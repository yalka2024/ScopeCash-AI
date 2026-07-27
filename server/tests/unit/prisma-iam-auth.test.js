/**
 * lib/prisma.js#createPrismaClientWithIamAuth builds a SEPARATE raw
 * PrismaClient from the module's default `base` export. withRls() and
 * tenantTransaction() both used to close over the module-level `base`
 * unconditionally — a real bug once a second raw client exists (this
 * factory), since every RLS-guarded query and every tenantTransaction()
 * call would silently run its SET LOCAL + actual query against the WRONG
 * connection pool. This test guards specifically against that regression:
 * it never touches a real database (both @prisma/client and the Cloud SQL
 * connector are mocked).
 */
jest.mock('@prisma/client', () => {
  const instances = [];
  return {
    PrismaClient: jest.fn().mockImplementation((opts) => {
      let proxied;
      const instance = {
        adapter: opts && opts.adapter,
        $transaction: jest.fn(async (fnOrArray) => (
          typeof fnOrArray === 'function' ? fnOrArray(proxied) : Promise.all(fnOrArray)
        )),
        $executeRaw: jest.fn(),
      };
      instance.$extends = jest.fn(() => proxied); // Prisma's real $extends wraps but delegates; a same-object stub is enough here
      // Any unmocked model access (e.g. tx.sourceDocument.findMany(...), which
      // $allOperations calls for real) resolves to a harmless fake result
      // instead of throwing "cannot read property of undefined".
      proxied = new Proxy(instance, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return new Proxy({}, { get: () => jest.fn(async () => 'mock-model-result') });
        },
      });
      instances.push(proxied);
      return proxied;
    }),
    __instances: instances,
  };
});
jest.mock('@prisma/adapter-better-sqlite3', () => ({
  PrismaBetterSqlite3: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation((poolOrConfig, opts) => ({ poolOrConfig, opts })),
}));
jest.mock('../../lib/cloud-sql-connector', () => ({
  createIamAuthPool: jest.fn(async () => ({ pool: { fakePool: true }, connector: { close: jest.fn() } })),
}));

const { __instances } = require('@prisma/client');
const { createIamAuthPool } = require('../../lib/cloud-sql-connector');
const prisma = require('../../lib/prisma');
const { runWithOrg } = require('../../lib/tenant-context');

describe('createPrismaClientWithIamAuth', () => {
  test('builds a genuinely separate raw client from the module\'s default export', async () => {
    const defaultRawClient = __instances[0]; // the module's own `base`, constructed at require() time
    expect(defaultRawClient).toBeDefined();

    const { client } = await prisma.createPrismaClientWithIamAuth({
      instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app',
    });

    expect(createIamAuthPool).toHaveBeenCalledWith({ instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app' });
    const iamRawClient = __instances[__instances.length - 1];
    expect(iamRawClient).not.toBe(defaultRawClient);
    expect(client).toBeDefined();
  });

  test('regression: tenantTransaction on the IAM-auth client runs against ITS OWN connection, never the default export\'s', async () => {
    const defaultRawClient = __instances[0];
    const { client } = await prisma.createPrismaClientWithIamAuth({
      instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app',
    });
    const iamRawClient = __instances[__instances.length - 1];

    await client.tenantTransaction(async () => 'ok');

    expect(iamRawClient.$transaction).toHaveBeenCalledTimes(1);
    expect(defaultRawClient.$transaction).not.toHaveBeenCalled();
  });

  test('regression: RLS query extension on the IAM-auth client opens its transaction against ITS OWN connection', async () => {
    const defaultRawClient = __instances[0];
    const { client } = await prisma.createPrismaClientWithIamAuth({
      instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app',
    });
    const iamRawClient = __instances[__instances.length - 1];

    // withRls() calls rawClient.$extends({query: {$allOperations}}) — invoke
    // that captured handler directly to exercise the same code path a real
    // query would, without needing a real Prisma model/operation. Needs a
    // real org context or the fail-closed early-return skips the
    // transaction entirely (see lib/prisma.js's $allOperations) — that's
    // the correct, separately-tested no-context behavior, not what this
    // test is checking.
    const extendConfig = iamRawClient.$extends.mock.calls[0][0];
    await runWithOrg('org-1', async () => {
      await extendConfig.query.$allOperations({
        model: 'SourceDocument', operation: 'findMany', args: {}, query: jest.fn(async () => []),
      });
    });

    expect(iamRawClient.$transaction).toHaveBeenCalledTimes(1);
    expect(defaultRawClient.$transaction).not.toHaveBeenCalled();
  });
});
