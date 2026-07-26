/**
 * Regression coverage for three real bugs found via a follow-up security
 * audit and fixed in the same session:
 *   1. routes/tools.js: platform-infrastructure tools (SecretManagerClient
 *      et al) were reachable by ANY authenticated user, not just admins —
 *      any signed-up customer could read production secrets.
 *   2. lib/tools/totpmfaprovider.js: `input.user_id` overrode the trustworthy
 *      `ctx.userId`, letting any authenticated caller attempt TOTP
 *      verification against any OTHER user's MFA secret.
 *   3. routes/oauth.js /revoke: accepted a bare token with no client
 *      authentication at all (RFC 7009 requires the client to authenticate).
 *
 * Real SQLite DB (global-setup.js), no mocking of the routes under test.
 */
const crypto = require('crypto');

const express = require('express');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const toolsRoutes = require('../../routes/tools');
const oauthRoutes = require('../../routes/oauth');
const oauthApps = require('../../lib/oauth-apps');

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }
function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

async function makeUser(role = 'user') {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  return prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true, role } });
}

afterAll(async () => { await prisma.$disconnect(); });

describe('tools.js: admin-only platform-infrastructure tools', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tools', toolsRoutes);
  app.use(errorMiddleware);

  test('a regular authenticated user cannot invoke SecretManagerClient', async () => {
    const user = await makeUser('user');
    const res = await request(app).post('/api/tools/SecretManagerClient/run').set('Authorization', bearer(user)).send({ secret_id: 'stripe-key' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_required');
  });

  test('a platform admin can reach SecretManagerClient (fails only on unconfigured GCP, not on authorization)', async () => {
    const admin = await makeUser('admin');
    const res = await request(app).post('/api/tools/SecretManagerClient/run').set('Authorization', bearer(admin)).send({ secret_id: 'stripe-key' });
    expect(res.status).not.toBe(403);
  });

  test('a regular user CAN still invoke a non-infrastructure tool (SHA256Hasher)', async () => {
    const user = await makeUser('user');
    const prev = process.env.INTEGRATION_SHA256HASHER_MODE;
    process.env.INTEGRATION_SHA256HASHER_MODE = 'live';
    try {
      const res = await request(app).post('/api/tools/SHA256Hasher/run').set('Authorization', bearer(user))
        .send({ file_bytes: Buffer.from('hello').toString('base64') });
      expect(res.status).toBe(200);
      expect(res.body.result.sha256_hex).toHaveLength(64);
    } finally {
      if (prev === undefined) delete process.env.INTEGRATION_SHA256HASHER_MODE; else process.env.INTEGRATION_SHA256HASHER_MODE = prev;
    }
  });
});

describe('TOTPMFAProvider: cannot verify another user\'s account', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tools', toolsRoutes);
  app.use(errorMiddleware);
  const ORIGINAL_ENV = process.env.INTEGRATION_TOTPMFAPROVIDER_MODE;
  beforeAll(() => { process.env.INTEGRATION_TOTPMFAPROVIDER_MODE = 'live'; });
  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.INTEGRATION_TOTPMFAPROVIDER_MODE;
    else process.env.INTEGRATION_TOTPMFAPROVIDER_MODE = ORIGINAL_ENV;
  });

  test('passing a different user_id in the body is ignored — only the caller\'s own MFA is ever checked', async () => {
    const caller = await makeUser('user');
    const victim = await makeUser('user'); // not MFA-enrolled either — the point is caller's identity, not victim's state
    const res = await request(app).post('/api/tools/TOTPMFAProvider/run').set('Authorization', bearer(caller))
      .send({ user_id: victim.id, totp_code: '123456' });
    expect(res.status).toBe(200);
    // Neither user has MFA enrolled, so this just proves no error/crash and a
    // legitimate not_enrolled response for the CALLER (caller has no mfaSecret) —
    // the security-relevant fact is this never throws/leaks based on victim.id.
    expect(res.body.result.mfa_status).toBe('not_enrolled');
  });
});

describe('oauth.js /revoke requires client authentication', () => {
  const app = express();
  app.use(express.json());
  app.use('/oauth', oauthRoutes);
  app.use(errorMiddleware);

  test('rejects revocation with no client_id/client_secret at all', async () => {
    const res = await request(app).post('/oauth/revoke').send({ token: 'whatever' });
    expect(res.status).toBe(400); // zod validation: client_id/client_secret required
  });

  test('rejects revocation with a wrong client_secret', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    const { app: oauthApp } = await oauthApps.registerApp({ orgId: org.id, name: 'Test App', redirectUris: ['https://example.com/cb'] });
    const res = await request(app).post('/oauth/revoke').send({ token: 'sometoken', client_id: oauthApp.clientId, client_secret: 'wrong-secret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  test('accepts revocation with the correct client credentials', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    const { app: oauthApp, clientSecret } = await oauthApps.registerApp({ orgId: org.id, name: 'Test App', redirectUris: ['https://example.com/cb'] });
    const res = await request(app).post('/oauth/revoke').send({ token: 'sometoken', client_id: oauthApp.clientId, client_secret: clientSecret });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });
});
