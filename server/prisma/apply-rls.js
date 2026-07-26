#!/usr/bin/env node
/**
 * apply-rls.js — applies prisma/rls.sql to the Postgres DB in DATABASE_URL.
 *
 * Idempotent. No-op (with a clear message) when DATABASE_URL is not Postgres,
 * so it is safe to call from CI/deploy pipelines that may run against SQLite.
 *
 *   npm run db:postgres:rls
 */
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL || '';
if (!url.startsWith('postgres')) {
  console.log('[rls] DATABASE_URL is not Postgres — RLS is a Postgres-only feature; skipping.');
  process.exit(0);
}

const sql = fs.readFileSync(path.join(__dirname, 'rls.sql'), 'utf8');

(async () => {
  // `pg` ships as a dependency of @prisma/adapter-pg (used for the Postgres path).
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    console.log('[rls] policies applied.');
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('[rls] failed:', e.message);
  process.exit(1);
});

