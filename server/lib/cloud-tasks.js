/**
 * Real Cloud Tasks client (replaces the CloudTasksEnqueuer mock, which threw
 * "not implemented" in live mode). Push-based, unlike BullMQ's pull worker:
 * Cloud Tasks itself HTTP-POSTs each task to `targetUrl` with an OIDC token,
 * and GCP manages retry/backoff/dead-lettering at the queue level.
 *
 * routes/jobs.js is the receiving end (`/api/jobs/process-task`), which
 * verifies the OIDC token before running the job.
 */
const { CloudTasksClient } = require('@google-cloud/tasks');
const { OAuth2Client } = require('google-auth-library');

const PROJECT = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null;
const LOCATION = process.env.GCP_TASKS_LOCATION || process.env.GCP_LOCATION || 'us-central1';
// The service account Cloud Tasks impersonates to mint the OIDC token it
// attaches to each push — must have roles/cloudtasks.enqueuer and be
// allowed to invoke the target (e.g. roles/run.invoker on Cloud Run).
const INVOKER_SERVICE_ACCOUNT = process.env.CLOUD_TASKS_INVOKER_SA || null;

function isConfigured() {
  return !!(PROJECT && INVOKER_SERVICE_ACCOUNT);
}

let _client = null;
function client() {
  if (!isConfigured()) {
    throw Object.assign(
      new Error('Cloud Tasks is not configured: set GCP_PROJECT_ID and CLOUD_TASKS_INVOKER_SA.'),
      { code: 'cloud_tasks_unconfigured' },
    );
  }
  if (!_client) _client = new CloudTasksClient();
  return _client;
}

/**
 * @param {object} opts
 * @param {string} opts.queueName
 * @param {string} opts.targetUrl the push endpoint (routes/jobs.js's /process-task)
 * @param {object} opts.payload JSON body delivered to targetUrl
 * @param {number} [opts.delaySeconds]
 * @returns {Promise<{taskName:string}>}
 */
async function enqueueTask({ queueName, targetUrl, payload, delaySeconds = 0 }) {
  if (!queueName) throw new Error('enqueueTask: queueName is required');
  if (!targetUrl) throw new Error('enqueueTask: targetUrl is required');
  const c = client();
  const parent = c.queuePath(PROJECT, LOCATION, queueName);
  const body = Buffer.from(JSON.stringify(payload || {})).toString('base64');
  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: targetUrl,
      headers: { 'Content-Type': 'application/json' },
      body,
      oidcToken: { serviceAccountEmail: INVOKER_SERVICE_ACCOUNT, audience: targetUrl },
    },
    ...(delaySeconds > 0 ? { scheduleTime: { seconds: Math.floor(Date.now() / 1000) + Math.floor(delaySeconds) } } : {}),
  };
  const [response] = await c.createTask({ parent, task });
  return { taskName: response.name };
}

/** Verifies the OIDC token Cloud Tasks attaches to each push. Throws on any
 * invalid/expired/wrong-audience token — routes/jobs.js relies on this being
 * the ONLY thing standing between the public internet and running a job. */
async function verifyPushToken(idToken, expectedAudience) {
  const oauth = new OAuth2Client();
  const ticket = await oauth.verifyIdToken({ idToken, audience: expectedAudience });
  const payload = ticket.getPayload();
  if (INVOKER_SERVICE_ACCOUNT && payload.email !== INVOKER_SERVICE_ACCOUNT) {
    throw new Error(`OIDC token email "${payload.email}" does not match configured CLOUD_TASKS_INVOKER_SA`);
  }
  return payload;
}

module.exports = { isConfigured, enqueueTask, verifyPushToken, PROJECT, LOCATION };
