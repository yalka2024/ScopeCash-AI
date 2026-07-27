/**
 * Success-fee computation for the six-stage commercial-outcome ledger
 * (routes/entities.js's /commercialOutcomes/:id/transition).
 *
 * Fails closed by design, per platform-manifest.json's public-adjuster-
 * statute compliance clauses: a fee is only ever recorded when BOTH (a) the
 * org has an active SuccessFeeAgreement (a real acceptance record — see
 * routes/success-fee.js — never a silently-flippable config flag, so this
 * is off for every org until an owner/admin explicitly accepts one) and
 * (b) the outcome's payer_type has been explicitly set to 'customer'
 * (never on null/unset/'insurance', so an outcome nobody has categorized
 * yet never earns a fee by default).
 */

function computeSuccessFee(collectedAmount, ratePercent) {
  return Math.round(collectedAmount * ratePercent * 100) / 100;
}

/**
 * Called inside the same tenantTransaction as the StageTransition write,
 * only when toStage === 'collected'. Returns the created EarnedRevenueEvent,
 * or null if no fee applies. `transition` must already be persisted (has an
 * `id`) since EarnedRevenueEvent.stageTransitionId is a required FK.
 */
async function maybeRecordEarnedRevenue(tx, { orgId, outcome, transition, collectedAmount }) {
  if (outcome.payer_type !== 'customer') return null;
  const agreement = await tx.successFeeAgreement.findFirst({ where: { orgId, active: true } });
  if (!agreement) return null;

  const feeAmount = computeSuccessFee(collectedAmount, agreement.ratePercent);
  return tx.earnedRevenueEvent.create({
    data: {
      orgId,
      commercialOutcomeId: outcome.id,
      stageTransitionId: transition.id,
      successFeeAgreementId: agreement.id,
      collectedAmount,
      ratePercent: agreement.ratePercent,
      feeAmount,
    },
  });
}

module.exports = { computeSuccessFee, maybeRecordEarnedRevenue };
