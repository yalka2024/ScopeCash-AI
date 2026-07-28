/**
 * Cloud SQL IAM auth on the real boot path.
 *
 * The implementation (lib/cloud-sql-connector.js + createPrismaClientWithIamAuth)
 * was complete and unit-tested but had ZERO production callers: nothing ever
 * invoked it, so every deployment used static-password auth regardless. What
 * was missing was the wiring, and the reason it was deferred is that building
 * the pool is async while lib/prisma.js constructs its export synchronously at
 * require() time.
 *
 * These tests cover that wiring: the env gate, fail-closed behaviour, that the
 * swap actually reaches a module that required prisma EARLIER (the whole point
 * of the Proxy indirection), and shutdown release. The real Cloud SQL IAM
 * handshake itself needs a live GCP instance and is not exercised here — the
 * connector is mocked.
 */
const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  jest.resetModules();
});

describe('initCloudSqlIamAuth', () => {
  test('is a no-op unless explicitly enabled, leaving the default client in place', async () => {
    delete process.env.CLOUD_SQL_IAM_AUTH;
    const prisma = require('../../lib/prisma');
    const before = prisma.__activeClient();
    const res = await prisma.initCloudSqlIamAuth();
    expect(res).toEqual({ enabled: false });
    expect(prisma.__activeClient()).toBe(before);
  });

  test('fails closed when enabled but misconfigured, rather than silently using password auth', async () => {
    process.env.CLOUD_SQL_IAM_AUTH = '1';
    delete process.env.CLOUD_SQL_INSTANCE;
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    const prisma = require('../../lib/prisma');
    await expect(prisma.initCloudSqlIamAuth()).rejects.toThrow(/CLOUD_SQL_INSTANCE/);
  });

  test('accepts CLOUD_SQL_CONNECTION_NAME, the name Terraform actually exports', async () => {
    // Regression guard: this function was written against CLOUD_SQL_INSTANCE
    // while deploy/terraform-gcp/main.tf has always set
    // CLOUD_SQL_CONNECTION_NAME. Because it fails closed, enabling
    // `cloud_sql_iam_auth = true` would have crash-looped the Cloud Run
    // service on boot. Both names must work.
    process.env.CLOUD_SQL_IAM_AUTH = '1';
    delete process.env.CLOUD_SQL_INSTANCE;
    process.env.CLOUD_SQL_CONNECTION_NAME = 'proj:us-central1:inst';
    process.env.CLOUD_SQL_IAM_USER = 'svc@proj.iam';
    delete process.env.CLOUD_SQL_DATABASE;   // must fall back, not throw

    const prisma = require('../../lib/prisma');
    prisma.createPrismaClientWithIamAuth = jest.fn().mockResolvedValue({
      client: { tenantTransaction: jest.fn() }, connector: { close: jest.fn() }, pool: { end: jest.fn() },
    });

    await expect(prisma.initCloudSqlIamAuth()).resolves.toEqual({ enabled: true });
    expect(prisma.createPrismaClientWithIamAuth).toHaveBeenCalledWith(
      expect.objectContaining({ instanceConnectionName: 'proj:us-central1:inst' }));
  });

  test('swaps the live client, and a consumer that required prisma BEFORE init sees the new one', async () => {
    process.env.CLOUD_SQL_IAM_AUTH = '1';
    process.env.CLOUD_SQL_INSTANCE = 'proj:us-central1:inst';
    process.env.CLOUD_SQL_IAM_USER = 'svc@proj.iam';
    process.env.CLOUD_SQL_DATABASE = 'scopecash';

    const prisma = require('../../lib/prisma');
    // Stand in for a route module: captures the export up front, exactly as
    // `const prisma = require('../lib/prisma')` does at module scope.
    const consumerHeldReference = prisma;
    const before = prisma.__activeClient();

    const fakeClient = { marker: 'iam-client', tenantTransaction: jest.fn() };
    const connector = { close: jest.fn() };
    const pool = { end: jest.fn() };
    prisma.createPrismaClientWithIamAuth = jest.fn().mockResolvedValue({ client: fakeClient, connector, pool });

    const res = await prisma.initCloudSqlIamAuth();
    expect(res).toEqual({ enabled: true });
    expect(prisma.createPrismaClientWithIamAuth).toHaveBeenCalledWith({
      instanceConnectionName: 'proj:us-central1:inst',
      iamUser: 'svc@proj.iam',
      database: 'scopecash',
    });

    expect(prisma.__activeClient()).not.toBe(before);
    // The reference captured before init resolves through to the new client —
    // this is what makes the swap work without any boot-order restructuring.
    expect(consumerHeldReference.marker).toBe('iam-client');
    // tenantTransaction must follow the swap too, or writes would keep going
    // through the old client's connection.
    expect(prisma.tenantTransaction).toBe(fakeClient.tenantTransaction);
  });

  test('shutdown releases the pool and the connector cert-refresh cycle', async () => {
    process.env.CLOUD_SQL_IAM_AUTH = '1';
    process.env.CLOUD_SQL_INSTANCE = 'proj:us-central1:inst';
    process.env.CLOUD_SQL_IAM_USER = 'svc@proj.iam';
    process.env.CLOUD_SQL_DATABASE = 'scopecash';

    const prisma = require('../../lib/prisma');
    const connector = { close: jest.fn() };
    const pool = { end: jest.fn() };
    prisma.createPrismaClientWithIamAuth = jest.fn().mockResolvedValue({
      client: { tenantTransaction: jest.fn() }, connector, pool,
    });

    await prisma.initCloudSqlIamAuth();
    await prisma.shutdownCloudSqlIamAuth();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(connector.close).toHaveBeenCalledTimes(1);

    // Idempotent — a second call (e.g. double SIGTERM) must not throw.
    await expect(prisma.shutdownCloudSqlIamAuth()).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test('shutdown is a no-op when IAM auth was never initialized', async () => {
    const prisma = require('../../lib/prisma');
    await expect(prisma.shutdownCloudSqlIamAuth()).resolves.toBeUndefined();
  });
});

describe('prisma export Proxy', () => {
  test('forwards model access and bound methods to the active client', async () => {
    const prisma = require('../../lib/prisma');
    // A real delegated model call still works through the trap.
    expect(typeof prisma.organization.count).toBe('function');
    expect(typeof prisma.$disconnect).toBe('function');
    expect(typeof prisma.tenantTransaction).toBe('function');
    expect(await prisma.organization.count()).toEqual(expect.any(Number));
  });
});
