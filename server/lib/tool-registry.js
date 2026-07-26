/**
 * Tool registry — auto-discovers every module in lib/tools/.
 * Each tool module exports { name, description, inputs, outputs, run(input, ctx) }.
 * Generated for ScopeCash AI.
 */
const fs = require('fs');
const path = require('path');

const TOOLS_DIR = path.join(__dirname, 'tools');
const _tools = new Map();

function _load() {
  if (_tools.size) return;
  if (!fs.existsSync(TOOLS_DIR)) return;
  for (const file of fs.readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const mod = require(path.join(TOOLS_DIR, file));
    if (mod && mod.name && typeof mod.run === 'function') _tools.set(mod.name, mod);
  }
}

function getTool(name) { _load(); return _tools.get(name); }
function listTools() { _load(); return Array.from(_tools.values()); }
function toolNames() { _load(); return Array.from(_tools.keys()); }

// Platform-infrastructure tools that reach something with nothing to do
// with the caller's own org (production secrets, raw billing HTTP calls,
// the platform job queue) — restricted to platform admins. Single source
// of truth: a follow-up security review found the original fix (an inline
// check only in routes/tools.js's direct HTTP path) was fully bypassable
// via lib/agent-runtime.js#execTool, the OTHER path that reaches these same
// tool objects (every shipped agent's `tools: []` means "every registered
// tool," so any authenticated user could ask an agent to call
// SecretManagerClient on their behalf). Both call sites now import and
// enforce this same check — see assertToolAccess below.
// EmailNotificationSender is also admin-only: its "approved_by" field is
// self-asserted free text from the same caller invoking it, not a real
// server-verified approval record, so treating it as safe-for-any-user
// let any authenticated account (including a brand-new, unverified
// self-registered one) send arbitrary outbound email — including
// attacker-controlled HTML — to an arbitrary external address from the
// platform's own verified sending domain. Revisit removing it from this
// set only once realRun() checks approved_by against a real approval
// object instead of trusting the caller's own claim.
const ADMIN_ONLY_TOOLS = new Set(['SecretManagerClient', 'StripeClient', 'CloudTasksEnqueuer', 'EmailNotificationSender']);

/**
 * Throws if `ctx.role` isn't a platform admin and `toolName` is
 * admin-only. Every caller of a tool's `run()` — direct HTTP
 * (routes/tools.js) or via an agent's tool-calling loop
 * (lib/agent-runtime.js) — must call this first.
 */
function assertToolAccess(toolName, ctx) {
  if (ADMIN_ONLY_TOOLS.has(toolName) && (!ctx || ctx.role !== 'admin')) {
    const err = new Error(`${toolName} is a platform-infrastructure tool restricted to admins`);
    err.code = 'admin_required'; err.statusCode = 403;
    throw err;
  }
}

module.exports = { getTool, listTools, toolNames, ADMIN_ONLY_TOOLS, assertToolAccess };

