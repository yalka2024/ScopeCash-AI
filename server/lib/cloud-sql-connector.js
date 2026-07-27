/**
 * Cloud SQL IAM database authentication — builds a `pg.Pool` via the
 * official `@google-cloud/cloud-sql-connector`, using Cloud SQL's automatic
 * IAM DB authentication instead of a static database password: the
 * connector mints a short-lived OAuth2 token + mTLS client cert for the
 * runtime's own IAM identity (ADC — the Cloud Run service account in
 * production) and transparently rotates both for the life of the process.
 * No DB password is ever generated, stored, or passed anywhere.
 *
 * Opt-in, not yet wired into lib/prisma.js's default boot path: building
 * this pool is unavoidably async (the connector fetches instance metadata
 * and an initial cert on first use), while lib/prisma.js constructs its
 * exported client synchronously at require() time so every existing
 * consumer (`const prisma = require('../lib/prisma')`, used across ~20
 * route files) keeps working unchanged. Wiring this in for real means
 * restructuring index.js's startup to await this pool BEFORE requiring any
 * route module — a real, higher-blast-radius change deliberately deferred
 * until there's a live GCP project to validate the new boot sequence
 * against (see TODO.md). `createPrismaClientWithIamAuth()` in
 * lib/prisma.js is the ready-to-call factory for that follow-up.
 *
 * Required Terraform-provisioned state (deploy/terraform-gcp/main.tf, gated
 * behind var.cloud_sql_iam_auth): the Cloud SQL instance has
 * `cloudsql.iam_authentication=on`, a `google_sql_user` of type
 * `CLOUD_IAM_SERVICE_ACCOUNT` exists for the runtime service account, and
 * that service account holds `roles/cloudsql.instanceUser`.
 */

/**
 * @param {object} opts
 * @param {string} opts.instanceConnectionName - "project:region:instance"
 * @param {string} opts.iamUser - IAM DB username: for a service account,
 *   its email WITHOUT the ".gserviceaccount.com" suffix (per Cloud SQL's
 *   automatic IAM DB auth convention — see the connector's own README).
 * @param {string} opts.database - target database name.
 * @param {number} [opts.max] - pool size (defaults to 5, matching the
 *   connector's own documented example — a Cloud SQL instance's own
 *   max_connections is the real ceiling, not this pool).
 * @returns {Promise<{pool: import('pg').Pool, connector: object}>} the ready
 *   pool plus the live Connector instance — callers must keep a reference
 *   to `connector` and call `connector.close()` on shutdown (it holds the
 *   background cert-refresh cycle open) alongside `pool.end()`.
 */
async function createIamAuthPool({ instanceConnectionName, iamUser, database, max = 5 }) {
  if (!instanceConnectionName) throw new Error('createIamAuthPool: instanceConnectionName is required ("project:region:instance")');
  if (!iamUser) throw new Error('createIamAuthPool: iamUser is required');
  if (!database) throw new Error('createIamAuthPool: database is required');

  const { Connector, AuthTypes } = require('@google-cloud/cloud-sql-connector');
  const { Pool } = require('pg');

  const connector = new Connector();
  const clientOpts = await connector.getOptions({ instanceConnectionName, authType: AuthTypes.IAM });
  const pool = new Pool({ ...clientOpts, user: iamUser, database, max });
  return { pool, connector };
}

module.exports = { createIamAuthPool };
