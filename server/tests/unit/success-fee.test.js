const { computeSuccessFee, maybeRecordEarnedRevenue } = require('../../lib/success-fee');

describe('computeSuccessFee', () => {
  test('rate applied to collected amount, rounded to cents', () => {
    expect(computeSuccessFee(10000, 0.1)).toBe(1000);
    expect(computeSuccessFee(999.99, 0.15)).toBe(150);
  });

  test('rounds half-cent artifacts from floating point rate math', () => {
    expect(computeSuccessFee(33.33, 0.1)).toBe(3.33);
  });

  test('zero rate earns zero fee', () => {
    expect(computeSuccessFee(10000, 0)).toBe(0);
  });
});

describe('maybeRecordEarnedRevenue (fails closed)', () => {
  function fakeTx({ agreement = null } = {}) {
    return {
      successFeeAgreement: { findFirst: jest.fn().mockResolvedValue(agreement) },
      earnedRevenueEvent: { create: jest.fn().mockResolvedValue({ id: 'ere_1' }) },
    };
  }

  test('returns null and never queries an agreement when payer_type is not "customer"', async () => {
    const tx = fakeTx();
    const result = await maybeRecordEarnedRevenue(tx, {
      orgId: 'org1', outcome: { id: 'o1', payer_type: 'insurance' }, transition: { id: 't1' }, collectedAmount: 1000,
    });
    expect(result).toBeNull();
    expect(tx.successFeeAgreement.findFirst).not.toHaveBeenCalled();
  });

  test('returns null when payer_type is null/unset', async () => {
    const tx = fakeTx();
    const result = await maybeRecordEarnedRevenue(tx, {
      orgId: 'org1', outcome: { id: 'o1', payer_type: null }, transition: { id: 't1' }, collectedAmount: 1000,
    });
    expect(result).toBeNull();
  });

  test('returns null when payer_type is customer but no active agreement exists', async () => {
    const tx = fakeTx({ agreement: null });
    const result = await maybeRecordEarnedRevenue(tx, {
      orgId: 'org1', outcome: { id: 'o1', payer_type: 'customer' }, transition: { id: 't1' }, collectedAmount: 1000,
    });
    expect(result).toBeNull();
  });

  test('creates an EarnedRevenueEvent when payer_type is customer and an active agreement exists', async () => {
    const agreement = { id: 'agr1', ratePercent: 0.1 };
    const tx = fakeTx({ agreement });
    await maybeRecordEarnedRevenue(tx, {
      orgId: 'org1', outcome: { id: 'o1', payer_type: 'customer' }, transition: { id: 't1' }, collectedAmount: 5000,
    });
    expect(tx.earnedRevenueEvent.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org1', commercialOutcomeId: 'o1', stageTransitionId: 't1',
        successFeeAgreementId: 'agr1', collectedAmount: 5000, ratePercent: 0.1, feeAmount: 500,
      },
    });
  });
});
