/**
 * Admin tenant economics (Tier 12).
 *   GET /api/admin/tenants            list orgs with plan + lane + month-to-date cost
 *   GET /api/admin/tenants/:orgId/cost?period=YYYY-MM   detailed cost breakdown
 *   GET /api/admin/tenants/:orgId/margin?period=YYYY-MM revenue vs cost
 *   GET /api/admin/tenants/top?period=YYYY-MM&limit=20  top spenders
 *   GET /api/admin/tenants/lanes                        lane → tenant census
 */
const express = require('express');
const prisma = require('../lib/prisma');
const cost = require('../lib/cost-attribution');
const { laneForPlan } = require('../lib/lanes');
const ent = require('../lib/entitlements');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

router.get('/', async (req, res, next) => {
  try {
    const period = req.query.period || cost.currentPeriodKey();
    const orgs = await prisma.organization.findMany({
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const out = [];
    for (const o of orgs) {
      let planId = 'free';
      try {
        const sub = await ent.getActiveSubscription(o.id);
        planId = (sub.tier && sub.tier.id) || 'free';
      } catch {}
      const lane = laneForPlan(planId);
      const c = await cost.getTenantCosts(o.id, period);
      out.push({
        orgId: o.id,
        name: o.name,
        createdAt: o.createdAt,
        planId,
        lane: lane.label,
        cost_cents: c.total_cents,
      });
    }
    res.json({ period, tenants: out });
  } catch (err) { next(err); }
});

router.get('/top', async (req, res, next) => {
  try {
    const period = req.query.period || cost.currentPeriodKey();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    const top = await cost.topTenantsByCost({ period, limit });
    res.json({ period, top });
  } catch (err) { next(err); }
});

router.get('/lanes', async (req, res, next) => {
  try {
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    const census = {};
    for (const o of orgs) {
      let planId = 'free';
      try {
        const sub = await ent.getActiveSubscription(o.id);
        planId = (sub.tier && sub.tier.id) || 'free';
      } catch {}
      const lane = laneForPlan(planId).label;
      census[lane] = (census[lane] || 0) + 1;
    }
    res.json({ census });
  } catch (err) { next(err); }
});

router.get('/:orgId/cost', async (req, res, next) => {
  try {
    const period = req.query.period || cost.currentPeriodKey();
    const data = await cost.getTenantCosts(req.params.orgId, period);
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/:orgId/margin', async (req, res, next) => {
  try {
    const period = req.query.period || cost.currentPeriodKey();
    const data = await cost.getTenantMargin(req.params.orgId, period);
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;

