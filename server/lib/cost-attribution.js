/**
 * Per-tenant cost attribution (Tier 12).
 *
 * Records the variable-cost resources consumed by each tenant so we can
 * compute cost-per-tenant and gross margin. Resources tracked:
 *   - http_compute_ms   : request CPU wall time (proxy for compute $)
 *   - db_query_ms       : Prisma round-trips wall time
 *   - storage_bytes     : delta of object storage usage
 *   - ai_tokens         : LLM tokens (input + output)
 *   - egress_bytes      : response bytes shipped to client
 *
 * Costs are translated to micro-cents using a per-resource rate table that
 * can be overridden by env vars (COST_RATE_<RESOURCE>_UCENTS_PER_UNIT).
 *
 * Writes are best-effort + non-blocking: failures log and return silently
 * so attribution can never harm the hot path.
 */
const prisma = require('./prisma');

// Default rates (micro-cents per unit). Tune to your actual infra COGS.
const DEFAULT_RATES = Object.freeze({
  http_compute_ms: 0.1,    // 1 cent per 100 sec CPU
  db_query_ms:     0.5,    // 1 cent per 20 sec DB time
  storage_bytes:   0.000_001, // ~$0.10/GB-month spread per byte
  ai_tokens:       2.0,    // 2 ucents per token (~$0.02/1k)
  egress_bytes:    0.000_002, // ~$0.20/GB egress
});

function rateFor(resource) {
  const envKey = `COST_RATE_${resource.toUpperCase()}_UCENTS_PER_UNIT`;
  const v = parseFloat(process.env[envKey]);
  if (Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_RATES[resource] || 0;
}

/**
 * Record a resource consumption event for a tenant. Non-blocking: errors
 * are logged but never rethrown to the caller. Quantity must be a finite
 * non-negative number; zero is a no-op.
 *
 * `ucentsOverride`: when the caller already knows the authoritative cost
 * for this event (e.g. ai-budget.js's per-model, per-input/output-token
 * price from modelRouter.estimateCostUcents(), already computed before it
 * calls here), pass it instead of letting `rateFor(resource)`'s flat
 * generic-COGS-proxy rate re-derive a DIFFERENT number for the same event.
 * `ai_tokens`'s flat rate (2.0 ucents/token) is a rough proxy for resources
 * with no per-event authoritative price; AI spend has one, so it should
 * win. See lib/cost-attribution.js#reconcileAiSpend for what this fixed.
 */
async function recordCost({ orgId, resource, quantity, metadata = null, ucentsOverride }) {
  if (!orgId || !resource) return { ok: false, reason: 'invalid_args' };
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return { ok: true, recorded: 0 };

  const ucents = ucentsOverride != null ? Number(ucentsOverride) : q * rateFor(resource);
  const period = currentPeriodKey();
  try {
    await prisma.tenantCostEvent.create({
      data: {
        orgId,
        resource,
        quantity: Math.round(q),
        ucents: Math.round(ucents),
        period,
        metadata: metadata ? JSON.stringify(metadata).slice(0, 4000) : null,
      },
    });
    return { ok: true, ucents };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(JSON.stringify({
        type: 'cost_attribution_error',
        orgId, resource, quantity: q, error: err.message,
      }));
    }
    return { ok: false, reason: 'persistence_error' };
  }
}

/**
 * Aggregate costs for a tenant over a period (default: current month).
 * Returns { total_cents, by_resource: { http_compute_ms: { ucents, units } } }.
 */
async function getTenantCosts(orgId, period) {
  const p = period || currentPeriodKey();
  const rows = await prisma.tenantCostEvent.groupBy({
    by: ['resource'],
    where: { orgId, period: p },
    _sum: { quantity: true, ucents: true },
  }).catch(() => []);

  const byResource = {};
  let totalUcents = 0;
  for (const r of rows) {
    const ucents = Number(r._sum.ucents || 0);
    byResource[r.resource] = {
      units:  Number(r._sum.quantity || 0),
      ucents,
      cents: Math.round(ucents / 1_000),
    };
    totalUcents += ucents;
  }
  return {
    period: p,
    total_cents: Math.round(totalUcents / 1_000),
    total_ucents: totalUcents,
    by_resource: byResource,
  };
}

/**
 * Tenant gross margin for a period.
 * margin = revenue (paid invoices) - cost (sum of cost events).
 */
async function getTenantMargin(orgId, period) {
  const p = period || currentPeriodKey();
  const cost = await getTenantCosts(orgId, p);

  // Sum invoice revenue for the period (matches periodStart YYYY-MM).
  const invoices = await prisma.invoice.findMany({
    where: { orgId, status: 'paid' },
    select: { amountCents: true, periodStart: true },
  }).catch(() => []);
  const revenueCents = invoices
    .filter(i => i.periodStart && periodKey(i.periodStart) === p)
    .reduce((s, i) => s + Number(i.amountCents || 0), 0);

  const marginCents = revenueCents - cost.total_cents;
  const marginPct = revenueCents > 0 ? (marginCents / revenueCents) * 100 : null;
  return {
    period: p,
    revenue_cents: revenueCents,
    cost_cents: cost.total_cents,
    margin_cents: marginCents,
    margin_pct: marginPct,
    by_resource: cost.by_resource,
  };
}

/** Top-N tenants by cost for the period. */
async function topTenantsByCost({ period, limit = 20 } = {}) {
  const p = period || currentPeriodKey();
  const rows = await prisma.tenantCostEvent.groupBy({
    by: ['orgId'],
    where: { period: p },
    _sum: { ucents: true },
    orderBy: { _sum: { ucents: 'desc' } },
    take: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200),
  }).catch(() => []);
  return rows.map(r => ({
    orgId: r.orgId,
    cost_cents: Math.round(Number(r._sum.ucents || 0) / 1_000),
  }));
}

/**
 * Cross-checks the two independent places AI spend gets recorded for the
 * same underlying events: AiSpendEvent (lib/ai-budget.js -- the accurate,
 * per-model, per-input/output-token figure used for budget enforcement)
 * against TenantCostEvent's `ai_tokens` rows (this file -- the mirrored
 * copy shown in tenant cost/margin reporting). They're written from the
 * SAME ucents value at the same call site (see recordCost's
 * `ucentsOverride`), so a healthy period reconciles to an exact match per
 * org; any nonzero delta means either a stale flat-rate estimate slipped
 * back in, or the mirror write silently failed for some events.
 *
 * This is the internal half of "GCP billing cost-attribution
 * reconciliation" -- catches drift between ScopeCash AI's OWN cost-
 * tracking systems. It does NOT compare against a real Google Cloud
 * invoice/Billing API, which needs a live GCP billing account this
 * environment doesn't have (see TODO.md's "Not achievable by an
 * engineering agent" section). Deliberately doesn't also check AiUsage
 * (lib/ai-guardrails.js's third AI-cost table) -- routes/ai.js computes
 * `ucents` once and passes that SAME value to both AiUsage.costUsd and
 * AiSpendEvent.ucents in the same synchronous block, so unlike
 * TenantCostEvent (which re-derived its own number independently) it
 * cannot drift from AiSpendEvent by construction.
 */
async function reconcileAiSpend(period) {
  const p = period || currentPeriodKey();
  const [spendRows, costRows] = await Promise.all([
    prisma.aiSpendEvent.groupBy({ by: ['orgId'], where: { period: p }, _sum: { ucents: true } }).catch(() => []),
    prisma.tenantCostEvent.groupBy({ by: ['orgId'], where: { period: p, resource: 'ai_tokens' }, _sum: { ucents: true } }).catch(() => []),
  ]);
  const spendByOrg = new Map(spendRows.map((r) => [r.orgId, Number(r._sum.ucents || 0)]));
  const costByOrg = new Map(costRows.map((r) => [r.orgId, Number(r._sum.ucents || 0)]));
  const orgIds = new Set([...spendByOrg.keys(), ...costByOrg.keys()]);

  let totalSpendUcents = 0;
  let totalCostUcents = 0;
  const orgs = [...orgIds].map((orgId) => {
    const aiSpendUcents = spendByOrg.get(orgId) || 0;
    const costAttributionUcents = costByOrg.get(orgId) || 0;
    totalSpendUcents += aiSpendUcents;
    totalCostUcents += costAttributionUcents;
    const deltaUcents = costAttributionUcents - aiSpendUcents;
    return {
      orgId,
      ai_spend_usd: aiSpendUcents / 100_000,
      cost_attribution_usd: costAttributionUcents / 100_000,
      delta_usd: deltaUcents / 100_000,
      reconciled: deltaUcents === 0,
    };
  }).sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd));

  return {
    period: p,
    total_ai_spend_usd: totalSpendUcents / 100_000,
    total_cost_attribution_usd: totalCostUcents / 100_000,
    total_delta_usd: (totalCostUcents - totalSpendUcents) / 100_000,
    all_reconciled: orgs.every((o) => o.reconciled),
    orgs,
  };
}

function currentPeriodKey() {
  return periodKey(new Date());
}
function periodKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

module.exports = {
  recordCost,
  getTenantCosts,
  getTenantMargin,
  topTenantsByCost,
  reconcileAiSpend,
  currentPeriodKey,
  rateFor,
};

