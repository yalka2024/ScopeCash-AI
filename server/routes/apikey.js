const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
// API keys are org credentials. The role catalogue (lib/roles.js) already says
// owner controls them; this is that statement actually enforced.
const { requireAnyOrgRole } = require('../lib/roles');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const router = express.Router();
router.use(authMiddleware);
// attachTenant resolves the org + plan and establishes runWithOrg (RLS
// context on Postgres). It is also where api_calls_per_month is counted, so a
// router that skips it is invisible to that quota — see middleware/tenant.js.
router.use(attachTenant);

// '*' is deliberately NOT mintable. middleware/auth.js#requireScope short-
// circuits on '*', so a key holding it bypasses every scope check in the app
// — and this route had no role gate, meaning any member (down to `viewer`,
// whose own role description says it "cannot create or modify any record")
// could mint themselves one. That is self-escalation to full API access.
// User sessions still carry '*' internally; it is only unrequestable here.
const VALID_SCOPES = ['read', 'write', 'upload', 'delete', 'admin'];
const MAX_PROJECT_GRANTS = 50;
const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.string().regex(/^[a-z*,\s]+$/i).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  // Restricts the key to specific projects instead of every project in the
  // org (routes/entities.js#scope, routes/evidence.js#assertProjectInOrg —
  // see lib/api-key-scope.js). Omitted/empty = org-wide, the pre-existing
  // default.
  projectIds: z.array(z.string().min(1)).max(MAX_PROJECT_GRANTS).optional(),
});

/** Every id in `projectIds` must be a real ProjectRecord in the caller's
 * own org — otherwise a key could be minted with a grant for a project
 * that doesn't exist (silently useless) or, worse, an id copy-pasted from
 * a DIFFERENT org (silently a no-op there too, since every check below
 * ANDs the grant with the caller's own orgId regardless — but rejecting
 * up front gives a real error instead of a silently-inert grant). */
async function assertProjectsInOrg(projectIds, orgId) {
  if (!projectIds || projectIds.length === 0) return;
  const found = await prisma.projectRecord.findMany({ where: { id: { in: projectIds }, orgId }, select: { id: true } });
  const foundIds = new Set(found.map((p) => p.id));
  const missing = projectIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw new HttpError(400, `These project ids do not reference a project in your organization: ${missing.join(', ')}`, 'invalid_project_reference');
  }
}

router.post('/', requireAnyOrgRole('owner', 'admin'), validate(CreateSchema), asyncHandler(async (req, res) => {
  const { name, scopes, expiresInDays, projectIds } = req.body;
  const requested = (scopes || 'read').split(/[,\s]+/).filter(Boolean);
  for (const s of requested) {
    if (!VALID_SCOPES.includes(s)) throw new HttpError(400, `Invalid scope: ${s}`, 'invalid_scope');
  }
  const uniqueProjectIds = projectIds ? [...new Set(projectIds)] : [];
  await assertProjectsInOrg(uniqueProjectIds, req.user.orgId);

  const rawKey = `scopecash-ai_${crypto.randomBytes(32).toString('hex')}`;
  // Slice from AFTER the constant "scopecash-ai_" literal (13 chars) — must
  // match middleware/auth.js's identical computation exactly, or this key
  // could never authenticate (its stored prefix would never match what
  // auth recomputes from the raw key at request time).
  const prefix = rawKey.slice(13, 21);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;

  const created = await prisma.$transaction(async (tx) => {
    const key = await tx.apiKey.create({ data: {
      userId: req.user.id, name, keyHash, prefix,
      scopes: requested.join(','), expiresAt,
    }});
    if (uniqueProjectIds.length) {
      await tx.apiKeyProjectGrant.createMany({
        data: uniqueProjectIds.map((projectId) => ({ apiKeyId: key.id, projectId })),
      });
    }
    return key;
  });

  await audit(req, 'apikey.create', { resource: 'apiKey', resourceId: created.id, details: { scopes: requested, projectIds: uniqueProjectIds } });
  res.status(201).json({ id: created.id, key: rawKey, prefix, name, scopes: requested, expiresAt, projectIds: uniqueProjectIds,
    message: 'Save this key — it cannot be shown again.' });
}));

router.get('/', asyncHandler(async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { userId: req.user.id },
    select: {
      id: true, name: true, prefix: true, scopes: true, active: true, lastUsedAt: true, expiresAt: true, createdAt: true,
      projectGrants: { select: { projectId: true } },
    },
  });
  res.json({ keys: keys.map(({ projectGrants, ...k }) => ({ ...k, projectIds: projectGrants.map((g) => g.projectId) })) });
}));

const ProjectGrantsSchema = z.object({ projectIds: z.array(z.string().min(1)).max(MAX_PROJECT_GRANTS) });

// PUT /api/apikey/:id/projects — replace the full project-grant set for an
// existing key. An empty array reverts the key to org-wide (the default).
router.put('/:id/projects', requireAnyOrgRole('owner', 'admin'), validate(ProjectGrantsSchema), asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!key) return res.status(404).json({ error: 'not_found' });
  const uniqueProjectIds = [...new Set(req.body.projectIds)];
  await assertProjectsInOrg(uniqueProjectIds, req.user.orgId);

  await prisma.$transaction(async (tx) => {
    await tx.apiKeyProjectGrant.deleteMany({ where: { apiKeyId: key.id } });
    if (uniqueProjectIds.length) {
      await tx.apiKeyProjectGrant.createMany({ data: uniqueProjectIds.map((projectId) => ({ apiKeyId: key.id, projectId })) });
    }
  });

  await audit(req, 'apikey.projects.replace', { resource: 'apiKey', resourceId: key.id, details: { projectIds: uniqueProjectIds } });
  res.json({ id: key.id, projectIds: uniqueProjectIds });
}));

router.delete('/:id', requireAnyOrgRole('owner', 'admin'), asyncHandler(async (req, res) => {
  await prisma.apiKey.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  await audit(req, 'apikey.delete', { resource: 'apiKey', resourceId: req.params.id });
  res.json({ message: 'API key deleted' });
}));

module.exports = router;
