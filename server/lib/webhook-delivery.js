/**
 * Outbound webhook delivery worker.
 * - Persists every delivery in WebhookDelivery
 * - Signs each request with HMAC-SHA256 of the body using webhook.secret
 * - Exponential backoff: 30s, 2m, 10m, 1h, 6h (5 attempts)
 * - After max attempts -> status=dead (Dead-Letter), webhook auto-disabled after N consecutive deliveries fail
 *
 * Tick loop runs every 15s (single-process). For multi-instance, run with
 * a single dedicated worker process.
 */
const crypto = require('crypto');
const prisma = require('./prisma');
const metrics = require('./metrics');

const ATTEMPT_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const MAX_ATTEMPTS = ATTEMPT_DELAYS_MS.length;
const TICK_MS = 15_000;
const AUTO_DISABLE_AFTER = 20;

let timer = null;

async function enqueueWebhookEvent(userId, event, payload) {
  const hooks = await prisma.webhook.findMany({
    where: { userId, active: true },
  });
  for (const h of hooks) {
    let events = []; try { events = JSON.parse(h.events); } catch {}
    if (!events.includes('*') && !events.includes(event)) continue;
    await prisma.webhookDelivery.create({
      data: {
        webhookId: h.id, event,
        payload: JSON.stringify(payload),
        status: 'pending', attemptCount: 0,
        nextAttemptAt: new Date(),
      },
    });
  }
}

function sign(secret, body, ts) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

async function deliverOne(delivery) {
  const hook = await prisma.webhook.findUnique({ where: { id: delivery.webhookId } });
  if (!hook || !hook.active) {
    await prisma.webhookDelivery.update({ where: { id: delivery.id },
      data: { status: 'dead', lastError: 'webhook inactive' } });
    return;
  }
  const ts = Date.now().toString();
  const sig = sign(hook.secret, delivery.payload, ts);
  let res, errText = null;
  try {
    res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-event': delivery.event,
        'x-webhook-timestamp': ts,
        'x-webhook-signature': `t=${ts},v1=${sig}`,
        'user-agent': 'scopecash-ai-webhook/1.0',
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) { errText = err.message; }

  const ok = res && res.status >= 200 && res.status < 300;
  const nextCount = delivery.attemptCount + 1;

  if (ok) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({ where: { id: delivery.id },
        data: { status: 'delivered', deliveredAt: new Date(), attemptCount: nextCount } }),
      prisma.webhook.update({ where: { id: hook.id }, data: { failureCount: 0 } }),
    ]);
    metrics.counters.webhookDeliveries.inc({ outcome: 'delivered' });
    return;
  }

  const failureMsg = errText || `HTTP ${res ? res.status : '???'}`;
  if (nextCount >= MAX_ATTEMPTS) {
    const newFail = hook.failureCount + 1;
    const updates = [
      prisma.webhookDelivery.update({ where: { id: delivery.id },
        data: { status: 'dead', attemptCount: nextCount, lastError: failureMsg } }),
      prisma.webhook.update({ where: { id: hook.id }, data: { failureCount: newFail } }),
    ];
    if (newFail >= AUTO_DISABLE_AFTER) {
      updates.push(prisma.webhook.update({ where: { id: hook.id },
        data: { active: false, disabledAt: new Date() } }));
    }
    await prisma.$transaction(updates);
    metrics.counters.webhookDeliveries.inc({ outcome: 'dead' });
  } else {
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: {
      status: 'pending', attemptCount: nextCount, lastError: failureMsg,
      nextAttemptAt: new Date(Date.now() + ATTEMPT_DELAYS_MS[nextCount - 1]),
    }});
    metrics.counters.webhookDeliveries.inc({ outcome: 'retry' });
  }
}

async function tick() {
  try {
    const due = await prisma.webhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
      take: 25, orderBy: { nextAttemptAt: 'asc' },
    });
    for (const d of due) { await deliverOne(d).catch(e => console.error('webhook deliver:', e.message)); }
  } catch (err) { console.error('webhook tick:', err.message); }
}

function startWebhookWorker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref && timer.unref();
}
function stopWebhookWorker() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { enqueueWebhookEvent, startWebhookWorker, stopWebhookWorker, sign };

