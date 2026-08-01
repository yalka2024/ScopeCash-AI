/**
 * Workflow routes — list, start, and inspect runs of the workflows declared
 * in this platform's spec. Generated for ScopeCash AI.
 */
const express = require('express');
const { authMiddleware, requireScope } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const limiters = require('../lib/ratelimit');
const guard = require('../lib/ai-guardrails');
const { audit } = require('../lib/audit');
const aiBudget = require('../lib/ai-budget');
const workflowRegistry = require('../lib/workflow-registry');
const { runWorkflow, getRun } = require('../lib/workflow-runtime');
const asyncRunner = require('../lib/async-runner');
const runStore = require('../lib/run-store');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use(aiBudget.aiBudgetGuard);
router.use(limiters.ai);

// GET /api/workflows — list available workflows.
router.get('/', requireScope('read'), asyncHandler(async (req, res) => {
  res.json({
    workflows: workflowRegistry.listWorkflows().map(w => ({
      name: w.name, description: w.description, steps: w.steps,
    })),
  });
}));

// GET /api/workflows/runs/:id — inspect a run.
router.get('/runs/:id', requireScope('read'), asyncHandler(async (req, res) => {
  const run = await getRun(req.params.id, { orgId: req.tenant.orgId });
  if (!run) throw new HttpError(404, 'Run not found', 'run_not_found');
  res.json(run);
}));

// POST /api/workflows/runs/:id/cancel — request cooperative cancellation.
router.post('/runs/:id/cancel', requireScope('write'), asyncHandler(async (req, res) => {
  const run = await getRun(req.params.id, { orgId: req.tenant.orgId });
  if (!run) throw new HttpError(404, 'Run not found', 'run_not_found');
  runStore.requestCancel(req.params.id);
  await audit(req, 'workflow.run.cancel', { details: { runId: req.params.id } });
  res.json({ runId: req.params.id, status: 'cancelling' });
}));

const StartSchema = z.object({
  input: z.union([z.string().max(50000), z.record(z.any())]).optional(),
  model: z.string().max(64).optional(),
  async: z.boolean().optional(),   // run in the background; returns a runId to poll
});

// POST /api/workflows/:name/start — start a workflow run (runs synchronously).
router.post('/:name/start', requireScope('read', 'ai'), validate(StartSchema),
  asyncHandler(async (req, res) => {
    const wf = workflowRegistry.getWorkflow(req.params.name);
    if (!wf) throw new HttpError(404, `Unknown workflow: ${req.params.name}`, 'workflow_not_found');

    const ctx = { userId: req.user.id, orgId: req.user.orgId, modelId: req.body.model };
    const rawInput = req.body.input == null ? '' :
      (typeof req.body.input === 'string' ? req.body.input : JSON.stringify(req.body.input));
    if (rawInput) {
      const inj = guard.detectInjection(rawInput);
      if (inj.suspicious) {
        await audit(req, 'workflow.start.blocked', { details: { workflow: wf.name, reason: 'prompt_injection' }, outcome: 'failure' });
        throw new HttpError(400, 'Input rejected by safety filter', 'prompt_blocked');
      }
    }
    const safeInput = rawInput ? guard.redactPII(guard.capInput(rawInput)).text : '';

    if (req.body.async) {
      const runId = await asyncRunner.enqueue('workflow', wf.name, safeInput, ctx);
      await audit(req, 'workflow.start.async', { details: { workflow: wf.name, runId } });
      return res.status(202).json({ runId, status: 'queued', poll: `/api/workflows/runs/${runId}` });
    }

    const run = await runWorkflow(wf, safeInput, ctx);
    await audit(req, 'workflow.start', { details: { workflow: wf.name, runId: run.id, status: run.status } });

    res.status(run.status === 'failed' ? 207 : 200).json(run);
  }));

module.exports = router;

