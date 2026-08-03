/**
 * Boot-time assertion that Row-Level Security is actually in place.
 *
 * RLS (prisma/rls.sql) is documented throughout this codebase as the hard
 * database-level backstop under the app's own `where: { orgId }` scoping —
 * the thing that means a route which forgets to filter still cannot leak
 * another tenant's rows. But nothing ever checked that the policies exist.
 *
 * That gap is not theoretical: `docker-compose.yml` starts the server with
 * `prisma migrate deploy && node index.js`, which creates the tables and
 * never applies rls.sql. A deployment on that path runs with the backstop
 * silently absent, looking identical to one where it is present — right up
 * until the first cross-tenant read.
 *
 * Fails CLOSED in production. Serving multi-tenant data while believing in a
 * protection that is not there is worse than refusing to start, because the
 * failure is invisible and the damage is other people's data.
 *
 * SQLite has no RLS at all, so this is a no-op there by design — that is the
 * documented local-development posture, not a gap.
 */
const prisma = require('./prisma');

const POLICY_NAME = 'tenant_isolation';

function isPostgres() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres'));
}

/**
 * Count tables carrying the tenant_isolation policy.
 * Returns { applicable, policyCount, error }.
 */
async function checkRlsPolicies() {
  if (!isPostgres()) return { applicable: false, policyCount: null };
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM pg_policies WHERE policyname = '${POLICY_NAME}'`
    );
    const policyCount = Number((rows && rows[0] && rows[0].count) || 0);
    return { applicable: true, policyCount };
  } catch (err) {
    // Cannot read pg_policies — treat as unknown rather than as "absent", so
    // a permissions quirk on the metadata view doesn't take a healthy
    // deployment down. Reported so it is still visible.
    return { applicable: true, policyCount: null, error: err.message };
  }
}

/**
 * Assert RLS at boot. Throws in production when policies are provably absent
 * (a real zero, not an unreadable check); warns loudly otherwise so local and
 * test runs are unaffected.
 */
async function assertRlsAtBoot({ isProduction = process.env.NODE_ENV === 'production' } = {}) {
  const result = await checkRlsPolicies();
  if (!result.applicable) return result;

  if (result.policyCount === null) {
    console.warn(JSON.stringify({
      severity: 'WARNING', type: 'rls_check_unavailable',
      note: 'Could not read pg_policies; RLS status unknown', error: result.error,
    }));
    return result;
  }

  if (result.policyCount > 0) {
    console.log(JSON.stringify({
      severity: 'INFO', type: 'rls_verified', policies: result.policyCount,
    }));
    return result;
  }

  const message = 'Row-Level Security policies are ABSENT on this Postgres database. '
    + 'Tenant isolation is documented as relying on them as a hard backstop. '
    + 'Run `npm run db:postgres:rls` (or deploy via `npm run db:postgres:deploy`, which chains it). '
    + 'Note that `prisma migrate deploy` alone does NOT apply rls.sql.';

  if (isProduction) {
    const err = new Error(message);
    err.code = 'rls_policies_missing';
    throw err;
  }
  console.warn(JSON.stringify({ severity: 'WARNING', type: 'rls_policies_missing', message }));
  return result;
}

module.exports = { checkRlsPolicies, assertRlsAtBoot, POLICY_NAME };
