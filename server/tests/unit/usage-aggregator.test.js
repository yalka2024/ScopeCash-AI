const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const aggregator = require('../../jobs/usage-aggregator');
const aiBudget = require('../../lib/ai-budget');
const cost = require('../../lib/cost-attribution');

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

afterAll(async () => {
  await prisma.$disconnect();
});

describe('checkAiSpendReconciliation (usage-aggregator job)', () => {
  // checkAiSpendReconciliation() always checks the REAL current period
  // (matching what an hourly job would do) across ALL orgs with no filter
  // -- by design, the same as reconcileAiSpend()'s own global aggregation.
  // That means result.all_reconciled is shared, cross-test-file state for
  // "current period" and can't be asserted on directly here (another test
  // file's deliberately-mismatched fixture for the same period would make
  // it false regardless of what THIS test seeded). Assertions below scope
  // to this test's own org row instead, the same discipline
  // cost-attribution.test.js's reconcileAiSpend tests already use.

  test('this org\'s row reconciles when AiSpendEvent and TenantCostEvent agree', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    const period = cost.currentPeriodKey();
    await aiBudget.recordAiSpend({ orgId: org.id, modelId: 'gemini-flash', provider: 'vertex', promptTokens: 100, completionTokens: 100, ucents: 50, period });

    const result = await aggregator.checkAiSpendReconciliation();
    const row = result.orgs.find((o) => o.orgId === org.id);
    expect(row).toBeTruthy();
    expect(row.reconciled).toBe(true);
  });

  test('drift between AiSpendEvent and TenantCostEvent for this org is surfaced and logs a warning', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    const period = cost.currentPeriodKey();
    await prisma.aiSpendEvent.create({ data: { orgId: org.id, promptTokens: 500, completionTokens: 500, totalTokens: 1000, ucents: 140, period } });
    await prisma.tenantCostEvent.create({ data: { orgId: org.id, resource: 'ai_tokens', quantity: 1000, ucents: 2000, period } });

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await aggregator.checkAiSpendReconciliation();
    const drift = spy.mock.calls.some((c) => String(c[0]).includes('ai_spend_reconciliation_drift'));
    spy.mockRestore();

    const row = result.orgs.find((o) => o.orgId === org.id);
    expect(row.reconciled).toBe(false);
    expect(drift).toBe(true); // this test's own drift is guaranteed to trigger the log regardless of other test pollution
  });
});
