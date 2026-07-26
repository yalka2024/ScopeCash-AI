/**
 * Governance API (Tier 19).
 *
 *  /api/governance/models               GET (admin), POST (admin)
 *  /api/governance/models/:id           GET (admin), PATCH (admin status transition)
 *  /api/governance/models/:id/evals     POST (admin)
 *  /api/governance/models/summary       GET (admin)
 *
 *  /api/governance/policies             GET (any), POST (admin publish)
 *  /api/governance/policies/:slug       GET (any)
 *  /api/governance/policies/:slug/ack   POST (any authed user)
 *  /api/governance/policies/pending     GET (authed)
 *  /api/governance/policies/coverage    GET (admin)
 *
 *  /api/governance/board-reports                 GET (admin), POST (admin)
 *  /api/governance/board-reports/:id             GET (admin)
 *  /api/governance/board-reports/:id/files/:f    GET (admin)
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { z, validate, asyncHandler } = require('../lib/validate');
const modelRegistry = require('../lib/model-registry');
const policyLibrary = require('../lib/policy-library');
const boardReports = require('../lib/board-reports');

const router = express.Router();
router.use(authMiddleware);

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
}

// ------- Models -------
const RegisterSchema = z.object({
  name: z.string().min(1).max(200),
  provider: z.string().min(1).max(80),
  modelId: z.string().min(1).max(200),
  version: z.string().max(80).optional(),
  purpose: z.string().max(1000).optional(),
  riskTier: z.enum(['minimal', 'limited', 'high', 'unacceptable']).optional(),
  dataInputs: z.array(z.string()).optional(),
  dataOutputs: z.array(z.string()).optional(),
  ownerId: z.string().optional(),
});
router.get('/models', adminOnly, asyncHandler(async (req, res) => {
  const status = req.query.status || null;
  const riskTier = req.query.riskTier || null;
  res.json({ models: await modelRegistry.listModels({ status, riskTier }) });
}));
router.post('/models', adminOnly, validate(RegisterSchema), asyncHandler(async (req, res) => {
  const row = await modelRegistry.register({ ...req.body, registeredBy: req.user.id });
  res.status(201).json(row);
}));
router.get('/models/summary', adminOnly, asyncHandler(async (_req, res) => {
  res.json(await modelRegistry.summary());
}));
router.get('/models/:id', adminOnly, asyncHandler(async (req, res) => {
  const row = await modelRegistry.getModel(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  res.json(row);
}));
const TransitionSchema = z.object({
  status: z.enum(['draft', 'in_review', 'approved', 'retired']),
  comment: z.string().max(2000).optional(),
});
router.patch('/models/:id', adminOnly, validate(TransitionSchema), asyncHandler(async (req, res) => {
  try {
    const row = await modelRegistry.transition(req.params.id, req.body.status, { actorId: req.user.id, comment: req.body.comment });
    res.json(row);
  } catch (err) {
    if (err.message === 'high_risk_requires_passing_evaluation') {
      return res.status(409).json({ error: err.message, code: err.message });
    }
    if (err.message === 'model_not_found') {
      return res.status(404).json({ error: err.message, code: err.message });
    }
    throw err;
  }
}));
const EvalSchema = z.object({
  suite: z.string().min(1).max(80),
  metric: z.string().min(1).max(80),
  score: z.number(),
  passed: z.boolean(),
  notes: z.string().max(2000).optional(),
});
router.post('/models/:id/evals', adminOnly, validate(EvalSchema), asyncHandler(async (req, res) => {
  const row = await modelRegistry.recordEvaluation(req.params.id, { ...req.body, runBy: req.user.id });
  res.status(201).json(row);
}));

// ------- Policies -------
router.get('/policies', asyncHandler(async (_req, res) => {
  res.json({ policies: await policyLibrary.listPolicies() });
}));
const PublishSchema = z.object({
  title: z.string().max(200).optional(),
  summary: z.string().max(1000).optional(),
  body: z.string().min(1).max(200000),
  version: z.string().min(1).max(40),
  requiresAck: z.boolean().optional(),
});
router.post('/policies/:slug', adminOnly, validate(PublishSchema), asyncHandler(async (req, res) => {
  const row = await policyLibrary.publish(req.params.slug, { ...req.body, publishedBy: req.user.id });
  res.status(201).json(row);
}));
router.get('/policies/pending', asyncHandler(async (req, res) => {
  res.json({ pending: await policyLibrary.pendingForUser(req.user.id) });
}));
router.get('/policies/coverage', adminOnly, asyncHandler(async (_req, res) => {
  res.json(await policyLibrary.complianceReport());
}));
router.get('/policies/:slug', asyncHandler(async (req, res) => {
  const row = await policyLibrary.getPolicy(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  res.json(row);
}));
router.post('/policies/:slug/ack', asyncHandler(async (req, res) => {
  try {
    const row = await policyLibrary.acknowledge({ userId: req.user.id, slug: req.params.slug });
    res.status(201).json(row);
  } catch (err) {
    if (err.message === 'policy_not_found') {
      return res.status(404).json({ error: err.message, code: err.message });
    }
    throw err;
  }
}));

// ------- Board reports -------
const ReportSchema = z.object({ period: z.string().regex(/^\d{4}-(Q[1-4]|\d{2})$/).optional() });
router.get('/board-reports', adminOnly, asyncHandler(async (_req, res) => {
  res.json({ reports: await boardReports.listReports() });
}));
router.post('/board-reports', adminOnly, validate(ReportSchema), asyncHandler(async (req, res) => {
  try {
    const row = await boardReports.generate({ period: req.body.period || null, requestedBy: req.user.id });
    res.status(201).json(row);
  } catch (err) {
    if (err.message === 'invalid_period') return res.status(400).json({ error: err.message, code: err.message });
    throw err;
  }
}));
router.get('/board-reports/:id', adminOnly, asyncHandler(async (req, res) => {
  const row = await boardReports.getReport(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  res.json(row);
}));
router.get('/board-reports/:id/files/:file', adminOnly, asyncHandler(async (req, res) => {
  const full = boardReports.readArtifact(req.params.id, req.params.file);
  if (!full) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  const ext = path.extname(full).toLowerCase();
  const mime = ext === '.json' ? 'application/json' : ext === '.md' ? 'text/markdown' : 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  fs.createReadStream(full).pipe(res);
}));

module.exports = router;

