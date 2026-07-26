const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { verifyAccessToken } = require('../lib/security');

const ACCESS_COOKIE = 'access_token';

async function authMiddleware(req, res, next) {
  try {
    let token = null;
    let authMode = null;

    // 1. Cookie-based session (browser, default)
    if (req.cookies && req.cookies[ACCESS_COOKIE]) {
      token = req.cookies[ACCESS_COOKIE];
      authMode = 'cookie';
    }

    const authHeader = req.headers.authorization || '';
    // 2. Bearer token (machine-to-machine; scoped same as user)
    if (!token && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
      authMode = 'bearer';
    }

    if (token) {
      const decoded = verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user) return res.status(401).json({ error: 'User not found', code: 'auth_invalid' });
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return res.status(423).json({ error: 'Account locked', code: 'auth_locked' });
      }
      req.user = { id: user.id, email: user.email, role: user.role, orgId: user.orgId, mfaEnabled: user.mfaEnabled, emailVerified: user.emailVerified };
      req.authMode = authMode;
      req.authScopes = ['*']; // user session = full scope
      return next();
    }

    // 3. API key
    if (authHeader.startsWith('ApiKey ')) {
      const key = authHeader.slice(7);
      const prefix = key.slice(0, 8);
      const keyHash = crypto.createHash('sha256').update(key).digest('hex');
      const apiKey = await prisma.apiKey.findFirst({ where: { keyHash, prefix, active: true } });
      if (!apiKey) return res.status(401).json({ error: 'Invalid API key', code: 'auth_invalid_key' });
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return res.status(401).json({ error: 'API key expired', code: 'auth_key_expired' });
      }
      const user = await prisma.user.findUnique({ where: { id: apiKey.userId } });
      if (!user) return res.status(401).json({ error: 'User not found', code: 'auth_invalid' });

      // fire-and-forget last-used update (don't block request)
      prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});

      req.user = { id: user.id, email: user.email, role: user.role, orgId: user.orgId };
      req.authMode = 'apikey';
      req.authScopes = (apiKey.scopes || 'read').split(/[,\s]+/).filter(Boolean);
      req.apiKeyId = apiKey.id;
      return next();
    }

    return res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token', code: 'auth_invalid' });
    }
    next(err);
  }
}

// Scope guard for API-key endpoints. Cookie/Bearer sessions have '*'.
function requireScope(...needed) {
  return (req, res, next) => {
    const scopes = req.authScopes || [];
    if (scopes.includes('*')) return next();
    for (const n of needed) {
      if (scopes.includes(n)) return next();
    }
    return res.status(403).json({ error: `Missing scope: ${needed.join(' or ')}`, code: 'scope_required' });
  };
}

module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;
module.exports.requireScope = requireScope;
module.exports.ACCESS_COOKIE = ACCESS_COOKIE;

