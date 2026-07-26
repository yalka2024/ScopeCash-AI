#!/usr/bin/env node
/**
 * Creates (idempotently) a NON-superuser Postgres role for running
 * tests/postgres/rls.test.js against. Must be non-superuser: Postgres
 * superusers bypass RLS regardless of policy, which would make every RLS
 * test in that file pass for the wrong reason (see prisma/rls.sql).
 *
 * Connects using DATABASE_URL (expected to be a superuser connection —
 * the default `postgres` user, as CI's postgres service provides) to
 * create the restricted role, then grants it what it needs on the schema
 * that migrate deploy already created.
 *
 * Usage: DATABASE_URL=postgresql://postgres:postgres@host:5432/db \
 *        node prisma/ci-postgres-test-role.js <role> <password>
 */
const url = process.env.DATABASE_URL || '';
if (!url.startsWith('postgres')) {
  console.log('[ci-postgres-test-role] DATABASE_URL is not Postgres — skipping.');
  process.exit(0);
}
const role = process.argv[2];
const password = process.argv[3];
if (!role || !password) {
  console.error('[ci-postgres-test-role] usage: node ci-postgres-test-role.js <role> <password>');
  process.exit(1);
}
// role/password are interpolated into SQL identifiers below (Postgres has
// no parameterized-identifier support) — this script only ever runs with
// CI-controlled args, but validate the shape anyway rather than trust that.
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  console.error('[ci-postgres-test-role] role must match /^[a-z_][a-z0-9_]*$/');
  process.exit(1);
}
if (/['"\\;]/.test(password)) {
  console.error('[ci-postgres-test-role] password must not contain quotes, backslashes, or semicolons');
  process.exit(1);
}

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', '${role}', '${password}');
        END IF;
      END
      $$;
    `);
    await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${role}`);
    console.log(`[ci-postgres-test-role] role "${role}" ready (non-superuser, table grants applied).`);
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('[ci-postgres-test-role] failed:', e.message);
  process.exit(1);
});
