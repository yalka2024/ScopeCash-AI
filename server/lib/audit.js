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
const { runWithSystemAccess } = require('./tenant-context');

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

// The chain is ONE sequence spanning every org (Activity has no per-org
// sub-chain), so both the read and the write below always run under
// system access regardless of the caller's ambient context. Most callers
// (e.g. everything in routes/auth.js, which never mounts attachTenant) have
// NO tenant context at all when audit() runs; without this, RLS's
// fail-closed USING/WITH CHECK policy would make _getLatestHash() see zero
// rows (silently rebasing the chain to GENESIS on every call) and would
// reject the INSERT outright for any payload whose orgId doesn't literally
// equal whatever GUC happens to be ambient — which for a null orgId (e.g.
// a failed login before a user is resolved) can never be satisfied even
// WITH context. audit() already decides the payload's own orgId before
// this point, so granting system access here only lets the write proceed;
// it never changes what gets stored.
//
// Must go through prisma.tenantTransaction(), NOT a bare
// runWithSystemAccess(() => prisma.activity.xxx(...)) — verified the hard
// way against a real non-superuser Postgres+RLS role: prisma.activity.create()
// returns a lazy PrismaPromise that doesn't actually dispatch (and doesn't
// invoke withRls's $allOperations, which is what reads the ALS store) until
// something awaits it, which happens on the OUTER `await runWithSystemAccess(...)`
// expression — by then storage.run()'s synchronous callback has already
// returned and popped the system-access context, so $allOperations sees no
// context at all and Postgres rejects the insert with a real RLS violation
// (42501). tenantTransaction() sidesteps this because it's a hand-written
// async function whose isSystemAccess()/currentOrgId() reads happen
// synchronously, before its own first await, capturing the decision into a
// plain closure variable that no longer depends on ALS timing — the same
// reason routes/auth.js's registration flow already relies on it.
async function _getLatestHash() {
  const row = await runWithSystemAccess(() => prisma.tenantTransaction((tx) => tx.activity.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  })));
  return (row && row.hash) || GENESIS;
}

async function _writeChained(payload) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const prevHash = await _getLatestHash();
    const hash     = computeHash(prevHash, payload);
    try {
      return await runWithSystemAccess(() => prisma.tenantTransaction((tx) => tx.activity.create({ data: { ...payload, prevHash, hash } })));
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
    // Same reasoning as _getLatestHash above (including the tenantTransaction
    // requirement — a bare runWithSystemAccess(() => prisma.activity.findMany())
    // would silently see zero rows on real Postgres+RLS): this must see the
    // WHOLE table, not whatever slice the caller's ambient org context (if
    // any) would otherwise restrict it to.
    const rows = await runWithSystemAccess(() => prisma.tenantTransaction((tx) => tx.activity.findMany({
      take: batchSize,
      orderBy: { createdAt: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })));
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

