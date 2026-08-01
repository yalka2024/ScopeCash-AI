/**
 * Trust portal API (Tier 18 — Trust-to-revenue).
 *
 * Public:
 *   GET  /api/trust-portal/questions             list canonical Q&A
 *   GET  /api/trust-portal/questions/:id         one Q&A
 *   POST /api/trust-portal/kits/request          prospect intake (rate limited)
 *   GET  /api/trust-portal/kits/download         download kit (?token=...)
 *   GET  /api/trust-portal/one-pager             public sales-enablement summary
 *
 * Admin:
 *   GET    /api/trust-portal/admin/kits          list all kit requests
 *   POST   /api/trust-portal/admin/kits/:id/approve
 *   POST   /api/trust-portal/admin/kits/:id/reject
 *   GET    /api/trust-portal/admin/overrides     list questionnaire overrides
 *   PUT    /api/trust-portal/admin/overrides/:questionId
 *   DELETE /api/trust-portal/admin/overrides/:questionId
 */
const express = require('express');
const limiters = require('../lib/ratelimit');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const bank = require('../lib/questionnaire-bank');
const kits = require('../lib/vendor-kits');
const { z, validate, asyncHandler } = require('../lib/validate');

const router = express.Router();

// ---- Public ----
router.get('/questions', asyncHandler(async (req, res) => {
  const framework = req.query.framework || null;
  const section = req.query.section || null;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    frameworks: bank.frameworks(),
    sections: bank.sections(framework),
    questions: bank.listQuestions({ framework, section }),
  });
}));

router.get('/questions/:id', asyncHandler(async (req, res) => {
  const q = bank.getQuestion(req.params.id);
  if (!q) return res.status(404).json({ error: 'Unknown question', code: 'not_found' });
  res.set('Cache-Control', 'public, max-age=300');
  res.json(q);
}));

router.get('/one-pager', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json({
    platform: 'ScopeCash AI',
    summary: 'ScopeCash AI is a multi-tenant SaaS platform. Customer data is encrypted at rest (AES-256) and in transit (TLS 1.2+). MFA-protected admin access. Annual pen test by an independent firm. Sub-processors disclosed. Self-serve data deletion. AI provider opt-out from training.',
    posture: {
      encryption: 'AES-256 at rest, TLS 1.2+ in transit',
      mfa: 'TOTP and WebAuthn for admin and customers',
      penTesting: 'Annual third-party',
      backups: 'Daily, encrypted, 35-day retention',
      dataDeletion: 'Self-serve in product; 35-day backup purge',
      aiTraining: 'Opted out at all AI providers',
    },
    links: {
      trustSummary: '/api/trust/summary',
      compliancePack: '/api/trust/pack',
      questions: '/api/trust-portal/questions',
      requestKit: '/api/trust-portal/kits/request',
    },
  });
}));

const RequestSchema = z.object({
  prospectName: z.string().max(120).optional(),
  prospectCompany: z.string().max(200).optional(),
  prospectEmail: z.string().email().max(200),
  message: z.string().max(2000).optional(),
});
// Rate limited for real. This is UNAUTHENTICATED and writes a database row
// plus captures an email; with AUTO_APPROVE_TRUST_KITS=1 it also mints a
// download token in that same anonymous call. The docblock claimed
// "(rate limited)" while no limiter was mounted — on a public repo that is
// the cheapest abuse target in the app.
router.post('/kits/request', limiters.expensive, validate(RequestSchema), asyncHandler(async (req, res) => {
  const kit = await kits.requestKit({
    prospectName: req.body.prospectName || null,
    prospectCompany: req.body.prospectCompany || null,
    prospectEmail: req.body.prospectEmail,
    message: req.body.message || null,
  });
  // Auto-approve if env says so (for self-serve kits).
  if (process.env.AUTO_APPROVE_TRUST_KITS === '1') {
    const { token } = await kits.approveKit(kit.id);
    return res.status(201).json({ id: kit.id, status: 'approved', downloadUrl: `/api/trust-portal/kits/download?token=${token}` });
  }
  res.status(201).json({ id: kit.id, status: 'requested', message: 'Your request has been received and will be reviewed shortly.' });
}));

router.get('/kits/download', asyncHandler(async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token', code: 'missing_token' });
  const kit = await kits.findByToken(String(token));
  if (!kit) return res.status(404).json({ error: 'Invalid or expired token', code: 'invalid_token' });
  await kits.streamKit(kit, res);
}));

// ---- Admin ----
const admin = express.Router();
admin.use(authMiddleware);
admin.use(attachTenant);
admin.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

admin.get('/kits', asyncHandler(async (req, res) => {
  const status = req.query.status || null;
  res.json({ kits: await kits.listKits({ status }) });
}));

const ApproveSchema = z.object({
  ttlDays: z.number().int().min(1).max(180).optional(),
  maxDownloads: z.number().int().min(1).max(1000).optional(),
});
admin.post('/kits/:id/approve', validate(ApproveSchema), asyncHandler(async (req, res) => {
  const result = await kits.approveKit(req.params.id, {
    ttlDays: req.body.ttlDays,
    maxDownloads: req.body.maxDownloads,
    approvedBy: req.user.id,
  });
  res.json({
    token: result.token,
    expiresAt: result.expiresAt,
    downloadUrl: `/api/trust-portal/kits/download?token=${result.token}`,
  });
}));

const RejectSchema = z.object({ reason: z.string().max(500).optional() });
admin.post('/kits/:id/reject', validate(RejectSchema), asyncHandler(async (req, res) => {
  await kits.rejectKit(req.params.id, { reason: req.body.reason || null, rejectedBy: req.user.id });
  res.json({ ok: true });
}));

admin.get('/overrides', asyncHandler(async (req, res) => {
  const orgId = req.tenant && req.tenant.orgId;
  if (!orgId) return res.json({ overrides: [] });
  const rows = await bank.answersFor({ orgId });
  res.json({ overrides: rows.filter(r => r.source === 'override') });
}));

const OverrideSchema = z.object({ answer: z.string().min(1).max(8000) });
admin.put('/overrides/:questionId', validate(OverrideSchema), asyncHandler(async (req, res) => {
  const orgId = req.tenant && req.tenant.orgId;
  if (!orgId) return res.status(400).json({ error: 'No org context', code: 'no_org' });
  const row = await bank.upsertOverride(orgId, req.params.questionId, req.body.answer);
  res.json(row);
}));

admin.delete('/overrides/:questionId', asyncHandler(async (req, res) => {
  const orgId = req.tenant && req.tenant.orgId;
  if (!orgId) return res.status(400).json({ error: 'No org context', code: 'no_org' });
  await bank.deleteOverride(orgId, req.params.questionId);
  res.json({ ok: true });
}));

router.use('/admin', admin);

module.exports = router;

