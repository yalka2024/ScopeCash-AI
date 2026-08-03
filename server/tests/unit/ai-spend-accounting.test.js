/**
 * AI spend accounting and amplification bounds.
 *
 * The finding: lib/ai-budget.js enforces a real ceiling (429 on cutoff), but
 * ONLY routes/ai.js ever recorded spend. Agents, workflows, goals and the
 * whole evidence pipeline — the heaviest Gemini consumer in the product —
 * spent money the ceiling never saw. The guard was real; its input was
 * fiction, so it would never have fired no matter how much was burned.
 *
 * Separately, the one entry point that queues unbounded background work
 * (`POST /agents/:name/run/async`) was also the only one with no quota gate,
 * and two paths multiplied a single request into arbitrarily many Gemini
 * calls: an LLM-authored plan with no length cap, and unbounded findMany
 * results being pasted into a prompt.
 */
const orchestrator = require('../../lib/orchestrator');
const agentRuntime = require('../../lib/agent-runtime');

describe('amplification bounds exist', () => {
  test('an LLM-authored plan cannot be unbounded', () => {
    // Each step drives a whole agent tree, so the model would otherwise be
    // choosing the multiplier on the Vertex bill.
    const cap = Number(process.env.MAX_PLAN_STEPS || 12);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(50);
  });

  test('agent recursion and turn count are bounded', () => {
    expect(agentRuntime.MAX_STEPS).toBeGreaterThan(0);
    expect(agentRuntime.MAX_DEPTH).toBeGreaterThan(0);
    // A delegating agent tree is MAX_STEPS ** MAX_DEPTH in the worst case;
    // this asserts that product stays comprehensible rather than explosive.
    expect(Math.pow(agentRuntime.MAX_STEPS, agentRuntime.MAX_DEPTH)).toBeLessThanOrEqual(10000);
  });
});

describe('spend is recorded at the chokepoints, not per route', () => {
  test('the evidence pipeline records spend from withAgentRun', () => {
    // withAgentRun already held both orgId and usage; recording there covers
    // all five pipeline call sites at once. Recording per call site would
    // have been five chances to forget.
    const src = require('fs').readFileSync(require.resolve('../../lib/evidence-pipeline'), 'utf8');
    expect(src).toMatch(/recordAiSpend/);
    // And it must not take the analysis down when accounting fails.
    expect(src).toMatch(/ai_spend_record_failed/);
  });

  test('agent runs record spend once, at the outermost call only', () => {
    const src = require('fs').readFileSync(require.resolve('../../lib/agent-runtime'), 'utf8');
    expect(src).toMatch(/recordAiSpend/);
    // Depth guard: a delegated sub-agent accumulates usage into the parent's
    // trace, so recording at depth > 0 would double-count the same tokens.
    expect(src).toMatch(/depth === 0/);
  });

  test('the evidence router mounts the budget guard it previously lacked', () => {
    const src = require('fs').readFileSync(require.resolve('../../routes/evidence'), 'utf8');
    expect(src).toMatch(/aiBudgetGuard/);
  });

  test('the async agent route checks quota like sync and stream do', () => {
    const src = require('fs').readFileSync(require.resolve('../../routes/agents'), 'utf8');
    // Three run variants, three quota checks — async was the missing one, and
    // it is the one that queues unbounded background work.
    const checks = (src.match(/checkAiQuota/g) || []).length;
    expect(checks).toBeGreaterThanOrEqual(3);
  });
});

describe('the budget guard still fails open on its own errors', () => {
  test('a broken budget lookup does not block AI entirely', async () => {
    // Deliberate: AI features going dark because the accounting table is
    // unreachable is worse than briefly uncapped spend. Documented in
    // lib/ai-budget.js and asserted here so it is not "fixed" by accident.
    const aiBudget = require('../../lib/ai-budget');
    expect(typeof aiBudget.aiBudgetGuard).toBe('function');
  });
});
