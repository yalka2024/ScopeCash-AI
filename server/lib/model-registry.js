/**
 * AI/ML model registry (Tier 19 — Governance).
 *
 * Tracks every AI model used by the platform with its risk tier, owner,
 * evaluation results, and approval status. Required for EU AI Act / ISO 42001
 * Annex A.6.2 / NIST AI RMF "Manage" function.
 *
 * Lifecycle:
 *   draft -> in_review -> approved -> retired
 * Only "approved" models may be wired into production code paths.
 */
const prisma = require('./prisma');

const RISK_TIERS = Object.freeze(['minimal', 'limited', 'high', 'unacceptable']);
const STATUSES = Object.freeze(['draft', 'in_review', 'approved', 'retired']);

function _validateRisk(t) { if (!RISK_TIERS.includes(t)) throw new Error('invalid_risk_tier'); }
function _validateStatus(s) { if (!STATUSES.includes(s)) throw new Error('invalid_status'); }

async function register({ name, provider, modelId, version, purpose, riskTier = 'limited', dataInputs = [], dataOutputs = [], ownerId = null, registeredBy = null }) {
  if (!name || !provider || !modelId) throw new Error('args_required');
  _validateRisk(riskTier);
  return prisma.modelRegistration.create({
    data: {
      name: String(name).slice(0, 200),
      provider: String(provider).slice(0, 80),
      modelId: String(modelId).slice(0, 200),
      version: version ? String(version).slice(0, 80) : null,
      purpose: purpose ? String(purpose).slice(0, 1000) : null,
      riskTier,
      status: 'draft',
      dataInputs: JSON.stringify(dataInputs || []),
      dataOutputs: JSON.stringify(dataOutputs || []),
      ownerId,
      registeredBy,
    },
  });
}

async function listModels({ status = null, riskTier = null } = {}) {
  const where = {};
  if (status) where.status = status;
  if (riskTier) where.riskTier = riskTier;
  return prisma.modelRegistration.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }).catch(() => []);
}

async function getModel(id) {
  const row = await prisma.modelRegistration.findUnique({ where: { id } }).catch(() => null);
  if (!row) return null;
  const evals = await prisma.modelEvaluation.findMany({ where: { modelId: id }, orderBy: { runAt: 'desc' }, take: 50 }).catch(() => []);
  return { ...row, dataInputs: _parse(row.dataInputs), dataOutputs: _parse(row.dataOutputs), evaluations: evals };
}

function _parse(s) { try { return JSON.parse(s || '[]'); } catch (_) { return []; } }

async function recordEvaluation(modelId, { suite, metric, score, passed, notes = null, runBy = null }) {
  if (!modelId || !suite || !metric || score == null) throw new Error('args_required');
  return prisma.modelEvaluation.create({
    data: {
      modelId,
      suite: String(suite).slice(0, 80),
      metric: String(metric).slice(0, 80),
      score: Number(score),
      passed: !!passed,
      notes: notes ? String(notes).slice(0, 2000) : null,
      runBy,
    },
  });
}

async function transition(modelId, nextStatus, { actorId = null, comment = null } = {}) {
  _validateStatus(nextStatus);
  const current = await prisma.modelRegistration.findUnique({ where: { id: modelId } });
  if (!current) throw new Error('model_not_found');
  // Approval requires at least one passing evaluation for high-risk models.
  if (nextStatus === 'approved' && current.riskTier === 'high') {
    const passes = await prisma.modelEvaluation.count({ where: { modelId, passed: true } });
    if (passes < 1) throw new Error('high_risk_requires_passing_evaluation');
  }
  await prisma.modelRegistration.update({
    where: { id: modelId },
    data: { status: nextStatus, statusUpdatedAt: new Date(), statusUpdatedBy: actorId, statusComment: comment || null },
  });
  return getModel(modelId);
}

/** Aggregate stats for the governance dashboard. */
async function summary() {
  const all = await prisma.modelRegistration.findMany().catch(() => []);
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  const byRisk = {};
  for (const r of RISK_TIERS) byRisk[r] = 0;
  for (const m of all) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    byRisk[m.riskTier] = (byRisk[m.riskTier] || 0) + 1;
  }
  return { total: all.length, byStatus, byRisk };
}

module.exports = { RISK_TIERS, STATUSES, register, listModels, getModel, recordEvaluation, transition, summary };

