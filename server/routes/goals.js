/**
 * Goal routes (agent-orchestrator archetype).
 * Submit a goal, the orchestrator plans + runs it; supervised goals pause for
 * human approval. Generated for ScopeCash AI.
 */
const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware, requireScope } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const limiters = require('../lib/ratelimit');
const guard = require('../lib/ai-guardrails');
const { audit } = require('../lib/audit');
const aiBudget = require('../lib/ai-budget');
const orchestrator = require('../lib/orchestrator');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use(aiBudget.aiBudgetGuard);
router.use(limiters.ai);

// GET /api/goals — list this tenant's goals (durable across restarts).
router.get('/', requireScope('read'), asyncHandler(async (req, res) => {
  // req.tenant.orgId, not req.user.orgId — User.orgId is nullable, and a null
  // there used to drop the filter entirely and list every tenant's goals.
  res.json({ goals: await orchestrator.listGoals(req.tenant.orgId) });
}));

// GET /api/goals/:id — inspect a goal, its plan, and its trace.
router.get('/:id', requireScope('read'), asyncHandler(async (req, res) => {
  const g = await orchestrator.getGoal(req.params.id, { orgId: req.tenant.orgId });
  if (!g) throw new HttpError(404, 'Goal not found', 'goal_not_found');
  res.json(g);
}));

const SubmitSchema = z.object({
  goal: z.string().min(3).max(10000),
  autonomy: z.enum(['supervised', 'autonomous']).optional(),
  model: z.string().max(64).optional(),
});

// POST /api/goals — submit a goal. Supervised goals return a plan to approve.
router.post('/', requireScope('read', 'ai'), validate(SubmitSchema),
  asyncHandler(async (req, res) => {
    const ctx = { userId: req.user.id, orgId: req.user.orgId, modelId: req.body.model };
    const quota = await guard.checkAiQuota(prisma, ctx);
    if (!quota.ok) throw new HttpError(429, quota.reason, 'ai_quota_exceeded', { used: quota.used, limit: quota.limit });

    const inj = guard.detectInjection(req.body.goal);
    if (inj.suspicious) {
      await audit(req, 'goal.submit.blocked', { details: { reason: 'prompt_injection' }, outcome: 'failure' });
      throw new HttpError(400, 'Goal rejected by safety filter', 'prompt_blocked');
    }
    const safeGoal = guard.redactPII(guard.capInput(req.body.goal)).text;

    const goal = await orchestrator.submitGoal(safeGoal, ctx, { autonomy: req.body.autonomy });
    await audit(req, 'goal.submit', { details: { goalId: goal.id, status: goal.status, autonomy: goal.autonomy, steps: goal.steps.length } });
    res.status(201).json(goal);
  }));

// POST /api/goals/:id/approve — approve a supervised plan and run it.
router.post('/:id/approve', requireScope('read', 'ai'),
  asyncHandler(async (req, res) => {
    const ctx = { userId: req.user.id, orgId: req.user.orgId, modelId: req.body.model };
    const goal = await orchestrator.approveGoal(req.params.id, ctx, { orgId: req.tenant.orgId });
    if (!goal) throw new HttpError(404, 'Goal not found', 'goal_not_found');
    await audit(req, 'goal.approve', { details: { goalId: goal.id, status: goal.status } });
    res.json(goal);
  }));

module.exports = router;

