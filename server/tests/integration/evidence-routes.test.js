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
    expect(analyzeDocRes.status).toBe(200);
    expect(analyzeDocRes.body.baseline.scopeItemCount).toBe(1);

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
    expect(analyzeImgRes.status).toBe(200);
    expect(analyzeImgRes.body.evidenceItem.extractedText).toMatch(/ductwork/);

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
    expect(findingsRes.status).toBe(200);
    expect(findingsRes.body.findings).toHaveLength(1);
    const findingId = findingsRes.body.findings[0].id;

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
    expect(analyzeRes.status).toBe(200);
    expect(analyzeRes.body.extraction.method).toBe('gemini-native');
    expect(analyzeRes.body.extraction.geminiFallbackRunId).toBeTruthy();
    expect(analyzeRes.body.baseline.scopeItemCount).toBe(1);
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
    expect(analyzeRes.status).toBe(422);
    expect(analyzeRes.body.code).toBe('extraction_unreadable');
  });
});
