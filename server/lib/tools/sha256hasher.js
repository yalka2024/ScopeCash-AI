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
const crypto = require('crypto');

const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Pure local computation — no external service to be unconfigured.
function status() {
  return currentMode() === 'mock' ? 'mock' : 'live';
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

// Real hash — file_bytes arrives as base64 (this tool is invoked over a JSON
// HTTP API, which can't carry raw binary) or already as a Buffer if called
// in-process.
async function realRun(input, ctx) {
  const { file_bytes } = input || {};
  if (!file_bytes) {
    const err = new Error(`${NAME}: file_bytes is required.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  const buffer = Buffer.isBuffer(file_bytes) ? file_bytes : Buffer.from(file_bytes, 'base64');
  const sha256_hex = crypto.createHash('sha256').update(buffer).digest('hex');
  return { sha256_hex };
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

