/**
 * Agent memory — per-session conversational + working memory.
 *
 * remember(ns, role, content)  append a turn to a session's memory
 * recall(ns, query, k)         return the k most relevant/recent turns
 * history(ns, n)               last n turns verbatim
 *
 * Backing is in-memory with a per-namespace cap; relevance is keyword overlap
 * with a recency boost (no embedding dependency). For durable / semantic memory
 * across restarts, back this with the RAG vector store or a DB — see TODO.md.
 * Generated for ScopeCash AI.
 */
const _mem = new Map();
const MAX = parseInt(process.env.AGENT_MEMORY_MAX || '200', 10);

function _ns(namespace) {
  const key = namespace || 'default';
  if (!_mem.has(key)) _mem.set(key, []);
  return _mem.get(key);
}

function remember(namespace, role, content) {
  const arr = _ns(namespace);
  arr.push({ role, content: String(content == null ? '' : content).slice(0, 4000), ts: Date.now() });
  while (arr.length > MAX) arr.shift();
  return arr.length;
}

function _score(text, queryTokens) {
  const t = String(text).toLowerCase();
  let s = 0;
  for (const q of queryTokens) { if (q.length >= 3 && t.includes(q)) s++; }
  return s;
}

function recall(namespace, query, k = 5) {
  const arr = _ns(namespace);
  if (!arr.length) return [];
  const qt = (String(query || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  // Relevance from keyword overlap; small recency boost so recent turns surface
  // when nothing matches strongly.
  const scored = arr.map((m, i) => ({ m, score: _score(m.content, qt) + (i / arr.length) * 0.5 }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k)).map(s => s.m);
}

function history(namespace, n = 10) { return _ns(namespace).slice(-n); }
function clear(namespace) { const a = _ns(namespace); const c = a.length; a.length = 0; return c; }
function stats(namespace) { return { namespace: namespace || 'default', count: _ns(namespace).length }; }

module.exports = { remember, recall, history, clear, stats };

