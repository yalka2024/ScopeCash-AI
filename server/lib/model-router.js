/**
 * AI model registry + router (Tier 13).
 *
 * Provides a provider-agnostic model catalog with:
 *   - per-model context window, max output, modality, capabilities
 *   - per-model price (USD per 1M input + 1M output tokens)
 *   - quality tier (0=basic, 1=balanced, 2=premium)
 *
 * The router selects a model for a request based on:
 *   - explicit `modelHint` if it's allow-listed
 *   - the tenant's plan-aware quality ceiling
 *   - cost/quality tradeoff knob (`AI_ROUTER_STRATEGY` = cheapest|balanced|best)
 *   - budget headroom (skip premium models when monthly spend > 90% budget)
 */

// Catalog is config-driven: server/config/models.json (refresh prices/ids there
// without touching code). Per-deployment price overrides via env:
// AI_PRICE_<MODEL_ID_UPPER_SNAKE>_INPUT_USD_PER_M / _OUTPUT_USD_PER_M.
const fs = require('fs');
const path = require('path');

// Embedded fallback used only if config/models.json is missing/unreadable.
const FALLBACK_CONFIG = {
  models: {
    'claude-haiku-4-5':  { provider: 'anthropic', quality: 1, ctx: 200_000,   maxOut: 64_000,  inUsdPerM: 1.00,  outUsdPerM: 5.00 },
    'claude-sonnet-4-6': { provider: 'anthropic', quality: 2, ctx: 1_000_000, maxOut: 64_000,  inUsdPerM: 3.00,  outUsdPerM: 15.00 },
    'claude-opus-4-8':   { provider: 'anthropic', quality: 3, ctx: 1_000_000, maxOut: 128_000, inUsdPerM: 5.00,  outUsdPerM: 25.00 },
    'claude-fable-5':    { provider: 'anthropic', quality: 3, ctx: 1_000_000, maxOut: 128_000, inUsdPerM: 10.00, outUsdPerM: 50.00 },
    'gpt-4o-mini':       { provider: 'openai',    quality: 1, ctx: 128_000,   maxOut: 16_000,  inUsdPerM: 0.15,  outUsdPerM: 0.60 },
    'gpt-4o':            { provider: 'openai',    quality: 2, ctx: 128_000,   maxOut: 16_000,  inUsdPerM: 2.50,  outUsdPerM: 10.00 },
    'gemini-flash-latest': { provider: 'gemini',  quality: 1, ctx: 1_000_000, maxOut: 65_000,  inUsdPerM: 0.30,  outUsdPerM: 2.50 },
    'gemini-pro-latest': { provider: 'gemini',    quality: 2, ctx: 1_000_000, maxOut: 65_000,  inUsdPerM: 1.25,  outUsdPerM: 10.00 },
    'local-mock':        { provider: 'mock',      quality: 0, ctx: 32_000,    maxOut: 4_000,   inUsdPerM: 0,     outUsdPerM: 0 },
  },
  planQualityCeiling: { free: 1, starter: 2, pro: 3, enterprise: 3 },
};

function loadConfig() {
  try {
    const p = path.join(__dirname, '..', 'config', 'models.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && raw.models && Object.keys(raw.models).length) return raw;
  } catch { /* fall through to embedded defaults */ }
  return FALLBACK_CONFIG;
}

const CONFIG = loadConfig();
const REGISTRY = Object.freeze(CONFIG.models);

function priceFor(modelId) {
  const m = REGISTRY[modelId];
  if (!m) return { inUsdPerM: 0, outUsdPerM: 0 };
  const k = modelId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const inOv = parseFloat(process.env[`AI_PRICE_${k}_INPUT_USD_PER_M`]);
  const outOv = parseFloat(process.env[`AI_PRICE_${k}_OUTPUT_USD_PER_M`]);
  return {
    inUsdPerM: Number.isFinite(inOv) ? inOv : m.inUsdPerM,
    outUsdPerM: Number.isFinite(outOv) ? outOv : m.outUsdPerM,
  };
}

/** Cost in USD micro-cents for a request. */
function estimateCostUcents(modelId, promptTokens, completionTokens) {
  const p = priceFor(modelId);
  // 1 USD = 100 cents = 100_000 micro-cents
  const usd = (promptTokens / 1_000_000) * p.inUsdPerM + (completionTokens / 1_000_000) * p.outUsdPerM;
  return Math.round(usd * 100_000);
}

// Plan -> max quality tier the tenant is allowed to use (config-driven).
const PLAN_QUALITY_CEILING = Object.freeze(
  CONFIG.planQualityCeiling || { free: 1, starter: 2, pro: 3, enterprise: 3 }
);

function maxQualityForPlan(planId) {
  const v = PLAN_QUALITY_CEILING[planId];
  return Number.isFinite(v) ? v : 1;
}

function strategy() {
  const s = (process.env.AI_ROUTER_STRATEGY || 'balanced').toLowerCase();
  return ['cheapest', 'balanced', 'best'].includes(s) ? s : 'balanced';
}

// Map a task difficulty to a target quality tier. 'easy' -> cheapest tier,
// 'hard' -> top tier the plan allows. Lets the router send cheap models to easy
// tasks and premium models to hard ones (cost control without quality loss).
function targetQualityForDifficulty(difficulty, ceiling) {
  switch ((difficulty || '').toLowerCase()) {
    case 'easy':   return 1;
    case 'medium': return Math.min(2, ceiling);
    case 'hard':   return ceiling;
    default:       return ceiling;   // unknown -> no constraint
  }
}

/**
 * Heuristic task-difficulty classifier (no model call). Used when the caller
 * doesn't pass an explicit difficulty. Cheap signal: length + complexity words.
 */
function classifyDifficulty(text = '') {
  const t = String(text).toLowerCase();
  const hard = /(architect|refactor|debug|migrat|optimi[sz]e|security|prove|multi-step|step by step|plan |design |reason|analy[sz]e deeply|complex)/;
  if (hard.test(t) || t.length > 4000) return 'hard';
  if (t.length < 400) return 'easy';
  return 'medium';
}

function cheapest(ids) {
  return ids.slice().sort((a, b) =>
    (priceFor(a).inUsdPerM + priceFor(a).outUsdPerM) - (priceFor(b).inUsdPerM + priceFor(b).outUsdPerM))[0];
}

/**
 * Allow-listed model ids per provider. If AI_PROVIDER is set, only models
 * matching that provider are eligible.
 */
function eligibleModels({ providerHint } = {}) {
  const wanted = (providerHint || process.env.AI_PROVIDER || '').toLowerCase();
  const ids = Object.keys(REGISTRY);
  return wanted ? ids.filter(id => REGISTRY[id].provider === wanted) : ids;
}

/**
 * Pick the model for a request.
 * @param {object} opts
 * @param {string} [opts.modelHint]   user/route preferred model id
 * @param {string} [opts.providerHint] override AI_PROVIDER
 * @param {string} opts.planId        tenant plan id
 * @param {number} [opts.budgetUtilization] 0..1 monthly AI budget used
 * @param {string} [opts.difficulty]  'easy' | 'medium' | 'hard' — routes cheap
 *                                     models to easy tasks, premium to hard ones
 * @returns {{ modelId, model, price, reason }}
 */
function pickModel({ modelHint, providerHint, planId = 'free', budgetUtilization = 0, difficulty } = {}) {
  const ceiling = maxQualityForPlan(planId);
  const elig = eligibleModels({ providerHint })
    .filter(id => REGISTRY[id].quality <= ceiling);

  // 1. Honour hint if present and eligible.
  if (modelHint && elig.includes(modelHint)) {
    return { modelId: modelHint, model: REGISTRY[modelHint], price: priceFor(modelHint), reason: 'hint' };
  }

  // 2. Squeeze quality when budget headroom is low.
  let cap = ceiling;
  if (budgetUtilization >= 0.9) cap = Math.min(cap, 1);
  else if (budgetUtilization >= 0.75) cap = Math.min(cap, 2);
  const pool = elig.filter(id => REGISTRY[id].quality <= cap);
  const finalPool = pool.length ? pool : elig;
  if (!finalPool.length) {
    return { modelId: 'local-mock', model: REGISTRY['local-mock'], price: priceFor('local-mock'), reason: 'fallback' };
  }

  // 3. Difficulty-based routing (overrides strategy when provided): cheapest
  //    model at the highest quality tier the task difficulty calls for.
  if (difficulty) {
    const target = Math.min(targetQualityForDifficulty(difficulty, ceiling), cap);
    const atOrBelow = finalPool.filter(id => REGISTRY[id].quality <= target);
    const candidates = atOrBelow.length ? atOrBelow : finalPool;
    const maxQ = Math.max(...candidates.map(id => REGISTRY[id].quality));
    const id = cheapest(candidates.filter(id => REGISTRY[id].quality === maxQ));
    return { modelId: id, model: REGISTRY[id], price: priceFor(id), reason: `difficulty:${difficulty}` };
  }

  // 4. Apply strategy.
  const strat = strategy();
  let ordered;
  if (strat === 'cheapest') {
    ordered = finalPool.slice().sort((a, b) =>
      (priceFor(a).inUsdPerM + priceFor(a).outUsdPerM) - (priceFor(b).inUsdPerM + priceFor(b).outUsdPerM));
  } else if (strat === 'best') {
    ordered = finalPool.slice().sort((a, b) => REGISTRY[b].quality - REGISTRY[a].quality);
  } else {
    // balanced: maximize quality / cost.
    ordered = finalPool.slice().sort((a, b) => {
      const ca = priceFor(a).inUsdPerM + priceFor(a).outUsdPerM + 0.01;
      const cb = priceFor(b).inUsdPerM + priceFor(b).outUsdPerM + 0.01;
      return (REGISTRY[b].quality / cb) - (REGISTRY[a].quality / ca);
    });
  }
  const id = ordered[0];
  return { modelId: id, model: REGISTRY[id], price: priceFor(id), reason: strat };
}

function listModels() {
  return Object.entries(REGISTRY).map(([id, m]) => ({ id, ...m, ...priceFor(id) }));
}

module.exports = {
  REGISTRY,
  priceFor,
  estimateCostUcents,
  maxQualityForPlan,
  strategy,
  pickModel,
  classifyDifficulty,
  listModels,
  PLAN_QUALITY_CEILING,
};

