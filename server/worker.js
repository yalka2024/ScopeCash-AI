/**
 * ScopeCash AI — Standalone Worker Process
 *
 * Run this as a separate process when REDIS_URL is configured for true
 * background processing decoupled from the API server:
 *   node worker.js
 *
 * In dev (no REDIS_URL), the in-process queue inside the API serves jobs;
 * starting this file is harmless and exits immediately.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { startBullWorker, stopBullWorker } = require('./lib/worker');
const asyncRunner = require('./lib/async-runner');
const evidenceJobs = require('./lib/evidence-jobs');

if (!process.env.REDIS_URL) {
  console.log('[worker] REDIS_URL not set; nothing to do (API uses in-process queue).');
  process.exit(0);
}

async function start() {
  // Same Cloud SQL IAM database auth the API process establishes before
  // serving (index.js). This process runs the SAME Prisma client against the
  // SAME database, so without this it would keep using the static-password
  // DATABASE_URL even with CLOUD_SQL_IAM_AUTH=1 — leaving half the deployment
  // on password auth and silently defeating the point of enabling it.
  // No-op unless CLOUD_SQL_IAM_AUTH=1; fails closed if enabled and
  // misconfigured. Awaited before any worker starts consuming jobs.
  await require('./lib/prisma').initCloudSqlIamAuth();

  const w = startBullWorker();
  if (!w) {
    console.error('[worker] failed to start BullMQ worker');
    process.exit(1);
  }
  asyncRunner.startWorker();   // background agent/workflow/goal runs
  evidenceJobs.startWorker();  // background evidence analysis (documents/photos/audio/findings)
  evidenceJobs.startReconciler(); // recovers AgentRunRecord rows stuck at 'queued', or 'running' with a stale heartbeat
  console.log(`[worker] started; concurrency=${process.env.WORKER_CONCURRENCY || 4}`);
}

start().catch((err) => {
  console.error('[worker] FATAL: startup failed —', err && err.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received; draining...`);
  try { await stopBullWorker(); } catch {}
  try { await asyncRunner.stopWorker(); } catch {}
  try { await evidenceJobs.stopWorker(); } catch {}
  try { evidenceJobs.stopReconciler(); } catch {}
  // Releases the IAM connector's background cert-refresh cycle, which would
  // otherwise keep this process alive past shutdown.
  try { await require('./lib/prisma').shutdownCloudSqlIamAuth(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

