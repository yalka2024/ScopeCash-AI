/**
 * LLM tracing adapter (opt-in, no-op by default).
 *
 * Gives observability over prompt execution — model, token usage and latency per
 * call, and nestable spans for the agent execution tree — WITHOUT forcing a
 * dependency or vendor. Backends are lazy-loaded and chosen by env:
 *   - Langfuse:  LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (+ LANGFUSE_BASEURL)
 *                requires `npm i langfuse`
 *   - OpenTelemetry: OTEL_EXPORTER_OTLP_ENDPOINT
 *                requires `npm i @opentelemetry/api`
 *   - Debug:     TRACE_DEBUG=1  → logs spans to stdout
 *   - else:      no-op (zero overhead)
 *
 * Never throws to the caller — a tracing failure must not break a request.
 * Generated for ScopeCash AI.
 */
let _backend = null;
let _init = false;

function backend() {
  if (_init) return _backend;
  _init = true;
  try {
    if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
      const { Langfuse } = require('langfuse');
      const lf = new Langfuse({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASEURL || undefined,
      });
      _backend = { kind: 'langfuse', lf };
    } else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const otel = require('@opentelemetry/api');
      _backend = { kind: 'otel', tracer: otel.trace.getTracer('scopecash-ai') };
    } else if (process.env.TRACE_DEBUG === '1') {
      _backend = { kind: 'debug' };
    } else {
      _backend = { kind: 'none' };
    }
  } catch (e) {
    console.warn('[tracing] backend unavailable, disabling:', e.message);
    _backend = { kind: 'none' };
  }
  return _backend;
}

function name() { return backend().kind; }
function enabled() { return backend().kind !== 'none'; }

/**
 * Record a single LLM generation (model, tokens, latency). Fire-and-forget.
 */
function recordLlm({ provider, model, promptTokens = 0, completionTokens = 0, latencyMs = 0, label = 'llm' } = {}) {
  const b = backend();
  try {
    if (b.kind === 'langfuse') {
      b.lf.generation({
        name: label,
        model: model || provider,
        usage: { input: promptTokens, output: completionTokens },
        metadata: { provider, latencyMs },
      });
    } else if (b.kind === 'otel') {
      const span = b.tracer.startSpan(label);
      span.setAttributes({ 'gen_ai.system': provider, 'gen_ai.request.model': model || '', 'gen_ai.usage.input_tokens': promptTokens, 'gen_ai.usage.output_tokens': completionTokens, 'gen_ai.latency_ms': latencyMs });
      span.end();
    } else if (b.kind === 'debug') {
      console.log(`[trace] ${label} provider=${provider} model=${model} in=${promptTokens} out=${completionTokens} ${latencyMs}ms`);
    }
  } catch (e) { /* tracing must never break the request */ }
}

/**
 * Run `fn` inside a named span (nestable). Times it and records usage if `fn`
 * returns an object with a `usage` field. Returns whatever `fn` returns.
 */
async function withSpan(label, attrs, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const u = result && (result.usage || result);
    recordLlm({
      provider: attrs && attrs.provider,
      model: attrs && attrs.model,
      promptTokens: u ? (u.promptTokens || u.input || 0) : 0,
      completionTokens: u ? (u.completionTokens || u.output || 0) : 0,
      latencyMs: Date.now() - t0,
      label,
    });
    return result;
  } catch (e) {
    recordLlm({ provider: attrs && attrs.provider, model: attrs && attrs.model, latencyMs: Date.now() - t0, label: `${label}:error` });
    throw e;
  }
}

async function flush() {
  const b = backend();
  try { if (b.kind === 'langfuse' && b.lf.flushAsync) await b.lf.flushAsync(); } catch { /* ignore */ }
}

module.exports = { recordLlm, withSpan, flush, enabled, name };

