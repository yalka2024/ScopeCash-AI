/**
 * pgvector backend for the RAG vector store (production / durable).
 *
 * Same interface as the in-memory backend, but async. Stores chunks in the
 * `rag_chunks` table (see prisma/rag-pgvector.sql) with a pgvector `embedding`
 * column and a `tsv` full-text column, and does HYBRID retrieval: dense
 * (cosine `<=>`) + sparse (`ts_rank`), fused with RRF.
 *
 * Enable with RAG_VECTOR_BACKEND=pgvector (DATABASE_URL must be Postgres and the
 * migration applied via `npm run db:postgres:rag`). The embedding dimension of
 * the table (default 1536) MUST match your embedding model — use a real model
 * (OpenAI/Voyage) in production, not the 256-dim local fallback.
 *
 * NOTE: not exercised by the SQLite dev path — verify against a real Postgres
 * before relying on it. Generated for ScopeCash AI.
 */
const { Pool } = require('pg');
const { rrf, tokenize } = require('./_score');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TABLE = 'rag_chunks';

function toVectorLiteral(vec) {
  return `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}

function backend() { return 'pgvector'; }

async function upsert(namespace, chunks) {
  const ids = [];
  const client = await pool.connect();
  try {
    for (const c of chunks) {
      const id = c.id || (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      await client.query(
        `INSERT INTO ${TABLE} (id, namespace, text, embedding, metadata)
         VALUES ($1, $2, $3, $4::vector, $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
        [id, namespace || 'default', c.text, toVectorLiteral(c.embedding), JSON.stringify(c.metadata || {})]
      );
      ids.push(id);
    }
    return ids;
  } finally {
    client.release();
  }
}

async function search(namespace, queryEmbedding, topK = 5) {
  const { rows } = await pool.query(
    `SELECT id, text, metadata, 1 - (embedding <=> $2::vector) AS score
     FROM ${TABLE} WHERE namespace = $1
     ORDER BY embedding <=> $2::vector ASC
     LIMIT $3`,
    [namespace || 'default', toVectorLiteral(queryEmbedding), Math.max(1, topK)]
  );
  return rows.map((r) => ({ id: r.id, text: r.text, metadata: r.metadata, score: Number(r.score) }));
}

async function searchHybrid(namespace, { queryEmbedding, queryText, topK = 5, candidateK } = {}) {
  const ns = namespace || 'default';
  const cand = candidateK || Math.max(topK * 4, 20);
  // Dense candidates (cosine) and sparse candidates (full-text), fetched
  // separately and fused with RRF in JS (same fusion as the memory backend).
  const dense = (await pool.query(
    `SELECT id, text, metadata FROM ${TABLE} WHERE namespace = $1
     ORDER BY embedding <=> $2::vector ASC LIMIT $3`,
    [ns, toVectorLiteral(queryEmbedding), cand]
  )).rows;
  const sparse = (await pool.query(
    `SELECT id, text, metadata, ts_rank(tsv, plainto_tsquery('english', $2)) AS rank
     FROM ${TABLE}
     WHERE namespace = $1 AND tsv @@ plainto_tsquery('english', $2)
     ORDER BY rank DESC LIMIT $3`,
    [ns, queryText || '', cand]
  )).rows;
  const byId = new Map();
  for (const r of [...dense, ...sparse]) if (!byId.has(r.id)) byId.set(r.id, r);
  const fused = [...rrf([dense.map((r) => r.id), sparse.map((r) => r.id)]).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);
  return fused.map(([id, score]) => { const r = byId.get(id); return { id: r.id, text: r.text, metadata: r.metadata, score }; });
}

async function remove(namespace, ids) {
  if (!ids || ids.length === 0) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM ${TABLE} WHERE namespace = $1 AND id = ANY($2::text[])`,
    [namespace || 'default', ids]
  );
  return rowCount;
}

async function clear(namespace) {
  const { rowCount } = await pool.query(`DELETE FROM ${TABLE} WHERE namespace = $1`, [namespace || 'default']);
  return rowCount;
}

async function stats(namespace) {
  const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ${TABLE} WHERE namespace = $1`, [namespace || 'default']);
  return { namespace: namespace || 'default', count: rows[0].count, backend: 'pgvector' };
}

module.exports = { backend, upsert, search, searchHybrid, remove, clear, stats, _tokenize: tokenize };

