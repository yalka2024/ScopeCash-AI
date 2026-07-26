/**
 * First-run setup endpoints (Tier 23).
 *
 *   GET  /api/setup/status     — public, returns { configured: boolean }
 *   POST /api/setup/complete   — public, only succeeds on a genuinely fresh,
 *                                empty deployment. Creates the first
 *                                Organization and admin user, marks them
 *                                email-verified, and issues a session so the
 *                                wizard can hand the operator straight into
 *                                the dashboard.
 *
 * SECURITY: "fresh deployment" is checked as BOTH zero admin users AND zero
 * organizations, not admin-count alone. A follow-up security review found
 * that gating on admin-count alone was a real, unauthenticated privilege-
 * escalation path: `role` is a global, platform-wide field (no per-org
 * scoping — see middleware/tenant.js mapping role==='admin' straight to a
 * platform-superuser org role), and normal self-serve registration
 * (routes/auth.js) never sets it. On a live, real deployment where the
 * operator hasn't manually run prisma/seed.js (exactly the scenario this
 * wizard exists to replace), `adminExists()` alone stays 0 forever — even
 * after real paying customers with real orgs have signed up — letting an
 * anonymous attacker call /complete, get created as role:'admin' (full
 * platform superuser), and get attached to `organization.findFirst()`
 * (whichever real org sorts first), **renaming that org** to whatever they
 * chose. Requiring zero organizations too closes this: any real signup
 * (self-serve registration always creates an Organization) permanently
 * closes this endpoint, which is the intended one-time-only semantics.
 * The check + create also now runs as one transaction to close the
 * remaining TOCTOU window between the check and the writes.
 */
const express = require('express');
const prisma = require('../lib/prisma');
const security = require('../lib/security');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const limiters = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const onboarding = require('../lib/onboarding');
const { issueSession } = require('../lib/session');
const { runWithSystemAccess } = require('../lib/tenant-context');

const router = express.Router();

const SetupSchema = z.object({
  orgName:       z.string().trim().min(2).max(120),
  adminEmail:    z.string().email().max(254),
  adminName:     z.string().trim().min(1).max(120),
  adminPassword: z.string().min(12).max(256),
  acceptTos:     z.literal(true),
});

async function isFreshDeployment() {
  try {
    const [adminCount, orgCount] = await runWithSystemAccess(async () => Promise.all([
      prisma.user.count({ where: { role: 'admin' } }),
      prisma.organization.count(),
    ]));
    return adminCount === 0 && orgCount === 0;
  } catch (e) {
    // If the DB isn't migrated yet we treat it as "not configured" so the
    // wizard can surface a meaningful error rather than 500-ing.
    return true;
  }
}

router.get('/status', asyncHandler(async (_req, res) => {
  const fresh = await isFreshDeployment();
  res.json({ configured: !fresh, requiresSetup: fresh });
}));

router.post('/complete', limiters.expensive, validate(SetupSchema), asyncHandler(async (req, res) => {
  const { orgName, adminEmail, adminName, adminPassword, acceptTos } = req.body;
  if (!acceptTos) throw new HttpError(400, 'tos_not_accepted');

  const pwError = security.validatePassword(adminPassword);
  if (pwError) throw new HttpError(400, pwError);

  const emailLower = String(adminEmail).toLowerCase();
  const passwordHash = await security.hashPassword(adminPassword);

  const { org, user } = await runWithSystemAccess(() => prisma.tenantTransaction(async (tx) => {
    const [adminCount, orgCount] = await Promise.all([
      tx.user.count({ where: { role: 'admin' } }),
      tx.organization.count(),
    ]);
    if (adminCount > 0 || orgCount > 0) throw new HttpError(409, 'setup_already_complete');

    const org = await tx.organization.create({ data: { name: orgName, plan: 'free' } });
    const user = await tx.user.create({
      data: {
        email: emailLower,
        name: adminName.trim(),
        passwordHash,
        role: 'admin',
        emailVerified: true,
        orgId: org.id,
      },
    });
    return { org, user };
  }));

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

