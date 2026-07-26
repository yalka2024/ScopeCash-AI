/**
 * Growth API (Tier 14).
 *
 * User-facing:
 *   POST /api/growth/events            client-side event ingestion
 *   GET  /api/growth/onboarding        my onboarding state
 *   POST /api/growth/onboarding/:step  mark a step complete (server may
 *                                      also mark steps from internal flows)
 *   GET  /api/growth/flags             effective flags for current user
 *
 * Admin-only:
 *   GET  /api/admin/growth/funnel?steps=signup,email_verified,first_record
 *   GET  /api/admin/growth/flags       list all defined flags
 *   PUT  /api/admin/growth/flags/:key  upsert flag config
 *   DELETE /api/admin/growth/flags/:key
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const events = require('../lib/growth-events');
const onboarding = require('../lib/onboarding');
const flags = require('../lib/feature-flags');
const { z, validate, asyncHandler } = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

const TrackSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z0-9._-]+$/i, 'invalid event name'),
  properties: z.record(z.any()).optional(),
});
router.post('/events', validate(TrackSchema), asyncHandler(async (req, res) => {
  events.track({
    name: req.body.name,
    userId: req.user.id,
    orgId: req.tenant && req.tenant.orgId,
    properties: req.body.properties || null,
    source: 'client',
  });
  res.status(202).json({ ok: true });
}));

router.get('/onboarding', asyncHandler(async (req, res) => {
  const state = await onboarding.getState(req.user.id);
  res.json(state);
}));

const StepSchema = z.object({ properties: z.record(z.any()).optional() });
router.post('/onboarding/:step', validate(StepSchema), asyncHandler(async (req, res) => {
  const result = await onboarding.markStep(req.user.id, req.params.step, {
    orgId: req.tenant && req.tenant.orgId,
    properties: req.body.properties || null,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result.state);
}));

router.get('/flags', asyncHandler(async (req, res) => {
  const all = await flags.listFlags();
  const ctx = {
    userId: req.user.id,
    orgId: req.tenant && req.tenant.orgId,
    planId: req.tenant && req.tenant.planId,
  };
  const out = {};
  for (const f of all) {
    out[f.key] = await flags.isEnabled(f.key, ctx);
  }
  res.json({ flags: out });
}));

// ---- Admin sub-router ----
const admin = express.Router();
admin.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

admin.get('/funnel', asyncHandler(async (req, res) => {
  const steps = (req.query.steps || 'signup,email_verified,first_record,activated')
    .split(',').map(s => s.trim()).filter(Boolean);
  const sinceMs = Math.min(parseInt(req.query.sinceMs, 10) || (7 * 24 * 3600 * 1000), 90 * 24 * 3600 * 1000);
  const orgId = req.query.orgId || null;
  const rows = await events.funnel(steps, { sinceMs, orgId });
  res.json({ steps: rows, sinceMs });
}));

admin.get('/flags', asyncHandler(async (_req, res) => {
  res.json({ flags: await flags.listFlags() });
}));

const FlagSchema = z.object({
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().min(0).max(100).optional(),
  planAllowList: z.string().max(200).nullable().optional(),
  orgAllowList: z.string().max(2000).nullable().optional(),
  orgDenyList: z.string().max(2000).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
admin.put('/flags/:key', validate(FlagSchema), asyncHandler(async (req, res) => {
  const row = await flags.upsertFlag(req.params.key, req.body || {});
  res.json(row);
}));

admin.delete('/flags/:key', asyncHandler(async (req, res) => {
  await flags.deleteFlag(req.params.key);
  res.json({ ok: true });
}));

router.use('/admin', admin);

module.exports = router;

