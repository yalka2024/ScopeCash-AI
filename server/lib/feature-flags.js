/**
 * Feature flags (Tier 14).
 *
 * A small, deterministic feature-flag engine. Flags live in the DB
 * (FeatureFlag model) and have:
 *   - key            unique slug
 *   - enabled        master kill switch
 *   - rolloutPercent 0..100 deterministic-by-userId rollout
 *   - planAllowList  optional comma-separated plan ids
 *   - orgAllowList   optional comma-separated org ids (always-on for these)
 *   - orgDenyList    explicit deny override
 *
 * Evaluation order: deny > allow > plan > rollout > enabled flag default.
 *
 * Exposure events are tracked (sampled at 10%) so we can A/B compare flags.
 */
const crypto = require('crypto');
const prisma = require('./prisma');
const events = require('./growth-events');

const CACHE = new Map(); // key -> { row, ts }
const TTL_MS = 30_000;

function _cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > TTL_MS) { CACHE.delete(key); return null; }
  return v.row;
}
function _cacheSet(key, row) { CACHE.set(key, { row, ts: Date.now() }); }
function invalidate(key) { if (key) CACHE.delete(key); else CACHE.clear(); }

function _bucket(key, userId) {
  const h = crypto.createHash('sha1').update(`${key}::${userId || 'anon'}`).digest();
  // First 4 bytes -> 0..99
  return h.readUInt32BE(0) % 100;
}

function _splitList(s) {
  return (s || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
}

async function getFlag(key) {
  if (!key) return null;
  const cached = _cacheGet(key);
  if (cached !== null) return cached;
  const row = await prisma.featureFlag.findUnique({ where: { key } }).catch(() => null);
  _cacheSet(key, row || null);
  return row;
}

/**
 * Evaluate a flag for the given context. Always returns a boolean.
 * Sample exposure events at 10% to avoid event-table bloat.
 */
async function isEnabled(key, ctx = {}) {
  const flag = await getFlag(key);
  if (!flag) return false;
  if (!flag.enabled) return false;

  const userId = ctx.userId || null;
  const orgId  = ctx.orgId || null;
  const planId = ctx.planId || null;

  // Deny list first (fail-closed).
  if (orgId && _splitList(flag.orgDenyList).includes(orgId)) return _expose(key, false, ctx, 'deny');

  // Always-on org allow list.
  if (orgId && _splitList(flag.orgAllowList).includes(orgId)) return _expose(key, true, ctx, 'org_allow');

  // Plan gate.
  if (flag.planAllowList) {
    const allowed = _splitList(flag.planAllowList);
    if (!planId || !allowed.includes(planId)) return _expose(key, false, ctx, 'plan_gate');
  }

  // Rollout %.
  const pct = Number.isFinite(flag.rolloutPercent) ? Math.max(0, Math.min(100, flag.rolloutPercent)) : 0;
  if (pct >= 100) return _expose(key, true, ctx, 'rollout_full');
  if (pct <= 0) return _expose(key, false, ctx, 'rollout_zero');
  const onByBucket = _bucket(key, userId) < pct;
  return _expose(key, onByBucket, ctx, 'rollout_bucket');
}

function _expose(key, value, ctx, reason) {
  // Sample 10% so admin pages don't drown in events.
  if (Math.random() < 0.1) {
    events.track({
      name: 'flag.exposed',
      userId: ctx.userId || null,
      orgId: ctx.orgId || null,
      properties: { key, value, reason },
      source: 'server',
    });
  }
  return value;
}

async function listFlags() {
  return prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }).catch(() => []);
}

async function upsertFlag(key, patch = {}) {
  if (!key) throw new Error('flag_key_required');
  const data = {
    enabled:        Boolean(patch.enabled),
    rolloutPercent: Math.max(0, Math.min(100, parseInt(patch.rolloutPercent ?? 0, 10) || 0)),
    planAllowList:  patch.planAllowList || null,
    orgAllowList:   patch.orgAllowList || null,
    orgDenyList:    patch.orgDenyList || null,
    description:    patch.description ? String(patch.description).slice(0, 500) : null,
    updatedAt:      new Date(),
  };
  const row = await prisma.featureFlag.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  });
  invalidate(key);
  return row;
}

async function deleteFlag(key) {
  await prisma.featureFlag.delete({ where: { key } }).catch(() => {});
  invalidate(key);
}

module.exports = { getFlag, isEnabled, listFlags, upsertFlag, deleteFlag, invalidate };

