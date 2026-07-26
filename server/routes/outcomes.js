/**
 * Outcome-based billing routes for ScopeCash AI.
 * Record confirmed business outcomes (metered to Stripe) and read the summary.
 */
const express = require('express');
const { authMiddleware, requireScope } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const outcomes = require('../lib/outcomes');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

// GET /api/outcomes — billing model, billable events, and per-event counts.
router.get('/', requireScope('read'), asyncHandler(async (req, res) => {
  res.json(outcomes.summary(req.user.orgId));
}));

const RecordSchema = z.object({
  event: z.string().min(1).max(128),
  quantity: z.number().int().min(1).max(100000).optional(),
  success: z.boolean().optional(),       // verification hook: only successes bill
  outcomeId: z.string().max(128).optional(),
  metadata: z.record(z.any()).optional(),
});

// POST /api/outcomes/record — record a business outcome; bills only if successful.
router.post('/record', requireScope('write'), validate(RecordSchema),
  asyncHandler(async (req, res) => {
    if (!outcomes.isBillable(req.body.event)) {
      throw new HttpError(400, `Not a billable outcome: ${req.body.event}`, 'event_not_billable',
        { billable: outcomes.billableEvents() });
    }
    const ctx = { orgId: req.user.orgId, userId: req.user.id, outcomeId: req.body.outcomeId };
    const result = await outcomes.recordOutcome(ctx, req.body.event, {
      quantity: req.body.quantity, success: req.body.success !== false, metadata: req.body.metadata,
    });
    await audit(req, 'billing.outcome.record', { details: { event: req.body.event, billed: result.billed, quantity: req.body.quantity || 1 } });
    res.status(result.billed ? 201 : 200).json(result);
  }));

module.exports = router;

