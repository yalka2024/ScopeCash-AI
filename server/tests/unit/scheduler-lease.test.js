/**
 * Single-winner lease for scheduled jobs.
 *
 * Cloud Run gives every instance (min 1, max 10 — deploy/terraform-gcp)
 * its own copy of each scheduled timer with no leader election. Most sweeps
 * are idempotent by construction, but lib/lifecycle-triggers.js sends email,
 * so a duplicate run means a duplicate message to a real customer.
 */
const prisma = require('../../lib/prisma');
const lease = require('../../lib/scheduler-lease');

const uid = (p) => `${p}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

afterAll(async () => { await prisma.$disconnect(); });

describe('claim', () => {
  test('exactly one caller wins a period, even when they race', async () => {
    const job = uid('job');
    const period = '2026-07-28T14';

    // All ten fire concurrently, as N instances genuinely would.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => lease.claim(job, period)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(9);
  });

  test('a later period is claimable again — this is not a mutex that jams', async () => {
    const job = uid('job');
    expect(await lease.claim(job, '2026-07-28T14')).toBe(true);
    expect(await lease.claim(job, '2026-07-28T15')).toBe(true);
  });

  test('different jobs do not block each other in the same period', async () => {
    const period = '2026-07-28T16';
    expect(await lease.claim(uid('a'), period)).toBe(true);
    expect(await lease.claim(uid('b'), period)).toBe(true);
  });

  test('fails OPEN when the lease table is unreachable', async () => {
    // A transient DB fault must not silently stop billing aggregation and
    // lifecycle sweeps entirely — duplicate work is the lesser failure, and
    // is exactly what the pre-lease behaviour did unconditionally.
    const spy = jest.spyOn(prisma.schedulerLease, 'create')
      .mockRejectedValue(new Error('connection refused'));
    expect(await lease.claim(uid('job'))).toBe(true);
    spy.mockRestore();
  });
});

describe('withLease', () => {
  test('runs the job for the winner and skips it for everyone else', async () => {
    const job = uid('job');
    const period = '2026-07-28T17';
    const fn = jest.fn().mockResolvedValue({ did: 'work' });

    const first = await lease.withLease(job, fn, period);
    const second = await lease.withLease(job, fn, period);

    expect(fn).toHaveBeenCalledTimes(1);          // the whole point
    expect(first).toEqual({ did: 'work' });
    expect(second).toMatchObject({ skipped: true });
  });

  test('a thrown job does not hold the period hostage for other jobs', async () => {
    const job = uid('job');
    await expect(lease.withLease(job, async () => { throw new Error('boom'); }, '2026-07-28T18'))
      .rejects.toThrow('boom');
    // Same job+period stays claimed (by design — "did anyone run this
    // period", not "is anyone running"), but the next period is free.
    expect(await lease.claim(job, '2026-07-28T19')).toBe(true);
  });
});

describe('pruneOldLeases', () => {
  test('removes rows past the retention window and keeps recent ones', async () => {
    const oldJob = uid('old');
    const newJob = uid('new');
    await prisma.schedulerLease.create({
      data: { jobName: oldJob, period: 'p1', claimedAt: new Date(Date.now() - 30 * 86400000) },
    });
    await prisma.schedulerLease.create({ data: { jobName: newJob, period: 'p1' } });

    await lease.pruneOldLeases(7);

    expect(await prisma.schedulerLease.findFirst({ where: { jobName: oldJob } })).toBeNull();
    expect(await prisma.schedulerLease.findFirst({ where: { jobName: newJob } })).toBeTruthy();
  });
});

describe('hourlyPeriodKey', () => {
  test('is UTC-based and hour-granular, so instances in any region agree', () => {
    expect(lease.hourlyPeriodKey(new Date('2026-07-28T14:59:59Z'))).toBe('2026-07-28T14');
    expect(lease.hourlyPeriodKey(new Date('2026-07-28T15:00:00Z'))).toBe('2026-07-28T15');
    // Zero-padded — string comparison must not reorder months/days/hours.
    expect(lease.hourlyPeriodKey(new Date('2026-01-05T03:00:00Z'))).toBe('2026-01-05T03');
  });
});
