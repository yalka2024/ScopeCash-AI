/**
 * Outcome-based billing for ScopeCash AI.
 *
 * Bills per successful business outcome (e.g. "invoice_processed") instead of
 * per seat. recordOutcome() only meters outcomes confirmed successful — the
 * verification hook — so failed work is never billed. Successful, billable
 * outcomes are reported to Stripe as metered usage when configured.
 *
 * Counters are in-memory for v1; back with Prisma for durable billing history.
 */
const fs = require('fs');
const path = require('path');

function loadConfig() {
  try {
    const p = path.join(__dirname, '..', 'config', 'outcomes.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { model: raw.billing_model || 'per_seat', events: Array.isArray(raw.events) ? raw.events : [] };
  } catch { return { model: 'per_seat', events: [] }; }
}
const CONFIG = loadConfig();
const BILLABLE = new Set(CONFIG.events);

// namespace (orgId) -> Map(event -> { billed, unverified })
const _counters = new Map();
function _ns(orgId) {
  const k = orgId || 'default';
  if (!_counters.has(k)) _counters.set(k, new Map());
  return _counters.get(k);
}
function _bump(orgId, event, field, qty) {
  const ns = _ns(orgId);
  const cur = ns.get(event) || { billed: 0, unverified: 0 };
  cur[field] += qty;
  ns.set(event, cur);
  return cur;
}

function isBillable(event) { return BILLABLE.has(event); }

/**
 * Report metered usage to Stripe.
 *
 * Uses the Meter Events API. The previous implementation called
 * `stripe.subscriptionItems.createUsageRecord`, which Stripe REMOVED in SDK
 * v22 (this repo runs 22.3.2, where the property is literally `undefined`).
 * Every call therefore threw "not a function" into the catch below, which
 * returned `{ reported: false }` — and the caller reported success anyway. The
 * platform has been recording billable outcomes and charging for none of them,
 * silently, on every deployment since the SDK bump.
 *
 * Meter Events are keyed by a meter's `event_name` and identify the customer
 * by `stripe_customer_id`, rather than by a per-tier subscription-item id — so
 * configuration is one env var per billable event instead of one per
 * (event × tier), and it no longer needs to know which item a given org's
 * subscription happens to use.
 */
async function reportToStripe(event, quantity, ctx) {
  if (!process.env.STRIPE_SECRET_KEY) return { reported: false, reason: 'stripe_unconfigured' };

  const meterEnv = `STRIPE_METER_${event.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const eventName = process.env[meterEnv];
  if (!eventName) return { reported: false, reason: 'no_meter_configured', expectedEnv: meterEnv };

  // Meter events bill a CUSTOMER, so without one there is nothing to charge.
  const prisma = require('./prisma');
  const sub = await prisma.subscription.findFirst({
    where: { orgId: ctx.orgId, stripeCustomerId: { not: null } },
    select: { stripeCustomerId: true },
  }).catch(() => null);
  if (!sub?.stripeCustomerId) return { reported: false, reason: 'no_stripe_customer' };

  try {
    const stripe = require('./billing/stripe');
    return await stripe.reportMeterEvent({
      eventName,
      stripeCustomerId: sub.stripeCustomerId,
      quantity,
      // Stable per (org, event, outcome) so a retry cannot double-bill. Falls
      // back to a timestamp only when there is no outcome to key on.
      identifier: `${ctx.orgId}:${event}:${ctx.outcomeId || Date.now()}`,
    });
  } catch (e) {
    // Still non-throwing — recording an outcome must not fail because billing
    // is down — but the caller now surfaces this instead of discarding it.
    return { reported: false, reason: e.message };
  }
}

/**
 * Record a business outcome.
 * @param {object} ctx { orgId, userId, outcomeId? }
 * @param {string} event  outcome event name (must be a configured billable event)
 * @param {object} opts { quantity=1, success=true, metadata }
 * @returns {Promise<{ billed, metered, stripe }>}
 */
async function recordOutcome(ctx, event, { quantity = 1, success = true, metadata = {} } = {}) {
  if (!isBillable(event)) {
    return { billed: false, reason: 'event_not_billable', event };
  }
  // Verification hook: only confirmed-successful outcomes are billed.
  if (!success) {
    _bump(ctx.orgId, event, 'unverified', quantity);
    return { billed: false, reason: 'outcome_not_successful', event };
  }
  _bump(ctx.orgId, event, 'billed', quantity);
  const stripe = await reportToStripe(event, quantity, ctx);

  // `billed` now reflects whether Stripe ACTUALLY accepted the charge, not
  // merely that we tried. It previously returned an unconditional `true`,
  // which is how a dead SDK call went unnoticed: the API answered
  // 201 {billed: true} while every single charge failed, and the reason was
  // buried in a nested field nobody read.
  const billed = Boolean(stripe && stripe.reported);
  if (!billed) {
    // ERROR severity so the Cloud Monitoring policies see it. Revenue
    // silently not being collected is the most expensive class of bug here.
    console.error(JSON.stringify({
      severity: 'ERROR', type: 'outcome_billing_failed',
      orgId: ctx.orgId, event, quantity, reason: stripe && stripe.reason,
    }));
  }
  return {
    billed,
    // Distinguishes "we recorded the outcome" from "we charged for it" — the
    // local ledger entry is real either way.
    recorded: true,
    event, quantity, metered: CONFIG.model === 'outcome', stripe,
  };
}

function summary(orgId) {
  const ns = _ns(orgId);
  const events = {};
  for (const [event, v] of ns.entries()) events[event] = v;
  return { billing_model: CONFIG.model, billable_events: CONFIG.events, events };
}

module.exports = { recordOutcome, isBillable, summary, billableEvents: () => CONFIG.events, model: CONFIG.model };

