/**
 * api_calls_per_month metering.
 *
 * This meter is different in kind from every other one: it ticks on EVERY
 * authenticated API request, so the straightforward implementation
 * (middleware/entitlements.js#enforceMeter -> usage-meter.recordUsage) would
 * add one UsageCounter read plus a two-write transaction to every request in
 * the system. That is a real throughput cost for a counter whose only job is
 * to compare against a monthly ceiling.
 *
 * Instead: enforcement reads an in-process cache of the persisted counter and
 * adds locally-buffered increments, so the hot path touches no database at
 * all. Buffered counts are flushed to the real UsageCounter/UsageEvent tables
 * on a timer and at shutdown.
 *
 * Tradeoff, stated plainly: a hard crash (SIGKILL, OOM, power loss) loses up
 * to FLUSH_INTERVAL_MS of counts for the affected instance. That is
 * acceptable here because the meter's purpose is quota enforcement, where
 * undercounting by a few seconds of traffic is harmless; it is deliberately
 * NOT how records_per_month or ai_tokens are handled, since those are
 * lower-volume and billed per unit, so they stay fully durable per event.
 */
const ent = require('./entitlements');
const meter = require('./usage-meter');
const { runWithOrg } = require('./tenant-context');

const FLUSH_INTERVAL_MS = Number(process.env.API_CALL_METER_FLUSH_MS || 15_000);
const COUNTER_TTL_MS = Number(process.env.API_CALL_METER_TTL_MS || 30_000);

// "orgId|period" -> units not yet written to the database. Keyed by period,
// not just org, so units incurred just before a month boundary are still
// attributed to the month they happened in when the flush lands after it.
const PENDING = new Map();
// orgId -> { period, value, expiresAt } snapshot of the persisted counter
const CACHE = new Map();
// orgId -> number of flushes that have committed for it. Used to detect a
// flush landing while a cache refresh is in flight; see checkAndRecord.
const FLUSH_GEN = new Map();

const pendingKey = (orgId, period) => `${orgId}|${period}`;

let flushTimer = null;

function ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().then(evictStaleCache).catch(() => {});
  }, FLUSH_INTERVAL_MS);
  // Never hold the process (or a Jest worker) open just for the flush tick.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Check the org against its api_calls_per_month limit and count this call.
 * Returns { allowed, used, limit, remaining }. `used` includes the call
 * being checked, so a limit of 1000 permits exactly 1000 calls.
 */
async function checkAndRecord(orgId, knownTier) {
  if (!orgId) return { allowed: true, used: 0, limit: -1, remaining: Infinity };
  // Fail open on a limit-resolution failure. attachTenant deliberately treats
  // an unreadable Subscription row as free-tier-and-keep-serving; letting this
  // lookup throw would convert that documented fail-open into a 500 on every
  // authenticated request while the billing table is unavailable.
  const limit = await ent.getLimit(orgId, 'api_calls_per_month', knownTier)
    .catch(() => -1);
  const period = ent.currentPeriodKey();

  let cached = CACHE.get(orgId);
  if (!cached || cached.period !== period || cached.expiresAt <= Date.now()) {
    // The refresh and a concurrent flush both mutate CACHE across an await,
    // and they can interleave either way: the SELECT may or may not observe a
    // flush that commits mid-read, while that flush separately folds its own
    // delta into the cache. Blindly storing the read result therefore either
    // double-counts the flushed units or discards them. Detect the overlap
    // with a per-org flush generation and, when one happened, keep the
    // already-folded cache entry rather than the ambiguous read.
    const genBefore = FLUSH_GEN.get(orgId) || 0;
    const persisted = await meter.getUsage(orgId, 'api_calls_per_month', period).catch(() => 0);
    const current = CACHE.get(orgId);
    const flushIntervened = (FLUSH_GEN.get(orgId) || 0) !== genBefore;
    cached = (flushIntervened && current && current.period === period)
      ? current
      : { period, value: persisted, expiresAt: Date.now() + COUNTER_TTL_MS };
    CACHE.set(orgId, cached);
  }

  const key = pendingKey(orgId, period);
  const pending = PENDING.get(key) || 0;
  const used = cached.value + pending + 1;

  // Unlimited tiers still get counted (the number is real, and billing/
  // analytics read it) but are never blocked.
  PENDING.set(key, pending + 1);
  ensureTimer();

  if (limit === -1) return { allowed: true, used, limit: -1, remaining: Infinity };
  return { allowed: used <= limit, used, limit, remaining: Math.max(0, limit - used) };
}

/** Persist all buffered counts. Safe to call concurrently and at shutdown. */
async function flush() {
  if (PENDING.size === 0) return { flushed: 0 };
  // Swap the buffer out first so concurrent requests keep accumulating into a
  // fresh map rather than having their increments dropped mid-write.
  const batch = [...PENDING.entries()];
  PENDING.clear();
  let flushed = 0;
  for (const [key, quantity] of batch) {
    if (quantity <= 0) continue;
    const sep = key.lastIndexOf('|');
    const orgId = key.slice(0, sep);
    const period = key.slice(sep + 1);
    // runWithOrg is required, not decorative: flush() is driven by a bare
    // setInterval and by gracefulShutdown, neither of which carries a tenant
    // context. On Postgres, RLS is fail-closed with FORCE ROW LEVEL SECURITY,
    // so the UsageEvent insert and UsageCounter upsert would fail their WITH
    // CHECK policy, recordUsage would swallow it, and the units would be
    // re-queued forever — the persisted counter would sit at 0 permanently
    // and the limit would only ever be enforced against this one process's
    // in-memory buffer. Scoped per-org rather than runWithSystemAccess since
    // each write belongs to exactly one tenant.
    const res = await runWithOrg(orgId, () => meter.recordUsage({
      orgId, meter: 'api_calls_per_month', quantity, period,
      metadata: { source: 'api-call-meter', buffered: true },
    })).catch(() => ({ ok: false }));
    if (res && res.ok) {
      flushed += quantity;
      // Fold the write into the cache so the next check doesn't have to
      // re-read it, and doesn't double-count what we just persisted. Only for
      // the current period — an entry for a period that has already rolled
      // over is not what a fresh check will look at.
      const cached = CACHE.get(orgId);
      if (cached && cached.period === period) cached.value += quantity;
      FLUSH_GEN.set(orgId, (FLUSH_GEN.get(orgId) || 0) + 1);
    } else {
      // Persistence failed — put the units back so they aren't silently lost.
      PENDING.set(key, (PENDING.get(key) || 0) + quantity);
    }
  }
  return { flushed };
}

/**
 * Drop cache entries for orgs with no buffered traffic and an expired TTL.
 * Without this the cache is append-only: one entry per org that has ever made
 * a request, retained for the process's lifetime.
 */
function evictStaleCache() {
  const now = Date.now();
  for (const [orgId, entry] of CACHE) {
    if (entry.expiresAt > now) continue;
    if (PENDING.has(pendingKey(orgId, entry.period))) continue;
    CACHE.delete(orgId);
    FLUSH_GEN.delete(orgId);
  }
}

/** Test/diagnostic helper — clears buffers and cached counters. */
function _reset() {
  PENDING.clear();
  CACHE.clear();
  FLUSH_GEN.clear();
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

module.exports = { checkAndRecord, flush, evictStaleCache, _reset, FLUSH_INTERVAL_MS };
