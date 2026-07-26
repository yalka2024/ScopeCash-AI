const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const ent = require('../lib/entitlements');
const meter = require('../lib/usage-meter');
const stripe = require('../lib/billing/stripe');
const dunning = require('../lib/billing/dunning');

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
router.post('/checkout', async (req, res, next) => {
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
    res.json({ url: session.url, id: session.id });
  } catch (err) { next(err); }
});

/* ── Stripe Customer Portal — self-service ────────────────────── */
router.post('/portal', async (req, res, next) => {
  try {
    if (!stripe.isConfigured()) {
      return res.status(503).json({ error: 'billing_not_configured', code: 'billing_not_configured' });
    }
    const base = process.env.PUBLIC_DASHBOARD_URL || 'http://localhost:3000';
    const session = await stripe.createPortalSession({
      orgId: req.user.orgId,
      returnUrl: `${base}/settings/billing`,
    });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

/* ── Cancel at period end (no portal) ─────────────────────────── */
router.post('/cancel', async (req, res, next) => {
  try {
    const sub = await dunning.cancel({ orgId: req.user.orgId, atPeriodEnd: true });
    res.json({ ok: true, status: sub?.status, cancelAt: sub?.cancelAt });
  } catch (err) { next(err); }
});

module.exports = router;
