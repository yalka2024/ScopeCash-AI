/**
 * HTTP integration adapter: OpenAPISpecExporter
 * Generates and serves self-documenting OpenAPI 3.1 spec for all REST API endpoints with pagination, tenant scoping, and stable error formats.
 *
 * Generated for ScopeCash AI (Phase 3 — real reference adapter).
 *
 * realRun() makes a REAL HTTP request — no SDK/deps, uses global fetch. It's
 * credential-gated: set the base URL (and optional API key) and flip to live:
 *     OPENAPISPECEXPORTER_BASE_URL=https://api.example.com/...   (OPENAPISPECEXPORTER_API_KEY=...)
 *     INTEGRATION_OPENAPISPECEXPORTER_MODE=live
 * Until a base URL is set, live mode REFUSES (501) rather than fake a result.
 */
const NAME = "OpenAPISpecExporter";
const ENV_KEY = 'INTEGRATION_OPENAPISPECEXPORTER_MODE';
const BASE_URL_KEY = 'OPENAPISPECEXPORTER_BASE_URL';
const API_KEY_KEY = 'OPENAPISPECEXPORTER_API_KEY';
const safety = require('../safety');
const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

function status() {
  if (currentMode() === 'mock') return 'mock';
  return process.env[BASE_URL_KEY] ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — set ${BASE_URL_KEY} and ${ENV_KEY}=live to call the real ${NAME}`,
    input,
  };
}

async function realRun(input, ctx) {
  const base = process.env[BASE_URL_KEY];
  if (!base) {
    const e = new Error(`${NAME}: ${BASE_URL_KEY} is not set — cannot call the real API (use ${ENV_KEY}=mock for demo data).`);
    e.statusCode = 501; e.code = 'integration_unconfigured';
    throw e;
  }
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (process.env[API_KEY_KEY]) headers['Authorization'] = `Bearer ${process.env[API_KEY_KEY]}`;
  const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(input || {}) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const e = new Error(`${NAME}: upstream responded ${res.status}`);
    e.statusCode = res.status; e.code = 'integration_upstream_error'; e.data = data;
    throw e;
  }
  return { ok: true, status: res.status, data };
}

module.exports = {
  name: NAME,
  description: "Generates and serves self-documenting OpenAPI 3.1 spec for all REST API endpoints with pagination, tenant scoping, and stable error formats.",
  inputs: ["route_registry"],
  outputs: ["openapi_json", "openapi_yaml"],
  envKey: ENV_KEY,
  configKeys: [ENV_KEY, BASE_URL_KEY, API_KEY_KEY],
  realImplemented,
  mode: currentMode,
  status,
  async run(input, ctx) {
    if (currentMode() === 'live') {
      safety.assertLiveAllowed(NAME);   // hard-block live mode on safety-gated platforms
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};

