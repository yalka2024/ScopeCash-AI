/**
 * Append-only audit log helper with tamper-evident hash chain (OBS-005).
 *
 * Implements a hashChain (a.k.a. previousHash / hash_chain) over the
 * Activity table. Every row stores:
 *   prevHash — SHA-256 of the previous row's `hash` (or 64 zeros for genesis)
 *   hash     — SHA-256 over a canonical JSON of the row's payload + prevHash
 *
 * A verifier (see `verifyChain` below) walks rows in insertion order and
 * recomputes every hash. Any mutation, deletion, or re-ordering breaks the
 * chain at the first affected row.
 *
 * Concurrency: writes within a single node process are serialised through a
 * promise mutex. Across processes we rely on a unique constraint on the
 * `prevHash` column — racing writers will see a unique violation and retry,
 * preserving the chain. See server/prisma/schema.prisma `model Activity`.
 *
 * Use:  await audit(req, 'auth.login.success', { resource: 'user', resourceId: user.id });
 */
const crypto = require('crypto');
const prisma = require('./prisma');

const GENESIS = '0'.repeat(64);
const MAX_RETRIES = 3;

let chainTail = Promise.resolve(); // in-process serialisation of audit writes

function canonical(payload) {
  // Deterministic JSON: sort keys at every level so identical payloads
  // always hash to the same value.
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload);
  if (Array.isArray(payload)) return '[' + payload.map(canonical).join(',') + ']';
  const keys = Object.keys(payload).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(payload[k])).join(',') + '}';
}

function computeHash(prevHash, row) {
  const h = crypto.createHash('sha256');
  h.update(prevHash);
  h.update('|');
  h.update(canonical(row));
  return h.digest('hex');
}

async function _getLatestHash() {
  const row = await prisma.activity.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });
  return (row && row.hash) || GENESIS;
}

async function _writeChained(payload) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const prevHash = await _getLatestHash();
    const hash     = computeHash(prevHash, payload);
    try {
      return await prisma.activity.create({ data: { ...payload, prevHash, hash } });
    } catch (err) {
      lastErr = err;
      // P2002 = Prisma unique constraint violation. Retry with fresh tail.
      if (err && (err.code === 'P2002' || /unique/i.test(err.message || ''))) continue;
      throw err;
    }
  }
  throw lastErr;
}

async function audit(req, action, opts = {}) {
  const payload = {
    userId:     opts.userId   ?? req?.user?.id   ?? null,
    orgId:      opts.orgId    ?? req?.user?.orgId ?? null,
    action,
    resource:   opts.resource ?? null,
    resourceId: opts.resourceId ?? null,
    details:    opts.details ? JSON.stringify(opts.details) : null,
    ipAddress:  req?.ip ?? null,
    userAgent:  req?.headers?.['user-agent'] ?? null,
    outcome:    opts.outcome ?? 'success',
  };

  const job = chainTail.then(() => _writeChained(payload).catch((err) => {
    console.error(JSON.stringify({ type: 'audit_failed', action, err: err.message }));
  }));
  chainTail = job.catch(() => {});
  return job;
}

/**
 * Walk the chain in insertion order and recompute hashes. Rows written
 * before the chain feature existed (legacy rows with `hash IS NULL`) are
 * skipped — verification starts at the first row that carries a hash.
 *
 * Returns: { ok, total, skippedLegacy, broken, firstBrokenId?, firstBrokenAt? }
 */
async function verifyChain({ batchSize = 1000 } = {}) {
  let prevHash = GENESIS;
  let total    = 0;
  let skippedLegacy = 0;
  let started  = false;
  let cursor   = null;

  while (true) {
    const rows = await prisma.activity.findMany({
      take: batchSize,
      orderBy: { createdAt: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    for (const row of rows) {
      const { id, hash, prevHash: storedPrev, createdAt, ...payload } = row;
      if (hash === null || hash === undefined) {
        if (!started) { skippedLegacy++; continue; }
        // A legacy null-hash row appearing AFTER chained rows is a tamper signal.
        return { ok: false, total, skippedLegacy, broken: true, firstBrokenId: id, firstBrokenAt: createdAt };
      }
      started = true;
      const expected = computeHash(prevHash, payload);
      if (storedPrev !== prevHash || hash !== expected) {
        return { ok: false, total, skippedLegacy, broken: true, firstBrokenId: id, firstBrokenAt: createdAt };
      }
      prevHash = hash;
      total++;
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }
  return { ok: true, total, skippedLegacy, broken: false };
}

module.exports = { audit, verifyChain, computeHash, canonical, GENESIS };

