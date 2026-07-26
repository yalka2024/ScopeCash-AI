/**
 * EU AI Act — Conformity Assessment Workflow (Article 43)
 *
 * For high-risk AI systems, providers must demonstrate conformity with the
 * requirements of Articles 8–15 BEFORE placing the system on the market.
 * Article 43 lets providers self-assess (internal control, Annex VI) for most
 * Annex III categories.
 *
 * This module:
 *   • Builds the canonical Article 43 / Annex VI checklist (template)
 *   • Initialises an assessment for a record (status=draft)
 *   • Updates item statuses + evidence text
 *   • Computes overall completeness + readiness verdict
 *   • Records signature/attestation (provider declaration)
 *
 * State is stored in the record's `conformityJson` column as a single JSON
 * blob (no schema joins required).
 */

const VERSION = '1.0.0';
const STATUSES = ['not_started', 'in_progress', 'satisfied', 'not_applicable', 'failed'];

/* -------------------------------------------------------------------------- */
/*  Canonical checklist                                                       */
/* -------------------------------------------------------------------------- */

const CHECKLIST = [
  // Article 9 — Risk management system
  { article: '9', section: 'Risk management',
    items: [
      { id: 'rms-1', q: 'Have you established a continuous, iterative risk management system covering the entire lifecycle?' },
      { id: 'rms-2', q: 'Have you identified and analysed known and reasonably foreseeable risks to health, safety, and fundamental rights?' },
      { id: 'rms-3', q: 'Have you estimated and evaluated risks that may emerge from intended use AND reasonably foreseeable misuse?' },
      { id: 'rms-4', q: 'Have you adopted appropriate, targeted risk management measures and tested them?' },
      { id: 'rms-5', q: 'Have you communicated residual risks to deployers in the instructions for use?' },
    ]},

  // Article 10 — Data and data governance
  { article: '10', section: 'Data & data governance',
    items: [
      { id: 'data-1', q: 'Are training, validation, and testing data sets relevant, sufficiently representative, and as free of errors as possible?' },
      { id: 'data-2', q: 'Have you applied data governance practices for collection, origin, preparation, and labelling?' },
      { id: 'data-3', q: 'Have you examined the data sets for possible biases that could affect health, safety, or discrimination?' },
      { id: 'data-4', q: 'Have you taken appropriate measures to detect, prevent, and mitigate such biases?' },
      { id: 'data-5', q: 'If processing special-category personal data for bias correction, do you have legal basis under GDPR Art. 9 and apply Art. 10(5) safeguards?' },
    ]},

  // Article 11 — Technical documentation
  { article: '11', section: 'Technical documentation',
    items: [
      { id: 'docs-1', q: 'Have you drawn up the technical documentation BEFORE placing the system on the market?' },
      { id: 'docs-2', q: 'Does the documentation contain all the elements set out in Annex IV?' },
      { id: 'docs-3', q: 'Will the documentation be kept up to date for 10 years after the system is placed on the market?' },
    ]},

  // Article 12 — Record-keeping (logs)
  { article: '12', section: 'Record-keeping & logging',
    items: [
      { id: 'logs-1', q: 'Does the system technically allow the automatic recording of events ("logs") over its lifetime?' },
      { id: 'logs-2', q: 'Do logs ensure traceability of the system\'s functioning at a level appropriate to the intended purpose?' },
      { id: 'logs-3', q: 'Are logs retained by the deployer for at least 6 months (or longer per other Union/Member State law)?' },
    ]},

  // Article 13 — Transparency & information
  { article: '13', section: 'Transparency to deployers',
    items: [
      { id: 'trans-1', q: 'Is the system designed and developed so its operation is sufficiently transparent for deployers to interpret outputs?' },
      { id: 'trans-2', q: 'Have you provided clear, complete, accurate, and unambiguous instructions for use?' },
      { id: 'trans-3', q: 'Do the instructions cover the system\'s intended purpose, accuracy/robustness/cybersecurity levels, foreseeable misuse, and human oversight measures?' },
    ]},

  // Article 14 — Human oversight
  { article: '14', section: 'Human oversight',
    items: [
      { id: 'human-1', q: 'Is the system designed to be effectively overseen by natural persons during use?' },
      { id: 'human-2', q: 'Can the deployer (i) understand the capabilities and limitations, (ii) monitor operation, and (iii) decide not to use or to disregard the output?' },
      { id: 'human-3', q: 'Can the deployer intervene or interrupt the system\'s operation through a "stop" button or similar mechanism?' },
      { id: 'human-4', q: 'For remote biometric identification: does any action only happen after at least two natural persons verify the result? (where required)' },
    ]},

  // Article 15 — Accuracy, robustness, cybersecurity
  { article: '15', section: 'Accuracy, robustness & cybersecurity',
    items: [
      { id: 'acc-1', q: 'Have you declared the relevant accuracy metrics and the levels actually achieved (in the instructions for use)?' },
      { id: 'acc-2', q: 'Is the system resilient to errors, faults, inconsistencies, and attempts by unauthorised third parties to alter use or performance?' },
      { id: 'acc-3', q: 'Have you taken measures to mitigate possible biased outputs influencing future input ("feedback loops")?' },
      { id: 'acc-4', q: 'Have you taken cybersecurity measures appropriate to the relevant circumstances and risks (e.g. data poisoning, adversarial examples, model leakage)?' },
    ]},

  // Article 17 — Quality management system (provider obligation)
  { article: '17', section: 'Quality management system',
    items: [
      { id: 'qms-1', q: 'Have you put in place a written, documented quality management system covering the entire lifecycle?' },
      { id: 'qms-2', q: 'Does the QMS cover regulatory compliance strategy, design control, data management, risk management, and post-market monitoring?' },
    ]},

  // Article 47 — EU declaration of conformity
  { article: '47', section: 'EU Declaration of Conformity',
    items: [
      { id: 'doc-1', q: 'Have you drawn up a written EU declaration of conformity in accordance with Annex V?' },
      { id: 'doc-2', q: 'Is the declaration kept at the disposal of national competent authorities for 10 years after market placement?' },
    ]},

  // Article 49 — Registration in EU database
  { article: '49', section: 'EU database registration',
    items: [
      { id: 'reg-1', q: 'Have you (or your authorised representative) registered the system in the EU database BEFORE placing it on the market?' },
    ]},

  // Article 72 — Post-market monitoring
  { article: '72', section: 'Post-market monitoring',
    items: [
      { id: 'pm-1', q: 'Have you established and documented a post-market monitoring system proportionate to the nature and risks of the system?' },
      { id: 'pm-2', q: 'Will the system actively and systematically collect and analyse data from deployers about its performance throughout its lifetime?' },
    ]},

  // Article 73 — Incident reporting
  { article: '73', section: 'Serious incident reporting',
    items: [
      { id: 'inc-1', q: 'Do you have procedures to report serious incidents to the market surveillance authority within the Article 73 deadlines (15 days, or 2/10 days for specific cases)?' },
    ]},
];

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

function buildTemplate() {
  const sections = CHECKLIST.map(s => ({
    article: s.article,
    section: s.section,
    items: s.items.map(it => ({
      id: it.id,
      question: it.q,
      status: 'not_started',
      evidence: '',
      updatedAt: null,
    })),
  }));
  return {
    version: VERSION,
    status: 'draft',
    route: 'internal_control_annex_vi', // most Annex III high-risk follow this
    sections,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    signedAt: null,
    signedBy: null,
    signatureName: null,
    signatureRole: null,
  };
}

function summarise(state) {
  let total = 0, satisfied = 0, na = 0, failed = 0, inProgress = 0;
  for (const sec of state.sections) {
    for (const it of sec.items) {
      total++;
      if (it.status === 'satisfied')      satisfied++;
      else if (it.status === 'not_applicable') na++;
      else if (it.status === 'failed')    failed++;
      else if (it.status === 'in_progress') inProgress++;
    }
  }
  const decided = satisfied + na + failed;
  const ready   = failed === 0 && (satisfied + na) === total;
  return {
    total,
    satisfied, notApplicable: na, failed, inProgress,
    notStarted: total - decided - inProgress,
    completionPercentage: total ? Math.round((decided / total) * 100) : 0,
    readyForAttestation: ready,
    blockingFailures: failed,
  };
}

function updateItem(state, itemId, patch) {
  for (const sec of state.sections) {
    for (const it of sec.items) {
      if (it.id !== itemId) continue;
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) {
          throw new Error(`Invalid status "${patch.status}". Allowed: ${STATUSES.join(', ')}`);
        }
        it.status = patch.status;
      }
      if (patch.evidence !== undefined) {
        it.evidence = String(patch.evidence).slice(0, 4000);
      }
      it.updatedAt = new Date().toISOString();
      state.updatedAt = it.updatedAt;
      return it;
    }
  }
  throw new Error(`Item "${itemId}" not found`);
}

function attest(state, { signedBy, signatureName, signatureRole }) {
  const summary = summarise(state);
  if (!summary.readyForAttestation) {
    const e = new Error(`Cannot attest: ${summary.failed} failure(s), ${summary.total - summary.satisfied - summary.notApplicable} item(s) still open.`);
    e.code = 'not_ready';
    throw e;
  }
  state.status = 'attested';
  state.signedAt = new Date().toISOString();
  state.completedAt = state.signedAt;
  state.signedBy = signedBy;
  state.signatureName = signatureName;
  state.signatureRole = signatureRole;
  return state;
}

module.exports = {
  VERSION, STATUSES, CHECKLIST,
  buildTemplate, summarise, updateItem, attest,
};

