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

if (!process.env.REDIS_URL) {
  console.log('[worker] REDIS_URL not set; nothing to do (API uses in-process queue).');
  process.exit(0);
}

const w = startBullWorker();
if (!w) {
  console.error('[worker] failed to start BullMQ worker');
  process.exit(1);
}
asyncRunner.startWorker();   // background agent/workflow/goal runs
console.log(`[worker] started; concurrency=${process.env.WORKER_CONCURRENCY || 4}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received; draining...`);
  try { await stopBullWorker(); } catch {}
  try { await asyncRunner.stopWorker(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

