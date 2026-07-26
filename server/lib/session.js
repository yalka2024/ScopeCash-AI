/**
 * Session helper — extracted so the auth router and the first-run setup
 * route share a single implementation.
 *
 * `issueSession(res, user, req)` mints a short-lived access JWT (15 min) and
 * a long-lived rotated refresh token (family-tracked for reuse detection),
 * persists the refresh row, and writes both cookies as HttpOnly + SameSite=lax.
 */
const crypto = require('crypto');
const prisma = require('./prisma');
const {
  signAccessToken, generateRefreshToken, hashToken, refreshExpiry,
} = require('./security');
const { ACCESS_COOKIE } = require('../middleware/auth');

const REFRESH_COOKIE = 'refresh_token';

function cookieOpts(maxAgeMs) {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   maxAgeMs,
  };
}

async function issueSession(res, user, req) {
  const access  = signAccessToken(user);
  const refresh = generateRefreshToken();
  const family  = crypto.randomUUID();
  const expiresAt = refreshExpiry();
  await prisma.refreshToken.create({ data: {
    userId:    user.id,
    tokenHash: hashToken(refresh),
    family,
    expiresAt,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || null,
  }});
  res.cookie(ACCESS_COOKIE,  access,  cookieOpts(15 * 60_000));
  res.cookie(REFRESH_COOKIE, refresh, cookieOpts(expiresAt - Date.now()));
  return { access };
}

module.exports = { issueSession, ACCESS_COOKIE, REFRESH_COOKIE, cookieOpts };

