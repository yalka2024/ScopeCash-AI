/**
 * Rate limiting — Redis-backed when REDIS_URL is set, else in-process LRU.
 * Per-route + per-identity (user id when authed, IP otherwise).
 */
const rateLimit = require('express-rate-limit');

let store = undefined;
if (process.env.REDIS_URL) {
  try {
    const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
    const IORedis = require('ioredis');
    const client = new IORedis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    store = new RedisStore({ sendCommand: (...args) => client.call(...args), prefix: 'rl:' });
    console.log('rate-limit: using Redis store');
  } catch (err) {
    console.warn('rate-limit: REDIS_URL set but redis store unavailable, falling back to memory:', err.message);
  }
}

function keyByIdentity(req) {
  return (req.user && req.user.id) ? `u:${req.user.id}` : `ip:${req.ip}`;
}

function makeLimiter({ windowMs, max, name }) {
  return rateLimit({
    windowMs, max, store,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `${name}:${keyByIdentity(req)}`,
    message: { error: 'Too many requests' },
  });
}

module.exports = {
  global:  makeLimiter({ windowMs: 60_000,    max: 600, name: 'global' }),
  auth:    makeLimiter({ windowMs: 15 * 60_000, max: 20,  name: 'auth' }),
  upload:  makeLimiter({ windowMs: 60_000,    max: 30,  name: 'upload' }),
  ai:      makeLimiter({ windowMs: 60_000,    max: 20,  name: 'ai' }),
  expensive: makeLimiter({ windowMs: 60_000,  max: 10,  name: 'expensive' }),
  publicBehavior: makeLimiter({ windowMs: 60_000, max: 30, name: 'public-behavior' }),
  makeLimiter,
};

