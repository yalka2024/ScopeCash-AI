/**
 * Durable run store for agent / workflow / goal runs.
 *
 * Persists run records to the AgentRun table so state survives restarts, with
 * an in-memory cache for fast reads within a process. All Prisma access is
 * best-effort: if the DB is unavailable the store degrades to in-memory, so the
 * runtimes never crash on a persistence hiccup. Generated for ScopeCash AI.
 */
const prisma = require('./prisma');

const _cache = new Map(); // id -> run object

// The `steps` column holds a full JSON snapshot of the run so any run shape
// (agent / workflow / goal) round-trips faithfully; the other columns are
// denormalized copies for indexing, listing, and querying.
function _serialize(run) {
  return {
    id: run.id,
    orgId: run.orgId || null,
    userId: run.userId || null,
    kind: run.kind,
    name: String(run.name || '').slice(0, 200),
    status: run.status || 'running',
    input: run.input != null ? String(run.input).slice(0, 8000) : null,
    output: run.output != null ? String(run.output).slice(0, 16000) : null,
    steps: JSON.stringify(run).slice(0, 200000),
    error: run.error || null,
  };
}

/** Upsert a run (cache + DB). Returns the run. */
async function save(run) {
  _cache.set(run.id, run);
  try {
    const data = _serialize(run);
    await prisma.agentRun.upsert({
      where: { id: run.id },
      update: { status: data.status, output: data.output, steps: data.steps, error: data.error },
      create: data,
    });
  } catch { /* degrade to in-memory */ }
  return run;
}

/** Read a run by id (cache first, then DB). */
async function get(id) {
  if (_cache.has(id)) return _cache.get(id);
  try {
    const row = await prisma.agentRun.findUnique({ where: { id } });
    if (!row) return null;
    const run = _inflate(row);
    _cache.set(id, run);
    return run;
  } catch { return null; }
}

/** List recent runs of a kind, optionally scoped to an org. */
async function list({ kind, orgId, take = 50 } = {}) {
  try {
    const rows = await prisma.agentRun.findMany({
      where: { ...(kind ? { kind } : {}), ...(orgId ? { orgId } : {}) },
      orderBy: { createdAt: 'desc' }, take,
    });
    return rows.map(_inflate);
  } catch {
    return Array.from(_cache.values())
      .filter(r => (!kind || r.kind === kind) && (!orgId || r.orgId === orgId))
      .slice(0, take);
  }
}

function _inflate(row) {
  // Prefer the full snapshot; fall back to the denormalized columns.
  try {
    const snap = JSON.parse(row.steps);
    if (snap && typeof snap === 'object') return snap;
  } catch { /* fall through */ }
  return {
    id: row.id, orgId: row.orgId, userId: row.userId, kind: row.kind, name: row.name,
    status: row.status, input: row.input, output: row.output, steps: [], error: row.error,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

// ── Cooperative cancellation ────────────────────────────────────────────
// A run is flagged here; the runtimes check isCancelled() between steps and
// stop gracefully. Process-local (matches the in-process executor); for the
// BullMQ path the flag is checked by whichever worker holds the run.
const _cancelled = new Set();
function requestCancel(id) { _cancelled.add(id); return true; }
function isCancelled(id) { return _cancelled.has(id); }
function clearCancel(id) { _cancelled.delete(id); }

module.exports = { save, get, list, requestCancel, isCancelled, clearCancel };

