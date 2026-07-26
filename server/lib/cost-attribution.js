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
 */
async function recordCost({ orgId, resource, quantity, metadata = null }) {
  if (!orgId || !resource) return { ok: false, reason: 'invalid_args' };
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return { ok: true, recorded: 0 };

  const ucents = q * rateFor(resource);
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
  currentPeriodKey,
  rateFor,
};

