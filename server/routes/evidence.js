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
const pipeline = require('../lib/evidence-pipeline');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

const MAX_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES || `${20 * 1024 * 1024}`, 10);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const DOCUMENT_EXTS = new Set(['pdf', 'docx', 'doc', 'txt', 'csv']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm']);

async function persistFile(req, file) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  const sniff = storage.sniffMagicBytes(file.buffer, ext);
  if (!sniff.ok) throw new HttpError(400, `File content does not match its extension (.${ext})`, 'invalid_file');
  const av = await storage.scanForViruses(file.buffer);
  if (!av.ok) throw new HttpError(400, `File rejected by virus scanner: ${av.reason}`, 'av_failed');
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const key = storage.newKey(req.user.id, file.originalname);
  const put = await storage.putObject({ key, body: file.buffer, contentType: sniff.mime });
  return { key, provider: put.provider, mime: sniff.mime, sha256, ext };
}

async function assertProjectInOrg(projectId, orgId) {
  const project = await prisma.projectRecord.findFirst({ where: { id: projectId, orgId } });
  if (!project) throw new HttpError(404, 'project not found', 'not_found');
  return project;
}

// ── SourceDocument upload (contracts, estimates, change orders, invoices) ──
const UPLOAD_ROLES = ['owner', 'admin', 'project_manager', 'estimator', 'field_user'];
const DocMetaSchema = z.object({ document_type: z.string().min(1).max(60) });

router.post('/projects/:projectId/sourceDocuments', requireAnyOrgRole(...UPLOAD_ROLES), upload.single('file'),
  validate(DocMetaSchema, 'body'), asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded', 'invalid_request');
    const project = await assertProjectInOrg(req.params.projectId, req.tenant.orgId);
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    if (!DOCUMENT_EXTS.has(ext)) throw new HttpError(400, `Unsupported document type ".${ext}"`, 'unsupported_file_type');

    const existing = await prisma.sourceDocument.findUnique({ where: { sha256_hash: crypto.createHash('sha256').update(req.file.buffer).digest('hex') } });
    if (existing) throw new HttpError(409, 'A document with this exact content already exists', 'duplicate_document', { sourceDocumentId: existing.id });

    const persisted = await persistFile(req, req.file);
    const row = await prisma.sourceDocument.create({
      data: {
        orgId: req.tenant.orgId, project_id: project.id, document_type: req.body.document_type,
        original_filename: req.file.originalname, storage_uri: persisted.key, mime_type: persisted.mime,
        file_size_bytes: req.file.buffer.length, sha256_hash: persisted.sha256, uploaded_by_id: req.user.id,
        uploaded_at: new Date(), extraction_status: 'pending', userId: req.user.id,
      },
    });
    await audit(req, 'sourceDocuments.upload', { resource: 'sourceDocument', resourceId: row.id });
    res.status(201).json(row);
  }));

// ── EvidenceItem upload (photos, audio, receipts, field media) ────────────
router.post('/projects/:projectId/evidenceItems', requireAnyOrgRole(...UPLOAD_ROLES), upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded', 'invalid_request');
    const project = await assertProjectInOrg(req.params.projectId, req.tenant.orgId);
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const evidenceType = IMAGE_EXTS.has(ext) ? 'photo' : AUDIO_EXTS.has(ext) ? 'audio' : DOCUMENT_EXTS.has(ext) ? 'receipt' : null;
    if (!evidenceType) throw new HttpError(400, `Unsupported evidence file type ".${ext}"`, 'unsupported_file_type');

    const persisted = await persistFile(req, req.file);
    const existing = await prisma.evidenceItem.findUnique({ where: { orgId_sha256Hash: { orgId: req.tenant.orgId, sha256Hash: persisted.sha256 } } });
    const row = await prisma.evidenceItem.create({
      data: {
        orgId: req.tenant.orgId, project_id: project.id, evidenceType, storageUri: persisted.key,
        sha256Hash: persisted.sha256, uploadedById: req.user.id,
        duplicateOfId: existing ? existing.id : null,
        quality: existing ? 'ok' : null,
      },
    });
    await audit(req, 'evidenceItems.upload', { resource: 'evidenceItem', resourceId: row.id, details: { duplicate: !!existing } });
    res.status(201).json(row);
  }));

// ── Analysis triggers ──────────────────────────────────────────────────────
const ANALYZE_ROLES = ['owner', 'admin', 'project_manager'];

router.post('/sourceDocuments/:id/analyze', requireAnyOrgRole(...ANALYZE_ROLES), asyncHandler(async (req, res) => {
  const sourceDocument = await prisma.sourceDocument.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!sourceDocument) return res.status(404).json({ error: 'not_found' });
  const project = await prisma.projectRecord.findFirst({ where: { id: sourceDocument.project_id, orgId: req.tenant.orgId } });

  // Local text extraction (pdf-parse/mammoth) needs bytes regardless of
  // driver; only the Gemini multimodal fallback below would prefer gs://.
  const stream = await storage.getStream(sourceDocument.storage_uri);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  const extracted = await pipeline.extractDocumentText({ mimeType: sourceDocument.mime_type, buffer });
  if (!extracted) {
    await prisma.sourceDocument.update({ where: { id: sourceDocument.id }, data: { extraction_status: 'failed' } });
    throw new HttpError(422, `No text extractor for mime type ${sourceDocument.mime_type} yet — native Gemini document understanding for scanned/image documents is a follow-up`, 'extraction_unsupported');
  }

  let baseline = null;
  if (['contract', 'estimate', 'change_order'].includes(sourceDocument.document_type)) {
    baseline = await pipeline.extractContractBaseline({ orgId: req.tenant.orgId, project, sourceDocument, extractedText: extracted.text });
  }
  await prisma.sourceDocument.update({
    where: { id: sourceDocument.id },
    data: { extraction_status: 'extracted', page_count: extracted.pages ? extracted.pages.length : sourceDocument.page_count },
  });
  await audit(req, 'sourceDocuments.analyze', { resource: 'sourceDocument', resourceId: sourceDocument.id });
  res.json({
    extraction: { method: extracted.method, textLength: extracted.text.length, pageCount: extracted.pages ? extracted.pages.length : null },
    baseline: baseline ? { scopeItemCount: baseline.scopeItems.length, contractProvisionCount: baseline.contractProvisions.length, agentRunId: baseline.agentRunId } : null,
  });
}));

router.post('/evidenceItems/:id/analyze', requireAnyOrgRole(...ANALYZE_ROLES), asyncHandler(async (req, res) => {
  const evidenceItem = await prisma.evidenceItem.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!evidenceItem) return res.status(404).json({ error: 'not_found' });
  const mimeType = evidenceItem.evidenceType === 'photo' ? 'image/jpeg' : 'audio/mpeg'; // best-effort; see follow-up below

  // Prefer a gs:// reference (no byte round-trip through this server) when
  // the GCS storage driver is active; only fall back to reading+base64-
  // inlining the bytes on the local/S3 drivers.
  const gcsUri = storage.gcsUri(evidenceItem.storageUri);
  let base64 = null;
  if (!gcsUri) {
    const stream = await storage.getStream(evidenceItem.storageUri);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    base64 = Buffer.concat(chunks).toString('base64');
  }

  let result;
  if (evidenceItem.evidenceType === 'audio') {
    result = await pipeline.transcribeAudio({ orgId: req.tenant.orgId, evidenceItem, gcsUri, base64, mimeType });
  } else if (evidenceItem.evidenceType === 'photo') {
    result = await pipeline.interpretImage({ orgId: req.tenant.orgId, evidenceItem, gcsUri, base64, mimeType });
  } else {
    throw new HttpError(422, `No Gemini analysis path for evidenceType "${evidenceItem.evidenceType}" yet`, 'analysis_unsupported');
  }
  await audit(req, 'evidenceItems.analyze', { resource: 'evidenceItem', resourceId: evidenceItem.id });
  res.json({ evidenceItem: result.evidenceItem, agentRunId: result.agentRunId });
}));

const FindingRunSchema = z.object({ changeEventId: z.string().optional() });
router.post('/projects/:id/findings/generate', requireAnyOrgRole(...ANALYZE_ROLES), validate(FindingRunSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectInOrg(req.params.id, req.tenant.orgId);
    const [scopeItems, contractProvisions, evidenceItems] = await Promise.all([
      prisma.scopeItem.findMany({ where: { orgId: req.tenant.orgId, project_id: project.id } }),
      prisma.contractProvision.findMany({ where: { orgId: req.tenant.orgId, project_id: project.id } }),
      prisma.evidenceItem.findMany({ where: { orgId: req.tenant.orgId, project_id: project.id } }),
    ]);
    if (scopeItems.length === 0 && contractProvisions.length === 0) {
      throw new HttpError(422, 'No contract baseline extracted for this project yet — analyze a contract/estimate source document first', 'no_baseline');
    }
    const result = await pipeline.compareScopeToEvidence({
      orgId: req.tenant.orgId, project, scopeItems, contractProvisions, evidenceItems,
      changeEventId: req.body.changeEventId || null,
    });
    await audit(req, 'projects.findings.generate', { resource: 'projectRecord', resourceId: project.id, details: { findingCount: result.findings.length, discardedCount: result.discardedCount } });
    res.json({
      findings: result.findings, discardedCount: result.discardedCount, agentRunId: result.agentRunId,
    });
  }));

router.get('/evidenceFindings/:id/citations/validate', asyncHandler(async (req, res) => {
  const finding = await prisma.evidenceFinding.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!finding) return res.status(404).json({ error: 'not_found' });
  const results = await pipeline.validateCitations({ orgId: req.tenant.orgId, findingId: finding.id });
  res.json({ data: results });
}));

module.exports = router;
