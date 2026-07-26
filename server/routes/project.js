const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const prisma = require('../lib/prisma');
const { authMiddleware, requireScope } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { tenantPrisma, tenantContextFromUser } = require('../lib/tenant');
const { enqueueJob, getQueueStatus } = require('../lib/worker');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const limiters = require('../lib/ratelimit');
const storage = require('../lib/storage');
const { enqueueWebhookEvent } = require('../lib/webhook-delivery');
const { paginate } = require('../lib/pagination');
const cache = require('../lib/cache');
const onboarding = require('../lib/onboarding');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

const ALLOWED_EXTS = ['.pdf', '.docx', '.jpg', '.png', '.heic', '.mpeg', '.mp4', '.wav', '.csv', '.txt', '.rfc822', '.zip'].map(e => e.replace(/^\./, '').toLowerCase());
const MAX_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES || `${20 * 1024 * 1024}`, 10);

// Memory storage so we can sniff magic bytes & scan before writing.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) return cb(null, true);
    // Reject with a reason. `cb(null, false)` drops the file silently, leaving the
    // route to report the misleading "No file uploaded".
    cb(new HttpError(400, `Unsupported file type ".${ext}" (allowed: ${ALLOWED_EXTS.map(e => `.${e}`).join(', ')})`, 'unsupported_file_type'));
  }
});

async function persistUpload(req, file) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();

  // Magic-byte sniffing
  const sniff = storage.sniffMagicBytes(file.buffer, ext);
  if (!sniff.ok) {
    throw new HttpError(400, `File content does not match its extension (.${ext})`, 'invalid_file');
  }

  // AV scan
  const av = await storage.scanForViruses(file.buffer);
  if (!av.ok) {
    throw new HttpError(400, `File rejected by virus scanner: ${av.reason}`, 'av_failed');
  }

  const key = storage.newKey(req.user.id, file.originalname);
  const put = await storage.putObject({ key, body: file.buffer, contentType: sniff.mime });

  return await prisma.project.create({ data: {
    projectName: file.originalname,
    projectPath: put.path || null,
    storageKey: key,
    storageProvider: put.provider,
    contentType: sniff.mime,
    fileSize: file.buffer.length,
    status: 'processing',
    userId: req.user.id,
    orgId:  req.user.orgId || null,
  }});
}

// Upload and process
router.post('/', limiters.upload, requireScope('write', 'upload'), upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded', 'invalid_request');
    const record = await persistUpload(req, req.file);
    enqueueJob(record.id, record.storageKey, req.user.id, req.user.email);
    enqueueWebhookEvent(req.user.id, 'project.created', { id: record.id, name: record.projectName }).catch(() => {});
    onboarding.markStep(req.user.id, 'first_record', { orgId: req.user.orgId || null }).catch(() => {});
    await audit(req, 'project.upload', { resource: 'project', resourceId: record.id });
    cache.del(`analytics:overview:${req.user.id}`).catch(() => {});
    res.status(202).json({
      id: record.id, name: record.projectName, status: 'processing',
      message: 'Queued for processing. Poll GET /api/projects/:id for status.'
    });
  }));

// Batch upload
router.post('/batch', limiters.upload, requireScope('write', 'upload'), upload.array('files', 10),
  asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) throw new HttpError(400, 'No files uploaded', 'invalid_request');
    const records = [];
    for (const file of req.files) {
      const record = await persistUpload(req, file);
      enqueueJob(record.id, record.storageKey, req.user.id, req.user.email);
      enqueueWebhookEvent(req.user.id, 'project.created', { id: record.id, name: record.projectName }).catch(() => {});
      records.push({ id: record.id, name: record.projectName, status: 'processing' });
    }
    onboarding.markStep(req.user.id, 'first_record', { orgId: req.user.orgId || null }).catch(() => {});
    await audit(req, 'project.batch_upload', { details: { count: records.length } });
    cache.del(`analytics:overview:${req.user.id}`).catch(() => {});
    res.status(202).json({ records, message: `${records.length} files queued for processing.` });
  }));

// List with cursor pagination
const ListSchema = z.object({
  status: z.string().optional(),
  risk: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
router.get('/', requireScope('read'), validate(ListSchema, 'query'), asyncHandler(async (req, res) => {
  const { status, risk, cursor, limit } = req.query;
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const where = {};
  if (status) where.status = status;
  if (risk)   where.overallRisk = risk;

  const page = await paginate(tp.project, {
    where, orderBy: { createdAt: 'desc' }, cursor, limit,
  });
  res.json({
    projects: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}));

// Get single
router.get('/:id', requireScope('read'), asyncHandler(async (req, res) => {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record) throw new HttpError(404, 'Not found', 'not_found');
  res.json(record);
}));

// Signed download URL (short-lived)
router.get('/:id/download-url', requireScope('read'), asyncHandler(async (req, res) => {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record || !record.storageKey) throw new HttpError(404, 'Not found', 'not_found');
  const url = await storage.signedDownloadUrl(record.storageKey, 300);
  res.json({ url, expiresIn: 300 });
}));

// Delete
router.delete('/:id', requireScope('write', 'delete'), asyncHandler(async (req, res) => {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record) throw new HttpError(404, 'Not found', 'not_found');
  if (record.storageKey) { await storage.deleteObject(record.storageKey).catch(() => {}); }
  if (record.projectPath && fs.existsSync(record.projectPath)) {
    try { fs.unlinkSync(record.projectPath); } catch {}
  }
  await prisma.project.delete({ where: { id: record.id } });
  await audit(req, 'project.delete', { resource: 'project', resourceId: record.id });
  enqueueWebhookEvent(req.user.id, 'project.deleted', { id: record.id }).catch(() => {});
  cache.del(`analytics:overview:${req.user.id}`).catch(() => {});
  res.json({ message: 'Deleted' });
}));

// Generic document-record evaluations (accuracy/robustness scoring against
// EvalRun/EvalResult) — kept; this is reusable eval infrastructure, not
// EU-AI-Act-specific machinery. (The legacy classify/Annex IV/conformity
// assessment endpoints that lived here — EU AI Act Article 6 risk
// classification and Annex IV/VI technical documentation — were removed:
// this product documents contractor scope evidence, not AI Act conformity.
// See lib/eu-ai-act-classifier.js, lib/annex-iv-generator.js, lib/conformity.js
// — also removed — if resurrecting any of this for a different product.)
async function _loadRecord(req) {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record) throw new HttpError(404, 'Not found', 'not_found');
  return record;
}

const evals = require('../lib/ai-evals');

router.get('/system/eval-suites', requireScope('read'), asyncHandler(async (_req, res) => {
  res.json({ suites: evals.listSuites() });
}));

router.get('/:id/evaluations', requireScope('read'), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  const runs = await prisma.evalRun.findMany({
    where: { recordId: record.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, suite: true, model: true, provider: true,
      score: true, passed: true, total: true,
      durationMs: true, totalTokens: true, ucents: true, createdAt: true,
    },
  });
  res.json({ runs });
}));

router.get('/:id/evaluations/:runId', requireScope('read'), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  const run = await prisma.evalRun.findFirst({
    where: { id: req.params.runId, recordId: record.id },
    include: { results: true },
  });
  if (!run) throw new HttpError(404, 'Eval run not found', 'not_found');
  res.json(run);
}));

const RunEvalSchema = z.object({
  suite:   z.string().min(1).max(64),
  model:   z.string().max(128).optional(),
  invoker: z.object({
    mode:     z.enum(['mock', 'http']).default('mock'),
    endpoint: z.string().url().optional(),
    apiKey:   z.string().max(512).optional(),
  }).optional(),
});
router.post('/:id/evaluations/run', requireScope('write'), validate(RunEvalSchema), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  const cfg = req.body.invoker || { mode: 'mock' };
  if (cfg.mode === 'http' && !cfg.endpoint) {
    throw new HttpError(400, 'HTTP invoker requires endpoint URL', 'invalid_invoker');
  }
  let result;
  try {
    result = await evals.runSuite({
      suite: req.body.suite,
      modelHint: req.body.model || null,
      recordId: record.id,
      userId: req.user.id,
      invokerConfig: cfg.mode === 'http' ? cfg : null,
    });
  } catch (e) {
    if (/suite_not_found/.test(e.message)) {
      throw new HttpError(400, `Unknown suite: ${req.body.suite}`, 'unknown_suite');
    }
    throw e;
  }
  await audit(req, 'project.evaluation.run', {
    resource: 'project', resourceId: record.id,
    details: { suite: result.suite, score: result.score, passed: result.passed, total: result.total, model: result.model },
  });
  res.json(result);
}));

// Queue status
router.get('/system/queue', requireScope('read'), asyncHandler(async (req, res) => {
  res.json(await getQueueStatus());
}));

module.exports = router;

