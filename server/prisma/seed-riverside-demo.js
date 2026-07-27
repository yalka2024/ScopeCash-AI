/**
 * Riverside Community Center HVAC Retrofit — fictional demonstration data.
 *
 * Everything in this script is invented for demonstration purposes: the
 * customer, contractor, contract, estimate, field evidence, and every name.
 * No real person, business, or jobsite is represented. The project name and
 * every generated packet are prefixed "[FICTIONAL DEMO]" so this cannot be
 * mistaken for real customer data in the product UI or in exports.
 *
 * Deterministic and idempotent: running it twice updates the same rows
 * (looked up by a fixed slug) rather than duplicating them. Does NOT call
 * the real Gemini API — the "AI-generated" findings below are exactly what
 * lib/evidence-pipeline.js would produce from this evidence (same shape,
 * same mandatory-citation-enforcement discipline), authored directly so the
 * demo runs offline without GCP credentials.
 *
 * Usage: node prisma/seed-riverside-demo.js   (also: npm run db:seed:demo)
 */
const crypto = require('crypto');
// bcryptjs, not lib/security.js's @node-rs/bcrypt: this is a one-time,
// offline, non-concurrent script -- the event-loop-blocking behavior
// that motivated the switch in lib/security.js doesn't apply here.
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { runWithSystemAccess, runWithOrg } = require('../lib/tenant-context');
const storage = require('../lib/storage');
const pdfPacketRenderer = require('../lib/tools/pdfpacketrenderer');

const DEMO_ORG_NAME = 'Summit Mechanical Services (Demo)';
const DEMO_ADMIN_EMAIL = 'demo-owner@summitmechanical.example';

// A tiny (1x1 pixel) but byte-valid JPEG — real magic bytes so
// storage.sniffMagicBytes()-style validation and sha256 hashing behave
// exactly as they would for a real photo, without needing real image assets.
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64',
);
// A tiny, byte-valid (silence) WAV header — same rationale as above.
const PLACEHOLDER_WAV = Buffer.from(
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
  'base64',
);

// Distinct photos need distinct bytes (and therefore distinct sha256 hashes)
// so duplicate detection only fires for the ONE pair that's meant to be a
// genuine duplicate — appending a tag after the JPEG's EOI marker changes
// the hash without invalidating the file (magic-byte sniffing only reads
// the first 3 bytes; trailing bytes after 0xFFD9 are standard practice for
// JPEG comment/metadata blocks and are ignored by decoders).
function jpegVariant(tag) {
  return Buffer.concat([PLACEHOLDER_JPEG, Buffer.from(`DEMO-TAG:${tag}`, 'utf8')]);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function ensureDemoOrgAndUsers() {
  return runWithSystemAccess(async () => {
    let org = await prisma.organization.findFirst({ where: { name: DEMO_ORG_NAME } });
    if (!org) {
      org = await prisma.organization.create({ data: { name: DEMO_ORG_NAME, plan: 'pro' } });
      console.log(`[riverside-demo] created org ${org.id}`);
    }
    await prisma.organizationRecord.upsert({
      where: { orgId: org.id },
      update: {},
      create: {
        orgId: org.id, name: DEMO_ORG_NAME, legal_name: 'Summit Mechanical Services LLC (fictional)',
        trade_types: 'HVAC', timezone: 'America/Los_Angeles', currency: 'USD',
        default_markup: 0.15, default_tax_rate: 0.0875,
      },
    });

    async function ensureUser(email, name, role) {
      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        user = await prisma.user.create({
          data: { email, name, passwordHash: await bcrypt.hash(crypto.randomBytes(18).toString('base64url'), 10), orgId: org.id, emailVerified: true },
        });
      }
      await prisma.orgMembership.upsert({
        where: { orgId_userId: { orgId: org.id, userId: user.id } },
        update: { role, status: 'active' },
        create: { orgId: org.id, userId: user.id, role, status: 'active' },
      });
      return user;
    }

    const owner = await ensureUser(DEMO_ADMIN_EMAIL, 'Summit Mechanical (Owner)', 'owner');
    const pm = await ensureUser('dana.reyes@summitmechanical.example', 'Dana Reyes', 'project_manager');
    const estimator = await ensureUser('priya.shah@summitmechanical.example', 'Priya Shah', 'estimator');
    const fieldTech = await ensureUser('mike.alvarez@summitmechanical.example', 'Mike Alvarez', 'field_user');
    return { org, owner, pm, estimator, fieldTech };
  });
}

const CONTRACT_TEXT = `CONTRACT FOR HVAC REPLACEMENT SERVICES
Between: Summit Mechanical Services ("Contractor") and Riverside Community Center ("Customer")
Date: March 3, 2026
Project Address: 4200 Magnolia Ave, Riverside, CA 92501

SCOPE OF WORK
1. Remove existing rooftop package HVAC unit (5-ton, non-functional compressor).
2. Furnish and install one (1) new 5-ton rooftop package HVAC unit (Carrier 48TC-060), including standard roof curb adapter.
3. Reconnect existing electrical whip to new unit disconnect (existing circuit, no panel work).
4. Reconnect existing supply and return ductwork connections at the curb only.
5. Startup, commissioning, and 1-year manufacturer warranty registration.

EXCLUSIONS
This Contract does NOT include: any ductwork replacement, modification, or extension
beyond the existing curb connections; any electrical panel, breaker, or service upgrade;
roofing repair beyond the curb adapter; or any work not explicitly listed above.

CONTRACT PRICE: $18,500.00, due upon substantial completion.

Section 4.2 - Change Orders: Any work outside this Scope of Work requires a signed,
written Change Order prior to performance. Verbal approvals are not binding.
`;

const ESTIMATE_TEXT = `ESTIMATE #EST-2026-0311
Riverside Community Center - Rooftop HVAC Replacement

1. Remove existing 5-ton rooftop unit ................................ $1,200.00
2. Furnish new 5-ton Carrier 48TC-060 rooftop unit .................... $9,800.00
3. Roof curb adapter kit ................................................ $950.00
4. Rigging / crane (rooftop set) ...................................... $1,800.00
5. Electrical reconnect (existing circuit) .............................. $650.00
6. Ductwork reconnect at curb ............................................ $500.00
7. Startup, commissioning, warranty registration ........................ $600.00
8. Labor (2 techs x 2 days) ........................................... $3,000.00
--------------------------------------------------------------------------------
TOTAL ................................................................ $18,500.00

NOTE: Quote assumes existing ductwork and electrical panel are adequate for the
new unit. If field conditions require ductwork modification or panel upgrade, a
Change Order will be issued before proceeding.
`;

async function ensureSourceDocument(orgId, projectId, userId, { type, filename, text }) {
  const buf = Buffer.from(text, 'utf8');
  const hash = sha256(buf);
  const existing = await prisma.sourceDocument.findUnique({ where: { sha256_hash: hash } });
  if (existing) return existing;
  const key = storage.newKey(userId, filename);
  await storage.putObject({ key, body: buf, contentType: 'text/plain' });
  return prisma.sourceDocument.create({
    data: {
      orgId, project_id: projectId, document_type: type, original_filename: filename,
      storage_uri: key, mime_type: 'text/plain', file_size_bytes: buf.length, sha256_hash: hash,
      uploaded_by_id: userId, uploaded_at: new Date('2026-03-03T09:00:00Z'), extraction_status: 'extracted', userId,
    },
  });
}

async function ensureEvidenceItem(orgId, projectId, userId, { filename, buffer, evidenceType, capturedAt, extractedText, transcript, duplicateOfId, quality }) {
  // Deterministic key (not storage.newKey()'s random suffix) so re-running
  // this seed finds the same row by storageUri instead of creating a new
  // one each time. sha256Hash is the REAL hash of the bytes — the
  // "duplicate" photo genuinely shares it with its original, exactly like a
  // real second upload of the same content would (EvidenceItem's unique
  // constraint was deliberately dropped for this reason; see schema.prisma).
  const key = `demo/riverside/${filename}`;
  const existing = await prisma.evidenceItem.findFirst({ where: { orgId, storageUri: key } });
  if (existing) return existing;
  await storage.putObject({ key, body: buffer, contentType: evidenceType === 'audio' ? 'audio/wav' : 'image/jpeg' });
  const hash = sha256(buffer);
  return prisma.evidenceItem.create({
    data: {
      orgId, project_id: projectId, evidenceType, storageUri: key, sha256Hash: hash,
      capturedAt: capturedAt || null, uploadedById: userId, extractedText: extractedText || null,
      transcript: transcript || null, duplicateOfId: duplicateOfId || null, quality: quality || 'ok',
    },
  });
}

async function main() {
  const { org, owner, pm, estimator, fieldTech } = await ensureDemoOrgAndUsers();

  await runWithOrg(org.id, async () => {
    const customer = await (async () => {
      const existing = await prisma.customer.findFirst({ where: { orgId: org.id, name: 'Riverside Community Center' } });
      if (existing) return existing;
      return prisma.customer.create({
        data: { orgId: org.id, name: 'Riverside Community Center', companyName: 'Riverside Community Center (fictional nonprofit)', email: 'facilities@riverside-cc.example', address: '4200 Magnolia Ave, Riverside, CA 92501' },
      });
    })();

    const project = await (async () => {
      const existing = await prisma.projectRecord.findFirst({ where: { orgId: org.id, project_number: 'RVS-2026-0311' } });
      const data = {
        orgId: org.id, customer_id: customer.id, name: '[FICTIONAL DEMO] Riverside Community Center — Rooftop HVAC Replacement',
        project_number: 'RVS-2026-0311', trade: 'HVAC', status: 'active', address: '4200 Magnolia Ave, Riverside, CA 92501',
        start_date: new Date('2026-03-10T00:00:00Z'), contract_value: 18500, original_estimate_value: 18500,
        project_manager_id: pm.id, estimator_id: estimator.id,
        original_scope_summary: 'Replace one 5-ton rooftop package HVAC unit; reconnect existing ductwork and electrical at the curb only. Excludes ductwork modification and electrical panel/breaker work.',
        exclusions_summary: 'No ductwork replacement/extension beyond curb connections. No electrical panel, breaker, or service upgrade. FICTIONAL DEMO DATA — not a real customer or project.',
        userId: owner.id,
      };
      if (existing) return prisma.projectRecord.update({ where: { id: existing.id }, data });
      return prisma.projectRecord.create({ data });
    })();

    // ---- Contract & estimate (baseline, as if extracted by the pipeline) ----
    const contractDoc = await ensureSourceDocument(org.id, project.id, owner.id, { type: 'contract', filename: 'riverside-contract.txt', text: CONTRACT_TEXT });
    const estimateDoc = await ensureSourceDocument(org.id, project.id, estimator.id, { type: 'estimate', filename: 'riverside-estimate.txt', text: ESTIMATE_TEXT });

    async function ensureScopeItem(description, extra) {
      const existing = await prisma.scopeItem.findFirst({ where: { orgId: org.id, project_id: project.id, description } });
      if (existing) return existing;
      return prisma.scopeItem.create({ data: { orgId: org.id, project_id: project.id, source: 'original', sourceDocumentId: estimateDoc.id, description, ...extra } });
    }
    await ensureScopeItem('Remove existing 5-ton rooftop unit', { quantity: 1, unit: 'ea', unitRate: 1200, totalAmount: 1200, category: 'labor', pageReference: '1' });
    await ensureScopeItem('Furnish new 5-ton Carrier 48TC-060 rooftop unit', { quantity: 1, unit: 'ea', unitRate: 9800, totalAmount: 9800, category: 'equipment', pageReference: '1' });
    await ensureScopeItem('Electrical reconnect (existing circuit)', { quantity: 1, unit: 'ea', unitRate: 650, totalAmount: 650, category: 'electrical', pageReference: '1' });
    await ensureScopeItem('Ductwork reconnect at curb', { quantity: 1, unit: 'ea', unitRate: 500, totalAmount: 500, category: 'ductwork', pageReference: '1' });

    async function ensureProvision(category, clauseText, pageNumber) {
      const existing = await prisma.contractProvision.findFirst({ where: { orgId: org.id, project_id: project.id, clauseText } });
      if (existing) return existing;
      return prisma.contractProvision.create({ data: { orgId: org.id, project_id: project.id, sourceDocumentId: contractDoc.id, category, clauseText, pageNumber } });
    }
    await ensureProvision('exclusion', 'This Contract does NOT include: any ductwork replacement, modification, or extension beyond the existing curb connections', 1);
    await ensureProvision('exclusion', 'any electrical panel, breaker, or service upgrade', 1);
    await ensureProvision('change_order', 'Any work outside this Scope of Work requires a signed, written Change Order prior to performance. Verbal approvals are not binding.', 1);

    // ---- Field evidence ----
    const photoDuct = await ensureEvidenceItem(org.id, project.id, fieldTech.id, {
      filename: 'attic-ductwork.jpg', buffer: jpegVariant('ductwork'), evidenceType: 'photo',
      capturedAt: new Date('2026-03-11T14:20:00Z'),
      extractedText: 'New flexible ductwork run installed from the rooftop unit down through the ceiling to a second-floor classroom supply register that did not previously exist. This is new ductwork, not a curb reconnect.',
    });
    // Duplicate of the ductwork photo — same visual content (same tag, so
    // the SAME bytes/hash), uploaded again by a different field tech later
    // the same day. duplicateOfId links it back.
    await ensureEvidenceItem(org.id, project.id, pm.id, {
      filename: 'attic-ductwork-copy.jpg', buffer: jpegVariant('ductwork'), evidenceType: 'photo',
      capturedAt: new Date('2026-03-11T16:05:00Z'),
      extractedText: 'New flexible ductwork run installed from the rooftop unit down through the ceiling to a second-floor classroom supply register that did not previously exist. This is new ductwork, not a curb reconnect.',
      duplicateOfId: photoDuct.id,
    });
    // Missing-timestamp evidence: camera clock was reset, capturedAt is null.
    const photoPanel = await ensureEvidenceItem(org.id, project.id, fieldTech.id, {
      filename: 'electrical-panel.jpg', buffer: jpegVariant('panel'), evidenceType: 'photo',
      capturedAt: null,
      extractedText: 'Electrical panel with a new 30-amp breaker added; panel cover shows visible new wiring not present in the original panel schedule.',
    });
    const audioNote = await ensureEvidenceItem(org.id, project.id, fieldTech.id, {
      filename: 'day2-voice-note.wav', buffer: PLACEHOLDER_WAV, evidenceType: 'audio',
      capturedAt: new Date('2026-03-11T17:00:00Z'),
      transcript: "Hey it's Mike, day two on the Riverside job. So the second floor classroom didn't have a return register at all, we had to run new duct up from the unit, that's probably a change order, gonna flag it. Also the panel was undersized for the new unit's disconnect so we added a breaker — that one's on us for not catching it at estimate, but it's still extra work either way.",
    });
    // A blurry, ambiguous photo with no corroboration — becomes the rejected finding.
    const photoAmbiguous = await ensureEvidenceItem(org.id, project.id, fieldTech.id, {
      filename: 'condensate-blurry.jpg', buffer: jpegVariant('condensate'), evidenceType: 'photo',
      capturedAt: new Date('2026-03-12T10:00:00Z'), quality: 'low_quality',
      extractedText: 'Out-of-focus photo near a condensate line; not possible to confirm what work, if any, was performed.',
    });
    // Two contradictory messages about verbal change-order approval.
    const messageApproved = await ensureEvidenceItem(org.id, project.id, pm.id, {
      filename: 'message-1-verbal-approval.txt', buffer: Buffer.from("Called the customer's facilities director, explained the extra ductwork run and the panel breaker addition, she said 'go ahead, that's fine.'"), evidenceType: 'message',
      capturedAt: new Date('2026-03-11T18:00:00Z'),
      extractedText: "Called the customer's facilities director, explained the extra ductwork run and the panel breaker addition, she said 'go ahead, that's fine.'",
    });
    const messageDenied = await ensureEvidenceItem(org.id, project.id, pm.id, {
      filename: 'message-2-written-denial.txt', buffer: Buffer.from('Per our email chain, Riverside Community Center has NOT approved any change orders beyond the signed contract scope. Please submit any additional charges through the board approval process before proceeding.'), evidenceType: 'message',
      capturedAt: new Date('2026-03-13T09:30:00Z'),
      extractedText: 'Per our email chain, Riverside Community Center has NOT approved any change orders beyond the signed contract scope. Please submit any additional charges through the board approval process before proceeding.',
    });

    // ---- Change event + findings (exactly what evidence-pipeline.js's
    // mandatory-citation-enforcement would have produced from this evidence —
    // authored directly so the demo runs without live Gemini credentials) ----
    const changeEvent = await (async () => {
      const existing = await prisma.changeEvent.findFirst({ where: { orgId: org.id, project_id: project.id, title: 'Unbilled scope beyond curb-only HVAC reconnect' } });
      const data = {
        orgId: org.id, project_id: project.id, title: 'Unbilled scope beyond curb-only HVAC reconnect',
        description: 'Field evidence shows ductwork and electrical panel work performed beyond the contract\'s curb-only reconnect scope.',
        event_date: new Date('2026-03-12T00:00:00Z'), status: 'reviewing', reason_category: 'field_condition', ai_confidence: 0.82, risk_level: 'medium', userId: pm.id,
      };
      if (existing) return prisma.changeEvent.update({ where: { id: existing.id }, data });
      return prisma.changeEvent.create({ data });
    })();

    async function ensureFinding(assertion, fields, citationSpecs) {
      const existing = await prisma.evidenceFinding.findFirst({ where: { orgId: org.id, project_id: project.id, assertion } });
      const finding = existing
        ? await prisma.evidenceFinding.update({ where: { id: existing.id }, data: fields })
        : await prisma.evidenceFinding.create({ data: { orgId: org.id, project_id: project.id, change_event_id: changeEvent.id, assertion, ...fields } });
      if (!existing) {
        for (const c of citationSpecs) await prisma.citation.create({ data: { orgId: org.id, findingId: finding.id, ...c } });
      }
      return finding;
    }

    const findingDuctwork = await ensureFinding(
      'New ductwork was run from the rooftop unit to a second-floor classroom register — this exceeds the contract\'s curb-only reconnect scope and its explicit ductwork exclusion.',
      { finding_type: 'scope_delta', source_citations: JSON.stringify([{ evidenceItemId: photoDuct.id }, { evidenceItemId: audioNote.id }]), confidence: 0.88, severity: 'medium', ai_generated: true, human_decision: 'supported', reviewer_id: pm.id, decision_reason: 'Confirmed via photo and field tech audio; ductwork clearly exceeds curb-only reconnect per contract Exclusions.' },
      [
        { evidenceItemId: photoDuct.id, quotedText: 'New flexible ductwork run installed from the rooftop unit down through the ceiling to a second-floor classroom supply register that did not previously exist' },
        { evidenceItemId: audioNote.id, quotedText: "the second floor classroom didn't have a return register at all, we had to run new duct up from the unit" },
      ],
    );

    const findingPanel = await ensureFinding(
      'A new 30-amp breaker was added to the electrical panel — the contract explicitly excludes any panel, breaker, or service upgrade.',
      { finding_type: 'scope_delta', source_citations: JSON.stringify([{ evidenceItemId: photoPanel.id }, { evidenceItemId: audioNote.id }]), confidence: 0.83, severity: 'medium', ai_generated: true, human_decision: 'supported', reviewer_id: pm.id, decision_reason: 'Confirmed via photo and field tech audio; breaker addition is explicitly excluded work per contract.' },
      [
        { evidenceItemId: photoPanel.id, quotedText: 'Electrical panel with a new 30-amp breaker added; panel cover shows visible new wiring' },
        { evidenceItemId: audioNote.id, quotedText: 'panel was undersized for the new unit\'s disconnect so we added a breaker' },
      ],
    );

    await ensureFinding(
      'Field team recorded a verbal customer approval for the extra work, but a later written message states no change orders were approved — and Contract Section 4.2 states verbal approvals are not binding.',
      { finding_type: 'contradiction', source_citations: JSON.stringify([{ evidenceItemId: messageApproved.id }, { evidenceItemId: messageDenied.id }]), contradictory_evidence: 'message-1-verbal-approval.txt claims verbal go-ahead; message-2-written-denial.txt (2 days later) states no change orders were approved. Contract Sec. 4.2 requires a signed written change order — verbal approval is not binding either way.', confidence: 0.79, severity: 'high', ai_generated: true, human_decision: 'pending' },
      [
        { evidenceItemId: messageApproved.id, quotedText: "she said 'go ahead, that's fine.'" },
        { evidenceItemId: messageDenied.id, quotedText: 'has NOT approved any change orders beyond the signed contract scope' },
      ],
    );

    // The unsupported/rejected finding: single ambiguous, low-quality photo
    // with no corroboration. Mandatory-citation-enforcement would still let
    // this THROUGH the code-level filter (it does resolve to a real source),
    // which is exactly why a human reviewer step exists — this is what that
    // review correctly rejects, and it must never appear in a packet.
    await ensureFinding(
      'Possible additional condensate line work near the rooftop unit.',
      { finding_type: 'scope_delta', source_citations: JSON.stringify([{ evidenceItemId: photoAmbiguous.id }]), confidence: 0.31, severity: 'low', ai_generated: true, human_decision: 'rejected', reviewer_id: pm.id, decision_reason: 'Photo is too blurry/distant to confirm what is shown, and there is no corroborating evidence from any other source. Do not include in the packet.' },
      [{ evidenceItemId: photoAmbiguous.id, quotedText: 'not possible to confirm what work, if any, was performed' }],
    );

    // ---- Commercial outcome: identified -> validated -> submitted (project
    // is still mid-flight; invoiced/collected intentionally not reached yet) ----
    const outcome = await (async () => {
      const existing = await prisma.commercialOutcome.findFirst({ where: { orgId: org.id, project_id: project.id, change_event_id: changeEvent.id } });
      if (existing) return existing;
      return prisma.commercialOutcome.create({ data: { orgId: org.id, project_id: project.id, change_event_id: changeEvent.id, userId: pm.id, notes: 'Ductwork + panel scope delta. Contradiction finding pending customer resolution before submission of that portion.' } });
    })();

    const AMOUNT = 1200 + 950; // duct run + panel breaker, reasonable fictional rates — distinct from the original estimate's amounts, deliberately not invented from thin air but grounded in ensureScopeItem-style category pricing
    async function ensureTransition(toStage, amount, actorId, reason) {
      const already = await prisma.stageTransition.findFirst({ where: { orgId: org.id, outcomeId: outcome.id, toStage } });
      if (already) return already;
      const last = await prisma.stageTransition.findFirst({ where: { orgId: org.id, outcomeId: outcome.id }, orderBy: { createdAt: 'desc' } });
      const field = { identified: 'identified_amount', validated: 'validated_amount', submitted: 'submitted_amount' }[toStage];
      await prisma.commercialOutcome.update({ where: { id: outcome.id }, data: { [field]: amount } });
      return prisma.stageTransition.create({ data: { orgId: org.id, outcomeId: outcome.id, fromStage: last ? last.toStage : null, toStage, amount, actorId, reason } });
    }
    await ensureTransition('identified', AMOUNT, pm.id, 'AI-assisted review flagged ductwork and panel scope delta from field evidence.');
    await ensureTransition('validated', AMOUNT, pm.id, 'Project manager confirmed both findings against photo + audio evidence; excluded the low-confidence condensate finding.');
    await ensureTransition('submitted', AMOUNT, pm.id, 'Submitted to customer pending resolution of the verbal-approval contradiction (Section 4.2 requires written change order regardless).');

    // ---- Evidence packet: a real, rendered PDF, explicitly excluding the
    // rejected finding and the still-pending contradiction from the billed total ----
    const packetData = {
      title: '[FICTIONAL DEMO] Change Order Support Packet — Riverside Community Center',
      project: project.name,
      project_number: project.project_number,
      customer: customer.name,
      prepared_by: 'Dana Reyes (Project Manager)',
      executive_summary: 'FICTIONAL DEMO DATA — not a real customer, project, or contract. Field evidence documents two items of work performed beyond the contracted curb-only HVAC reconnect scope: an unauthorized ductwork extension and an electrical panel breaker addition, together totaling $2,150.00. A third item (a disputed verbal change-order approval) is NOT included in this total pending written customer resolution per Contract Section 4.2. A fourth AI-flagged item (possible condensate work) was reviewed and REJECTED for insufficient evidence and is excluded from this packet entirely.',
      included_findings: [
        { id: findingDuctwork.id, assertion: findingDuctwork.assertion, amount: 1200, status: 'supported' },
        { id: findingPanel.id, assertion: findingPanel.assertion, amount: 950, status: 'supported' },
      ],
      excluded_findings: [
        { reason: 'pending customer written resolution (contradiction between verbal approval claim and written denial)' },
        { reason: 'rejected by reviewer — insufficient evidence (single blurry, uncorroborated photo)' },
      ],
      total_potential_amount: AMOUNT,
      sources: [
        `SourceDocument ${contractDoc.id} — riverside-contract.txt`,
        `EvidenceItem ${photoDuct.id} — attic-ductwork.jpg`,
        `EvidenceItem ${photoPanel.id} — electrical-panel.jpg`,
        `EvidenceItem ${audioNote.id} — day2-voice-note.wav (transcript)`,
      ],
      approval: { approver: 'Dana Reyes', timestamp: new Date('2026-03-14T12:00:00Z').toISOString(), reference: 'RVS-2026-001', status: 'approved', notes: 'Fictional demo approval for illustration only.' },
    };
    // pdfPacketRenderer's realRun() is a genuine, dependency-free PDF builder
    // (see lib/tools/pdfpacketrenderer.js) — not a network call — so it's
    // safe and appropriate to force live mode for this one call regardless
    // of the operator's global INTEGRATION_PDFPACKETRENDERER_MODE setting.
    const prevPdfMode = process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
    process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live';
    let rendered;
    try {
      rendered = await pdfPacketRenderer.run(
        { packet_data_json: JSON.stringify(packetData), template_id: 'change-order-support' },
        { orgId: org.id, userId: pm.id },
      );
    } finally {
      if (prevPdfMode === undefined) delete process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
      else process.env.INTEGRATION_PDFPACKETRENDERER_MODE = prevPdfMode;
    }
    let pdfStorageUri = null;
    let contentHash = null;
    if (!rendered._mock && rendered.pdf_bytes) {
      const pdfBuf = Buffer.isBuffer(rendered.pdf_bytes) ? rendered.pdf_bytes : Buffer.from(rendered.pdf_bytes);
      const key = storage.newKey(pm.id, 'riverside-change-order-packet.pdf');
      await storage.putObject({ key, body: pdfBuf, contentType: 'application/pdf' });
      pdfStorageUri = key;
      contentHash = rendered.content_hash || sha256(pdfBuf);
    }

    const packet = await (async () => {
      const existing = await prisma.evidencePacket.findFirst({ where: { orgId: org.id, project_id: project.id, packet_number: 'RVS-2026-001' } });
      const data = {
        orgId: org.id, project_id: project.id, packet_number: 'RVS-2026-001', version: 1, status: 'approved',
        recipient: 'Riverside Community Center — Facilities Director', executive_summary: packetData.executive_summary,
        total_potential_amount: AMOUNT, customer_validated_amount: null,
        pdf_storage_uri: pdfStorageUri, content_hash: contentHash,
        approved_by_id: pm.id, approved_at: new Date('2026-03-14T12:00:00Z'), userId: pm.id,
      };
      if (existing) return prisma.evidencePacket.update({ where: { id: existing.id }, data });
      return prisma.evidencePacket.create({ data });
    })();

    console.log('[riverside-demo] done.');
    console.log(`  org:      ${org.id} (${DEMO_ORG_NAME})`);
    console.log(`  project:  ${project.id} (${project.name})`);
    console.log(`  findings: supported=2 pending=1 rejected=1`);
    console.log(`  packet:   ${packet.id} (${packet.packet_number}) pdf=${pdfStorageUri || '(render skipped — pdfPacketRenderer in mock mode)'}`);
  });
}

main()
  .catch((err) => { console.error('[riverside-demo] failed:', err); process.exitCode = 1; })
  .finally(async () => { try { await prisma.$disconnect(); } catch {} });
