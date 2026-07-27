/**
 * AI economics admin routes (Tier 13).
 *   GET /api/admin/ai/models                    list registered models + prices
 *   GET /api/admin/ai/spend?period=YYYY-MM      org-wide AI spend breakdown
 *   GET /api/admin/ai/spend/:orgId?period=...   per-tenant breakdown
 *   GET /api/admin/ai/reconciliation?period=... AiSpendEvent vs TenantCostEvent drift check
 *   GET /api/admin/ai/budgets                   plan budgets in effect
 *   GET /api/admin/ai/evals                     latest eval run summaries
 *   POST /api/admin/ai/evals/run                trigger eval suite (smoke)
 *   GET /api/admin/ai/observability             consolidated AI quality + cost dashboard
 */
const express = require('express');
const prisma = require('../lib/prisma');
const router_lib = require('../lib/model-router');
const budget = require('../lib/ai-budget');
const evals = require('../lib/ai-evals');
const costAttribution = require('../lib/cost-attribution');
const { runWithSystemAccess } = require('../lib/tenant-context');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

router.get('/models', (_req, res) => {
  res.json({ strategy: router_lib.strategy(), models: router_lib.listModels() });
});

router.get('/budgets', (_req, res) => {
  const out = {};
  for (const plan of Object.keys(budget.DEFAULT_BUDGETS_USD)) {
    out[plan] = { budget_usd_per_month: budget.budgetUsdForPlan(plan) };
  }
  res.json({ budgets: out });
});

router.get('/spend', async (req, res, next) => {
  try {
    const period = req.query.period || budget.currentPeriodKey();
    const rows = await prisma.aiSpendEvent.groupBy({
      by: ['orgId', 'model'],
      where: { orgId: req.user.orgId, period },   // tenant-scoped: a tenant admin sees only their own org's spend
      _sum: { ucents: true, totalTokens: true },
      orderBy: { _sum: { ucents: 'desc' } },
      take: 200,
    }).catch(() => []);
    const byOrg = new Map();
    for (const r of rows) {
      if (!byOrg.has(r.orgId)) byOrg.set(r.orgId, { orgId: r.orgId, ucents: 0, tokens: 0, models: [] });
      const o = byOrg.get(r.orgId);
      o.ucents += Number(r._sum.ucents || 0);
      o.tokens += Number(r._sum.totalTokens || 0);
      o.models.push({ model: r.model, ucents: Number(r._sum.ucents || 0), tokens: Number(r._sum.totalTokens || 0) });
    }
    res.json({
      period,
      total_usd: ([...byOrg.values()].reduce((s, o) => s + o.ucents, 0)) / 100_000,
      orgs: [...byOrg.values()].map(o => ({
        orgId: o.orgId,
        spent_usd: o.ucents / 100_000,
        tokens: o.tokens,
        models: o.models,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/spend/:orgId', async (req, res, next) => {
  try {
    const period = req.query.period || budget.currentPeriodKey();
    const orgId = req.params.orgId;
    // Tenant isolation: a tenant admin may only read their OWN org's spend.
    if (orgId !== req.user.orgId) return res.status(403).json({ error: 'forbidden', code: 'cross_tenant' });
    const rows = await prisma.aiSpendEvent.groupBy({
      by: ['model', 'provider'],
      where: { orgId, period },
      _sum: { ucents: true, promptTokens: true, completionTokens: true, totalTokens: true },
      orderBy: { _sum: { ucents: 'desc' } },
    }).catch(() => []);
    const status = await budget.getStatus(orgId, req.tenant.planId);
    res.json({
      period,
      orgId,
      budget: status,
      breakdown: rows.map(r => ({
        model: r.model,
        provider: r.provider,
        ucents: Number(r._sum.ucents || 0),
        usd: Number(r._sum.ucents || 0) / 100_000,
        promptTokens: Number(r._sum.promptTokens || 0),
        completionTokens: Number(r._sum.completionTokens || 0),
        totalTokens: Number(r._sum.totalTokens || 0),
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/ai/reconciliation?period=YYYY-MM — cross-checks
// AiSpendEvent (accurate per-model AI cost) against TenantCostEvent's
// mirrored ai_tokens rows (tenant cost/margin reporting) for the same
// period, per org. This is the internal half of "GCP billing
// cost-attribution reconciliation" -- it does NOT compare against a real
// Google Cloud Billing API/invoice, which needs a live GCP billing account
// this environment doesn't have (see TODO.md).
//
// Genuinely cross-tenant (aggregates every org) — an audited, admin-only
// exception to per-org scoping, matching routes/tenants.js's `/top` (same
// underlying lib/cost-attribution.js). Without runWithSystemAccess, RLS
// under real Postgres would fail closed to just the caller's own org
// (attachTenant already put this request inside runWithOrg), silently
// under-reporting drift rather than exposing anything -- still a real
// correctness bug for the one thing this endpoint exists to catch.
router.get('/reconciliation', async (req, res, next) => {
  try {
    const result = await runWithSystemAccess(() => costAttribution.reconcileAiSpend(req.query.period));
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/evals', async (_req, res, next) => {
  try {
    const runs = await prisma.evalRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, suite: true, model: true, score: true, passed: true, total: true, durationMs: true, createdAt: true },
    }).catch(() => []);
    res.json({ runs });
  } catch (err) { next(err); }
});

router.post('/evals/run', async (req, res, next) => {
  try {
    const suite = (req.body && req.body.suite) || 'smoke';
    const modelHint = (req.body && req.body.model) || null;
    const result = await evals.runSuite({ suite, modelHint });
    res.json(result);
  } catch (err) { next(err); }
});

// Consolidated AI observability — health (requests/blocked/tokens/cost),
// per-model + daily trends, eval quality, and current-period spend in one call.
router.get('/observability', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 90);
    const since = new Date(Date.now() - days * 86400000);

    const usage = await prisma.aiUsage.findMany({
      where: { createdAt: { gte: since } },
      select: { outcome: true, totalTokens: true, costUsd: true, model: true, createdAt: true },
      take: 10000,
    }).catch(() => []);

    const total = usage.length;
    const blocked = usage.filter(u => u.outcome === 'blocked').length;
    const tokens = usage.reduce((s, u) => s + (u.totalTokens || 0), 0);
    const costUsd = usage.reduce((s, u) => s + (u.costUsd || 0), 0);

    const byModel = {};
    const daily = {};
    for (const u of usage) {
      const m = u.model || 'unknown';
      byModel[m] = byModel[m] || { requests: 0, tokens: 0 };
      byModel[m].requests++; byModel[m].tokens += u.totalTokens || 0;
      const d = new Date(u.createdAt).toISOString().slice(0, 10);
      daily[d] = daily[d] || { requests: 0, blocked: 0, tokens: 0 };
      daily[d].requests++; if (u.outcome === 'blocked') daily[d].blocked++; daily[d].tokens += u.totalTokens || 0;
    }

    const runs = await prisma.evalRun.findMany({
      orderBy: { createdAt: 'desc' }, take: 50,
      select: { suite: true, model: true, score: true, passed: true, total: true, createdAt: true },
    }).catch(() => []);
    const latestBySuite = {};
    for (const r of runs) { if (!latestBySuite[r.suite]) latestBySuite[r.suite] = r; }
    const avgScore = runs.length ? runs.reduce((s, r) => s + (r.score || 0), 0) / runs.length : null;

    const period = budget.currentPeriodKey();
    const spendRows = await prisma.aiSpendEvent.groupBy({
      by: ['model'], where: { period }, _sum: { ucents: true, totalTokens: true },
    }).catch(() => []);
    const spendUsd = spendRows.reduce((s, r) => s + Number(r._sum.ucents || 0), 0) / 100_000;

    res.json({
      window_days: days,
      ai_health: {
        requests: total,
        blocked,
        blocked_rate: total ? Number((blocked / total).toFixed(4)) : 0,
        tokens,
        cost_usd: Number(costUsd.toFixed(4)),
      },
      by_model: byModel,
      daily,
      eval_quality: { avg_score: avgScore, latest_by_suite: latestBySuite, recent: runs.slice(0, 10) },
      spend: {
        period,
        total_usd: spendUsd,
        by_model: spendRows.map(r => ({ model: r.model, usd: Number(r._sum.ucents || 0) / 100_000, tokens: Number(r._sum.totalTokens || 0) })),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;

