/**
 * OAuth 2.0 server (Tier 16 — Marketplace).
 *
 * Allows third-party apps registered as OAuthApp rows to obtain delegated
 * access to a ScopeCash AI user's data. Implements:
 *
 *   - authorization_code grant (with PKCE recommended)
 *   - refresh_token grant
 *   - opaque tokens stored in OAuthGrant (hashed)
 *
 * Scopes are the same strings as ApiKey scopes ('read', 'write', 'admin').
 *
 * NOTE: token endpoints below are deliberately minimal. For production,
 * integrate with a battle-tested library (oauth2-server / @node-oauth/oauth2-server).
 */
const crypto = require('crypto');
const prisma = require('./prisma');

const ACCESS_TTL_MS  = 60 * 60 * 1000;          // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS    = 10 * 60 * 1000;           // 10 min

function _randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function _hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function registerApp({ orgId, name, redirectUris = [], scopes = 'read', description = null, ownerUserId = null }) {
  if (!name || typeof name !== 'string') throw new Error('app_name_required');
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) throw new Error('redirect_uris_required');
  const clientId = _randomToken(16);
  const clientSecret = _randomToken(32);
  const app = await prisma.oAuthApp.create({
    data: {
      clientId,
      clientSecretHash: _hash(clientSecret),
      name: name.slice(0, 120),
      description: description ? description.slice(0, 500) : null,
      redirectUris: redirectUris.join('\n').slice(0, 2000),
      scopes: scopes.slice(0, 200),
      orgId: orgId || null,
      ownerUserId: ownerUserId || null,
    },
  });
  return { app, clientSecret }; // return secret once
}

async function listApps({ orgId } = {}) {
  const where = orgId ? { orgId } : {};
  return prisma.oAuthApp.findMany({ where, orderBy: { createdAt: 'desc' } }).catch(() => []);
}

async function deleteApp(clientId) {
  await prisma.oAuthApp.deleteMany({ where: { clientId } }).catch(() => {});
}

async function getApp(clientId) {
  return prisma.oAuthApp.findUnique({ where: { clientId } }).catch(() => null);
}

function _validRedirect(app, redirectUri) {
  const list = (app.redirectUris || '').split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean);
  return list.includes(redirectUri);
}

/**
 * Step 1: User has authenticated and approved scopes. Issue a one-time code.
 */
async function issueCode({ clientId, userId, redirectUri, scopes, codeChallenge = null, codeChallengeMethod = null }) {
  const app = await getApp(clientId);
  if (!app) throw new Error('unknown_client');
  if (!_validRedirect(app, redirectUri)) throw new Error('invalid_redirect');
  const code = _randomToken(24);
  await prisma.oAuthGrant.create({
    data: {
      grantType: 'code',
      tokenHash: _hash(code),
      clientId, userId, scopes: scopes || app.scopes,
      redirectUri,
      codeChallenge, codeChallengeMethod,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

/**
 * Step 2: Exchange code for access + refresh tokens.
 */
async function exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier = null }) {
  const app = await getApp(clientId);
  if (!app) throw new Error('unknown_client');
  if (app.clientSecretHash !== _hash(clientSecret || '')) throw new Error('invalid_client_secret');
  const grant = await prisma.oAuthGrant.findFirst({
    where: { grantType: 'code', tokenHash: _hash(code), clientId },
  });
  if (!grant) throw new Error('invalid_code');
  if (grant.consumedAt) throw new Error('code_already_used');
  if (grant.expiresAt && grant.expiresAt.getTime() < Date.now()) throw new Error('code_expired');
  if (grant.redirectUri !== redirectUri) throw new Error('redirect_mismatch');
  if (grant.codeChallenge) {
    if (!codeVerifier) throw new Error('pkce_verifier_required');
    let derived;
    if (grant.codeChallengeMethod === 'S256') {
      derived = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    } else {
      derived = codeVerifier;
    }
    if (derived !== grant.codeChallenge) throw new Error('pkce_mismatch');
  }
  await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { consumedAt: new Date() } });

  const accessToken  = _randomToken(32);
  const refreshToken = _randomToken(32);
  const now = new Date();
  await prisma.oAuthGrant.createMany({ data: [
    { grantType: 'access',  tokenHash: _hash(accessToken),  clientId, userId: grant.userId, scopes: grant.scopes, expiresAt: new Date(now.getTime() + ACCESS_TTL_MS) },
    { grantType: 'refresh', tokenHash: _hash(refreshToken), clientId, userId: grant.userId, scopes: grant.scopes, expiresAt: new Date(now.getTime() + REFRESH_TTL_MS) },
  ]});
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: grant.scopes,
  };
}

async function refreshTokens({ refreshToken, clientId, clientSecret }) {
  const app = await getApp(clientId);
  if (!app) throw new Error('unknown_client');
  if (app.clientSecretHash !== _hash(clientSecret || '')) throw new Error('invalid_client_secret');
  const grant = await prisma.oAuthGrant.findFirst({
    where: { grantType: 'refresh', tokenHash: _hash(refreshToken), clientId },
  });
  if (!grant) throw new Error('invalid_refresh');
  if (grant.expiresAt && grant.expiresAt.getTime() < Date.now()) throw new Error('refresh_expired');
  const accessToken = _randomToken(32);
  await prisma.oAuthGrant.create({
    data: { grantType: 'access', tokenHash: _hash(accessToken), clientId, userId: grant.userId, scopes: grant.scopes, expiresAt: new Date(Date.now() + ACCESS_TTL_MS) },
  });
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: grant.scopes,
  };
}

async function verifyAccessToken(accessToken) {
  const grant = await prisma.oAuthGrant.findFirst({
    where: { grantType: 'access', tokenHash: _hash(accessToken) },
  }).catch(() => null);
  if (!grant) return null;
  if (grant.expiresAt && grant.expiresAt.getTime() < Date.now()) return null;
  return { userId: grant.userId, clientId: grant.clientId, scopes: grant.scopes };
}

async function revokeToken(token) {
  await prisma.oAuthGrant.deleteMany({ where: { tokenHash: _hash(token) } }).catch(() => {});
}

module.exports = {
  registerApp, listApps, deleteApp, getApp,
  issueCode, exchangeCode, refreshTokens, verifyAccessToken, revokeToken,
};

