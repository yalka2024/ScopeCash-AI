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
function withRls(client) {
  return client.$extends({
    name: 'rls-tenant-isolation',
    query: {
      // NOTE: this must NOT do `base.$transaction([base.$executeRaw\`SET...\`, query(args)])`.
      // `query(args)` is bound to the ORIGINAL (un-extended) operation from this specific
      // call; batching it inside an array alongside a *separately* `base`-issued
      // $executeRaw does not reliably put both statements on the same connection/
      // transaction, which silently defeats the whole point (verified against a real
      // non-superuser Postgres role: the array form of the two mixed-origin calls left
      // every row visible, i.e. the SET LOCAL never reached the connection that ran the
      // actual query). Instead we open one interactive transaction and re-issue the SAME
      // model + operation on that transaction's own client (`tx`), so the GUC and the
      // query provably share a connection.
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
        return base.$transaction(async (tx) => {
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

const prisma = isPg ? withRls(base) : base;

// Multi-statement atomic transactions under RLS. Plain `prisma.$transaction([opA, opB])`
// (array form) no longer gives cross-op atomicity here: each op independently goes
// through withRls's $allOperations and opens its OWN mini-transaction to scope its own
// SET LOCAL, so opA can commit while opB fails. Use this instead whenever multiple
// writes must succeed or fail together (e.g. updating a running total AND appending its
// ledger row) — it opens exactly one transaction, sets the tenant GUC once, and hands
// you a plain (non-RLS-extended) `tx` to call `tx.model.op()` on directly.
async function tenantTransaction(fn) {
  if (!isPg) return base.$transaction(fn);
  const orgId = currentOrgId();
  const system = isSystemAccess();
  if (!orgId && !system) {
    console.warn('[prisma] tenantTransaction ran with no tenant context and no system-access grant — RLS (fail-closed) will return zero rows for org-scoped tables.');
    return base.$transaction(fn);
  }
  return base.$transaction(async (tx) => {
    if (system) await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    else await tx.$executeRaw`SELECT set_config('app.org_id', ${String(orgId)}, true)`;
    return fn(tx);
  });
}
prisma.tenantTransaction = tenantTransaction;

module.exports = prisma;

