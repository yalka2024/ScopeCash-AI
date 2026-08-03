/**
 * Boot-time RLS assertion.
 *
 * RLS is documented throughout this codebase as the hard database-level
 * backstop under the app's own `where: { orgId }` scoping. Nothing ever
 * checked it was actually applied — and `docker-compose.yml` genuinely
 * started the server with `prisma migrate deploy`, which creates the tables
 * and never runs rls.sql. That deployment looked identical to a protected
 * one until the first cross-tenant read.
 */
const prisma = require('../../lib/prisma');
const rlsAssert = require('../../lib/rls-assert');

const OLD_ENV = { ...process.env };
afterEach(() => { process.env = { ...OLD_ENV }; jest.restoreAllMocks(); });

describe('checkRlsPolicies', () => {
  test('is a no-op on SQLite — no RLS exists there, by design', async () => {
    process.env.DATABASE_URL = 'file:./test.db';
    const res = await rlsAssert.checkRlsPolicies();
    expect(res.applicable).toBe(false);
    expect(res.policyCount).toBeNull();
  });

  test('counts tenant_isolation policies on Postgres', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue([{ count: 42 }]);
    const res = await rlsAssert.checkRlsPolicies();
    expect(res).toMatchObject({ applicable: true, policyCount: 42 });
  });

  test('an unreadable pg_policies is "unknown", not "absent"', async () => {
    // A permissions quirk on the metadata view must not take down a healthy
    // deployment by being mistaken for missing policies.
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockRejectedValue(new Error('permission denied'));
    const res = await rlsAssert.checkRlsPolicies();
    expect(res.applicable).toBe(true);
    expect(res.policyCount).toBeNull();
    expect(res.error).toMatch(/permission denied/);
  });
});

describe('assertRlsAtBoot', () => {
  test('THROWS in production when policies are provably absent', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue([{ count: 0 }]);
    await expect(rlsAssert.assertRlsAtBoot({ isProduction: true }))
      .rejects.toThrow(/Row-Level Security policies are ABSENT/);
  });

  test('the production error names the command that fixes it', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue([{ count: 0 }]);
    try {
      await rlsAssert.assertRlsAtBoot({ isProduction: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('rls_policies_missing');
      expect(e.message).toMatch(/db:postgres:rls/);
      // The subtlety that caused this: migrate deploy is not enough.
      expect(e.message).toMatch(/migrate deploy/);
    }
  });

  test('passes silently when policies are present', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue([{ count: 44 }]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(rlsAssert.assertRlsAtBoot({ isProduction: true })).resolves.toMatchObject({ policyCount: 44 });
    expect(log).toHaveBeenCalled();
  });

  test('does NOT throw when the check itself is unreadable, even in production', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockRejectedValue(new Error('no view'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(rlsAssert.assertRlsAtBoot({ isProduction: true })).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
  });

  test('warns rather than throwing outside production, so dev still runs', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue([{ count: 0 }]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(rlsAssert.assertRlsAtBoot({ isProduction: false })).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
  });
});
