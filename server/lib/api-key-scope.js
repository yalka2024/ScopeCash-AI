/**
 * API-key project-level scoping. `ApiKey.scopes` (read/write/etc, checked
 * by middleware/auth.js#requireScope) is org-wide — a key with any write
 * scope can touch every project in the org. `ApiKeyProjectGrant` narrows
 * that: a key with one or more grant rows is additionally restricted to
 * just those projects. A key with ZERO grants stays org-wide — the
 * pre-existing, backward-compatible default for every key created before
 * this feature existed.
 *
 * Consumed by routes/entities.js (the generic per-project domain CRUD)
 * and routes/evidence.js (the real upload/analyze endpoints) — the two
 * places project-scoped resources actually live.
 */
const prisma = require('./prisma');

/** @returns {Promise<string[]|null>} null = unrestricted (org-wide); array = allowed project ids only. */
async function getApiKeyProjectIds(apiKeyId) {
  if (!apiKeyId) return null;
  const grants = await prisma.apiKeyProjectGrant.findMany({ where: { apiKeyId }, select: { projectId: true } });
  if (grants.length === 0) return null;
  return grants.map((g) => g.projectId);
}

/** Resolves `req.apiKeyProjectIds` once per request. A no-op (null) for
 * cookie/Bearer session auth (always org-wide, req.authScopes === ['*'])
 * and for keys with no grants — mount after middleware/auth.js. */
async function attachApiKeyProjectScope(req, res, next) {
  try {
    req.apiKeyProjectIds = req.authMode === 'apikey' ? await getApiKeyProjectIds(req.apiKeyId) : null;
    next();
  } catch (err) { next(err); }
}

module.exports = { getApiKeyProjectIds, attachApiKeyProjectScope };
