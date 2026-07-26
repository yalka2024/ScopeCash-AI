-- ============================================================================
-- pgvector RAG store — ScopeCash AI
-- ----------------------------------------------------------------------------
-- Durable, scalable replacement for the in-memory vector store. Postgres only.
-- Apply with:  npm run db:postgres:rag   (or psql "$DATABASE_URL" -f prisma/rag-pgvector.sql)
-- Then set RAG_VECTOR_BACKEND=pgvector.
--
-- The embedding dimension (1536) targets OpenAI text-embedding-3-small / Voyage.
-- If you use a different model, change vector(1536) to match its dimension.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS rag_chunks (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  namespace  text NOT NULL,                          -- tenant/org id
  text       text NOT NULL,
  embedding  vector(1536),
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_chunks_ns        ON rag_chunks (namespace);
CREATE INDEX IF NOT EXISTS rag_chunks_tsv       ON rag_chunks USING gin (tsv);
-- HNSW cosine index for fast approximate nearest-neighbour (pgvector >= 0.5).
CREATE INDEX IF NOT EXISTS rag_chunks_embedding ON rag_chunks USING hnsw (embedding vector_cosine_ops);

