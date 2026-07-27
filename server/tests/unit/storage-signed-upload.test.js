/**
 * Unit tests for lib/storage.js#signedUploadUrl — the real direct-to-
 * storage (GCS V4 / S3 presigned) PUT URL generator. lib/storage.js reads
 * STORAGE_DRIVER at module load time, so each driver is exercised via
 * jest.isolateModules() with the env var set beforehand, mocking only the
 * cloud SDK client construction (never real network calls).
 */

describe('signedUploadUrl', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.resetModules(); });

  test('GCS driver returns a real V4 write URL with the requested content type bound in', async () => {
    let storage;
    const getSignedUrl = jest.fn(async (opts) => {
      expect(opts.version).toBe('v4');
      expect(opts.action).toBe('write');
      expect(opts.contentType).toBe('image/jpeg');
      expect(typeof opts.expires).toBe('number');
      return ['https://storage.googleapis.com/signed-put-url'];
    });
    jest.doMock('@google-cloud/storage', () => ({
      Storage: jest.fn().mockImplementation(() => ({
        bucket: jest.fn().mockReturnValue({
          file: jest.fn().mockReturnValue({ getSignedUrl }),
        }),
      })),
    }));
    await jest.isolateModulesAsync(async () => {
      process.env.STORAGE_DRIVER = 'gcs';
      process.env.STORAGE_BUCKET = 'test-bucket';
      storage = require('../../lib/storage');
      const result = await storage.signedUploadUrl({ key: 'u1/abc-photo.jpg', contentType: 'image/jpeg', ttlSeconds: 300 });
      expect(result).toEqual({ url: 'https://storage.googleapis.com/signed-put-url', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  test('S3 driver returns a real presigned PUT URL', async () => {
    let storage;
    await jest.isolateModulesAsync(async () => {
      process.env.STORAGE_DRIVER = 's3';
      process.env.STORAGE_BUCKET = 'test-bucket';
      storage = require('../../lib/storage');
      storage.__signedUrlFn = jest.fn(async (client, cmd) => {
        expect(cmd.input.ContentType).toBe('application/pdf');
        return 'https://s3.amazonaws.com/test-bucket/signed-put-url';
      });
      const result = await storage.signedUploadUrl({ key: 'u1/abc-doc.pdf', contentType: 'application/pdf', ttlSeconds: 300 });
      expect(result).toEqual({ url: 'https://s3.amazonaws.com/test-bucket/signed-put-url', method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
    });
  });

  test('local driver returns null — no direct-to-storage tier to sign a URL for', async () => {
    let storage;
    await jest.isolateModulesAsync(async () => {
      process.env.STORAGE_DRIVER = 'local';
      storage = require('../../lib/storage');
      const result = await storage.signedUploadUrl({ key: 'u1/abc.txt', contentType: 'text/plain' });
      expect(result).toBeNull();
    });
  });
});
