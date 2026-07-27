/**
 * lib/org-deletion.js — the org-wide deletion sweep. Real SQLite test
 * database, no mocks: this is exactly the kind of destructive logic where
 * "should work" isn't good enough — every assertion here checks real rows.
 */
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const orgDeletion = require('../../lib/org-deletion');

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

/** Seeds a realistic, deeply cross-referenced dataset for one org: the
 * exact chain of models research flagged as having real FK dependencies
 * (Customer -> ProjectRecord -> SourceDocument/EvidenceItem -> ScopeItem/
 * ContractProvision/EvidenceFinding+Citation/EvidencePacket+
 * CommercialOutcome+StageTransition), plus org-level rows with no FK chain
 * (Subscription, Invoice, AgentRunRecord) and a home User + their ApiKey. */
async function seedFullOrg() {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true, name: 'Real Owner' } });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
  const apiKey = await prisma.apiKey.create({ data: { userId: user.id, name: 'CI key', keyHash: uid('hash'), prefix: 'sk_test', active: true } });

  const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Riverside Community Center' } });
  const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'HVAC Retrofit', userId: user.id, original_scope_summary: 'Replace unit.' } });
  const sourceDocument = await prisma.sourceDocument.create({
    data: {
      orgId: org.id, project_id: project.id, document_type: 'invoice',
      original_filename: 'invoice.txt', storage_uri: 'local://irrelevant',
      sha256_hash: uid('sha'), uploaded_at: new Date(), extraction_status: 'extracted', userId: user.id,
      mime_type: 'text/plain',
    },
  });
  const evidenceItem = await prisma.evidenceItem.create({
    data: { orgId: org.id, project_id: project.id, evidenceType: 'photo', storageUri: 'local://irrelevant2', sha256Hash: uid('sha2'), uploadedById: user.id },
  });
  const scopeItem = await prisma.scopeItem.create({ data: { orgId: org.id, project_id: project.id, description: 'HVAC filter replacement' } });
  const contractProvision = await prisma.contractProvision.create({
    data: { orgId: org.id, project_id: project.id, sourceDocumentId: sourceDocument.id, clauseText: 'Replace filter only.' },
  });
  const finding = await prisma.evidenceFinding.create({
    data: { orgId: org.id, project_id: project.id, finding_type: 'scope_delta', assertion: 'Extra work performed.', source_citations: '[]' },
  });
  await prisma.citation.create({ data: { orgId: org.id, findingId: finding.id, sourceDocumentId: sourceDocument.id } });
  const packet = await prisma.evidencePacket.create({ data: { orgId: org.id, project_id: project.id, packet_number: 'P-1', version: 1, userId: user.id } });
  const outcome = await prisma.commercialOutcome.create({ data: { orgId: org.id, project_id: project.id, packet_id: packet.id, userId: user.id } });
  await prisma.stageTransition.create({ data: { orgId: org.id, outcomeId: outcome.id, toStage: 'identified', amount: 1000 } });
  await prisma.agentRunRecord.create({ data: { orgId: org.id, project_id: project.id, agent_type: 'sourceDocument_analyze_job', status: 'completed' } });
  await prisma.subscription.create({ data: { orgId: org.id, planId: 'pro', status: 'active' } });
  await prisma.invoice.create({ data: { orgId: org.id, stripeInvoiceId: uid('in'), amountCents: 5000, status: 'paid', periodStart: new Date(), periodEnd: new Date() } });

  return { org, user, apiKey, customer, project, sourceDocument, evidenceItem, scopeItem, contractProvision, finding, packet, outcome };
}

afterAll(async () => { await prisma.$disconnect(); });

describe('requestOrgDeletion / cancelOrgDeletion', () => {
  test('sets and clears the scheduling fields', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });

    const requested = await orgDeletion.requestOrgDeletion({ orgId: org.id, requestedByUserId: user.id, graceDays: 30 });
    expect(requested.deletionRequestedAt).toBeTruthy();
    expect(requested.deletionRequestedBy).toBe(user.id);
    const expectedMs = requested.deletionRequestedAt.getTime() + 30 * 86_400_000;
    expect(Math.abs(requested.scheduledDeletionAt.getTime() - expectedMs)).toBeLessThan(1000);

    const canceled = await orgDeletion.cancelOrgDeletion({ orgId: org.id });
    expect(canceled.deletionRequestedAt).toBeNull();
    expect(canceled.deletionRequestedBy).toBeNull();
    expect(canceled.scheduledDeletionAt).toBeNull();
  });
});

describe('hasActiveLegalHold', () => {
  test('true only for an unreleased hold', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    expect(await orgDeletion.hasActiveLegalHold(org.id)).toBe(false);

    const hold = await prisma.retentionLegalHold.create({
      data: { orgId: org.id, resourceType: 'project', resourceId: uid('res'), holdType: 'legal_hold' },
    });
    expect(await orgDeletion.hasActiveLegalHold(org.id)).toBe(true);

    await prisma.retentionLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date() } });
    expect(await orgDeletion.hasActiveLegalHold(org.id)).toBe(false);
  });
});

describe('executeOrgDeletion', () => {
  test('an active legal hold blocks deletion entirely — the org and its data survive', async () => {
    const { org, project } = await seedFullOrg();
    await prisma.retentionLegalHold.create({ data: { orgId: org.id, resourceType: 'project', resourceId: project.id, holdType: 'legal_hold' } });

    const result = await orgDeletion.executeOrgDeletion({ orgId: org.id });
    expect(result).toEqual({ orgId: org.id, skipped: true, reason: 'active_legal_hold' });

    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeTruthy();
    expect(await prisma.projectRecord.findUnique({ where: { id: project.id } })).toBeTruthy();
  });

  test('dry run reports counts for every org-scoped model without deleting anything', async () => {
    const { org } = await seedFullOrg();
    const result = await orgDeletion.executeOrgDeletion({ orgId: org.id, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.counts.projectRecord).toBe(1);
    expect(result.counts.customer).toBe(1);
    expect(result.counts.evidenceFinding).toBe(1);
    expect(result.usersToAnonymize).toBe(1);

    // Nothing was actually touched.
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeTruthy();
    expect(await prisma.projectRecord.count({ where: { orgId: org.id } })).toBe(1);
  });

  test('real execution deletes every org-scoped row across every model, anonymizes the home user, deactivates their API keys, and leaves a DIFFERENT org completely untouched', async () => {
    const seeded = await seedFullOrg();
    const other = await seedFullOrg(); // a second, unrelated org with its own full dataset

    const result = await orgDeletion.executeOrgDeletion({ orgId: seeded.org.id });
    expect(result.deleted).toBe(true);
    expect(result.usersAnonymized).toBe(1);

    // The org itself is gone.
    expect(await prisma.organization.findUnique({ where: { id: seeded.org.id } })).toBeNull();

    // Every org-scoped model — not just the ones this test happened to seed —
    // reports zero rows for the deleted org, verified generically against
    // the SAME list the sweep itself uses (no hand-maintained model list to
    // fall out of sync here either).
    for (const prop of orgDeletion.ORG_SCOPED_MODEL_PROPS) {
      const count = await prisma[prop].count({ where: { orgId: seeded.org.id } });
      expect({ model: prop, count }).toEqual({ model: prop, count: 0 });
    }

    // The home user is anonymized in place (row kept, per the DSAR pattern),
    // unlinked from the now-gone org, and their API key deactivated.
    const anonymizedUser = await prisma.user.findUnique({ where: { id: seeded.user.id } });
    expect(anonymizedUser).toBeTruthy();
    expect(anonymizedUser.orgId).toBeNull();
    expect(anonymizedUser.role).toBe('erased');
    expect(anonymizedUser.email).toMatch(/^erased-.+@erased\.invalid$/);
    const key = await prisma.apiKey.findUnique({ where: { id: seeded.apiKey.id } });
    expect(key.active).toBe(false);

    // A completely separate org's identical dataset is fully intact.
    expect(await prisma.organization.findUnique({ where: { id: other.org.id } })).toBeTruthy();
    expect(await prisma.projectRecord.findUnique({ where: { id: other.project.id } })).toBeTruthy();
    expect(await prisma.evidenceFinding.findUnique({ where: { id: other.finding.id } })).toBeTruthy();
    const otherUser = await prisma.user.findUnique({ where: { id: other.user.id } });
    expect(otherUser.role).not.toBe('erased');
    expect(otherUser.orgId).toBe(other.org.id);
  });

  test('regression: a pre-registered collision on the deterministic anon-email does not permanently block deletion', async () => {
    // The anon email is deterministic from userId alone (any org member can
    // read another's id via GET /members), so it's guessable in advance.
    // Simulates someone squatting that exact address before deletion runs —
    // deletion must still succeed (falling back to a randomized suffix),
    // not abort the whole org's deletion and silently stay stuck forever.
    const seeded = await seedFullOrg();
    const anonId = `erased-${crypto.createHash('sha256').update(seeded.user.id).digest('hex').slice(0, 16)}`;
    await prisma.user.create({ data: { email: `${anonId}@erased.invalid`, passwordHash: 'x', emailVerified: true } });

    const result = await orgDeletion.executeOrgDeletion({ orgId: seeded.org.id });
    expect(result.deleted).toBe(true);

    const anonymizedUser = await prisma.user.findUnique({ where: { id: seeded.user.id } });
    expect(anonymizedUser.role).toBe('erased');
    expect(anonymizedUser.email).toMatch(/^erased-.+@erased\.invalid$/);
    expect(anonymizedUser.email).not.toBe(`${anonId}@erased.invalid`); // fell back to a randomized suffix
  });

  test('a guest membership in a DIFFERENT (surviving) org is untouched when the home org is deleted', async () => {
    const seeded = await seedFullOrg();
    const otherOrg = await prisma.organization.create({ data: { name: uid('OtherOrg') } });
    // seeded.user is also a member of otherOrg, but otherOrg is NOT their home org.
    await prisma.orgMembership.create({ data: { orgId: otherOrg.id, userId: seeded.user.id, role: 'viewer', status: 'active' } });

    await orgDeletion.executeOrgDeletion({ orgId: seeded.org.id });

    const guestMembership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: otherOrg.id, userId: seeded.user.id } } });
    expect(guestMembership).toBeTruthy();
    expect(guestMembership.status).toBe('active'); // untouched — this org was never deleted
  });
});

describe('findOrgsDueForDeletion / sweepOrgsForDeletion', () => {
  test('only finds orgs whose scheduledDeletionAt has passed', async () => {
    const future = await prisma.organization.create({ data: { name: uid('Org'), scheduledDeletionAt: new Date(Date.now() + 86_400_000) } });
    const due = await prisma.organization.create({ data: { name: uid('Org'), scheduledDeletionAt: new Date(Date.now() - 1000) } });

    const results = await orgDeletion.findOrgsDueForDeletion();
    const ids = results.map((o) => o.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(future.id);
  });

  test('sweep executes deletion for every due org and skips ones under an active hold, without touching not-yet-due orgs', async () => {
    const dueAndClear = await seedFullOrg();
    await prisma.organization.update({ where: { id: dueAndClear.org.id }, data: { scheduledDeletionAt: new Date(Date.now() - 1000) } });

    const dueButHeld = await seedFullOrg();
    await prisma.organization.update({ where: { id: dueButHeld.org.id }, data: { scheduledDeletionAt: new Date(Date.now() - 1000) } });
    await prisma.retentionLegalHold.create({ data: { orgId: dueButHeld.org.id, resourceType: 'project', resourceId: dueButHeld.project.id, holdType: 'legal_hold' } });

    const notDue = await seedFullOrg();
    await prisma.organization.update({ where: { id: notDue.org.id }, data: { scheduledDeletionAt: new Date(Date.now() + 86_400_000) } });

    const results = await orgDeletion.sweepOrgsForDeletion();
    const byOrg = Object.fromEntries(results.map((r) => [r.orgId, r]));

    expect(byOrg[dueAndClear.org.id]).toMatchObject({ deleted: true });
    expect(await prisma.organization.findUnique({ where: { id: dueAndClear.org.id } })).toBeNull();

    expect(byOrg[dueButHeld.org.id]).toMatchObject({ skipped: true, reason: 'active_legal_hold' });
    expect(await prisma.organization.findUnique({ where: { id: dueButHeld.org.id } })).toBeTruthy();

    expect(byOrg[notDue.org.id]).toBeUndefined(); // not due yet — never even considered
    expect(await prisma.organization.findUnique({ where: { id: notDue.org.id } })).toBeTruthy();
  });
});
