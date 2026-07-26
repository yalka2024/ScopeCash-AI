/**
 * Marketplace API (Tier 16).
 *
 *   GET  /api/marketplace/catalog                public — list integrations
 *   GET  /api/marketplace/installations          authed  — installs for my org
 *   POST /api/marketplace/install/:id            authed  — install integration for my org
 *   DELETE /api/marketplace/install/:id          authed  — uninstall
 *
 *   GET  /api/marketplace/oauth-apps             admin   — list registered OAuth apps
 *   POST /api/marketplace/oauth-apps             admin   — register app, returns secret once
 *   DELETE /api/marketplace/oauth-apps/:clientId admin   — delete app
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const integrations = require('../lib/integrations');
const oauthApps = require('../lib/oauth-apps');
const { z, validate, asyncHandler } = require('../lib/validate');

const router = express.Router();

// Public catalog (no auth required).
router.get('/catalog', asyncHandler(async (_req, res) => {
  res.json({ integrations: integrations.listCatalog() });
}));

router.use(authMiddleware);
router.use(attachTenant);

router.get('/installations', asyncHandler(async (req, res) => {
  const orgId = req.tenant && req.tenant.orgId;
  if (!orgId) return res.json({ installations: [] });
  const rows = await integrations.listInstallations(orgId);
  res.json({
    installations: rows.map(r => ({
      id: r.id,
      integrationId: r.integrationId,
      status: r.status,
      installedBy: r.installedBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}));

const InstallSchema = z.object({ config: z.record(z.any()).optional() });
router.post('/install/:id', validate(InstallSchema), asyncHandler(async (req, res) => {
  const orgId = req.tenant && req.tenant.orgId;
  if (!orgId) return res.status(400).json({ error: 'No org context', code: 'no_org' });
  if (!integrations.getCatalogEntry(req.params.id)) {
    return res.status(404).json({ error: 'Unknown integration', code: 'unknown_integration' });
  }
  const row = await integrations.install(orgId, req.params.id, {
    config: req.body.config || {},
    installedBy: req.user.id,
  });
  res.status(201).json({ id: row.id, integrationId: row.integrationId, status: row.status });
}));

router.delete('/install/:id', asyncHandler(async (req, res) => {
  const orgId = req.tenant && req.tenant.orgId;
  if (!orgId) return res.status(400).json({ error: 'No org context', code: 'no_org' });
  await integrations.uninstall(orgId, req.params.id);
  res.json({ ok: true });
}));

// ---- OAuth app management (admin only) ----
const admin = express.Router();
admin.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

admin.get('/', asyncHandler(async (req, res) => {
  const apps = await oauthApps.listApps({ orgId: req.tenant && req.tenant.orgId });
  res.json({
    apps: apps.map(a => ({
      clientId: a.clientId,
      name: a.name,
      description: a.description,
      redirectUris: (a.redirectUris || '').split(/[\n,\s]+/).filter(Boolean),
      scopes: a.scopes,
      createdAt: a.createdAt,
    })),
  });
}));

const RegisterSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  redirectUris: z.array(z.string().url()).min(1).max(10),
  scopes: z.string().max(200).optional(),
});
admin.post('/', validate(RegisterSchema), asyncHandler(async (req, res) => {
  const result = await oauthApps.registerApp({
    orgId: req.tenant && req.tenant.orgId,
    ownerUserId: req.user.id,
    name: req.body.name,
    description: req.body.description || null,
    redirectUris: req.body.redirectUris,
    scopes: req.body.scopes || 'read',
  });
  res.status(201).json({
    clientId: result.app.clientId,
    clientSecret: result.clientSecret, // shown ONCE
    name: result.app.name,
    redirectUris: req.body.redirectUris,
    scopes: result.app.scopes,
  });
}));

admin.delete('/:clientId', asyncHandler(async (req, res) => {
  await oauthApps.deleteApp(req.params.clientId);
  res.json({ ok: true });
}));

router.use('/oauth-apps', admin);

module.exports = router;

