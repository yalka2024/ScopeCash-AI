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

describe('enforceDataRetention', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => { process.env = { ...OLD_ENV }; });

  test('is report-only by default: flags expired evidence without deleting it', async () => {
    delete process.env.DATA_RETENTION_ENFORCE;
    const prisma = require('../../lib/prisma');
    jest.spyOn(prisma.organization, 'findMany').mockResolvedValue([{ id: 'org1' }]);
    jest.spyOn(prisma.subscription, 'findFirst').mockResolvedValue(null);
    jest.spyOn(prisma.evidenceItem, 'findMany').mockResolvedValue([
      { id: 'a', storageUri: 'a.jpg' }, { id: 'b', storageUri: 'b.jpg' },
      { id: 'c', storageUri: 'c.jpg' }, { id: 'd', storageUri: 'd.jpg' },
    ]);
    jest.spyOn(prisma.sourceDocument, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.retentionLegalHold, 'findMany').mockResolvedValue([]);
    const storage = require('../../lib/storage');
    const delObj = jest.spyOn(storage, 'deleteObject').mockResolvedValue({});
    const del = jest.spyOn(prisma.evidenceItem, 'deleteMany').mockResolvedValue({ count: 4 });

    const res = await require('../../jobs/usage-aggregator').enforceDataRetention();
    expect(res.enforcing).toBe(false);
    expect(res.expired).toBe(4);
    expect(res.deleted).toBe(0);
    expect(del).not.toHaveBeenCalled();     // the whole point: no silent data destruction
    expect(delObj).not.toHaveBeenCalled();  // and no bytes removed either
    jest.restoreAllMocks();
  });

  test('deletes only when the operator has explicitly opted in', async () => {
    process.env.DATA_RETENTION_ENFORCE = '1';
    const prisma = require('../../lib/prisma');
    jest.spyOn(prisma.organization, 'findMany').mockResolvedValue([{ id: 'org1' }]);
    jest.spyOn(prisma.subscription, 'findFirst').mockResolvedValue(null);
    jest.spyOn(prisma.evidenceItem, 'findMany').mockResolvedValue([
      { id: 'a', storageUri: 'a.jpg' }, { id: 'b', storageUri: 'b.jpg' },
      { id: 'c', storageUri: 'c.jpg' }, { id: 'd', storageUri: 'd.jpg' },
    ]);
    jest.spyOn(prisma.sourceDocument, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.retentionLegalHold, 'findMany').mockResolvedValue([]);
    jest.spyOn(require('../../lib/storage'), 'deleteObject').mockResolvedValue({});
    const del = jest.spyOn(prisma.evidenceItem, 'deleteMany').mockResolvedValue({ count: 4 });
    jest.spyOn(prisma.sourceDocument, 'deleteMany').mockResolvedValue({ count: 0 });

    const res = await require('../../jobs/usage-aggregator').enforceDataRetention();
    expect(res.enforcing).toBe(true);
    expect(res.deleted).toBe(4);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0].where.id.in).toEqual(['a', 'b', 'c', 'd']);
    // The date filter is what SELECTS candidates...
    const selectWhere = prisma.evidenceItem.findMany.mock.calls[0][0].where;
    expect(selectWhere.orgId).toBe('org1');
    expect(selectWhere.createdAt.lt).toBeInstanceOf(Date);
    jest.restoreAllMocks();
  });

  test('skips orgs whose plan reports no retention window rather than deleting everything', async () => {
    process.env.DATA_RETENTION_ENFORCE = '1';
    const prisma = require('../../lib/prisma');
    jest.spyOn(prisma.organization, 'findMany').mockResolvedValue([{ id: 'org1' }]);
    // A plan id that isn't in the catalog resolves to a tier with no usable
    // retention limit — the sweep must skip, not treat it as "delete all".
    jest.spyOn(prisma.subscription, 'findFirst').mockResolvedValue({ orgId: 'org1', planId: 'nonexistent-plan', status: 'active' });
    jest.spyOn(require('../../lib/entitlements'), 'getTier').mockReturnValue({ limits: {} });
    const del = jest.spyOn(prisma.evidenceItem, 'deleteMany').mockResolvedValue({ count: 0 });

    const res = await require('../../jobs/usage-aggregator').enforceDataRetention();
    expect(res.expired).toBe(0);
    expect(del).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe('enforceDataRetention: safety guards', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => { process.env = { ...OLD_ENV }; jest.restoreAllMocks(); });

  test('uses the CONTRACTED plan window, so suspension cannot collapse 7 years to 30 days', async () => {
    process.env.DATA_RETENTION_ENFORCE = '1';
    const prisma = require('../../lib/prisma');
    jest.spyOn(prisma.organization, 'findMany').mockResolvedValue([{ id: 'org1' }]);
    // Suspended enterprise sub: ent.getLimit() would report free's 30 days.
    jest.spyOn(prisma.subscription, 'findFirst').mockResolvedValue({ orgId: 'org1', planId: 'enterprise', status: 'suspended' });
    jest.spyOn(prisma.evidenceItem, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.sourceDocument, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.retentionLegalHold, 'findMany').mockResolvedValue([]);

    await require('../../jobs/usage-aggregator').enforceDataRetention();
    // The cutoff handed to the query must reflect enterprise's 2555 days.
    const cutoff = prisma.evidenceItem.findMany.mock.calls[0][0].where.createdAt.lt;
    const ageDays = (Date.now() - cutoff.getTime()) / 86400000;
    expect(Math.round(ageDays)).toBe(2555);
  });

  test('never deletes a resource under an active legal hold', async () => {
    process.env.DATA_RETENTION_ENFORCE = '1';
    const prisma = require('../../lib/prisma');
    jest.spyOn(prisma.organization, 'findMany').mockResolvedValue([{ id: 'org1' }]);
    jest.spyOn(prisma.subscription, 'findFirst').mockResolvedValue(null);
    jest.spyOn(prisma.evidenceItem, 'findMany').mockResolvedValue([
      { id: 'keep', storageUri: 'k.jpg' }, { id: 'drop', storageUri: 'd.jpg' },
    ]);
    jest.spyOn(prisma.sourceDocument, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.retentionLegalHold, 'findMany').mockResolvedValue([
      { resourceType: 'evidenceItem', resourceId: 'keep' },
    ]);
    const storage = require('../../lib/storage');
    const delObj = jest.spyOn(storage, 'deleteObject').mockResolvedValue({});
    const delEv = jest.spyOn(prisma.evidenceItem, 'deleteMany').mockResolvedValue({ count: 1 });
    jest.spyOn(prisma.sourceDocument, 'deleteMany').mockResolvedValue({ count: 0 });

    const res = await require('../../jobs/usage-aggregator').enforceDataRetention();

    // Deleted by explicit id, and the held row is not among them.
    expect(delEv.mock.calls[0][0].where.id.in).toEqual(['drop']);
    expect(res.expired).toBe(1);
    // The held object's bytes must survive too, not just its row.
    expect(delObj.mock.calls.map(c => c[0])).toEqual(['d.jpg']);
  });

  test('deletes the stored object as well as the row, so the bytes really go', async () => {
    process.env.DATA_RETENTION_ENFORCE = '1';
    const prisma = require('../../lib/prisma');
    jest.spyOn(prisma.organization, 'findMany').mockResolvedValue([{ id: 'org1' }]);
    jest.spyOn(prisma.subscription, 'findFirst').mockResolvedValue(null);
    jest.spyOn(prisma.evidenceItem, 'findMany').mockResolvedValue([{ id: 'e1', storageUri: 'e1.jpg' }]);
    jest.spyOn(prisma.sourceDocument, 'findMany').mockResolvedValue([{ id: 'd1', storage_uri: 'd1.pdf' }]);
    jest.spyOn(prisma.retentionLegalHold, 'findMany').mockResolvedValue([]);
    const storage = require('../../lib/storage');
    const delObj = jest.spyOn(storage, 'deleteObject').mockResolvedValue({});
    jest.spyOn(prisma.evidenceItem, 'deleteMany').mockResolvedValue({ count: 1 });
    jest.spyOn(prisma.sourceDocument, 'deleteMany').mockResolvedValue({ count: 1 });

    const res = await require('../../jobs/usage-aggregator').enforceDataRetention();
    expect(res.deleted).toBe(2);
    expect(delObj.mock.calls.map(c => c[0]).sort()).toEqual(['d1.pdf', 'e1.jpg']);
  });
});
