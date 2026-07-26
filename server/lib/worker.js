/**
 * ScopeCash AI — Background Worker
 *
 * Two execution modes:
 *   - REDIS_URL set: BullMQ queue + Worker (multi-process, retry, persistence)
 *   - else        : in-process FIFO queue (dev/single-node fallback)
 *
 * Both modes share the same runJob() pipeline so behavior is identical.
 */

const path = require('path');
const prisma = require('./prisma');
const storage = require('./storage');
const metrics = require('./metrics');
const cloudTasks = require('./cloud-tasks');

const QUEUE_NAME = 'scopecash-ai-jobs';
const REDIS_URL = process.env.REDIS_URL || '';
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '4', 10);

// ── Mode A: BullMQ ───────────────────────────────────────────
let bullQueue = null;
let bullWorker = null;
function initBull() {
  if (bullQueue || !REDIS_URL) return null;
  try {
    const { Queue } = require('bullmq');
    const IORedis = require('ioredis');
    const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    bullQueue = new Queue(QUEUE_NAME, { connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      }
    });
  } catch (err) {
    console.warn('[worker] BullMQ unavailable; falling back to in-process queue:', err.message);
    bullQueue = null;
  }
  return bullQueue;
}

function startBullWorker() {
  if (bullWorker || !REDIS_URL) return null;
  try {
    const { Worker } = require('bullmq');
    const IORedis = require('ioredis');
    const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    bullWorker = new Worker(QUEUE_NAME, async (job) => runJob(job.data), {
      connection, concurrency: CONCURRENCY,
    });
    bullWorker.on('failed', (job, err) => {
      console.error(`[worker] job ${job?.id} failed:`, err.message);
    });
    bullWorker.on('completed', (job) => {
      console.log(`[worker] job ${job.id} completed`);
    });
    return bullWorker;
  } catch (err) {
    console.warn('[worker] could not start BullMQ Worker:', err.message);
    return null;
  }
}

async function stopBullWorker() {
  try { if (bullWorker) await bullWorker.close(); } catch {}
  try { if (bullQueue)  await bullQueue.close();  } catch {}
  bullWorker = null;
  bullQueue = null;
}

// ── Mode B: in-process FIFO ──────────────────────────────────
const localQueue = [];
let localProcessing = 0;

async function processNextLocal() {
  if (localProcessing >= CONCURRENCY) return;
  const job = localQueue.shift();
  if (!job) return;
  localProcessing++;
  try {
    await runJob(job);
  } catch (err) {
    console.error(`[worker] job ${job.recordId} failed:`, err.message);
    metrics.counters.jobsFailed.inc({ reason: err.code || 'error' });
    try {
      await prisma.project.update({
        where: { id: job.recordId },
        data: { status: 'failed' }
      });
    } catch {}
  } finally {
    localProcessing--;
    if (localQueue.length > 0) setImmediate(processNextLocal);
  }
}

// ── Mode C: Cloud Tasks (push-based; GCP manages retry/backoff) ──────────
const JOBS_BACKEND = (process.env.JOBS_BACKEND || '').toLowerCase();
function useCloudTasks() { return JOBS_BACKEND === 'cloud-tasks' && cloudTasks.isConfigured(); }

// ── Public API ───────────────────────────────────────────────
function enqueueJob(recordId, storageKey, userId, userEmail) {
  const data = { recordId, storageKey, userId, userEmail };

  if (useCloudTasks()) {
    const targetUrl = process.env.CLOUD_TASKS_PUSH_URL; // e.g. https://<cloud-run-url>/api/jobs/process-task
    if (!targetUrl) {
      console.error('[worker] JOBS_BACKEND=cloud-tasks but CLOUD_TASKS_PUSH_URL is unset; falling back to local queue');
    } else {
      cloudTasks.enqueueTask({ queueName: process.env.CLOUD_TASKS_QUEUE || 'scopecash-jobs', targetUrl, payload: data })
        .catch((err) => {
          console.error('[worker] Cloud Tasks enqueue failed; using local queue:', err.message);
          localQueue.push(data); processNextLocal();
        });
      return;
    }
  }

  const q = initBull();
  if (q) {
    q.add('process', data, { jobId: recordId }).catch(err => {
      console.error('[worker] enqueue failed; using local queue:', err.message);
      localQueue.push(data); processNextLocal();
    });
    return;
  }
  localQueue.push(data);
  processNextLocal();
}

async function getQueueStatus() {
  if (REDIS_URL && bullQueue) {
    const counts = await bullQueue.getJobCounts('waiting', 'active', 'failed', 'delayed');
    return { mode: 'bullmq', ...counts };
  }
  return { mode: 'local', queued: localQueue.length, processing: localProcessing };
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream === 'string') return Buffer.from(stream);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ─── Text Extraction ──────────────────────────────────

async function extractText(storageKey) {
  const ext = path.extname(storageKey).toLowerCase();
  const stream = await storage.getStream(storageKey);
  const buffer = await streamToBuffer(stream);

  if (ext === '.txt') {
    return buffer.toString('utf-8');
  }

  if (ext === '.pdf') {
    try {
      const { PDFParse } = require('pdf-parse');
      const pdf = new PDFParse({ data: new Uint8Array(buffer) });
      await pdf.load();
      const result = await pdf.getText();
      return result.text || '';
    } catch (err) {
      console.error('PDF extraction error:', err.message);
      return '';
    }
  }

  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (err) {
      console.error('DOCX extraction error:', err.message);
      return '';
    }
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ─── Domain Processing Pipeline ───────────────────────


// Load detection patterns
const ENGINE_DATA = path.resolve(__dirname, '../data');
let detectionPatterns = {};
try {
  detectionPatterns = JSON.parse(fs.readFileSync(path.join(ENGINE_DATA, 'detection-patterns.json'), 'utf-8'));
} catch {}

function detectPatterns(text) {
  const paragraphs = text.split(/(\r?\n){2,}/);
  const findings = {};
  const minLength = detectionPatterns.heuristics?.min_length || 40;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length < minLength) continue;

    for (const key of Object.keys(detectionPatterns.patterns || {})) {
      const regexList = detectionPatterns.patterns[key];
      const keywords = detectionPatterns.keywords?.[key] || [];

      let regexHit = false;
      for (const regex of regexList) {
        const cleaned = regex.replace(/\(\?[imsx]+\)/g, '');
        if (new RegExp(cleaned, 'i').test(trimmed)) {
          regexHit = true;
          break;
        }
      }

      let keywordHits = 0;
      for (const kw of keywords) {
        if (new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(trimmed)) {
          keywordHits++;
        }
      }

      const keywordScore = keywords.length > 0 ? keywordHits / keywords.length : 0;
      const confidence = regexHit ? 0.7 + (keywordScore * 0.3) : keywordScore;

      if (confidence >= (detectionPatterns.heuristics?.confidence_threshold || 0.5)) {
        if (!findings[key]) findings[key] = trimmed;
      }
    }
  }
  return findings;
}


function scoreRisk(findings, gaps) {
  const totalFindings = Object.keys(findings).length;
  const totalGaps = gaps.length;

  if (totalFindings === 0) return { overall: 'Unknown', score: 0 };

  const gapPenalty = totalGaps * 15;
  const baseScore = Math.max(0, 100 - gapPenalty);
  const score = Math.min(100, Math.max(0, baseScore));

  const level = score >= 80 ? 'Low' : score >= 50 ? 'Moderate' : score >= 25 ? 'High' : 'Critical';

  return { overall: level, score, totalFindings, totalGaps };
}

async function runJob(job) {
  // 1. Extract text (storageKey for new uploads, fallback to legacy filePath)
  const source = job.storageKey || job.filePath;
  const text = await extractText(source);
  if (!text || text.trim().length < 50) {
    throw new Error('Document is empty or too short to analyze');
  }

  // 2. Process document

  const findings = detectPatterns(text);


  const requiredItems = ["Attorney-reviewed disclaimer rendered in every PDF packet","AI must refuse legal-entitlement assertions and legal advice","Success fee must not be enabled by default and requires separately accepted written agreement","Success fee must not be charged against insurance-paid outcomes without legal review confirming non-adjuster characterization","Identified amount must never be labeled approved, invoiced, or collected in any UI, API, report, or export","Every AI assertion must have at least one source citation","Rejected findings must never appear in packets","Contradictory evidence must never be omitted from risk review","Prompt injection from uploaded documents must be blocked","Demo data must be excluded from competition evidence totals","No evidence may be exposed publicly; all access via signed URLs only","CCPA deletion and Do Not Sell workflow required"];
  const gaps = requiredItems.filter(r => !findings[r]);


  // 3. Score risk
  const risk = scoreRisk(findings || {}, gaps || []);

  // 4. Build report
  const report = {
    findings: findings || {},
    gaps: gaps || [],
    risk,
    processedAt: new Date().toISOString(),
    textLength: text.length
  };

  // 5. Save results
  await prisma.project.update({
    where: { id: job.recordId },
    data: {
      status: 'completed',
      riskScore: risk.score,
      overallRisk: risk.overall,
      reportJson: JSON.stringify(report)
    }
  });

  metrics.counters.jobsProcessed.inc({ outcome: 'completed' });
  console.log(`Job ${job.recordId} completed: ${risk.overall} risk (score: ${risk.score})`);
}

module.exports = { enqueueJob, getQueueStatus, runJob, startBullWorker, stopBullWorker };

