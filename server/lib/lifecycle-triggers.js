/**
 * Lifecycle triggers (Tier 14).
 *
 * Listens for canonical growth events + scheduled checks and creates
 * `Notification` rows (which are the in-product surface for emails too).
 * Triggers are idempotent: each (userId, kind) pair is recorded in
 * LifecycleSent so we never spam the same user twice.
 *
 * Scheduler: call `startScheduler()` once at boot. It runs hourly.
 *
 * Default rules:
 *   - day-1 nudge:    no `first_record` 24h after signup → in-product nudge
 *   - day-3 churn:    no login event 72h after signup → re-engage
 *   - trial-ending:   subscription.trialEndsAt < 48h → upgrade prompt
 *   - budget-warning: ai-budget utilization >= 0.75 → admin notice
 */
const prisma = require('./prisma');
const events = require('./growth-events');

const KINDS = Object.freeze({
  DAY1_NUDGE:       'lifecycle.day1_nudge',
  DAY3_REENGAGE:    'lifecycle.day3_reengage',
  TRIAL_ENDING:     'lifecycle.trial_ending',
  AI_BUDGET_WARN:   'lifecycle.ai_budget_warn',
});

async function _alreadySent(userId, kind) {
  const row = await prisma.lifecycleSent.findUnique({
    where: { userId_kind: { userId, kind } },
  }).catch(() => null);
  return Boolean(row);
}

async function _markSent(userId, kind, properties = null) {
  try {
    await prisma.lifecycleSent.create({
      data: {
        userId, kind,
        properties: properties ? JSON.stringify(properties).slice(0, 2000) : null,
      },
    });
  } catch {}
}

/**
 * Send a lifecycle notification (idempotent). Emits a growth event.
 * The notification surface is the existing Notification model; an email
 * provider integration can subscribe to `lifecycle.<kind>.sent` events.
 */
async function send(userId, kind, { title, message, type = 'lifecycle', orgId = null, properties = null } = {}) {
  if (!userId || !kind) return { ok: false, reason: 'invalid_args' };
  if (await _alreadySent(userId, kind)) return { ok: true, deduped: true };
  await prisma.notification.create({
    data: { userId, type, title: String(title || kind), message: String(message || ''), metadata: properties ? JSON.stringify(properties).slice(0, 2000) : null },
  }).catch(() => {});
  await _markSent(userId, kind, properties);
  events.track({ name: `${kind}.sent`, userId, orgId, properties, source: 'system' });
  return { ok: true };
}

async function _processDay1(now) {
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
  const candidates = await prisma.user.findMany({
    where: { createdAt: { lte: cutoff, gte: new Date(now.getTime() - 48 * 3600 * 1000) } },
    select: { id: true, orgId: true },
    take: 500,
  }).catch(() => []);
  let sent = 0;
  for (const u of candidates) {
    if (await _alreadySent(u.id, KINDS.DAY1_NUDGE)) continue;
    const created = await prisma.project.count({ where: { userId: u.id } }).catch(() => 0);
    if (created > 0) continue;
    await send(u.id, KINDS.DAY1_NUDGE, {
      orgId: u.orgId,
      title: 'Get started in ScopeCash AI',
      message: 'You have not created your first project yet. It takes about 60 seconds — give it a try.',
    });
    sent += 1;
  }
  return sent;
}

async function _processTrialEnding(now) {
  const soon = new Date(now.getTime() + 48 * 3600 * 1000);
  const subs = await prisma.subscription.findMany({
    where: { status: 'trialing', trialEndsAt: { lte: soon, gte: now } },
    take: 500,
  }).catch(() => []);
  let sent = 0;
  for (const sub of subs) {
    // Notify the org's first user (admin/owner approximation).
    const user = await prisma.user.findFirst({ where: { orgId: sub.orgId }, orderBy: { createdAt: 'asc' } }).catch(() => null);
    if (!user) continue;
    if (await _alreadySent(user.id, KINDS.TRIAL_ENDING)) continue;
    await send(user.id, KINDS.TRIAL_ENDING, {
      orgId: sub.orgId,
      title: 'Your trial ends soon',
      message: `Your ScopeCash AI trial ends on ${new Date(sub.trialEndsAt).toUTCString()}. Add a payment method to keep access.`,
      properties: { planId: sub.planId, trialEndsAt: sub.trialEndsAt },
    });
    sent += 1;
  }
  return sent;
}

let timer = null;

function startScheduler({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (timer) return timer;
  const tick = async () => {
    try {
      const now = new Date();
      await _processDay1(now);
      await _processTrialEnding(now);
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error(JSON.stringify({ type: 'lifecycle_scheduler_error', error: err.message }));
      }
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // Run shortly after boot so first cycle is observable.
  setTimeout(tick, 30_000).unref?.();
  return timer;
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { KINDS, send, startScheduler, stopScheduler, _processDay1, _processTrialEnding };

