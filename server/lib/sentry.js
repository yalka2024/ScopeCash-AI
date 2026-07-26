/**
 * ScopeCash AI — Sentry error tracking (Node SDK v8+)
 *
 * No-op unless SENTRY_DSN is set. Uses dynamic require so the dependency is
 * optional. In Sentry v8 the HTTP request context is captured automatically
 * via OpenTelemetry auto-instrumentation, so `requestHandler()` is a
 * pass-through middleware kept for interface compatibility with the existing
 * index.js wiring.
 */

let Sentry = null;
let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  if (!process.env.SENTRY_DSN) return;
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.GIT_SHA || process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
      // Do not send PII by default; opt in via env.
      sendDefaultPii: process.env.SENTRY_SEND_PII === '1',
      beforeSend(event) {
        try {
          if (event.request?.headers) {
            for (const k of Object.keys(event.request.headers)) {
              if (/^(cookie|authorization|x-api-key|x-csrf-token)$/i.test(k)) {
                event.request.headers[k] = '[redacted]';
              }
            }
          }
          if (event.request?.data && typeof event.request.data === 'object') {
            for (const k of Object.keys(event.request.data)) {
              if (/(password|secret|token|apiKey|api_key)/i.test(k)) {
                event.request.data[k] = '[redacted]';
              }
            }
          }
        } catch {}
        return event;
      },
    });
    console.log('[sentry] initialized (node v8)');
  } catch (err) {
    console.warn('[sentry] not available:', err.message);
    Sentry = null;
  }
}

// v8 auto-captures HTTP context via OTel. Keep as no-op for interface compat.
function requestHandler() {
  return (req, _res, next) => next();
}

// Capture 5xx server errors, then forward to the next error middleware.
function errorHandler() {
  return (err, req, _res, next) => {
    const status = err.status || err.statusCode || 500;
    if (Sentry && status >= 500) {
      try {
        Sentry.captureException(err, {
          extra: {
            requestId: req.requestId,
            path: req.originalUrl,
            method: req.method,
          },
        });
      } catch {}
    }
    next(err);
  };
}

function captureException(err, context) {
  if (!Sentry) return;
  try { Sentry.captureException(err, context ? { extra: context } : undefined); } catch {}
}

function setUser(user) {
  if (!Sentry || !user) return;
  try { Sentry.setUser({ id: user.id, email: user.email }); } catch {}
}

async function flush(timeoutMs = 2000) {
  if (!Sentry) return;
  try { await Sentry.flush(timeoutMs); } catch {}
}

module.exports = { init, requestHandler, errorHandler, captureException, setUser, flush };

