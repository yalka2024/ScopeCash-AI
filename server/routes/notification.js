const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { NOTIFICATION_TYPES } = require('../lib/notification-types');
const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const unread = notifications.filter(n => !n.read).length;
    res.json({ notifications, unread });
  } catch (err) { next(err); }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },   // user-scoped — prevents IDOR
      data: { read: true }
    });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    res.json({ message: 'Marked as read' });
  } catch (err) { next(err); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true }
    });
    res.json({ message: 'All marked as read' });
  } catch (err) { next(err); }
});

// GET /notifications/preferences — every known type, merged with the
// caller's own overrides (a type with no row yet reports the default:
// both channels on). Always the CALLING user's own preferences — userId
// comes from the authenticated session, never a request parameter, so
// there is no cross-user read path to guard against.
router.get('/preferences', asyncHandler(async (req, res) => {
  const rows = await prisma.notificationPreference.findMany({ where: { userId: req.user.id } });
  const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
  const preferences = NOTIFICATION_TYPES.map(({ type, label, description }) => ({
    type, label, description,
    inApp: byType[type] ? byType[type].inApp : true,
    email: byType[type] ? byType[type].email : true,
  }));
  res.json({ preferences });
}));

const PreferenceSchema = z.object({ inApp: z.boolean(), email: z.boolean() });

// PUT /notifications/preferences/:type — upsert the calling user's own
// channel settings for one known type.
router.put('/preferences/:type', validate(PreferenceSchema), asyncHandler(async (req, res) => {
  const known = NOTIFICATION_TYPES.some((t) => t.type === req.params.type);
  if (!known) throw new HttpError(404, 'Unknown notification type', 'not_found');
  const row = await prisma.notificationPreference.upsert({
    where: { userId_type: { userId: req.user.id, type: req.params.type } },
    create: { userId: req.user.id, type: req.params.type, inApp: req.body.inApp, email: req.body.email },
    update: { inApp: req.body.inApp, email: req.body.email },
  });
  res.json(row);
}));

module.exports = router;

