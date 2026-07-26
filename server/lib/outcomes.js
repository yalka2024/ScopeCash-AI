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

/** Report metered usage to Stripe (best-effort; no-op unless configured). */
async function reportToStripe(event, quantity, ctx) {
  if (!process.env.STRIPE_SECRET_KEY) return { reported: false, reason: 'stripe_unconfigured' };
  const itemEnv = `STRIPE_OUTCOME_ITEM_${event.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const subscriptionItem = process.env[itemEnv];
  if (!subscriptionItem) return { reported: false, reason: 'no_subscription_item' };
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    await stripe.subscriptionItems.createUsageRecord(subscriptionItem, {
      quantity, timestamp: Math.floor(Date.now() / 1000), action: 'increment',
    }, { idempotencyKey: `${ctx.orgId}:${event}:${ctx.outcomeId || Date.now()}` });
    return { reported: true, subscriptionItem };
  } catch (e) {
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
  return { billed: true, event, quantity, metered: CONFIG.model === 'outcome', stripe };
}

function summary(orgId) {
  const ns = _ns(orgId);
  const events = {};
  for (const [event, v] of ns.entries()) events[event] = v;
  return { billing_model: CONFIG.model, billable_events: CONFIG.events, events };
}

module.exports = { recordOutcome, isBillable, summary, billableEvents: () => CONFIG.events, model: CONFIG.model };

