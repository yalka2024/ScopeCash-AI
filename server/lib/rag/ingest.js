/**
 * RAG ingestion + retrieval.
 *   ingestText  -> chunk a document, embed chunks, upsert into the tenant's namespace
 *   retrieve    -> embed a query, return top-k chunks with citations
 * Generated for ScopeCash AI.
 */
const embeddings = require('./embeddings');
const store = require('./vector-store');
const reranker = require('./reranker');

const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || '900', 10);
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || '150', 10);
const TOP_K = parseInt(process.env.RAG_TOP_K || '5', 10);

/** Split text into overlapping chunks on paragraph/sentence-ish boundaries. */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    // Prefer to break on a paragraph or sentence boundary near the window end.
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const br = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
      if (br > size * 0.5) end = start + br + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks.filter(Boolean);
}

/**
 * Ingest a document for a tenant.
 * @param {string} namespace  tenant/org id
 * @param {string} text       document content
 * @param {object} metadata   e.g. { source, title }
 * @returns {Promise<{ chunks, ids }>}
 */
async function ingestText(namespace, text, metadata = {}) {
  const pieces = chunkText(text);
  if (pieces.length === 0) return { chunks: 0, ids: [] };
  const vectors = await embeddings.embed(pieces);
  const records = pieces.map((p, i) => ({
    text: p,
    embedding: vectors[i],
    metadata: { ...metadata, chunkIndex: i },
  }));
  const ids = await store.upsert(namespace, records);
  return { chunks: records.length, ids, provider: embeddings.provider() };
}

/**
 * Retrieve the most relevant chunks for a query.
 * @returns {Promise<{ matches, citations }>}
 */
async function retrieve(namespace, query, topK = TOP_K) {
  const qv = await embeddings.embedOne(query);
  // Hybrid retrieval (dense + keyword, RRF-fused) — over-fetch, then rerank to topK.
  const candidates = await store.searchHybrid(namespace, {
    queryEmbedding: qv,
    queryText: query,
    topK: Math.max(topK * 3, topK),
  });
  const ranked = await reranker.rerank(query, candidates, topK);
  const matches = ranked.slice(0, topK);
  const citations = matches.map((m, i) => ({
    ref: i + 1,
    score: Number((m.score || 0).toFixed(4)),
    source: m.metadata && m.metadata.source,
    title: m.metadata && m.metadata.title,
    excerpt: (m.text || '').slice(0, 240),
  }));
  return {
    matches,
    citations,
    provider: embeddings.provider(),
    backend: store.backend(),
    reranker: reranker.provider(),
  };
}

module.exports = { chunkText, ingestText, retrieve, stats: store.stats, clear: store.clear };

