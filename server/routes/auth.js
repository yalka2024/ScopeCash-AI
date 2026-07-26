const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const {
  signAccessToken, generateRefreshToken, hashToken, refreshExpiry,
  validatePassword, hashPassword, verifyPassword,
  MAX_FAILED, lockoutFor,
  generateMfaSecret, verifyTotp, otpauthUrl,
} = require('../lib/security');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const limiters = require('../lib/ratelimit');
// Not named `email`: handlers destructure an `email` field off req.body, which
// would shadow this module and turn sendTemplate into a TypeError at runtime.
const mailer = require('../lib/email');
const onboarding = require('../lib/onboarding');
const { ACCESS_COOKIE, authMiddleware } = require('../middleware/auth');
const { issueSession, REFRESH_COOKIE, cookieOpts } = require('../lib/session');

const router = express.Router();

function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, orgId: u.orgId, mfaEnabled: u.mfaEnabled }; }

// ─── Schemas ──────────────────────────────────────────
const RegisterSchema = z.object({
  email: z.string().email().max(254),
  password: z.string(),
  name: z.string().max(120).optional(),
});
const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
const EmailSchema = z.object({ email: z.string().email().max(254) });
const ResetSchema = z.object({ token: z.string().min(20), password: z.string() });

// ─── Register ─────────────────────────────────────────
router.post('/register', limiters.auth, validate(RegisterSchema), asyncHandler(async (req, res) => {
  if (process.env.BETA_MODE === 'true') {
    throw new HttpError(403, 'Registration is closed during private beta', 'beta_closed');
  }
  const { email, password, name } = req.body;
  const pwError = validatePassword(password);
  if (pwError) throw new HttpError(400, pwError, 'weak_password');

  const lower = email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: lower } });
  if (existing) throw new HttpError(409, 'Email already registered', 'email_taken');

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email: lower, passwordHash, name: name || null } });

  // Email verification token
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.emailVerificationToken.create({ data: {
    userId: user.id, tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 24 * 3600_000),
  }});
  // Dispatch verification email (Resend > SendGrid > console fallback in dev)
  mailer.sendTemplate('verifyEmail', user.email, { token: raw, name: user.name })
    .catch((e) => console.error('[auth] verifyEmail dispatch failed:', e && e.message));
  // Log the raw token only OUTSIDE production so devs can recover the link without an
  // inbox. Never log this credential in production — it would land in centralized logs
  // and let anyone with log access verify any newly-registered account.
  if (process.env.NODE_ENV !== 'production') {
    console.log(JSON.stringify({ type: 'email_verify_token', userId: user.id, token: raw }));
  }

  await issueSession(res, user, req);
  // Mark first onboarding step (best-effort)
  onboarding.markStep(user.id, 'signup').catch(() => {});
  await audit(req, 'auth.register', { userId: user.id, resource: 'user', resourceId: user.id });
  res.status(201).json({ user: publicUser(user) });
}));

// ─── Login (with optional TOTP and lockout) ───────────
router.post('/login', limiters.auth, validate(LoginSchema), asyncHandler(async (req, res) => {
  const { email, password, totp } = req.body;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Generic message regardless of whether user exists
  const invalid = () => { throw new HttpError(401, 'Invalid credentials', 'auth_invalid'); };

  if (!user) {
    await audit(req, 'auth.login.fail', { details: { reason: 'no_user', email }, outcome: 'failure' });
    invalid();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit(req, 'auth.login.locked', { userId: user.id, outcome: 'failure' });
    throw new HttpError(423, 'Account temporarily locked. Try again later.', 'auth_locked');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED ? lockoutFor() : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: failed, lockedUntil: lock } });
    await audit(req, 'auth.login.fail', { userId: user.id, details: { failed }, outcome: 'failure' });
    invalid();
  }

  if (user.mfaEnabled) {
    if (!totp) throw new HttpError(401, 'MFA code required', 'mfa_required');
    if (!verifyTotp(user.mfaSecret, totp)) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLogins: user.failedLogins + 1 } });
      await audit(req, 'auth.login.mfa_fail', { userId: user.id, outcome: 'failure' });
      invalid();
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: {
    failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(),
  }});
  await issueSession(res, user, req);
  await audit(req, 'auth.login.success', { userId: user.id });
  res.json({ user: publicUser(user) });
}));

// ─── Refresh access token (rotation + reuse detection) ─
router.post('/refresh', asyncHandler(async (req, res) => {
  const raw = req.cookies && req.cookies[REFRESH_COOKIE];
  if (!raw) throw new HttpError(401, 'No refresh token', 'auth_no_refresh');
  const tokenHash = hashToken(raw);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored) throw new HttpError(401, 'Refresh token invalid', 'auth_invalid');

  if (stored.revokedAt) {
    // Reuse detected -> kill the whole family
    await prisma.refreshToken.updateMany({
      where: { family: stored.family, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    res.clearCookie(ACCESS_COOKIE); res.clearCookie(REFRESH_COOKIE);
    await audit(req, 'auth.refresh.reuse_detected', { userId: stored.userId, outcome: 'failure' });
    throw new HttpError(401, 'Refresh token reuse detected', 'auth_reuse');
  }
  if (stored.expiresAt < new Date()) throw new HttpError(401, 'Refresh token expired', 'auth_expired');

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user) throw new HttpError(401, 'User not found', 'auth_invalid');

  const newRaw = generateRefreshToken();
  const newHash = hashToken(newRaw);
  const expiresAt = refreshExpiry();
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date(), replacedBy: newHash } }),
    prisma.refreshToken.create({ data: {
      userId: user.id, tokenHash: newHash, family: stored.family,
      expiresAt, ipAddress: req.ip, userAgent: req.headers['user-agent'] || null,
    }}),
  ]);
  const access = signAccessToken(user);
  res.cookie(ACCESS_COOKIE, access,    cookieOpts(15 * 60_000));
  res.cookie(REFRESH_COOKIE, newRaw,   cookieOpts(expiresAt - Date.now()));
  res.json({ ok: true });
}));

// ─── Logout ───────────────────────────────────────────
router.post('/logout', asyncHandler(async (req, res) => {
  const raw = req.cookies && req.cookies[REFRESH_COOKIE];
  if (raw) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(raw), revokedAt: null },
      data:  { revokedAt: new Date() },
    }).catch(() => {});
  }
  res.clearCookie(ACCESS_COOKIE);
  res.clearCookie(REFRESH_COOKIE);
  res.json({ ok: true });
}));

// ─── Me ───────────────────────────────────────────────
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id },
    select: { id: true, email: true, name: true, role: true, orgId: true, emailVerified: true, mfaEnabled: true, createdAt: true } });
  res.json({ user });
}));

// ─── Email verification ───────────────────────────────
router.post('/verify-email', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) throw new HttpError(400, 'token required', 'invalid_request');
  const t = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!t || t.usedAt || t.expiresAt < new Date()) throw new HttpError(400, 'Invalid or expired token', 'invalid_token');
  await prisma.$transaction([
    prisma.user.update({ where: { id: t.userId }, data: { emailVerified: true } }),
    prisma.emailVerificationToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
  ]);
  // Mark onboarding step (best-effort — never block verification on this)
  onboarding.markStep(t.userId, 'email_verified').catch(() => {});
  await audit(req, 'auth.email_verified', { userId: t.userId });
  res.json({ ok: true });
}));

// ─── Password reset ───────────────────────────────────
router.post('/forgot-password', limiters.auth, validate(EmailSchema), asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email.toLowerCase() } });
  // Always 200 to avoid email enumeration
  if (user) {
    const raw = crypto.randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({ data: {
      userId: user.id, tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }});
    mailer.sendTemplate('passwordReset', user.email, { token: raw, name: user.name })
      .catch((e) => console.error('[auth] passwordReset dispatch failed:', e && e.message));
    // Never log this credential in production — it would land in centralized logs
    // and let anyone with log access take over any account.
    if (process.env.NODE_ENV !== 'production') {
      console.log(JSON.stringify({ type: 'password_reset_token', userId: user.id, token: raw }));
    }
  }
  res.json({ ok: true });
}));

router.post('/reset-password', limiters.auth, validate(ResetSchema), asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const pwError = validatePassword(password);
  if (pwError) throw new HttpError(400, pwError, 'weak_password');
  const t = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!t || t.usedAt || t.expiresAt < new Date()) throw new HttpError(400, 'Invalid or expired token', 'invalid_token');
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: t.userId }, data: { passwordHash, passwordChangedAt: new Date() } }),
    prisma.passwordResetToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
    // revoke all refresh tokens
    prisma.refreshToken.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(req, 'auth.password_reset', { userId: t.userId });
  res.json({ ok: true });
}));

// ─── MFA enrollment / verification / disable ─────────
router.post('/mfa/setup', authMiddleware, asyncHandler(async (req, res) => {
  const secret = generateMfaSecret();
  await prisma.user.update({ where: { id: req.user.id }, data: { mfaSecret: secret, mfaEnabled: false } });
  res.json({ secret, otpauth: otpauthUrl(secret, req.user.email) });
}));

router.post('/mfa/enable', authMiddleware, asyncHandler(async (req, res) => {
  const { totp } = req.body || {};
  const u = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!u.mfaSecret) throw new HttpError(400, 'MFA not initialized', 'mfa_not_setup');
  if (!verifyTotp(u.mfaSecret, totp)) throw new HttpError(400, 'Invalid TOTP', 'mfa_invalid');
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
  await audit(req, 'auth.mfa.enabled', { userId: u.id });
  res.json({ ok: true });
}));

router.post('/mfa/disable', authMiddleware, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const u = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!password || !(await verifyPassword(password, u.passwordHash))) {
    throw new HttpError(401, 'Password confirmation required', 'auth_invalid');
  }
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: false, mfaSecret: null } });
  await audit(req, 'auth.mfa.disabled', { userId: u.id });
  res.json({ ok: true });
}));

module.exports = router;

