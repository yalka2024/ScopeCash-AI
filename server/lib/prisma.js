const { PrismaClient } = require('@prisma/client');
const { currentOrgId, isSystemAccess } = require('./tenant-context');

const isPg = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres'));

let adapter;
if (isPg) {
  const { PrismaPg } = require('@prisma/adapter-pg');
  adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
} else {
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL || 'file:./dev.db',
  });
}

const base = new PrismaClient({ adapter });

// ── Row-Level Security enforcement (Postgres only) ──────────────────────────
// For every query we set a LOCAL GUC on the SAME connection (one transaction)
// so the RLS policies in prisma/rls.sql restrict every row to the caller's org
// AT THE DATABASE. This is a hard backstop under the app-level
// `where: { orgId }` scoping: even a route that forgets the filter cannot leak
// another tenant's rows. No-op on SQLite (no RLS).
//
// RLS is fail-closed: a query that runs with neither an org in context
// (runWithOrg) nor an explicit system-access grant (runWithSystemAccess) will
// see ZERO rows on every org-scoped table, not every tenant's rows. We still
// let the query through here (rather than throwing) so read paths degrade to
// "empty" instead of a hard 500 — but we log loudly, because an empty result
// from a path that expected data is exactly the kind of silent bug this is
// meant to surface.
//
// NOTE: requires the RLS migration applied (`npm run db:postgres:rls`) AND the
// app DB role to be subject to RLS (the migration uses FORCE ROW LEVEL SECURITY).
//
// Takes the RAW (un-extended) client as `rawClient` and both extends it AND
// opens its transactions against that SAME client — never a different one.
// This matters once more than one raw PrismaClient exists in the process
// (see createPrismaClientWithIamAuth below): each needs its own withRls()
// closing over its OWN client, not a shared module-level one, or the SET
// LOCAL GUC and the actual query would silently run on two different
// connection pools, defeating RLS entirely without any visible error.
function withRls(rawClient) {
  return rawClient.$extends({
    name: 'rls-tenant-isolation',
    query: {
      // NOTE: this must NOT do `rawClient.$transaction([rawClient.$executeRaw\`SET...\`, query(args)])`.
      // `query(args)` is bound to the ORIGINAL (un-extended) operation from this specific
      // call; batching it inside an array alongside a *separately* issued $executeRaw
      // does not reliably put both statements on the same connection/transaction, which
      // silently defeats the whole point (verified against a real non-superuser Postgres
      // role: the array form of the two mixed-origin calls left every row visible, i.e.
      // the SET LOCAL never reached the connection that ran the actual query). Instead we
      // open one interactive transaction and re-issue the SAME model + operation on that
      // transaction's own client (`tx`), so the GUC and the query provably share a connection.
      async $allOperations({ model, operation, args, query }) {
        const orgId = currentOrgId();
        const system = isSystemAccess();
        if (!orgId && !system) {
          console.warn('[prisma] query ran with no tenant context and no system-access grant — RLS (fail-closed) will return zero rows for org-scoped tables. Wrap this code path in runWithOrg() or runWithSystemAccess() from lib/tenant-context.js.');
          return query(args);
        }
        if (!model) {
          // Top-level raw query ($queryRaw/$executeRaw called directly by app code) —
          // not reconstructable via tx[model][operation]. Rare in this codebase (health
          // checks only, already mocked in tests); falls through without RLS context.
          return query(args);
        }
        const modelKey = model[0].toLowerCase() + model.slice(1);
        return rawClient.$transaction(async (tx) => {
          if (system) {
            await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
          } else {
            await tx.$executeRaw`SELECT set_config('app.org_id', ${String(orgId)}, true)`;
          }
          return tx[modelKey][operation](args);
        });
      },
    },
  });
}

// The live client every consumer ultimately talks to. Mutable so Cloud SQL
// IAM auth can replace it during startup — see initCloudSqlIamAuth() below.
let active = isPg ? withRls(base) : base;
// Properties owned by this module rather than forwarded to `active`
// (tenantTransaction, the factory, test seams). Held separately so swapping
// `active` doesn't drop them.
const OVERRIDES = Object.create(null);

/**
 * The module export is a Proxy over `active` rather than `active` itself.
 *
 * Cloud SQL IAM authentication needs an async pool (the connector fetches
 * instance metadata and mints a cert before a Pool can be constructed), but
 * ~20 route modules do `const prisma = require('../lib/prisma')` at module
 * scope and would capture whatever object existed at require() time. The
 * indirection means startup can swap the underlying client after those
 * requires have already happened, and every holder follows automatically —
 * no boot-order restructuring, which is what made this "deliberately
 * deferred" before.
 *
 * The trap only forwards property reads; the per-query cost is a property
 * lookup against a database round trip.
 */
const prisma = new Proxy(Object.create(null), {
  get(_target, prop) {
    if (prop in OVERRIDES) return OVERRIDES[prop];
    const v = active[prop];
    return typeof v === 'function' ? v.bind(active) : v;
  },
  set(_target, prop, value) { OVERRIDES[prop] = value; return true; },
  has(_target, prop) { return prop in OVERRIDES || prop in active; },
});

// Multi-statement atomic transactions under RLS. Plain `prisma.$transaction([opA, opB])`
// (array form) no longer gives cross-op atomicity here: each op independently goes
// through withRls's $allOperations and opens its OWN mini-transaction to scope its own
// SET LOCAL, so opA can commit while opB fails. Use this instead whenever multiple
// writes must succeed or fail together (e.g. updating a running total AND appending its
// ledger row) — it opens exactly one transaction, sets the tenant GUC once, and hands
// you a plain (non-RLS-extended) `tx` to call `tx.model.op()` on directly.
//
// Bound to a specific raw client + whether IT is Postgres, same reasoning as
// withRls above — must never default to a different client's connection.
function makeTenantTransaction(rawClient, rawClientIsPg) {
  return async function tenantTransaction(fn) {
    if (!rawClientIsPg) return rawClient.$transaction(fn);
    const orgId = currentOrgId();
    const system = isSystemAccess();
    if (!orgId && !system) {
      console.warn('[prisma] tenantTransaction ran with no tenant context and no system-access grant — RLS (fail-closed) will return zero rows for org-scoped tables.');
      return rawClient.$transaction(fn);
    }
    return rawClient.$transaction(async (tx) => {
      if (system) await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      else await tx.$executeRaw`SELECT set_config('app.org_id', ${String(orgId)}, true)`;
      return fn(tx);
    });
  };
}
prisma.tenantTransaction = makeTenantTransaction(base, isPg);

/**
 * Builds a SEPARATE PrismaClient authenticated via Cloud SQL automatic IAM
 * DB auth (lib/cloud-sql-connector.js) instead of the static DATABASE_URL
 * password above — no DB password generated, stored, or passed anywhere.
 * Invoked by initCloudSqlIamAuth() below, which index.js and worker.js both
 * await before doing any work. Callers should use that rather than this
 * factory directly — it installs the resulting client as the module's
 * active one, so the ~20 route files that captured the export at require()
 * time follow automatically.
 *
 * (This comment previously said the factory was "deliberately not invoked
 * yet". That stopped being true when the boot wiring landed; it is recorded
 * here because a stale comment asserting a feature is unwired is exactly
 * how a working mechanism gets treated as dead code.)
 *
 * @param {object} opts
 * @param {string} opts.instanceConnectionName - "project:region:instance"
 * @param {string} opts.iamUser
 * @param {string} opts.database
 * @returns {Promise<{client: import('@prisma/client').PrismaClient, connector: object, pool: import('pg').Pool}>}
 *   `client` has RLS enforcement and a `tenantTransaction()` helper applied
 *   the same way as the default export, both correctly bound to THIS
 *   client's own connection (never the default export's) — caller must call
 *   `pool.end()` and `connector.close()` on shutdown.
 */
async function createPrismaClientWithIamAuth({ instanceConnectionName, iamUser, database }) {
  const { createIamAuthPool } = require('./cloud-sql-connector');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { pool, connector } = await createIamAuthPool({ instanceConnectionName, iamUser, database });
  const iamAdapter = new PrismaPg(pool, { disposeExternalPool: true });
  const rawClient = new PrismaClient({ adapter: iamAdapter });
  const client = withRls(rawClient);
  client.tenantTransaction = makeTenantTransaction(rawClient, true); // Cloud SQL IAM auth is Postgres-only
  return { client, connector, pool };
}
prisma.createPrismaClientWithIamAuth = createPrismaClientWithIamAuth;

let iamHandles = null;

/**
 * Startup hook that actually PUTS Cloud SQL IAM auth on the production path.
 *
 * Enabled by CLOUD_SQL_IAM_AUTH=1 plus CLOUD_SQL_INSTANCE
 * ("project:region:instance"), CLOUD_SQL_IAM_USER and CLOUD_SQL_DATABASE.
 * When unset this is a no-op and the static-password DATABASE_URL client
 * built above stays in place, so the default deployment path is unchanged.
 *
 * Must be awaited before the server accepts traffic — index.js does this
 * before app.listen(). Because the export is a Proxy over `active`, route
 * modules that already required this file pick the new client up with no
 * re-require and no boot-order change.
 *
 * Fails closed on purpose: if an operator has explicitly asked for IAM auth
 * and it cannot be established, the process must not quietly fall back to
 * password auth — that would defeat the point of turning it on.
 */
async function initCloudSqlIamAuth() {
  if (process.env.CLOUD_SQL_IAM_AUTH !== '1') return { enabled: false };
  const instanceConnectionName = process.env.CLOUD_SQL_INSTANCE;
  const iamUser = process.env.CLOUD_SQL_IAM_USER;
  const database = process.env.CLOUD_SQL_DATABASE;
  if (!instanceConnectionName || !iamUser || !database) {
    throw new Error('CLOUD_SQL_IAM_AUTH=1 requires CLOUD_SQL_INSTANCE, CLOUD_SQL_IAM_USER and CLOUD_SQL_DATABASE.');
  }
  // Called through the export (not the local binding) so it is substitutable
  // in tests, the same seam lib/storage.js uses for __signedUrlFn — the real
  // Cloud SQL handshake needs a live instance and can't run in CI.
  const { client, connector, pool } = await prisma.createPrismaClientWithIamAuth({ instanceConnectionName, iamUser, database });
  active = client;
  OVERRIDES.tenantTransaction = client.tenantTransaction;
  iamHandles = { connector, pool };
  console.log(JSON.stringify({ type: 'cloud_sql_iam_auth_enabled', instanceConnectionName, iamUser, database }));
  return { enabled: true };
}

/** Release the IAM connector's background cert-refresh cycle and its pool.
 * No-op when IAM auth was never initialized. */
async function shutdownCloudSqlIamAuth() {
  if (!iamHandles) return;
  const { connector, pool } = iamHandles;
  iamHandles = null;
  try { await pool.end(); } catch {}
  try { await connector.close(); } catch {}
}

prisma.initCloudSqlIamAuth = initCloudSqlIamAuth;
prisma.shutdownCloudSqlIamAuth = shutdownCloudSqlIamAuth;
/** Test seam: what the Proxy currently forwards to. */
prisma.__activeClient = () => active;

module.exports = prisma;

