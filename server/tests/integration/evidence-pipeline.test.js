/**
 * Evidence pipeline tests. Mocks ONLY the Vertex AI call itself
 * (lib/vertex-ai#generate) — persistence, mandatory citation enforcement,
 * and citation validation all run for real against a SQLite test DB.
 */
const crypto = require('crypto');
// test.db migration is handled once by tests/global-setup.js (Jest globalSetup).

jest.mock('../../lib/vertex-ai', () => ({
  generate: jest.fn(),
}));

const vertex = require('../../lib/vertex-ai');
const prisma = require('../../lib/prisma');
const pipeline = require('../../lib/evidence-pipeline');

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

async function makeOrgProjectCustomer() {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
  const project = await prisma.projectRecord.create({
    data: { orgId: org.id, customer_id: customer.id, name: 'HVAC Retrofit', userId: uid('user') },
  });
  return { org, customer, project };
}

afterAll(async () => { await prisma.$disconnect(); });
beforeEach(() => { vertex.generate.mockReset(); });

describe('extractDocumentText', () => {
  test('plain text is extracted directly without calling Vertex', async () => {
    const result = await pipeline.extractDocumentText({ mimeType: 'text/plain', buffer: Buffer.from('hello world') });
    expect(result.text).toBe('hello world');
    expect(result.method).toBe('plain');
    expect(vertex.generate).not.toHaveBeenCalled();
  });

  test('unrecognized mime type returns null (caller falls back to native Gemini document understanding)', async () => {
    const result = await pipeline.extractDocumentText({ mimeType: 'image/heic', buffer: Buffer.from('x') });
    expect(result).toBeNull();
  });
});

describe('extractContractBaseline', () => {
  test('persists ScopeItem + ContractProvision rows from the model response and logs an AgentRunRecord', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    const sourceDocument = await prisma.sourceDocument.create({
      data: {
        orgId: org.id, project_id: project.id, document_type: 'contract', original_filename: 'contract.pdf',
        storage_uri: 'local://contract.pdf', sha256_hash: uid('sha'), uploaded_at: new Date(), userId: project.userId,
      },
    });
    vertex.generate.mockResolvedValue({
      text: '{}',
      json: {
        scopeItems: [{ description: 'Install 3-ton HVAC unit', quantity: 1, unit: 'ea', unitRate: 4500, totalAmount: 4500, category: 'equipment', pageNumber: 2 }],
        contractProvisions: [{ category: 'exclusion', clauseText: 'Ductwork replacement is not included', pageNumber: 3, sectionRef: '4.2' }],
      },
      modelVersion: 'gemini-2.5-flash-001',
      usage: { promptTokens: 500, completionTokens: 120, totalTokens: 620 },
      costUsd: 0.0009,
    });

    const result = await pipeline.extractContractBaseline({ orgId: org.id, project, sourceDocument, extractedText: 'contract text...' });

    expect(result.scopeItems).toHaveLength(1);
    expect(result.scopeItems[0].description).toBe('Install 3-ton HVAC unit');
    expect(result.scopeItems[0].pageReference).toBe('2');
    expect(result.contractProvisions).toHaveLength(1);

    const run = await prisma.agentRunRecord.findUnique({ where: { id: result.agentRunId } });
    expect(run.status).toBe('completed');
    expect(run.model_version).toBe('gemini-2.5-flash-001');
    expect(run.token_usage).toBe(620);
    expect(run.agent_type).toBe('contract_baseline_extraction');
  });

  test('a Vertex failure marks the AgentRunRecord failed and rethrows', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    const sourceDocument = await prisma.sourceDocument.create({
      data: {
        orgId: org.id, project_id: project.id, document_type: 'contract', original_filename: 'c2.pdf',
        storage_uri: 'local://c2.pdf', sha256_hash: uid('sha'), uploaded_at: new Date(), userId: project.userId,
      },
    });
    vertex.generate.mockRejectedValue(new Error('upstream 503'));

    await expect(pipeline.extractContractBaseline({ orgId: org.id, project, sourceDocument, extractedText: 'x' }))
      .rejects.toThrow('upstream 503');

    const run = await prisma.agentRunRecord.findFirst({ where: { orgId: org.id, agent_type: 'contract_baseline_extraction' }, orderBy: { createdAt: 'desc' } });
    expect(run.status).toBe('failed');
    expect(run.error_message).toMatch(/upstream 503/);
  });
});

describe('compareScopeToEvidence — mandatory citation enforcement', () => {
  test('a finding with a resolvable citation is persisted with a real Citation row', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    const evidenceItem = await prisma.evidenceItem.create({
      data: { orgId: org.id, project_id: project.id, evidenceType: 'photo', storageUri: 'local://p1.jpg', sha256Hash: uid('sha'), extractedText: 'Duct run visible in attic, new ductwork installed' },
    });
    vertex.generate.mockResolvedValue({
      text: '{}',
      json: {
        findings: [{
          findingType: 'scope_delta', assertion: 'New ductwork was installed but not in the original scope',
          severity: 'medium', confidence: 0.75,
          citations: [{ sourceKey: `evidence:${evidenceItem.id}`, quotedText: 'new ductwork installed', pageNumber: null }],
        }],
      },
      modelVersion: 'gemini-2.5-pro-001',
      usage: { promptTokens: 900, completionTokens: 80, totalTokens: 980 },
      costUsd: 0.0012,
    });

    const result = await pipeline.compareScopeToEvidence({
      orgId: org.id, project, scopeItems: [], contractProvisions: [], evidenceItems: [evidenceItem],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.discardedCount).toBe(0);
    const citations = await prisma.citation.findMany({ where: { findingId: result.findings[0].id } });
    expect(citations).toHaveLength(1);
    expect(citations[0].evidenceItemId).toBe(evidenceItem.id);
  });

  test('a finding whose citation sourceKey does not resolve to a real source is discarded, not persisted', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    vertex.generate.mockResolvedValue({
      text: '{}',
      json: {
        findings: [{
          findingType: 'scope_delta', assertion: 'Fabricated finding citing a source that does not exist',
          severity: 'high', confidence: 0.9,
          citations: [{ sourceKey: 'evidence:does-not-exist', quotedText: 'invented quote' }],
        }],
      },
      modelVersion: 'gemini-2.5-pro-001',
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
      costUsd: 0.0002,
    });

    const result = await pipeline.compareScopeToEvidence({
      orgId: org.id, project, scopeItems: [], contractProvisions: [], evidenceItems: [],
    });

    expect(result.findings).toHaveLength(0);
    expect(result.discardedCount).toBe(1);
    const allFindings = await prisma.evidenceFinding.findMany({ where: { orgId: org.id, project_id: project.id } });
    expect(allFindings).toHaveLength(0);
  });

  test('a finding with NO citations at all is discarded (unsupported-assertion refusal)', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    vertex.generate.mockResolvedValue({
      text: '{}',
      json: { findings: [{ findingType: 'scope_delta', assertion: 'Unsupported guess', severity: 'low', confidence: 0.3, citations: [] }] },
      modelVersion: 'gemini-2.5-pro-001',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      costUsd: 0.0001,
    });

    const result = await pipeline.compareScopeToEvidence({ orgId: org.id, project, scopeItems: [], contractProvisions: [], evidenceItems: [] });
    expect(result.findings).toHaveLength(0);
    expect(result.discardedCount).toBe(1);
  });
});

describe('validateCitations', () => {
  test('flags a citation whose quoted text is not actually present in the source', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    const evidenceItem = await prisma.evidenceItem.create({
      data: { orgId: org.id, project_id: project.id, evidenceType: 'photo', storageUri: 'local://p2.jpg', sha256Hash: uid('sha'), extractedText: 'A completely different description' },
    });
    const finding = await prisma.evidenceFinding.create({
      data: { orgId: org.id, project_id: project.id, finding_type: 'scope_delta', assertion: 'x', source_citations: '[]', userId: project.userId },
    });
    await prisma.citation.create({ data: { orgId: org.id, findingId: finding.id, evidenceItemId: evidenceItem.id, quotedText: 'text that was never actually said' } });

    const results = await pipeline.validateCitations({ orgId: org.id, findingId: finding.id });
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toBe('quoted_text_not_found_in_source');
  });

  test('validates a citation whose quoted text IS present in the source', async () => {
    const { org, project } = await makeOrgProjectCustomer();
    const evidenceItem = await prisma.evidenceItem.create({
      data: { orgId: org.id, project_id: project.id, evidenceType: 'photo', storageUri: 'local://p3.jpg', sha256Hash: uid('sha'), extractedText: 'new ductwork installed in the attic space' },
    });
    const finding = await prisma.evidenceFinding.create({
      data: { orgId: org.id, project_id: project.id, finding_type: 'scope_delta', assertion: 'x', source_citations: '[]', userId: project.userId },
    });
    await prisma.citation.create({ data: { orgId: org.id, findingId: finding.id, evidenceItemId: evidenceItem.id, quotedText: 'new ductwork installed' } });

    const results = await pipeline.validateCitations({ orgId: org.id, findingId: finding.id });
    expect(results[0].valid).toBe(true);
    expect(results[0].reason).toBe('ok');
  });
});
