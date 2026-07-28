/**
 * Operations API (Tier 17) — admin only.
 *
 *   GET    /api/operations/slos                 list SLOs + computed SLIs
 *   GET    /api/operations/slos/:id             one SLO
 *   GET    /api/operations/incidents            list incidents (admin view)
 *   POST   /api/operations/incidents            open new incident
 *   GET    /api/operations/incidents/:id        incident with timeline
 *   POST   /api/operations/incidents/:id/updates  add update / change status
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const slo = require('../lib/slo');
const incidents = require('../lib/incidents');
const { z, validate, asyncHandler } = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);
// attachTenant resolves the org + plan and establishes runWithOrg (RLS
// context on Postgres). It is also where api_calls_per_month is counted, so
// a router that skips it is invisible to that quota — see middleware/tenant.js.
router.use(attachTenant);
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

router.get('/slos', asyncHandler(async (_req, res) => {
  const all = await slo.computeAll();
  res.json({ slos: all });
}));

router.get('/slos/:id', asyncHandler(async (req, res) => {
  const def = slo.definitions().find(d => d.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown SLO', code: 'not_found' });
  res.json(await slo.compute(def));
}));

router.get('/incidents', asyncHandler(async (req, res) => {
  const includeResolved = req.query.includeResolved !== 'false';
  res.json({ incidents: await incidents.list({ includeResolved }) });
}));

const OpenSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).optional(),
  component: z.string().max(80).optional(),
  message: z.string().max(2000).optional(),
  publish: z.boolean().optional(),
});
router.post('/incidents', validate(OpenSchema), asyncHandler(async (req, res) => {
  const inc = await incidents.open({
    title: req.body.title,
    severity: req.body.severity || 'sev3',
    component: req.body.component || null,
    message: req.body.message || '',
    publish: req.body.publish !== false,
    openedBy: req.user.id,
  });
  res.status(201).json(inc);
}));

router.get('/incidents/:id', asyncHandler(async (req, res) => {
  const inc = await incidents.getWithUpdates(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  res.json(inc);
}));

const UpdateSchema = z.object({
  status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved']).optional(),
  message: z.string().max(2000).optional(),
  publish: z.boolean().optional(),
});
router.post('/incidents/:id/updates', validate(UpdateSchema), asyncHandler(async (req, res) => {
  const inc = await incidents.update(req.params.id, {
    status: req.body.status || null,
    message: req.body.message || '',
    publish: req.body.publish === undefined ? null : req.body.publish,
    authorId: req.user.id,
  });
  res.json(inc);
}));

module.exports = router;

