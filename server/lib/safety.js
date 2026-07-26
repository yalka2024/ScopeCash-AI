/**
 * Server-side safety status for ScopeCash AI.
 *
 * When `gated` is true this platform targets a safety-critical / regulated domain
 * and its domain/compliance logic is unvalidated scaffolding. Integration adapters
 * REFUSE live mode while gated unless an explicit, logged attestation override is
 * set — so a hollow medical/financial/legal scaffold cannot quietly operate as if
 * it were real. This is a hard block, not just the README/dashboard warning.
 */
'use strict';

const OVERRIDE_TOKEN = 'I_ACCEPT_UNVALIDATED_SCAFFOLD';

const SAFETY = {
  gated: false,
  category: '',
};

// Live mode is blocked on gated platforms unless the operator explicitly attests
// (SAFETY_OVERRIDE=I_ACCEPT_UNVALIDATED_SCAFFOLD) that the domain logic has been
// independently validated. The override is intentionally ugly and logged.
function liveBlocked() {
  if (!SAFETY.gated) return false;
  return process.env.SAFETY_OVERRIDE !== OVERRIDE_TOKEN;
}

function assertLiveAllowed(name) {
  if (liveBlocked()) {
    const e = new Error(
      `${name || 'integration'}: live mode BLOCKED — this is a SAFETY-GATED scaffold ` +
      `(${SAFETY.category}). Its domain/compliance logic is unvalidated. After independent ` +
      `validation by a qualified professional, set SAFETY_OVERRIDE=${OVERRIDE_TOKEN} to proceed.`
    );
    e.statusCode = 451;
    e.code = 'safety_gated';
    throw e;
  }
}

module.exports = { ...SAFETY, OVERRIDE_TOKEN, liveBlocked, assertLiveAllowed };

