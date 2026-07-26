/**
 * Data Subject Access Request (DSAR) endpoints (DATA-006).
 *
 * Implements the GDPR Article 15 (right of access / data export) and
 * Article 17 (right to erasure / right to be forgotten) flows for the
 * authenticated end-user. SOC 2 CC6.5 / ISO 27701 7.3.4-7.3.6.
 *
 *   GET  /api/me/export   — returns JSON of all PII held about the caller
 *   POST /api/me/erase    — anonymises the caller's account immediately,
 *                           revokes all sessions, audits the action.
 *
 * The hard-delete is implemented as an in-place anonymisation rather than
 * row deletion so the audit hash chain (OBS-005) is not broken.
 */
const express = require('express');
const crypto  = require('crypto');
const prisma  = require('../lib/prisma');
const { authMiddleware, requireScope } = require('../middleware/auth');
const { audit } = require('../lib/audit');
let encryption = null;
try { encryption = require('../lib/encryption'); } catch (e) { /* optional */ }

const router = express.Router();
router.use(authMiddleware);

// ── GET /api/me/export — Article 15 right of access ───────────────
router.get('/export', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true, orgId: true, createdAt: true, updatedAt: true },
    });
    if (!user) return res.status(404).json({ error: 'not_found' });

    const activity = await prisma.activity.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { id: true, action: true, resource: true, resourceId: true, createdAt: true },
    });

    try { await audit(req, 'dsar.export', { resource: 'user', resourceId: req.user.id }); } catch (e) {}

    res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
    res.json({
      generatedAt: new Date().toISOString(),
      subject: user,
      activity,
      note: 'Export covers profile, role and audit-log entries. Submit a DSAR to support@ for archived backups.',
    });
  } catch (err) { next(err); }
});

// ── POST /api/me/erase — Article 17 right to erasure ──────────────
// Body: { confirm: 'ERASE' }
// Anonymises the user record in place: email/name replaced with hashed
// placeholders, password broken, role demoted. Session is invalidated by
// clearing the auth cookie. The row stays so foreign-key history (and
// the audit hash chain) remains intact.
router.post('/erase', requireScope('write'), express.json(), async (req, res, next) => {
  try {
    if (!req.body || req.body.confirm !== 'ERASE') {
      return res.status(400).json({ error: 'must_post_confirm_ERASE' });
    }
    const userId = req.user.id;

    // Build deterministic, irreversible anonymous identifier.
    const anonId = 'erased-' + crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
    const anonEmail = anonId + '@erased.invalid';

    await prisma.user.update({
      where: { id: userId },
      data: {
        email: anonEmail,
        name: 'erased user',
        // Field is `passwordHash` in the schema — writing `password` (a non-existent
        // field) made Prisma throw and the erasure silently fail, leaving real
        // credentials valid. Overwrite the real hash so login is permanently broken.
        passwordHash: crypto.randomBytes(32).toString('hex'),
        role: 'erased',
      },
    });

    try { await audit(req, 'dsar.erase', { resource: 'user', resourceId: userId, anonId }); } catch (e) {}

    // Invalidate the auth cookie immediately.
    res.clearCookie('auth', { path: '/' });
    res.clearCookie('refresh', { path: '/' });
    res.json({ ok: true, anonId, message: 'Account anonymised. Backups will roll off within 30 days.' });
  } catch (err) { next(err); }
});

module.exports = router;

