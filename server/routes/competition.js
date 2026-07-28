/**
 * Competition Evidence Center — platform-admin-only report for a startup-
 * competition submission. Gated on the platform-level admin flag
 * (req.user.role === 'admin'), same as routes/tenants.js and routes/ai-admin.js,
 * not per-org role — this reports on the whole business, not one tenant.
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const competition = require('../lib/competition-evidence');
const pdfPacketRenderer = require('../lib/tools/pdfpacketrenderer');

const router = express.Router();
router.use(authMiddleware);
// attachTenant resolves the org + plan and establishes runWithOrg (RLS
// context on Postgres). It is also where api_calls_per_month is counted, so a
// router that skips it is invisible to that quota — see middleware/tenant.js.
router.use(attachTenant);
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const PeriodQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}$/).optional() });

function resolvePeriod(req) {
  const from = req.query.from || currentPeriod();
  const to = req.query.to || from;
  return { from, to };
}

router.get('/report', validate(PeriodQuery, 'query'), asyncHandler(async (req, res) => {
  const { from, to } = resolvePeriod(req);
  res.json(await competition.buildReport(from, to));
}));

router.get('/report.csv', validate(PeriodQuery, 'query'), asyncHandler(async (req, res) => {
  const { from, to } = resolvePeriod(req);
  const report = await competition.buildReport(from, to);
  const lines = ['period,arms_length_cents,related_party_cents,ai_spend_ucents,ai_requests'];
  for (const r of report.revenue) {
    const exp = report.expense.find((e) => e.period === r.period) || { ai_spend_ucents: 0, requests: 0 };
    lines.push(`${r.period},${r.arms_length_cents},${r.related_party_cents},${exp.ai_spend_ucents},${exp.requests}`);
  }
  await audit(req, 'competition.export.csv', { details: { from, to } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="competition-evidence.csv"');
  res.send(lines.join('\n'));
}));

router.get('/report.pdf', validate(PeriodQuery, 'query'), asyncHandler(async (req, res) => {
  const { from, to } = resolvePeriod(req);
  const report = await competition.buildReport(from, to);
  const prevMode = process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
  process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live';
  let rendered;
  try {
    rendered = await pdfPacketRenderer.run(
      { packet_data_json: JSON.stringify(report), template_id: 'competition-evidence' },
      { orgId: req.user.orgId || 'platform', userId: req.user.id },
    );
  } finally {
    if (prevMode === undefined) delete process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
    else process.env.INTEGRATION_PDFPACKETRENDERER_MODE = prevMode;
  }
  const pdfBuf = Buffer.isBuffer(rendered.pdf_bytes) ? rendered.pdf_bytes : Buffer.from(rendered.pdf_bytes);
  await audit(req, 'competition.export.pdf', { details: { from, to } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="competition-evidence.pdf"');
  res.send(pdfBuf);
}));

router.get('/reconcile', validate(PeriodQuery, 'query'), asyncHandler(async (req, res) => {
  const { from, to } = resolvePeriod(req);
  const result = await competition.reconcile(from, to);
  await audit(req, 'competition.reconcile', { details: { from, to, matched: result.matched } });
  res.json(result);
}));

module.exports = router;
