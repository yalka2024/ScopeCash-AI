/**
 * Tenant context + per-tenant rate limiting (Tier 12).
 *
 * `attachTenant` MUST run after `authMiddleware`. It:
 *   1. Resolves the org's plan + lane and attaches `req.tenant`.
 *   2. Enforces a plan-aware per-tenant request budget (token bucket).
 *
 * The per-tenant bucket is in-process (Map). For multi-instance deployments
 * a Redis backend should be wired up; the in-process limiter still gives
 * correct fairness within a single node.
 */
const ent = require('../lib/entitlements');
const { laneForPlan, rateBudgetForPlan } = require('../lib/lanes');
const { runWithOrg } = require('../lib/tenant-context');
const prisma = require('../lib/prisma');

const BUCKETS = new Map();   // key: orgId -> { tokens, lastRefillMs, capacity }
const WINDOW_MS = 60_000;

function takeToken(orgId, planId) {
  const capacity = rateBudgetForPlan(planId);
  const now = Date.now();
  let b = BUCKETS.get(orgId);
  if (!b || b.capacity !== capacity) {
    b = { tokens: capacity, lastRefillMs: now, capacity };
    BUCKETS.set(orgId, b);
  } else {
    const elapsed = now - b.lastRefillMs;
    if (elapsed > 0) {
      const refill = (elapsed / WINDOW_MS) * capacity;
      b.tokens = Math.min(capacity, b.tokens + refill);
      b.lastRefillMs = now;
    }
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, remaining: Math.floor(b.tokens), capacity };
  }
  const retryAfterMs = Math.ceil(((1 - b.tokens) / capacity) * WINDOW_MS);
  return { allowed: false, remaining: 0, capacity, retryAfterMs };
}

async function attachTenant(req, res, next) {
  if (!req.user) {
    // attachTenant must run after authMiddleware. If it didn't, fail closed.
    return res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
  }
  const orgId = req.user.orgId || req.user.id;

  // Every Prisma call below must run WITH the tenant context already active —
  // on Postgres, RLS (prisma/rls.sql) is fail-closed, so a query issued before
  // runWithOrg() wraps this function sees zero rows regardless of its own
  // `where` clause (previously true here: the OrgMembership lookup ran before
  // runWithOrg was ever called, so every non-admin request silently resolved
  // to req.orgRole = 'viewer' on Postgres, no matter the caller's real role).
  return runWithOrg(orgId, async () => {
    let planId = 'free';
    let plan = null;
    try {
      const sub = await ent.getActiveSubscription(req.user.orgId);
      planId = (sub.tier && sub.tier.id) || 'free';
      plan = sub.tier;
    } catch {
      // Treat resolution failures as free tier (fail-open for app routing,
      // fail-closed for paid features handled separately by entitlements).
    }
    const lane = laneForPlan(planId);
    req.tenant = {
      orgId,
      planId,
      plan,
      lane: lane.label,
      laneSpec: lane,
    };
    res.setHeader('x-tenant-lane', lane.label);

    // Per-org domain role (OrgMembership), distinct from the platform-level
    // User.role field used by requireRole()/isWriteRole() for the `admin`
    // super-user bypass. A user with no membership row (pre-migration account,
    // or an org they were removed from) resolves to 'viewer' — fail closed,
    // not fail open.
    if (req.user.role === 'admin') {
      req.orgRole = 'admin';
    } else if (req.user.orgId) {
      const membership = await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: req.user.orgId, userId: req.user.id } },
      }).catch(() => null);
      req.orgRole = (membership && membership.status === 'active') ? membership.role : 'viewer';
    } else {
      req.orgRole = 'viewer';
    }

    return attachTenantRest(req, res, next, orgId, planId);
  });
}

function attachTenantRest(req, res, next, orgId, planId) {
  // Per-tenant rate budget
  const rl = takeToken(orgId, planId);
  res.setHeader('x-tenant-rate-remaining', String(rl.remaining));
  res.setHeader('x-tenant-rate-capacity', String(rl.capacity));
  if (!rl.allowed) {
    res.setHeader('retry-after', String(Math.ceil(rl.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'Tenant rate limit exceeded',
      code: 'tenant_rate_limit',
      planId,
      retryAfterSeconds: Math.ceil(rl.retryAfterMs / 1000),
    });
  }
  // Already running inside the runWithOrg scope established by attachTenant
  // above — just continue the middleware chain.
  return next();
}

// Test/diagnostic helpers
function _resetBuckets() { BUCKETS.clear(); }
function _bucketSnapshot(orgId) { return BUCKETS.get(orgId) || null; }

module.exports = attachTenant;
module.exports.attachTenant = attachTenant;
module.exports._resetBuckets = _resetBuckets;
module.exports._bucketSnapshot = _bucketSnapshot;

