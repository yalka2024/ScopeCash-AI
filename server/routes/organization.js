/**
 * Organization membership & invitations.
 *
 * Replaces the old design where:
 *   - POST /organizations let ANY authenticated user create a new org and
 *     silently reassign their own user.orgId to it (no restriction — a user
 *     could "replace" their org at will).
 *   - POST /organizations/invite required the invitee to already have an
 *     account, accepted no role, and just flipped user.orgId directly with
 *     no token, no expiry, no audit trail.
 *
 * Every account now gets its own org automatically at signup (routes/auth.js
 * register handler), so org creation here is gone entirely. Membership lives
 * in OrgMembership (role + status per user per org); invitations are real,
 * expiring, tokenized rows in Invitation, accepted by token rather than by
 * an admin blindly reassigning someone else's account.
 */
const crypto = require('crypto');
const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { hashToken } = require('../lib/security');
const { roleNames, requireAnyOrgRole } = require('../lib/roles');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const mailer = require('../lib/email');

const router = express.Router();
router.use(authMiddleware);

const MANAGE_ROLES = ['owner', 'admin'];
const INVITE_TTL_MS = 7 * 24 * 3600_000;

// GET /api/organizations/mine — org profile + active membership list.
router.get('/mine', attachTenant, asyncHandler(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.tenant.orgId } });
  if (!org) return res.json({ org: null, memberships: [] });
  const memberships = await prisma.orgMembership.findMany({
    where: { orgId: org.id, status: 'active' },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  const record = await prisma.organizationRecord.findUnique({ where: { orgId: org.id } });
  res.json({ org, record, memberships });
}));

// GET /api/organizations/members
router.get('/members', attachTenant, asyncHandler(async (req, res) => {
  const memberships = await prisma.orgMembership.findMany({
    where: { orgId: req.tenant.orgId, status: { not: 'removed' } },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  res.json({ data: memberships });
}));

const RoleChangeSchema = z.object({ role: z.enum(roleNames()) });

// PATCH /api/organizations/members/:userId — change a member's role.
router.patch('/members/:userId', attachTenant, requireAnyOrgRole(...MANAGE_ROLES), validate(RoleChangeSchema),
  asyncHandler(async (req, res) => {
    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: req.tenant.orgId, userId: req.params.userId } },
    });
    if (!membership || membership.status !== 'active') return res.status(404).json({ error: 'not_found' });
    if (membership.role === 'owner' && req.body.role !== 'owner') {
      const owners = await prisma.orgMembership.count({ where: { orgId: req.tenant.orgId, role: 'owner', status: 'active' } });
      if (owners <= 1) throw new HttpError(409, 'Cannot demote the last owner', 'last_owner');
    }
    const row = await prisma.orgMembership.update({ where: { id: membership.id }, data: { role: req.body.role } });
    await audit(req, 'organization.member.role_changed', { resource: 'orgMembership', resourceId: row.id, details: { role: req.body.role } });
    res.json(row);
  }));

// DELETE /api/organizations/members/:userId — remove a member (soft).
router.delete('/members/:userId', attachTenant, requireAnyOrgRole(...MANAGE_ROLES), asyncHandler(async (req, res) => {
  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: req.tenant.orgId, userId: req.params.userId } },
  });
  if (!membership || membership.status !== 'active') return res.status(404).json({ error: 'not_found' });
  if (membership.role === 'owner') {
    const owners = await prisma.orgMembership.count({ where: { orgId: req.tenant.orgId, role: 'owner', status: 'active' } });
    if (owners <= 1) throw new HttpError(409, 'Cannot remove the last owner', 'last_owner');
  }
  await prisma.orgMembership.update({ where: { id: membership.id }, data: { status: 'removed', removedAt: new Date() } });
  await audit(req, 'organization.member.removed', { resource: 'orgMembership', resourceId: membership.id });
  res.json({ ok: true });
}));

// ── Invitations ───────────────────────────────────────
const InviteSchema = z.object({ email: z.string().email().max(254), role: z.enum(roleNames()) });

// GET /api/organizations/invitations — list pending invites for this org.
router.get('/invitations', attachTenant, requireAnyOrgRole(...MANAGE_ROLES), asyncHandler(async (req, res) => {
  const rows = await prisma.invitation.findMany({
    where: { orgId: req.tenant.orgId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: rows.map(({ tokenHash, ...r }) => r) }); // never expose the hash
}));

// POST /api/organizations/invitations — invite a teammate by email + role.
router.post('/invitations', attachTenant, requireAnyOrgRole(...MANAGE_ROLES), validate(InviteSchema),
  asyncHandler(async (req, res) => {
    const email = req.body.email.toLowerCase();
    const existingMember = await prisma.user.findUnique({ where: { email } });
    if (existingMember) {
      const membership = await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: req.tenant.orgId, userId: existingMember.id } },
      });
      if (membership && membership.status === 'active') {
        throw new HttpError(409, 'This person is already a member of your organization', 'already_member');
      }
    }
    const raw = crypto.randomBytes(32).toString('base64url');
    const invitation = await prisma.invitation.create({
      data: {
        orgId: req.tenant.orgId, email, role: req.body.role,
        tokenHash: hashToken(raw), invitedBy: req.user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    const org = await prisma.organization.findUnique({ where: { id: req.tenant.orgId } });
    mailer.sendTemplate('invite', email, {
      token: raw, inviter_name: req.user.name || req.user.email, org_name: org && org.name, role: req.body.role,
    }).catch((e) => console.error('[organization] invite dispatch failed:', e && e.message));
    if (process.env.NODE_ENV !== 'production') {
      console.log(JSON.stringify({ type: 'org_invite_token', invitationId: invitation.id, token: raw }));
    }
    await audit(req, 'organization.invite.sent', { resource: 'invitation', resourceId: invitation.id, details: { email, role: req.body.role } });
    res.status(201).json({ id: invitation.id, email, role: invitation.role, expiresAt: invitation.expiresAt });
  }));

// DELETE /api/organizations/invitations/:id — revoke a pending invite.
router.delete('/invitations/:id', attachTenant, requireAnyOrgRole(...MANAGE_ROLES), asyncHandler(async (req, res) => {
  const invitation = await prisma.invitation.findFirst({ where: { id: req.params.id, orgId: req.tenant.orgId } });
  if (!invitation || invitation.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  await prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'revoked', revokedAt: new Date() } });
  await audit(req, 'organization.invite.revoked', { resource: 'invitation', resourceId: invitation.id });
  res.json({ ok: true });
}));

const AcceptSchema = z.object({ token: z.string().min(20) });

// POST /api/organizations/invitations/accept — the invited user (must already
// be logged in, with an account matching the invited email) joins the org.
router.post('/invitations/accept', validate(AcceptSchema), asyncHandler(async (req, res) => {
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(req.body.token) } });
  if (!invitation || invitation.status !== 'pending' || invitation.expiresAt < new Date()) {
    throw new HttpError(400, 'Invalid or expired invitation', 'invalid_invitation');
  }
  if (invitation.email !== req.user.email.toLowerCase()) {
    throw new HttpError(403, 'This invitation was sent to a different email address', 'invitation_email_mismatch');
  }
  const { runWithOrg } = require('../lib/tenant-context');
  await runWithOrg(invitation.orgId, () => prisma.tenantTransaction(async (tx) => {
    await tx.orgMembership.upsert({
      where: { orgId_userId: { orgId: invitation.orgId, userId: req.user.id } },
      update: { role: invitation.role, status: 'active', removedAt: null },
      create: { orgId: invitation.orgId, userId: req.user.id, role: invitation.role, invitedBy: invitation.invitedBy },
    });
    await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'accepted', acceptedAt: new Date() } });
    // Keep the cached "current org" pointer in step with the accepted invite —
    // it does not overwrite any *other* org the user still belongs to via
    // OrgMembership, only which one lib/prisma.js/attachTenant treat as active.
    await tx.user.update({ where: { id: req.user.id }, data: { orgId: invitation.orgId } });
  }));
  await audit(req, 'organization.invite.accepted', { resource: 'invitation', resourceId: invitation.id });
  res.json({ ok: true, orgId: invitation.orgId, role: invitation.role });
}));

module.exports = router;
