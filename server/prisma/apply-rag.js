#!/usr/bin/env node
/**
 * apply-rag.js — applies prisma/rag-pgvector.sql (pgvector RAG store) to the
 * Postgres DB in DATABASE_URL. Idempotent. No-op on non-Postgres URLs.
 *
 *   npm run db:postgres:rag
 */
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL || '';
if (!url.startsWith('postgres')) {
  console.log('[rag] DATABASE_URL is not Postgres — pgvector is a Postgres-only feature; skipping.');
  process.exit(0);
}

const sql = fs.readFileSync(path.join(__dirname, 'rag-pgvector.sql'), 'utf8');

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    console.log('[rag] pgvector store ready (rag_chunks).');
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('[rag] failed:', e.message);
  process.exit(1);
});

