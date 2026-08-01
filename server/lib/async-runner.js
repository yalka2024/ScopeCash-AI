/**
 * Background async runner for ScopeCash AI.
 *
 * Runs agents / workflows / goals OFF the request path: enqueue() creates a
 * durable run (status 'queued') and returns its id immediately, then the work
 * executes in the background and persists progress via the run-store — so the
 * caller polls GET .../runs/:id (or /goals/:id) instead of holding the request
 * open for a long agent loop.
 *
 *   - REDIS_URL set : BullMQ queue, consumed by the standalone worker process
 *                     (node worker.js) — survives an API restart, retries.
 *   - else          : in-process (setImmediate) — works with no extra process,
 *                     but a run in flight is lost if the API restarts (resume
 *                     is a planned follow-up). Status is durable either way.
 */
const crypto = require('crypto');
const store = require('./run-store');

const QUEUE_NAME = 'scopecash-ai-agent-jobs';
const REDIS_URL = process.env.REDIS_URL || '';
const CONCURRENCY = parseInt(process.env.AGENT_WORKER_CONCURRENCY || '2', 10);

let queue = null;
let worker = null;

function _initQueue() {
  if (queue || !REDIS_URL) return queue;
  try {
    const { Queue } = require('bullmq');
    const IORedis = require('ioredis');
    queue = new Queue(QUEUE_NAME, {
      connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  } catch (e) {
    console.warn('[async-runner] BullMQ unavailable; using in-process:', e.message);
    queue = null;
  }
  return queue;
}

async function _dispatch({ runId, kind, name, input, ctx }) {
  const base = { id: runId, kind, name, orgId: ctx.orgId, userId: ctx.userId, input };
  // Thread cooperative cancellation: the runtimes check ctx.isCancelled().
  const runCtx = { ...ctx, runId, isCancelled: () => store.isCancelled(runId) };
  try {
    if (kind === 'agent') {
      const agent = require('./agent-registry').getAgent(name);
      if (!agent) return store.save({ ...base, status: 'failed', error: `unknown agent: ${name}` });
      await store.save({ ...base, status: 'running' });
      const { runAgent } = require('./agent-runtime');
      const r = await runAgent(agent, input, runCtx);
      const status = r.cancelled ? 'cancelled' : (r.truncated ? 'truncated' : 'completed');
      return store.save({ ...base, status, output: r.output, steps: r.steps });
    }
    if (kind === 'workflow') {
      const wf = require('./workflow-registry').getWorkflow(name);
      if (!wf) return store.save({ ...base, status: 'failed', error: `unknown workflow: ${name}` });
      const { runWorkflow } = require('./workflow-runtime');
      return runWorkflow(wf, input, runCtx, runId);   // reuses runId, persists itself
    }
    if (kind === 'goal') {
      // orchestrator only exists in the agent-orchestrator archetype.
      const orchestrator = require('./orchestrator');
      return orchestrator.submitGoal(input, runCtx, { runId });
    }
    return store.save({ ...base, status: 'failed', error: `unknown kind: ${kind}` });
  } catch (e) {
    return store.save({ ...base, status: 'failed', error: e.message });
  } finally {
    store.clearCancel(runId);
  }
}

/**
 * Enqueue a background run. Returns the runId immediately.
 * @param {'agent'|'workflow'|'goal'} kind
 * @param {string} name   agent/workflow name (or the goal text for kind 'goal')
 * @param {string|object} input
 * @param {object} ctx    { orgId, userId, modelId, session }
 */
async function enqueue(kind, name, input, ctx = {}) {
  const runId = crypto.randomUUID();
  await store.save({
    id: runId, kind, name: String(name).slice(0, 200),
    orgId: ctx.orgId, userId: ctx.userId,
    input: typeof input === 'string' ? input : JSON.stringify(input || ''),
    status: 'queued', createdAt: new Date().toISOString(),
  });
  const job = { runId, kind, name, input, ctx };
  const q = _initQueue();
  if (q) {
    q.add('run', job, { jobId: runId }).catch(e => {
      console.error('[async-runner] enqueue failed; running in-process:', e.message);
      setImmediate(() => _dispatch(job).catch(() => {}));
    });
  } else {
    setImmediate(() => _dispatch(job).catch(e => console.error('[async-runner] in-process run failed:', e.message)));
  }
  return runId;
}

function startWorker() {
  if (worker || !REDIS_URL) return null;
  try {
    const { Worker } = require('bullmq');
    const IORedis = require('ioredis');
    worker = new Worker(QUEUE_NAME, async (job) => _dispatch(job.data), {
      connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency: CONCURRENCY,
    });
    worker.on('failed', (job, err) => console.error(`[async-runner] job ${job?.id} failed:`, err.message));
    return worker;
  } catch (e) {
    console.warn('[async-runner] worker start failed:', e.message);
    return null;
  }
}

async function stopWorker() {
  try { if (worker) await worker.close(); } catch {}
  try { if (queue) await queue.close(); } catch {}
  worker = null; queue = null;
}

// getRun is re-exported with its (id, { orgId }) signature intact — callers
// must scope. See lib/run-store.js#get for why this is not optional.
module.exports = { enqueue, startWorker, stopWorker, getRun: store.get };

