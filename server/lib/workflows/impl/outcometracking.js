'use strict';

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

/**
 * Helpers
 */
function parseState(state) {
  if (!state) return {};
  if (typeof state === 'object') return state;
  try { return JSON.parse(state); } catch { return {}; }
}

function isoNow() {
  return new Date().toISOString();
}

function toMoney(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function pushHistory(record, entry) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push({ ...entry, recordedAt: isoNow() });
}

// Step 0 – Record customer-validated amount with evidence upload
steps[0] = async (state, ctx) => {
  const s = parseState(state);

  const validatedAmount = toMoney(
    ctx && ctx.validatedAmount != null ? ctx.validatedAmount :
    s.validatedAmount != null ? s.validatedAmount : 0
  );
  const evidenceRef = (ctx && ctx.evidenceRef) || s.evidenceRef || null;

  const entry = {
    stage: 'customer_validated',
    validatedAmount,
    evidenceRef,
  };

  pushHistory(s, entry);

  s.stages = s.stages || {};
  s.stages.customerValidated = {
    amount: validatedAmount,
    evidenceRef,
    recordedAt: isoNow(),
  };

  return JSON.stringify(s);
};

// Step 1 – Record submitted amount and submission date
steps[1] = async (state, ctx) => {
  const s = parseState(state);

  const submittedAmount = toMoney(
    ctx && ctx.submittedAmount != null ? ctx.submittedAmount :
    s.submittedAmount != null ? s.submittedAmount : 0
  );
  const submissionDate = (ctx && ctx.submissionDate) || s.submissionDate || isoNow();

  const entry = {
    stage: 'submitted',
    submittedAmount,
    submissionDate,
  };

  pushHistory(s, entry);

  s.stages = s.stages || {};
  s.stages.submitted = {
    amount: submittedAmount,
    submissionDate,
    recordedAt: isoNow(),
  };

  return JSON.stringify(s);
};

// Step 2 – Record approved or partially approved amount with approval evidence
steps[2] = async (state, ctx) => {
  const s = parseState(state);

  const approvedAmount = toMoney(
    ctx && ctx.approvedAmount != null ? ctx.approvedAmount :
    s.approvedAmount != null ? s.approvedAmount : 0
  );
  const approvalStatus = (ctx && ctx.approvalStatus) || s.approvalStatus || 'approved';
  const approvalEvidenceRef = (ctx && ctx.approvalEvidenceRef) || s.approvalEvidenceRef || null;

  const validApprovalStatuses = ['approved', 'partially_approved', 'rejected'];
  const normalizedStatus = validApprovalStatuses.includes(approvalStatus)
    ? approvalStatus
    : 'approved';

  const entry = {
    stage: 'approved',
    approvedAmount,
    approvalStatus: normalizedStatus,
    approvalEvidenceRef,
  };

  pushHistory(s, entry);

  s.stages = s.stages || {};
  s.stages.approved = {
    amount: approvedAmount,
    status: normalizedStatus,
    approvalEvidenceRef,
    recordedAt: isoNow(),
  };

  return JSON.stringify(s);
};

// Step 3 – Record invoice number, invoice date, and invoiced amount
steps[3] = async (state, ctx) => {
  const s = parseState(state);

  const invoiceNumber = (ctx && ctx.invoiceNumber) || s.invoiceNumber || '';
  const invoiceDate = (ctx && ctx.invoiceDate) || s.invoiceDate || isoNow();
  const invoicedAmount = toMoney(
    ctx && ctx.invoicedAmount != null ? ctx.invoicedAmount :
    s.invoicedAmount != null ? s.invoicedAmount : 0
  );

  const entry = {
    stage: 'invoiced',
    invoiceNumber,
    invoiceDate,
    invoicedAmount,
  };

  pushHistory(s, entry);

  s.stages = s.stages || {};
  s.stages.invoiced = {
    invoiceNumber,
    invoiceDate,
    amount: invoicedAmount,
    recordedAt: isoNow(),
  };

  return JSON.stringify(s);
};

// Step 4 – Record payment date and collected amount with payment evidence
steps[4] = async (state, ctx) => {
  const s = parseState(state);

  const paymentDate = (ctx && ctx.paymentDate) || s.paymentDate || isoNow();
  const collectedAmount = toMoney(
    ctx && ctx.collectedAmount != null ? ctx.collectedAmount :
    s.collectedAmount != null ? s.collectedAmount : 0
  );
  const paymentEvidenceRef = (ctx && ctx.paymentEvidenceRef) || s.paymentEvidenceRef || null;

  const entry = {
    stage: 'collected',
    paymentDate,
    collectedAmount,
    paymentEvidenceRef,
  };

  pushHistory(s, entry);

  s.stages = s.stages || {};
  s.stages.collected = {
    paymentDate,
    amount: collectedAmount,
    paymentEvidenceRef,
    recordedAt: isoNow(),
  };

  return JSON.stringify(s);
};

// Step 5 – Display conversion funnel showing all six stages; preserve full change history
steps[5] = async (state, ctx) => {
  const s = parseState(state);
  const stages = s.stages || {};

  // Funnel stages in order (6 total: validated, submitted, approved, invoiced, collected + a "won" summary)
  const funnelStages = [
    {
      label: 'Customer Validated',
      key: 'customerValidated',
      amount: (stages.customerValidated && stages.customerValidated.amount) || 0,
    },
    {
      label: 'Submitted',
      key: 'submitted',
      amount: (stages.submitted && stages.submitted.amount) || 0,
    },
    {
      label: 'Approved',
      key: 'approved',
      amount: (stages.approved && stages.approved.amount) || 0,
      status: (stages.approved && stages.approved.status) || null,
    },
    {
      label: 'Invoiced',
      key: 'invoiced',
      amount: (stages.invoiced && stages.invoiced.amount) || 0,
      invoiceNumber: (stages.invoiced && stages.invoiced.invoiceNumber) || null,
    },
    {
      label: 'Collected',
      key: 'collected',
      amount: (stages.collected && stages.collected.amount) || 0,
    },
    {
      label: 'Net Outcome (Collected vs Validated)',
      key: 'netOutcome',
      amount: (stages.collected && stages.collected.amount) || 0,
      reference: (stages.customerValidated && stages.customerValidated.amount) || 0,
      conversionRate: (() => {
        const validated = (stages.customerValidated && stages.customerValidated.amount) || 0;
        const collected = (stages.collected && stages.collected.amount) || 0;
        if (validated === 0) return null;
        return Math.round((collected / validated) * 10000) / 100; // percentage, 2 dp
      })(),
    },
  ];

  // Compute per-stage conversion rates relative to first stage
  const baseAmount = funnelStages[0].amount || 0;
  const enriched = funnelStages.map(stage => ({
    ...stage,
    conversionVsValidated: baseAmount > 0
      ? Math.round((stage.amount / baseAmount) * 10000) / 100
      : null,
  }));

  const funnel = {
    generatedAt: isoNow(),
    funnelStages: enriched,
    history: Array.isArray(s.history) ? s.history : [],
  };

  // Merge back into state so history is preserved
  s.funnel = funnel;

  return JSON.stringify(s);
};

module.exports = { realImplemented, steps, workflow: "OutcomeTracking" };
