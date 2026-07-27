/**
 * AI budgets (Tier 13).
 *
 * Two-layer enforcement:
 *   1. Per-tenant monthly USD ceiling (plan-aware, env-overridable):
 *        AI_BUDGET_<PLAN>_USD_PER_MONTH
 *   2. Soft warning at 75%, hard cutoff at 100% (returns 402-style error code).
 *
 * Spend is computed from AiSpendEvent rows for the current period (YYYY-MM).
 * A small in-process cache (60s TTL) protects the hot path from per-request
 * aggregations.
 */
const prisma = require('./prisma');

const DEFAULT_BUDGETS_USD = Object.freeze({
  free:           5,
  starter:       50,
  pro:          500,
  enterprise:  5000,
});

function budgetUsdForPlan(planId) {
  const envKey = `AI_BUDGET_${String(planId).toUpperCase()}_USD_PER_MONTH`;
  const v = parseFloat(process.env[envKey]);
  if (Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_BUDGETS_USD[planId] != null ? DEFAULT_BUDGETS_USD[planId] : DEFAULT_BUDGETS_USD.free;
}

const SPEND_CACHE = new Map(); // key: orgId:period -> { ucents, ts }
const TTL_MS = 60_000;

function _cacheKey(orgId, period) { return `${orgId}::${period}`; }
function _cacheGet(orgId, period) {
  const v = SPEND_CACHE.get(_cacheKey(orgId, period));
  if (!v) return null;
  if (Date.now() - v.ts > TTL_MS) { SPEND_CACHE.delete(_cacheKey(orgId, period)); return null; }
  return v.ucents;
}
function _cacheSet(orgId, period, ucents) {
  SPEND_CACHE.set(_cacheKey(orgId, period), { ucents, ts: Date.now() });
}
function invalidateSpendCache(orgId, period) {
  if (orgId && period) SPEND_CACHE.delete(_cacheKey(orgId, period));
  else if (orgId) {
    for (const k of SPEND_CACHE.keys()) if (k.startsWith(`${orgId}::`)) SPEND_CACHE.delete(k);
  } else SPEND_CACHE.clear();
}

async function getMonthlySpendUcents(orgId, period) {
  if (!orgId) return 0;
  const p = period || currentPeriodKey();
  const cached = _cacheGet(orgId, p);
  if (cached != null) return cached;
  const agg = await prisma.aiSpendEvent.aggregate({
    where: { orgId, period: p },
    _sum: { ucents: true },
  }).catch(() => ({ _sum: { ucents: 0 } }));
  const ucents = Number(agg._sum.ucents || 0);
  _cacheSet(orgId, p, ucents);
  return ucents;
}

async function getStatus(orgId, planId) {
  const period = currentPeriodKey();
  const ucents = await getMonthlySpendUcents(orgId, period);
  const budgetUcents = Math.round(budgetUsdForPlan(planId) * 100_000);
  const utilization = budgetUcents > 0 ? ucents / budgetUcents : 0;
  return {
    period,
    planId,
    spent_ucents: ucents,
    spent_usd: ucents / 100_000,
    budget_ucents: budgetUcents,
    budget_usd: budgetUcents / 100_000,
    utilization,
    state: utilization >= 1 ? 'cutoff' : utilization >= 0.75 ? 'warn' : 'ok',
    remaining_ucents: Math.max(0, budgetUcents - ucents),
  };
}

/**
 * Express-style guard. Run AFTER attachTenant. Adds req.aiBudget for the
 * route handler; rejects with 429 (cutoff) when over budget.
 */
async function aiBudgetGuard(req, res, next) {
  if (!req.tenant) return res.status(401).json({ error: 'tenant_required', code: 'tenant_required' });
  try {
    const status = await getStatus(req.tenant.orgId, req.tenant.planId);
    res.setHeader('x-ai-budget-utilization', status.utilization.toFixed(3));
    res.setHeader('x-ai-budget-remaining-usd', status.remaining_ucents > 0 ? (status.remaining_ucents / 100_000).toFixed(4) : '0');
    if (status.state === 'cutoff') {
      return res.status(429).json({
        error: 'AI budget exhausted for the current period',
        code: 'ai_budget_exhausted',
        period: status.period,
        budget_usd: status.budget_usd,
        spent_usd: status.spent_usd,
      });
    }
    req.aiBudget = status;
    return next();
  } catch (err) {
    // Fail-open on persistence errors so AI features stay alive — but log.
    if (process.env.NODE_ENV !== 'test') {
      console.error(JSON.stringify({ type: 'ai_budget_guard_error', error: err.message }));
    }
    req.aiBudget = { state: 'unknown', utilization: 0 };
    return next();
  }
}

/**
 * Record AI spend after a model call. Always called from server-side AI routes.
 * Updates the per-tenant cost-attribution rollup with `ai_tokens` resource so
 * the Tenant economics dashboard reflects AI spend in the same view.
 */
async function recordAiSpend({ orgId, userId, modelId, provider, promptTokens, completionTokens, ucents, period, outcome = 'success' }) {
  if (!orgId) return { ok: false, reason: 'no_org' };
  const p = period || currentPeriodKey();
  try {
    await prisma.aiSpendEvent.create({
      data: {
        orgId, userId: userId || null,
        provider: provider || null,
        model: modelId || null,
        promptTokens: promptTokens || 0,
        completionTokens: completionTokens || 0,
        totalTokens: (promptTokens || 0) + (completionTokens || 0),
        ucents: ucents || 0,
        period: p,
        outcome,
      },
    });
    invalidateSpendCache(orgId, p);

    // Mirror into tenant cost attribution so the dashboard rolls up cleanly.
    // Passes this event's own already-computed ucents (ucentsOverride)
    // instead of letting cost-attribution.js re-derive a cost from its flat
    // generic ai_tokens rate -- that rate is a rough proxy for resources
    // with no per-event price; AI spend has an accurate, per-model one, so
    // it should win. See lib/cost-attribution.js#reconcileAiSpend for the
    // drift this fixes (found in review: the flat rate diverged from real
    // per-model pricing by up to ~10x for flash-tier requests).
    try {
      const cost = require('./cost-attribution');
      await cost.recordCost({
        orgId,
        resource: 'ai_tokens',
        quantity: (promptTokens || 0) + (completionTokens || 0),
        ucentsOverride: ucents || 0,
        metadata: { model: modelId, provider },
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error(JSON.stringify({ type: 'cost_attribution_mirror_error', orgId, error: err.message }));
      }
    }

    return { ok: true };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(JSON.stringify({ type: 'ai_spend_record_error', orgId, error: err.message }));
    }
    return { ok: false, reason: 'persistence_error' };
  }
}

function currentPeriodKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  budgetUsdForPlan,
  getMonthlySpendUcents,
  getStatus,
  aiBudgetGuard,
  recordAiSpend,
  invalidateSpendCache,
  currentPeriodKey,
  DEFAULT_BUDGETS_USD,
};

