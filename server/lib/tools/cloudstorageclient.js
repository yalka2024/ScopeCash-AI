const NAME = "CloudStorageClient";
const ENV_KEY = 'INTEGRATION_CLOUDSTORAGECLIENT_MODE';
const safety = require('../safety');
const crypto = require('crypto');
const path = require('path');
const storage = require('../storage');

const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Three-state capability status: 'mock' | 'live' | 'unimplemented'.
function status() {
  if (currentMode() === 'mock') return 'mock';
  return realImplemented ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — set ${ENV_KEY}=live to use the real ${NAME} (writes through lib/storage.js: local disk, S3, or GCS per STORAGE_DRIVER)`,
    input,
  };
}

/**
 * realRun — actually writes through lib/storage.js (whichever STORAGE_DRIVER
 * is configured: local disk, S3-compatible, or GCS) rather than computing a
 * fake signed-URL-shaped string with no backing object. Object path
 * validation and hashing are still done locally; the object itself is real.
 *
 * Inputs
 *   file_bytes   – Buffer | Uint8Array | base64 string | null/undefined
 *   object_path  – string, e.g. "receipts/2024/jan/invoice.pdf"
 *   content_type – MIME string, e.g. "application/pdf"
 *
 * Outputs
 *   signed_download_url – real signedDownloadUrl() from lib/storage.js
 *   storage_uri          – lib/storage.js key (gs://... on the GCS driver)
 *   size_bytes, sha256    – of the payload, when file_bytes was provided
 *   path_valid, errors
 */
async function realRun(input, ctx) {
  input = input || {};
  const errors = [];

  const rawPath = (input.object_path || '').trim();
  let objectPath = rawPath;
  let pathValid = false;
  if (!rawPath) {
    errors.push('object_path is required');
  } else {
    const normalised = path.posix.normalize(rawPath);
    if (normalised.startsWith('..') || normalised.startsWith('/') || normalised.includes('../') || /[<>:"\\|?*\x00-\x1f]/.test(rawPath)) {
      errors.push(`object_path "${rawPath}" failed validation (path traversal or illegal characters)`);
    } else {
      objectPath = normalised;
      pathValid = true;
    }
  }

  const contentType = (input.content_type || 'application/octet-stream').trim();

  let payloadBuffer = null;
  const rawBytes = input.file_bytes;
  if (rawBytes != null) {
    if (Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array) {
      payloadBuffer = Buffer.from(rawBytes);
    } else if (typeof rawBytes === 'string') {
      try { payloadBuffer = Buffer.from(rawBytes, 'base64'); } catch (e) { errors.push('file_bytes: base64 decode failed — ' + e.message); }
    } else {
      errors.push('file_bytes: unsupported type — must be Buffer, Uint8Array, or base64 string');
    }
  }

  if (!pathValid || errors.length > 0) {
    return { signed_download_url: null, storage_uri: null, size_bytes: null, sha256: null, content_type: contentType, object_path: objectPath, path_valid: pathValid, errors };
  }

  const orgId = (ctx && ctx.orgId) || 'default-org';
  const key = `${orgId}/${objectPath}`;

  let sizeBytes = null;
  let sha256Hex = null;
  let storageUri = null;
  let signedUrl = null;

  if (payloadBuffer) {
    sizeBytes = payloadBuffer.length;
    sha256Hex = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
    const put = await storage.putObject({ key, body: payloadBuffer, contentType });
    storageUri = storage.gcsUri(key) || `${put.provider}://${key}`;
    signedUrl = await storage.signedDownloadUrl(key, 300);
  }

  return {
    signed_upload_url: null, // writes go through putObject() above, not a client-side signed PUT — see follow-up in STATUS.md
    signed_download_url: signedUrl,
    storage_uri: storageUri,
    size_bytes: sizeBytes,
    sha256: sha256Hex,
    content_type: contentType,
    object_path: objectPath,
    path_valid: pathValid,
    errors,
  };
}

module.exports = {
  name: NAME,
  description: "Immutable evidence store with signed URL generation, path validation, and no public exposure.",
  inputs: ["file_bytes", "object_path", "content_type"],
  outputs: ["signed_upload_url", "signed_download_url", "storage_uri"],
  envKey: ENV_KEY,
  configKeys: [ENV_KEY],
  realImplemented,
  mode: currentMode,
  status,

  /**
   * @param {object} input  keyed by the declared input names
   * @param {object} ctx    { userId, orgId, modelId }
   * @returns {Promise<object>}
   */
  async run(input, ctx) {
    if (currentMode() === 'live') {
      safety.assertLiveAllowed(NAME);   // hard-block live mode on safety-gated platforms
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};
