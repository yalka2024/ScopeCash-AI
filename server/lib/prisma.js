const { PrismaClient } = require('@prisma/client');
const { currentOrgId } = require('./tenant-context');

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
// For every query we set the LOCAL GUC `app.org_id` on the SAME connection (one
// transaction) so the RLS policies in prisma/rls.sql restrict every row to the
// caller's org AT THE DATABASE. This is a hard backstop under the app-level
// `where: { orgId }` scoping: even a route that forgets the filter cannot leak
// another tenant's rows. No-op on SQLite (no RLS) and when there is no org in
// context (system jobs / seed / pre-auth lookups run unscoped).
//
// NOTE: requires the RLS migration applied (`npm run db:postgres:rls`) AND the
// app DB role to be subject to RLS (the migration uses FORCE ROW LEVEL SECURITY).
// Verify enforcement against a real Postgres before relying on it in production.
function withRls(client) {
  return client.$extends({
    name: 'rls-tenant-isolation',
    query: {
      async $allOperations({ args, query }) {
        const orgId = currentOrgId();
        if (!orgId) return query(args);
        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('app.org_id', ${String(orgId)}, true)`,
          query(args),
        ]);
        return result;
      },
    },
  });
}

const prisma = isPg ? withRls(base) : base;

module.exports = prisma;

