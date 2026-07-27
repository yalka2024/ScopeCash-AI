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
const evidenceJobs = require('../lib/evidence-jobs');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

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
    const existing = await prisma.evidenceItem.findFirst({ where: { orgId: req.tenant.orgId, sha256Hash: persisted.sha256 } });
    const row = await prisma.evidenceItem.create({
      data: {
        orgId: req.tenant.orgId, project_id: project.id, evidenceType, storageUri: persisted.key,
        sha256Hash: persisted.sha256, mimeType: persisted.mime, uploadedById: req.user.id,
        duplicateOfId: existing ? existing.id : null,
        quality: existing ? 'ok' : null,
      },
    });
    await audit(req, 'evidenceItems.upload', { resource: 'evidenceItem', resourceId: row.id, details: { duplicate: !!existing } });
    res.status(201).json(row);
  }));

// ── Analysis triggers ──────────────────────────────────────────────────────
const ANALYZE_ROLES = ['owner', 'admin', 'project_manager'];

// All three routes below enqueue durable background work (lib/evidence-jobs.js)
// rather than running the Gemini pipeline synchronously in the request —
// these calls can take well over the typical HTTP/load-balancer timeout on a
// large document or a slow model response. Each returns 202 with an
// agentRunId the client polls via GET /api/agentRunRecords/:id (already a
// generic, tenant-scoped, read-only entity route — see routes/entities.js).

router.post('/sourceDocuments/:id/analyze', requireAnyOrgRole(...ANALYZE_ROLES), asyncHandler(async (req, res) => {
  const sourceDocument = await prisma.sourceDocument.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!sourceDocument) return res.status(404).json({ error: 'not_found' });
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

router.post('/evidenceItems/:id/analyze', requireAnyOrgRole(...ANALYZE_ROLES), asyncHandler(async (req, res) => {
  const evidenceItem = await prisma.evidenceItem.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!evidenceItem) return res.status(404).json({ error: 'not_found' });
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
router.post('/projects/:id/findings/generate', requireAnyOrgRole(...ANALYZE_ROLES), validate(FindingRunSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectInOrg(req.params.id, req.tenant.orgId);
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
  const results = await pipeline.validateCitations({ orgId: req.tenant.orgId, findingId: finding.id });
  res.json({ data: results });
}));

module.exports = router;
