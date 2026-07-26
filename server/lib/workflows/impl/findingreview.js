'use strict';

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

/**
 * Helper: safely parse state as JSON, returning {} on failure.
 */
function parseState(state) {
  if (!state) return {};
  if (typeof state === 'object') return state;
  try {
    return JSON.parse(state);
  } catch (_) {
    return { raw: state };
  }
}

/**
 * Step 0: Display plain-language assertion, why identified, and confidence/risk level.
 * Formats the finding's core assertion into a human-readable review card.
 */
steps[0] = async (state, ctx) => {
  const s = parseState(state);
  const finding = s.finding || {};

  const assertion = finding.assertion || finding.summary || '(No assertion provided)';
  const whyIdentified = finding.rationale || finding.why || '(No rationale provided)';
  const confidence = finding.confidence != null ? finding.confidence : 'N/A';
  const riskLevel = finding.riskLevel || finding.risk || 'Unknown';

  const confidencePct = typeof confidence === 'number'
    ? `${Math.round(confidence * 100)}%`
    : confidence;

  const display = {
    step: 'assertion_overview',
    assertionCard: {
      assertion,
      whyIdentified,
      confidence: confidencePct,
      riskLevel: riskLevel.toString().toUpperCase(),
    },
  };

  return Object.assign({}, s, { display });
};

/**
 * Step 1: Show original-scope citation, field-evidence citations, and contract provision reference.
 * Formats citations into a structured evidence panel.
 */
steps[1] = async (state, ctx) => {
  const s = parseState(state);
  const finding = s.finding || {};

  const scopeCitation = finding.scopeCitation || finding.originalScope || null;
  const fieldEvidence = Array.isArray(finding.fieldEvidenceCitations)
    ? finding.fieldEvidenceCitations
    : finding.fieldEvidence
      ? [finding.fieldEvidence]
      : [];
  const contractProvision = finding.contractProvision || finding.contractRef || null;

  const citationsPanel = {
    step: 'citations_panel',
    scopeCitation: scopeCitation || '(No original-scope citation)',
    fieldEvidenceCitations: fieldEvidence.length > 0
      ? fieldEvidence
      : ['(No field-evidence citations)'],
    contractProvision: contractProvision || '(No contract provision reference)',
  };

  return Object.assign({}, s, { citationsPanel });
};

/**
 * Step 2: Display contradictions and missing-evidence list from ProofAndRiskAgent.
 * Surfaces risk flags that require human attention.
 */
steps[2] = async (state, ctx) => {
  const s = parseState(state);
  const finding = s.finding || {};
  const proofRisk = s.proofAndRisk || finding.proofAndRisk || {};

  const contradictions = Array.isArray(proofRisk.contradictions)
    ? proofRisk.contradictions
    : [];
  const missingEvidence = Array.isArray(proofRisk.missingEvidence)
    ? proofRisk.missingEvidence
    : [];

  const riskFlags = {
    step: 'risk_flags',
    contradictions: contradictions.length > 0
      ? contradictions
      : ['(None identified)'],
    missingEvidence: missingEvidence.length > 0
      ? missingEvidence
      : ['(None identified)'],
    hasHighRiskFlags: contradictions.length > 0 || missingEvidence.length > 0,
  };

  return Object.assign({}, s, { riskFlags });
};

/**
 * Step 3: Show suggested cost items with rate source.
 * Formats the cost suggestion table for reviewer inspection.
 */
steps[3] = async (state, ctx) => {
  const s = parseState(state);
  const finding = s.finding || {};

  const rawItems = Array.isArray(finding.suggestedCostItems)
    ? finding.suggestedCostItems
    : finding.costItems
      ? finding.costItems
      : [];

  const costItems = rawItems.map((item, idx) => ({
    index: idx + 1,
    description: item.description || item.desc || `Item ${idx + 1}`,
    quantity: item.quantity != null ? item.quantity : 1,
    unit: item.unit || 'EA',
    unitCost: item.unitCost != null ? item.unitCost : 0,
    totalCost: item.totalCost != null
      ? item.totalCost
      : (item.quantity || 1) * (item.unitCost || 0),
    rateSource: item.rateSource || item.source || '(No rate source specified)',
  }));

  const totalEstimate = costItems.reduce((sum, i) => sum + (i.totalCost || 0), 0);

  const costPanel = {
    step: 'cost_panel',
    costItems: costItems.length > 0 ? costItems : [{ description: '(No cost items suggested)' }],
    totalEstimate,
  };

  return Object.assign({}, s, { costPanel });
};

/**
 * Step 5: Require mandatory decision reason when overriding a high-risk warning.
 * Validates that a reason is present when the reviewer overrides a high-risk finding.
 * (Step 4 — reviewer UI interaction — is left to runtime/human action.)
 */
steps[5] = async (state, ctx) => {
  const s = parseState(state);
  const decision = s.reviewDecision || {};
  const riskFlags = s.riskFlags || {};
  const finding = s.finding || {};

  const riskLevel = (finding.riskLevel || finding.risk || '').toString().toUpperCase();
  const isHighRisk = riskLevel === 'HIGH' || riskFlags.hasHighRiskFlags === true;
  const action = (decision.action || '').toString().toUpperCase();
  const isOverride = action === 'REJECT' || action === 'EDIT';
  const reason = (decision.reason || '').trim();

  let validationResult = {
    step: 'decision_validation',
    requiresReason: isHighRisk && isOverride,
    reasonProvided: reason.length > 0,
    valid: true,
    validationMessage: null,
  };

  if (isHighRisk && isOverride && reason.length === 0) {
    validationResult.valid = false;
    validationResult.validationMessage =
      'A mandatory reason is required when overriding a high-risk warning.';
  } else if (isHighRisk && isOverride) {
    validationResult.validationMessage =
      'High-risk override reason recorded.';
  } else {
    validationResult.validationMessage = 'Validation passed.';
  }

  return Object.assign({}, s, { validationResult });
};

/**
 * Step 6: Record human decision, reviewer ID, timestamp, and any corrections in AgentRun.
 * Assembles the final audit record for persistence.
 */
steps[6] = async (state, ctx) => {
  const s = parseState(state);
  const decision = s.reviewDecision || {};
  const validationResult = s.validationResult || {};

  if (validationResult.requiresReason && !validationResult.valid) {
    return Object.assign({}, s, {
      auditRecord: null,
      auditError: validationResult.validationMessage || 'Validation failed; record not saved.',
    });
  }

  const reviewerId = decision.reviewerId
    || (ctx && ctx.userId)
    || (ctx && ctx.reviewerId)
    || 'unknown-reviewer';

  const timestamp = new Date().toISOString();

  const auditRecord = {
    step: 'audit_record',
    workflowName: 'FindingReview',
    findingId: (s.finding && s.finding.id) || s.findingId || null,
    reviewerId,
    timestamp,
    decision: {
      action: decision.action || null,
      reason: decision.reason || null,
      corrections: decision.corrections || null,
    },
    snapshot: {
      assertionCard: s.display ? s.display.assertionCard : null,
      citationsPanel: s.citationsPanel || null,
      riskFlags: s.riskFlags || null,
      costPanel: s.costPanel || null,
    },
    recorded: true,
  };

  return Object.assign({}, s, { auditRecord });
};

module.exports = { realImplemented, steps, workflow: "FindingReview" };
