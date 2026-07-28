/**
 * Invariant: every router that authenticates real users must also mount
 * attachTenant.
 *
 * attachTenant is where api_calls_per_month is counted and where runWithOrg
 * (Postgres RLS context) is established. A router that authenticates but
 * skips it keeps working perfectly — the routes respond, nothing errors — it
 * simply never counts against the quota and runs its queries with no tenant
 * context. That silence is why this needs a test rather than review
 * discipline: eight routers had drifted out of coverage before anyone
 * noticed, and nothing would have surfaced it.
 *
 * Reads the route sources directly rather than introspecting Express, because
 * the property under test is "this file mounts the middleware", which is
 * exactly what the source says and what a future edit would change.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', '..', 'routes');

/**
 * Routers that authenticate but deliberately do NOT count against the API
 * quota. Each needs a reason — this list is the exemption, so an entry added
 * without justification is the thing to catch in review.
 */
const EXEMPT = {
  'auth.js': 'login/register/verify — pre-authentication, and quota-exempt so a limit cannot lock someone out of signing in',
  'oauth.js': 'OAuth authorization flows — same pre-auth rationale as auth.js',
  'jobs.js': 'Cloud Tasks push target — machine-to-machine delivery, not a customer API call',
  'dsar.js': 'mounted at /api/me; GDPR data-subject requests must not be blocked by billing state',
  'billing.js': 'mounts attachTenant itself but is quota-exempt by path, so a limit cannot block the page where a customer would fix it',
  'stripe-webhook.js': 'Stripe-signed webhook, no user session',
  'health.js': 'liveness/readiness for orchestrators',
  'tenants.js': 'platform-admin tenant administration, not tenant-scoped traffic',
};

function readRoute(file) {
  return fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
}

describe('attachTenant coverage', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));

  test('every user-authenticating router mounts attachTenant, or is a documented exemption', () => {
    const missing = [];
    for (const file of files) {
      const src = readRoute(file);
      if (!/authMiddleware/.test(src)) continue;      // not a user-authenticated router
      if (/attachTenant/.test(src)) continue;          // covered
      if (EXEMPT[file]) continue;                      // deliberately not covered
      missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  test('the eight routers found uncovered by the 2026-07-27 verification pass are covered', () => {
    // Named explicitly so a regression points at the specific file, rather
    // than only failing the generic sweep above.
    for (const file of ['analytics.js', 'apikey.js', 'competition.js', 'data-products.js',
      'governance.js', 'notification.js', 'operations.js', 'tools.js']) {
      expect(readRoute(file)).toMatch(/router\.use\(attachTenant\)/);
    }
  });

  test('attachTenant is mounted AFTER authMiddleware, since it fails closed without req.user', () => {
    for (const file of files) {
      const src = readRoute(file);
      if (!/router\.use\(attachTenant\)/.test(src) || !/router\.use\(authMiddleware\)/.test(src)) continue;
      expect(src.indexOf('router.use(authMiddleware)')).toBeLessThan(src.indexOf('router.use(attachTenant)'));
    }
  });

  test('every exemption names a real route file, so the list cannot rot silently', () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(files).toContain(file);
      expect(EXEMPT[file].length).toBeGreaterThan(20);   // a reason, not a placeholder
    }
  });
});
