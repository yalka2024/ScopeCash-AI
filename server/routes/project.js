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

// EU AI Act auto-classification — runs the rules engine and stores the verdict
// on the record (overallRisk, riskScore, reportJson). Idempotent: each call
// overwrites the previous verdict.
const classifier = require('../lib/eu-ai-act-classifier');
const annexIv    = require('../lib/annex-iv-generator');
const conformity = require('../lib/conformity');

const ClassifySchema = z.object({
  description:    z.string().min(3).max(2000),
  sector:         z.string().optional(),
  decisionImpact: z.string().optional(),
  dataSensitive:  z.array(z.string()).optional().default([]),
  scope:          z.string().optional(),
  providerRole:   z.string().optional(),
});
router.post('/:id/classify', requireScope('write'), validate(ClassifySchema), asyncHandler(async (req, res) => {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record) throw new HttpError(404, 'Not found', 'not_found');

  const verdict = classifier.classify(req.body);

  const updated = await prisma.project.update({
    where: { id: record.id },
    data: {
      overallRisk: verdict.verdict,
      riskScore:   verdict.score,
      reportJson:  JSON.stringify(verdict),
    },
  });

  await audit(req, 'project.classify', {
    resource: 'project', resourceId: record.id,
    details: { verdict: verdict.verdict, score: verdict.score, version: verdict.version },
  });
  enqueueWebhookEvent(req.user.id, 'project.classified', {
    id: record.id, verdict: verdict.verdict, score: verdict.score,
  }).catch(() => {});
  cache.del(`analytics:overview:${req.user.id}`).catch(() => {});

  res.json({ record: updated, verdict });
}));

// Annex IV technical documentation — JSON
// Aborts if there is no classifier verdict on file.
async function _loadRecordWithVerdict(req) {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record) throw new HttpError(404, 'Not found', 'not_found');
  if (!record.reportJson) {
    throw new HttpError(409, 'Run classification before generating Annex IV documentation', 'not_classified');
  }
  let verdict;
  try { verdict = JSON.parse(record.reportJson); }
  catch { throw new HttpError(500, 'Stored verdict is invalid JSON', 'corrupt_verdict'); }

  const org = req.user.orgId
    ? await prisma.organization.findUnique({ where: { id: req.user.orgId } })
    : null;
  return { record, verdict, organisation: org ? { name: org.name } : {} };
}

router.get('/:id/annex-iv.json', requireScope('read'), asyncHandler(async (req, res) => {
  const { record, verdict, organisation } = await _loadRecordWithVerdict(req);
  const extras = {};
  // Optional: pull from a future "extras" column. For now, the user fills these
  // via a follow-up endpoint or accepts the placeholders.
  const doc = annexIv.generateJson({ record, verdict, organisation, extras });
  await audit(req, 'project.annex_iv.export', {
    resource: 'project', resourceId: record.id,
    details: { format: 'json', completeness: doc.completeness.percentage },
  });
  res.json(doc);
}));

router.get('/:id/annex-iv.pdf', requireScope('read'), asyncHandler(async (req, res) => {
  const { record, verdict, organisation } = await _loadRecordWithVerdict(req);
  const filename = `annex-iv-${(record.projectName || record.id).replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await audit(req, 'project.annex_iv.export', {
    resource: 'project', resourceId: record.id,
    details: { format: 'pdf' },
  });
  annexIv.generatePdf({ record, verdict, organisation, extras: {} }, res);
}));

// ─── Conformity Assessment (Article 43, Annex VI internal control) ────────
// State lives in record.conformityJson. Idempotent: GET returns the current
// state (creating a draft on first read for high-risk records).

async function _loadRecord(req) {
  const tp = tenantPrisma(prisma, tenantContextFromUser(req.user));
  const record = await tp.project.findFirst({ where: { id: req.params.id } });
  if (!record) throw new HttpError(404, 'Not found', 'not_found');
  return record;
}
function _readState(record) {
  if (!record.conformityJson) return null;
  try { return JSON.parse(record.conformityJson); }
  catch { throw new HttpError(500, 'Stored conformity state is invalid JSON', 'corrupt_conformity'); }
}
async function _writeState(recordId, state) {
  return prisma.project.update({
    where: { id: recordId },
    data: { conformityJson: JSON.stringify(state) },
  });
}

router.get('/:id/conformity', requireScope('read'), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  const state = _readState(record) || conformity.buildTemplate();
  res.json({ state, summary: conformity.summarise(state) });
}));

router.post('/:id/conformity/start', requireScope('write'), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  if (record.conformityJson) {
    throw new HttpError(409, 'Conformity assessment already started', 'already_started');
  }
  const state = conformity.buildTemplate();
  if (req.body && req.body.route) state.route = req.body.route;
  await _writeState(record.id, state);
  await audit(req, 'project.conformity.start', {
    resource: 'project', resourceId: record.id,
    details: { route: state.route },
  });
  res.json({ state, summary: conformity.summarise(state) });
}));

const ConformityItemSchema = z.object({
  itemId:   z.string().min(1).max(64),
  status:   z.enum(conformity.STATUSES).optional(),
  evidence: z.string().max(4000).optional(),
});
router.patch('/:id/conformity/item', requireScope('write'), validate(ConformityItemSchema), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  const state = _readState(record) || conformity.buildTemplate();
  conformity.updateItem(state, req.body.itemId, {
    status: req.body.status,
    evidence: req.body.evidence,
  });
  await _writeState(record.id, state);
  await audit(req, 'project.conformity.update', {
    resource: 'project', resourceId: record.id,
    details: { itemId: req.body.itemId, status: req.body.status },
  });
  res.json({ state, summary: conformity.summarise(state) });
}));

const AttestSchema = z.object({
  signatureName: z.string().min(2).max(200),
  signatureRole: z.string().min(2).max(200),
});
router.post('/:id/conformity/attest', requireScope('write'), validate(AttestSchema), asyncHandler(async (req, res) => {
  const record = await _loadRecord(req);
  const state = _readState(record);
  if (!state) throw new HttpError(409, 'Start the conformity assessment first', 'not_started');
  try {
    conformity.attest(state, {
      signedBy:      req.user.id,
      signatureName: req.body.signatureName,
      signatureRole: req.body.signatureRole,
    });
  } catch (e) {
    if (e.code === 'not_ready') throw new HttpError(409, e.message, 'not_ready');
    throw e;
  }
  await _writeState(record.id, state);
  await audit(req, 'project.conformity.attest', {
    resource: 'project', resourceId: record.id,
    details: { signedBy: req.user.id, signatureName: req.body.signatureName },
  });
  res.json({ state, summary: conformity.summarise(state) });
}));

router.get('/:id/conformity/checklist-template', requireScope('read'), asyncHandler(async (_req, res) => {
  res.json({ version: conformity.VERSION, sections: conformity.CHECKLIST });
}));

// ─── Model Evaluations (Article 15 — accuracy, robustness, cybersecurity) ─
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

