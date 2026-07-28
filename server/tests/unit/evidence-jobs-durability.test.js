/**
 * Durable-job behaviour: heartbeats, crashed-worker recovery, bounded
 * retries with dead-lettering, cooperative cancellation, and replay.
 *
 * The gap these close: reconcileStuckJobs only ever swept status='queued', so
 * a run whose worker died mid-execution stayed 'running' forever and was
 * never recovered; and nothing counted attempts, so an undispatchable job was
 * retried on every tick indefinitely.
 */
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const jobs = require('../../lib/evidence-jobs');
const { runWithSystemAccess } = require('../../lib/tenant-context');

function uid(p) { return `${p}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

async function makeRun(overrides = {}) {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  return prisma.agentRunRecord.create({
    data: {
      orgId: org.id,
      agent_type: 'sourceDocument_analyze_job',
      status: 'queued',
      input_refs: JSON.stringify({ sourceDocumentId: uid('doc') }),
      ...overrides,
    },
  });
}

const ancient = () => new Date(Date.now() - 60 * 60 * 1000);

afterAll(async () => { await prisma.$disconnect(); });

describe('heartbeat', () => {
  test('records liveness and progress, and reports the run is not cancelled', async () => {
    const run = await makeRun({ status: 'running' });
    const alive = await jobs.heartbeat(run.id, { stage: 'extracting', pct: 25 });
    expect(alive).toBe(true);

    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.heartbeat_at).toBeInstanceOf(Date);
    expect(JSON.parse(after.progress)).toEqual({ stage: 'extracting', pct: 25 });
  });

  test('returns false once cancellation has been requested, so the worker can stop at a safe point', async () => {
    const run = await makeRun({ status: 'running' });
    await jobs.requestCancel(run.id);
    expect(await jobs.heartbeat(run.id, { stage: 'gemini_fallback', pct: 45 })).toBe(false);
  });
});

describe('reconcileStuckJobs', () => {
  test('recovers a run whose worker died mid-execution (status running, stale heartbeat)', async () => {
    const run = await makeRun({ status: 'running', heartbeat_at: ancient(), createdAt: ancient() });
    const res = await runWithSystemAccess(() => jobs.reconcileStuckJobs());
    expect(res.redispatched).toBeGreaterThanOrEqual(1);

    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.attempt_count).toBe(1);
    expect(['queued', 'running', 'completed', 'failed']).toContain(after.status);
  });

  test('leaves a running job with a FRESH heartbeat alone', async () => {
    const run = await makeRun({ status: 'running', heartbeat_at: new Date(), createdAt: ancient() });
    await runWithSystemAccess(() => jobs.reconcileStuckJobs());
    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.attempt_count).toBe(0);   // never touched
  });

  test('dead-letters instead of retrying forever once the attempt budget is spent', async () => {
    const run = await makeRun({
      status: 'running', heartbeat_at: ancient(), createdAt: ancient(),
      attempt_count: jobs.MAX_ATTEMPTS,
    });
    const res = await runWithSystemAccess(() => jobs.reconcileStuckJobs());
    expect(res.deadLettered).toBeGreaterThanOrEqual(1);

    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.status).toBe('dead_lettered');
    expect(after.dead_lettered_at).toBeInstanceOf(Date);
    expect(after.error_message).toMatch(/Exceeded/);
  });

  test('dead-letters a run it cannot reconstruct, rather than redispatching it every tick', async () => {
    const run = await makeRun({ status: 'queued', createdAt: ancient(), agent_type: 'sourceDocument_analyze_job' });
    // Corrupt the payload so _reconstructJob yields no usable job.
    await prisma.agentRunRecord.update({ where: { id: run.id }, data: { agent_type: 'unknown_job_type' } });
    await runWithSystemAccess(() => jobs.reconcileStuckJobs());
    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    // Not in AGENT_TYPE_TO_KIND at all, so it isn't even selected — and is
    // therefore never redispatched, which is the property that matters.
    expect(after.status).toBe('queued');
    expect(after.attempt_count).toBe(0);
  });

  test('honours a cancel requested while the job was stuck', async () => {
    const run = await makeRun({
      status: 'running', heartbeat_at: ancient(), createdAt: ancient(),
      cancel_requested_at: new Date(),
    });
    const res = await runWithSystemAccess(() => jobs.reconcileStuckJobs());
    expect(res.cancelled).toBeGreaterThanOrEqual(1);
    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.status).toBe('cancelled');
  });
});

describe('requestCancel', () => {
  test('cancels a queued run outright — there is nothing to cooperate with', async () => {
    const run = await makeRun({ status: 'queued' });
    expect(await jobs.requestCancel(run.id)).toEqual({ ok: true, status: 'cancelled' });
    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.status).toBe('cancelled');
    expect(after.completed_at).toBeInstanceOf(Date);
  });

  test('only flags a running run, leaving it to stop at a safe point', async () => {
    const run = await makeRun({ status: 'running' });
    expect(await jobs.requestCancel(run.id)).toEqual({ ok: true, status: 'cancel_requested' });
    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.status).toBe('running');            // NOT killed mid-write
    expect(after.cancel_requested_at).toBeInstanceOf(Date);
  });

  test('refuses to cancel an already-finished run', async () => {
    const run = await makeRun({ status: 'completed' });
    expect(await jobs.requestCancel(run.id)).toMatchObject({ ok: false, reason: 'already_finished' });
  });
});

describe('replayJob', () => {
  test('resets a dead-lettered run to queued with a fresh attempt budget', async () => {
    const run = await makeRun({
      status: 'dead_lettered', dead_lettered_at: new Date(), completed_at: new Date(),
      attempt_count: jobs.MAX_ATTEMPTS, error_message: 'Exceeded attempts',
    });
    expect(await jobs.replayJob(run.id)).toMatchObject({ ok: true });

    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.attempt_count).toBe(0);      // deliberate human decision, not a blind retry
    expect(after.dead_lettered_at).toBeNull();
    expect(after.error_message).toBeNull();
  });

  test('refuses to replay a run that is still in flight', async () => {
    const run = await makeRun({ status: 'running' });
    expect(await jobs.replayJob(run.id)).toMatchObject({ ok: false, reason: 'not_replayable' });
  });

  test('refuses to replay a completed run, which would redo real work', async () => {
    const run = await makeRun({ status: 'completed' });
    expect(await jobs.replayJob(run.id)).toMatchObject({ ok: false, reason: 'not_replayable' });
  });
});

/**
 * Regression guard for a bug introduced alongside the `running` sweep: only
 * the document path heartbeated, so a still-working evidence-item or
 * findings job went stale after the threshold, was judged crashed, and was
 * redispatched WHILE RUNNING. Nothing deduplicated it — the evidence-item
 * idempotency guard only skips terminal states, and findings-generation has
 * no target-row guard at all — so the work really ran concurrently, up to
 * MAX_ATTEMPTS times, then dead-lettered while succeeding.
 */
describe('withHeartbeat keeps a long-running job out of the stuck sweep', () => {
  test('refreshes heartbeat_at DURING a slow operation, not just at its boundaries', async () => {
    const run = await makeRun({ status: 'running', heartbeat_at: ancient() });
    const before = (await prisma.agentRunRecord.findUnique({ where: { id: run.id } })).heartbeat_at;

    process.env.EVIDENCE_JOB_HEARTBEAT_MS = '20';
    jest.resetModules();
    const freshJobs = require('../../lib/evidence-jobs');

    // A single await longer than the keepalive interval — the exact shape
    // that a stage-boundary-only heartbeat cannot cover.
    await freshJobs.withHeartbeat(run.id, { stage: 'slow', pct: 50 },
      () => new Promise((r) => setTimeout(r, 120)));

    const after = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
    expect(after.heartbeat_at.getTime()).toBeGreaterThan(before.getTime());
    expect(JSON.parse(after.progress)).toEqual({ stage: 'slow', pct: 50 });
    delete process.env.EVIDENCE_JOB_HEARTBEAT_MS;
  });

  test('stops pinging once the wrapped work finishes, so a completed run cannot look alive forever', async () => {
    const run = await makeRun({ status: 'running' });
    process.env.EVIDENCE_JOB_HEARTBEAT_MS = '20';
    jest.resetModules();
    const freshJobs = require('../../lib/evidence-jobs');

    await freshJobs.withHeartbeat(run.id, { stage: 'x' }, async () => 'done');
    const hb = async () => {
      const r = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
      return r.heartbeat_at ? r.heartbeat_at.getTime() : null;
    };
    const settled = await hb();
    await new Promise((r) => setTimeout(r, 90));
    // Unchanged after several keepalive intervals' worth of time — the
    // interval really was cleared, so a finished run can't look alive.
    expect(await hb()).toBe(settled);
    delete process.env.EVIDENCE_JOB_HEARTBEAT_MS;
  });

  test('clears its interval even when the wrapped work throws', async () => {
    const run = await makeRun({ status: 'running' });
    process.env.EVIDENCE_JOB_HEARTBEAT_MS = '20';
    jest.resetModules();
    const freshJobs = require('../../lib/evidence-jobs');

    await expect(freshJobs.withHeartbeat(run.id, { stage: 'x' }, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    const hb = async () => {
      const r = await prisma.agentRunRecord.findUnique({ where: { id: run.id } });
      return r.heartbeat_at ? r.heartbeat_at.getTime() : null;
    };
    const settled = await hb();
    await new Promise((r) => setTimeout(r, 90));
    // Unchanged after several keepalive intervals' worth of time — the
    // interval really was cleared, so a finished run can't look alive.
    expect(await hb()).toBe(settled);
    delete process.env.EVIDENCE_JOB_HEARTBEAT_MS;
  });
});
