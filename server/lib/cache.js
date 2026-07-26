/**
 * ScopeCash AI — Cache layer
 *
 * - REDIS_URL set: Redis-backed cache (shared across instances)
 * - else        : in-process LRU-ish Map with TTL (single-process only)
 *
 * Use sparingly for hot, idempotent reads. Always supply a stable key prefix
 * that includes the tenant/user id to avoid cross-tenant leakage.
 */

const REDIS_URL = process.env.REDIS_URL || '';
const DEFAULT_TTL = parseInt(process.env.CACHE_DEFAULT_TTL || '60', 10); // seconds

let redis = null;
function getRedis() {
  if (!REDIS_URL) return null;
  if (redis) return redis;
  try {
    const IORedis = require('ioredis');
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
    redis.on('error', (e) => console.warn('[cache] redis error:', e.message));
  } catch (err) {
    console.warn('[cache] ioredis unavailable:', err.message);
    redis = null;
  }
  return redis;
}

// In-memory fallback
const MAX_MEM_ENTRIES = 1000;
const mem = new Map(); // key -> { value, expiresAt }

function memSet(key, value, ttl) {
  if (mem.size >= MAX_MEM_ENTRIES) {
    const firstKey = mem.keys().next().value;
    if (firstKey !== undefined) mem.delete(firstKey);
  }
  mem.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}
function memGet(key) {
  const entry = mem.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { mem.delete(key); return null; }
  return entry.value;
}

async function get(key) {
  const r = getRedis();
  if (r) {
    try {
      const v = await r.get(key);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  }
  return memGet(key);
}

async function set(key, value, ttl = DEFAULT_TTL) {
  const r = getRedis();
  if (r) {
    try { await r.set(key, JSON.stringify(value), 'EX', ttl); return; }
    catch { /* fall through */ }
  }
  memSet(key, value, ttl);
}

async function del(key) {
  const r = getRedis();
  if (r) { try { await r.del(key); } catch {} }
  mem.delete(key);
}

async function delPrefix(prefix) {
  const r = getRedis();
  if (r) {
    try {
      const stream = r.scanStream({ match: `${prefix}*`, count: 200 });
      const pipeline = r.pipeline();
      stream.on('data', (keys) => { for (const k of keys) pipeline.del(k); });
      await new Promise((resolve, reject) => {
        stream.on('end', resolve); stream.on('error', reject);
      });
      await pipeline.exec();
      return;
    } catch {}
  }
  for (const k of [...mem.keys()]) { if (k.startsWith(prefix)) mem.delete(k); }
}

async function getOrSet(key, ttl, loader) {
  const cached = await get(key);
  if (cached !== null && cached !== undefined) return cached;
  const fresh = await loader();
  if (fresh !== null && fresh !== undefined) await set(key, fresh, ttl);
  return fresh;
}

module.exports = { get, set, del, delPrefix, getOrSet };

