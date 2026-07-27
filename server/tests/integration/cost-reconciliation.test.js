/**
 * GCP billing cost-attribution reconciliation (TODO.md). The EXTERNAL half
 * of this item -- comparing ScopeCash AI's internal cost tracking against a
 * real Google Cloud Billing API invoice -- needs a live GCP billing account
 * this environment doesn't have (see TODO.md's "Not achievable by an
 * engineering agent" section; already documented there, not re-litigated
 * here).
 *
 * The achievable, real gap found by research: two independent internal
 * cost-tracking systems for the exact same AI request --
 * AiSpendEvent (lib/ai-budget.js, accurate per-model $/token pricing used
 * for budget enforcement) and TenantCostEvent's `ai_tokens` rows
 * (lib/cost-attribution.js, used for tenant gross-margin reporting) --
 * priced the SAME tokens two different ways: AiSpendEvent from the real
 * per-model rate, TenantCostEvent from a flat generic 2.0-ucents/token
 * proxy. For a flash-tier request that's roughly a 10-14x overstatement of
 * AI cost in every gross-margin calculation. Fixed by having
 * ai-budget.js#recordAiSpend() pass its already-computed accurate ucents
 * into cost-attribution.js#recordCost() (a new `ucentsOverride` param)
 * instead of letting it re-derive a different number. This file covers the
 * HTTP surface (GET /api/admin/ai/reconciliation); tests/unit/
 * cost-attribution.test.js covers the underlying fix and reconcileAiSpend()
 * itself in detail.
 */
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const aiBudget = require('../../lib/ai-budget');
const cost = require('../../lib/cost-attribution');

const aiAdminRoutes = require('../../routes/ai-admin');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/ai', aiAdminRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

async function makeUser(role) {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({
    data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role, orgId: org.id, emailVerified: true },
  });
  return { org, user };
}

function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/admin/ai/reconciliation', () => {
  test('requires platform-admin role, same as every other route in this file', async () => {
    const { user } = await makeUser('user');
    const res = await request(app).get('/api/admin/ai/reconciliation').set('Authorization', bearer(user));
    expect(res.status).toBe(403);
  });

  test('an admin sees the reconciled figures for a real AI-spend event', async () => {
    const { org, user: admin } = await makeUser('admin');
    const period = cost.currentPeriodKey();
    await aiBudget.recordAiSpend({
      orgId: org.id, modelId: 'gemini-flash', provider: 'vertex',
      promptTokens: 500, completionTokens: 500, ucents: 140, period,
    });

    const res = await request(app).get(`/api/admin/ai/reconciliation?period=${period}`).set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.period).toBe(period);
    const row = res.body.orgs.find((o) => o.orgId === org.id);
    expect(row).toBeTruthy();
    expect(row.reconciled).toBe(true);
    expect(row.delta_usd).toBe(0);
  });

  test('drift between the two cost-tracking systems is surfaced, not hidden', async () => {
    const { org, user: admin } = await makeUser('admin');
    const period = cost.currentPeriodKey();
    await prisma.aiSpendEvent.create({ data: { orgId: org.id, promptTokens: 500, completionTokens: 500, totalTokens: 1000, ucents: 140, period } });
    await prisma.tenantCostEvent.create({ data: { orgId: org.id, resource: 'ai_tokens', quantity: 1000, ucents: 2000, period } });

    const res = await request(app).get(`/api/admin/ai/reconciliation?period=${period}`).set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.all_reconciled).toBe(false);
    const row = res.body.orgs.find((o) => o.orgId === org.id);
    expect(row.reconciled).toBe(false);
  });
});
