/**
 * Dashboard Sentry wiring (browser SDK v8+).
 *
 * No-op unless REACT_APP_SENTRY_DSN is set at build time AND @sentry/react is
 * installed. We load the SDK from window.Sentry (via the official loader
 * script) to avoid bundling it when DSN is not set. To enable:
 *
 *   1. Add the Sentry JS loader <script> to public/index.html, or
 *   2. Install @sentry/react and swap `window.Sentry` for an import.
 */

let initialized = false;
let SentryRef = null;

export function initSentry() {
  if (initialized) return;
  initialized = true;
  const dsn = process.env.REACT_APP_SENTRY_DSN;
  if (!dsn) return;
  // Loaded lazily from the global if the loader script is present.
  if (typeof window !== 'undefined' && window.Sentry && typeof window.Sentry.init === 'function') {
    try {
      SentryRef = window.Sentry;
      SentryRef.init({
        dsn,
        environment: process.env.REACT_APP_SENTRY_ENV || process.env.NODE_ENV,
        release: process.env.REACT_APP_SENTRY_RELEASE || undefined,
        tracesSampleRate: parseFloat(process.env.REACT_APP_SENTRY_TRACES || '0.1'),
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: parseFloat(process.env.REACT_APP_SENTRY_REPLAY_ON_ERROR || '0'),
      });
    } catch {
      SentryRef = null;
    }
  }
}

export function captureException(err, extra) {
  if (!SentryRef) return;
  try { SentryRef.captureException(err, extra ? { extra } : undefined); } catch {}
}

export function setUser(user) {
  if (!SentryRef || !user) return;
  try { SentryRef.setUser({ id: user.id, email: user.email }); } catch {}
}

