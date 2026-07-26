/**
 * Per-request tenant context (AsyncLocalStorage).
 *
 * Carries the caller's orgId through the async call tree so lib/prisma.js can set
 * the Postgres `app.org_id` GUC for Row-Level Security WITHOUT threading orgId
 * through every function. `attachTenant` runs the rest of each request inside
 * `runWithOrg(orgId, next)`.
 *
 * RLS (prisma/rls.sql) is fail-closed: code that runs with neither `runWithOrg`
 * nor `runWithSystemAccess` sees ZERO rows on any org-scoped table on Postgres.
 * Genuinely tenant-spanning code (seed scripts, and a short, audited allowlist
 * of admin cross-tenant reports that truly need to aggregate across orgs) must
 * opt in explicitly via `runWithSystemAccess`. Prefer `runWithOrg(orgId, ...)`
 * per iteration when the work is really "loop over each org one at a time" —
 * that stays least-privilege instead of granting a blanket bypass.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithOrg(orgId, fn) {
  return storage.run({ orgId: orgId ? String(orgId) : null, systemAccess: false }, fn);
}

// Explicit, narrow escape from tenant scoping for code that must legitimately
// see across every organization. Never the default — always an opt-in call.
function runWithSystemAccess(fn) {
  return storage.run({ orgId: null, systemAccess: true }, fn);
}

function currentOrgId() {
  const s = storage.getStore();
  return s && s.orgId ? s.orgId : null;
}

function isSystemAccess() {
  const s = storage.getStore();
  return !!(s && s.systemAccess);
}

module.exports = { storage, runWithOrg, runWithSystemAccess, currentOrgId, isSystemAccess };

