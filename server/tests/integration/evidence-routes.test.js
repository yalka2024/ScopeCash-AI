/**
 * HTTP-level tests for routes/evidence.js: upload -> analyze -> generate
 * findings -> validate citations, through the real Express app. Mocks only
 * lib/vertex-ai#generate.
 */
const crypto = require('crypto');
// test.db migration is handled once by tests/global-setup.js (Jest globalSetup).

jest.mock('../../lib/vertex-ai', () => ({ generate: jest.fn(), isConfigured: jest.fn(() => true) }));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const vertex = require('../../lib/vertex-ai');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const evidenceRoutes = require('../../routes/evidence');
const pipeline = require('../../lib/evidence-pipeline');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', evidenceRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}
function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

// Analysis now runs via lib/evidence-jobs.js in the background (no
// REDIS_URL/Cloud Tasks in tests, so it's the in-process setImmediate
// fallback — fast, but still a separate tick from the enqueue response).
// Poll the same AgentRunRecord the dashboard polls until it settles.
// (Queried directly via Prisma rather than GET /api/agentRunRecords/:id —
// this file's test app only mounts evidenceRoutes, not entities.js.)
async function pollRun(agentRunId, { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  for (;;) {
    const run = await prisma.agentRunRecord.findUnique({ where: { id: agentRunId } });
    if (run && (run.status === 'completed' || run.status === 'failed')) return run;
    if (Date.now() - started > timeoutMs) throw new Error(`agentRunRecord ${agentRunId} did not settle within ${timeoutMs}ms (status=${run && run.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function makeOwnerAndProject() {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Riverside Community Center' } });
  const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'HVAC Retrofit', userId: user.id, original_scope_summary: 'Replace 3-ton rooftop HVAC unit only.' } });
  return { org, user, project };
}

afterAll(async () => { await prisma.$disconnect(); });
beforeEach(() => {
  vertex.generate.mockReset();
  vertex.isConfigured.mockReset().mockReturnValue(true);
  jest.restoreAllMocks();
});

describe('evidence upload + analysis routes', () => {
  test('upload a contract, analyze it, upload a photo, analyze it, generate findings, validate citations', async () => {
    const { user, project } = await makeOwnerAndProject();

    // 1. Upload a plain-text "contract" (document_type=contract so analysis
    // also runs baseline extraction, not just text extraction).
    const uploadRes = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments`)
      .set('Authorization', bearer(user))
      .field('document_type', 'contract')
      .attach('file', Buffer.from('CONTRACT: Replace 3-ton rooftop HVAC unit. No ductwork included.'), { filename: 'contract.txt', contentType: 'text/plain' });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.extraction_status).toBe('pending');
    const sourceDocumentId = uploadRes.body.id;

    // 2. Analyze it — mocked baseline extraction.
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: {
        scopeItems: [{ description: 'Replace 3-ton rooftop HVAC unit', quantity: 1, unit: 'ea', pageNumber: 1 }],
        contractProvisions: [{ category: 'exclusion', clauseText: 'No ductwork included', pageNumber: 1 }],
      },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      costUsd: 0.0003,
    });
    const analyzeDocRes = await request(app).post(`/api/sourceDocuments/${sourceDocumentId}/analyze`).set('Authorization', bearer(user));
    expect(analyzeDocRes.status).toBe(202);
    expect(analyzeDocRes.body.status).toBe('queued');
    const docRun = await pollRun(analyzeDocRes.body.agentRunId);
    expect(docRun.status).toBe('completed');
    expect(JSON.parse(docRun.output_refs).baseline.scopeItemCount).toBe(1);

    // 3. Upload a photo.
    const photoRes = await request(app)
      .post(`/api/projects/${project.id}/evidenceItems`)
      .set('Authorization', bearer(user))
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]), { filename: 'attic.jpg', contentType: 'image/jpeg' });
    expect(photoRes.status).toBe(201);
    expect(photoRes.body.evidenceType).toBe('photo');
    const evidenceItemId = photoRes.body.id;

    // 4. Analyze the photo — mocked image interpretation.
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: { description: 'New ductwork visible in attic', visibleText: '', quality: 'ok' },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      costUsd: 0.0002,
    });
    const analyzeImgRes = await request(app).post(`/api/evidenceItems/${evidenceItemId}/analyze`).set('Authorization', bearer(user));
    expect(analyzeImgRes.status).toBe(202);
    const imgRun = await pollRun(analyzeImgRes.body.agentRunId);
    expect(imgRun.status).toBe('completed');
    const updatedEvidenceItem = await prisma.evidenceItem.findUnique({ where: { id: evidenceItemId } });
    expect(updatedEvidenceItem.analysisStatus).toBe('completed');
    expect(updatedEvidenceItem.extractedText).toMatch(/ductwork/);

    // 5. Generate findings — mocked scope comparison, citing the real evidence item.
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: {
        findings: [{
          findingType: 'scope_delta', assertion: 'Ductwork was installed but excluded from contract scope',
          severity: 'high', confidence: 0.85,
          citations: [{ sourceKey: `evidence:${evidenceItemId}`, quotedText: 'ductwork visible in attic' }],
        }],
      },
      modelVersion: 'gemini-2.5-pro-001',
      usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600 },
      costUsd: 0.001,
    });
    const findingsRes = await request(app).post(`/api/projects/${project.id}/findings/generate`).set('Authorization', bearer(user)).send({});
    expect(findingsRes.status).toBe(202);
    const findingsRun = await pollRun(findingsRes.body.agentRunId);
    expect(findingsRun.status).toBe('completed');
    const findingsOutput = JSON.parse(findingsRun.output_refs);
    expect(findingsOutput.findings).toHaveLength(1);
    const findingId = findingsOutput.findings[0].id;

    // 6. Validate citations on the resulting finding.
    const validateRes = await request(app).get(`/api/evidenceFindings/${findingId}/citations/validate`).set('Authorization', bearer(user));
    expect(validateRes.status).toBe(200);
    expect(validateRes.body.data).toHaveLength(1);
    expect(validateRes.body.data[0].valid).toBe(true);
  });

  test('rejects generating findings before any baseline has been extracted', async () => {
    const { user, project } = await makeOwnerAndProject();
    const res = await request(app).post(`/api/projects/${project.id}/findings/generate`).set('Authorization', bearer(user)).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_baseline');
  });

  test('duplicate exact-content document upload is rejected with 409', async () => {
    const { user, project } = await makeOwnerAndProject();
    const buf = Buffer.from('identical contract text');
    const first = await request(app).post(`/api/projects/${project.id}/sourceDocuments`).set('Authorization', bearer(user))
      .field('document_type', 'contract').attach('file', buf, { filename: 'a.txt', contentType: 'text/plain' });
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/projects/${project.id}/sourceDocuments`).set('Authorization', bearer(user))
      .field('document_type', 'contract').attach('file', buf, { filename: 'b.txt', contentType: 'text/plain' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('duplicate_document');
  });

  test('re-uploading identical photo bytes succeeds and records duplicateOfId (does not crash on a hash collision)', async () => {
    const { user, project } = await makeOwnerAndProject();
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xaa, 0xbb, 0xcc]);
    const first = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', buf, { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect(first.status).toBe(201);
    expect(first.body.duplicateOfId).toBeNull();

    const second = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', buf, { filename: 'second.jpg', contentType: 'image/jpeg' });
    expect(second.status).toBe(201);
    expect(second.body.duplicateOfId).toBe(first.body.id);
    expect(second.body.sha256Hash).toBe(first.body.sha256Hash);
  });

  test('photo upload stores its real sniffed mimeType (not a guess)', async () => {
    const { user, project } = await makeOwnerAndProject();
    const res = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]), { filename: 'roof.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/jpeg');
  });

  test('accepts a real HEIC photo (Gemini-supported iPhone default format)', async () => {
    const { user, project } = await makeOwnerAndProject();
    // Minimal valid HEIC signature: an ISOBMFF "ftyp" box with a heic brand.
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('heic'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('mif1heic'),
    ]);
    const res = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', heic, { filename: 'jobsite.heic', contentType: 'image/heic' });
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/heic');
  });

  test.each([
    // Minimal-but-real magic bytes for each format storage.js#MAGIC now
    // recognizes, one real fixture per AUDIO_EXTS entry (routes/evidence.js).
    ['note.mp3', 'audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])])],
    ['note.mp3', 'audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0x00])], // bare MPEG frame sync, no ID3 tag
    ['note.wav', 'audio/wav', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE')])],
    ['note.ogg', 'audio/ogg', Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00])],
    ['note.m4a', 'audio/mp4', Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('M4A '), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('M4A mp42')])],
    ['note.webm', 'audio/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])],
  ])('accepts a real %s upload (magic-byte sniffing, not just extension)', async (filename, expectedMime, bytes) => {
    const { user, project } = await makeOwnerAndProject();
    const res = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', bytes, { filename, contentType: expectedMime });
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe(expectedMime);
    expect(res.body.evidenceType).toBe('audio');
  });

  test('rejects a .wav upload whose bytes are not actually RIFF/WAVE (magic-byte mismatch)', async () => {
    const { user, project } = await makeOwnerAndProject();
    const res = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', Buffer.from('plain text pretending to be audio'), { filename: 'note.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(400);
  });

  test('falls back to Gemini-native document extraction when local extraction finds no text layer (scanned document)', async () => {
    const { user, project } = await makeOwnerAndProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments`)
      .set('Authorization', bearer(user))
      .field('document_type', 'contract')
      .attach('file', Buffer.from('%PDF-1.4 fake scanned pdf bytes'), { filename: 'scanned.pdf', contentType: 'application/pdf' });
    expect(uploadRes.status).toBe(201);

    // Simulate pdf-parse successfully "parsing" a scan with no text layer.
    jest.spyOn(pipeline, 'extractDocumentText').mockResolvedValueOnce({ text: '', pages: [], method: 'pdf-parse' });
    // First generate() call: the Gemini-native extraction fallback.
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: { text: 'CONTRACT: Replace 3-ton rooftop HVAC unit.', unreadable: false, pageCount: 1 },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340 },
      costUsd: 0.0004,
    });
    // Second generate() call: baseline extraction runs against the recovered text.
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: { scopeItems: [{ description: 'Replace 3-ton rooftop HVAC unit', pageNumber: 1 }], contractProvisions: [] },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      costUsd: 0.0003,
    });

    const analyzeRes = await request(app).post(`/api/sourceDocuments/${uploadRes.body.id}/analyze`).set('Authorization', bearer(user));
    expect(analyzeRes.status).toBe(202);
    const run = await pollRun(analyzeRes.body.agentRunId);
    expect(run.status).toBe('completed');
    const output = JSON.parse(run.output_refs);
    expect(output.extraction.method).toBe('gemini-native');
    expect(output.extraction.geminiFallbackRunId).toBeTruthy();
    expect(output.baseline.scopeItemCount).toBe(1);
    // No "[illegible]" markers in the transcribed text -> 'ok'.
    expect(output.extraction.quality).toBe('ok');
    expect(output.extraction.illegibleSpanCount).toBe(0);
    const doc = await prisma.sourceDocument.findUnique({ where: { id: uploadRes.body.id } });
    expect(doc.extraction_quality).toBe('ok');
  });

  test('OCR quality scoring: illegible markers in a Gemini fallback transcript mark extraction_quality low_quality, not just extracted', async () => {
    const { user, project } = await makeOwnerAndProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments`)
      .set('Authorization', bearer(user))
      .field('document_type', 'invoice')
      .attach('file', Buffer.from('%PDF-1.4 fake partially-legible scanned pdf bytes'), { filename: 'faded.pdf', contentType: 'application/pdf' });
    expect(uploadRes.status).toBe(201);

    jest.spyOn(pipeline, 'extractDocumentText').mockResolvedValueOnce({ text: '', pages: [], method: 'pdf-parse' });
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: { text: 'Invoice total: [illegible]\nDate: [illegible]\nContractor: Riverside HVAC', unreadable: false, pageCount: 1 },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340 },
      costUsd: 0.0004,
    });
    // 'invoice' document_type does not trigger baseline extraction (only
    // contract/estimate/change_order do) — only the one generate() call above.

    const analyzeRes = await request(app).post(`/api/sourceDocuments/${uploadRes.body.id}/analyze`).set('Authorization', bearer(user));
    expect(analyzeRes.status).toBe(202);
    const run = await pollRun(analyzeRes.body.agentRunId);
    expect(run.status).toBe('completed');
    const output = JSON.parse(run.output_refs);
    expect(output.extraction.quality).toBe('low_quality');
    expect(output.extraction.illegibleSpanCount).toBe(2);
    const doc = await prisma.sourceDocument.findUnique({ where: { id: uploadRes.body.id } });
    expect(doc.extraction_status).toBe('extracted'); // still usable — illegible spans don't fail the whole extraction
    expect(doc.extraction_quality).toBe('low_quality');
  });

  test('422s when Gemini-native fallback also cannot read the document', async () => {
    const { user, project } = await makeOwnerAndProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments`)
      .set('Authorization', bearer(user))
      .field('document_type', 'contract')
      .attach('file', Buffer.from('%PDF-1.4 fake blank pdf bytes'), { filename: 'blank.pdf', contentType: 'application/pdf' });
    expect(uploadRes.status).toBe(201);

    jest.spyOn(pipeline, 'extractDocumentText').mockResolvedValueOnce(null);
    vertex.generate.mockResolvedValueOnce({
      text: '{}',
      json: { text: '', unreadable: true },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 300, completionTokens: 5, totalTokens: 305 },
      costUsd: 0.0001,
    });

    const analyzeRes = await request(app).post(`/api/sourceDocuments/${uploadRes.body.id}/analyze`).set('Authorization', bearer(user));
    expect(analyzeRes.status).toBe(202);
    const run = await pollRun(analyzeRes.body.agentRunId);
    expect(run.status).toBe('failed');
    expect(run.error_message).toMatch(/could not read any text/);
    const doc = await prisma.sourceDocument.findUnique({ where: { id: uploadRes.body.id } });
    expect(doc.extraction_status).toBe('failed');
    expect(doc.extraction_quality).toBe('unreadable');
  });

  test('409s when analyzing a document that is already extracted', async () => {
    const { user, project } = await makeOwnerAndProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments`)
      .set('Authorization', bearer(user))
      .field('document_type', 'invoice')
      .attach('file', Buffer.from('Invoice #1: $500 for HVAC filter replacement.'), { filename: 'invoice.txt', contentType: 'text/plain' });
    expect(uploadRes.status).toBe(201);

    const first = await request(app).post(`/api/sourceDocuments/${uploadRes.body.id}/analyze`).set('Authorization', bearer(user));
    expect(first.status).toBe(202);
    await pollRun(first.body.agentRunId);

    const second = await request(app).post(`/api/sourceDocuments/${uploadRes.body.id}/analyze`).set('Authorization', bearer(user));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_extracted');
  });
});

describe('direct-to-storage signed upload URLs', () => {
  const storage = require('../../lib/storage');

  test('upload-url 501s on the local storage driver (this test env) with a clear fallback message', async () => {
    const { user, project } = await makeOwnerAndProject();
    const res = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments/upload-url`)
      .set('Authorization', bearer(user))
      .send({ filename: 'contract.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('direct_upload_unsupported');
    expect(res.body.error).toMatch(/multipart upload endpoint/);
  });

  test('confirm-upload validates real bytes already placed at the staging key and creates the row', async () => {
    const { user, project } = await makeOwnerAndProject();
    // Simulate the browser's direct PUT having already happened: place real
    // bytes at a real key via the same storage module the app uses — not a
    // hand-constructed path — then confirm it through the real endpoint.
    const stagingKey = storage.newKey(user.id, 'invoice.txt');
    await storage.putObject({ key: stagingKey, body: Buffer.from('Invoice #77: real staged content.'), contentType: 'text/plain' });

    const res = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments/confirm-upload`)
      .set('Authorization', bearer(user))
      .send({ stagingKey, originalFilename: 'invoice.txt', document_type: 'invoice' });

    expect(res.status).toBe(201);
    expect(res.body.storage_uri).toBe(stagingKey);
    expect(res.body.mime_type).toBe('text/plain');
    const row = await prisma.sourceDocument.findUnique({ where: { id: res.body.id } });
    expect(row.extraction_status).toBe('pending');
  });

  test('confirm-upload rejects a stagingKey belonging to a different user', async () => {
    const { user: userA } = await makeOwnerAndProject();
    const { user: userB, project: projectB } = await makeOwnerAndProject();
    const stagingKeyForA = storage.newKey(userA.id, 'x.txt');
    await storage.putObject({ key: stagingKeyForA, body: Buffer.from('content'), contentType: 'text/plain' });

    const res = await request(app)
      .post(`/api/projects/${projectB.id}/sourceDocuments/confirm-upload`)
      .set('Authorization', bearer(userB))
      .send({ stagingKey: stagingKeyForA, originalFilename: 'x.txt', document_type: 'invoice' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('staging_key_mismatch');
  });

  test('confirm-upload rejects a stagingKey that path-traverses out of the caller\'s own prefix', async () => {
    const { user, project } = await makeOwnerAndProject();
    const traversalAttempts = [
      `${user.id}/../../../../etc/passwd`,
      `${user.id}/..%2f..%2fetc%2fpasswd`,
      `${user.id}/sub/../../other-user/secret.txt`,
      `${user.id}/`,
      `${user.id}`,
    ];
    for (const stagingKey of traversalAttempts) {
      const res = await request(app)
        .post(`/api/projects/${project.id}/sourceDocuments/confirm-upload`)
        .set('Authorization', bearer(user))
        .send({ stagingKey, originalFilename: 'x.txt', document_type: 'invoice' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('staging_key_mismatch');
    }
  });

  test('confirm-upload deletes the staged object and rejects content that fails magic-byte sniffing', async () => {
    const { user, project } = await makeOwnerAndProject();
    const stagingKey = storage.newKey(user.id, 'fake.pdf');
    // Declares .pdf but the bytes are plain text — magic-byte mismatch.
    await storage.putObject({ key: stagingKey, body: Buffer.from('not actually a pdf'), contentType: 'application/pdf' });

    const res = await request(app)
      .post(`/api/projects/${project.id}/sourceDocuments/confirm-upload`)
      .set('Authorization', bearer(user))
      .send({ stagingKey, originalFilename: 'fake.pdf', document_type: 'invoice' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_file');
    // Local driver's getStream() resolves immediately with a lazily-opened
    // fs.createReadStream — the ENOENT only surfaces as an async 'error'
    // event once something reads from it, so drain it to observe that.
    const stream = await storage.getStream(stagingKey);
    await expect(new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.resume();
    })).rejects.toThrow(); // cleaned up, not left orphaned
  });

  test('duplicate-content check is org-scoped: a cross-org byte-identical document never leaks the other org\'s document id', async () => {
    const { user: userA, project: projectA } = await makeOwnerAndProject();
    const { user: userB, project: projectB } = await makeOwnerAndProject();
    const bytes = Buffer.from('Invoice #900: identical content uploaded by two unrelated orgs.');

    const first = await request(app).post(`/api/projects/${projectA.id}/sourceDocuments`).set('Authorization', bearer(userA))
      .field('document_type', 'invoice').attach('file', bytes, { filename: 'shared.txt', contentType: 'text/plain' });
    expect(first.status).toBe(201);

    // Org B uploads the identical bytes via the signed-upload flow. The
    // 409 (if any) must never reference org A's real document id — an
    // unrelated org has no business learning that id exists at all.
    const stagingKey = storage.newKey(userB.id, 'shared.txt');
    await storage.putObject({ key: stagingKey, body: bytes, contentType: 'text/plain' });
    const second = await request(app)
      .post(`/api/projects/${projectB.id}/sourceDocuments/confirm-upload`)
      .set('Authorization', bearer(userB))
      .send({ stagingKey, originalFilename: 'shared.txt', document_type: 'invoice' });

    if (second.status === 409) {
      expect(second.body.code).toBe('duplicate_document');
      expect(second.body.sourceDocumentId).not.toBe(first.body.id);
      expect(second.body.sourceDocumentId).toBeUndefined();
    } else {
      // Org-scoped pre-check found nothing (expected on SQLite/no-RLS);
      // the DB-level unique constraint is still global, so this succeeding
      // means the two hashes didn't collide at storage layer — assert the
      // row really was created for org B, not silently misattributed.
      expect(second.status).toBe(201);
      expect(second.body.orgId).toBe(userB.orgId);
    }
  });

  test('confirm-upload for evidenceItems tracks (not rejects) duplicate content, matching the multipart endpoint', async () => {
    const { user, project } = await makeOwnerAndProject();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);

    const firstUpload = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', bytes, { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect(firstUpload.status).toBe(201);

    const stagingKey = storage.newKey(user.id, 'second.jpg');
    await storage.putObject({ key: stagingKey, body: bytes, contentType: 'image/jpeg' });
    const confirmRes = await request(app)
      .post(`/api/projects/${project.id}/evidenceItems/confirm-upload`)
      .set('Authorization', bearer(user))
      .send({ stagingKey, originalFilename: 'second.jpg' });

    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.duplicateOfId).toBe(firstUpload.body.id);
  });
});

describe('GET /evidenceItems/:id/view', () => {
  const storage = require('../../lib/storage');

  test('streams a real (non-HEIC) image back as-is, with its stored mimeType', async () => {
    const { user, project } = await makeOwnerAndProject();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
    const upload = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', bytes, { filename: 'roof.jpg', contentType: 'image/jpeg' });
    expect(upload.status).toBe(201);

    const res = await request(app).get(`/api/evidenceItems/${upload.body.id}/view`).set('Authorization', bearer(user));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(res.body, bytes)).toBe(0);
  });

  test('converts a HEIC photo to JPEG on the fly, keeping the ORIGINAL bytes in storage untouched', async () => {
    const { user, project } = await makeOwnerAndProject();
    // Minimal valid HEIC container signature (same fixture the upload test
    // above uses) — enough to pass storage.js#sniffMagicBytes, but not a
    // real decodable image, so the actual heic-convert call is mocked here
    // (same testing boundary as mocking lib/billing/stripe's SDK calls
    // elsewhere — this tests THIS route's own branching/integration logic,
    // not the third-party codec library's decode correctness).
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('heic'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('mif1heic'),
    ]);
    const upload = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', heic, { filename: 'jobsite.heic', contentType: 'image/heic' });
    expect(upload.status).toBe(201);

    const fakeJpeg = Buffer.from('not a real jpeg but stands in for one');
    const imageConvert = require('../../lib/image-convert');
    const heicSpy = jest.spyOn(imageConvert, 'heicToJpeg').mockResolvedValue(fakeJpeg);

    const res = await request(app).get(`/api/evidenceItems/${upload.body.id}/view`).set('Authorization', bearer(user));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(res.body, fakeJpeg)).toBe(0);
    expect(heicSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(heicSpy.mock.calls[0][0], heic)).toBe(0); // converter got the REAL original bytes

    // Storage itself was never touched — refetching the raw object still
    // returns the original HEIC bytes, not the converted JPEG.
    heicSpy.mockRestore();
    const row = await prisma.evidenceItem.findUnique({ where: { id: upload.body.id } });
    const stream = await storage.getStream(row.storageUri);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.compare(Buffer.concat(chunks), heic)).toBe(0);
  });

  test('404s for a nonexistent id and for an item belonging to a different org', async () => {
    const { user, project } = await makeOwnerAndProject();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
    const upload = await request(app).post(`/api/projects/${project.id}/evidenceItems`).set('Authorization', bearer(user))
      .attach('file', bytes, { filename: 'roof.jpg', contentType: 'image/jpeg' });

    const missing = await request(app).get('/api/evidenceItems/does-not-exist/view').set('Authorization', bearer(user));
    expect(missing.status).toBe(404);

    const { user: outsider } = await makeOwnerAndProject();
    const crossOrg = await request(app).get(`/api/evidenceItems/${upload.body.id}/view`).set('Authorization', bearer(outsider));
    expect(crossOrg.status).toBe(404);
  });

  test('422s for a non-photo evidence item (e.g. audio)', async () => {
    const { user, project } = await makeOwnerAndProject();
    // Seeded directly, not via POST .../evidenceItems, to test the VIEW
    // route's own 422-for-non-photo logic in isolation from the upload
    // path's magic-byte sniffing (covered separately below).
    const row = await prisma.evidenceItem.create({
      data: {
        orgId: project.orgId, project_id: project.id, evidenceType: 'audio',
        storageUri: storage.newKey(user.id, 'note.mp3'), sha256Hash: crypto.randomBytes(32).toString('hex'),
        mimeType: 'audio/mpeg', uploadedById: user.id,
      },
    });

    const res = await request(app).get(`/api/evidenceItems/${row.id}/view`).set('Authorization', bearer(user));
    expect(res.status).toBe(422);
  });
});
