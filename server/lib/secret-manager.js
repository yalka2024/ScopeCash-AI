/**
 * Real Google Secret Manager client (replaces the SecretManagerClient mock,
 * which threw "not implemented" in live mode). ADC auth, same credential
 * resolution as lib/vertex-ai.js — no key file handling here.
 *
 * Short in-process TTL cache so a hot path doesn't call the API on every
 * request; NOT a substitute for real secret rotation — callers that need a
 * rotated secret immediately should call _clearCache() after rotating.
 */
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const PROJECT = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null;
const CACHE_TTL_MS = parseInt(process.env.SECRET_CACHE_TTL_MS || '300000', 10); // 5 min

function isConfigured() {
  return !!PROJECT;
}

let _client = null;
function client() {
  if (!isConfigured()) {
    throw Object.assign(new Error('Secret Manager is not configured: set GCP_PROJECT_ID.'), { code: 'secret_manager_unconfigured' });
  }
  if (!_client) _client = new SecretManagerServiceClient();
  return _client;
}

const cache = new Map(); // "secretId:version" -> { value, expiresAt }

/** @returns {Promise<string>} the secret's plaintext payload */
async function getSecret(secretId, version = 'latest') {
  if (!secretId) throw new Error('getSecret: secretId is required');
  const cacheKey = `${secretId}:${version}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const c = client();
  const name = `projects/${PROJECT}/secrets/${secretId}/versions/${version}`;
  const [response] = await c.accessSecretVersion({ name });
  const value = response.payload.data.toString('utf8');
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function _clearCache() { cache.clear(); }

module.exports = { isConfigured, getSecret, _clearCache, PROJECT };
