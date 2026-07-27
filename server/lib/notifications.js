/**
 * Single writer of Notification rows / sender of notification emails —
 * every real notification producer (lifecycle-triggers.js's scheduled
 * nudges, routes/entities.js's packet-approval notice, future ones) should
 * call notifyUser() rather than writing prisma.notification.create()
 * directly, so a user's NotificationPreference is always honored instead
 * of each producer having to remember to check it itself.
 */
const prisma = require('./prisma');
const email = require('./email');

/**
 * @param {string} userId
 * @param {string} type - matches a NOTIFICATION_TYPES entry (lib/notification-types.js)
 * @param {{ title?: string, message?: string, properties?: object }} opts
 * @returns {Promise<{ notification: object|null, inApp: boolean, emailSent: boolean }>}
 */
async function notifyUser(userId, type, { title, message, properties = null } = {}) {
  if (!userId || !type) return { notification: null, inApp: false, emailSent: false };

  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_type: { userId, type } },
  }).catch(() => null);
  // No row for this (user, type) yet -> both channels default on.
  const inApp = pref ? pref.inApp : true;
  const emailEnabled = pref ? pref.email : true;

  const titleStr = String(title || type);
  const messageStr = String(message || '');

  // Independent reads/writes — the Notification row and the recipient's
  // email address don't depend on each other, so fetch them together
  // instead of stacking two round trips in series.
  const [notification, user] = await Promise.all([
    inApp
      ? prisma.notification.create({
          data: {
            userId, type, title: titleStr, message: messageStr,
            metadata: properties ? JSON.stringify(properties).slice(0, 2000) : null,
          },
        }).catch(() => null)
      : Promise.resolve(null),
    emailEnabled
      ? prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null)
      : Promise.resolve(null),
  ]);

  let emailSent = false;
  if (emailEnabled && user?.email) {
    try {
      await email.send({ to: user.email, subject: titleStr, text: messageStr });
      emailSent = true;
    } catch (err) {
      console.error('[notifications] email send failed for type', type, '-', err && err.message);
    }
  }

  return { notification, inApp, emailSent };
}

module.exports = { notifyUser };
