const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { audit } = require('../lib/audit');
const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// All admin user actions are scoped to the admin's OWN organization — a tenant
// admin must never reach users/records belonging to another org (tenant isolation).
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { orgId: req.user.orgId },
      select: { id: true, email: true, name: true, role: true, orgId: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ users });
  } catch (err) { next(err); }
});

router.patch('/users/:id/role', requireAdmin, async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const result = await prisma.user.updateMany({
      where: { id: req.params.id, orgId: req.user.orgId },   // org-scoped
      data: { role }
    });
    if (!result.count) return res.status(404).json({ error: 'User not found' });
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    await audit(req, 'admin.user.role_changed', { resource: 'user', resourceId: user.id, details: { role } });
    res.json({ id: user.id, email: user.email, role: user.role });
  } catch (err) { next(err); }
});

router.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    const result = await prisma.user.deleteMany({
      where: { id: req.params.id, orgId: req.user.orgId }    // org-scoped
    });
    if (!result.count) return res.status(404).json({ error: 'User not found' });
    await audit(req, 'admin.user.deleted', { resource: 'user', resourceId: req.params.id });
    res.json({ message: 'User deleted' });
  } catch (err) { next(err); }
});

router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const where = { orgId: req.user.orgId };
    const [userCount, recordCount] = await Promise.all([
      prisma.user.count({ where }),
      prisma.project.count({ where })
    ]);
    res.json({ users: userCount, projects: recordCount });
  } catch (err) { next(err); }
});

// ─── Sentry diagnostics ─────────────────────────────────────
// GET  /api/admin/sentry/status  — shows whether Sentry is configured
// POST /api/admin/sentry/test    — throws an error to verify reporting
router.get('/sentry/status', requireAdmin, (req, res) => {
  res.json({
    configured: Boolean(process.env.SENTRY_DSN),
    environment: process.env.NODE_ENV || 'development',
    release: process.env.GIT_SHA || process.env.SENTRY_RELEASE || null,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  });
});
router.post('/sentry/test', requireAdmin, (req, _res, next) => {
  next(new Error('Sentry test error from /api/admin/sentry/test (intentional)'));
});

// ─── DB backups ─────────────────────────────────────────────
// GET  /api/admin/backups         — list existing backups
// POST /api/admin/backups/run     — trigger a backup + retention prune
// POST /api/admin/backups/prune   — apply retention only
const dbBackup = require('../scripts/db-backup');
router.get('/backups', requireAdmin, async (_req, res, next) => {
  try { res.json({ backups: await dbBackup.listBackups(), destination: dbBackup.destConfig() }); }
  catch (err) { next(err); }
});
router.post('/backups/run', requireAdmin, async (req, res, next) => {
  try {
    const result = await dbBackup.runBackup();
    await audit(req, 'admin.backup.run', { resource: 'backup', details: { name: result && result.name, size: result && result.size } });
    res.json(result);
  } catch (err) { next(err); }
});
router.post('/backups/prune', requireAdmin, async (req, res, next) => {
  try {
    const result = await dbBackup.prune();
    await audit(req, 'admin.backup.prune', { resource: 'backup', details: result });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Transactional email diagnostics ────────────────────────
// GET  /api/admin/email/status   — provider + from address
// POST /api/admin/email/test     — { to, template?, vars? } sends a probe
const email = require('../lib/email');
router.get('/email/status', requireAdmin, (req, res) => {
  res.json({
    provider: email.provider(),
    configured: email.isConfigured(),
    from: email.FROM,
    public_url: email.PUBLIC_URL,
    available_templates: ['verifyEmail', 'passwordReset', 'welcome', 'invite', 'invoice', 'alert', 'test'],
  });
});
router.post('/email/test', requireAdmin, async (req, res, next) => {
  try {
    const to = (req.body && req.body.to) || req.user.email;
    const template = (req.body && req.body.template) || 'test';
    const vars = Object.assign({ sent_at: new Date().toISOString() }, (req.body && req.body.vars) || {});
    const result = await email.sendTemplate(template, to, vars);
    await audit(req, 'admin.email.test_sent', { resource: 'email', details: { to, template } });
    res.json({ ok: true, to, template, ...result });
  } catch (err) { next(err); }
});

module.exports = router;

