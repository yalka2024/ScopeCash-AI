/**
 * Real Vertex AI Gemini client (server/lib/tools/vertexaigeminiclient.js was a
 * generic HTTP-POST-to-a-configurable-URL wrapper with no SDK, no Google auth,
 * and a mock default — this is the actual integration it stood in for).
 *
 * Auth: Application Default Credentials via `@google/genai`'s own credential
 * resolution — a service account key (`GOOGLE_APPLICATION_CREDENTIALS`),
 * workload identity, or `gcloud auth application-default login` in dev. No
 * API key handling here; Vertex AI mode is IAM-authenticated, not key-based.
 *
 * Region: GCP_LOCATION (default us-central1 — override for data residency).
 *
 * Model pinning: VERTEX_GEMINI_MODEL / VERTEX_GEMINI_PRO_MODEL are REQUIRED,
 * not defaulted to a guessed version string, and never "-latest" — Google
 * regularly retires dated Gemini versions, and a finding whose citation
 * validity depends on model behavior must record exactly which pinned
 * version produced it (every caller stamps AgentRunRecord.model_version from
 * the API response, not from the env var, so drift is visible even if the
 * alias resolves differently than expected).
 */
const { GoogleGenAI } = require('@google/genai');

const PROJECT = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

function isConfigured() {
  return !!PROJECT;
}

let _client = null;
function client() {
  if (!isConfigured()) {
    throw Object.assign(
      new Error('Vertex AI is not configured: set GCP_PROJECT_ID (and optionally GCP_LOCATION).'),
      { code: 'vertex_unconfigured' },
    );
  }
  if (!_client) {
    _client = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  }
  return _client;
}

function requireModel(explicit, envVar) {
  const id = explicit || process.env[envVar];
  if (!id) {
    throw Object.assign(
      new Error(`No Vertex Gemini model configured — set ${envVar} to a specific, pinned model id (e.g. "gemini-2.5-flash-001"), not a "-latest" alias.`),
      { code: 'vertex_model_unpinned' },
    );
  }
  if (/-latest$/i.test(id)) {
    throw Object.assign(
      new Error(`${envVar}="${id}" is a "-latest" alias. Pin an explicit, dated/numbered model version instead.`),
      { code: 'vertex_model_not_pinned' },
    );
  }
  return id;
}

/** Default (cheaper/faster) model id — throws if unconfigured. */
function defaultModel() { return requireModel(null, 'VERTEX_GEMINI_MODEL'); }
/** Higher-quality model id for harder reasoning steps — throws if unconfigured. */
function proModel() { return requireModel(null, 'VERTEX_GEMINI_PRO_MODEL'); }

// Approximate USD-per-1M-token pricing for cost attribution (AgentRunRecord.
// estimated_cost_usd / AiSpendEvent). Keyed by substring match against the
// pinned model id so "gemini-2.5-flash-001" and "gemini-3.0-flash-002" both
// match "flash" — override with real numbers per deployment via
// VERTEX_PRICE_<FLASH|PRO>_{IN,OUT}_USD_PER_M if these drift from Google's
// published rates.
const FALLBACK_PRICE = { inUsdPerM: 0.30, outUsdPerM: 2.50 };
function priceFor(modelId) {
  const id = (modelId || '').toLowerCase();
  const tier = id.includes('pro') ? 'PRO' : id.includes('flash') ? 'FLASH' : null;
  const envIn = tier && parseFloat(process.env[`VERTEX_PRICE_${tier}_IN_USD_PER_M`]);
  const envOut = tier && parseFloat(process.env[`VERTEX_PRICE_${tier}_OUT_USD_PER_M`]);
  if (envIn > 0 && envOut > 0) return { inUsdPerM: envIn, outUsdPerM: envOut };
  if (tier === 'PRO') return { inUsdPerM: 1.25, outUsdPerM: 10.00 };
  if (tier === 'FLASH') return FALLBACK_PRICE;
  return FALLBACK_PRICE;
}
function estimateCostUsd(modelId, promptTokens, completionTokens) {
  const p = priceFor(modelId);
  return (promptTokens / 1_000_000) * p.inUsdPerM + (completionTokens / 1_000_000) * p.outUsdPerM;
}

// Retry on 429/5xx with exponential backoff + jitter. Not retried: 4xx other
// than 429 (bad request / permission / not-found are not transient).
async function withRetry(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.code || (err.response && err.response.status);
      const retryable = status === 429 || (typeof status === 'number' && status >= 500);
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 200;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * A multimodal source: exactly one of `text`, `gcsUri` (+ mimeType — a
 * `gs://` object, used for anything already in GCS so bytes don't round-trip
 * through the app server), or `base64` (+ mimeType — small inline payloads).
 */
function toPart(source) {
  if (source.text !== undefined) return { text: source.text };
  if (source.gcsUri) {
    if (!source.mimeType) throw new Error('toPart: gcsUri parts require mimeType');
    return { fileData: { fileUri: source.gcsUri, mimeType: source.mimeType } };
  }
  if (source.base64) {
    if (!source.mimeType) throw new Error('toPart: base64 parts require mimeType');
    return { inlineData: { data: source.base64, mimeType: source.mimeType } };
  }
  throw new Error('toPart: source must have text, gcsUri, or base64');
}

/**
 * Core structured-generation call.
 *
 * @param {object} opts
 * @param {Array<{text?:string, gcsUri?:string, base64?:string, mimeType?:string}>} opts.parts
 * @param {string} [opts.systemInstruction]
 * @param {object} [opts.responseSchema] JSON-schema-ish object (Vertex's constrained
 *   subset — see the SDK's GenerateContentConfig.responseSchema docs). When set, the
 *   model is forced into `application/json` matching it and the result is parsed.
 * @param {string} [opts.model] explicit model id — otherwise defaultModel().
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxOutputTokens]
 * @returns {Promise<{text:string, json:(object|null), modelVersion:string, usage:{promptTokens:number,completionTokens:number,totalTokens:number}, costUsd:number, latencyMs:number}>}
 */
async function generate({ parts, systemInstruction, responseSchema, model, temperature = 0.1, maxOutputTokens = 8192 }) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('generate: parts must be a non-empty array');
  const ai = client();
  const modelId = model || defaultModel();
  const contents = [{ role: 'user', parts: parts.map(toPart) }];
  const config = {
    temperature,
    maxOutputTokens,
    ...(systemInstruction ? { systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] } } : {}),
    ...(responseSchema ? { responseMimeType: 'application/json', responseSchema } : {}),
  };

  const started = Date.now();
  const response = await withRetry(() => ai.models.generateContent({ model: modelId, contents, config }));
  const latencyMs = Date.now() - started;

  const text = response.text || '';
  let json = null;
  if (responseSchema) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw Object.assign(new Error('Vertex AI returned non-JSON output despite responseSchema'), { cause: err, rawText: text, code: 'vertex_bad_json' });
    }
  }
  const usageMeta = response.usageMetadata || {};
  const usage = {
    promptTokens: usageMeta.promptTokenCount || 0,
    completionTokens: usageMeta.candidatesTokenCount || 0,
    totalTokens: usageMeta.totalTokenCount || 0,
  };
  const modelVersion = response.modelVersion || modelId;
  return {
    text,
    json,
    modelVersion,
    usage,
    costUsd: estimateCostUsd(modelVersion, usage.promptTokens, usage.completionTokens),
    latencyMs,
  };
}

module.exports = {
  isConfigured,
  generate,
  toPart,
  defaultModel,
  proModel,
  estimateCostUsd,
  PROJECT,
  LOCATION,
};
