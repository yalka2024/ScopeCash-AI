const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const ent = require('../lib/entitlements');
const meter = require('../lib/usage-meter');
const stripe = require('../lib/billing/stripe');
const packetCredits = require('../lib/billing/packet-credits');
const dunning = require('../lib/billing/dunning');
const { audit } = require('../lib/audit');
// Money-moving actions are owner/admin only. Without this any member — down to
// a `viewer` — could cancel the org's subscription or start a $149 charge.
const { requireAnyOrgRole } = require('../lib/roles');

const router = express.Router();

/* ── Public plan catalog (no auth — used by pricing page) ─────── */
router.get('/plans/public', (req, res) => {
  // Strip nothing sensitive — PLANS only contains pricing & limits.
  res.json({
    plans: ent.PLANS,
    billing_configured: stripe.isConfigured(),
  });
});

router.use(authMiddleware);
// Every handler below reads billing/subscription state for the caller's org.
// On Postgres, RLS (prisma/rls.sql) is fail-closed — without attachTenant
// establishing the app.org_id context, prisma.subscription.findFirst() sees
// ZERO rows regardless of the real data, and ent.getActiveSubscription()
// silently falls back to the free tier. That meant every paying customer's
// own /api/billing/usage call would report them as free-tier on Postgres —
// found via a follow-up audit, verified by tracing attachTenant's own doc
// comment about exactly this RLS-context requirement.
router.use(attachTenant);

/* ── Plan catalog (public to authenticated users) ─────────────── */
router.get('/plans', (req, res) => {
  res.json({ plans: ent.PLANS });
});

/* ── Current usage + plan summary for the requesting org ──────── */
router.get('/usage', async (req, res, next) => {
  try {
    const orgId = req.user?.orgId;
    const sub = await ent.getActiveSubscription(orgId);
    const usage = orgId ? await meter.getAllUsage(orgId) : {};
    res.json({
      tier: sub.tier.id,
      tier_name: sub.tier.name,
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAt: sub.cancelAt,
      limits: sub.tier.limits,
      entitlements: sub.tier.entitlements,
      usage,
      period: ent.currentPeriodKey(),
    });
  } catch (err) { next(err); }
});

/* ── Stripe Checkout — start a subscription ───────────────────── */
router.post('/checkout', requireAnyOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (!stripe.isConfigured()) {
      return res.status(503).json({ error: 'billing_not_configured', code: 'billing_not_configured' });
    }
    const { tierId, cadence = 'monthly' } = req.body || {};
    if (!tierId) return res.status(400).json({ error: 'tierId required' });

    const base = process.env.PUBLIC_DASHBOARD_URL || 'http://localhost:3000';
    const session = await stripe.createCheckoutSession({
      orgId: req.user.orgId,
      email: req.user.email,
      name:  req.user.name,
      tierId,
      cadence,
      successUrl: `${base}/settings/billing?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/settings/billing?status=cancelled`,
    });
    await audit(req, 'billing.checkout.started', { resource: 'subscription', resourceId: req.user.orgId, details: { tierId, cadence } });
    res.json({ url: session.url, id: session.id });
  } catch (err) { next(err); }
});

/**
 * Buy a single evidence packet ($149) — no subscription.
 *
 * This is the conversion path for a contractor with one stuck dispute who
 * won't take on a second monthly bill on top of Jobber/Housecall Pro. The
 * credit it grants is creditable toward a plan for 60 days, so the one-off
 * is an on-ramp rather than a dead end.
 */
router.post('/checkout/packet', requireAnyOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (!stripe.isConfigured()) {
      return res.status(503).json({ error: 'billing_not_configured', code: 'billing_not_configured' });
    }
    const base = process.env.PUBLIC_DASHBOARD_URL || 'http://localhost:3000';
    const session = await stripe.createPacketCheckoutSession({
      orgId: req.user.orgId,
      email: req.user.email,
      name: req.user.name,
      successUrl: `${base}/packets?status=purchased&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/packets?status=cancelled`,
    });
    await audit(req, 'billing.packet_checkout.started', {
      resource: 'packetCredit', resourceId: req.user.orgId,
      details: { amountCents: packetCredits.PACKET_PRICE_CENTS },
    });
    res.json({ url: session.url, id: session.id, amountCents: packetCredits.PACKET_PRICE_CENTS });
  } catch (err) { next(err); }
});

/** What the org can spend right now: plan coverage, unspent packet credits. */
router.get('/packet-credits', async (req, res, next) => {
  try {
    const orgId = req.tenant?.orgId || req.user.orgId;
    const [auth, creditable] = await Promise.all([
      packetCredits.authorizeExport(orgId),
      packetCredits.creditableTowardPlan(orgId),
    ]);
    res.json({
      canExport: auth.allowed,
      via: auth.via || null,
      priceCents: packetCredits.PACKET_PRICE_CENTS,
      unspentCredits: creditable.count,
      creditableTowardPlanCents: creditable.amountCents,
    });
  } catch (err) { next(err); }
});

/* ── Stripe Customer Portal — self-service ────────────────────── */
router.post('/portal', requireAnyOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (!stripe.isConfigured()) {
      return res.status(503).json({ error: 'billing_not_configured', code: 'billing_not_configured' });
    }
    const base = process.env.PUBLIC_DASHBOARD_URL || 'http://localhost:3000';
    const session = await stripe.createPortalSession({
      orgId: req.user.orgId,
      returnUrl: `${base}/settings/billing`,
    });
    await audit(req, 'billing.portal.opened', { resource: 'subscription', resourceId: req.user.orgId });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

/* ── Cancel at period end (no portal) ─────────────────────────── */
router.post('/cancel', requireAnyOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    const sub = await dunning.cancel({ orgId: req.user.orgId, atPeriodEnd: true });
    await audit(req, 'billing.subscription.cancel_requested', { resource: 'subscription', resourceId: req.user.orgId, details: { status: sub?.status, cancelAt: sub?.cancelAt } });
    res.json({ ok: true, status: sub?.status, cancelAt: sub?.cancelAt });
  } catch (err) { next(err); }
});

module.exports = router;
