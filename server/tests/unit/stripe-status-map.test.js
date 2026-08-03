/**
 * Stripe subscription status -> entitlement status.
 *
 * This map is the only thing between a status string Stripe sends and paid
 * access: lib/entitlements.js grants the paid tier iff the mapped status is in
 * LIVE_STATUSES, and falls back to the free tier otherwise. The map used to
 * end in `default: return 'active'`, so every status nobody had enumerated
 * granted the full paid tier.
 *
 * The concrete case was `paused` — Stripe's pause_collection state, i.e. "we
 * are deliberately not billing this customer" — which came out `active`.
 */
const { mapStripeStatus, STRIPE_STATUS_MAP } = require('../../routes/stripe-webhook');
const { LIVE_STATUSES } = require('../../lib/entitlements');

describe('mapStripeStatus', () => {
  test('maps every status Stripe documents', () => {
    // If Stripe adds one, this list is where it gets noticed.
    expect(Object.keys(STRIPE_STATUS_MAP).sort()).toEqual([
      'active', 'canceled', 'incomplete', 'incomplete_expired',
      'past_due', 'paused', 'trialing', 'unpaid',
    ]);
  });

  test('paying states stay live; non-paying states do not', () => {
    for (const s of ['trialing', 'active', 'past_due', 'unpaid', 'incomplete']) {
      expect(LIVE_STATUSES).toContain(mapStripeStatus(s));
    }
    for (const s of ['canceled', 'incomplete_expired', 'paused']) {
      expect(LIVE_STATUSES).not.toContain(mapStripeStatus(s));
    }
  });

  test('past_due and unpaid stay live on purpose', () => {
    // Dunning owns the downgrade schedule (lib/billing/dunning.js): past_due
    // -> grace -> suspended over a set number of days. Cutting access off the
    // instant a card fails would pre-empt that, so these deliberately remain
    // live and let dunning decide when access ends.
    expect(mapStripeStatus('past_due')).toBe('past_due');
    expect(mapStripeStatus('unpaid')).toBe('grace');
  });

  test('paused does NOT grant paid access', () => {
    // The regression this file exists for.
    expect(mapStripeStatus('paused')).toBe('paused');
    expect(mapStripeStatus('paused')).not.toBe('active');
  });

  describe('unknown statuses', () => {
    let err;
    beforeEach(() => { err = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => err.mockRestore());

    test('do not grant paid access', () => {
      for (const s of ['some_future_status', '', null, undefined, 'ACTIVE']) {
        expect(LIVE_STATUSES).not.toContain(mapStripeStatus(s));
      }
    });

    test('are loud, so the mapping gets added rather than silently withheld', () => {
      // Fail-closed is only defensible if somebody finds out. The alerting
      // policy watches for this log type.
      mapStripeStatus('some_future_status');
      const logged = JSON.parse(err.mock.calls[0][0]);
      expect(logged.severity).toBe('ERROR');
      expect(logged.type).toBe('stripe_status_unmapped');
      expect(logged.stripeStatus).toBe('some_future_status');
    });

    test('are case-sensitive rather than guessed at', () => {
      // 'ACTIVE' is not a Stripe status. Case-folding to be helpful would be
      // guessing at a billing signal; better to reject and log it.
      expect(mapStripeStatus('ACTIVE')).toBe('unknown');
    });
  });
});
