/**
 * Tool / integration adapter: TOTPMFAProvider
 * TOTP-based MFA enrollment, challenge, and verification for all user accounts.
 *
 * Generated for ScopeCash AI.
 *
 * This is a PORT with two adapters:
 *   • mockRun  — deterministic, clearly-labeled fake data so the platform runs
 *                end-to-end today. Every result is tagged `_mock: true`.
 *   • realRun  — YOUR real integration. Implement it, flip `realImplemented` to
 *                true, and switch this tool live with:  INTEGRATION_TOTPMFAPROVIDER_MODE=live
 *
 * It NEVER silently returns fake data dressed as real: in live mode an
 * unimplemented realRun() THROWS, so nothing downstream mistakes a guess for truth.
 */
const NAME = "TOTPMFAProvider";
const ENV_KEY = 'INTEGRATION_TOTPMFAPROVIDER_MODE';
const safety = require('../safety');
const prisma = require('../prisma');
const { verifyTotp } = require('../security');
const { decrypt } = require('../encryption');

const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Pure local computation (RFC 6238, see lib/security.js) once a user's
// stored secret is loaded — no external service to be unconfigured.
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

// Real TOTP verification against the CALLER's own stored, encrypted MFA
// secret (the same lib/security.js#verifyTotp logic routes/auth.js already
// uses at login). Declared as a challenge/verification tool, not enrollment
// — enrollment stays on the dedicated, session-authenticated
// /api/auth/mfa/setup + /mfa/enable endpoints, which correctly require the
// caller to be proving they hold the secret they're enrolling, not just
// passing a user_id. This tool never fabricates backup codes: the product
// doesn't implement backup codes today, so that output is honestly null
// rather than invented.
//
// userId comes ONLY from ctx.userId (server-derived from the verified
// session, see routes/tools.js), never from input.user_id — an earlier
// version of this function used `input.user_id || ctx.userId`, letting any
// authenticated caller supply an arbitrary user_id in the request body and
// use this as a cross-tenant TOTP verification oracle against any other
// user's decrypted MFA secret. There is no legitimate reason for this tool
// to verify anyone but the caller; an admin-initiated reset/verification
// for a different user would need its own explicitly role-gated endpoint,
// not a generic input field with no authorization check at all.
async function realRun(input, ctx) {
  const userId = ctx && ctx.userId;
  const totpCode = input && input.totp_code;
  if (!userId) {
    const err = new Error(`${NAME}: user_id is required.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  if (!totpCode) {
    const err = new Error(`${NAME}: totp_code is required.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true, mfaSecret: true } });
  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    return { mfa_status: 'not_enrolled', backup_codes: null };
  }
  const valid = verifyTotp(decrypt(user.mfaSecret), totpCode);
  return { mfa_status: valid ? 'verified' : 'invalid', backup_codes: null };
}

module.exports = {
  name: NAME,
  description: "TOTP-based MFA verification for the calling user's own account.",
  inputs: ["totp_code"],
  outputs: ["mfa_status", "backup_codes"],
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

