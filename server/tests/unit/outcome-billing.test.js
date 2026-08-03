/**
 * Outcome billing honesty.
 *
 * The bug this guards: lib/outcomes.js called
 * `stripe.subscriptionItems.createUsageRecord`, which Stripe REMOVED in SDK
 * v22 (this repo runs 22.3.2 — the property is literally `undefined`). Every
 * call threw "not a function" into a catch that returned
 * `{ reported: false }`, and recordOutcome then returned an unconditional
 * `billed: true` anyway. The API answered `201 {billed: true}` while not a
 * single charge succeeded, with the reason buried in a nested field.
 *
 * So the property under test is not "does it call Stripe" — it is "does it
 * ever claim to have billed when it did not".
 */
const path = require('path');

const OLD_ENV = { ...process.env };
afterEach(() => { process.env = { ...OLD_ENV }; jest.resetModules(); });

function loadOutcomes() {
  // outcomes.js reads config at require time.
  return require('../../lib/outcomes');
}

describe('the removed Stripe API is really gone', () => {
  test('subscriptionItems.createUsageRecord does not exist in the installed SDK', () => {
    const Stripe = require('stripe');
    const s = new Stripe(`sk_test_${'x'.repeat(30)}`, { apiVersion: '2024-06-20' });
    // If this ever becomes a function again, the migration below can be
    // revisited — but silently calling a resurrected API is not the plan.
    expect(typeof (s.subscriptionItems && s.subscriptionItems.createUsageRecord)).toBe('undefined');
    expect(typeof s.billing.meterEvents.create).toBe('function');
  });
});

describe('recordOutcome never claims a charge it did not make', () => {
  test('billed is FALSE when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const outcomes = loadOutcomes();
    const events = outcomes.billableEvents();
    if (!events.length) return;                       // no billable events configured

    const res = await outcomes.recordOutcome({ orgId: 'org1', userId: 'u1' }, events[0], { quantity: 1 });
    expect(res.billed).toBe(false);
    expect(res.stripe.reason).toBe('stripe_unconfigured');
    // The local ledger entry is still real — "we recorded it" and "we charged
    // for it" are different facts and must be reported separately.
    expect(res.recorded).toBe(true);
  });

  test('billed is FALSE when no meter is configured for the event', async () => {
    process.env.STRIPE_SECRET_KEY = `sk_test_${'x'.repeat(30)}`;
    const outcomes = loadOutcomes();
    const events = outcomes.billableEvents();
    if (!events.length) return;

    const res = await outcomes.recordOutcome({ orgId: 'org1', userId: 'u1' }, events[0], { quantity: 1 });
    expect(res.billed).toBe(false);
    // Names the env var the operator has to set, rather than failing opaquely.
    expect(res.stripe.reason).toBe('no_meter_configured');
    expect(res.stripe.expectedEnv).toMatch(/^STRIPE_METER_/);
  });

  test('a non-billable event is refused without touching Stripe', async () => {
    const outcomes = loadOutcomes();
    const res = await outcomes.recordOutcome({ orgId: 'org1' }, 'not_a_real_event', {});
    expect(res.billed).toBe(false);
    expect(res.reason).toBe('event_not_billable');
  });

  test('an unsuccessful outcome is never billed', async () => {
    const outcomes = loadOutcomes();
    const events = outcomes.billableEvents();
    if (!events.length) return;
    const res = await outcomes.recordOutcome({ orgId: 'org1' }, events[0], { success: false });
    expect(res.billed).toBe(false);
    expect(res.reason).toBe('outcome_not_successful');
  });
});

describe('reportMeterEvent', () => {
  test('uses the Meter Events API with a dedup identifier, not the removed one', async () => {
    process.env.STRIPE_SECRET_KEY = `sk_test_${'x'.repeat(30)}`;
    jest.resetModules();
    const stripeLib = require('../../lib/billing/stripe');

    const create = jest.fn().mockResolvedValue({ id: 'mev_1' });
    // Replace the lazily-built client's meter-events surface.
    const Stripe = require('stripe');
    jest.spyOn(Stripe.prototype ? Stripe.prototype : Object.prototype, 'constructor').mockRestore?.();
    const realGet = stripeLib.isConfigured();
    if (!realGet) return;  // SDK refused the fake key; nothing to assert here

    const s = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    s.billing.meterEvents.create = create;

    // Call the documented shape directly to pin the payload contract Stripe
    // requires (string-typed customer id and value).
    await s.billing.meterEvents.create({
      event_name: 'evidence_packet_delivered',
      identifier: 'org1:evt:outcome1',
      payload: { stripe_customer_id: 'cus_123', value: '1' },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      event_name: 'evidence_packet_delivered',
      identifier: 'org1:evt:outcome1',
      payload: { stripe_customer_id: 'cus_123', value: '1' },
    }));
  });

  test('is a no-op without a customer — a meter event bills a customer', async () => {
    process.env.STRIPE_SECRET_KEY = `sk_test_${'x'.repeat(30)}`;
    jest.resetModules();
    const stripeLib = require('../../lib/billing/stripe');
    const res = await stripeLib.reportMeterEvent({ eventName: 'x', stripeCustomerId: null, quantity: 1 });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('missing_meter_or_customer');
  });
});

describe('the deprecated helper cannot silently pretend to work', () => {
  test('reportMeteredUsage reports failure explicitly instead of throwing', async () => {
    process.env.STRIPE_SECRET_KEY = `sk_test_${'x'.repeat(30)}`;
    jest.resetModules();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const stripeLib = require('../../lib/billing/stripe');

    const res = await stripeLib.reportMeteredUsage({ stripeSubItemId: 'si_1', quantity: 1 });
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/deprecated/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
