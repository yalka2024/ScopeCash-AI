/**
 * Integration coverage for the Phase 1 hardening work:
 *   - registration auto-creates Organization + OrgMembership(owner) + OrganizationRecord
 *   - per-entity RBAC (req.orgRole from OrgMembership, not the blanket write-role check)
 *   - cross-tenant isolation on the generic domain CRUD
 *   - cross-org foreign-key rejection (customer_id must belong to the caller's org)
 *   - packet approval / commercial-outcome stage-transition guardrails
 *   - Idempotency-Key dedup on POST
 *
 * Runs against a real SQLite test database (migrations applied fresh) rather
 * than a mocked Prisma client — the existing suite mocks Prisma everywhere
 * (see tests/integration/health.test.js), so none of this was exercised
 * end-to-end before.
 */
const crypto = require('crypto');
// test.db migration is handled once by tests/global-setup.js (Jest globalSetup).

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { issueCsrfCookie, csrfProtect } = require('../../lib/csrf');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken, hashToken } = require('../../lib/security');

const authRoutes = require('../../routes/auth');
const organizationRoutes = require('../../routes/organization');
const entityRoutes = require('../../routes/entities');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(issueCsrfCookie);
  app.use('/api/', csrfProtect);
  app.get('/csrf-primer', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/orgs', organizationRoutes);
  app.use('/api', entityRoutes);
  app.use(errorMiddleware);
  return app;
}

const app = buildApp();

function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

function uniqueEmail() {
  return `u${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.local`;
}

async function makeOrgWithMember(role = 'owner') {
  const org = await prisma.organization.create({ data: { name: `Org ${crypto.randomBytes(3).toString('hex')}`, plan: 'free' } });
  const user = await prisma.user.create({
    data: {
      email: uniqueEmail(),
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      role: 'user', orgId: org.id, emailVerified: true,
    },
  });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role, status: 'active' } });
  return { org, user };
}

async function getCsrf(agent) {
  const res = await agent.get('/csrf-primer');
  const setCookie = res.headers['set-cookie'] || [];
  const raw = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('csrf='));
  return raw ? raw.split('=')[1] : null;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('registration auto-creates org + owner membership', () => {
  test('POST /api/auth/register creates Organization, OrgMembership(owner), OrganizationRecord', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    const email = uniqueEmail();
    const res = await agent.post('/api/auth/register')
      .set('x-csrf-token', csrf)
      .send({ email, password: 'Correct-Horse-Battery-9!', name: 'Ada' });
    expect(res.status).toBe(201);
    expect(res.body.user.orgId).toBeTruthy();

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: res.body.user.orgId, userId: res.body.user.id } },
    });
    expect(membership).toBeTruthy();
    expect(membership.role).toBe('owner');
    expect(membership.status).toBe('active');

    const record = await prisma.organizationRecord.findUnique({ where: { orgId: res.body.user.orgId } });
    expect(record).toBeTruthy();
  });
});

describe('per-entity RBAC (req.orgRole)', () => {
  test('owner can create a customer and a project', async () => {
    const { user } = await makeOrgWithMember('owner');
    const cRes = await request(app).post('/api/customers').set('Authorization', bearer(user)).send({ name: 'Riverside Community Center' });
    expect(cRes.status).toBe(201);

    const pRes = await request(app).post('/api/projectRecords').set('Authorization', bearer(user))
      .send({ customer_id: cRes.body.id, name: 'HVAC Retrofit' });
    expect(pRes.status).toBe(201);
    expect(pRes.body.orgId).toBe(user.orgId);
  });

  test('field_user cannot create a project (403) but can create a source document', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const custRes = await request(app).post('/api/customers').set('Authorization', bearer(owner)).send({ name: 'Cust' });
    const projRes = await request(app).post('/api/projectRecords').set('Authorization', bearer(owner))
      .send({ customer_id: custRes.body.id, name: 'Proj' });

    const { org } = await prisma.organization.findUnique({ where: { id: owner.orgId } }).then((o) => ({ org: o }));
    const fieldUser = await prisma.user.create({
      data: { email: uniqueEmail(), passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true },
    });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: fieldUser.id, role: 'field_user', status: 'active' } });

    const blocked = await request(app).post('/api/projectRecords').set('Authorization', bearer(fieldUser))
      .send({ customer_id: custRes.body.id, name: 'Should fail' });
    expect(blocked.status).toBe(403);

    const allowed = await request(app).post('/api/sourceDocuments').set('Authorization', bearer(fieldUser)).send({
      project_id: projRes.body.id, document_type: 'photo', original_filename: 'a.jpg',
      storage_uri: 'local://a.jpg', sha256_hash: crypto.randomBytes(16).toString('hex'),
      uploaded_at: new Date().toISOString(),
    });
    expect(allowed.status).toBe(201);
  });

  test('viewer can list but cannot create', async () => {
    const { org } = await makeOrgWithMember('owner');
    const viewer = await prisma.user.create({
      data: { email: uniqueEmail(), passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true },
    });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: viewer.id, role: 'viewer', status: 'active' } });

    const list = await request(app).get('/api/customers').set('Authorization', bearer(viewer));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);

    const create = await request(app).post('/api/customers').set('Authorization', bearer(viewer)).send({ name: 'x' });
    expect(create.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  test('org B cannot read, update, or delete org A\'s customer', async () => {
    const { user: userA } = await makeOrgWithMember('owner');
    const { user: userB } = await makeOrgWithMember('owner');

    const created = await request(app).post('/api/customers').set('Authorization', bearer(userA)).send({ name: 'A-only' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const getAsB = await request(app).get(`/api/customers/${id}`).set('Authorization', bearer(userB));
    expect(getAsB.status).toBe(404);

    const putAsB = await request(app).put(`/api/customers/${id}`).set('Authorization', bearer(userB)).send({ name: 'hijacked' });
    expect(putAsB.status).toBe(404);

    const delAsB = await request(app).delete(`/api/customers/${id}`).set('Authorization', bearer(userB));
    expect(delAsB.status).toBe(404);

    const stillThere = await prisma.customer.findUnique({ where: { id } });
    expect(stillThere.name).toBe('A-only');
  });

  test('cannot create a project pointing at another org\'s customer', async () => {
    const { user: userA } = await makeOrgWithMember('owner');
    const { user: userB } = await makeOrgWithMember('owner');
    const custB = await request(app).post('/api/customers').set('Authorization', bearer(userB)).send({ name: 'B cust' });

    const res = await request(app).post('/api/projectRecords').set('Authorization', bearer(userA))
      .send({ customer_id: custB.body.id, name: 'cross-org attempt' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_reference');
  });
});

async function seedProjectAndPacket(pmRole = 'project_manager') {
  const { user: owner, org } = await makeOrgWithMember('owner');
  const pm = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: pm.id, role: pmRole, status: 'active' } });
  const cust = await request(app).post('/api/customers').set('Authorization', bearer(owner)).send({ name: 'C' });
  const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(owner)).send({ customer_id: cust.body.id, name: 'P' });
  const packet = await request(app).post('/api/evidencePackets').set('Authorization', bearer(owner))
    .send({ project_id: proj.body.id, packet_number: 'PK-1', version: 1 });
  return { owner, pm, org, proj, packet };
}

describe('evidence packet approval workflow', () => {
  test('field_user cannot approve; project_manager can; double-approve 409s', async () => {
    const { org, packet } = await seedProjectAndPacket();
    const fieldUser = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: fieldUser.id, role: 'field_user', status: 'active' } });

    const blocked = await request(app).post(`/api/evidencePackets/${packet.body.id}/approve`).set('Authorization', bearer(fieldUser));
    expect(blocked.status).toBe(403);

    const pmMembership = await prisma.orgMembership.findFirst({ where: { orgId: org.id, role: 'project_manager' } });
    const pmRow = await prisma.user.findUnique({ where: { id: pmMembership.userId } });

    const approved = await request(app).post(`/api/evidencePackets/${packet.body.id}/approve`).set('Authorization', bearer(pmRow));
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approved_by_id).toBe(pmRow.id);

    const again = await request(app).post(`/api/evidencePackets/${packet.body.id}/approve`).set('Authorization', bearer(pmRow));
    expect(again.status).toBe(409);
  });

  test('generic PUT cannot set status/approved_by_id directly', async () => {
    const { owner, packet } = await seedProjectAndPacket();
    const res = await request(app).put(`/api/evidencePackets/${packet.body.id}`).set('Authorization', bearer(owner))
      .send({ status: 'approved', approved_by_id: owner.id, recipient: 'City of Riverside' });
    expect(res.status).toBe(200);
    expect(res.body.status).not.toBe('approved');
    expect(res.body.recipient).toBe('City of Riverside');
  });
});

describe('commercial outcome six-stage ledger', () => {
  test('forward transitions succeed, backward transitions 409, ledger rows are written', async () => {
    const { owner, proj } = await seedProjectAndPacket();
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner)).send({ project_id: proj.body.id });
    const outcomeId = outcomeRes.body.id;

    const t1 = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'identified', amount: 5000 });
    expect(t1.status).toBe(200);
    expect(t1.body.outcome.identified_amount).toBe(5000);

    const t2 = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'validated', amount: 4800 });
    expect(t2.status).toBe(200);
    expect(t2.body.outcome.validated_amount).toBe(4800);

    const backward = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'identified', amount: 5000 });
    expect(backward.status).toBe(409);
    expect(backward.body.code).toBe('stage_regression');

    const ledger = await request(app).get(`/api/commercialOutcomes/${outcomeId}/transitions`).set('Authorization', bearer(owner));
    expect(ledger.body.data.length).toBe(2);
    expect(ledger.body.data[0].toStage).toBe('identified');
    expect(ledger.body.data[1].toStage).toBe('validated');
    expect(ledger.body.data[1].fromStage).toBe('identified');
  });

  test('summary endpoint sums across outcomes with the six stages kept separate, never merged', async () => {
    const { owner, proj } = await seedProjectAndPacket();
    const o1 = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner)).send({ project_id: proj.body.id });
    const o2 = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner)).send({ project_id: proj.body.id });

    await request(app).post(`/api/commercialOutcomes/${o1.body.id}/transition`).set('Authorization', bearer(owner)).send({ toStage: 'identified', amount: 1000 });
    await request(app).post(`/api/commercialOutcomes/${o1.body.id}/transition`).set('Authorization', bearer(owner)).send({ toStage: 'validated', amount: 900 });
    await request(app).post(`/api/commercialOutcomes/${o2.body.id}/transition`).set('Authorization', bearer(owner)).send({ toStage: 'identified', amount: 2000 });
    await request(app).post(`/api/commercialOutcomes/${o2.body.id}/transition`).set('Authorization', bearer(owner)).send({ toStage: 'validated', amount: 1800 });
    await request(app).post(`/api/commercialOutcomes/${o2.body.id}/transition`).set('Authorization', bearer(owner)).send({ toStage: 'submitted', amount: 1800 });

    // Route-ordering regression guard: /summary must not be shadowed by the
    // generic GET /commercialOutcomes/:id route registered later in the file.
    const summary = await request(app).get('/api/commercialOutcomes/summary').set('Authorization', bearer(owner));
    expect(summary.status).toBe(200);
    expect(summary.body.outcomeCount).toBe(2);
    expect(summary.body.totals.identified_amount).toBe(3000);
    expect(summary.body.totals.validated_amount).toBe(2700);
    expect(summary.body.totals.submitted_amount).toBe(1800);
    // Never collapsed into one number — collected/invoiced/approved untouched stay zero, not undefined or merged.
    expect(summary.body.totals.approved_amount).toBe(0);
    expect(summary.body.totals.invoiced_amount).toBe(0);
    expect(summary.body.totals.collected_amount).toBe(0);
  });
});

describe('ownership transfer (two-step: request, then target confirms)', () => {
  async function addMember(org, role) {
    const user = await prisma.user.create({
      data: { email: uniqueEmail(), passwordHash: '$2b$10$abcdefghijklmnopqrstuv', role: 'user', orgId: org.id, emailVerified: true },
    });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role, status: 'active' } });
    return user;
  }
  function tokenFromLog(spy) {
    const call = spy.mock.calls.find((c) => { try { return JSON.parse(c[0]).type === 'org_ownership_transfer_token'; } catch { return false; } });
    return call && JSON.parse(call[0]).token;
  }

  test('requesting a transfer does NOT change any role by itself', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin = await addMember(org, 'admin');

    const res = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin.id });
    expect(res.status).toBe(201);

    const ownerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: owner.id } } });
    const targetMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: admin.id } } });
    expect(ownerMembership.role).toBe('owner'); // unchanged until confirmed
    expect(targetMembership.role).toBe('admin'); // unchanged until confirmed
  });

  test('full flow: request then the target confirms with the token — swap happens atomically, exactly one owner throughout', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin = await addMember(org, 'admin');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const reqRes = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin.id });
    expect(reqRes.status).toBe(201);
    const token = tokenFromLog(logSpy);
    expect(token).toBeTruthy();
    logSpy.mockRestore();

    const confirmRes = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(admin)).send({ token });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body).toMatchObject({ ok: true, oldOwnerId: owner.id, newOwnerId: admin.id });

    const oldOwnerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: owner.id } } });
    const newOwnerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: admin.id } } });
    expect(oldOwnerMembership.role).toBe('admin');
    expect(newOwnerMembership.role).toBe('owner');

    const ownerCount = await prisma.orgMembership.count({ where: { orgId: org.id, role: 'owner', status: 'active' } });
    expect(ownerCount).toBe(1); // never zero, never two, at any point

    // The request can't be replayed.
    const replay = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(admin)).send({ token });
    expect(replay.status).toBe(409);
  });

  test('only the invited recipient can confirm — not the requesting owner, not an unrelated member', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin = await addMember(org, 'admin');
    const bystander = await addMember(org, 'admin');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin.id });
    const token = tokenFromLog(logSpy);
    logSpy.mockRestore();

    const byOwner = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(owner)).send({ token });
    expect(byOwner.status).toBe(403);
    const byBystander = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(bystander)).send({ token });
    expect(byBystander.status).toBe(403);

    const ownerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: owner.id } } });
    expect(ownerMembership.role).toBe('owner'); // still unchanged
  });

  test('a non-owner (even an admin) cannot initiate a transfer', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin = await addMember(org, 'admin');
    const other = await addMember(org, 'admin');

    const res = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(admin)).send({ newOwnerUserId: other.id });
    expect(res.status).toBe(403);

    const ownerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: owner.id } } });
    expect(ownerMembership.role).toBe('owner'); // unchanged
  });

  test('rejects transferring to a user who is not an active member of the org', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const { user: outsider } = await makeOrgWithMember('owner'); // a real user, but in a DIFFERENT org

    const res = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: outsider.id });
    expect(res.status).toBe(404);
  });

  test('rejects transferring to a removed (former) member', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const former = await addMember(org, 'admin');
    await prisma.orgMembership.update({ where: { orgId_userId: { orgId: org.id, userId: former.id } }, data: { status: 'removed', removedAt: new Date() } });

    const res = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: former.id });
    expect(res.status).toBe(404);
  });

  test('only one pending transfer request per org at a time', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin1 = await addMember(org, 'admin');
    const admin2 = await addMember(org, 'admin');

    const first = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin1.id });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin2.id });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('transfer_already_pending');
  });

  test('regression: confirming a second, racing pending request after the first already resolved ownership does not create two owners', async () => {
    // The "one pending request per org" API-level check (previous test) is
    // a plain check-then-create, not itself race-proof: two near-
    // simultaneous requests from the same owner to two different targets
    // could both end up pending. Simulates that directly by inserting both
    // requests via Prisma with known tokens, bypassing the API's guard.
    // Confirming both, in order, must not leave two simultaneous owners.
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin1 = await addMember(org, 'admin');
    const admin2 = await addMember(org, 'admin');
    const tokenA = 'raw-token-for-the-first-racing-request';
    const tokenB = 'raw-token-for-the-second-racing-request';
    await Promise.all([
      prisma.ownershipTransferRequest.create({
        data: { orgId: org.id, fromUserId: owner.id, toUserId: admin1.id, tokenHash: hashToken(tokenA), expiresAt: new Date(Date.now() + 48 * 3600_000) },
      }),
      prisma.ownershipTransferRequest.create({
        data: { orgId: org.id, fromUserId: owner.id, toUserId: admin2.id, tokenHash: hashToken(tokenB), expiresAt: new Date(Date.now() + 48 * 3600_000) },
      }),
    ]);

    const confirmA = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(admin1)).send({ token: tokenA });
    expect(confirmA.status).toBe(200);

    const confirmB = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(admin2)).send({ token: tokenB });
    expect(confirmB.status).toBe(409);
    expect(confirmB.body.code).toBe('stale_transfer');

    const ownerCount = await prisma.orgMembership.count({ where: { orgId: org.id, role: 'owner', status: 'active' } });
    expect(ownerCount).toBe(1); // admin1 only — admin2's stale confirm never applied
    const admin1Membership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: admin1.id } } });
    const admin2Membership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: admin2.id } } });
    expect(admin1Membership.role).toBe('owner');
    expect(admin2Membership.role).toBe('admin'); // unchanged
  });

  test('the owner can revoke a pending request before it is confirmed', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin = await addMember(org, 'admin');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const created = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin.id });
    const token = tokenFromLog(logSpy);
    logSpy.mockRestore();

    const revokeRes = await request(app).delete(`/api/orgs/transfer-ownership/${created.body.id}`).set('Authorization', bearer(owner));
    expect(revokeRes.status).toBe(200);

    const confirmAfterRevoke = await request(app).post('/api/orgs/transfer-ownership/confirm').set('Authorization', bearer(admin)).send({ token });
    expect(confirmAfterRevoke.status).toBe(409);
    const ownerMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: org.id, userId: owner.id } } });
    expect(ownerMembership.role).toBe('owner');

    // Revoking frees up the org to start a new request.
    const another = await request(app).post('/api/orgs/transfer-ownership').set('Authorization', bearer(owner)).send({ newOwnerUserId: admin.id });
    expect(another.status).toBe(201);
  });

  test('regression: the generic role-change endpoint refuses to promote anyone to owner directly (would create two owners)', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const admin = await addMember(org, 'admin');

    const res = await request(app).patch(`/api/orgs/members/${admin.id}`).set('Authorization', bearer(owner)).send({ role: 'owner' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('use_transfer_ownership_endpoint');

    const ownerCount = await prisma.orgMembership.count({ where: { orgId: org.id, role: 'owner', status: 'active' } });
    expect(ownerCount).toBe(1); // still exactly one owner — the promotion never happened
  });
});

describe('org deletion request/cancel', () => {
  test('the owner can request deletion; scheduledDeletionAt is set roughly 30 days out by default', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const res = await request(app).post('/api/orgs/request-deletion').set('Authorization', bearer(owner)).send({ confirm: 'DELETE' });
    expect(res.status).toBe(201);
    expect(res.body.scheduledDeletionAt).toBeTruthy();

    const updated = await prisma.organization.findUnique({ where: { id: org.id } });
    expect(updated.deletionRequestedAt).toBeTruthy();
    expect(updated.deletionRequestedBy).toBe(owner.id);
    const daysOut = (new Date(updated.scheduledDeletionAt).getTime() - new Date(updated.deletionRequestedAt).getTime()) / 86_400_000;
    expect(daysOut).toBeCloseTo(30, 0);
  });

  test('requires the exact confirm:"DELETE" body — a typo or missing confirmation does not schedule anything', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const res = await request(app).post('/api/orgs/request-deletion').set('Authorization', bearer(owner)).send({ confirm: 'delete' });
    expect(res.status).toBe(400);
    const updated = await prisma.organization.findUnique({ where: { id: org.id } });
    expect(updated.scheduledDeletionAt).toBeNull();
  });

  test('a non-owner cannot request org deletion', async () => {
    const { org } = await makeOrgWithMember('owner');
    const admin = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: '$2b$10$abcdefghijklmnopqrstuv', role: 'user', orgId: org.id, emailVerified: true } });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: admin.id, role: 'admin', status: 'active' } });

    const res = await request(app).post('/api/orgs/request-deletion').set('Authorization', bearer(admin)).send({ confirm: 'DELETE' });
    expect(res.status).toBe(403);
    const updated = await prisma.organization.findUnique({ where: { id: org.id } });
    expect(updated.scheduledDeletionAt).toBeNull();
  });

  test('an active legal hold blocks the initial request outright', async () => {
    const { org, owner, proj } = await seedProjectAndPacket();
    await prisma.retentionLegalHold.create({ data: { orgId: org.id, resourceType: 'project', resourceId: proj.body.id, holdType: 'legal_hold' } });

    const res = await request(app).post('/api/orgs/request-deletion').set('Authorization', bearer(owner)).send({ confirm: 'DELETE' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('active_legal_hold');
  });

  test('the owner can cancel a pending deletion request', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    await request(app).post('/api/orgs/request-deletion').set('Authorization', bearer(owner)).send({ confirm: 'DELETE' });

    const res = await request(app).post('/api/orgs/cancel-deletion').set('Authorization', bearer(owner));
    expect(res.status).toBe(200);
    const updated = await prisma.organization.findUnique({ where: { id: org.id } });
    expect(updated.scheduledDeletionAt).toBeNull();
    expect(updated.deletionRequestedAt).toBeNull();
  });

  test('canceling when nothing is scheduled 404s', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const res = await request(app).post('/api/orgs/cancel-deletion').set('Authorization', bearer(owner));
    expect(res.status).toBe(404);
  });
});

describe('Idempotency-Key on POST', () => {
  test('repeating the same key returns the same created row, not a duplicate', async () => {
    const { user } = await makeOrgWithMember('owner');
    const key = crypto.randomUUID();
    const r1 = await request(app).post('/api/customers').set('Authorization', bearer(user)).set('Idempotency-Key', key).send({ name: 'Idempotent Co' });
    const r2 = await request(app).post('/api/customers').set('Authorization', bearer(user)).set('Idempotency-Key', key).send({ name: 'Idempotent Co' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);

    const count = await prisma.customer.count({ where: { orgId: user.orgId, name: 'Idempotent Co' } });
    expect(count).toBe(1);
  });
});
