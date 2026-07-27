/**
 * Durable background processing for evidence analysis — the async
 * counterpart to routes/evidence.js's three analyze endpoints, which
 * previously ran the whole Gemini pipeline synchronously in the HTTP
 * request. Same three-backend resilience pattern as lib/async-runner.js
 * (agent runs) and lib/worker.js (legacy generic risk-scan jobs):
 *
 *   - JOBS_BACKEND=cloud-tasks + Cloud Tasks configured: push-based via
 *     lib/cloud-tasks.js, delivered back to routes/jobs.js#/process-task.
 *     Survives API restarts/redeploys; GCP manages retry/backoff.
 *   - REDIS_URL set: BullMQ queue, consumed by a Worker in this same
 *     process (or a standalone worker process) — survives an API restart.
 *   - Neither configured: in-process (setImmediate) — zero extra
 *     infrastructure for local dev, but a job in flight is lost if the API
 *     process restarts before it finishes.
 *
 * The "job" (queued -> running -> completed/failed, pollable) is tracked
 * on a dedicated AgentRunRecord row created eagerly (status 'queued')
 * BEFORE the job is dispatched, so the client has something to poll
 * (GET /api/agentRunRecords/:id) immediately after the 202 response — the
 * granular per-Gemini-call AgentRunRecord rows evidence-pipeline.js's own
 * withAgentRun() creates internally are unaffected and still exist for
 * detailed cost/latency accounting; this is a coarser, outer "did my
 * analyze request finish" record whose output_refs ends up holding exactly
 * the same JSON shape the old synchronous 200 response used to return.
 *
 * Idempotency: Cloud Tasks (and BullMQ retries) can and will redeliver a
 * job more than once. Every handler below re-checks the target row's own
 * status column (SourceDocument.extraction_status /
 * EvidenceItem.analysisStatus) immediately before doing any work, and
 * no-ops if it's already past 'processing' — never blindly reprocesses.
 */
const prisma = require('./prisma');
const storage = require('./storage');
const pipeline = require('./evidence-pipeline');
const vertex = require('./vertex-ai');
const cloudTasks = require('./cloud-tasks');
const { runWithOrg, runWithSystemAccess } = require('./tenant-context');

const MIN_EXTRACTED_CHARS = 20;
const QUEUE_NAME = 'scopecash-ai-evidence-jobs';
const REDIS_URL = process.env.REDIS_URL || '';
const JOBS_BACKEND = (process.env.JOBS_BACKEND || '').toLowerCase();

function useCloudTasks() { return JOBS_BACKEND === 'cloud-tasks' && cloudTasks.isConfigured(); }

let bullQueue = null;
let bullWorker = null;
function _initBull() {
  if (bullQueue || !REDIS_URL) return bullQueue;
  try {
    const { Queue } = require('bullmq');
    const IORedis = require('ioredis');
    bullQueue = new Queue(QUEUE_NAME, {
      connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  } catch (e) {
    console.warn('[evidence-jobs] BullMQ unavailable; using in-process:', e.message);
    bullQueue = null;
  }
  return bullQueue;
}

function startWorker() {
  if (bullWorker || !REDIS_URL || useCloudTasks()) return null;
  try {
    const { Worker } = require('bullmq');
    const IORedis = require('ioredis');
    bullWorker = new Worker(QUEUE_NAME, async (job) => processJob(job.data), {
      connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency: parseInt(process.env.EVIDENCE_WORKER_CONCURRENCY || '2', 10),
    });
    bullWorker.on('failed', (job, err) => console.error(`[evidence-jobs] job ${job?.id} failed:`, err.message));
    return bullWorker;
  } catch (e) {
    console.warn('[evidence-jobs] worker start failed:', e.message);
    return null;
  }
}

async function stopWorker() {
  try { if (bullWorker) await bullWorker.close(); } catch {}
  try { if (bullQueue) await bullQueue.close(); } catch {}
  bullWorker = null; bullQueue = null;
}

/** Dispatches a prepared job onto whichever backend is configured — shared
 * by every enqueue*() function below. */
async function _dispatch(job) {
  if (useCloudTasks()) {
    const targetUrl = process.env.CLOUD_TASKS_PUSH_URL;
    if (targetUrl) {
      try {
        await cloudTasks.enqueueTask({
          queueName: process.env.CLOUD_TASKS_EVIDENCE_QUEUE || 'scopecash-evidence-jobs',
          targetUrl,
          payload: { __evidenceJob: true, ...job },
        });
        return;
      } catch (err) {
        console.error('[evidence-jobs] Cloud Tasks enqueue failed; falling back:', err.message);
      }
    } else {
      console.error('[evidence-jobs] JOBS_BACKEND=cloud-tasks but CLOUD_TASKS_PUSH_URL is unset; falling back');
    }
  }
  const q = _initBull();
  if (q) {
    q.add('process', job, { jobId: job.runId }).catch((err) => {
      console.error('[evidence-jobs] BullMQ enqueue failed; running in-process:', err.message);
      setImmediate(() => processJob(job).catch(() => {}));
    });
    return;
  }
  setImmediate(() => processJob(job).catch((err) => console.error('[evidence-jobs] in-process job failed:', err.message)));
}

async function _createJobRun({ orgId, projectId, agentType, inputRefs }) {
  return prisma.agentRunRecord.create({
    data: { orgId, project_id: projectId || null, agent_type: agentType, status: 'queued', input_refs: JSON.stringify(inputRefs || {}) },
  });
}

async function _finishJobRun(runId, { status, outputRefs, errorMessage }) {
  return prisma.agentRunRecord.update({
    where: { id: runId },
    data: {
      status,
      output_refs: outputRefs ? JSON.stringify(outputRefs) : undefined,
      error_message: errorMessage || null,
      completed_at: new Date(),
    },
  }).catch((err) => console.error(`[evidence-jobs] failed to finalize run ${runId}:`, err.message));
}

async function _markRunning(runId) {
  return prisma.agentRunRecord.update({ where: { id: runId }, data: { status: 'running' } }).catch(() => {});
}

// ── SourceDocument analysis ──────────────────────────────────────────────
async function enqueueSourceDocumentAnalysis({ sourceDocumentId, orgId, projectId }) {
  const run = await _createJobRun({ orgId, projectId, agentType: 'sourceDocument_analyze_job', inputRefs: { sourceDocumentId } });
  await prisma.sourceDocument.update({ where: { id: sourceDocumentId }, data: { extraction_status: 'processing' } });
  await _dispatch({ runId: run.id, kind: 'sourceDocument.analyze', sourceDocumentId, orgId, projectId });
  return run.id;
}

async function _processSourceDocumentAnalyze({ runId, sourceDocumentId, orgId, projectId }) {
  const sourceDocument = await prisma.sourceDocument.findFirst({ where: { id: sourceDocumentId, orgId } });
  if (!sourceDocument) return _finishJobRun(runId, { status: 'failed', errorMessage: 'sourceDocument no longer exists' });
  // Idempotency: a redelivered task after this already completed/failed is a
  // no-op — never re-run analysis that already produced a real result.
  if (sourceDocument.extraction_status === 'extracted' || sourceDocument.extraction_status === 'failed') {
    return _finishJobRun(runId, { status: sourceDocument.extraction_status === 'extracted' ? 'completed' : 'failed', outputRefs: { note: 'already processed; redelivery skipped' } });
  }
  await _markRunning(runId);
  const project = await prisma.projectRecord.findFirst({ where: { id: sourceDocument.project_id, orgId } });

  try {
    const stream = await storage.getStream(sourceDocument.storage_uri);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    let extracted = await pipeline.extractDocumentText({ mimeType: sourceDocument.mime_type, buffer });
    let geminiFallbackRunId = null;
    const needsFallback = !extracted || (extracted.text || '').trim().length < MIN_EXTRACTED_CHARS;
    if (needsFallback) {
      if (!vertex.isConfigured()) {
        await prisma.sourceDocument.update({ where: { id: sourceDocument.id }, data: { extraction_status: 'failed' } });
        const reason = extracted ? 'appears to be a scanned/image-only document with no extractable text layer' : `no local text extractor for mime type ${sourceDocument.mime_type}`;
        return _finishJobRun(runId, { status: 'failed', errorMessage: `This document ${reason}, and Gemini (the native-document fallback) is not configured.` });
      }
      const gcsUri = storage.gcsUri(sourceDocument.storage_uri);
      const viaGemini = await pipeline.extractDocumentTextViaGemini({
        orgId, projectId: project.id, sourceDocumentId: sourceDocument.id,
        mimeType: sourceDocument.mime_type, buffer: gcsUri ? undefined : buffer, gcsUri,
      });
      geminiFallbackRunId = viaGemini.agentRunId;
      if (viaGemini.unreadable || viaGemini.text.trim().length === 0) {
        await prisma.sourceDocument.update({ where: { id: sourceDocument.id }, data: { extraction_status: 'failed' } });
        return _finishJobRun(runId, { status: 'failed', errorMessage: 'Gemini could not read any text from this document — it may be blank, corrupted, or too low quality to transcribe.', outputRefs: { geminiFallbackRunId } });
      }
      extracted = { text: viaGemini.text, pages: null, method: viaGemini.method };
    }

    let baseline = null;
    if (['contract', 'estimate', 'change_order'].includes(sourceDocument.document_type)) {
      baseline = await pipeline.extractContractBaseline({ orgId, project, sourceDocument, extractedText: extracted.text });
    }
    await prisma.sourceDocument.update({
      where: { id: sourceDocument.id },
      data: { extraction_status: 'extracted', page_count: extracted.pages ? extracted.pages.length : sourceDocument.page_count },
    });

    const outputRefs = {
      extraction: { method: extracted.method, textLength: extracted.text.length, pageCount: extracted.pages ? extracted.pages.length : null, geminiFallbackRunId },
      baseline: baseline ? { scopeItemCount: baseline.scopeItems.length, contractProvisionCount: baseline.contractProvisions.length, agentRunId: baseline.agentRunId } : null,
    };
    return _finishJobRun(runId, { status: 'completed', outputRefs });
  } catch (err) {
    await prisma.sourceDocument.update({ where: { id: sourceDocument.id }, data: { extraction_status: 'failed' } }).catch(() => {});
    return _finishJobRun(runId, { status: 'failed', errorMessage: String((err && err.message) || err) });
  }
}

// ── EvidenceItem analysis ────────────────────────────────────────────────
async function enqueueEvidenceItemAnalysis({ evidenceItemId, orgId, projectId }) {
  const run = await _createJobRun({ orgId, projectId, agentType: 'evidenceItem_analyze_job', inputRefs: { evidenceItemId } });
  await prisma.evidenceItem.update({ where: { id: evidenceItemId }, data: { analysisStatus: 'processing' } });
  await _dispatch({ runId: run.id, kind: 'evidenceItem.analyze', evidenceItemId, orgId, projectId });
  return run.id;
}

async function _processEvidenceItemAnalyze({ runId, evidenceItemId, orgId }) {
  const evidenceItem = await prisma.evidenceItem.findFirst({ where: { id: evidenceItemId, orgId } });
  if (!evidenceItem) return _finishJobRun(runId, { status: 'failed', errorMessage: 'evidenceItem no longer exists' });
  if (evidenceItem.analysisStatus === 'completed' || evidenceItem.analysisStatus === 'failed') {
    return _finishJobRun(runId, { status: evidenceItem.analysisStatus, outputRefs: { note: 'already processed; redelivery skipped' } });
  }
  await _markRunning(runId);

  try {
    const mimeType = evidenceItem.mimeType || (evidenceItem.evidenceType === 'photo' ? 'image/jpeg' : 'audio/mpeg');
    const gcsUri = storage.gcsUri(evidenceItem.storageUri);
    let base64 = null;
    if (!gcsUri) {
      const stream = await storage.getStream(evidenceItem.storageUri);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      base64 = Buffer.concat(chunks).toString('base64');
    }

    let result;
    if (evidenceItem.evidenceType === 'audio') {
      result = await pipeline.transcribeAudio({ orgId, evidenceItem, gcsUri, base64, mimeType });
    } else if (evidenceItem.evidenceType === 'photo') {
      result = await pipeline.interpretImage({ orgId, evidenceItem, gcsUri, base64, mimeType });
    } else {
      await prisma.evidenceItem.update({ where: { id: evidenceItemId }, data: { analysisStatus: 'failed' } });
      return _finishJobRun(runId, { status: 'failed', errorMessage: `No Gemini analysis path for evidenceType "${evidenceItem.evidenceType}" yet` });
    }
    await prisma.evidenceItem.update({ where: { id: evidenceItemId }, data: { analysisStatus: 'completed' } });
    return _finishJobRun(runId, { status: 'completed', outputRefs: { evidenceItemId: result.evidenceItem.id, agentRunId: result.agentRunId } });
  } catch (err) {
    await prisma.evidenceItem.update({ where: { id: evidenceItemId }, data: { analysisStatus: 'failed' } }).catch(() => {});
    return _finishJobRun(runId, { status: 'failed', errorMessage: String((err && err.message) || err) });
  }
}

// ── Findings generation ──────────────────────────────────────────────────
async function enqueueFindingsGeneration({ projectId, orgId, changeEventId }) {
  // No single target row to gate on (this compares ALL evidence for the
  // project) — idempotency here means "don't let two generation runs race
  // for the same project," not "skip if already done" (re-running is a
  // legitimate, repeatable action as new evidence arrives).
  const already = await prisma.agentRunRecord.findFirst({
    where: { orgId, project_id: projectId, agent_type: 'findings_generate_job', status: { in: ['queued', 'running'] } },
  });
  if (already) {
    const err = new Error('A findings-generation run is already in progress for this project');
    err.code = 'already_running'; err.runId = already.id;
    throw err;
  }
  const run = await _createJobRun({ orgId, projectId, agentType: 'findings_generate_job', inputRefs: { changeEventId: changeEventId || null } });
  await _dispatch({ runId: run.id, kind: 'project.findingsGenerate', projectId, orgId, changeEventId: changeEventId || null });
  return run.id;
}

async function _processFindingsGenerate({ runId, projectId, orgId, changeEventId }) {
  await _markRunning(runId);
  try {
    const project = await prisma.projectRecord.findFirst({ where: { id: projectId, orgId } });
    if (!project) return _finishJobRun(runId, { status: 'failed', errorMessage: 'project no longer exists' });
    const [scopeItems, contractProvisions, evidenceItems] = await Promise.all([
      prisma.scopeItem.findMany({ where: { orgId, project_id: project.id } }),
      prisma.contractProvision.findMany({ where: { orgId, project_id: project.id } }),
      prisma.evidenceItem.findMany({ where: { orgId, project_id: project.id } }),
    ]);
    if (scopeItems.length === 0 && contractProvisions.length === 0) {
      return _finishJobRun(runId, { status: 'failed', errorMessage: 'No contract baseline extracted for this project yet — analyze a contract/estimate source document first' });
    }
    const result = await pipeline.compareScopeToEvidence({ orgId, project, scopeItems, contractProvisions, evidenceItems, changeEventId });
    return _finishJobRun(runId, {
      status: 'completed',
      outputRefs: { findingCount: result.findings.length, discardedCount: result.discardedCount, agentRunId: result.agentRunId, findings: result.findings },
    });
  } catch (err) {
    return _finishJobRun(runId, { status: 'failed', errorMessage: String((err && err.message) || err) });
  }
}

/** Single entry point for every backend (BullMQ Worker, in-process
 * setImmediate, and the Cloud Tasks push receiver in routes/jobs.js).
 *
 * Unlike the enqueue*() functions above — which run synchronously inside
 * the original HTTP request and so already inherit attachTenant's
 * runWithOrg() AsyncLocalStorage context — this function runs LATER,
 * detached from that request (a BullMQ Worker callback, a fresh Cloud
 * Tasks push, or even the in-process setImmediate fallback, which only
 * happens to inherit context by accident of scheduling and shouldn't be
 * relied on). Without explicitly re-establishing tenant context here,
 * every Prisma call below would run with neither org nor system-access
 * context — Postgres RLS (prisma/rls.sql) is fail-closed, so in a real
 * Postgres+RLS deployment every query would silently see zero rows and
 * every job would incorrectly fail as "no longer exists," not because of
 * a real permission problem but because nothing ever told RLS which
 * tenant this job belongs to. */
async function processJob(job) {
  return runWithOrg(job.orgId, async () => {
    switch (job.kind) {
      case 'sourceDocument.analyze': return _processSourceDocumentAnalyze(job);
      case 'evidenceItem.analyze': return _processEvidenceItemAnalyze(job);
      case 'project.findingsGenerate': return _processFindingsGenerate(job);
      default:
        console.error(`[evidence-jobs] unknown job kind: ${job.kind}`);
    }
  });
}

// ── Reconciliation sweep (the "job creation" dual-write hazard) ──────────
// enqueue*() above creates the AgentRunRecord row (status 'queued') THEN
// dispatches to Cloud Tasks/BullMQ/setImmediate as a SEPARATE step. If the
// process crashes/restarts between those two steps — or a dispatch that
// looked successful never actually lands (a BullMQ .add() racing a process
// exit before its promise settles, a Cloud Tasks call that times out after
// the request already reached the queue) — the record is stuck at 'queued'
// forever: nothing will ever process it, and a client polling
// GET /api/agentRunRecords/:id waits forever too. This sweep finds
// AgentRunRecord rows past a "should have started by now" threshold and
// re-dispatches them. Safe to redeliver: every _process*() handler above
// already re-checks the target row's own status before doing any work
// (the same idempotency guard that protects against real Cloud Tasks/
// BullMQ redelivery), so a job that actually did start after all is just a
// harmless no-op the second time.
const STUCK_JOB_THRESHOLD_MS = 2 * 60 * 1000;
const AGENT_TYPE_TO_KIND = {
  sourceDocument_analyze_job: 'sourceDocument.analyze',
  evidenceItem_analyze_job: 'evidenceItem.analyze',
  findings_generate_job: 'project.findingsGenerate',
};

function _reconstructJob(run) {
  const kind = AGENT_TYPE_TO_KIND[run.agent_type];
  if (!kind) return null; // not a kind this module dispatches (or redispatching isn't safe/known)
  let inputRefs = {};
  try { inputRefs = run.input_refs ? JSON.parse(run.input_refs) : {}; } catch { /* leave empty */ }
  const base = { runId: run.id, kind, orgId: run.orgId, projectId: run.project_id };
  if (kind === 'sourceDocument.analyze') return { ...base, sourceDocumentId: inputRefs.sourceDocumentId };
  if (kind === 'evidenceItem.analyze') return { ...base, evidenceItemId: inputRefs.evidenceItemId };
  if (kind === 'project.findingsGenerate') return { ...base, changeEventId: inputRefs.changeEventId || null };
  return null;
}

/** Run periodically (see startReconciler below). Reads across every org on
 * purpose — a stuck job's own org isn't known ahead of time — so this is
 * exactly the narrow, audited runWithSystemAccess() case lib/tenant-
 * context.js documents, not a per-request org. */
async function reconcileStuckJobs({ olderThanMs = STUCK_JOB_THRESHOLD_MS, limit = 25 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stuck = await runWithSystemAccess(async () => prisma.agentRunRecord.findMany({
    where: { status: 'queued', createdAt: { lt: cutoff }, agent_type: { in: Object.keys(AGENT_TYPE_TO_KIND) } },
    take: limit, orderBy: { createdAt: 'asc' },
  }));
  let redispatched = 0;
  for (const run of stuck) {
    const job = _reconstructJob(run);
    if (!job) continue;
    console.warn(`[evidence-jobs] reconciling stuck run ${run.id} (${run.agent_type}, queued since ${run.createdAt.toISOString()}) — redispatching`);
    await _dispatch(job);
    redispatched++;
  }
  return { checked: stuck.length, redispatched };
}

let reconcileTimer = null;
const RECONCILE_TICK_MS = 60_000;
function startReconciler() {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    reconcileStuckJobs().catch((err) => console.error('[evidence-jobs] reconcile tick failed:', err.message));
  }, RECONCILE_TICK_MS);
  reconcileTimer.unref && reconcileTimer.unref();
}
function stopReconciler() { if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; } }

module.exports = {
  enqueueSourceDocumentAnalysis,
  enqueueEvidenceItemAnalysis,
  enqueueFindingsGeneration,
  processJob,
  startWorker,
  stopWorker,
  reconcileStuckJobs,
  startReconciler,
  stopReconciler,
};
