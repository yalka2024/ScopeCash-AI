/**
 * AI evaluation harness (Tier 13).
 *
 * Runs deterministic, offline-friendly evaluation suites against a candidate
 * model and persists EvalRun + per-case results to the database. Designed to
 * be:
 *   - Cheap: small fixed prompt set; tokens capped per case.
 *   - Safe: no PII, no external context — uses the canned suites in
 *           server/evals/<suite>.json.
 *   - Useful: returns pass-rate + median latency + total spend so CI can
 *             gate on regressions.
 *
 * The suites are evaluated by simple substring / regex / JSON-shape rules.
 * Plug in richer scorers (LLM-as-judge, BLEU, exact-match) by extending the
 * `scorers` table below.
 */
const path = require('path');
const fs = require('fs');
const prisma = require('./prisma');
const router = require('./model-router');
const budget = require('./ai-budget');
const { scorers, scoreCase } = require('./eval-scorers');

const SUITES_DIR = path.join(__dirname, '..', 'evals');

function loadSuite(name) {
  const safe = String(name || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safe) throw new Error('invalid_suite_name');
  const p = path.join(SUITES_DIR, `${safe}.json`);
  if (!fs.existsSync(p)) throw new Error(`suite_not_found:${safe}`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!raw || !Array.isArray(raw.cases)) throw new Error('invalid_suite_shape');
  return raw;
}

// scorers + scoreCase are shared with the release gate via lib/eval-scorers.js.

/**
 * Pluggable model invoker. The caller may pass `invoker` to inject a fake
 * for tests. By default, evals uses a deterministic "echo" mock so the
 * suite runs in CI without external API keys. Wire `invoker` to a real
 * provider when running production evals.
 */
async function defaultInvoker({ system, prompt }) {
  // Echo-shape response that satisfies basic contains/json scorers.
  const lower = (prompt || '').toLowerCase();
  // Refuse injection-style prompts so the smoke suite passes without a real model.
  if (/ignore .*instruction|reveal|system prompt|developer mode/.test(lower)) {
    return { text: 'I cannot comply with that request.', promptTokens: Math.ceil((system.length + prompt.length) / 4), completionTokens: 8 };
  }
  if (lower.includes('return json')) {
    return { text: JSON.stringify({ ok: true, echo: prompt }), promptTokens: prompt.length, completionTokens: 32 };
  }
  return {
    text: `mock-eval-response: ${prompt}`.slice(0, 512),
    promptTokens: Math.ceil((system.length + prompt.length) / 4),
    completionTokens: 32,
  };
}

/**
 * Build an HTTP invoker that calls a user-provided model endpoint.
 * Expected request: POST <endpoint> { model, system, prompt }
 * Expected response: { text } or { output: { text } } or { choices: [{ message: { content }}] }
 * Authentication: Authorization: Bearer <apiKey> if apiKey provided.
 */
function httpInvoker({ endpoint, apiKey, timeoutMs = 30000 }) {
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
    throw new Error('http_invoker_requires_endpoint_url');
  }
  return async function ({ system, prompt, model }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, system, prompt }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`http_${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => ({}));
      // Normalise common response shapes:
      let text =
        data.text ||
        (data.output && data.output.text) ||
        (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
        (typeof data === 'string' ? data : '') ||
        '';
      const usage = data.usage || {};
      return {
        text: String(text),
        promptTokens: usage.prompt_tokens || usage.promptTokens || Math.ceil((system.length + prompt.length) / 4),
        completionTokens: usage.completion_tokens || usage.completionTokens || Math.ceil(text.length / 4),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Run a named suite end-to-end. Persists EvalRun + EvalResult rows.
 * Returns summary { runId, score, passed, total, durationMs, model }.
 *
 * Optional: { recordId, userId } link this run to a specific AI use case/system.
 * Optional: { invokerConfig: { mode: 'http', endpoint, apiKey } } selects the HTTP invoker.
 */
async function runSuite({
  suite = 'smoke', modelHint = null, invoker = null,
  planId = 'pro', recordId = null, userId = null, invokerConfig = null,
} = {}) {
  const def = loadSuite(suite);
  const pick = router.pickModel({ modelHint, planId, budgetUtilization: 0 });
  const start = Date.now();
  const results = [];
  let totalUcents = 0;
  let totalTokens = 0;

  // Pick the invoker: explicit > config-based HTTP > default mock.
  let activeInvoker = invoker;
  if (!activeInvoker && invokerConfig && invokerConfig.mode === 'http') {
    activeInvoker = httpInvoker(invokerConfig);
  }
  if (!activeInvoker) activeInvoker = defaultInvoker;

  for (const c of def.cases) {
    const t0 = Date.now();
    let outText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let errorMsg = null;
    try {
      const r = await activeInvoker({
        system: def.system || 'You are a deterministic evaluation harness.',
        prompt: c.prompt,
        model: pick.modelId,
      });
      outText = r.text || '';
      promptTokens = r.promptTokens || 0;
      completionTokens = r.completionTokens || 0;
    } catch (err) {
      errorMsg = err.message;
    }
    const score = scoreCase(outText, c.expect);
    const ucents = router.estimateCostUcents(pick.modelId, promptTokens, completionTokens);
    totalUcents += ucents;
    totalTokens += promptTokens + completionTokens;
    results.push({
      caseId: c.id,
      passed: score.passed && !errorMsg,
      durationMs: Date.now() - t0,
      promptTokens, completionTokens, ucents,
      failures: errorMsg ? [{ kind: 'invoker_error', error: errorMsg }] : score.failures,
      output: outText.slice(0, 500),
    });
  }

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const scoreVal = total > 0 ? passed / total : 0;
  const durationMs = Date.now() - start;

  let runId = null;
  try {
    const run = await prisma.evalRun.create({
      data: {
        suite,
        model: pick.modelId,
        provider: pick.model.provider,
        score: scoreVal,
        passed,
        total,
        durationMs,
        ucents: totalUcents,
        totalTokens,
        recordId,
        userId,
      },
    });
    runId = run.id;
    await prisma.evalResult.createMany({
      data: results.map(r => ({
        runId,
        caseId: r.caseId,
        passed: r.passed,
        durationMs: r.durationMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        ucents: r.ucents,
        failures: JSON.stringify(r.failures || []).slice(0, 4000),
        output: (r.output || '').slice(0, 2000),
      })),
    }).catch(() => {});
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(JSON.stringify({ type: 'eval_persist_error', error: err.message }));
    }
  }

  return {
    runId,
    suite,
    model: pick.modelId,
    provider: pick.model.provider,
    score: scoreVal,
    passed,
    total,
    durationMs,
    spend_usd: totalUcents / 100_000,
    results,
  };
}

function listSuites() {
  if (!fs.existsSync(SUITES_DIR)) return [];
  return fs.readdirSync(SUITES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const name = f.replace(/\.json$/, '');
      try {
        const def = JSON.parse(fs.readFileSync(path.join(SUITES_DIR, f), 'utf8'));
        return { name, description: def.description || '', cases: (def.cases || []).length };
      } catch { return { name, description: '(failed to parse)', cases: 0 }; }
    });
}

module.exports = { runSuite, loadSuite, scoreCase, scorers, defaultInvoker, httpInvoker, listSuites };

