/**
 * Capability registry — the honest runtime status of every tool/integration.
 *
 * Each generated tool reports `status()`: 'mock' | 'live' | 'unimplemented'.
 * Built-in tools without that contract report 'builtin'. Surfaced at
 * GET /api/health/integrations so nothing in this platform is ever silently fake.
 *
 * Generated for ScopeCash AI.
 */
const toolRegistry = require('./tool-registry');
const safety = require('./safety');

function toolCapabilities() {
  return toolRegistry.listTools().map((t) => {
    const configKeys = Array.isArray(t.configKeys) ? t.configKeys : (t.envKey ? [t.envKey] : []);
    return {
      type: 'tool',
      name: t.name,
      status: typeof t.status === 'function' ? t.status() : 'builtin',
      mode: typeof t.mode === 'function' ? t.mode() : (t.mode || null),
      envKey: t.envKey || null,
      // Go-live config: which env vars wire this integration up, and whether each
      // is currently set (booleans only — never the secret values).
      configKeys,
      configKeysSet: configKeys.map((k) => ({ key: k, set: !!process.env[k] })),
    };
  });
}

function summary() {
  const caps = toolCapabilities();
  const by = { live: 0, mock: 0, unimplemented: 0, builtin: 0 };
  for (const c of caps) by[c.status] = (by[c.status] || 0) + 1;
  return {
    total: caps.length,
    safetyGated: safety.gated,
    safetyCategory: safety.category || null,
    liveBlocked: safety.liveBlocked(),
    ...by,
  };
}

module.exports = { toolCapabilities, summary };

