/**
 * Cloud Tasks push target. Not behind authMiddleware — the caller is Cloud
 * Tasks itself, not a logged-in user; it's authenticated by verifying the
 * OIDC token GCP attaches to every push (lib/cloud-tasks.js#verifyPushToken),
 * scoped to this exact endpoint URL as the token audience.
 */
const express = require('express');
const { asyncHandler, HttpError } = require('../lib/validate');
const cloudTasks = require('../lib/cloud-tasks');
const worker = require('../lib/worker');

const router = express.Router();

router.post('/process-task', asyncHandler(async (req, res) => {
  if (!cloudTasks.isConfigured()) throw new HttpError(503, 'Cloud Tasks is not configured', 'cloud_tasks_unconfigured');
  const authz = req.headers.authorization || '';
  if (!authz.startsWith('Bearer ')) throw new HttpError(401, 'Missing push authentication token', 'unauthorized');

  const audience = process.env.CLOUD_TASKS_PUSH_AUDIENCE || `${req.protocol}://${req.get('host')}/api/jobs/process-task`;
  await cloudTasks.verifyPushToken(authz.slice(7), audience); // throws on any invalid/expired/wrong-audience token

  await worker.runJob(req.body || {});
  res.json({ ok: true });
}));

module.exports = router;
