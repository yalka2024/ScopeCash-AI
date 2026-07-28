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
const apiCalls = require('../lib/api-call-meter');

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

/**
 * Paths exempt from the api_calls_per_month quota and the suspended-writes
 * block. Locking a customer out of billing/auth when they hit a limit or
 * fall behind on payment would strand them on the exact pages they need to
 * fix it — the quota would enforce itself into being unfixable. Health is
 * exempt so orchestrators keep working regardless of tenant state.
 */
const QUOTA_EXEMPT_PREFIXES = ['/api/billing', '/api/auth', '/api/health', '/api/me'];

function isQuotaExempt(req) {
  // Compare on path segments, not a raw startsWith: a bare prefix test would
  // make '/api/me' also exempt a future '/api/metrics' or '/api/members',
  // silently widening the exemption as routes are added. Query string is
  // stripped first so '/api/billing?x=1' still matches.
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return QUOTA_EXEMPT_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

async function attachTenantRest(req, res, next, orgId, planId) {
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

  if (!isQuotaExempt(req)) {
    // Suspended subscriptions lose writes but keep reads, so a customer can
    // still export their data after non-payment. middleware/entitlements.js
    // has exported blockIfSuspended() for this since it was written, but it
    // was never mounted on any router — enforcing it here covers every
    // authenticated route at once instead of needing 18 separate mounts.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const sub = await ent.getActiveSubscription(req.user.orgId).catch(() => null);
      if (sub && sub.status === 'suspended') {
        const message = 'Your subscription is suspended for non-payment. Reads are still allowed; please update billing to restore writes.';
        return res.status(402).json({
          error: message, code: 'subscription_suspended', message,
          upgrade_url: '/settings/billing', requestId: req.requestId,
        });
      }
    }

    // api_calls_per_month is an advertised per-tier limit that had no
    // enforcement anywhere. Counted here because this is where the plan is
    // already resolved.
    //
    // COVERAGE: attachTenant cannot be mounted globally (it requires
    // req.user, and auth is applied per-router), so coverage is maintained by
    // mounting it on every router that authenticates users. A verification
    // pass found eight that authenticated but skipped it — analytics,
    // api-keys, competition, data-products, governance, notifications,
    // operations, tools — leaving them uncounted and unbillable; all now
    // mount it. tests/unit/tenant-coverage.test.js fails if a new
    // user-authenticating router is added without it, since the failure mode
    // is silent: the route works perfectly and simply never counts.
    //
    // Deliberately still uncovered: /api/auth and /api/health (pre-auth or
    // machine-facing), /api/me (DSAR export, quota-exempt so non-payment
    // can't block a data-subject request), /api/jobs (Cloud Tasks push
    // target — machine-to-machine, not a customer API call), and
    // /api/billing (exempt so a limit can't lock a customer out of the page
    // where they'd fix it).
    const quota = await apiCalls.checkAndRecord(orgId, req.tenant.plan);
    if (quota.limit !== -1) {
      res.setHeader('x-quota-meter', 'api_calls_per_month');
      res.setHeader('x-quota-used', String(quota.used));
      res.setHeader('x-quota-limit', String(quota.limit));
      res.setHeader('x-quota-remaining', String(quota.remaining));
    }
    if (!quota.allowed) {
      const message = `Monthly API call limit reached (${quota.used}/${quota.limit}).`;
      return res.status(402).json({
        error: message, code: 'usage_limit_exceeded', message,
        meter: 'api_calls_per_month', used: quota.used, limit: quota.limit,
        remaining: quota.remaining, upgrade_url: '/settings/billing', requestId: req.requestId,
      });
    }
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

