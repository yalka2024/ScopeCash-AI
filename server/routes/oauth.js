/**
 * OAuth 2.0 endpoints (Tier 16).
 *
 *   GET  /oauth/authorize  — authorization endpoint (consents the user)
 *   POST /oauth/token      — token endpoint (authorization_code + refresh_token)
 *   POST /oauth/revoke     — token revocation
 *
 * The authorize endpoint here is a JSON-only consent stub: in production
 * the dashboard renders a consent screen and POSTs to /api/marketplace/oauth-consent.
 */
const express = require('express');
const oauthApps = require('../lib/oauth-apps');
const { authMiddleware } = require('../middleware/auth');
const { z, validate, asyncHandler } = require('../lib/validate');
const { audit } = require('../lib/audit');

const router = express.Router();

// Authorize — requires the user to be logged in to ScopeCash AI.
const AuthorizeSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.literal('code'),
  scope: z.string().optional(),
  state: z.string().max(200).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.enum(['plain', 'S256']).optional(),
});

router.get('/authorize', authMiddleware, validate(AuthorizeSchema, 'query'), asyncHandler(async (req, res) => {
  const q = req.query;
  const app = await oauthApps.getApp(q.client_id);
  if (!app) return res.status(400).json({ error: 'invalid_client' });
  // In a real UI, render consent screen. For headless flow, auto-approve.
  const code = await oauthApps.issueCode({
    clientId: q.client_id,
    userId: req.user.id,
    redirectUri: q.redirect_uri,
    scopes: q.scope || app.scopes,
    codeChallenge: q.code_challenge || null,
    codeChallengeMethod: q.code_challenge_method || null,
  });
  await audit(req, 'oauth.authorize.granted', { resource: 'oauth_client', resourceId: q.client_id, details: { scope: q.scope || app.scopes } });
  const url = new URL(q.redirect_uri);
  url.searchParams.set('code', code);
  if (q.state) url.searchParams.set('state', q.state);
  res.redirect(url.toString());
}));

const TokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    redirect_uri: z.string().url(),
    code_verifier: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }),
]);
router.post('/token', validate(TokenSchema), asyncHandler(async (req, res) => {
  try {
    if (req.body.grant_type === 'authorization_code') {
      const { _userId, ...tokens } = await oauthApps.exchangeCode({
        code: req.body.code,
        clientId: req.body.client_id,
        clientSecret: req.body.client_secret,
        redirectUri: req.body.redirect_uri,
        codeVerifier: req.body.code_verifier || null,
      });
      await audit(req, 'oauth.token.issued', { userId: _userId, resource: 'oauth_client', resourceId: req.body.client_id, details: { grantType: 'authorization_code' } });
      return res.json(tokens);
    }
    const { _userId, ...tokens } = await oauthApps.refreshTokens({
      refreshToken: req.body.refresh_token,
      clientId: req.body.client_id,
      clientSecret: req.body.client_secret,
    });
    await audit(req, 'oauth.token.issued', { userId: _userId, resource: 'oauth_client', resourceId: req.body.client_id, details: { grantType: 'refresh_token' } });
    res.json(tokens);
  } catch (err) {
    res.status(400).json({ error: err.message || 'invalid_request' });
  }
}));

const RevokeSchema = z.object({
  token: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});
router.post('/revoke', validate(RevokeSchema), asyncHandler(async (req, res) => {
  let result;
  try {
    result = await oauthApps.revokeToken({ token: req.body.token, clientId: req.body.client_id, clientSecret: req.body.client_secret });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'invalid_client' });
  }
  await audit(req, 'oauth.token.revoked', { userId: result.userId, resource: 'oauth_client', resourceId: req.body.client_id, details: { revokedCount: result.revokedCount } });
  res.json({ revoked: true });
}));

module.exports = router;

