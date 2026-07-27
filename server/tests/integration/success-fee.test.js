/**
 * Success-fee/earned-revenue accounting (TODO.md). A ground-up build, not a
 * dormant-code activation like several other P2 items — there was no
 * existing field/config to wire up. Two compliance requirements from
 * platform-manifest.json's public-adjuster-statute clauses drive the
 * design, both enforced in code rather than left to convention:
 *
 *  - "Success fee must not be enabled by default and requires separately
 *    accepted written agreement" — modeled as a real SuccessFeeAgreement
 *    acceptance record (who, when, what rate), created only by an explicit,
 *    confirmed POST /api/successFeeAgreements from an owner/admin (routes/
 *    success-fee.js). Nothing ever creates one implicitly.
 *  - "Success fee must not be charged against insurance-paid outcomes
 *    without legal review" — lib/success-fee.js#maybeRecordEarnedRevenue
 *    fails closed: a fee is only ever computed when CommercialOutcome.
 *    payer_type is explicitly 'customer'. null/unset/'insurance' all
 *    produce zero fee.
 *
 * EarnedRevenueEvent is tied to a specific StageTransition (not just the
 * outcome) because /commercialOutcomes/:id/transition allows re-collecting
 * (correcting) the same outcome more than once — each correction is its
 * own earning event, not a silent overwrite.
 */
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');

const entityRoutes = require('../../routes/entities');
const successFeeRoutes = require('../../routes/success-fee');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/successFeeAgreements', successFeeRoutes);
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

async function makeProject(owner) {
  const cust = await request(app).post('/api/customers').set('Authorization', bearer(owner)).send({ name: 'C' });
  const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(owner)).send({ customer_id: cust.body.id, name: 'P' });
  return proj.body;
}

async function acceptAgreement(owner, ratePercent = 0.1) {
  return request(app).post('/api/successFeeAgreements').set('Authorization', bearer(owner))
    .send({ ratePercent, acceptAgreement: true });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('success-fee agreement lifecycle', () => {
  test('owner can accept a new agreement, creating a real acceptance record', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const res = await acceptAgreement(owner, 0.12);
    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.ratePercent).toBe(0.12);
    expect(res.body.active).toBe(true);
    expect(res.body.acceptedByUserId).toBe(owner.id);
    expect(res.body.acceptedAt).toBeTruthy();
  });

  test('a non-owner/admin role (project_manager) cannot accept an agreement', async () => {
    const { user: pm } = await makeOrgWithMember('project_manager');
    const res = await acceptAgreement(pm);
    expect(res.status).toBe(403);
  });

  test('acceptance requires the exact acceptAgreement:true confirmation, not just a rate', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const res = await request(app).post('/api/successFeeAgreements').set('Authorization', bearer(owner)).send({ ratePercent: 0.1 });
    expect(res.status).toBe(400);
    const rows = await prisma.successFeeAgreement.findMany({ where: { orgId: owner.orgId } });
    expect(rows).toHaveLength(0);
  });

  test('re-accepting supersedes the prior agreement — at most one active row per org', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const first = await acceptAgreement(owner, 0.1);
    const second = await acceptAgreement(owner, 0.15);
    expect(second.status).toBe(201);

    const rows = await prisma.successFeeAgreement.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first.body.id);
    expect(rows[0].active).toBe(false);
    expect(rows[0].deactivatedAt).toBeTruthy();
    expect(rows[1].id).toBe(second.body.id);
    expect(rows[1].active).toBe(true);
  });

  test('owner can deactivate an active agreement; a second deactivate is a harmless no-op', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const created = await acceptAgreement(owner);
    const deactivate = await request(app).post(`/api/successFeeAgreements/${created.body.id}/deactivate`).set('Authorization', bearer(owner));
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.active).toBe(false);

    const again = await request(app).post(`/api/successFeeAgreements/${created.body.id}/deactivate`).set('Authorization', bearer(owner));
    expect(again.status).toBe(200);
    expect(again.body.active).toBe(false);
  });

  test('GET only returns the calling org\'s own agreements', async () => {
    const { user: ownerA } = await makeOrgWithMember('owner');
    const { user: ownerB } = await makeOrgWithMember('owner');
    await acceptAgreement(ownerA);
    await acceptAgreement(ownerB);

    const listA = await request(app).get('/api/successFeeAgreements').set('Authorization', bearer(ownerA));
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].orgId).toBe(ownerA.orgId);
  });

  test('EarnedRevenueEvent is a read-only entity — no generic write route exists for it', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const res = await request(app).post('/api/earnedRevenueEvents').set('Authorization', bearer(owner)).send({ feeAmount: 999 });
    expect(res.status).toBe(404);
  });
});

describe('fee computation on collection (fail-closed by payer_type + active agreement)', () => {
  test('payer_type=customer + an active agreement earns a fee on collection', async () => {
    const { org, user: owner } = await makeOrgWithMember('owner');
    const agreement = await acceptAgreement(owner, 0.1);
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'customer' });
    const outcomeId = outcomeRes.body.id;

    const t = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeTruthy();
    expect(t.body.earnedRevenueEvent.feeAmount).toBe(1000);
    expect(t.body.earnedRevenueEvent.ratePercent).toBe(0.1);
    expect(t.body.earnedRevenueEvent.successFeeAgreementId).toBe(agreement.body.id);
    expect(t.body.earnedRevenueEvent.stageTransitionId).toBe(t.body.transition.id);

    const rows = await prisma.earnedRevenueEvent.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(1);
  });

  test('payer_type left unset never earns a fee, even with an active agreement', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    await acceptAgreement(owner);
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner)).send({ project_id: proj.id });

    const t = await request(app).post(`/api/commercialOutcomes/${outcomeRes.body.id}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeNull();
  });

  test('payer_type=insurance never earns a fee, even with an active agreement (public-adjuster-statute requirement)', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    await acceptAgreement(owner);
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'insurance' });

    const t = await request(app).post(`/api/commercialOutcomes/${outcomeRes.body.id}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeNull();

    const rows = await prisma.earnedRevenueEvent.findMany({ where: { commercialOutcomeId: outcomeRes.body.id } });
    expect(rows).toHaveLength(0);
  });

  test('payer_type=customer but no active agreement (never accepted) never earns a fee — off by default', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'customer' });

    const t = await request(app).post(`/api/commercialOutcomes/${outcomeRes.body.id}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeNull();
  });

  test('payer_type=customer but the agreement was deactivated before collection never earns a fee', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const agreement = await acceptAgreement(owner);
    await request(app).post(`/api/successFeeAgreements/${agreement.body.id}/deactivate`).set('Authorization', bearer(owner));
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'customer' });

    const t = await request(app).post(`/api/commercialOutcomes/${outcomeRes.body.id}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeNull();
  });

  test('re-collecting (a correction) records a SECOND EarnedRevenueEvent tied to the new transition, not the first', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    await acceptAgreement(owner, 0.1);
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'customer' });
    const outcomeId = outcomeRes.body.id;

    const t1 = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    const t2 = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 12000, reason: 'correction — additional payment received' });
    expect(t2.status).toBe(200);
    expect(t2.body.earnedRevenueEvent.feeAmount).toBe(1200);
    expect(t2.body.earnedRevenueEvent.stageTransitionId).toBe(t2.body.transition.id);
    expect(t2.body.earnedRevenueEvent.stageTransitionId).not.toBe(t1.body.transition.id);

    const rows = await prisma.earnedRevenueEvent.findMany({ where: { commercialOutcomeId: outcomeId }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].feeAmount).toBe(1000);
    expect(rows[1].feeAmount).toBe(1200);
  });

  test('a transition to a non-collected stage never triggers fee computation', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    await acceptAgreement(owner);
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'customer' });

    const t = await request(app).post(`/api/commercialOutcomes/${outcomeRes.body.id}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'invoiced', amount: 10000 });
    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeNull();
  });

  test('SECURITY REGRESSION: the fee decision reads payer_type off this transaction\'s own write, not a stale pre-transaction snapshot (TOCTOU)', async () => {
    // Simulates a concurrent PUT /commercialOutcomes/:id flipping payer_type
    // in the window between the route's pre-transaction findFirst and the
    // transaction opening: the pre-transaction read returns a STALE
    // 'customer' snapshot, while the real, currently-committed row is
    // 'insurance'. Before the fix, maybeRecordEarnedRevenue was called with
    // that stale object and would wrongly compute a fee against an
    // insurance-paid outcome -- the exact thing payer_type exists to
    // prevent. The fix reads payer_type off `updatedOutcome` (this
    // transaction's own UPDATE result) instead, so it must see the real,
    // current 'insurance' value and record no fee.
    const { user: owner } = await makeOrgWithMember('owner');
    await acceptAgreement(owner, 0.1);
    const proj = await makeProject(owner);
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'insurance' });
    const outcomeId = outcomeRes.body.id;
    const real = await prisma.commercialOutcome.findUnique({ where: { id: outcomeId } });

    const spy = jest.spyOn(prisma.commercialOutcome, 'findFirst').mockResolvedValueOnce({ ...real, payer_type: 'customer' });
    const t = await request(app).post(`/api/commercialOutcomes/${outcomeId}/transition`).set('Authorization', bearer(owner))
      .send({ toStage: 'collected', amount: 10000 });
    spy.mockRestore();

    expect(t.status).toBe(200);
    expect(t.body.earnedRevenueEvent).toBeNull();
    const rows = await prisma.earnedRevenueEvent.findMany({ where: { commercialOutcomeId: outcomeId } });
    expect(rows).toHaveLength(0);
  });
});

describe('payer_type is a real enum, not a free-text field', () => {
  test('an unrecognized payer_type value is rejected (400), not silently stored', async () => {
    const { user: owner } = await makeOrgWithMember('owner');
    const proj = await makeProject(owner);
    const res = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer(owner))
      .send({ project_id: proj.id, payer_type: 'Customer' }); // wrong case — must not silently pass
    expect(res.status).toBe(400);
  });
});
