/**
 * Shared retrieval scoring helpers (used by both the in-memory and pgvector
 * backends — kept in its own module to avoid a circular require). Generated for
 * ScopeCash AI.
 */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // vectors are expected L2-normalized
}

function tokenize(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g)) || [];
}

function sparseScore(queryTokens, text) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  let score = 0;
  for (const q of queryTokens) if (tf.has(q)) score += 1 + Math.log(tf.get(q));
  return score;
}

// Reciprocal Rank Fusion — combine ranked id lists into one robust ranking.
function rrf(lists, k = 60) {
  const acc = new Map();
  for (const list of lists) {
    list.forEach((id, i) => acc.set(id, (acc.get(id) || 0) + 1 / (k + i + 1)));
  }
  return acc;
}

module.exports = { cosine, tokenize, sparseScore, rrf };

