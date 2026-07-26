/**
 * Agent routes — list and run the agents declared in this platform's spec.
 * Generated for ScopeCash AI.
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
const agentRegistry = require('../lib/agent-registry');
const { runAgent } = require('../lib/agent-runtime');
const asyncRunner = require('../lib/async-runner');
const runStore = require('../lib/run-store');
const crypto = require('crypto');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use(aiBudget.aiBudgetGuard);
router.use(limiters.ai);

// GET /api/agents — list available agents and their declared tools.
router.get('/', requireScope('read'), asyncHandler(async (req, res) => {
  res.json({
    agents: agentRegistry.listAgents().map(a => ({
      name: a.name, role: a.role, description: a.description, tools: a.tools || [],
    })),
  });
}));

const RunSchema = z.object({
  input: z.union([z.string().max(50000), z.record(z.any())]),
  model: z.string().max(64).optional(),
  session: z.string().max(128).optional(),  // memory namespace; persists context across calls
});

// POST /api/agents/:name/run — run an agent to completion.
router.post('/:name/run', requireScope('read', 'ai'), validate(RunSchema),
  asyncHandler(async (req, res) => {
    const agent = agentRegistry.getAgent(req.params.name);
    if (!agent) throw new HttpError(404, `Unknown agent: ${req.params.name}`, 'agent_not_found');

    const ctx = { userId: req.user.id, orgId: req.user.orgId, modelId: req.body.model };
    // Scope memory to the caller's tenant so sessions never leak across orgs.
    if (req.body.session) ctx.session = `${req.user.orgId}:${req.body.session}`;
    const quota = await guard.checkAiQuota(prisma, ctx);
    if (!quota.ok) throw new HttpError(429, quota.reason, 'ai_quota_exceeded', { used: quota.used, limit: quota.limit });

    const rawInput = typeof req.body.input === 'string' ? req.body.input : JSON.stringify(req.body.input);
    const inj = guard.detectInjection(rawInput);
    if (inj.suspicious) {
      await audit(req, 'agent.run.blocked', { details: { agent: agent.name, reason: 'prompt_injection' }, outcome: 'failure' });
      throw new HttpError(400, 'Input rejected by safety filter', 'prompt_blocked');
    }
    const { text: safeInput } = guard.redactPII(guard.capInput(rawInput));

    // Persist a durable run record (pollable + cancellable) for the sync run.
    const runId = crypto.randomUUID();
    ctx.runId = runId;
    ctx.isCancelled = () => runStore.isCancelled(runId);
    const baseRun = { id: runId, kind: 'agent', name: agent.name, orgId: ctx.orgId, userId: ctx.userId, input: safeInput };
    await runStore.save({ ...baseRun, status: 'running' });

    let result;
    try {
      result = await runAgent(agent, safeInput, ctx);
    } finally {
      runStore.clearCancel(runId);
    }
    const status = result.cancelled ? 'cancelled' : (result.truncated ? 'truncated' : 'completed');
    await runStore.save({ ...baseRun, status, output: result.output, steps: result.steps });

    await guard.recordAiUsage(prisma, ctx, {
      provider: process.env.AI_PROVIDER, model: ctx.modelId,
      promptTokens: result.usage?.promptTokens || 0,
      completionTokens: result.usage?.completionTokens || 0,
      prompt: safeInput,
    });
    await audit(req, 'agent.run', { details: { agent: agent.name, runId, steps: result.steps?.length || 0, tools: result.toolCalls?.length || 0 } });

    res.json({
      runId,
      agent: agent.name,
      output: result.output,
      status,
      steps: result.steps,
      toolCalls: result.toolCalls,
      truncated: !!result.truncated,
    });
  }));

// POST /api/agents/runs/:id/cancel — request cooperative cancellation.
router.post('/runs/:id/cancel', requireScope('write'), asyncHandler(async (req, res) => {
  const run = await runStore.get(req.params.id);
  if (!run) throw new HttpError(404, 'Run not found', 'run_not_found');
  // Ownership: only the run's own tenant/user may cancel it (prevents cross-tenant IDOR).
  const ownsRun = (run.orgId && run.orgId === req.user.orgId) || (run.userId && run.userId === req.user.id);
  if (!ownsRun) throw new HttpError(404, 'Run not found', 'run_not_found');
  runStore.requestCancel(req.params.id);
  await audit(req, 'agent.run.cancel', { details: { runId: req.params.id } });
  res.json({ runId: req.params.id, status: 'cancelling' });
}));

// POST /api/agents/:name/run/stream — run an agent, streaming progress as SSE.
// Emits events: step, text, tool, final, error. Reuses the same guardrails.
router.post('/:name/run/stream', requireScope('read', 'ai'), validate(RunSchema),
  asyncHandler(async (req, res) => {
    const agent = agentRegistry.getAgent(req.params.name);
    if (!agent) throw new HttpError(404, `Unknown agent: ${req.params.name}`, 'agent_not_found');

    const ctx = { userId: req.user.id, orgId: req.user.orgId, modelId: req.body.model };
    if (req.body.session) ctx.session = `${req.user.orgId}:${req.body.session}`;
    const quota = await guard.checkAiQuota(prisma, ctx);
    if (!quota.ok) throw new HttpError(429, quota.reason, 'ai_quota_exceeded', { used: quota.used, limit: quota.limit });

    const rawInput = typeof req.body.input === 'string' ? req.body.input : JSON.stringify(req.body.input);
    const inj = guard.detectInjection(rawInput);
    if (inj.suspicious) {
      await audit(req, 'agent.run.blocked', { details: { agent: agent.name, reason: 'prompt_injection' }, outcome: 'failure' });
      throw new HttpError(400, 'Input rejected by safety filter', 'prompt_blocked');
    }
    const { text: safeInput } = guard.redactPII(guard.capInput(rawInput));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ } };
    ctx.onEvent = send;

    try {
      const result = await runAgent(agent, safeInput, ctx);
      await guard.recordAiUsage(prisma, ctx, {
        provider: process.env.AI_PROVIDER, model: ctx.modelId,
        promptTokens: result.usage?.promptTokens || 0,
        completionTokens: result.usage?.completionTokens || 0,
        prompt: safeInput,
      });
      await audit(req, 'agent.run.stream', { details: { agent: agent.name, steps: result.steps?.length || 0 } });
      send({ type: 'done', truncated: !!result.truncated });
    } catch (e) {
      send({ type: 'error', error: e.message, code: e.code || 'agent_error' });
    } finally {
      res.end();
    }
  }));

// POST /api/agents/:name/run/async — enqueue a background run; returns a runId.
router.post('/:name/run/async', requireScope('read', 'ai'), validate(RunSchema),
  asyncHandler(async (req, res) => {
    const agent = agentRegistry.getAgent(req.params.name);
    if (!agent) throw new HttpError(404, `Unknown agent: ${req.params.name}`, 'agent_not_found');
    const ctx = { userId: req.user.id, orgId: req.user.orgId, modelId: req.body.model };
    if (req.body.session) ctx.session = `${req.user.orgId}:${req.body.session}`;

    const rawInput = typeof req.body.input === 'string' ? req.body.input : JSON.stringify(req.body.input);
    const inj = guard.detectInjection(rawInput);
    if (inj.suspicious) {
      await audit(req, 'agent.run.blocked', { details: { agent: agent.name, reason: 'prompt_injection' }, outcome: 'failure' });
      throw new HttpError(400, 'Input rejected by safety filter', 'prompt_blocked');
    }
    const safeInput = guard.redactPII(guard.capInput(rawInput)).text;
    const runId = await asyncRunner.enqueue('agent', agent.name, safeInput, ctx);
    await audit(req, 'agent.run.async', { details: { agent: agent.name, runId } });
    res.status(202).json({ runId, status: 'queued', poll: `/api/agents/runs/${runId}` });
  }));

// GET /api/agents/runs/:id — poll a background agent run.
router.get('/runs/:id', requireScope('read'), asyncHandler(async (req, res) => {
  const run = await asyncRunner.getRun(req.params.id);
  if (!run) throw new HttpError(404, 'Run not found', 'run_not_found');
  res.json(run);
}));

module.exports = router;

