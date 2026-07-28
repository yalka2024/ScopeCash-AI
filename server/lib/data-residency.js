/**
 * Data-residency runtime enforcement.
 *
 * Until now residency was DECLARED (lib/trust-pack.js publishes
 * DATA_RESIDENCY_REGION on an unauthenticated trust endpoint) and PLACED
 * (Terraform pins Cloud SQL, GCS and Secret Manager replicas to var.region).
 * Nothing checked that the two agree. So a deployment could set
 * DATA_RESIDENCY_REGION=europe-west1 while GCP_LOCATION and the bucket stayed
 * us-central1, and the platform would publish a residency claim to customers
 * that its own infrastructure contradicted — the worst failure mode for a
 * compliance assertion, because it is invisible and it is in writing.
 *
 * This closes that: the declared region and the regions actually in use are
 * compared at boot. Mismatch fails closed in production (refusing to start is
 * strictly better than serving under a false compliance claim) and warns
 * loudly elsewhere, so local dev and tests are unaffected.
 *
 * Scope, stated honestly: this enforces DEPLOYMENT-level residency — one
 * region for the whole install. It is NOT per-tenant residency. Selling
 * "your data stays in the EU" to one customer while another is in the US
 * needs a per-org region column and region-scoped buckets/instances, which
 * is a product decision and a migration, not a boot check.
 */

/** Vertex's global endpoint is genuinely non-regional; lib/vertex-ai.js
 * documents that the chat path uses it. Treated as a known exemption rather
 * than a mismatch so it can't be mistaken for a misconfiguration. */
const NON_REGIONAL = new Set(['global', '']);

function normalize(r) {
  return String(r == null ? '' : r).trim().toLowerCase();
}

/**
 * Compare the declared residency region against every region actually
 * configured. Returns { ok, declared, mismatches: [{ setting, value }] }.
 *
 * Only compares what is actually set — an unset GCP_LOCATION is a separate
 * configuration problem, not a residency violation, and reporting it here
 * would bury the real signal.
 */
function checkResidency(env = process.env) {
  const declared = normalize(env.DATA_RESIDENCY_REGION);
  // No declaration means no claim is being published, so nothing to violate.
  if (!declared) return { ok: true, declared: null, mismatches: [] };

  const candidates = [
    ['GCP_LOCATION', env.GCP_LOCATION],
    ['CLOUD_SQL_INSTANCE', regionFromConnectionName(env.CLOUD_SQL_INSTANCE || env.CLOUD_SQL_CONNECTION_NAME)],
  ];

  const mismatches = [];
  for (const [setting, raw] of candidates) {
    const value = normalize(raw);
    if (!value || NON_REGIONAL.has(value)) continue;
    if (value !== declared) mismatches.push({ setting, value });
  }
  return { ok: mismatches.length === 0, declared, mismatches };
}

/** "project:region:instance" -> "region"; null for anything else. */
function regionFromConnectionName(name) {
  if (!name) return null;
  const parts = String(name).split(':');
  return parts.length === 3 ? parts[1] : null;
}

/**
 * Boot gate. Called from index.js before the server accepts traffic.
 * Throws in production on mismatch (the caller's start() already fails
 * closed); warns otherwise so tests and local dev are unaffected.
 */
function assertResidencyAtBoot({ env = process.env, isProduction = env.NODE_ENV === 'production' } = {}) {
  const result = checkResidency(env);
  if (result.ok) return result;

  const detail = result.mismatches.map((m) => `${m.setting}=${m.value}`).join(', ');
  const message = `Data residency mismatch: DATA_RESIDENCY_REGION=${result.declared} but ${detail}. `
    + 'The trust endpoint publishes the declared region to customers, so serving with this mismatch '
    + 'would put a false compliance claim in writing.';

  if (isProduction) {
    const err = new Error(message);
    err.code = 'data_residency_mismatch';
    throw err;
  }
  console.warn(JSON.stringify({ severity: 'WARNING', type: 'data_residency_mismatch', ...result }));
  return result;
}

module.exports = { checkResidency, assertResidencyAtBoot, regionFromConnectionName };
