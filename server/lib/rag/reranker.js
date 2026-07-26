/**
 * Cross-encoder reranker (opt-in adapter).
 *
 * After hybrid retrieval returns candidates, a reranker re-scores them against
 * the query with a cross-encoder for a big precision gain. This is OFF by
 * default and falls back to identity (keeps the fusion order) so the platform
 * works with zero extra config. Enable with:
 *   RERANK_PROVIDER=voyage  VOYAGE_API_KEY=...   (model RERANK_MODEL, default rerank-2)
 *   RERANK_PROVIDER=cohere  COHERE_API_KEY=...   (model RERANK_MODEL, default rerank-english-v3.0)
 * Generated for ScopeCash AI.
 */
const PROVIDER = (process.env.RERANK_PROVIDER || 'none').toLowerCase();

function provider() {
  if (PROVIDER === 'voyage' && process.env.VOYAGE_API_KEY) return 'voyage';
  if (PROVIDER === 'cohere' && process.env.COHERE_API_KEY) return 'cohere';
  return 'none';
}

async function voyageRerank(query, candidates, topK) {
  const model = process.env.RERANK_MODEL || 'rerank-2';
  const res = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, documents: candidates.map((c) => c.text), model, top_k: topK }),
  });
  if (!res.ok) throw new Error(`voyage rerank ${res.status}`);
  const data = await res.json();
  return data.data.map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
}

async function cohereRerank(query, candidates, topK) {
  const model = process.env.RERANK_MODEL || 'rerank-english-v3.0';
  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, documents: candidates.map((c) => c.text), model, top_n: topK }),
  });
  if (!res.ok) throw new Error(`cohere rerank ${res.status}`);
  const data = await res.json();
  return data.results.map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
}

/**
 * Rerank candidates ({ id, text, metadata, score }) against the query.
 * Returns the top-K reranked. Falls back to identity (fusion order) on any
 * error or when no provider is configured — never throws to the caller.
 */
async function rerank(query, candidates, topK = candidates.length) {
  if (!candidates || candidates.length === 0) return [];
  try {
    if (provider() === 'voyage') return await voyageRerank(query, candidates, topK);
    if (provider() === 'cohere') return await cohereRerank(query, candidates, topK);
  } catch (e) {
    console.warn('[rag] rerank failed, using fusion order:', e.message);
  }
  return candidates.slice(0, topK);
}

module.exports = { rerank, provider };

