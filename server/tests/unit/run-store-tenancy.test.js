/**
 * Cross-tenant IDOR regression guard for lib/run-store.js (audit finding F-2).
 *
 * `get(id)` was a bare id lookup with no org filter, reachable by any
 * authenticated user of any org via GET /api/workflows/runs/:id,
 * POST /api/workflows/runs/:id/cancel, GET /api/goals/:id,
 * POST /api/goals/:id/approve and GET /api/agents/runs/:id — so a stranger
 * could read another tenant's run input/output, cancel their running
 * workflow, or approve and EXECUTE their plan.
 *
 * The in-process cache is what made it exploitable even on Postgres with RLS
 * enabled: a run cached by org A's request was returned to org B without the
 * query ever reaching the database, so the RLS policy never evaluated. That
 * is why the check lives on the returned object rather than being delegated
 * to RLS — a Map cannot be protected by a database policy. The cache-hit
 * path is therefore the most important case below.
 */
const crypto = require('crypto');
const store = require('../../lib/run-store');

const uid = (p) => `${p}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

async function seedRun(orgId) {
  const id = uid('run');
  await store.save({ id, kind: 'workflow', orgId, status: 'running', input: { secret: 'tenant-only' } });
  return id;
}

describe('run-store.get tenant scoping', () => {
  test('the owning org can read its own run', async () => {
    const orgA = uid('orgA');
    const id = await seedRun(orgA);
    const run = await store.get(id, { orgId: orgA });
    expect(run).toBeTruthy();
    expect(run.id).toBe(id);
  });

  test('another org gets null — not the run', async () => {
    const orgA = uid('orgA');
    const id = await seedRun(orgA);
    expect(await store.get(id, { orgId: uid('orgB') })).toBeNull();
  });

  test('CACHE HIT path is scoped too — the bug that defeated RLS', async () => {
    const orgA = uid('orgA');
    const id = await seedRun(orgA);
    // Warm the cache as the owner, exactly as org A's own request would.
    expect(await store.get(id, { orgId: orgA })).toBeTruthy();
    // Now the attacker's request: served from cache, never reaching the DB.
    expect(await store.get(id, { orgId: uid('orgB') })).toBeNull();
  });

  test('omitting orgId throws rather than silently returning everything', async () => {
    // An omission must be a loud mistake, not a quiet cross-tenant read.
    const id = await seedRun(uid('orgA'));
    await expect(store.get(id)).rejects.toThrow(/requires an explicit orgId/);
  });

  test('orgId: null is an explicit, deliberate internal bypass', async () => {
    // The runtime resuming its own run has no request org; that path must
    // still work, but only when it asks for it in so many words.
    const orgA = uid('orgA');
    const id = await seedRun(orgA);
    expect(await store.get(id, { orgId: null })).toBeTruthy();
  });

  test('a missing run is null for everyone, leaking no existence signal', async () => {
    expect(await store.get(uid('nope'), { orgId: uid('org') })).toBeNull();
  });
});
