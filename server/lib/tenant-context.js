/**
 * Per-request tenant context (AsyncLocalStorage).
 *
 * Carries the caller's orgId through the async call tree so lib/prisma.js can set
 * the Postgres `app.org_id` GUC for Row-Level Security WITHOUT threading orgId
 * through every function. `attachTenant` runs the rest of each request inside
 * `runWithOrg(orgId, next)`. Background jobs / seeds that must act tenant-scoped
 * can wrap their work in `runWithOrg` too; left unset, queries run unscoped
 * (which on Postgres + RLS means the `IS NULL` escape in prisma/rls.sql applies).
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithOrg(orgId, fn) {
  return storage.run({ orgId: orgId ? String(orgId) : null }, fn);
}

function currentOrgId() {
  const s = storage.getStore();
  return s && s.orgId ? s.orgId : null;
}

module.exports = { storage, runWithOrg, currentOrgId };

