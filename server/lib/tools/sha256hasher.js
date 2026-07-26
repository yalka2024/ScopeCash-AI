/**
 * Tool / integration adapter: SHA256Hasher
 * Computes SHA-256 hash of uploaded file bytes for duplicate detection and immutability verification.
 *
 * Generated for ScopeCash AI.
 *
 * This is a PORT with two adapters:
 *   • mockRun  — deterministic, clearly-labeled fake data so the platform runs
 *                end-to-end today. Every result is tagged `_mock: true`.
 *   • realRun  — YOUR real integration. Implement it, flip `realImplemented` to
 *                true, and switch this tool live with:  INTEGRATION_SHA256HASHER_MODE=live
 *
 * It NEVER silently returns fake data dressed as real: in live mode an
 * unimplemented realRun() THROWS, so nothing downstream mistakes a guess for truth.
 */
const NAME = "SHA256Hasher";
const ENV_KEY = 'INTEGRATION_SHA256HASHER_MODE';
const safety = require('../safety');

// Flip to `true` once realRun() is a genuine integration.
const realImplemented = false;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Three-state capability status: 'mock' | 'live' | 'unimplemented'.
function status() {
  if (currentMode() === 'mock') return 'mock';
  return realImplemented ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  // Deterministic, obviously-fake placeholder. Shape it toward `outputs` so
  // screens/agents render — but it is NOT real data.
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — implement realRun() and set ${ENV_KEY}=live to use the real ${NAME}`,
    input,
  };
}

async function realRun(input, ctx) {
  // TODO: implement the real SHA256Hasher integration (call the real API / data source).
  // Until then, live mode refuses rather than fake it.
  const err = new Error(`${NAME}: real integration not implemented — set ${ENV_KEY}=mock for demo data, or implement realRun().`);
  err.code = 'integration_unimplemented';
  err.statusCode = 501;
  throw err;
}

module.exports = {
  name: NAME,
  description: "Computes SHA-256 hash of uploaded file bytes for duplicate detection and immutability verification.",
  inputs: ["file_bytes"],
  outputs: ["sha256_hex"],
  envKey: ENV_KEY,
  configKeys: [ENV_KEY],
  realImplemented,
  mode: currentMode,
  status,

  /**
   * @param {object} input  keyed by the declared input names
   * @param {object} ctx    { userId, orgId, modelId }
   * @returns {Promise<object>}
   */
  async run(input, ctx) {
    if (currentMode() === 'live') {
      safety.assertLiveAllowed(NAME);   // hard-block live mode on safety-gated platforms
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};

