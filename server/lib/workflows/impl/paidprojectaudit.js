'use strict';

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

/**
 * Step 1 (index 1): Create project and record audit tier against project.
 * Parses tier selection from state and builds a project record.
 */
steps[1] = async (state, ctx) => {
  let parsed = {};
  try { parsed = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const tier = parsed.tier || parsed.auditTier || parsed.selectedTier || null;
  const validTiers = { pilot: 99, standard: 249 };

  const resolvedTier = tier && validTiers[String(tier).toLowerCase()]
    ? String(tier).toLowerCase()
    : (parsed.amount === 99 ? 'pilot' : parsed.amount === 249 ? 'standard' : 'unknown');

  const price = validTiers[resolvedTier] || null;

  const projectId = parsed.projectId ||
    `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const project = {
    projectId,
    auditTier: resolvedTier,
    tierPrice: price,
    stripeSessionId: parsed.stripeSessionId || parsed.sessionId || null,
    customerEmail: parsed.customerEmail || parsed.email || null,
    createdAt: new Date().toISOString(),
    status: 'created',
  };

  return JSON.stringify({ ...parsed, project, currentStep: 'project_created' });
};

/**
 * Step 4 (index 4): Run IntakeAgent: classify, deduplicate, flag issues.
 * Deterministically classifies and deduplicates uploaded documents and evidence
 * based on metadata already in state, without calling external services.
 */
steps[4] = async (state, ctx) => {
  let parsed = {};
  try { parsed = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const contractDocs = parsed.contractDocuments || parsed.contracts || [];
  const fieldEvidence = parsed.fieldEvidence || parsed.evidence || [];
  const allFiles = [
    ...contractDocs.map(f => ({ ...f, source: 'contract' })),
    ...fieldEvidence.map(f => ({ ...f, source: 'field' })),
  ];

  // Deduplicate by name+size if available
  const seen = new Set();
  const deduplicated = [];
  const duplicates = [];
  for (const file of allFiles) {
    const key = `${(file.name || file.filename || '').toLowerCase()}::${file.size || 0}`;
    if (seen.has(key)) {
      duplicates.push(file);
    } else {
      seen.add(key);
      deduplicated.push(file);
    }
  }

  // Classify by extension/type heuristics
  const classifyFile = (file) => {
    const name = (file.name || file.filename || '').toLowerCase();
    const mimeType = (file.mimeType || file.type || '').toLowerCase();
    if (/\.(jpg|jpeg|png|gif|heic|webp)$/.test(name) || mimeType.startsWith('image/')) return 'photo';
    if (/\.(mp3|m4a|wav|aac|ogg)$/.test(name) || mimeType.startsWith('audio/')) return 'voice_note';
    if (/receipt/i.test(name)) return 'receipt';
    if (/log/i.test(name)) return 'log';
    if (/message|chat|text/i.test(name)) return 'message';
    if (/\.(pdf)$/.test(name) || mimeType === 'application/pdf') return 'document_pdf';
    if (/\.(docx?|odt)$/.test(name)) return 'document_word';
    if (/\.(xlsx?|csv)$/.test(name)) return 'spreadsheet';
    if (/contract/i.test(name)) return 'contract';
    if (/estimate/i.test(name)) return 'estimate';
    if (/scope/i.test(name)) return 'scope_of_work';
    if (/rate/i.test(name)) return 'rate_sheet';
    return 'unknown';
  };

  const classified = deduplicated.map(file => ({
    ...file,
    classification: file.classification || classifyFile(file),
  }));

  // Flag issues
  const flags = [];
  const expectedContractTypes = ['contract', 'estimate', 'scope_of_work', 'rate_sheet'];
  const foundTypes = new Set(classified.filter(f => f.source === 'contract').map(f => f.classification));
  for (const t of expectedContractTypes) {
    if (!foundTypes.has(t)) {
      flags.push({ type: 'missing_document', detail: `No ${t.replace(/_/g, ' ')} found among contract documents.` });
    }
  }
  if (classified.filter(f => f.source === 'field').length === 0) {
    flags.push({ type: 'missing_evidence', detail: 'No field evidence uploaded.' });
  }
  if (duplicates.length > 0) {
    flags.push({ type: 'duplicates_removed', detail: `${duplicates.length} duplicate file(s) removed.`, duplicates });
  }

  const intakeReport = {
    totalFilesReceived: allFiles.length,
    duplicatesRemoved: duplicates.length,
    filesAfterDedup: classified.length,
    classified,
    flags,
    intakeStatus: flags.some(f => f.type !== 'duplicates_removed') ? 'needs_attention' : 'ok',
  };

  return JSON.stringify({ ...parsed, intakeReport, currentStep: 'intake_complete' });
};

/**
 * Step 7 (index 7): Run ProofAndRiskAgent: surface contradictions and missing evidence.
 * Deterministically cross-references scope delta events against evidence to find gaps.
 */
steps[7] = async (state, ctx) => {
  let parsed = {};
  try { parsed = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const changeEvents = parsed.changeEvents || parsed.scopeDelta || [];
  const evidenceItems = parsed.evidenceItems || parsed.extractedEvidence || [];
  const scopeItems = parsed.scopeItems || parsed.baseline || [];

  // Build a set of evidence references (IDs or descriptions)
  const evidenceRefs = new Set(evidenceItems.map(e => String(e.id || e.ref || e.description || '').toLowerCase()));

  const contradictions = [];
  const missingEvidence = [];

  for (const event of changeEvents) {
    const eventId = String(event.id || event.ref || event.description || '').toLowerCase();
    const hasEvidence = event.evidenceRefs
      ? event.evidenceRefs.some(r => evidenceRefs.has(String(r).toLowerCase()))
      : evidenceRefs.has(eventId);

    if (!hasEvidence) {
      missingEvidence.push({
        changeEventId: event.id || event.ref,
        description: event.description || 'Unknown change event',
        risk: 'high',
        detail: 'No supporting evidence found for this change event.',
      });
    }

    // Check for contradiction: event claims extra work but scope shows exclusion
    const scopeExclusion = scopeItems.find(s =>
      s.type === 'exclusion' &&
      (s.description || '').toLowerCase().includes((event.description || '').toLowerCase().slice(0, 20))
    );
    if (scopeExclusion) {
      contradictions.push({
        changeEventId: event.id || event.ref,
        description: event.description,
        contradictionWith: scopeExclusion.description || scopeExclusion.id,
        detail: 'Change event conflicts with an explicit scope exclusion.',
      });
    }
  }

  // Check for evidence items not linked to any change event
  const linkedEventRefs = new Set(
    changeEvents.flatMap(e => e.evidenceRefs ? e.evidenceRefs.map(r => String(r).toLowerCase()) : [])
  );
  const orphanEvidence = evidenceItems.filter(e => {
    const ref = String(e.id || e.ref || '').toLowerCase();
    return ref && !linkedEventRefs.has(ref);
  });

  const riskSummary = {
    totalChangeEvents: changeEvents.length,
    eventsWithMissingEvidence: missingEvidence.length,
    contradictions: contradictions.length,
    orphanEvidenceItems: orphanEvidence.length,
    overallRisk: missingEvidence.length > 0 || contradictions.length > 0 ? 'elevated' : 'low',
  };

  const proofAndRiskReport = {
    contradictions,
    missingEvidence,
    orphanEvidence,
    riskSummary,
  };

  return JSON.stringify({ ...parsed, proofAndRiskReport, currentStep: 'proof_and_risk_complete' });
};

/**
 * Step 11 (index 11): Mark audit delivered; request consented customer feedback and testimonial.
 * Records delivery timestamp and prepares a feedback request payload.
 */
steps[11] = async (state, ctx) => {
  let parsed = {};
  try { parsed = typeof state === 'string' ? JSON.parse(state) : (state || {}); } catch (_) {}

  const project = parsed.project || {};
  const deliveredAt = new Date().toISOString();

  const auditDelivery = {
    projectId: project.projectId || parsed.projectId || null,
    auditTier: project.auditTier || parsed.auditTier || 'unknown',
    deliveredAt,
    packetUrl: parsed.packetUrl || parsed.approvedPacketUrl || null,
    status: 'delivered',
  };

  const feedbackRequest = {
    customerEmail: project.customerEmail || parsed.customerEmail || parsed.email || null,
    consentRequired: true,
    requestedAt: deliveredAt,
    feedbackFormUrl: parsed.feedbackFormUrl || null,
    testimonialOptIn: false, // must be explicitly consented by customer
    message: [
      'Thank you for choosing ScopeCash AI for your project audit.',
      'We would love to hear about your experience.',
      'If you are willing, please share your feedback and — with your consent — a testimonial.',
      'Your participation is entirely voluntary.',
    ].join(' '),
    consentStatement:
      'By submitting a testimonial, you consent to ScopeCash AI using your feedback for marketing purposes. You may withdraw consent at any time.',
  };

  return JSON.stringify({
    ...parsed,
    auditDelivery,
    feedbackRequest,
    currentStep: 'audit_delivered',
  });
};

module.exports = { realImplemented, steps, workflow: "PaidProjectAudit" };
