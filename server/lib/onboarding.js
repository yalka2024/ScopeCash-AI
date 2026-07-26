/**
 * Onboarding state machine (Tier 14).
 *
 * Walks the user through the standard activation milestones for ScopeCash AI.
 * Steps are industry-aware via the `industry` token, but the default ladder
 * works for any SaaS:
 *   1. signup           — account created (auto on register)
 *   2. email_verified   — email confirmed
 *   3. profile          — name + org filled
 *   4. first_record     — first project created
 *   5. invited_teammate — at least one team invite sent
 *   6. activated        — completed enough to qualify for retention metric
 *
 * Persists OnboardingState per user (1:1) and emits `onboarding.<step>` events.
 */
const prisma = require('./prisma');
const events = require('./growth-events');

// Default 6-step ladder. Override per-platform by editing this list.
const DEFAULT_STEPS = Object.freeze([
  'signup',
  'email_verified',
  'profile',
  'first_record',
  'invited_teammate',
  'activated',
]);

function steps() {
  // Allow runtime override via env: ONBOARDING_STEPS=signup,email_verified,first_record
  const env = process.env.ONBOARDING_STEPS;
  if (!env) return DEFAULT_STEPS;
  const list = env.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? Object.freeze(list) : DEFAULT_STEPS;
}

async function getState(userId) {
  if (!userId) return null;
  const row = await prisma.onboardingState.findUnique({ where: { userId } }).catch(() => null);
  if (row) return _shape(row);
  // Bootstrap on first read.
  return _shape(await prisma.onboardingState.create({
    data: { userId, completedSteps: JSON.stringify([]) },
  }).catch(() => ({ userId, completedSteps: '[]', completedAt: null, updatedAt: new Date() })));
}

function _shape(row) {
  let completed = [];
  try { completed = JSON.parse(row.completedSteps || '[]'); } catch {}
  if (!Array.isArray(completed)) completed = [];
  const ladder = steps();
  const next = ladder.find(s => !completed.includes(s)) || null;
  return {
    userId: row.userId,
    steps: ladder,
    completed,
    next,
    progress: ladder.length > 0 ? completed.filter(s => ladder.includes(s)).length / ladder.length : 0,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

/** Mark a step complete. Idempotent. Emits a growth event the first time. */
async function markStep(userId, step, { orgId = null, properties = null } = {}) {
  if (!userId || !step) return { ok: false, reason: 'invalid_args' };
  const ladder = steps();
  if (!ladder.includes(step)) return { ok: false, reason: 'unknown_step' };
  const cur = await getState(userId);
  if (cur.completed.includes(step)) return { ok: true, alreadyCompleted: true, state: cur };

  const completed = [...cur.completed, step];
  const isComplete = ladder.every(s => completed.includes(s));
  const data = {
    completedSteps: JSON.stringify(completed),
    completedAt: isComplete ? new Date() : null,
    updatedAt: new Date(),
  };
  await prisma.onboardingState.update({ where: { userId }, data })
    .catch(async () => prisma.onboardingState.create({ data: { userId, ...data } }).catch(() => {}));

  events.track({
    name: `onboarding.${step}`,
    userId, orgId,
    properties: { step, progress: completed.length / ladder.length, ...(properties || {}) },
    source: 'system',
  });
  if (isComplete) {
    events.track({ name: 'onboarding.activated', userId, orgId, source: 'system' });
  }
  return { ok: true, state: await getState(userId) };
}

module.exports = { steps, getState, markStep, DEFAULT_STEPS };

