/**
 * Tools API for ScopeCash AI — list and invoke the platform's real tools.
 *
 * Built-in tools (forecast, scorer, …) compute for real; integration adapters
 * return labeled mock data until configured, and refuse live mode on a
 * safety-gated platform. Auth-protected.
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../lib/validate');
const registry = require('../lib/tool-registry');

const router = express.Router();
router.use(authMiddleware);

// Most tools operate only on the caller's own ctx (userId/orgId) and are
// safe for any authenticated user. A few reach platform-wide infrastructure
// that has nothing to do with the caller's own org — most acutely
// SecretManagerClient, which returns the actual value of any named
// production secret with no scoping at all once GCP_PROJECT_ID is set
// (required for this platform's real Gemini/Vertex AI pipeline, so it's
// realistically always set). Found via a follow-up security audit: any
// signed-up customer, any role, could call
// POST /api/tools/SecretManagerClient/run {"secret_id":"..."} and read
// production credentials. Gated to platform admins here since ctx (passed
// to every tool's run()) deliberately carries no role information for
// tools to self-check.
const ADMIN_ONLY_TOOLS = new Set(['SecretManagerClient', 'StripeClient', 'CloudTasksEnqueuer']);

router.get('/', (req, res) => {
  res.json(registry.listTools().map((t) => ({
    name: t.name,
    description: t.description || '',
    inputs: t.inputs || [],
    outputs: t.outputs || [],
    status: typeof t.status === 'function' ? t.status() : 'builtin',
  })));
});

router.post('/:name/run', asyncHandler(async (req, res) => {
  const tool = registry.getTool(req.params.name);
  if (!tool) return res.status(404).json({ error: 'tool_not_found' });
  if (ADMIN_ONLY_TOOLS.has(tool.name) && (!req.user || req.user.role !== 'admin')) {
    throw new HttpError(403, `${tool.name} is a platform-infrastructure tool restricted to admins`, 'admin_required');
  }
  const ctx = { userId: req.user && req.user.id, orgId: req.user && req.user.orgId };
  const result = await tool.run(req.body || {}, ctx);  // safety/mock semantics enforced inside the tool
  res.json({ ok: true, tool: tool.name, result });
}));

module.exports = router;

