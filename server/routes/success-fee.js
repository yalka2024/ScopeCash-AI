/**
 * Success-fee agreement lifecycle for ScopeCash AI.
 *
 * A SuccessFeeAgreement is a real, separately-accepted written-agreement
 * acceptance record (who, when, what rate) authorizing ScopeCash AI to earn
 * a success fee on an org's collected commercial outcomes — see
 * platform-manifest.json's public-adjuster-statute compliance clauses:
 * "Success fee must not be enabled by default and requires separately
 * accepted written agreement." Nothing creates a row here except this
 * explicit, confirmed POST from an org owner/admin, so the feature stays
 * off for every org until that happens. Fee computation itself is handled
 * by lib/success-fee.js from the commercial-outcome stage-transition route
 * (routes/entities.js) — this file only manages accept/list/revoke.
 *
 * Routes:
 *   POST /api/successFeeAgreements              accept a new agreement
 *   GET  /api/successFeeAgreements               list this org's agreements
 *   POST /api/successFeeAgreements/:id/deactivate   revoke an active agreement
 */
const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { requireAnyOrgRole } = require('../lib/roles');
const { z, validate, asyncHandler } = require('../lib/validate');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

const AcceptSchema = z.object({
  ratePercent: z.number().finite().min(0.001).max(0.5),
  // Mirrors routes/setup.js's acceptTos: z.literal(true) — the request is
  // only valid at all if this exact confirmation is present, so acceptance
  // can never happen as a side effect of some other field being set.
  acceptAgreement: z.literal(true),
});

router.post('/', requireAnyOrgRole('owner', 'admin'), validate(AcceptSchema), asyncHandler(async (req, res) => {
  // At most one active agreement per org — re-accepting supersedes the
  // previous rate rather than stacking a second active row.
  await prisma.successFeeAgreement.updateMany({
    where: { orgId: req.tenant.orgId, active: true },
    data: { active: false, deactivatedAt: new Date() },
  });
  const agreement = await prisma.successFeeAgreement.create({
    data: {
      orgId: req.tenant.orgId,
      ratePercent: req.body.ratePercent,
      acceptedAt: new Date(),
      acceptedByUserId: req.user.id,
      active: true,
    },
  });
  await audit(req, 'successFeeAgreements.accept', {
    resource: 'successFeeAgreement', resourceId: agreement.id, details: { ratePercent: agreement.ratePercent },
  });
  res.status(201).json(agreement);
}));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await prisma.successFeeAgreement.findMany({
    where: { orgId: req.tenant.orgId }, orderBy: { createdAt: 'desc' },
  });
  res.json(rows);
}));

router.post('/:id/deactivate', requireAnyOrgRole('owner', 'admin'), asyncHandler(async (req, res) => {
  const agreement = await prisma.successFeeAgreement.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!agreement) return res.status(404).json({ error: 'not_found' });
  if (!agreement.active) return res.json(agreement);

  const updated = await prisma.successFeeAgreement.update({
    where: { id: agreement.id }, data: { active: false, deactivatedAt: new Date() },
  });
  await audit(req, 'successFeeAgreements.deactivate', { resource: 'successFeeAgreement', resourceId: agreement.id });
  res.json(updated);
}));

module.exports = router;
