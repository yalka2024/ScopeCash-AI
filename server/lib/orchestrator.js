/**
 * Goal orchestrator (LATS / autonomous agents).
 *
 * submitGoal(goal) -> an LLM planner decomposes the goal into ordered steps;
 * each step is executed by the best-matching agent from the registry (or a
 * generic executor). Autonomy is gated:
 *   - 'supervised'  : plan, then wait for human approval before executing
 *   - 'autonomous'  : plan and execute straight through
 *
 * Goal state is kept in-memory and exposed via getGoal(id). Durable persistence
 * + resume is a planned follow-up (TODO.md 7.x).
 * Generated for ScopeCash AI (agent-orchestrator archetype).
 */
const crypto = require('crypto');
const agentRegistry = require('./agent-registry');
const { runAgent } = require('./agent-runtime');
const store = require('./run-store');

const DEFAULT_AUTONOMY = (process.env.AGENT_AUTONOMY || 'supervised').toLowerCase();

function _extractJson(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const a = t.indexOf('['); const b = t.lastIndexOf(']');
  if (a >= 0 && b > a) return t.substring(a, b + 1);
  return null;
}

function _parseSteps(text) {
  const json = _extractJson(text);
  if (json) {
    try { const arr = JSON.parse(json); if (Array.isArray(arr)) return arr.map(String).filter(Boolean); } catch { /* fall through */ }
  }
  // Fallback: split prose into bullet/numbered lines.
  return String(text || '').split('\n')
    .map(s => s.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter(Boolean);
}

function _matchAgent(step) {
  const s = step.toLowerCase();
  for (const a of agentRegistry.listAgents()) {
    if (s.includes(a.name.toLowerCase())) return a;
  }
  return null;
}

async function planGoal(goal, ctx) {
  const planner = {
    name: 'Planner', role: 'planner',
    description: 'Decompose a goal into an ordered list of concrete, executable steps. Respond ONLY with a JSON array of step strings.',
    tools: [],
  };
  const agentList = agentRegistry.agentNames().join(', ') || '(none registered)';
  const r = await runAgent(planner,
    `Goal: ${goal}\n\nAvailable specialist agents: ${agentList}\n\nReturn a JSON array of step strings that, executed in order, achieve the goal.`,
    ctx);
  return _parseSteps(r.output);
}

async function submitGoal(goal, ctx = {}, opts = {}) {
  const id = opts.runId || crypto.randomUUID();   // reuse a pre-created run id (async execution)
  const g = {
    id, kind: 'goal', name: String(goal).slice(0, 200), goal,
    orgId: ctx.orgId, userId: ctx.userId,
    status: 'planning',
    autonomy: (opts.autonomy || DEFAULT_AUTONOMY).toLowerCase(),
    steps: [], trace: [], result: null, output: null,
    createdAt: new Date().toISOString(),
  };
  await store.save(g);

  try {
    const steps = await planGoal(goal, ctx);
    g.steps = steps.map((s, i) => ({ index: i, step: s, status: 'pending' }));
  } catch (e) {
    g.status = 'failed'; g.error = e.message; await store.save(g); return g;
  }

  if (g.autonomy === 'supervised') {
    g.status = 'awaiting_approval';   // human must approve the plan
    await store.save(g);
    return g;
  }
  return _execute(g, ctx);
}

async function approveGoal(id, ctx = {}, { orgId } = {}) {
  // orgId scoping is mandatory: this APPROVES AND EXECUTES a plan, so an
  // unscoped lookup let any authenticated user run another tenant's goal.
  const g = await store.get(id, { orgId });
  if (!g) return null;
  if (g.status !== 'awaiting_approval') return g;
  return _execute(g, ctx);
}

async function _execute(g, ctx) {
  g.status = 'running';
  let state = g.goal;
  try {
    for (const st of g.steps) {
      st.status = 'running'; st.startedAt = new Date().toISOString();
      const agent = _matchAgent(st.step) || {
        name: 'Executor', role: 'executor',
        description: 'Execute the given step toward the goal.', tools: [],
      };
      const r = await runAgent(agent,
        `Goal: ${g.goal}\nCurrent step: ${st.step}\n\nContext so far:\n${state}`, ctx);
      st.output = r.output; st.via = agent.name; st.status = 'completed';
      st.completedAt = new Date().toISOString();
      g.trace.push({ step: st.step, agent: agent.name });
      state = r.output;
    }
    g.status = 'completed'; g.result = state; g.output = state;
  } catch (e) {
    g.status = 'failed'; g.error = e.message;
  }
  g.completedAt = new Date().toISOString();
  await store.save(g);
  return g;
}

async function getGoal(id, { orgId } = {}) { return store.get(id, { orgId }); }
async function listGoals(orgId) { return store.list({ kind: 'goal', orgId }); }

module.exports = { submitGoal, approveGoal, getGoal, listGoals, planGoal };

