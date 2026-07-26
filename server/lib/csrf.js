/**
 * CSRF protection — double-submit cookie pattern.
 * Stateless: signed CSRF cookie + matching X-CSRF-Token header on
 * unsafe methods. Skipped for Bearer/ApiKey requests (those auth
 * methods are not browser-cookie-driven).
 */
const crypto = require('crypto');

const COOKIE_NAME = 'csrf';
const HEADER_NAME = 'x-csrf-token';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function newToken() { return crypto.randomBytes(32).toString('base64url'); }

function issueCsrfCookie(req, res, next) {
  if (!req.cookies || !req.cookies[COOKIE_NAME]) {
    const t = newToken();
    res.cookie(COOKIE_NAME, t, {
      httpOnly: false,                     // intentional: JS must read it to echo it
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    req.csrfToken = t;
  } else {
    req.csrfToken = req.cookies[COOKIE_NAME];
  }
  next();
}

function csrfProtect(req, res, next) {
  if (SAFE.has(req.method)) return next();
  // Skip if request is using a non-cookie auth scheme.
  const authz = req.headers.authorization || '';
  if (authz.startsWith('Bearer ') || authz.startsWith('ApiKey ')) return next();

  const cookie = req.cookies && req.cookies[COOKIE_NAME];
  const header = req.headers[HEADER_NAME];
  if (!cookie || !header) return res.status(403).json({ error: 'CSRF token missing' });

  const a = Buffer.from(cookie); const b = Buffer.from(header);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }
  next();
}

module.exports = { issueCsrfCookie, csrfProtect, COOKIE_NAME, HEADER_NAME };

