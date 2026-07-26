/**
 * Unit tests for the Phase 3 GCP integrations, mocking the underlying GCP
 * SDK clients (no real network/credentials needed): GCS storage driver,
 * Cloud Tasks enqueue + push-token verification, Secret Manager.
 */

describe('lib/storage.js — GCS driver', () => {
  const fileMocks = { save: jest.fn(), createReadStream: jest.fn(), delete: jest.fn(), getSignedUrl: jest.fn() };
  const bucketMock = { file: jest.fn(() => fileMocks) };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.STORAGE_DRIVER = 'gcs';
    process.env.STORAGE_BUCKET = 'test-bucket';
    process.env.GCP_PROJECT_ID = 'test-project';
    jest.doMock('@google-cloud/storage', () => ({
      Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn(() => bucketMock) })),
    }));
  });

  afterEach(() => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.STORAGE_BUCKET;
    delete process.env.GCP_PROJECT_ID;
  });

  test('putObject writes through bucket.file().save()', async () => {
    const storage = require('../../lib/storage');
    const result = await storage.putObject({ key: 'org1/file.pdf', body: Buffer.from('hi'), contentType: 'application/pdf' });
    expect(fileMocks.save).toHaveBeenCalledWith(Buffer.from('hi'), expect.objectContaining({ contentType: 'application/pdf' }));
    expect(result).toEqual({ key: 'org1/file.pdf', provider: 'gcs' });
  });

  test('gcsUri returns a gs:// reference only on the gcs driver', () => {
    const storage = require('../../lib/storage');
    expect(storage.gcsUri('org1/file.pdf')).toBe('gs://test-bucket/org1/file.pdf');
  });

  test('deleteObject calls bucket.file().delete()', async () => {
    const storage = require('../../lib/storage');
    await storage.deleteObject('org1/file.pdf');
    expect(fileMocks.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  test('signedDownloadUrl calls bucket.file().getSignedUrl()', async () => {
    fileMocks.getSignedUrl.mockResolvedValue(['https://storage.googleapis.com/signed']);
    const storage = require('../../lib/storage');
    const url = await storage.signedDownloadUrl('org1/file.pdf', 60);
    expect(url).toBe('https://storage.googleapis.com/signed');
    expect(fileMocks.getSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ action: 'read' }));
  });
});

describe('lib/storage.js — local driver (gcsUri is null)', () => {
  test('gcsUri returns null when not on the gcs driver', () => {
    jest.resetModules();
    delete process.env.STORAGE_DRIVER;
    const storage = require('../../lib/storage');
    expect(storage.gcsUri('anything')).toBeNull();
  });
});

describe('lib/cloud-tasks.js', () => {
  const createTaskMock = jest.fn();
  const queuePathMock = jest.fn(() => 'projects/p/locations/l/queues/q');

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GCP_PROJECT_ID = 'test-project';
    process.env.CLOUD_TASKS_INVOKER_SA = 'invoker@test-project.iam.gserviceaccount.com';
    jest.doMock('@google-cloud/tasks', () => ({
      CloudTasksClient: jest.fn().mockImplementation(() => ({ queuePath: queuePathMock, createTask: createTaskMock })),
    }));
  });

  afterEach(() => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.CLOUD_TASKS_INVOKER_SA;
  });

  test('isConfigured requires both GCP_PROJECT_ID and CLOUD_TASKS_INVOKER_SA', () => {
    const cloudTasks = require('../../lib/cloud-tasks');
    expect(cloudTasks.isConfigured()).toBe(true);
    delete process.env.CLOUD_TASKS_INVOKER_SA;
    jest.resetModules();
    const reloaded = require('../../lib/cloud-tasks');
    expect(reloaded.isConfigured()).toBe(false);
  });

  test('enqueueTask builds an OIDC-authenticated push task', async () => {
    createTaskMock.mockResolvedValue([{ name: 'projects/p/locations/l/queues/q/tasks/t1' }]);
    const cloudTasks = require('../../lib/cloud-tasks');
    const result = await cloudTasks.enqueueTask({ queueName: 'q', targetUrl: 'https://example.com/api/jobs/process-task', payload: { a: 1 } });
    expect(result.taskName).toBe('projects/p/locations/l/queues/q/tasks/t1');
    const [[{ task }]] = createTaskMock.mock.calls;
    expect(task.httpRequest.url).toBe('https://example.com/api/jobs/process-task');
    expect(task.httpRequest.oidcToken.serviceAccountEmail).toBe('invoker@test-project.iam.gserviceaccount.com');
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual({ a: 1 });
  });

  test('throws clearly when not configured rather than silently no-op', async () => {
    delete process.env.CLOUD_TASKS_INVOKER_SA;
    jest.resetModules();
    const cloudTasks = require('../../lib/cloud-tasks');
    await expect(cloudTasks.enqueueTask({ queueName: 'q', targetUrl: 'https://x', payload: {} }))
      .rejects.toThrow(/not configured/);
  });
});

describe('lib/cloud-tasks.js — verifyPushToken', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GCP_PROJECT_ID = 'test-project';
    process.env.CLOUD_TASKS_INVOKER_SA = 'invoker@test-project.iam.gserviceaccount.com';
  });
  afterEach(() => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.CLOUD_TASKS_INVOKER_SA;
  });

  test('rejects a token whose email does not match the configured invoker', async () => {
    jest.doMock('google-auth-library', () => ({
      OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({ email: 'someone-else@evil.example.com' }) }),
      })),
    }));
    const cloudTasks = require('../../lib/cloud-tasks');
    await expect(cloudTasks.verifyPushToken('fake-token', 'https://example.com')).rejects.toThrow(/does not match/);
  });

  test('accepts a token whose email matches the configured invoker', async () => {
    jest.doMock('google-auth-library', () => ({
      OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({ email: 'invoker@test-project.iam.gserviceaccount.com' }) }),
      })),
    }));
    const cloudTasks = require('../../lib/cloud-tasks');
    const payload = await cloudTasks.verifyPushToken('fake-token', 'https://example.com');
    expect(payload.email).toBe('invoker@test-project.iam.gserviceaccount.com');
  });
});

describe('lib/secret-manager.js', () => {
  const accessSecretVersionMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GCP_PROJECT_ID = 'test-project';
    jest.doMock('@google-cloud/secret-manager', () => ({
      SecretManagerServiceClient: jest.fn().mockImplementation(() => ({ accessSecretVersion: accessSecretVersionMock })),
    }));
  });
  afterEach(() => { delete process.env.GCP_PROJECT_ID; });

  test('getSecret reads and decodes the payload, then caches it', async () => {
    accessSecretVersionMock.mockResolvedValue([{ payload: { data: Buffer.from('sup3r-secret') } }]);
    const secretManager = require('../../lib/secret-manager');
    const value = await secretManager.getSecret('db-password');
    expect(value).toBe('sup3r-secret');
    expect(accessSecretVersionMock).toHaveBeenCalledWith({ name: 'projects/test-project/secrets/db-password/versions/latest' });

    // Second call within the TTL should hit the cache, not the API again.
    await secretManager.getSecret('db-password');
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1);
  });

  test('throws when GCP_PROJECT_ID is not set', async () => {
    delete process.env.GCP_PROJECT_ID;
    jest.resetModules();
    const secretManager = require('../../lib/secret-manager');
    await expect(secretManager.getSecret('x')).rejects.toThrow(/not configured/);
  });
});

describe('routes/jobs.js — Cloud Tasks push endpoint', () => {
  let app;
  const verifyPushTokenMock = jest.fn();
  const runJobMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('../../lib/cloud-tasks', () => ({
      isConfigured: () => true,
      verifyPushToken: verifyPushTokenMock,
    }));
    jest.doMock('../../lib/worker', () => ({ runJob: runJobMock }));
    const express = require('express');
    const jobsRoutes = require('../../routes/jobs');
    const { errorMiddleware } = require('../../lib/validate');
    app = express();
    app.use(express.json());
    app.use('/api/jobs', jobsRoutes);
    app.use(errorMiddleware);
  });

  test('rejects a request with no Authorization header', async () => {
    const request = require('supertest');
    const res = await request(app).post('/api/jobs/process-task').send({});
    expect(res.status).toBe(401);
    expect(verifyPushTokenMock).not.toHaveBeenCalled();
  });

  test('runs the job when the OIDC token verifies', async () => {
    verifyPushTokenMock.mockResolvedValue({ email: 'invoker@test-project.iam.gserviceaccount.com' });
    runJobMock.mockResolvedValue();
    const request = require('supertest');
    const res = await request(app).post('/api/jobs/process-task').set('Authorization', 'Bearer faketoken').send({ recordId: 'r1' });
    expect(res.status).toBe(200);
    expect(runJobMock).toHaveBeenCalledWith({ recordId: 'r1' });
  });

  test('propagates a verification failure as a non-200 response, does not run the job', async () => {
    verifyPushTokenMock.mockRejectedValue(new Error('invalid token'));
    const request = require('supertest');
    const res = await request(app).post('/api/jobs/process-task').set('Authorization', 'Bearer badtoken').send({});
    expect(res.status).not.toBe(200);
    expect(runJobMock).not.toHaveBeenCalled();
  });
});
