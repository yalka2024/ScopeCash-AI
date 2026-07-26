/**
 * Tool / integration adapter: CloudTasksEnqueuer
 * Durable async job queue for all agent runs, file processing, PDF rendering, email delivery, and retention jobs.
 *
 * Generated for ScopeCash AI.
 *
 * This is a PORT with two adapters:
 *   • mockRun  — deterministic, clearly-labeled fake data so the platform runs
 *                end-to-end today. Every result is tagged `_mock: true`.
 *   • realRun  — YOUR real integration. Implement it, flip `realImplemented` to
 *                true, and switch this tool live with:  INTEGRATION_CLOUDTASKSENQUEUER_MODE=live
 *
 * It NEVER silently returns fake data dressed as real: in live mode an
 * unimplemented realRun() THROWS, so nothing downstream mistakes a guess for truth.
 */
const NAME = "CloudTasksEnqueuer";
const ENV_KEY = 'INTEGRATION_CLOUDTASKSENQUEUER_MODE';
const safety = require('../safety');
const cloudTasks = require('../cloud-tasks');

const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Three-state capability status: 'mock' | 'live' | 'unimplemented'.
function status() {
  if (currentMode() === 'mock') return 'mock';
  return cloudTasks.isConfigured() ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  // Deterministic, obviously-fake placeholder. Shape it toward `outputs` so
  // screens/agents render — but it is NOT real data.
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — set ${ENV_KEY}=live (and GCP_PROJECT_ID + CLOUD_TASKS_INVOKER_SA) to enqueue a real Cloud Tasks task`,
    input,
  };
}

// Real Cloud Tasks enqueue — see lib/cloud-tasks.js for the client and
// routes/jobs.js for the receiving push endpoint + OIDC verification.
async function realRun(input, ctx) {
  if (!cloudTasks.isConfigured()) {
    const err = new Error(`${NAME}: GCP_PROJECT_ID and CLOUD_TASKS_INVOKER_SA are not set — cannot enqueue a real task (use ${ENV_KEY}=mock for demo data).`);
    err.code = 'integration_unconfigured'; err.statusCode = 501;
    throw err;
  }
  const targetUrl = process.env.CLOUD_TASKS_PUSH_URL;
  if (!targetUrl) {
    const err = new Error(`${NAME}: CLOUD_TASKS_PUSH_URL is not set — cannot enqueue without a push target.`);
    err.code = 'integration_unconfigured'; err.statusCode = 501;
    throw err;
  }
  const { task_payload, queue_name, schedule_time } = input || {};
  const delaySeconds = schedule_time ? Math.max(0, Math.floor((new Date(schedule_time).getTime() - Date.now()) / 1000)) : 0;
  const result = await cloudTasks.enqueueTask({
    queueName: queue_name || process.env.CLOUD_TASKS_QUEUE || 'scopecash-jobs',
    targetUrl, payload: task_payload || {}, delaySeconds,
  });
  return { task_id: result.taskName, queue_status: 'enqueued' };
}

module.exports = {
  name: NAME,
  description: "Durable async job queue for all agent runs, file processing, PDF rendering, email delivery, and retention jobs.",
  inputs: ["task_payload", "queue_name", "schedule_time"],
  outputs: ["task_id", "queue_status"],
  envKey: ENV_KEY,
  configKeys: [ENV_KEY],
  realImplemented,
  mode: currentMode,
  status,

  /**
   * @param {object} input  keyed by the declared input names
   * @param {object} ctx    { userId, orgId, modelId }
   * @returns {Promise<object>}
   */
  async run(input, ctx) {
    if (currentMode() === 'live') {
      safety.assertLiveAllowed(NAME);   // hard-block live mode on safety-gated platforms
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};

