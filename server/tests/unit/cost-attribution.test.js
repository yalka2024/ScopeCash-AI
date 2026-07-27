const prisma = require('../../lib/prisma');
const cost = require('../../lib/cost-attribution');
const aiBudget = require('../../lib/ai-budget');
const crypto = require('crypto');

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

async function makeOrg() {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  return org.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('recordCost — ucentsOverride', () => {
  test('without an override, uses the flat per-resource rate', async () => {
    const orgId = await makeOrg();
    const period = cost.currentPeriodKey();
    const res = await cost.recordCost({ orgId, resource: 'ai_tokens', quantity: 1000 });
    expect(res.ok).toBe(true);
    expect(res.ucents).toBe(1000 * cost.rateFor('ai_tokens')); // 2.0 ucents/token by default

    const rows = await prisma.tenantCostEvent.findMany({ where: { orgId, period, resource: 'ai_tokens' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ucents).toBe(Math.round(1000 * cost.rateFor('ai_tokens')));
  });

  test('with an override, uses the caller-supplied ucents instead of the flat rate', async () => {
    const orgId = await makeOrg();
    // Deliberately far from what the flat rate would produce (1000 * 2.0 = 2000)
    // to prove the override, not the rate table, determined the stored value.
    const res = await cost.recordCost({ orgId, resource: 'ai_tokens', quantity: 1000, ucentsOverride: 140 });
    expect(res.ok).toBe(true);
    expect(res.ucents).toBe(140);

    const rows = await prisma.tenantCostEvent.findMany({ where: { orgId, resource: 'ai_tokens' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ucents).toBe(140);
    expect(rows[0].quantity).toBe(1000); // units are still recorded accurately
  });
});

describe('recordAiSpend — mirrors the authoritative ucents into cost-attribution (regression)', () => {
  test('AiSpendEvent and the mirrored TenantCostEvent row carry the SAME ucents, not independently-derived values', async () => {
    const orgId = await makeOrg();
    const period = cost.currentPeriodKey();
    // A flash-tier-shaped request: 500 prompt + 500 completion tokens at an
    // accurate per-model price far below the flat ai_tokens rate (2.0
    // ucents/token would give 2000; the real per-model price here is 140).
    const result = await aiBudget.recordAiSpend({
      orgId, userId: null, modelId: 'gemini-flash', provider: 'vertex',
      promptTokens: 500, completionTokens: 500, ucents: 140, period,
    });
    expect(result.ok).toBe(true);

    const spendRows = await prisma.aiSpendEvent.findMany({ where: { orgId, period } });
    expect(spendRows).toHaveLength(1);
    expect(spendRows[0].ucents).toBe(140);

    const costRows = await prisma.tenantCostEvent.findMany({ where: { orgId, period, resource: 'ai_tokens' } });
    expect(costRows).toHaveLength(1);
    // Before the fix this would have been 1000 * 2.0 = 2000 (the flat rate),
    // not 140 (the real per-model price) — a ~14x overstatement.
    expect(costRows[0].ucents).toBe(140);
  });
});

describe('reconcileAiSpend', () => {
  test('a period with no data reconciles vacuously', async () => {
    const result = await cost.reconcileAiSpend('2099-01');
    expect(result.all_reconciled).toBe(true);
    expect(result.orgs).toEqual([]);
    expect(result.total_ai_spend_usd).toBe(0);
    expect(result.total_cost_attribution_usd).toBe(0);
  });

  test('matched AiSpendEvent + TenantCostEvent for an org reconciles with zero delta', async () => {
    const orgId = await makeOrg();
    const period = cost.currentPeriodKey();
    await aiBudget.recordAiSpend({ orgId, modelId: 'gemini-pro', provider: 'vertex', promptTokens: 100, completionTokens: 100, ucents: 500, period });

    const result = await cost.reconcileAiSpend(period);
    const org = result.orgs.find((o) => o.orgId === orgId);
    expect(org).toBeTruthy();
    expect(org.reconciled).toBe(true);
    expect(org.delta_usd).toBe(0);
    expect(org.ai_spend_usd).toBeCloseTo(500 / 100_000);
    expect(org.cost_attribution_usd).toBeCloseTo(500 / 100_000);
  });

  test('a deliberately mismatched pair is flagged as drift, not silently averaged away', async () => {
    const orgId = await makeOrg();
    const period = cost.currentPeriodKey();
    // Simulate the pre-fix bug directly: AiSpendEvent gets the accurate
    // price, TenantCostEvent gets a stale/wrong figure (as if some other
    // code path re-derived it independently).
    await prisma.aiSpendEvent.create({ data: { orgId, provider: 'vertex', model: 'gemini-flash', promptTokens: 500, completionTokens: 500, totalTokens: 1000, ucents: 140, period } });
    await prisma.tenantCostEvent.create({ data: { orgId, resource: 'ai_tokens', quantity: 1000, ucents: 2000, period } });

    const result = await cost.reconcileAiSpend(period);
    const org = result.orgs.find((o) => o.orgId === orgId);
    expect(org.reconciled).toBe(false);
    expect(org.delta_usd).toBeCloseTo((2000 - 140) / 100_000);
    expect(result.all_reconciled).toBe(false);
  });

  test('orgs are sorted by |delta| descending, worst drift first', async () => {
    const orgId1 = await makeOrg();
    const orgId2 = await makeOrg();
    const period = cost.currentPeriodKey();
    await prisma.aiSpendEvent.create({ data: { orgId: orgId1, promptTokens: 0, completionTokens: 0, totalTokens: 0, ucents: 100, period } });
    await prisma.tenantCostEvent.create({ data: { orgId: orgId1, resource: 'ai_tokens', quantity: 0, ucents: 150, period } }); // delta 50
    await prisma.aiSpendEvent.create({ data: { orgId: orgId2, promptTokens: 0, completionTokens: 0, totalTokens: 0, ucents: 100, period } });
    await prisma.tenantCostEvent.create({ data: { orgId: orgId2, resource: 'ai_tokens', quantity: 0, ucents: 5000, period } }); // delta 4900

    const result = await cost.reconcileAiSpend(period);
    const idx1 = result.orgs.findIndex((o) => o.orgId === orgId1);
    const idx2 = result.orgs.findIndex((o) => o.orgId === orgId2);
    expect(idx2).toBeLessThan(idx1); // orgId2's bigger drift sorts first
  });
});
