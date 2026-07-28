/**
 * Single-winner lease for scheduled jobs across multiple instances.
 *
 * Cloud Run runs 1..N instances (deploy/terraform-gcp/main.tf: min 1, max 10)
 * and every instance independently schedules the same hourly/daily jobs —
 * there is no leader election. Most sweeps are idempotent by construction
 * (lib/billing/dunning.js transitions on `where: { status }`, so a second
 * pass matches nothing; retention deletes by explicit id), but
 * lib/lifecycle-triggers.js EMITS NOTIFICATIONS — a second instance running
 * the same period sends the same customer a second email.
 *
 * The unique constraint on (jobName, period) IS the lock: every instance
 * attempts the same insert, exactly one succeeds, the losers get P2002 and
 * skip. No new infrastructure, no advisory-lock syntax, and identical
 * behaviour on SQLite and Postgres.
 *
 * Deliberately NOT a mutual-exclusion lock with heartbeats and takeover: this
 * is "did anyone already run this period?", not "is anyone running right
 * now". A crashed holder does not block the next period, and the cost of a
 * missed period is one late sweep — strictly better than the duplicate-email
 * failure it replaces. Jobs that must never be skipped should not use this.
 */
const prisma = require('./prisma');
const { runWithSystemAccess } = require('./tenant-context');

/** Hour-granularity period key in UTC, e.g. "2026-07-28T14". Matches the
 * hourly cadence every current caller uses. */
function hourlyPeriodKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
}

/** Instance identity, for debugging only — never used for correctness. */
const INSTANCE = process.env.K_REVISION || process.env.HOSTNAME || `pid-${process.pid}`;

/**
 * Try to claim `jobName` for `period`. Returns true for exactly one caller
 * per (jobName, period), false for everyone else.
 *
 * Fails OPEN: if the lease table is unreachable we return true and let the
 * job run. A transient database problem should not silently stop billing
 * aggregation or lifecycle sweeps altogether — duplicate work is the lesser
 * failure, and it is what the previous behaviour did unconditionally anyway.
 */
async function claim(jobName, period = hourlyPeriodKey()) {
  try {
    await runWithSystemAccess(() => prisma.schedulerLease.create({
      data: { jobName, period, claimedBy: INSTANCE },
    }));
    return true;
  } catch (err) {
    if (err && err.code === 'P2002') return false; // another instance won
    console.warn(JSON.stringify({
      severity: 'WARNING', type: 'scheduler_lease_unavailable',
      jobName, period, error: err && err.message,
    }));
    return true;
  }
}

/**
 * Wrap a scheduled tick so it only runs on the instance that wins the period.
 * Returns the job's result, or { skipped: true } on the instances that lost.
 */
async function withLease(jobName, fn, period = hourlyPeriodKey()) {
  if (!await claim(jobName, period)) {
    return { skipped: true, reason: 'another instance holds this period', jobName, period };
  }
  return fn();
}

/** Drop lease rows older than `olderThanDays`. The table is append-only, one
 * row per job per period, so it grows slowly — but unbounded is still
 * unbounded. Called from the hourly aggregator. */
async function pruneOldLeases(olderThanDays = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  return runWithSystemAccess(() => prisma.schedulerLease.deleteMany({
    where: { claimedAt: { lt: cutoff } },
  })).catch(() => ({ count: 0 }));
}

module.exports = { claim, withLease, pruneOldLeases, hourlyPeriodKey, INSTANCE };
