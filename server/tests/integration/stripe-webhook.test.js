/**
 * routes/stripe-webhook.js — real Express app + supertest, mocking only
 * lib/billing/stripe (signature verification) since real Stripe signing
 * needs no exercising here. Covers the atomicity fix: the event dedup
 * marker and the actual state mutation must commit or roll back together,
 * or a real handler failure gets permanently swallowed as "already
 * handled" the moment Stripe retries.
 */
jest.mock('../../lib/billing/stripe', () => ({
  isConfigured: () => true,
  verifyWebhook: (rawBody) => JSON.parse(rawBody.toString()),
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const stripeWebhookRoutes = require('../../routes/stripe-webhook');
const dunning = require('../../lib/billing/dunning');

function buildApp() {
  const app = express();
  app.use('/api/billing/webhook', stripeWebhookRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

function subscriptionEvent({ id, orgId, status = 'active' }) {
  return {
    id, type: 'customer.subscription.updated',
    data: {
      object: {
        id: `sub_${uid('x')}`, customer: `cus_${uid('x')}`, status,
        metadata: { orgId, tierId: 'pro' },
        items: { data: [{ price: { lookup_key: 'pro' } }] },
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  };
}

describe('POST /api/billing/webhook/stripe', () => {
  test('subscription.updated with a real orgId creates/updates the Subscription row', async () => {
    const orgId = uid('org');
    const event = subscriptionEvent({ id: `evt_${uid('e')}`, orgId });

    const res = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(event));

    expect(res.status).toBe(200);
    const sub = await prisma.subscription.findUnique({ where: { orgId } });
    expect(sub).toBeTruthy();
    expect(sub.status).toBe('active');
    expect(sub.planId).toBe('pro');
  });

  test('a genuine duplicate delivery (same event id) is acked without re-running the mutation', async () => {
    const orgId = uid('org');
    const eventId = `evt_${uid('e')}`;
    const first = subscriptionEvent({ id: eventId, orgId, status: 'active' });
    const res1 = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(first));
    expect(res1.status).toBe(200);

    // Same event id, different status — if this re-ran, status would flip to past_due.
    const second = subscriptionEvent({ id: eventId, orgId, status: 'past_due' });
    const res2 = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(second));
    expect(res2.status).toBe(200);
    expect(res2.body.duplicate).toBe(true);

    const sub = await prisma.subscription.findUnique({ where: { orgId } });
    expect(sub.status).toBe('active'); // unchanged — the duplicate never touched it
  });

  test('regression: a handler failure rolls back the dedup marker too, so a genuine Stripe retry can still succeed', async () => {
    const orgId = uid('org');
    const eventId = `evt_${uid('e')}`;
    // dunning.activate() updates an existing Subscription (e.g. from an
    // earlier trial-start webhook) rather than creating one — set that up
    // so the retry's success path is realistic, not an unrelated 404.
    await prisma.subscription.create({ data: { orgId, planId: 'pro', status: 'trialing' } });
    const invoiceEvent = {
      id: eventId, type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: `in_${uid('x')}`, subscription: `sub_${uid('x')}`,
          subscription_details: { metadata: { orgId } },
          amount_paid: 5000, currency: 'usd',
          period_start: Math.floor(Date.now() / 1000),
          period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          lines: { data: [{ price: { lookup_key: 'pro' } }] },
        },
      },
    };

    const activateSpy = jest.spyOn(dunning, 'activate').mockRejectedValueOnce(new Error('simulated transient failure'));
    const res1 = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(invoiceEvent));
    expect(res1.status).toBe(500);

    // The dedup marker must NOT have survived the rolled-back transaction —
    // otherwise Stripe's retry of the SAME event id would be silently acked
    // as "already handled" despite the mutation never having succeeded.
    const markerAfterFailure = await prisma.stripeEvent.findUnique({ where: { id: eventId } });
    expect(markerAfterFailure).toBeNull();
    const subAfterFailure = await prisma.subscription.findUnique({ where: { orgId } });
    expect(subAfterFailure.status).toBe('trialing'); // unchanged — the failed activate() rolled back too

    activateSpy.mockRestore();
    const res2 = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(invoiceEvent));
    expect(res2.status).toBe(200);
    const subAfterRetry = await prisma.subscription.findUnique({ where: { orgId } });
    expect(subAfterRetry.status).toBe('active');
    const markerAfterRetry = await prisma.stripeEvent.findUnique({ where: { id: eventId } });
    expect(markerAfterRetry).toBeTruthy();
  });

  test('an event with no orgId in metadata is acked as a no-op (nothing to attribute the mutation to)', async () => {
    const event = subscriptionEvent({ id: `evt_${uid('e')}`, orgId: undefined });
    delete event.data.object.metadata.orgId;
    const res = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(res.status).toBe(200);
  });
});
