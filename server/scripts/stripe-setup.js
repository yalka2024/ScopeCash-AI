#!/usr/bin/env node
/**
 * ScopeCash AI — Stripe live-mode setup script.
 *
 * What it does (idempotent, safe to re-run):
 *   1. Validates STRIPE_SECRET_KEY (must start with sk_live_ for live mode,
 *      sk_test_ for test mode — emits a warning when running against test).
 *   2. For every billable tier in the embedded plans catalog:
 *        a. Creates (or reuses, by metadata.tierId) a Stripe Product.
 *        b. Creates monthly + yearly recurring Prices in tier.currency,
 *           reusing prices whose unit_amount / interval already match.
 *   3. Optionally creates the Customer Portal configuration matching the
 *      tier list (allow plan switching + payment method updates).
 *   4. Optionally registers a webhook endpoint pointing at
 *      <PUBLIC_URL>/api/billing/webhook for the events we already handle.
 *   5. Prints the env vars to copy into Fly/Railway secrets, e.g.
 *
 *        STRIPE_PRICE_STARTER_MONTHLY=price_…
 *        STRIPE_PRICE_STARTER_YEARLY=price_…
 *        STRIPE_PRICE_PRO_MONTHLY=price_…
 *        STRIPE_PRICE_PRO_YEARLY=price_…
 *        STRIPE_WEBHOOK_SECRET=whsec_…
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_… node scripts/stripe-setup.js
 *   STRIPE_SECRET_KEY=sk_live_… PUBLIC_URL=https://app.example.com \
 *     node scripts/stripe-setup.js --webhook
 *   node scripts/stripe-setup.js --dry-run   # plan-only, no Stripe writes
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { PLANS } = require('../lib/entitlements');

const PLATFORM_ID = 'scopecash-ai';
const PLATFORM_NAME = 'ScopeCash AI';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WANT_WEBHOOK = args.includes('--webhook');
const WANT_PORTAL = !args.includes('--no-portal');

function log(...a) { console.log('[stripe-setup]', ...a); }
function die(msg) { console.error('[stripe-setup] FATAL:', msg); process.exit(1); }

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.length < 20) die('STRIPE_SECRET_KEY is required.');
  if (!key.startsWith('sk_live_') && !key.startsWith('sk_test_')) {
    die(`STRIPE_SECRET_KEY must start with sk_live_ or sk_test_ (got prefix ${key.slice(0, 8)}…).`);
  }
  if (key.startsWith('sk_test_')) {
    log('⚠ Running against TEST mode (sk_test_…). Set sk_live_… for production.');
  }
  const Stripe = require('stripe');
  return new Stripe(key, { apiVersion: '2024-06-20', maxNetworkRetries: 2 });
}

const billableTiers = (PLANS.tiers || []).filter((t) => {
  if (t.contact_sales) return false;                           // skip enterprise
  const m = t.price_cents_monthly ?? t.price_monthly_cents ?? 0;
  const y = t.price_cents_yearly  ?? t.price_yearly_cents  ?? 0;
  return (m > 0) || (y > 0);                                  // skip free
});

if (billableTiers.length === 0) {
  die('No billable tiers in plans catalog (every tier is free or contact_sales).');
}

async function findProduct(stripe, tierId) {
  // metadata.tierId is the join key.
  let starting_after;
  while (true) {
    const page = await stripe.products.list({ limit: 100, active: true, starting_after });
    for (const p of page.data) {
      if (p.metadata && p.metadata.tierId === tierId && p.metadata.platformId === PLATFORM_ID) {
        return p;
      }
    }
    if (!page.has_more) return null;
    starting_after = page.data[page.data.length - 1].id;
  }
}

async function findPrice(stripe, productId, currency, unitAmount, interval) {
  const page = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  return page.data.find((p) =>
    p.currency === currency &&
    p.unit_amount === unitAmount &&
    p.recurring && p.recurring.interval === interval
  ) || null;
}

async function ensureProduct(stripe, tier) {
  if (DRY_RUN) return { id: `prod_dryrun_${tier.id}`, name: tier.name || tier.id };
  const existing = await findProduct(stripe, tier.id);
  if (existing) {
    log(`product ${tier.id}: reusing ${existing.id}`);
    return existing;
  }
  const created = await stripe.products.create({
    name: `${PLATFORM_NAME} — ${tier.name || tier.id}`,
    description: tier.description || `${tier.name || tier.id} plan`,
    metadata: { platformId: PLATFORM_ID, tierId: tier.id },
  });
  log(`product ${tier.id}: created ${created.id}`);
  return created;
}

async function ensurePrice(stripe, product, tier, interval, amount) {
  if (!amount || amount <= 0) return null;
  if (DRY_RUN) return { id: `price_dryrun_${tier.id}_${interval}`, unit_amount: amount, recurring: { interval } };
  const currency = (tier.currency || PLANS.currency || 'USD').toLowerCase();
  const reuse = await findPrice(stripe, product.id, currency, amount, interval);
  if (reuse) {
    log(`price  ${tier.id}/${interval}: reusing ${reuse.id} (${amount} ${currency})`);
    return reuse;
  }
  const created = await stripe.prices.create({
    product: product.id,
    currency,
    unit_amount: amount,
    recurring: { interval },
    metadata: { platformId: PLATFORM_ID, tierId: tier.id, cadence: interval === 'month' ? 'monthly' : 'yearly' },
  });
  log(`price  ${tier.id}/${interval}: created ${created.id} (${amount} ${currency})`);
  return created;
}

async function ensurePortal(stripe, products) {
  if (DRY_RUN) { log('portal: skipped (dry-run)'); return null; }
  const monthlyPrices = products.flatMap((p) => p.prices.monthly ? [p.prices.monthly.id] : []);
  const yearlyPrices  = products.flatMap((p) => p.prices.yearly  ? [p.prices.yearly.id]  : []);
  const portal = await stripe.billingPortal.configurations.create({
    business_profile: { headline: `${PLATFORM_NAME} subscription` },
    features: {
      payment_method_update: { enabled: true },
      invoice_history:       { enabled: true },
      customer_update:       { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
      subscription_cancel:   { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price', 'promotion_code'],
        proration_behavior: 'create_prorations',
        products: products.map((p) => ({
          product: p.product.id,
          prices: [p.prices.monthly?.id, p.prices.yearly?.id].filter(Boolean),
        })),
      },
    },
    metadata: { platformId: PLATFORM_ID },
  });
  log(`portal: created ${portal.id} (monthly:${monthlyPrices.length}, yearly:${yearlyPrices.length})`);
  return portal;
}

async function ensureWebhook(stripe, publicUrl) {
  if (DRY_RUN) { log('webhook: skipped (dry-run)'); return null; }
  if (!publicUrl) die('--webhook requires PUBLIC_URL env var');
  const url = `${publicUrl.replace(/\/$/, '')}/api/billing/webhook`;
  const events = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.finalized',
  ];
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data
    .find((w) => w.url === url);
  if (existing) {
    log(`webhook: reusing ${existing.id} (cannot re-read secret; rotate or use existing whsec)`);
    return existing;
  }
  const w = await stripe.webhookEndpoints.create({
    url, enabled_events: events,
    metadata: { platformId: PLATFORM_ID },
  });
  log(`webhook: created ${w.id} → ${url}`);
  log(`         STRIPE_WEBHOOK_SECRET=${w.secret}`);
  return w;
}

(async () => {
  const stripe = DRY_RUN ? null : getStripe();
  if (DRY_RUN) log('dry-run mode: no Stripe API calls will be made');

  log(`platform: ${PLATFORM_NAME} (${PLATFORM_ID})`);
  log(`billable tiers: ${billableTiers.map((t) => t.id).join(', ')}`);

  const setup = [];
  for (const tier of billableTiers) {
    const product = await ensureProduct(stripe, tier);
    const monthly = await ensurePrice(stripe, product, tier, 'month', tier.price_cents_monthly ?? tier.price_monthly_cents);
    const yearly  = await ensurePrice(stripe, product, tier, 'year',  tier.price_cents_yearly  ?? tier.price_yearly_cents);
    setup.push({ tier, product, prices: { monthly, yearly } });
  }

  let portal = null;
  if (WANT_PORTAL) portal = await ensurePortal(stripe, setup);

  let webhook = null;
  if (WANT_WEBHOOK) webhook = await ensureWebhook(stripe, process.env.PUBLIC_URL);

  console.log('\n# ── Copy these into your Fly/Railway secrets ──────────────────');
  for (const s of setup) {
    const id = s.tier.id.toUpperCase();
    if (s.prices.monthly) console.log(`STRIPE_PRICE_${id}_MONTHLY=${s.prices.monthly.id}`);
    if (s.prices.yearly)  console.log(`STRIPE_PRICE_${id}_YEARLY=${s.prices.yearly.id}`);
  }
  if (portal) console.log(`STRIPE_PORTAL_CONFIG_ID=${portal.id}`);
  if (webhook?.secret) console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
  console.log('# ──────────────────────────────────────────────────────────────\n');

  console.log(JSON.stringify({
    ok: true,
    dryRun: DRY_RUN,
    platformId: PLATFORM_ID,
    products: setup.map((s) => ({
      tierId: s.tier.id,
      productId: s.product.id,
      monthlyPriceId: s.prices.monthly?.id || null,
      yearlyPriceId:  s.prices.yearly?.id  || null,
    })),
    portalConfigId: portal?.id || null,
    webhookId: webhook?.id || null,
  }, null, 2));
})().catch((err) => die(err.message));

