/**
 * Token, password & MFA utilities.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const ACCESS_TTL  = process.env.ACCESS_TOKEN_TTL  || '15m';
const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '14', 10);

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, orgId: user.orgId, ver: 'v2' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL, issuer: 'scopecash-ai', audience: 'scopecash-ai-api' }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, {
    issuer: 'scopecash-ai', audience: 'scopecash-ai-api'
  });
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiry() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS());
}
function REFRESH_TOKEN_TTL_MS() { return REFRESH_TTL_DAYS * 86400000; }

// ── Password policy: min 12 chars, mixed case, digit, symbol ──
const PASSWORD_RX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 12) return 'Password must be at least 12 characters';
  if (!PASSWORD_RX.test(pw)) return 'Password must contain upper, lower, digit and symbol';
  return null;
}
async function hashPassword(pw) { return bcrypt.hash(pw, 12); }
async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

// ── Account lockout config ──
const MAX_FAILED = parseInt(process.env.LOGIN_MAX_FAILED || '8', 10);
const LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10);
function lockoutFor() { return new Date(Date.now() + LOCK_MINUTES * 60000); }

// ── TOTP (RFC 6238) implemented with Node crypto so we don't add otplib ──
function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/=+$/g, '').toUpperCase();
  const out = []; let bits = 0, value = 0;
  for (const c of str) {
    const i = alphabet.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateMfaSecret() {
  return base32Encode(crypto.randomBytes(20));
}
function totpAt(secretB32, time = Math.floor(Date.now() / 1000), step = 30, digits = 6) {
  const counter = Math.floor(time / step);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
             | (hmac[offset + 2] << 8)  |  hmac[offset + 3];
  return String(code % (10 ** digits)).padStart(digits, '0');
}
function verifyTotp(secretB32, token) {
  if (!token || !/^\d{6}$/.test(token)) return false;
  const now = Math.floor(Date.now() / 1000);
  for (const d of [-1, 0, 1]) {
    if (totpAt(secretB32, now + d * 30) === token) return true;
  }
  return false;
}
function otpauthUrl(secretB32, label, issuer = 'ScopeCash AI') {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secretB32}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  signAccessToken, verifyAccessToken,
  generateRefreshToken, hashToken, refreshExpiry, REFRESH_TOKEN_TTL_MS,
  validatePassword, hashPassword, verifyPassword,
  MAX_FAILED, lockoutFor,
  generateMfaSecret, verifyTotp, otpauthUrl,
};

