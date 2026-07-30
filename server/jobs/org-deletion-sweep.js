/**
 * Scheduled sweep that executes org-wide deletion past the retention grace
 * period (lib/org-deletion.js does the actual work — see its header
 * comment). OFF by default (ORG_DELETION_SWEEP_ENABLED must be explicitly
 * set to '1') — this is a genuinely destructive, irreversible job, unlike
 * the other schedulers in this directory, and should not silently start
 * running the moment this file is required by a deployment that never
 * intended to use it.
 */
const orgDeletion = require('../lib/org-deletion');
const lease = require('../lib/scheduler-lease');

let timer = null;

async function runOnce({ dryRun = false } = {}) {
  const results = await orgDeletion.sweepOrgsForDeletion({ dryRun });
  if (results.length) {
    console.log(JSON.stringify({ type: 'org_deletion_sweep_run', dryRun, results }));
  }
  return results;
}

function startScheduler({ intervalMs = parseInt(process.env.ORG_DELETION_SWEEP_INTERVAL_MS || `${6 * 3600_000}`, 10) } = {}) {
  if (process.env.ORG_DELETION_SWEEP_ENABLED !== '1') return null;
  if (timer) return timer;
  const dryRun = process.env.ORG_DELETION_SWEEP_DRY_RUN === '1';
  const tick = async () => {
    try {
      // Leased. This sweep PERMANENTLY DELETES an organization's data across
      // 44 models — the single most irreversible scheduled action in the
      // system — and Cloud Run gives every instance its own copy of this
      // timer with no leader election. The underlying delete is idempotent
      // (a second pass finds nothing left to remove), so the risk is not
      // double-deletion but N concurrent destructive transactions racing over
      // the same rows. One winner per period removes that entirely.
      // See lib/scheduler-lease.js.
      await lease.withLease('org-deletion-sweep', () => runOnce({ dryRun }));
    } catch (err) {
      console.error(JSON.stringify({ type: 'org_deletion_sweep_error', error: err.message }));
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // First run shortly after boot rather than waiting a full interval.
  setTimeout(tick, 60_000).unref?.();
  return timer;
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { runOnce, startScheduler, stopScheduler };
