const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const ent = require('../lib/entitlements');
const router = express.Router();

const KNOWN_EVENTS = ['*', 'project.created', 'project.deleted', 'project.completed'];
const CreateSchema = z.object({
  url: z.string().url().refine(u => /^https?:\/\//i.test(u), 'http(s) URL required'),
  events: z.array(z.string()).min(1).refine(arr => arr.every(e => KNOWN_EVENTS.includes(e)),
    `events must be one of ${KNOWN_EVENTS.join(', ')}`),
});

// attachTenant is required here, not optional: on Postgres, RLS is
// fail-closed, so without it establishing app.org_id the Subscription lookup
// inside checkWebhooks sees ZERO rows and every org — including Enterprise —
// resolves to the free tier's limit of 1. routes/billing.js carries the same
// note for the same reason; this is that bug, not a new one.
router.post('/', authMiddleware, attachTenant, validate(CreateSchema), asyncHandler(async (req, res) => {
  const { url, events } = req.body;
  // Plan quota: `webhooks` is an advertised per-tier limit (lib/entitlements.js
  // PLANS) that had no enforcement anywhere — a free-tier org could configure
  // unlimited endpoints. Gauge-style like seats/storage, since endpoints are a
  // live count rather than a monthly flow.
  const orgId = req.tenant?.orgId || req.user?.orgId || null;
  const quota = await ent.checkWebhooks(orgId, 1, req.tenant?.plan);
  if (!quota.allowed) {
    throw new HttpError(402,
      `Webhook endpoint limit reached (${quota.used}/${quota.limit}). Upgrade your plan to add more.`,
      'usage_limit_exceeded',
      { meter: 'webhooks', used: quota.used, limit: quota.limit, remaining: quota.remaining });
  }
  const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
  const webhook = await prisma.webhook.create({
    data: { userId: req.user.id, url, events: JSON.stringify(events), secret }
  });
  await audit(req, 'webhook.create', { resource: 'webhook', resourceId: webhook.id });
  // Secret is shown only once
  res.status(201).json({ id: webhook.id, url, events, secret,
    message: 'Save this secret — it will not be shown again. Use it to verify x-webhook-signature: t=<ts>,v1=<hex(hmac-sha256(secret, ts + "." + body))>' });
}));

router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const webhooks = await prisma.webhook.findMany({
    where: { userId: req.user.id },
    select: { id: true, url: true, events: true, active: true, failureCount: true, disabledAt: true, createdAt: true },
  });
  res.json({ webhooks: webhooks.map(w => ({ ...w, events: JSON.parse(w.events) })) });
}));

router.get('/:id/deliveries', authMiddleware, asyncHandler(async (req, res) => {
  const hook = await prisma.webhook.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!hook) throw new HttpError(404, 'Not found', 'not_found');
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { webhookId: hook.id }, orderBy: { createdAt: 'desc' }, take: 50,
    select: { id: true, event: true, status: true, attemptCount: true, lastError: true,
              nextAttemptAt: true, deliveredAt: true, createdAt: true },
  });
  res.json({ deliveries });
}));

router.post('/:id/deliveries/:dId/redeliver', authMiddleware, asyncHandler(async (req, res) => {
  const hook = await prisma.webhook.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!hook) throw new HttpError(404, 'Not found', 'not_found');
  const updated = await prisma.webhookDelivery.updateMany({
    where: { id: req.params.dId, webhookId: hook.id },
    data:  { status: 'pending', nextAttemptAt: new Date(), attemptCount: 0, lastError: null },
  });
  if (updated.count === 0) throw new HttpError(404, 'Delivery not found', 'not_found');
  res.json({ message: 'Re-queued' });
}));

router.delete('/:id', authMiddleware, asyncHandler(async (req, res) => {
  await prisma.webhook.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  await audit(req, 'webhook.delete', { resource: 'webhook', resourceId: req.params.id });
  res.json({ message: 'Webhook deleted' });
}));

module.exports = router;

