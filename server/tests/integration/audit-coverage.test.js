/**
 * Verifies the audit() call sites added across auth.js (logout), billing.js
 * (checkout/portal/cancel), oauth.js (authorize/token/revoke), and admin.js
 * (role change/delete/email test) actually create the expected Activity row
 * — not just that the route responds successfully.
 *
 * Also regression-tests the root-cause fix in lib/audit.js: previously
 * _getLatestHash()/prisma.activity.create() ran with whatever ambient tenant
 * context (if any) the CALLER happened to be in. Since Activity's hash chain
 * spans every org as ONE sequence, and most of these call sites (everything
 * in auth.js, which never mounts attachTenant) have NO ambient context at
 * all, real Postgres+RLS would have made every one of these writes silently
 * fail (swallowed internally by audit()'s own catch, logged via
 * console.error only) — the whole point of this test file. SQLite has no
 * RLS, so it can't reproduce the failure directly, but it does prove the
 * chain stays globally consistent across writes issued from different
 * (or no) ambient org contexts, which is what the fix's internal
 * runWithSystemAccess() wrap is actually for.
 */
jest.mock('../../lib/billing/stripe', () => ({
  isConfigured: () => true,
  createCheckoutSession: async () => ({ url: 'https://checkout.stripe.com/test_cs', id: 'cs_test_123' }),
  createPortalSession: async () => ({ url: 'https://billing.stripe.com/test_portal' }),
}));

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { issueCsrfCookie, csrfProtect } = require('../../lib/csrf');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const { runWithOrg, runWithSystemAccess } = require('../../lib/tenant-context');
const { audit, verifyChain } = require('../../lib/audit');
const oauthApps = require('../../lib/oauth-apps');

const authRoutes = require('../../routes/auth');
const billingRoutes = require('../../routes/billing');
const oauthRoutes = require('../../routes/oauth');
const adminRoutes = require('../../routes/admin');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(issueCsrfCookie);
  app.use('/api/', csrfProtect);
  app.get('/csrf-primer', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/oauth', oauthRoutes);
  app.use('/api/admin', adminRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }
function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}
async function getCsrf(agent) {
  const res = await agent.get('/csrf-primer');
  const setCookie = res.headers['set-cookie'] || [];
  const raw = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('csrf='));
  return raw ? raw.split('=')[1] : null;
}

async function makeOrgWithMember(role = 'owner') {
  const org = await prisma.organization.create({ data: { name: `Org ${uid('o')}`, plan: 'free' } });
  const user = await prisma.user.create({
    data: {
      email: `${uid('u')}@test.local`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      role: 'user', orgId: org.id, emailVerified: true,
    },
  });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role, status: 'active' } });
  return { org, user };
}

function latestActivity(action, resourceId) {
  return prisma.activity.findFirst({ where: { action, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'desc' } });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('audit() coverage on newly-instrumented routes', () => {
  test('POST /api/auth/logout writes auth.logout', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    const email = `${uid('u')}@test.local`;
    const reg = await agent.post('/api/auth/register').set('x-csrf-token', csrf)
      .send({ email, password: 'Correct-Horse-Battery-9!', name: 'Ada' });
    expect(reg.status).toBe(201);
    const userId = reg.body.user.id;

    const res = await agent.post('/api/auth/logout').set('x-csrf-token', csrf).send({});
    expect(res.status).toBe(200);

    const row = await latestActivity('auth.logout');
    expect(row).toBeTruthy();
    expect(row.userId).toBe(userId);
  });

  test('billing checkout/portal/cancel each write their own audit action', async () => {
    const { org, user } = await makeOrgWithMember('owner');
    const auth = bearer(user);

    const checkout = await request(app).post('/api/billing/checkout').set('Authorization', auth)
      .send({ tierId: 'pro', cadence: 'monthly' });
    expect(checkout.status).toBe(200);
    const checkoutRow = await latestActivity('billing.checkout.started', org.id);
    expect(checkoutRow).toBeTruthy();
    expect(checkoutRow.details).toContain('pro');

    const portal = await request(app).post('/api/billing/portal').set('Authorization', auth).send({});
    expect(portal.status).toBe(200);
    const portalRow = await latestActivity('billing.portal.opened', org.id);
    expect(portalRow).toBeTruthy();

    await prisma.subscription.create({ data: { orgId: org.id, planId: 'pro', status: 'active' } });
    const cancel = await request(app).post('/api/billing/cancel').set('Authorization', auth).send({});
    expect(cancel.status).toBe(200);
    const cancelRow = await latestActivity('billing.subscription.cancel_requested', org.id);
    expect(cancelRow).toBeTruthy();
  });

  test('oauth authorize/token/revoke each write their own audit action with the right userId', async () => {
    const { user } = await makeOrgWithMember('owner');
    const { app: oauthApp, clientSecret } = await oauthApps.registerApp({
      name: 'Test App', redirectUris: ['https://example.com/cb'], scopes: 'read',
    });

    const authorizeRes = await request(app).get('/oauth/authorize')
      .set('Authorization', bearer(user))
      .query({ client_id: oauthApp.clientId, redirect_uri: 'https://example.com/cb', response_type: 'code' });
    expect(authorizeRes.status).toBe(302);
    const grantedRow = await latestActivity('oauth.authorize.granted', oauthApp.clientId);
    expect(grantedRow).toBeTruthy();
    expect(grantedRow.userId).toBe(user.id);

    const code = new URL(authorizeRes.headers.location).searchParams.get('code');
    const tokenRes = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code', code,
      client_id: oauthApp.clientId, client_secret: clientSecret,
      redirect_uri: 'https://example.com/cb',
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body._userId).toBeUndefined(); // must never leak to the OAuth client response
    const issuedRow = await latestActivity('oauth.token.issued', oauthApp.clientId);
    expect(issuedRow).toBeTruthy();
    expect(issuedRow.userId).toBe(user.id);

    const revokeRes = await request(app).post('/oauth/revoke').send({
      token: tokenRes.body.access_token, client_id: oauthApp.clientId, client_secret: clientSecret,
    });
    expect(revokeRes.status).toBe(200);
    const revokedRow = await latestActivity('oauth.token.revoked', oauthApp.clientId);
    expect(revokedRow).toBeTruthy();
    expect(revokedRow.userId).toBe(user.id);
  });

  test('admin role-change, delete, and email-test each write their own audit action', async () => {
    const { org, user: admin } = await makeOrgWithMember('owner');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'admin' } });
    const target = await prisma.user.create({
      data: { email: `${uid('u')}@test.local`, passwordHash: '$2b$10$abcdefghijklmnopqrstuv', role: 'user', orgId: org.id, emailVerified: true },
    });
    const auth = bearer({ ...admin, role: 'admin' });

    const roleRes = await request(app).patch(`/api/admin/users/${target.id}/role`).set('Authorization', auth).send({ role: 'viewer' });
    expect(roleRes.status).toBe(200);
    const roleRow = await latestActivity('admin.user.role_changed', target.id);
    expect(roleRow).toBeTruthy();
    expect(roleRow.details).toContain('viewer');

    const emailRes = await request(app).post('/api/admin/email/test').set('Authorization', auth).send({ to: 'probe@test.local' });
    expect(emailRes.status).toBe(200);
    const emailRow = await latestActivity('admin.email.test_sent');
    expect(emailRow).toBeTruthy();
    expect(emailRow.details).toContain('probe@test.local');

    const deleteRes = await request(app).delete(`/api/admin/users/${target.id}`).set('Authorization', auth).send();
    expect(deleteRes.status).toBe(200);
    const deleteRow = await latestActivity('admin.user.deleted', target.id);
    expect(deleteRow).toBeTruthy();
  });
});

describe('audit() hash chain stays globally consistent regardless of caller context', () => {
  test('writes issued from different ambient org contexts (and none at all) still form one valid chain', async () => {
    const before = await verifyChain();
    expect(before.ok).toBe(true);

    const orgA = uid('orgA');
    const orgB = uid('orgB');
    // No ambient context at all — mirrors auth.js's routes today.
    await audit({}, 'test.no_context', { orgId: null, resource: 'probe' });
    // Ambient context for a DIFFERENT org than the payload's own orgId —
    // mirrors a background job or webhook whose org comes from event data,
    // not from whatever happened to be active when audit() was called.
    await runWithOrg(orgA, () => audit({}, 'test.mismatched_org_context', { orgId: orgB, resource: 'probe' }));
    // Full system access ambient context.
    await runWithSystemAccess(() => audit({}, 'test.system_context', { orgId: orgA, resource: 'probe' }));

    const after = await verifyChain();
    expect(after.ok).toBe(true);
    expect(after.total).toBeGreaterThanOrEqual(before.total + 3);

    const mismatched = await latestActivity('test.mismatched_org_context');
    expect(mismatched.orgId).toBe(orgB); // stored orgId is whatever the payload said, not the ambient context
  });
});
