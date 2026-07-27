/**
 * Cloud Logging structured-field support.
 *
 * The app already logs JSON to stdout, which Cloud Run ingests — but as an
 * opaque `jsonPayload`. Cloud Logging special-cases a handful of field names,
 * and without them the logs are much less useful than they look:
 *
 *   severity                          - every line was ingested as DEFAULT, so
 *                                       "show me errors" and any severity-based
 *                                       alert policy matched nothing.
 *   logging.googleapis.com/trace      - no correlation with Cloud Trace, so a
 *   logging.googleapis.com/spanId       slow request could not be tied to its
 *                                       own log lines.
 *   httpRequest                       - method/status/latency render as a real
 *                                       request row in the Logs Explorer and
 *                                       feed request-based metrics, instead of
 *                                       being ordinary payload keys.
 *
 * All of it is additive: the original fields stay, so existing log-reading
 * (including the local `type:` convention this codebase greps for) is
 * unchanged, and nothing here depends on running on GCP. Off-GCP the trace
 * fields are simply absent.
 *
 * Deliberately no @google-cloud/logging dependency: writing correctly-shaped
 * JSON to stdout is Google's own documented approach for Cloud Run and avoids
 * a client library, its credentials, and its buffering on the request path.
 */

const PROJECT_ID = () => process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null;

/** Map an HTTP status to a Cloud Logging severity. */
function severityForStatus(status) {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARNING';
  return 'INFO';
}

/**
 * Parse Cloud Run's X-Cloud-Trace-Context: "TRACE_ID/SPAN_ID;o=1".
 * Returns {} when absent or malformed, or when no project id is known —
 * a trace field without the correct project prefix is silently ignored by
 * Cloud Logging, so emitting a half-formed one has no value.
 */
function traceFields(req) {
  const project = PROJECT_ID();
  const header = req && req.headers && req.headers['x-cloud-trace-context'];
  if (!project || !header) return {};
  const [traceId, rest] = String(header).split('/');
  if (!traceId) return {};
  const out = { 'logging.googleapis.com/trace': `projects/${project}/traces/${traceId}` };
  const spanId = rest ? String(rest).split(';')[0] : null;
  if (spanId) out['logging.googleapis.com/spanId'] = spanId;
  return out;
}

/** The Cloud Logging `httpRequest` object for a finished request. */
function httpRequestField(req, res, ms) {
  return {
    requestMethod: req.method,
    requestUrl: req.originalUrl,
    status: res.statusCode,
    latency: `${(ms / 1000).toFixed(3)}s`,
    userAgent: req.headers['user-agent'],
    remoteIp: req.ip,
    protocol: req.protocol,
  };
}

/** Build the access-log line for a finished request. */
function accessLogEntry(req, res, ms) {
  return {
    severity: severityForStatus(res.statusCode),
    // Original shape preserved — existing tooling greps on `type`.
    type: 'http',
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status: res.statusCode,
    ms,
    httpRequest: httpRequestField(req, res, ms),
    ...traceFields(req),
  };
}

module.exports = { accessLogEntry, severityForStatus, traceFields, httpRequestField };
