/**
 * Money arithmetic in lib/pricing.js.
 *
 * These values are real dollars: they persist to Float columns (38 of them in
 * the schema, zero Decimal), sum into evidence-packet totals a contractor
 * hands to a customer, feed the six-stage commercial-outcome ledger, and are
 * the input to lib/success-fee.js#computeSuccessFee — which rounds, but only
 * at the very end, so it rounds an already-drifted number.
 *
 * There was no unit test for any of it. This file establishes the baseline
 * BEFORE any migration to integer cents, so the migration has something to be
 * checked against rather than being a leap of faith.
 *
 * Where a case documents real IEEE-754 drift, the assertion is written to show
 * the drift rather than hide it behind toBeCloseTo. A test that rounds away
 * the very defect it exists to characterise is worse than no test.
 */
const { computeCostItemPricing } = require('../../lib/pricing');

const cents = (n) => Math.round(n * 100);

describe('computeCostItemPricing — basic correctness', () => {
  test('derives total from unit cost and quantity', () => {
    const r = computeCostItemPricing({ unitCost: 100, quantity: 3 });
    expect(r.totalCost).toBe(300);
    expect(r.billedTotal).toBe(300);
  });

  test('an explicit totalCost wins over unitCost * quantity', () => {
    const r = computeCostItemPricing({ unitCost: 100, quantity: 3, totalCost: 250 });
    expect(r.totalCost).toBe(250);
  });

  test('quantity defaults to 1', () => {
    expect(computeCostItemPricing({ unitCost: 42 }).totalCost).toBe(42);
  });

  test('returns all-null when there is nothing to price', () => {
    expect(computeCostItemPricing({})).toEqual({
      totalCost: null, markupAmount: null, taxAmount: null, billedTotal: null,
    });
  });

  test('tax applies to cost PLUS markup, not cost alone', () => {
    // Order matters commercially: taxing pre-markup would under-bill.
    const r = computeCostItemPricing({ totalCost: 1000, markupRate: 0.2, taxRate: 0.1 });
    expect(r.markupAmount).toBe(200);
    expect(r.taxAmount).toBeCloseTo(120, 10);   // (1000 + 200) * 0.10
    expect(r.billedTotal).toBeCloseTo(1320, 10);
  });

  test('markup without tax, and tax without markup, both work', () => {
    expect(computeCostItemPricing({ totalCost: 1000, markupRate: 0.15 }).billedTotal).toBe(1150);
    expect(computeCostItemPricing({ totalCost: 1000, taxRate: 0.08 }).billedTotal).toBe(1080);
  });
});

describe('IEEE-754 drift — characterising what float arithmetic actually does', () => {
  test('a single realistic line item already lands off an exact cent', () => {
    // 8.25% tax on a $1,234.56 item with 15% markup — an ordinary invoice line.
    //   markup  = 1234.56 * 0.15   =  185.184
    //   taxable = 1234.56 + 185.184 = 1419.744
    //   tax     = 1419.744 * 0.0825 =  117.12888
    //   total   =                     1536.87288  -> $1536.87
    const r = computeCostItemPricing({ totalCost: 1234.56, markupRate: 0.15, taxRate: 0.0825 });
    expect(cents(r.billedTotal)).toBe(153687);
    // Rounded it is right; stored it is not. billedTotal persists to a Float
    // column at full precision, sub-cent tail and all — 1536.87288..., never
    // an exact number of cents. That residue is what accumulates downstream.
    expect(Number.isInteger(r.billedTotal * 100)).toBe(false);
  });

  test('summing many line items accumulates visible error', () => {
    // A packet totals its items. 1000 identical lines is a large but entirely
    // possible job, and float addition is not associative.
    const line = computeCostItemPricing({ totalCost: 0.1, markupRate: 0.1 }).billedTotal;
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += line;

    const exact = 110;                                   // 1000 * 0.11
    expect(sum).not.toBe(exact);                          // drift is real
    expect(Math.abs(sum - exact)).toBeLessThan(0.01);     // and currently sub-cent
    // Rounding only at the end still lands correctly at THIS scale — which is
    // exactly why the bug is invisible until it isn't.
    expect(cents(sum)).toBe(11000);
  });

  test('the classic 0.1 + 0.2 case is reachable through this function', () => {
    const r = computeCostItemPricing({ unitCost: 0.1, quantity: 3 });
    // 0.1 * 3 is not 0.30000000000000004's sibling by accident — it is what
    // gets written to the database.
    expect(r.totalCost).not.toBe(0.3);
    expect(r.totalCost).toBeCloseTo(0.3, 10);
  });

  test('nothing in the pricing path rounds — values persist at full precision', () => {
    // Confirms the property a cents migration would change. If someone adds
    // rounding inside computeCostItemPricing, this test should fail and be
    // deliberately updated, not silently pass.
    const r = computeCostItemPricing({ totalCost: 100, markupRate: 1 / 3 });
    expect(String(r.markupAmount)).toMatch(/33\.33333/);
    // Not rounded — it keeps every bit it computed.
    expect(Number.isInteger(r.markupAmount)).toBe(false);
    // And a demonstration of why "just use floats carefully" is not a plan:
    // 100 * (1/3) is NOT the same double as 100/3. Multiplying by a stored
    // rate and dividing are different operations with different results, so
    // two code paths that look equivalent can disagree in the last bits — and
    // both get written to the database.
    expect(r.markupAmount).not.toBe(100 / 3);
    expect(r.markupAmount).toBeCloseTo(100 / 3, 10);
  });
});

describe('degenerate and hostile inputs', () => {
  test('zero cost prices to zero, not null', () => {
    const r = computeCostItemPricing({ totalCost: 0, markupRate: 0.2, taxRate: 0.1 });
    expect(r.totalCost).toBe(0);
    expect(r.billedTotal).toBe(0);
  });

  test('a negative quantity produces a negative total rather than being rejected', () => {
    // Documenting current behaviour, not endorsing it: nothing upstream
    // forbids this, so a credit/refund line is representable — and so is a
    // typo. Worth knowing before the cents migration decides what to do.
    expect(computeCostItemPricing({ unitCost: 100, quantity: -2 }).totalCost).toBe(-200);
  });

  test('very large values stay finite and exact to the cent', () => {
    const r = computeCostItemPricing({ totalCost: 9_999_999.99, markupRate: 0.1 });
    expect(Number.isFinite(r.billedTotal)).toBe(true);
    expect(cents(r.billedTotal)).toBe(1099999999);
  });
});
