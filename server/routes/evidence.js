/**
 * Evidence upload + AI processing endpoints — the actual entry points into
 * lib/evidence-pipeline.js. entities.js's generic CRUD lets a client write a
 * SourceDocument/EvidenceItem row with an arbitrary storage_uri string
 * (useful for the domain data model, not for real uploads); these routes are
 * the real thing: multipart upload -> validated bytes -> object storage ->
 * row creation -> (on request) Gemini analysis.
 *
 * Mirrors routes/project.js's upload pattern (multer memory storage, magic-
 * byte sniffing, AV scan, storage.putObject) rather than inventing a new one.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { requireAnyOrgRole } = require('../lib/roles');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const limiters = require('../lib/ratelimit');
const storage = require('../lib/storage');
// Not destructured — `jest.spyOn(imageConvert, 'heicToJpeg')` in tests
// replaces the property on this module object; a destructured `const
// { heicToJpeg }` would capture the original function reference at
// require-time instead, invisible to the spy.
const imageConvert = require('../lib/image-convert');
const pipeline = require('../lib/evidence-pipeline');
const evidenceJobs = require('../lib/evidence-jobs');
const { attachApiKeyProjectScope } = require('../lib/api-key-scope');
const { enforceMeter } = require('../middleware/entitlements');
const ent = require('../lib/entitlements');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use(attachApiKeyProjectScope);

const MAX_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES || `${20 * 1024 * 1024}`, 10);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const DOCUMENT_EXTS = new Set(['pdf', 'docx', 'doc', 'txt', 'csv']);
// gif/tiff are intentionally NOT included: Gemini vision does not officially
// support either format, and lib/storage.js has no magic-byte signature for
// them either — declaring them "accepted" without either would silently
// mislead (see TODO.md). webp/heic/heif are both real: Gemini vision
// supports all three natively, and lib/storage.js#sniffMagicBytes now
// recognizes their signatures.
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm']);

// Shared by both upload paths: the classic multipart endpoints below (bytes
// arrive in the request body) and the signed-upload confirm endpoints
// (bytes already sit in storage; fetched back here to run the identical
// check before anything is allowed to reference them as a real row).
async function validateBuffer(buffer, ext) {
  const sniff = storage.sniffMagicBytes(buffer, ext);
  if (!sniff.ok) throw new HttpError(400, `File content does not match its extension (.${ext})`, 'invalid_file');
  const av = await storage.scanForViruses(buffer);
  if (!av.ok) throw new HttpError(400, `File rejected by virus scanner: ${av.reason}`, 'av_failed');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { sniff, sha256 };
}

/**
 * Enforce the plan's storage_gb quota before any bytes are written. Checked
 * here rather than in a route-level middleware because the size isn't known
 * until the body has been parsed, and it must cover both upload paths
 * (multipart and signed-upload confirm) that funnel through persistFile.
 */
async function assertStorageQuota(req, byteLength) {
  const status = await ent.checkStorageBytes(req.tenant?.orgId, byteLength, req.tenant?.plan);
  if (!status.allowed) {
    const usedGb = (status.used / ent.BYTES_PER_GB).toFixed(2);
    throw new HttpError(402,
      `Storage limit reached (${usedGb} GB of ${status.limitGb} GB used). Upgrade your plan or delete files to free space.`,
      'usage_limit_exceeded',
      { meter: 'storage_gb', used: status.used, limit: status.limit, remaining: status.remaining });
  }
}

async function persistFile(req, file) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  const { sniff, sha256 } = await validateBuffer(file.buffer, ext);
  await assertStorageQuota(req, file.buffer.length);
  const key = storage.newKey(req.user.id, file.originalname);
  const put = await storage.putObject({ key, body: file.buffer, contentType: sniff.mime });
  return { key, provider: put.provider, mime: sniff.mime, sha256, ext, sizeBytes: file.buffer.length };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Confirms a signed-upload-URL staging key really has the bytes the
 * client claims (re-fetches and re-validates — never trusted on the
 * client's word alone), or throws and cleans up the staged object. */
async function validateStagedUpload(req, stagingKey, originalFilename) {
  const ext = path.extname(originalFilename || '').slice(1).toLowerCase();
  let buffer;
  try {
    buffer = await streamToBuffer(await storage.getStream(stagingKey));
  } catch {
    throw new HttpError(400, 'Upload not found — the signed URL may have expired or the upload never completed', 'upload_not_found');
  }
  try {
    const { sniff, sha256 } = await validateBuffer(buffer, ext);
    // Quota is checked here rather than at upload-url issue time because the
    // real byte count isn't known until the client has actually uploaded.
    // Over-quota staged bytes are deleted below by the same cleanup path
    // that handles a failed signature/AV check, so they can't accumulate.
    await assertStorageQuota(req, buffer.length);
    return { mime: sniff.mime, sha256, fileSize: buffer.length };
  } catch (err) {
    await storage.deleteObject(stagingKey).catch(() => {});
    throw err;
  }
}

/** sha256_hash is a table-wide unique column (not compound with orgId), so
 * two different orgs can never hold a byte-identical SourceDocument even
 * though the app-level pre-checks above are org-scoped for tenant isolation
 * (never expose another org's document id in a 409). Under Postgres+RLS
 * that pre-check is invisible to another org's row, so a real collision
 * still surfaces here as a P2002 at create() time — converted to the same
 * conflict response, without leaking the other org's document id. */
async function createSourceDocumentOrDuplicate409(data) {
  try {
    return await prisma.sourceDocument.create({ data });
  } catch (err) {
    // Target shape differs by connector (Postgres: array of column names in
    // err.meta.target; SQLite: only present in err.message) — check both.
    const detail = `${(err && err.meta && err.meta.target) || ''} ${(err && err.message) || ''}`;
    if (err && err.code === 'P2002' && detail.includes('sha256_hash')) {
      throw new HttpError(409, 'A document with this exact content already exists', 'duplicate_document');
    }
    throw err;
  }
}

// storage.newKey()'s second segment only ever contains [stamp]-[hex]-[sanitized name].
const STAGING_KEY_REST_RE = /^[a-zA-Z0-9._-]{1,255}$/;

/** Every staging key is minted as newKey(userId, ...): exactly one '/', the
 * caller's own id as the first segment, a restricted-charset second segment.
 * A plain startsWith(`${userId}/`) check is NOT enough — the local storage
 * driver joins this key onto a filesystem path (path.join(LOCAL_ROOT, key)),
 * so a value like `${userId}/../../../../etc/passwd` would pass a prefix
 * check yet still escape LOCAL_ROOT once joined, giving an authenticated
 * user arbitrary file read (via confirm-upload persisting the file's bytes)
 * and arbitrary file delete (via the validation-failure cleanup path).
 * Requiring the second segment to be a single slash-free, dot-free-as-a-
 * whole-segment token closes that off regardless of storage driver. */
function assertStagingKeyOwnedByUser(stagingKey, userId) {
  const reject = () => { throw new HttpError(403, 'stagingKey does not belong to the calling user', 'staging_key_mismatch'); };
  if (typeof stagingKey !== 'string') return reject();
  const slash = stagingKey.indexOf('/');
  if (slash === -1 || stagingKey.indexOf('/', slash + 1) !== -1) return reject();
  const owner = stagingKey.slice(0, slash);
  const rest = stagingKey.slice(slash + 1);
  if (owner !== userId) return reject();
  if (rest === '.' || rest === '..' || !STAGING_KEY_REST_RE.test(rest)) return reject();
}

// A project-scoped API key (ApiKeyProjectGrant — see lib/api-key-scope.js)
// is additionally restricted to specific projects within the org; a key
// with no grants stays org-wide (the pre-existing default). Checked at
// every route below that resolves a project either directly (:projectId
// params, via assertProjectInOrg) or indirectly (a document/item/finding
// fetched by its own id, whose project_id is then checked here) — the
// equivalent chokepoint to routes/entities.js's scope() for this file's
// real upload/analyze surface.
function assertApiKeyCanTouchProject(req, projectId) {
  if (req.apiKeyProjectIds && !req.apiKeyProjectIds.includes(projectId)) {
    throw new HttpError(403, 'This API key is not granted access to that project', 'project_scope_denied');
  }
}

/** Scopes the sha256 duplicate-content lookups below to a project-scoped
 * key's own allowlist. Without this, a key restricted to Project A could
 * learn — via a 409's `sourceDocumentId` or a new row's `duplicateOfId` —
 * that byte-identical content exists in some OTHER, ungranted project in
 * the same org, plus that other record's real internal id. Scoping the
 * PRE-check means a real duplicate in an ungranted project is simply
 * invisible to it: for sourceDocuments (sha256_hash is a table-wide
 * unique column) the create() below still hits that real DB constraint
 * and is caught by createSourceDocumentOrDuplicate409's fallback — a
 * clean 409 with no id, never a crash; for evidenceItems (deliberately
 * NOT unique) it just creates a fresh, non-duplicate-flagged row, which
 * is correct: a key that can't see the other project has no way to know
 * a "duplicate" exists there at all, and shouldn't. */
function apiKeyDedupScope(req) {
  return req.apiKeyProjectIds ? { project_id: { in: req.apiKeyProjectIds } } : {};
}

async function assertProjectInOrg(req, projectId) {
  const project = await prisma.projectRecord.findFirst({ where: { id: projectId, orgId: req.tenant.orgId } });
  if (!project) throw new HttpError(404, 'project not found', 'not_found');
  assertApiKeyCanTouchProject(req, project.id);
  return project;
}

// ── SourceDocument upload (contracts, estimates, change orders, invoices) ──
const UPLOAD_ROLES = ['owner', 'admin', 'project_manager', 'estimator', 'field_user'];
const DocMetaSchema = z.object({ document_type: z.string().min(1).max(60) });

router.post('/projects/:projectId/sourceDocuments', requireAnyOrgRole(...UPLOAD_ROLES), upload.single('file'),
  validate(DocMetaSchema, 'body'), asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded', 'invalid_request');
    const project = await assertProjectInOrg(req, req.params.projectId);
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    if (!DOCUMENT_EXTS.has(ext)) throw new HttpError(400, `Unsupported document type ".${ext}"`, 'unsupported_file_type');

    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const existing = await prisma.sourceDocument.findFirst({ where: { orgId: req.tenant.orgId, sha256_hash: sha256, ...apiKeyDedupScope(req) } });
    if (existing) throw new HttpError(409, 'A document with this exact content already exists', 'duplicate_document', { sourceDocumentId: existing.id });

    const persisted = await persistFile(req, req.file);
    const row = await createSourceDocumentOrDuplicate409({
      orgId: req.tenant.orgId, project_id: project.id, document_type: req.body.document_type,
      original_filename: req.file.originalname, storage_uri: persisted.key, mime_type: persisted.mime,
      file_size_bytes: req.file.buffer.length, sha256_hash: persisted.sha256, uploaded_by_id: req.user.id,
      uploaded_at: new Date(), extraction_status: 'pending', userId: req.user.id,
    });
    await audit(req, 'sourceDocuments.upload', { resource: 'sourceDocument', resourceId: row.id });
    res.status(201).json(row);
  }));

// ── SourceDocument direct-to-storage upload (real V4/presigned PUT URL) ──
// The multipart route above proxies every byte through this server's own
// memory (multer memoryStorage) — fine for typical documents, wasteful for
// a large scanned contract or a long field video. This pair lets the
// browser PUT bytes straight to GCS/S3: request a signed URL, upload
// directly, then confirm (which re-fetches and re-validates the bytes —
// the signed URL itself proves nothing about content, only that SOME bytes
// landed at that key). GCS/S3 only; storage.js#signedUploadUrl returns null
// on the local driver, so this 501s there with a clear fallback message.
const UploadUrlSchema = z.object({ filename: z.string().min(1).max(255), contentType: z.string().min(1).max(127) });

router.post('/projects/:projectId/sourceDocuments/upload-url', requireAnyOrgRole(...UPLOAD_ROLES), validate(UploadUrlSchema), asyncHandler(async (req, res) => {
  await assertProjectInOrg(req, req.params.projectId);
  const ext = path.extname(req.body.filename).slice(1).toLowerCase();
  if (!DOCUMENT_EXTS.has(ext)) throw new HttpError(400, `Unsupported document type ".${ext}"`, 'unsupported_file_type');
  const stagingKey = storage.newKey(req.user.id, req.body.filename);
  const signed = await storage.signedUploadUrl({ key: stagingKey, contentType: req.body.contentType, ttlSeconds: 600 });
  if (!signed) throw new HttpError(501, `Direct upload URLs require STORAGE_DRIVER=gcs or s3 (current: ${storage.DRIVER}) — use the multipart upload endpoint instead`, 'direct_upload_unsupported');
  res.json({ uploadUrl: signed.url, method: signed.method, headers: signed.headers, stagingKey, expiresIn: 600 });
}));

const ConfirmUploadSchema = z.object({ stagingKey: z.string().min(1).max(500), originalFilename: z.string().min(1).max(255), document_type: z.string().min(1).max(60) });

router.post('/projects/:projectId/sourceDocuments/confirm-upload', requireAnyOrgRole(...UPLOAD_ROLES), validate(ConfirmUploadSchema), asyncHandler(async (req, res) => {
  const project = await assertProjectInOrg(req, req.params.projectId);
  assertStagingKeyOwnedByUser(req.body.stagingKey, req.user.id);

  const existing = await prisma.sourceDocument.findFirst({ where: { storage_uri: req.body.stagingKey } });
  if (existing) throw new HttpError(409, 'This staged upload has already been confirmed', 'already_confirmed', { sourceDocumentId: existing.id });

  const { mime, sha256, fileSize } = await validateStagedUpload(req, req.body.stagingKey, req.body.originalFilename);
  const dup = await prisma.sourceDocument.findFirst({ where: { orgId: req.tenant.orgId, sha256_hash: sha256, ...apiKeyDedupScope(req) } });
  if (dup) {
    await storage.deleteObject(req.body.stagingKey).catch(() => {});
    throw new HttpError(409, 'A document with this exact content already exists', 'duplicate_document', { sourceDocumentId: dup.id });
  }

  let row;
  try {
    row = await createSourceDocumentOrDuplicate409({
      orgId: req.tenant.orgId, project_id: project.id, document_type: req.body.document_type,
      original_filename: req.body.originalFilename, storage_uri: req.body.stagingKey, mime_type: mime,
      file_size_bytes: fileSize, sha256_hash: sha256, uploaded_by_id: req.user.id,
      uploaded_at: new Date(), extraction_status: 'pending', userId: req.user.id,
    });
  } catch (err) {
    await storage.deleteObject(req.body.stagingKey).catch(() => {});
    throw err;
  }
  await audit(req, 'sourceDocuments.upload', { resource: 'sourceDocument', resourceId: row.id, details: { method: 'direct_signed_url' } });
  res.status(201).json(row);
}));

// ── EvidenceItem upload (photos, audio, receipts, field media) ────────────
router.post('/projects/:projectId/evidenceItems', requireAnyOrgRole(...UPLOAD_ROLES), upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded', 'invalid_request');
    const project = await assertProjectInOrg(req, req.params.projectId);
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const evidenceType = IMAGE_EXTS.has(ext) ? 'photo' : AUDIO_EXTS.has(ext) ? 'audio' : DOCUMENT_EXTS.has(ext) ? 'receipt' : null;
    if (!evidenceType) throw new HttpError(400, `Unsupported evidence file type ".${ext}"`, 'unsupported_file_type');

    const persisted = await persistFile(req, req.file);
    const existing = await prisma.evidenceItem.findFirst({ where: { orgId: req.tenant.orgId, sha256Hash: persisted.sha256, ...apiKeyDedupScope(req) } });
    const row = await prisma.evidenceItem.create({
      data: {
        orgId: req.tenant.orgId, project_id: project.id, evidenceType, storageUri: persisted.key,
        sha256Hash: persisted.sha256, mimeType: persisted.mime, uploadedById: req.user.id,
        fileSizeBytes: persisted.sizeBytes,
        duplicateOfId: existing ? existing.id : null,
        quality: existing ? 'ok' : null,
      },
    });
    await audit(req, 'evidenceItems.upload', { resource: 'evidenceItem', resourceId: row.id, details: { duplicate: !!existing } });
    res.status(201).json(row);
  }));

// ── EvidenceItem direct-to-storage upload (real V4/presigned PUT URL) ────
// Same rationale and validate-after-upload shape as the sourceDocuments
// pair above — see its comment.
router.post('/projects/:projectId/evidenceItems/upload-url', requireAnyOrgRole(...UPLOAD_ROLES), validate(UploadUrlSchema), asyncHandler(async (req, res) => {
  await assertProjectInOrg(req, req.params.projectId);
  const ext = path.extname(req.body.filename).slice(1).toLowerCase();
  const evidenceType = IMAGE_EXTS.has(ext) ? 'photo' : AUDIO_EXTS.has(ext) ? 'audio' : DOCUMENT_EXTS.has(ext) ? 'receipt' : null;
  if (!evidenceType) throw new HttpError(400, `Unsupported evidence file type ".${ext}"`, 'unsupported_file_type');
  const stagingKey = storage.newKey(req.user.id, req.body.filename);
  const signed = await storage.signedUploadUrl({ key: stagingKey, contentType: req.body.contentType, ttlSeconds: 600 });
  if (!signed) throw new HttpError(501, `Direct upload URLs require STORAGE_DRIVER=gcs or s3 (current: ${storage.DRIVER}) — use the multipart upload endpoint instead`, 'direct_upload_unsupported');
  res.json({ uploadUrl: signed.url, method: signed.method, headers: signed.headers, stagingKey, expiresIn: 600, evidenceType });
}));

const ConfirmEvidenceUploadSchema = z.object({ stagingKey: z.string().min(1).max(500), originalFilename: z.string().min(1).max(255) });

router.post('/projects/:projectId/evidenceItems/confirm-upload', requireAnyOrgRole(...UPLOAD_ROLES), validate(ConfirmEvidenceUploadSchema), asyncHandler(async (req, res) => {
  const project = await assertProjectInOrg(req, req.params.projectId);
  assertStagingKeyOwnedByUser(req.body.stagingKey, req.user.id);

  const alreadyConfirmed = await prisma.evidenceItem.findFirst({ where: { storageUri: req.body.stagingKey } });
  if (alreadyConfirmed) throw new HttpError(409, 'This staged upload has already been confirmed', 'already_confirmed', { evidenceItemId: alreadyConfirmed.id });

  const ext = path.extname(req.body.originalFilename).slice(1).toLowerCase();
  const evidenceType = IMAGE_EXTS.has(ext) ? 'photo' : AUDIO_EXTS.has(ext) ? 'audio' : DOCUMENT_EXTS.has(ext) ? 'receipt' : null;
  if (!evidenceType) throw new HttpError(400, `Unsupported evidence file type ".${ext}"`, 'unsupported_file_type');

  const { mime, sha256, fileSize } = await validateStagedUpload(req, req.body.stagingKey, req.body.originalFilename);
  // Deliberately NOT rejected as a conflict, unlike sourceDocuments: a field
  // worker genuinely re-photographing the same thing twice must still be
  // able to upload both — see the identical comment on EvidenceItem.sha256Hash
  // in prisma/schema.prisma.
  const existing = await prisma.evidenceItem.findFirst({ where: { orgId: req.tenant.orgId, sha256Hash: sha256, ...apiKeyDedupScope(req) } });

  const row = await prisma.evidenceItem.create({
    data: {
      orgId: req.tenant.orgId, project_id: project.id, evidenceType, storageUri: req.body.stagingKey,
      sha256Hash: sha256, mimeType: mime, uploadedById: req.user.id,
      fileSizeBytes: fileSize,
      duplicateOfId: existing ? existing.id : null,
      quality: existing ? 'ok' : null,
    },
  });
  await audit(req, 'evidenceItems.upload', { resource: 'evidenceItem', resourceId: row.id, details: { duplicate: !!existing, method: 'direct_signed_url' } });
  res.status(201).json(row);
}));

// ── EvidenceItem view (browser-displayable, converting HEIC on the fly) ──
// Storage keeps the ORIGINAL bytes always (HEIC included — Gemini vision
// analyzes heic/heif natively, and sha256Hash is over what was actually
// uploaded, not a derived copy). But Chrome/Firefox/Edge have no built-in
// HEIC decoder — a bare <img src="x.heic"> renders a broken-image icon on
// every non-Safari browser — so a HEIC/HEIF item is transcoded to JPEG only
// here, at serve time, never touching the stored object. No role gate
// beyond org membership (read access), matching this file's other GET
// routes (e.g. citations/validate below).
router.get('/evidenceItems/:id/view', asyncHandler(async (req, res) => {
  const item = await prisma.evidenceItem.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!item) return res.status(404).json({ error: 'not_found' });
  assertApiKeyCanTouchProject(req, item.project_id);
  if (item.evidenceType !== 'photo') {
    throw new HttpError(422, 'Only photo evidence items can be viewed as an image', 'not_an_image');
  }
  let buffer;
  try {
    buffer = await streamToBuffer(await storage.getStream(item.storageUri));
  } catch {
    throw new HttpError(404, 'Stored file not found', 'file_not_found');
  }
  const isHeic = item.mimeType === 'image/heic' || item.mimeType === 'image/heif';
  const contentType = isHeic ? 'image/jpeg' : (item.mimeType || 'application/octet-stream');
  const body = isHeic ? await imageConvert.heicToJpeg(buffer) : buffer;
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'private, max-age=3600');
  return res.send(body);
}));

// ── Analysis triggers ──────────────────────────────────────────────────────
const ANALYZE_ROLES = ['owner', 'admin', 'project_manager'];

// All three routes below enqueue durable background work (lib/evidence-jobs.js)
// rather than running the Gemini pipeline synchronously in the request —
// these calls can take well over the typical HTTP/load-balancer timeout on a
// large document or a slow model response. Each returns 202 with an
// agentRunId the client polls via GET /api/agentRunRecords/:id (already a
// generic, tenant-scoped, read-only entity route — see routes/entities.js).

router.post('/sourceDocuments/:id/analyze', requireAnyOrgRole(...ANALYZE_ROLES), enforceMeter('records_per_month'), asyncHandler(async (req, res) => {
  const sourceDocument = await prisma.sourceDocument.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!sourceDocument) return res.status(404).json({ error: 'not_found' });
  assertApiKeyCanTouchProject(req, sourceDocument.project_id);
  if (sourceDocument.extraction_status === 'processing') {
    throw new HttpError(409, 'Analysis is already in progress for this document', 'already_processing');
  }
  if (sourceDocument.extraction_status === 'extracted') {
    throw new HttpError(409, 'This document has already been analyzed', 'already_extracted');
  }
  const runId = await evidenceJobs.enqueueSourceDocumentAnalysis({
    sourceDocumentId: sourceDocument.id, orgId: req.tenant.orgId, projectId: sourceDocument.project_id,
  });
  await audit(req, 'sourceDocuments.analyze.enqueue', { resource: 'sourceDocument', resourceId: sourceDocument.id, details: { agentRunId: runId } });
  res.status(202).json({ agentRunId: runId, status: 'queued', poll: `/api/agentRunRecords/${runId}` });
}));

router.post('/evidenceItems/:id/analyze', requireAnyOrgRole(...ANALYZE_ROLES), enforceMeter('records_per_month'), asyncHandler(async (req, res) => {
  const evidenceItem = await prisma.evidenceItem.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!evidenceItem) return res.status(404).json({ error: 'not_found' });
  assertApiKeyCanTouchProject(req, evidenceItem.project_id);
  if (evidenceItem.analysisStatus === 'processing') {
    throw new HttpError(409, 'Analysis is already in progress for this item', 'already_processing');
  }
  if (evidenceItem.analysisStatus === 'completed') {
    throw new HttpError(409, 'This item has already been analyzed', 'already_analyzed');
  }
  if (evidenceItem.evidenceType !== 'audio' && evidenceItem.evidenceType !== 'photo') {
    throw new HttpError(422, `No Gemini analysis path for evidenceType "${evidenceItem.evidenceType}" yet`, 'analysis_unsupported');
  }
  const runId = await evidenceJobs.enqueueEvidenceItemAnalysis({
    evidenceItemId: evidenceItem.id, orgId: req.tenant.orgId, projectId: evidenceItem.project_id,
  });
  await audit(req, 'evidenceItems.analyze.enqueue', { resource: 'evidenceItem', resourceId: evidenceItem.id, details: { agentRunId: runId } });
  res.status(202).json({ agentRunId: runId, status: 'queued', poll: `/api/agentRunRecords/${runId}` });
}));

const FindingRunSchema = z.object({ changeEventId: z.string().optional() });
router.post('/projects/:id/findings/generate', requireAnyOrgRole(...ANALYZE_ROLES), enforceMeter('records_per_month'), validate(FindingRunSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectInOrg(req, req.params.id);
    const [scopeItemCount, contractProvisionCount] = await Promise.all([
      prisma.scopeItem.count({ where: { orgId: req.tenant.orgId, project_id: project.id } }),
      prisma.contractProvision.count({ where: { orgId: req.tenant.orgId, project_id: project.id } }),
    ]);
    if (scopeItemCount === 0 && contractProvisionCount === 0) {
      throw new HttpError(422, 'No contract baseline extracted for this project yet — analyze a contract/estimate source document first', 'no_baseline');
    }
    let runId;
    try {
      runId = await evidenceJobs.enqueueFindingsGeneration({
        projectId: project.id, orgId: req.tenant.orgId, changeEventId: req.body.changeEventId || null,
      });
    } catch (err) {
      if (err.code === 'already_running') {
        throw new HttpError(409, err.message, 'already_running', { agentRunId: err.runId });
      }
      throw err;
    }
    await audit(req, 'projects.findings.generate.enqueue', { resource: 'projectRecord', resourceId: project.id, details: { agentRunId: runId } });
    res.status(202).json({ agentRunId: runId, status: 'queued', poll: `/api/agentRunRecords/${runId}` });
  }));

router.get('/evidenceFindings/:id/citations/validate', asyncHandler(async (req, res) => {
  const finding = await prisma.evidenceFinding.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!finding) return res.status(404).json({ error: 'not_found' });
  assertApiKeyCanTouchProject(req, finding.project_id);
  const results = await pipeline.validateCitations({ orgId: req.tenant.orgId, findingId: finding.id });
  res.json({ data: results });
}));

module.exports = router;
