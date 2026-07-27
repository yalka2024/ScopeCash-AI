/**
 * Unit tests for lib/evidence-jobs.js's own idempotency guarantees — the
 * defense-in-depth layer that protects against Cloud Tasks (and BullMQ)
 * redelivering the exact same task more than once, independent of the
 * route-level 409 checks in routes/evidence.js (covered in
 * tests/integration/evidence-routes.test.js).
 */
const crypto = require('crypto');
jest.mock('../../lib/vertex-ai', () => ({ generate: jest.fn(), isConfigured: jest.fn(() => true) }));
jest.mock('../../lib/storage', () => ({
  getStream: jest.fn(async () => require('stream').Readable.from([Buffer.from('irrelevant bytes; extraction is mocked')])),
  gcsUri: jest.fn(() => null),
}));

const prisma = require('../../lib/prisma');
const vertex = require('../../lib/vertex-ai');
const evidenceJobs = require('../../lib/evidence-jobs');

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

async function makeOrgProjectDoc(overrides = {}) {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Test Customer' } });
  const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'Test Project', userId: user.id } });
  const sourceDocument = await prisma.sourceDocument.create({
    data: {
      orgId: org.id, project_id: project.id, document_type: 'invoice',
      original_filename: 'x.txt', storage_uri: 'local://does-not-need-to-exist-for-this-test',
      sha256_hash: uid('sha'), uploaded_at: new Date(), extraction_status: 'pending', userId: user.id,
      mime_type: 'text/plain',
      ...overrides,
    },
  });
  return { org, user, project, sourceDocument };
}

afterAll(async () => { await prisma.$disconnect(); });
beforeEach(() => { vertex.generate.mockReset(); vertex.isConfigured.mockReset().mockReturnValue(true); });

describe('evidence-jobs redelivery idempotency', () => {
  test('processJob no-ops a redelivered sourceDocument.analyze task after it already completed', async () => {
    const { org, project, sourceDocument } = await makeOrgProjectDoc({ document_type: 'change_order' });
    // Force the local-extraction path (plain text mime — no Gemini call needed
    // for extraction itself) but WITH a baseline extraction (change_order),
    // so exactly one vertex.generate call happens per real run.
    vertex.generate.mockResolvedValue({
      text: '{}', json: { scopeItems: [], contractProvisions: [] },
      modelVersion: 'gemini-2.5-flash-001', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, costUsd: 0.0001,
    });

    const runId = await evidenceJobs.enqueueSourceDocumentAnalysis({
      sourceDocumentId: sourceDocument.id, orgId: org.id, projectId: project.id,
    });
    // The enqueue's own dispatch already ran the job once via setImmediate
    // (no REDIS_URL/Cloud Tasks in the test env) — wait for it to settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const afterFirst = await prisma.agentRunRecord.findUnique({ where: { id: runId } });
    expect(afterFirst.status).toBe('completed');
    expect(vertex.generate).toHaveBeenCalledTimes(1);

    // Simulate Cloud Tasks redelivering the identical push payload — call
    // processJob directly a second time with the same job description.
    await evidenceJobs.processJob({ runId, kind: 'sourceDocument.analyze', sourceDocumentId: sourceDocument.id, orgId: org.id, projectId: project.id });

    // No second Gemini call — the handler saw extraction_status was already
    // 'extracted' and no-opped instead of blindly reprocessing.
    expect(vertex.generate).toHaveBeenCalledTimes(1);
    const doc = await prisma.sourceDocument.findUnique({ where: { id: sourceDocument.id } });
    expect(doc.extraction_status).toBe('extracted');
  });

  test('enqueueFindingsGeneration refuses to start a second run while one is already queued/running for the same project', async () => {
    const { org, project } = await makeOrgProjectDoc();
    await prisma.agentRunRecord.create({
      data: { orgId: org.id, project_id: project.id, agent_type: 'findings_generate_job', status: 'running' },
    });
    await expect(evidenceJobs.enqueueFindingsGeneration({ projectId: project.id, orgId: org.id }))
      .rejects.toMatchObject({ code: 'already_running' });
  });
});
