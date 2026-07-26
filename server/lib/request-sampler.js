/**
 * Request sampler (Tier 17 — Operations).
 *
 * Lightweight Express middleware + worker hook that buckets request and
 * job outcomes into 1-minute RequestSample rows. Enables SLO/SLI math
 * without scanning per-request access logs.
 *
 *   bucketAt   minute-rounded timestamp
 *   kind       'http' | 'job'
 *   count      total events in this bucket
 *   errorCount events with status >= 500 / job outcome != success
 *   p95Ms      approx p95 latency in this bucket (HTTP only)
 *   maxMs      max latency seen in this bucket
 */
const prisma = require('./prisma');

const FLUSH_INTERVAL_MS = 30_000;
const buckets = new Map(); // key -> { kind, bucketAt, count, errorCount, latencies[] }
let flushing = false;

function _bucketKey(kind, bucketAt) { return `${kind}:${bucketAt.toISOString()}`; }

function _bucketTime(d = new Date()) {
  const t = new Date(d); t.setSeconds(0, 0); return t;
}

function _record(kind, isError, ms = null) {
  const at = _bucketTime();
  const key = _bucketKey(kind, at);
  let b = buckets.get(key);
  if (!b) { b = { kind, bucketAt: at, count: 0, errorCount: 0, latencies: [] }; buckets.set(key, b); }
  b.count += 1;
  if (isError) b.errorCount += 1;
  if (typeof ms === 'number' && Number.isFinite(ms)) {
    b.latencies.push(ms);
    if (b.latencies.length > 1000) b.latencies = b.latencies.slice(-1000);
  }
}

function _quantile(arr, q) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const now = _bucketTime();
    const rows = [];
    for (const [key, b] of buckets) {
      // Only flush completed buckets (older than current minute) to avoid double counts.
      if (b.bucketAt.getTime() >= now.getTime()) continue;
      rows.push({
        kind: b.kind,
        bucketAt: b.bucketAt,
        count: b.count,
        errorCount: b.errorCount,
        p95Ms: Math.round(_quantile(b.latencies, 0.95)),
        maxMs: b.latencies.length ? Math.max(...b.latencies) : 0,
      });
      buckets.delete(key);
    }
    if (rows.length) {
      try {
        await prisma.requestSample.createMany({ data: rows });
      } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
          console.error(JSON.stringify({ type: 'request_sampler_flush_error', count: rows.length, error: err.message }));
        }
      }
    }
  } finally {
    flushing = false;
  }
}

let timer = null;
function startScheduler({ intervalMs = FLUSH_INTERVAL_MS } = {}) {
  if (timer) return timer;
  timer = setInterval(() => { flush().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return timer;
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }
async function drain() { await flush(); await flush(); /* second pass for current minute */ }

function httpMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    _record('http', res.statusCode >= 500, ms);
  });
  next();
}

function recordJob(success) { _record('job', !success, null); }

module.exports = { startScheduler, stopScheduler, drain, flush, httpMiddleware, recordJob };

