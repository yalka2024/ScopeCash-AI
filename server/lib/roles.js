/**
 * Role-based access control for ScopeCash AI (Phase 2.4).
 *
 * Real, spec-driven RBAC — not the binary admin check. ROLES is the catalog the
 * spec declared; middleware enforces it per route. 'admin' is always allowed.
 */
'use strict';

// [{ name, description, canWrite }] — canWrite null means "infer from the name".
const ROLES = [{"name":"owner","description":"Full org control: billing, members, settings, deletion, exports, legal hold, and API keys.","canWrite":true},{"name":"admin","description":"Manages projects, customers, rates, templates, members, and reporting.","canWrite":true},{"name":"project_manager","description":"Creates projects, uploads evidence, reviews findings, and approves packets.","canWrite":true},{"name":"estimator","description":"Edits scope items, quantities, rates, and proposed pricing.","canWrite":true},{"name":"field_user","description":"Uploads photographs, voice notes, receipts, and daily logs from the field.","canWrite":true},{"name":"viewer","description":"Read-only access to projects, findings, and packets. Cannot create or modify any record.","canWrite":false},{"name":"user","description":"Default role for newly registered accounts.","canWrite":true}];

const READONLY_HINTS = /^(viewer|read.?only|auditor|guest|observer)$/i;

function roleNames() { return ROLES.map((r) => r.name); }

function isKnownRole(role) { return role === 'admin' || ROLES.some((r) => r.name === role); }

// Whether a role may perform writes (create/update/delete).
function isWriteRole(role) {
  if (role === 'admin') return true;
  const r = ROLES.find((x) => x.name === role);
  if (!r) return false;                 // unknown role → no write
  if (r.canWrite === false) return false;
  if (r.canWrite === true) return true;
  return !READONLY_HINTS.test(role);    // infer from the name when unspecified
}

// Require the caller's role to be one of `allowed` (admin always passes).
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated', code: 'auth_required' });
    if (req.user.role === 'admin' || allowed.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'forbidden', code: 'role_required', requiredAny: allowed });
  };
}

// Require any write-capable role.
function requireWrite(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated', code: 'auth_required' });
  if (isWriteRole(req.user.role)) return next();
  return res.status(403).json({ error: 'forbidden', code: 'write_role_required' });
}

// Per-entity RBAC using the caller's ORG-scoped role (req.orgRole, resolved by
// middleware/tenant.js's attachTenant from OrgMembership) rather than the
// single platform-level req.user.role. This is what actually stops a
// field_user from writing CommercialOutcome rows or a viewer from creating
// anything — requireWrite() only checks "is this role write-capable at all,"
// which every non-viewer role satisfies.
function requireAnyOrgRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated', code: 'auth_required' });
    if (req.user.role === 'admin') return next();
    const role = req.orgRole || 'viewer';
    if (allowed.includes(role)) return next();
    return res.status(403).json({ error: 'forbidden', code: 'role_required', requiredAny: allowed });
  };
}

// Org-level roles allowed to move an EvidencePacket to 'approved'
// (routes/entities.js's POST /evidencePackets/:id/approve) — shared here
// so anything that needs to know "can this org member actually approve a
// packet" (e.g. lib/tools/emailnotificationsender.js, which must not let a
// caller trigger a notification off a packet THEY had no part in
// approving) uses the exact same list, not a second copy that can drift.
const PACKET_APPROVE_ROLES = ['owner', 'admin', 'project_manager'];

module.exports = { ROLES, roleNames, isKnownRole, isWriteRole, requireRole, requireWrite, requireAnyOrgRole, PACKET_APPROVE_ROLES };

