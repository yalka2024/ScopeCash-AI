/**
 * Workflow runtime — executes a workflow's steps in order, threading state
 * between them. Each step is resolved against the agent/tool registries:
 *   - if the step names a registered agent  -> run that agent
 *   - else if it names a registered tool    -> invoke that tool
 *   - else                                  -> delegate to the workflow's
 *                                              default agent (or a generic one)
 *
 * Run state is kept in-memory and exposed via getRun(id). Durable persistence
 * (DB-backed runs, resume) is a planned follow-up — see TODO.md (7.x).
 * Generated for ScopeCash AI.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const agentRegistry = require('./agent-registry');
const toolRegistry = require('./tool-registry');
const { runAgent } = require('./agent-runtime');
const store = require('./run-store');

// Deterministic step implementations (the C4.1 slot, extended to workflows):
// workflows/impl/<slug>.js modules indexed by workflow name. An implemented
// step runs INSTEAD of agent/tool/LLM resolution; unimplemented steps fall
// through, so partial implementation is always safe.
const _impls = (() => {
  const out = {};
  try {
    const dir = path.join(__dirname, 'workflows', 'impl');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      try {
        const m = require(path.join(dir, f));
        if (m && m.workflow && m.steps) out[m.workflow] = m;
      } catch { /* broken impl module: that workflow falls back to LLM resolution */ }
    }
  } catch { /* no impl dir generated */ }
  return out;
})();

function _matchAgent(step) {
  for (const a of agentRegistry.listAgents()) {
    if (step.toLowerCase().includes(a.name.toLowerCase())) return a;
  }
  return null;
}
function _matchTool(step) {
  for (const t of toolRegistry.listTools()) {
    if (step.toLowerCase().includes(t.name.toLowerCase())) return t;
  }
  return null;
}

/**
 * Start (and run to completion) a workflow.
 * @param {object} wfDef  { name, description, steps: string[], agent?: string }
 * @param {object|string} input
 * @param {object} ctx  { userId, orgId, modelId }
 * @returns {Promise<run>}
 */
async function runWorkflow(wfDef, input, ctx = {}, runId = null) {
  runId = runId || crypto.randomUUID();   // reuse a pre-created run id (async execution)
  const run = {
    id: runId, kind: 'workflow', name: wfDef.name, workflow: wfDef.name,
    orgId: ctx.orgId, userId: ctx.userId, status: 'running',
    input: typeof input === 'string' ? input : JSON.stringify(input || ''),
    startedAt: new Date().toISOString(), steps: [], output: null,
  };
  await store.save(run);   // durable: persists at start so a crash mid-run is visible

  let state = typeof input === 'string' ? input : JSON.stringify(input || {});
  const defaultAgent = wfDef.agent ? agentRegistry.getAgent(wfDef.agent) : null;

  try {
    for (let i = 0; i < wfDef.steps.length; i++) {
      if (typeof ctx.isCancelled === 'function' && ctx.isCancelled()) {
        run.status = 'cancelled'; run.completedAt = new Date().toISOString();
        await store.save(run);
        return run;
      }
      const stepText = wfDef.steps[i];
      const record = { index: i, step: stepText, status: 'running', startedAt: new Date().toISOString() };
      run.steps.push(record);

      const implMod = _impls[wfDef.name];
      const implStep = implMod && implMod.realImplemented && typeof implMod.steps[i] === 'function'
        ? implMod.steps[i] : null;
      const agent = implStep ? null : (_matchAgent(stepText) || defaultAgent);
      const tool = (!agent && !implStep) ? _matchTool(stepText) : null;

      let result;
      if (implStep) {
        result = await implStep(state, ctx);
        result = typeof result === 'string' ? result : JSON.stringify(result);
        record.via = 'impl';
      } else if (agent) {
        const r = await runAgent(agent, `Workflow "${wfDef.name}" — step ${i + 1}: ${stepText}\n\nContext so far:\n${state}`, ctx);
        result = r.output;
        record.via = `agent:${agent.name}`;
      } else if (tool) {
        result = await tool.run({ input: state, step: stepText }, ctx);
        result = typeof result === 'string' ? result : JSON.stringify(result);
        record.via = `tool:${tool.name}`;
      } else {
        // No specific binding: synthesize a one-shot agent for this step.
        const r = await runAgent(
          { name: `${wfDef.name} coordinator`, role: 'workflow', description: wfDef.description, tools: [] },
          `Workflow "${wfDef.name}" — step ${i + 1}: ${stepText}\n\nContext so far:\n${state}`, ctx);
        result = r.output;
        record.via = 'agent:coordinator';
      }

      record.status = 'completed';
      record.completedAt = new Date().toISOString();
      record.output = result;
      state = result;
    }
    run.status = 'completed';
    run.output = state;
  } catch (e) {
    run.status = 'failed';
    run.error = e.message;
  }
  run.completedAt = new Date().toISOString();
  await store.save(run);   // durable: final state
  return run;
}

async function getRun(id, { orgId } = {}) { return store.get(id, { orgId }); }
async function listRuns(orgId) { return store.list({ kind: 'workflow', orgId }); }

module.exports = { runWorkflow, getRun, listRuns };

