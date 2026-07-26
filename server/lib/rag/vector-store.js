/**
 * Vector store — namespaced (per-tenant) retrieval with HYBRID search.
 *
 * Backends (selected by RAG_VECTOR_BACKEND, else by DATABASE_URL):
 *   - 'memory'   (default): in-memory cosine + keyword, fused with RRF. Zero deps,
 *                 works in dev/tests immediately. Not durable across restarts.
 *   - 'pgvector' (production): durable pgvector + Postgres full-text, same fusion.
 *                 See vector-store.pg.js + prisma/rag-pgvector.sql. Verify on a
 *                 real Postgres before relying on it.
 *
 * Interface (all may be awaited; the memory impl is sync, pg is async):
 *   upsert(ns, chunks) · search(ns, qVec, k) · searchHybrid(ns, opts) ·
 *   remove(ns, ids) · clear(ns) · stats(ns) · backend()
 * Generated for ScopeCash AI.
 */
const crypto = require('crypto');
const { cosine, tokenize, sparseScore, rrf } = require('./_score');

// ── in-memory backend ───────────────────────────────────────────────────────
const _store = new Map(); // namespace -> Map(id -> { id, text, embedding, metadata })
function _ns(namespace) {
  const key = namespace || 'default';
  if (!_store.has(key)) _store.set(key, new Map());
  return _store.get(key);
}

const memory = {
  backend() { return 'memory'; },
  upsert(namespace, chunks) {
    const ns = _ns(namespace);
    const ids = [];
    for (const c of chunks) {
      const id = c.id || crypto.randomUUID();
      ns.set(id, { id, text: c.text, embedding: c.embedding, metadata: c.metadata || {} });
      ids.push(id);
    }
    return ids;
  },
  search(namespace, queryEmbedding, topK = 5) {
    const ns = _ns(namespace);
    const scored = [];
    for (const c of ns.values()) {
      scored.push({ id: c.id, text: c.text, metadata: c.metadata, score: cosine(queryEmbedding, c.embedding) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  },
  // Hybrid: dense (cosine) + sparse (keyword) candidate lists fused with RRF.
  searchHybrid(namespace, { queryEmbedding, queryText, topK = 5, candidateK } = {}) {
    const ns = _ns(namespace);
    const items = [...ns.values()];
    if (items.length === 0) return [];
    const cand = candidateK || Math.max(topK * 4, 20);
    const dense = queryEmbedding
      ? items.map((c) => ({ id: c.id, s: cosine(queryEmbedding, c.embedding) })).sort((a, b) => b.s - a.s).slice(0, cand).map((x) => x.id)
      : [];
    const qTok = tokenize(queryText);
    const sparse = items.map((c) => ({ id: c.id, s: sparseScore(qTok, c.text) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, cand).map((x) => x.id);
    const fused = [...rrf([dense, sparse]).entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    return fused.map(([id, score]) => { const c = ns.get(id); return { id: c.id, text: c.text, metadata: c.metadata, score }; });
  },
  remove(namespace, ids) {
    const ns = _ns(namespace);
    let n = 0;
    for (const id of ids) if (ns.delete(id)) n++;
    return n;
  },
  clear(namespace) {
    const ns = _ns(namespace);
    const n = ns.size;
    ns.clear();
    return n;
  },
  stats(namespace) { return { namespace: namespace || 'default', count: _ns(namespace).size, backend: 'memory' }; },
};

// ── backend selection ───────────────────────────────────────────────────────
function pickBackend() {
  const want = (process.env.RAG_VECTOR_BACKEND || '').toLowerCase();
  if (want === 'pgvector') {
    try { return require('./vector-store.pg'); } catch (e) { console.warn('[rag] pgvector backend unavailable, using memory:', e.message); }
  }
  return memory;
}
const impl = pickBackend();

module.exports = {
  backend: () => impl.backend(),
  upsert: (ns, chunks) => impl.upsert(ns, chunks),
  search: (ns, qv, k) => impl.search(ns, qv, k),
  searchHybrid: (ns, opts) => impl.searchHybrid(ns, opts),
  remove: (ns, ids) => impl.remove(ns, ids),
  clear: (ns) => impl.clear(ns),
  stats: (ns) => impl.stats(ns),
  _helpers: { cosine, tokenize, sparseScore, rrf },
};

