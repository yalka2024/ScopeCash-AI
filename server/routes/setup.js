/**
 * First-run setup endpoints (Tier 23).
 *
 *   GET  /api/setup/status     — public, returns { configured: boolean }
 *   POST /api/setup/complete   — public, only succeeds when no admin user
 *                                exists. Creates (or upgrades) the default
 *                                Organization, creates the first admin user,
 *                                marks them email-verified, and issues a
 *                                session so the wizard can hand the operator
 *                                straight into the dashboard.
 *
 * Once any admin exists, /complete returns 409 setup_already_complete and
 * the wizard UI redirects to the regular login page.
 */
const express = require('express');
const prisma = require('../lib/prisma');
const security = require('../lib/security');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const limiters = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const onboarding = require('../lib/onboarding');
const { issueSession } = require('../lib/session');

const router = express.Router();

const SetupSchema = z.object({
  orgName:       z.string().trim().min(2).max(120),
  adminEmail:    z.string().email().max(254),
  adminName:     z.string().trim().min(1).max(120),
  adminPassword: z.string().min(12).max(256),
  acceptTos:     z.literal(true),
});

async function adminExists() {
  try {
    return await prisma.user.count({ where: { role: 'admin' } });
  } catch (e) {
    // If the DB isn't migrated yet we treat it as "not configured" so the
    // wizard can surface a meaningful error rather than 500-ing.
    return 0;
  }
}

router.get('/status', asyncHandler(async (_req, res) => {
  const count = await adminExists();
  res.json({ configured: count > 0, requiresSetup: count === 0 });
}));

router.post('/complete', limiters.expensive, validate(SetupSchema), asyncHandler(async (req, res) => {
  const existing = await adminExists();
  if (existing > 0) throw new HttpError(409, 'setup_already_complete');

  const { orgName, adminEmail, adminName, adminPassword, acceptTos } = req.body;
  if (!acceptTos) throw new HttpError(400, 'tos_not_accepted');

  const pwError = security.validatePassword(adminPassword);
  if (pwError) throw new HttpError(400, pwError);

  const emailLower = String(adminEmail).toLowerCase();

  // Reuse the bootstrap org if one already exists; otherwise create it.
  let org = await prisma.organization.findFirst();
  if (org) {
    if (org.name !== orgName) {
      org = await prisma.organization.update({ where: { id: org.id }, data: { name: orgName } });
    }
  } else {
    org = await prisma.organization.create({ data: { name: orgName, plan: 'free' } });
  }

  const passwordHash = await security.hashPassword(adminPassword);
  const user = await prisma.user.create({
    data: {
      email: emailLower,
      name: adminName.trim(),
      passwordHash,
      role: 'admin',
      emailVerified: true,
      orgId: org.id,
    },
  });

  // Best-effort: mark onboarding "signup" + "email_verified" so the new
  // operator doesn't see the verify-email step on their first dashboard
  // load.
  try { await onboarding.markStep(user.id, 'signup'); }         catch { /* ignore */ }
  try { await onboarding.markStep(user.id, 'email_verified'); } catch { /* ignore */ }

  try {
    await audit(req, 'auth.first_run_setup', {
      userId: user.id,
      orgId: org.id,
      resource: 'user',
      resourceId: user.id,
      details: { email: emailLower, orgName: org.name },
    });
  } catch { /* audit must not block setup */ }

  await issueSession(res, user, req);

  res.status(201).json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    organization: { id: org.id, name: org.name },
  });
}));

module.exports = router;

