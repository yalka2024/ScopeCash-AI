/**
 * Tools API for ScopeCash AI — list and invoke the platform's real tools.
 *
 * Built-in tools (forecast, scorer, …) compute for real; integration adapters
 * return labeled mock data until configured, and refuse live mode on a
 * safety-gated platform. Auth-protected.
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../lib/validate');
const registry = require('../lib/tool-registry');

const router = express.Router();
router.use(authMiddleware);

// Most tools operate only on the caller's own ctx (userId/orgId) and are
// safe for any authenticated user. A few reach platform-wide infrastructure
// or send real outbound effects with no scoping to the caller's own org —
// see lib/tool-registry.js#ADMIN_ONLY_TOOLS (the single source of truth;
// lib/agent-runtime.js#execTool enforces the identical check on the OTHER
// path that reaches these same tool objects, via an agent's tool-calling
// loop — a follow-up security review found the original version of this
// gate, inline here only, was fully bypassable through that second path).

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
  registry.assertToolAccess(tool.name, { role: req.user && req.user.role });
  const ctx = { userId: req.user && req.user.id, orgId: req.user && req.user.orgId, role: req.user && req.user.role };
  const result = await tool.run(req.body || {}, ctx);  // safety/mock semantics enforced inside the tool
  res.json({ ok: true, tool: tool.name, result });
}));

module.exports = router;

