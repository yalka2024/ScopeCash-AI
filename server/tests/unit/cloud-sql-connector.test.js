/**
 * Unit tests for lib/cloud-sql-connector.js#createIamAuthPool — verifies the
 * wiring against a mocked @google-cloud/cloud-sql-connector and pg (no real
 * GCP project or network access), since this is exactly the kind of code
 * that's easy to get subtly wrong (wrong authType enum, wrong pool options,
 * forgetting to pass the IAM-formatted user through).
 */
jest.mock('@google-cloud/cloud-sql-connector', () => ({
  Connector: jest.fn(),
  AuthTypes: { IAM: 'IAM' },
}));
jest.mock('pg', () => ({ Pool: jest.fn() }));

const { Connector } = require('@google-cloud/cloud-sql-connector');
const { Pool } = require('pg');
const { createIamAuthPool } = require('../../lib/cloud-sql-connector');

describe('createIamAuthPool', () => {
  let getOptions;
  let fakeStream;
  beforeEach(() => {
    jest.clearAllMocks();
    fakeStream = jest.fn();
    getOptions = jest.fn(async () => ({ stream: fakeStream, ssl: {} }));
    Connector.mockImplementation(() => ({ getOptions, close: jest.fn() }));
  });

  test('requests automatic IAM DB auth options for the given instance', async () => {
    await createIamAuthPool({ instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app' });
    expect(getOptions).toHaveBeenCalledWith({ instanceConnectionName: 'proj:us-central1:inst', authType: 'IAM' });
  });

  test('builds the Pool from the connector\'s options plus the IAM user, database, and pool size — no password anywhere', async () => {
    await createIamAuthPool({ instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app', max: 7 });
    expect(Pool).toHaveBeenCalledTimes(1);
    const poolArgs = Pool.mock.calls[0][0];
    expect(poolArgs.user).toBe('sa@proj.iam');
    expect(poolArgs.database).toBe('app');
    expect(poolArgs.max).toBe(7);
    expect(poolArgs.password).toBeUndefined();
    expect(poolArgs.stream).toBe(fakeStream); // connector's options passed through, not reconstructed
  });

  test('defaults pool size to 5 when max is omitted', async () => {
    await createIamAuthPool({ instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app' });
    expect(Pool.mock.calls[0][0].max).toBe(5);
  });

  test('returns both the pool and the live connector (caller must close both on shutdown)', async () => {
    const fakePool = { query: jest.fn() };
    Pool.mockImplementation(() => fakePool);
    const result = await createIamAuthPool({ instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam', database: 'app' });
    expect(result.pool).toBe(fakePool);
    expect(typeof result.connector.close).toBe('function');
  });

  test.each([
    ['instanceConnectionName', { iamUser: 'sa@proj.iam', database: 'app' }],
    ['iamUser', { instanceConnectionName: 'proj:us-central1:inst', database: 'app' }],
    ['database', { instanceConnectionName: 'proj:us-central1:inst', iamUser: 'sa@proj.iam' }],
  ])('rejects when %s is missing, before ever touching the network', async (missing, opts) => {
    await expect(createIamAuthPool(opts)).rejects.toThrow(new RegExp(missing));
    expect(Connector).not.toHaveBeenCalled();
  });
});
