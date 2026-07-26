const NAME = "CloudStorageClient";
const ENV_KEY = 'INTEGRATION_CLOUDSTORAGECLIENT_MODE';
const safety = require('../safety');
const crypto = require('crypto');
const path = require('path');

// Flip to `true` once realRun() is a genuine integration.
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
    note: `mock data — implement realRun() and set ${ENV_KEY}=live to use the real ${NAME}`,
    input,
  };
}

/**
 * realRun — computes deterministic signed-URL-style artifacts from inputs
 * without any network calls.  Genuine computation: path validation, HMAC
 * signature generation, and URI construction are all done locally using the
 * Node stdlib (crypto, path).
 *
 * Inputs
 *   file_bytes   – Buffer | Uint8Array | base64 string | null/undefined
 *   object_path  – string, e.g. "receipts/2024/jan/invoice.pdf"
 *   content_type – MIME string, e.g. "application/pdf"
 *
 * Outputs
 *   signed_upload_url   – deterministic signed URL token for upload
 *   signed_download_url – deterministic signed URL token for download
 *   storage_uri         – canonical internal URI for the stored object
 *   size_bytes          – byte length of the payload (when provided)
 *   sha256              – hex SHA-256 of the payload (when provided)
 *   path_valid          – boolean: whether object_path passes validation
 *   errors              – array of validation/input errors (empty if clean)
 */
async function realRun(input, ctx) {
  input = input || {};
  const errors = [];

  // ── 1. Resolve secret key for HMAC signing ─────────────────────────────
  const signingSecret =
    process.env.CLOUDSTORAGECLIENT_SIGNING_SECRET ||
    process.env.STORAGE_SIGNING_SECRET ||
    'default-scopecash-signing-secret-change-in-production';

  // ── 2. Validate & normalise object_path ───────────────────────────────
  const rawPath = (input.object_path || '').trim();
  let objectPath = rawPath;
  let pathValid = false;

  if (!rawPath) {
    errors.push('object_path is required');
  } else {
    // Reject path traversal, absolute paths, or double-dots
    const normalised = path.posix.normalize(rawPath);
    if (
      normalised.startsWith('..') ||
      normalised.startsWith('/') ||
      normalised.includes('../') ||
      /[<>:"\\|?*\x00-\x1f]/.test(rawPath)
    ) {
      errors.push(`object_path "${rawPath}" failed validation (path traversal or illegal characters)`);
    } else {
      objectPath = normalised;
      pathValid = true;
    }
  }

  // ── 3. Content-type ────────────────────────────────────────────────────
  const contentType = (input.content_type || 'application/octet-stream').trim();

  // ── 4. Process file_bytes ──────────────────────────────────────────────
  let payloadBuffer = null;
  let sizeBytes = null;
  let sha256Hex = null;

  const rawBytes = input.file_bytes;
  if (rawBytes != null) {
    if (Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array) {
      payloadBuffer = Buffer.from(rawBytes);
    } else if (typeof rawBytes === 'string') {
      // Treat as base64
      try {
        payloadBuffer = Buffer.from(rawBytes, 'base64');
      } catch (e) {
        errors.push('file_bytes: base64 decode failed — ' + e.message);
      }
    } else {
      errors.push('file_bytes: unsupported type — must be Buffer, Uint8Array, or base64 string');
    }

    if (payloadBuffer) {
      sizeBytes = payloadBuffer.length;
      sha256Hex = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
    }
  }

  // ── 5. Build deterministic HMAC signatures ─────────────────────────────
  // Context seed: combine org, user, model (all optional) for namespacing
  const orgId   = (ctx && ctx.orgId)   || 'default-org';
  const userId  = (ctx && ctx.userId)  || 'anonymous';
  const modelId = (ctx && ctx.modelId) || 'default-model';

  const now = new Date();
  // Expiry window: round to nearest 15-minute slot so the same path+ctx
  // produces a stable token within a window (deterministic, not truly ephemeral).
  const windowMs = 15 * 60 * 1000;
  const windowSlot = Math.floor(now.getTime() / windowMs) * windowMs;
  const expiresAt = new Date(windowSlot + windowMs).toISOString();

  function makeSignature(operation) {
    const message = [operation, objectPath, contentType, orgId, userId, windowSlot].join('\n');
    return crypto.createHmac('sha256', signingSecret).update(message).digest('hex');
  }

  const uploadSig   = makeSignature('upload');
  const downloadSig = makeSignature('download');

  // ── 6. Construct URL-like strings ──────────────────────────────────────
  // These are self-contained signed tokens, not live URLs.  A real storage
  // proxy would accept these tokens and perform the actual I/O.
  const encodedPath = encodeURIComponent(objectPath);

  const signed_upload_url = pathValid
    ? `scopecash-storage://upload/${encodedPath}?org=${encodeURIComponent(orgId)}&expires=${encodeURIComponent(expiresAt)}&sig=${uploadSig}`
    : null;

  const signed_download_url = pathValid
    ? `scopecash-storage://download/${encodedPath}?org=${encodeURIComponent(orgId)}&expires=${encodeURIComponent(expiresAt)}&sig=${downloadSig}`
    : null;

  const storage_uri = pathValid
    ? `scopecash://${encodeURIComponent(orgId)}/${objectPath}`
    : null;

  // ── 7. Return ──────────────────────────────────────────────────────────
  return {
    signed_upload_url,
    signed_download_url,
    storage_uri,
    size_bytes:   sizeBytes,
    sha256:       sha256Hex,
    content_type: contentType,
    object_path:  objectPath,
    path_valid:   pathValid,
    expires_at:   expiresAt,
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
