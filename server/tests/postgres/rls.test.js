/**
 * Real-Postgres RLS regression suite — the class of test the SQLite suite
 * structurally cannot run, since SQLite has no RLS at all. This is exactly
 * how the Phase 10 billing.js/board-reports.js bugs (a route querying an
 * RLS-protected table with no tenant/system context established, silently
 * seeing zero rows instead of an error) went undetected: every existing
 * test ran against SQLite, where that code path just... worked, for the
 * wrong reason (no policy to violate).
 *
 * Requires DATABASE_URL to point at Postgres, migrated, with rls.sql
 * applied, connected as a NON-superuser role (superusers bypass RLS
 * regardless of policy — see .github/workflows/ci.yml for how CI sets
 * this up). Skips everything with a clear message if DATABASE_URL isn't
 * Postgres, so this file is safe to have around even if someone points
 * jest.postgres.config.js at the wrong database by mistake.
 *
 * Every runWithOrg/runWithSystemAccess callback below is `async` and
 * internally `await`s each Prisma call — never a sync arrow that just
 * returns a lazy Prisma promise (even wrapped in Promise.all). Prisma
 * calls are lazy: the actual dispatch happens when something awaits them,
 * which for a bare `() => prisma.x.create(...)` or
 * `() => Promise.all([...])` callback happens OUTSIDE the
 * AsyncLocalStorage `.run()` frame — silently losing tenant/system
 * context. This is a previously-documented gotcha in this codebase
 * (see STATUS.md Phase 1) and this file itself hit it during authoring
 * (RLS policy violations on INSERT) before being fixed to this shape.
 */
const crypto = require('crypto');

const isPg = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres'));
const d = isPg ? describe : describe.skip;

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

d('Postgres RLS', () => {
  let prisma, runWithOrg, runWithSystemAccess;

  beforeAll(() => {
    prisma = require('../../lib/prisma');
    ({ runWithOrg, runWithSystemAccess } = require('../../lib/tenant-context'));
  });
  afterAll(async () => { await prisma.$disconnect(); });

  test('a query with NO tenant/system context sees zero rows (fail-closed), not an error and not every org', async () => {
    const org = await runWithSystemAccess(async () => prisma.organization.create({ data: { name: uid('Org') } }));
    await runWithSystemAccess(async () => prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } }));

    // No runWithOrg / runWithSystemAccess wrapping here — this is exactly
    // the bug shape billing.js had: a query issued outside any tenant
    // context. Must NOT throw, and must NOT return the row.
    const rows = await prisma.customer.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(0);
  });

  test('runWithOrg(orgA) cannot see orgB rows even if the query forgets to filter by orgId (defense in depth)', async () => {
    const [orgA, orgB] = await runWithSystemAccess(async () => Promise.all([
      prisma.organization.create({ data: { name: uid('OrgA') } }),
      prisma.organization.create({ data: { name: uid('OrgB') } }),
    ]));
    await runWithSystemAccess(async () => {
      await prisma.customer.create({ data: { orgId: orgA.id, name: 'Customer of A' } });
      await prisma.customer.create({ data: { orgId: orgB.id, name: 'Customer of B' } });
    });

    // Deliberately NO where filter — simulates a route that forgot to
    // scope its query. RLS must be the backstop that keeps this safe.
    const seenFromA = await runWithOrg(orgA.id, async () => prisma.customer.findMany({}));
    expect(seenFromA.map((c) => c.name)).toEqual(['Customer of A']);

    const seenFromB = await runWithOrg(orgB.id, async () => prisma.customer.findMany({}));
    expect(seenFromB.map((c) => c.name)).toEqual(['Customer of B']);
  });

  test('regression: a real active Subscription is visible through attachTenant\'s tenant context (the billing.js bug)', async () => {
    const org = await runWithSystemAccess(async () => prisma.organization.create({ data: { name: uid('Org') } }));
    await runWithSystemAccess(async () => prisma.subscription.create({
      data: {
        orgId: org.id, planId: 'pro', status: 'active',
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    }));

    // Without tenant context: must NOT see it (this is what billing.js got
    // wrong before the fix — falling back to "no subscription" -> free tier).
    const withoutContext = await prisma.subscription.findFirst({ where: { orgId: org.id, status: 'active' } });
    expect(withoutContext).toBeNull();

    // With tenant context established (what attachTenant now does for
    // billing.js): must see the real row.
    const withContext = await runWithOrg(org.id, async () => prisma.subscription.findFirst({ where: { orgId: org.id, status: 'active' } }));
    expect(withContext).not.toBeNull();
    expect(withContext.planId).toBe('pro');
  });

  test('runWithSystemAccess sees rows across every org (the legitimate cross-tenant admin-report escape hatch)', async () => {
    const nameA = uid('Sys-visible-A');
    const nameB = uid('Sys-visible-B');
    const [orgA, orgB] = await runWithSystemAccess(async () => Promise.all([
      prisma.organization.create({ data: { name: uid('OrgA') } }),
      prisma.organization.create({ data: { name: uid('OrgB') } }),
    ]));
    await runWithSystemAccess(async () => {
      await prisma.customer.create({ data: { orgId: orgA.id, name: nameA } });
      await prisma.customer.create({ data: { orgId: orgB.id, name: nameB } });
    });

    const names = await runWithSystemAccess(async () => prisma.customer.findMany({
      where: { name: { in: [nameA, nameB] } },
    }));
    expect(names.map((c) => c.name).sort()).toEqual([nameA, nameB]);
  });
});

if (!isPg) {
  test('skipped: DATABASE_URL does not point at Postgres', () => {
    console.warn('[rls.test.js] DATABASE_URL is not Postgres — all RLS tests skipped. Run via `npm run test:postgres-rls` with a real Postgres DATABASE_URL to exercise this file.');
    expect(true).toBe(true);
  });
}
