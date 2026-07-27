/**
 * Usage quotas matching stated prices (TODO.md). Two real, previously-
 * unenforced gaps between the pricing page's claims (dashboard/src/
 * PricingPage.js, sourced from entitlements.js's PLANS catalog) and actual
 * behavior:
 *
 *  - Seats: a Free-tier org (marketed as 1 seat) could invite unlimited
 *    teammates. middleware/entitlements.js's enforceMeter()/requireFeature()
 *    already existed, fully built, with zero call sites anywhere in the
 *    app — activated here for the first time. Seats specifically needed a
 *    NEW gauge-style check (lib/entitlements.js#checkSeats, counting active
 *    OrgMembership rows directly) rather than the existing checkUsage(),
 *    since checkUsage()'s UsageCounter resets every calendar month, which
 *    is correct for a flow meter like records_per_month but wrong for a
 *    live headcount that shouldn't reset just because the period rolled
 *    over.
 *  - records_per_month ("AI use cases / month" on the pricing page): wired
 *    the existing (also previously-unused) enforceMeter('records_per_month')
 *    onto the three Gemini-analysis-triggering routes.
 */
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const ent = require('../../lib/entitlements');

const organizationRoutes = require('../../routes/organization');
const evidenceRoutes = require('../../routes/evidence');
const entityRoutes = require('../../routes/entities');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/orgs', organizationRoutes);
  app.use('/api', evidenceRoutes);
  app.use('/api', entityRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

async function makeOrgWithMember(role = 'owner') {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({
    data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true },
  });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role, status: 'active' } });
  return { org, user };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('seat limits (Free tier: 1 seat)', () => {
  test('inviting a second teammate on a 1-seat org is rejected (402) before an invite is even created', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const res = await request(app).post('/api/orgs/invitations').set('Authorization', bearer(owner))
      .send({ email: `${uid('invitee')}@test.local`, role: 'estimator' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('usage_limit_exceeded');
    expect(res.body.meter).toBe('seats');
    expect(res.body.used).toBe(1);
    expect(res.body.limit).toBe(1);
    // `error` must hold the human-readable message, not the code — matches
    // this codebase's own HttpError convention, and is what the dashboard's
    // apiJson() actually surfaces to the user (it reads body.error first).
    // middleware/entitlements.js originally got this backwards for every
    // response shape it returns (dormant code, never exercised through a
    // real client until this item wired it in for the first time).
    expect(res.body.error).toMatch(/seat limit/i);
    expect(res.body.error).not.toBe('usage_limit_exceeded');

    const pending = await prisma.invitation.findMany({ where: { orgId: org.id } });
    expect(pending).toHaveLength(0); // rejected before creating the row
  });

  test('checkSeats() reports allowed:true exactly up to the limit, false beyond it', async () => {
    const { org } = await makeOrgWithMember('owner'); // 1 active member, Free tier limit 1
    const atCapacity = await ent.checkSeats(org.id, 0); // "would 0 more still fit" — yes, already at exactly the limit
    expect(atCapacity).toMatchObject({ allowed: true, used: 1, limit: 1, remaining: 0 });
    const overCapacity = await ent.checkSeats(org.id, 1);
    expect(overCapacity.allowed).toBe(false);
  });

  test('two pending invites both accepted would exceed a 2-seat cap — the second accept is rejected even though the first succeeded', async () => {
    // Simulates starter-tier-like headroom (2 free slots) without needing a
    // real Subscription/Stripe plan row: seed two Invitation rows directly
    // (bypassing the invite-send route's own seat check, matching the "two
    // invites sent while under the cap" scenario) against an org that
    // already has 2 active members and a 3-seat effective limit forced via
    // a temporary Subscription row.
    const { org, user: owner } = await makeOrgWithMember('owner');
    const member2 = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: member2.id, role: 'estimator', status: 'active' } });
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'starter', status: 'active' } }); // 5 seats

    // Fill remaining headroom down to exactly 1 free seat by adding 2 more members (2 + 2 = 4, 1 free of 5).
    for (let i = 0; i < 2; i++) {
      const u = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: u.id, role: 'estimator', status: 'active' } });
    }

    const inviteeA = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, passwordHash: 'x', role: 'user', emailVerified: true } });
    const inviteeB = await prisma.user.create({ data: { email: `${uid('b')}@test.local`, passwordHash: 'x', role: 'user', emailVerified: true } });
    const rawA = 'a'.repeat(32), rawB = 'b'.repeat(32);
    const { hashToken } = require('../../lib/security');
    await prisma.invitation.create({ data: { orgId: org.id, email: inviteeA.email, role: 'estimator', tokenHash: hashToken(rawA), invitedBy: owner.id, expiresAt: new Date(Date.now() + 3600_000) } });
    await prisma.invitation.create({ data: { orgId: org.id, email: inviteeB.email, role: 'estimator', tokenHash: hashToken(rawB), invitedBy: owner.id, expiresAt: new Date(Date.now() + 3600_000) } });

    const acceptA = await request(app).post('/api/orgs/invitations/accept').set('Authorization', bearer(inviteeA)).send({ token: rawA });
    expect(acceptA.status).toBe(200); // fills the last free seat (5/5)

    const acceptB = await request(app).post('/api/orgs/invitations/accept').set('Authorization', bearer(inviteeB)).send({ token: rawB });
    expect(acceptB.status).toBe(402);
    expect(acceptB.body.meter).toBe('seats');

    const membershipB = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: inviteeB.id } } });
    expect(membershipB).toBeNull(); // never created
  });

  test('a post-write recheck rolls back the membership even when the pre-flight check was stale (race-guard safety net)', async () => {
    // A genuine concurrent race (two accepts truly overlapping) isn't
    // reproducible deterministically in a single-threaded test — this
    // isolates the specific safety net POST /invitations/accept now has
    // for that scenario: even if checkSeats()'s pre-flight read (a plain,
    // unlocked count with no transaction) returned allowed:true based on
    // stale state, the recount inside the same transaction as the
    // membership write must catch an org that's actually already full and
    // roll the write back, rather than trusting the stale pre-flight result.
    const { org, user: owner } = await makeOrgWithMember('owner'); // 1 active member, Free tier limit 1
    const invitee = await prisma.user.create({ data: { email: `${uid('invitee')}@test.local`, passwordHash: 'x', role: 'user', emailVerified: true } });
    const raw = 'c'.repeat(32);
    const { hashToken } = require('../../lib/security');
    const invitation = await prisma.invitation.create({ data: { orgId: org.id, email: invitee.email, role: 'estimator', tokenHash: hashToken(raw), invitedBy: owner.id, expiresAt: new Date(Date.now() + 3600_000) } });

    // Simulate "the pre-flight check ran against stale state and said yes"
    // — the org is really already at its 1-seat limit the whole time.
    const spy = jest.spyOn(ent, 'checkSeats').mockResolvedValueOnce({ allowed: true, used: 0, limit: 1, remaining: 1 });
    const res = await request(app).post('/api/orgs/invitations/accept').set('Authorization', bearer(invitee)).send({ token: raw });
    spy.mockRestore();

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('usage_limit_exceeded');

    const membership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: invitee.id } } });
    expect(membership).toBeNull(); // rolled back, not left half-applied
    const invitationRow = await prisma.invitation.findUnique({ where: { id: invitation.id } });
    expect(invitationRow.status).toBe('pending'); // the invitation.update() inside the same transaction was rolled back too
  });
});

describe('records_per_month ("AI use cases / month")', () => {
  async function makeOrgProjectAndDoc() {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const cust = await request(app).post('/api/customers').set('Authorization', bearer(owner)).send({ name: 'C' });
    const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(owner)).send({ customer_id: cust.body.id, name: 'P' });
    const doc = await request(app).post('/api/sourceDocuments').set('Authorization', bearer(owner)).send({
      project_id: proj.body.id, document_type: 'contract', original_filename: 'a.pdf',
      storage_uri: 'local://a.pdf', sha256_hash: crypto.randomBytes(16).toString('hex'), uploaded_at: new Date().toISOString(),
    });
    expect(doc.status).toBe(201);
    return { org, owner, doc: doc.body };
  }

  test('a successful analyze enqueue records real usage (UsageCounter increments by 1)', async () => {
    const { org, owner, doc } = await makeOrgProjectAndDoc();
    const period = ent.currentPeriodKey();
    const before = await prisma.usageCounter.findUnique({ where: { orgId_meter_period: { orgId: org.id, meter: 'records_per_month', period } } });
    expect(before).toBeNull();

    const res = await request(app).post(`/api/sourceDocuments/${doc.id}/analyze`).set('Authorization', bearer(owner));
    expect(res.status).toBe(202);
    expect(res.headers['x-quota-meter']).toBe('records_per_month');
    expect(res.headers['x-quota-limit']).toBe('50'); // Free tier

    // recordUsage() fires on res.on('finish') — supertest has already
    // received the response by the time .send() resolves above, and
    // finish fires synchronously with/just after that, so no polling needed.
    const after = await prisma.usageCounter.findUnique({ where: { orgId_meter_period: { orgId: org.id, meter: 'records_per_month', period } } });
    expect(Number(after.value)).toBe(1); // UsageCounter.value is a BigInt column
  });

  test('a request at the monthly limit is rejected (402) before the analyze job is ever enqueued', async () => {
    const { org, owner, doc } = await makeOrgProjectAndDoc();
    const period = ent.currentPeriodKey();
    await prisma.usageCounter.create({ data: { orgId: org.id, meter: 'records_per_month', period, value: 50 } }); // Free tier limit

    const res = await request(app).post(`/api/sourceDocuments/${doc.id}/analyze`).set('Authorization', bearer(owner));
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('usage_limit_exceeded');
    expect(res.body.meter).toBe('records_per_month');
    expect(res.body.used).toBe(50);
    expect(res.body.limit).toBe(50);

    const refreshed = await prisma.sourceDocument.findUnique({ where: { id: doc.id } });
    expect(refreshed.extraction_status).not.toBe('processing'); // no job was enqueued
  });

  test('an org on an unlimited (enterprise) plan is never blocked regardless of usage', async () => {
    const { org, owner, doc } = await makeOrgProjectAndDoc();
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'enterprise', status: 'active' } });
    const period = ent.currentPeriodKey();
    await prisma.usageCounter.create({ data: { orgId: org.id, meter: 'records_per_month', period, value: 999999 } });

    const res = await request(app).post(`/api/sourceDocuments/${doc.id}/analyze`).set('Authorization', bearer(owner));
    expect(res.status).toBe(202);
    expect(res.headers['x-quota-limit']).toBeUndefined(); // enforceMeter skips the headers when limit === -1
  });
});

/**
 * The remaining advertised meters. Before this, storage_gb / webhooks /
 * api_calls_per_month / ai_tokens_per_month appeared in the PLANS catalog and
 * on the pricing page but were checked nowhere in the codebase — the strings
 * existed only in the catalog literal. Suspended subscriptions were likewise
 * never blocked from writing.
 */
describe('storage_gb', () => {
  const FREE_TIER = { limits: { storage_gb: 1 } };

  test('sums bytes across BOTH models that hold uploads, not just one', async () => {
    const { org, user } = await makeOrgWithMember('owner');
    const cust = await request(app).post('/api/customers').set('Authorization', bearer(user)).send({ name: 'C' });
    const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(user)).send({ customer_id: cust.body.id, name: 'P' });
    await prisma.sourceDocument.create({
      data: {
        orgId: org.id, userId: user.id, project_id: proj.body.id, document_type: 'contract',
        original_filename: 'a.pdf', storage_uri: 'local://a.pdf',
        sha256_hash: crypto.randomBytes(16).toString('hex'),
        uploaded_at: new Date(), file_size_bytes: 400,
      },
    });
    await prisma.evidenceItem.create({
      data: {
        orgId: org.id, project_id: proj.body.id, evidenceType: 'photo', storageUri: 'local://p.jpg',
        sha256Hash: crypto.randomBytes(32).toString('hex'), fileSizeBytes: 600,
      },
    });
    const status = await ent.checkStorageBytes(org.id, 0, FREE_TIER);
    expect(status.used).toBe(1000);
  });

  test('rows predating the fileSizeBytes column count as 0 rather than blocking the org', async () => {
    const { org, user } = await makeOrgWithMember('owner');
    const cust = await request(app).post('/api/customers').set('Authorization', bearer(user)).send({ name: 'C' });
    const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(user)).send({ customer_id: cust.body.id, name: 'P' });
    await prisma.evidenceItem.create({
      data: {
        orgId: org.id, project_id: proj.body.id, evidenceType: 'photo', storageUri: 'local://legacy.jpg',
        sha256Hash: crypto.randomBytes(32).toString('hex'), fileSizeBytes: null,
      },
    });
    const status = await ent.checkStorageBytes(org.id, 0, FREE_TIER);
    expect(status.used).toBe(0);
    expect(status.allowed).toBe(true);
  });

  test('blocks once the requested bytes would cross the limit, and allows exactly hitting it', async () => {
    const { org } = await makeOrgWithMember('owner');
    const tinyTier = { limits: { storage_gb: 1 / ent.BYTES_PER_GB * 1000 } }; // exactly 1000 bytes
    expect((await ent.checkStorageBytes(org.id, 1000, tinyTier)).allowed).toBe(true);
    expect((await ent.checkStorageBytes(org.id, 1001, tinyTier)).allowed).toBe(false);
  });

  test('an unlimited (enterprise) plan is never blocked', async () => {
    const { org } = await makeOrgWithMember('owner');
    const status = await ent.checkStorageBytes(org.id, Number.MAX_SAFE_INTEGER, { limits: { storage_gb: -1 } });
    expect(status.allowed).toBe(true);
  });

  test('the upload route returns 402 and creates no row when over quota', async () => {
    const { user } = await makeOrgWithMember('owner');
    const cust = await request(app).post('/api/customers').set('Authorization', bearer(user)).send({ name: 'C' });
    const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(user)).send({ customer_id: cust.body.id, name: 'P' });
    const spy = jest.spyOn(ent, 'checkStorageBytes').mockResolvedValue({
      allowed: false, used: 2 * ent.BYTES_PER_GB, limit: ent.BYTES_PER_GB, limitGb: 1, remaining: 0,
    });
    const res = await request(app).post(`/api/projects/${proj.body.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]), { filename: 'roof.jpg', contentType: 'image/jpeg' });
    spy.mockRestore();
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('usage_limit_exceeded');
    expect(await prisma.evidenceItem.count({ where: { project_id: proj.body.id } })).toBe(0);
  });
});

describe('webhooks', () => {
  test('counts across every member of the org, not per user', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const second = await prisma.user.create({
      data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true },
    });
    await prisma.webhook.create({ data: { userId: owner.id, url: 'https://a.test/h', events: '["*"]', secret: 's1' } });
    await prisma.webhook.create({ data: { userId: second.id, url: 'https://b.test/h', events: '["*"]', secret: 's2' } });
    const status = await ent.checkWebhooks(org.id, 1, { limits: { webhooks: 2 } });
    expect(status.used).toBe(2);
    expect(status.allowed).toBe(false); // a 3rd would exceed the limit of 2
  });

  test('an org with no members yet reports zero rather than throwing', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Empty') } });
    const status = await ent.checkWebhooks(org.id, 1, { limits: { webhooks: 1 } });
    expect(status.used).toBe(0);
    expect(status.allowed).toBe(true);
  });
});

describe('suspended subscriptions', () => {
  test('a suspended subscription is actually reported as suspended (the status was previously unreachable)', async () => {
    const { org } = await makeOrgWithMember('owner');
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'pro', status: 'suspended' } });
    const sub = await ent.getActiveSubscription(org.id);
    expect(sub.status).toBe('suspended');
  });

  test('a suspended org is downgraded to free-tier limits and loses paid entitlements', async () => {
    const { org } = await makeOrgWithMember('owner');
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'pro', status: 'suspended' } });
    expect(await ent.can(org.id, 'sso')).toBe(false);           // pro grants sso; suspended must not
    expect(await ent.getLimit(org.id, 'seats')).toBe(1);        // free tier, not pro's 25
  });

  test('a live subscription still resolves to its real paid tier', async () => {
    const { org } = await makeOrgWithMember('owner');
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'pro', status: 'active' } });
    const sub = await ent.getActiveSubscription(org.id);
    expect(sub.status).toBe('active');
    expect(sub.tier.id).toBe('pro');
    expect(await ent.can(org.id, 'sso')).toBe(true);
  });

  test('a status nobody enumerated (e.g. incomplete) does not hand out paid features', async () => {
    const { org } = await makeOrgWithMember('owner');
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'pro', status: 'incomplete' } });
    const sub = await ent.getActiveSubscription(org.id);
    expect(sub.status).toBe('incomplete');
    expect(sub.tier.id).toBe('free');
    expect(await ent.can(org.id, 'sso')).toBe(false);
  });
});
