/**
 * Embeddings — provider-agnostic text -> vector.
 *
 * Uses OpenAI embeddings when OPENAI_API_KEY is set and EMBEDDING_PROVIDER is
 * 'openai'. Otherwise falls back to a deterministic local hash embedding so the
 * RAG stack works offline and in tests (lower quality, but functional and
 * dependency-free). Generated for ScopeCash AI.
 */
const crypto = require('crypto');

const PROVIDER = (process.env.EMBEDDING_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'local')).toLowerCase();
const OPENAI_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const LOCAL_DIM = parseInt(process.env.EMBEDDING_LOCAL_DIM || '256', 10);

/** Deterministic bag-of-hashed-tokens embedding. Same text -> same vector. */
function localEmbed(text) {
  const vec = new Array(LOCAL_DIM).fill(0);
  // Drop short stopwords and naively de-pluralize so e.g. "returns" ~ "return".
  // This is a low-quality offline fallback; real retrieval uses provider
  // embeddings (set EMBEDDING_PROVIDER=openai).
  const tokens = (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(t => t.length >= 3)
    .map(t => (t.length > 3 && t.endsWith('s')) ? t.slice(0, -1) : t);
  for (const tok of tokens) {
    const h = crypto.createHash('md5').update(tok).digest();
    const idx = h.readUInt32BE(0) % LOCAL_DIM;
    const sign = (h[4] & 1) ? 1 : -1;
    vec[idx] += sign;
  }
  // L2-normalize so cosine similarity is a dot product.
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

async function openaiEmbed(texts) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.embeddings.create({ model: OPENAI_MODEL, input: texts });
  return resp.data.map(d => d.embedding);
}

/** Embed one or many strings. Returns array of vectors. */
async function embed(input) {
  const texts = Array.isArray(input) ? input : [input];
  if (PROVIDER === 'openai' && process.env.OPENAI_API_KEY) {
    return openaiEmbed(texts);
  }
  return texts.map(localEmbed);
}

async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}

function provider() { return (PROVIDER === 'openai' && process.env.OPENAI_API_KEY) ? 'openai' : 'local'; }

module.exports = { embed, embedOne, provider };

