/**
 * Field-level encryption helper (AES-256-GCM, versioned envelope).
 *
 * Used to satisfy DATA-005 / SOC 2 CC6.1 / ISO 27001 A.10.1 — sensitive
 * personal data (lead emails, free-text use-case descriptions, KYC fields,
 * etc.) is encrypted at rest with a key never persisted in the database.
 *
 * Envelope format (string, URL-safe-ish):
 *   v1:<base64url(iv12)>:<base64url(tag16)>:<base64url(ciphertext)>
 *
 * Keys (must be 32 raw bytes; supply as base64 *or* 64-char hex):
 *   ENCRYPTION_KEY         — primary encryption/decryption key
 *   ENCRYPTION_KEY_OLD     — optional, for key rotation. decrypt() falls back
 *                            to this if the primary key fails the GCM tag.
 *   ENCRYPTION_SEARCH_KEY  — HMAC-SHA256 key used by `searchHash()` to make
 *                            equality lookups against encrypted columns
 *                            possible (deterministic, irreversible).
 *
 * Boot-time guard: in production we refuse to start without a real
 * ENCRYPTION_KEY. In non-prod we synthesise one from JWT_SECRET so that
 * generated platforms run out-of-the-box for local dev (DO NOT use in prod).
 */
const crypto = require('crypto');

const VERSION = 'v1';
const IV_LEN  = 12;   // GCM standard
const TAG_LEN = 16;
const KEY_LEN = 32;   // AES-256

function _decodeKey(raw, label) {
  if (!raw) return null;
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
  }
  if (!buf || buf.length !== KEY_LEN) {
    throw new Error(`[encryption] ${label} must be 32 bytes (provide as 64-char hex or 44-char base64); got ${buf ? buf.length : 0} bytes`);
  }
  return buf;
}

function _deriveDevKey(seed, salt) {
  // Deterministic, dev-only fallback so generated platforms boot without
  // requiring the operator to mint keys before first run. NEVER hits prod
  // because of the guard below.
  return crypto.scryptSync(String(seed || 'dev-seed'), salt, KEY_LEN);
}

let PRIMARY_KEY = null;
let OLD_KEY     = null;
let SEARCH_KEY  = null;

function _initKeys() {
  PRIMARY_KEY = _decodeKey(process.env.ENCRYPTION_KEY,     'ENCRYPTION_KEY');
  OLD_KEY     = _decodeKey(process.env.ENCRYPTION_KEY_OLD, 'ENCRYPTION_KEY_OLD');
  SEARCH_KEY  = _decodeKey(process.env.ENCRYPTION_SEARCH_KEY, 'ENCRYPTION_SEARCH_KEY');

  const isProd = process.env.NODE_ENV === 'production';
  if (!PRIMARY_KEY) {
    if (isProd) {
      throw new Error('[encryption] ENCRYPTION_KEY is required in production. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    }
    PRIMARY_KEY = _deriveDevKey(process.env.JWT_SECRET, 'enc-dev-salt');
  }
  if (!SEARCH_KEY) {
    if (isProd) {
      throw new Error('[encryption] ENCRYPTION_SEARCH_KEY is required in production for searchable encrypted columns.');
    }
    SEARCH_KEY = _deriveDevKey(process.env.JWT_SECRET, 'search-dev-salt');
  }
}

_initKeys();

/**
 * Encrypt a UTF-8 string. Returns the envelope string. `null` / `undefined`
 * inputs pass through unchanged so callers can use this on optional fields.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', PRIMARY_KEY, iv);
  const ct     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * Decrypt an envelope string back to UTF-8. Returns the input unchanged when
 * it does not match the envelope format (so legacy plaintext rows can be
 * read transparently during a migration).
 */
function decrypt(envelope) {
  if (envelope === null || envelope === undefined) return envelope;
  if (typeof envelope !== 'string') return envelope;
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return envelope; // not encrypted
  const [, ivB, tagB, ctB] = parts;
  const iv  = Buffer.from(ivB,  'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const ct  = Buffer.from(ctB,  'base64url');
  for (const key of [PRIMARY_KEY, OLD_KEY].filter(Boolean)) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    } catch (_) { /* try next key */ }
  }
  throw new Error('[encryption] decrypt failed: GCM auth tag invalid for all known keys');
}

/**
 * Deterministic search hash for equality lookups against encrypted columns.
 * Uses HMAC-SHA256 with a separate key so disclosure of the search index
 * does not weaken the encryption key, and so an attacker cannot brute-force
 * the plaintext with a public hash function.
 */
function searchHash(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const norm = String(plaintext).trim().toLowerCase();
  return crypto.createHmac('sha256', SEARCH_KEY).update(norm).digest('base64url');
}

/** Helper for objects: encrypt the named string fields in-place. */
function encryptFields(obj, fields) {
  if (!obj) return obj;
  for (const f of fields) {
    if (obj[f] !== undefined && obj[f] !== null) obj[f] = encrypt(obj[f]);
  }
  return obj;
}

/** Helper for objects: decrypt the named string fields in-place. */
function decryptFields(obj, fields) {
  if (!obj) return obj;
  for (const f of fields) {
    if (obj[f] !== undefined && obj[f] !== null) {
      try { obj[f] = decrypt(obj[f]); } catch (_) { /* leave as-is */ }
    }
  }
  return obj;
}

// Self-test on require — fails fast if envelope/round-trip ever regresses.
(function selfTest() {
  const sample = 'jane.doe+test@example.com — \u20ac€ unicode ✓';
  const env = encrypt(sample);
  const out = decrypt(env);
  if (out !== sample) {
    throw new Error('[encryption] self-test failed: round-trip mismatch');
  }
  if (decrypt(null) !== null || decrypt('plain text') !== 'plain text') {
    throw new Error('[encryption] self-test failed: passthrough behaviour broken');
  }
  if (searchHash('Foo@Bar.com') !== searchHash(' foo@bar.com ')) {
    throw new Error('[encryption] self-test failed: searchHash not deterministic across normalisation');
  }
})();

module.exports = {
  encrypt,
  decrypt,
  searchHash,
  encryptFields,
  decryptFields,
  // Exposed so ops scripts (key-rotation drills) can re-init after env reload.
  _reload: _initKeys,
};

