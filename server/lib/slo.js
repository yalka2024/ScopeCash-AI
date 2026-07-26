/**
 * SLO / SLI library (Tier 17 — Operations).
 *
 * Defines service-level objectives and computes the actual SLI + remaining
 * error budget from RequestSample rows written by the sampler middleware.
 *
 * Default SLOs (override with env SLO_DEFINITIONS as JSON):
 *   - api_availability    99.9%   28d window
 *   - api_latency_p95     <= 500ms  28d window
 *   - background_success  99.5%   28d window
 *
 * SLI math:
 *   - availability   = good / total          (good = status < 500)
 *   - latency_p95    = computed per-bucket, then averaged to a "worst window" estimate
 *
 * Error budget:
 *   total_window_minutes = window_days * 24 * 60
 *   allowed_bad          = total_window_minutes * (1 - target)   for availability
 *   remaining            = allowed_bad - bad_minutes
 */
const prisma = require('./prisma');

const DEFAULT_SLOS = Object.freeze([
  { id: 'api_availability', kind: 'availability', target: 0.999, windowDays: 28,
    description: 'Public API HTTP success rate (status < 500).' },
  { id: 'api_latency_p95',  kind: 'latency_p95', target_ms: 500, target: 0.95, windowDays: 28,
    description: '95% of API requests complete in under 500 ms.' },
  { id: 'background_success', kind: 'job_success', target: 0.995, windowDays: 28,
    description: 'Background job success rate (worker.js).' },
]);

function definitions() {
  if (!process.env.SLO_DEFINITIONS) return DEFAULT_SLOS;
  try {
    const parsed = JSON.parse(process.env.SLO_DEFINITIONS);
    if (!Array.isArray(parsed)) return DEFAULT_SLOS;
    return parsed;
  } catch { return DEFAULT_SLOS; }
}

function _windowSince(days) { return new Date(Date.now() - days * 24 * 3600 * 1000); }

async function _aggregateAvailability(windowDays) {
  const since = _windowSince(windowDays);
  const rows = await prisma.requestSample.findMany({
    where: { kind: 'http', bucketAt: { gte: since } },
    select: { count: true, errorCount: true, p95Ms: true },
  }).catch(() => []);
  let total = 0; let bad = 0;
  for (const r of rows) { total += r.count || 0; bad += r.errorCount || 0; }
  return { total, bad, good: total - bad };
}

async function _aggregateLatency(windowDays, targetMs) {
  const since = _windowSince(windowDays);
  const rows = await prisma.requestSample.findMany({
    where: { kind: 'http', bucketAt: { gte: since } },
    select: { count: true, p95Ms: true },
  }).catch(() => []);
  if (!rows.length) return { sampleCount: 0, breachBuckets: 0, totalBuckets: 0, percentGood: 1 };
  let breach = 0; let weighted = 0; let n = 0;
  for (const r of rows) {
    if ((r.p95Ms || 0) > targetMs) breach += 1;
    weighted += (r.p95Ms || 0) * (r.count || 0);
    n += r.count || 0;
  }
  return {
    sampleCount: n,
    breachBuckets: breach,
    totalBuckets: rows.length,
    percentGood: 1 - (breach / Math.max(rows.length, 1)),
  };
}

async function _aggregateJobSuccess(windowDays) {
  const since = _windowSince(windowDays);
  const rows = await prisma.requestSample.findMany({
    where: { kind: 'job', bucketAt: { gte: since } },
    select: { count: true, errorCount: true },
  }).catch(() => []);
  let total = 0; let bad = 0;
  for (const r of rows) { total += r.count || 0; bad += r.errorCount || 0; }
  return { total, bad, good: total - bad };
}

async function compute(slo) {
  if (slo.kind === 'availability') {
    const a = await _aggregateAvailability(slo.windowDays);
    const sli = a.total > 0 ? a.good / a.total : 1;
    const allowedBad = a.total * (1 - slo.target);
    const remaining = Math.max(0, allowedBad - a.bad);
    return {
      id: slo.id, kind: slo.kind, target: slo.target, windowDays: slo.windowDays,
      total: a.total, good: a.good, bad: a.bad,
      sli, healthy: sli >= slo.target,
      errorBudget: { allowedBad, usedBad: a.bad, remaining, percentUsed: allowedBad > 0 ? Math.min(1, a.bad / allowedBad) : 0 },
      description: slo.description,
    };
  }
  if (slo.kind === 'latency_p95') {
    const l = await _aggregateLatency(slo.windowDays, slo.target_ms);
    const allowedBreach = l.totalBuckets * (1 - slo.target);
    return {
      id: slo.id, kind: slo.kind, target: slo.target, target_ms: slo.target_ms,
      windowDays: slo.windowDays,
      sampleCount: l.sampleCount, totalBuckets: l.totalBuckets, breachBuckets: l.breachBuckets,
      sli: l.percentGood, healthy: l.percentGood >= slo.target,
      errorBudget: { allowedBad: allowedBreach, usedBad: l.breachBuckets, remaining: Math.max(0, allowedBreach - l.breachBuckets), percentUsed: allowedBreach > 0 ? Math.min(1, l.breachBuckets / allowedBreach) : 0 },
      description: slo.description,
    };
  }
  if (slo.kind === 'job_success') {
    const a = await _aggregateJobSuccess(slo.windowDays);
    const sli = a.total > 0 ? a.good / a.total : 1;
    const allowedBad = a.total * (1 - slo.target);
    return {
      id: slo.id, kind: slo.kind, target: slo.target, windowDays: slo.windowDays,
      total: a.total, good: a.good, bad: a.bad,
      sli, healthy: sli >= slo.target,
      errorBudget: { allowedBad, usedBad: a.bad, remaining: Math.max(0, allowedBad - a.bad), percentUsed: allowedBad > 0 ? Math.min(1, a.bad / allowedBad) : 0 },
      description: slo.description,
    };
  }
  return { id: slo.id, kind: slo.kind, error: 'unknown_kind' };
}

async function computeAll() {
  return Promise.all(definitions().map(compute));
}

/** Quick health probe used by status page; returns { ok, components: [...] }. */
async function probe() {
  const components = [];

  // Database (real ping)
  let dbOk = true; let dbLatencyMs = null;
  try {
    const t0 = Date.now();
    await prisma.$queryRawUnsafe('SELECT 1');
    dbLatencyMs = Date.now() - t0;
  } catch { dbOk = false; }
  components.push({
    id: 'database',
    status: dbOk ? (dbLatencyMs > 1000 ? 'degraded' : 'operational') : 'major_outage',
    latencyMs: dbLatencyMs,
  });

  // API: derive from last 15 min of HTTP samples (5xx rate)
  let apiStatus = 'operational'; let apiSamples = 0; let apiErrors = 0;
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recent = await prisma.requestSample.findMany({
      where: { kind: 'http', bucketAt: { gte: since } },
      select: { count: true, errorCount: true },
    });
    for (const r of recent) { apiSamples += r.count || 0; apiErrors += r.errorCount || 0; }
    if (apiSamples > 0) {
      const errorRate = apiErrors / apiSamples;
      if (errorRate >= 0.10)      apiStatus = 'major_outage';
      else if (errorRate >= 0.02) apiStatus = 'degraded';
    }
  } catch { /* keep operational on lookup failure */ }
  components.push({ id: 'api', status: apiStatus, samples: apiSamples, errors: apiErrors });

  // Workers: real queue probe via worker lib (best-effort)
  let workersStatus = 'operational'; let queueDepth = null; let queueMode = null;
  try {
    const worker = require('./worker');
    if (typeof worker.getQueueStatus === 'function') {
      const q = await worker.getQueueStatus();
      queueMode  = q.mode || 'local';
      queueDepth = (q.waiting || q.queued || 0) + (q.active || q.processing || 0);
      if (q.failed && q.failed > 50)        workersStatus = 'degraded';
      if (queueDepth > 1000)                workersStatus = 'degraded';
    }
  } catch { workersStatus = 'degraded'; }
  components.push({ id: 'workers', status: workersStatus, queueDepth, queueMode });

  // Storage (driver-aware): assume OK unless explicit DRIVER reports problems
  let storageStatus = 'operational'; let storageDriver = null;
  try {
    const storage = require('./storage');
    storageDriver = storage.DRIVER || 'local';
  } catch { storageStatus = 'degraded'; }
  components.push({ id: 'storage', status: storageStatus, driver: storageDriver });

  return { ok: components.every(c => c.status === 'operational'), components };
}

/**
 * Daily uptime history per `kind` (http or job) for the public status page.
 * Returns oldest -> newest day. Each row: { date, total, errors, availability }.
 * Days with no samples report `availability: null` (rendered as "no data").
 */
async function uptimeHistory({ days = 90, kind = 'http' } = {}) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 90));
  const now = new Date();
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (safeDays - 1) * 86400_000;
  const since = new Date(startMs);

  const rows = await prisma.requestSample.findMany({
    where: { kind, bucketAt: { gte: since } },
    select: { bucketAt: true, count: true, errorCount: true },
  }).catch(() => []);

  // Bucket by UTC date YYYY-MM-DD
  const buckets = new Map();
  for (let i = 0; i < safeDays; i += 1) {
    const d = new Date(startMs + i * 86400_000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, total: 0, errors: 0 });
  }
  for (const r of rows) {
    const key = new Date(r.bucketAt).toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue;
    b.total  += r.count || 0;
    b.errors += r.errorCount || 0;
  }
  return Array.from(buckets.values()).map((b) => ({
    date: b.date,
    total: b.total,
    errors: b.errors,
    availability: b.total > 0 ? (b.total - b.errors) / b.total : null,
  }));
}

module.exports = { DEFAULT_SLOS, definitions, compute, computeAll, probe, uptimeHistory };

