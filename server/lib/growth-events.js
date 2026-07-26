/**
 * Growth events pipeline (Tier 14).
 *
 * Append-only event log used for funnel + activation analytics, lifecycle
 * triggers, and feature-flag exposure tracking. Designed to:
 *   - Never block the request path (errors swallowed, logged once).
 *   - Be cheap to write (single insert + optional async fan-out).
 *   - Be easy to query (canonical event names + flat properties JSON).
 *
 * Canonical event names: `<noun>.<verb>` lowercase, e.g. `signup.completed`.
 */
const prisma = require('./prisma');

// Small in-process queue so high-traffic routes don't await DB inserts.
const QUEUE = [];
let flushing = false;
const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH = 100;

function _scheduleFlush() {
  if (flushing) return;
  flushing = true;
  setTimeout(flush, FLUSH_INTERVAL_MS).unref?.();
}

async function flush() {
  flushing = false;
  if (!QUEUE.length) return;
  const batch = QUEUE.splice(0, MAX_BATCH);
  try {
    await prisma.growthEvent.createMany({ data: batch });
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(JSON.stringify({ type: 'growth_event_flush_error', count: batch.length, error: err.message }));
    }
  }
  if (QUEUE.length) _scheduleFlush();
}

/**
 * Record a growth event. Returns immediately; persistence is batched.
 * @param {object} ev
 * @param {string} ev.name      canonical event name (e.g. 'signup.completed')
 * @param {string} [ev.userId]  acting user id
 * @param {string} [ev.orgId]   tenant org id
 * @param {object} [ev.properties] flat key/value properties
 * @param {string} [ev.source]  'server' | 'client' | 'system' | 'webhook'
 */
function track(ev) {
  if (!ev || typeof ev.name !== 'string' || !ev.name) return { ok: false, reason: 'invalid_name' };
  const props = ev.properties && typeof ev.properties === 'object' ? ev.properties : null;
  QUEUE.push({
    name: ev.name.toLowerCase().slice(0, 80),
    userId: ev.userId || null,
    orgId: ev.orgId || null,
    source: (ev.source || 'server').slice(0, 16),
    properties: props ? JSON.stringify(props).slice(0, 4000) : null,
  });
  _scheduleFlush();
  return { ok: true };
}

/** Synchronously flush in-memory queue. Call from graceful shutdown / tests. */
async function drain() { await flush(); while (QUEUE.length) await flush(); }

/**
 * Funnel step counts for a list of event names within a window. Returns rows
 * keyed by event name: { name, unique_users, total }. Useful for activation
 * funnel charts.
 */
async function funnel(stepNames, { sinceMs = 7 * 24 * 3600 * 1000, orgId = null } = {}) {
  const since = new Date(Date.now() - sinceMs);
  const where = { createdAt: { gte: since }, name: { in: stepNames } };
  if (orgId) where.orgId = orgId;
  const rows = await prisma.growthEvent.findMany({
    where, select: { name: true, userId: true },
  }).catch(() => []);
  const out = stepNames.map(n => ({ name: n, total: 0, unique_users: 0 }));
  const seen = new Map();
  for (const r of rows) {
    const slot = out.find(x => x.name === r.name);
    if (!slot) continue;
    slot.total += 1;
    const k = `${r.name}::${r.userId || 'anon'}`;
    if (!seen.has(k)) { seen.set(k, true); slot.unique_users += 1; }
  }
  return out;
}

/** Recent events by user for debugging + lifecycle decisions. */
async function recentForUser(userId, limit = 50) {
  return prisma.growthEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit, 10) || 50, 200),
  }).catch(() => []);
}

module.exports = { track, flush, drain, funnel, recentForUser };

