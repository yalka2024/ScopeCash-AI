/**
 * Cloud Logging special fields. These field names are contractual — Cloud
 * Logging only special-cases the exact spellings, so a typo silently
 * degrades the log line back to opaque payload with no visible failure.
 */
const gcp = require('../../lib/gcp-logging');

const OLD_ENV = { ...process.env };
afterEach(() => { process.env = { ...OLD_ENV }; });

function mkReq(headers = {}) {
  return {
    method: 'GET', originalUrl: '/api/projects?page=2', requestId: 'req-1',
    ip: '203.0.113.9', protocol: 'https', headers: { 'user-agent': 'jest', ...headers },
  };
}

describe('accessLogEntry', () => {
  test('maps status to severity so severity-based alerts can match', () => {
    expect(gcp.severityForStatus(200)).toBe('INFO');
    expect(gcp.severityForStatus(302)).toBe('INFO');
    expect(gcp.severityForStatus(404)).toBe('WARNING');
    expect(gcp.severityForStatus(500)).toBe('ERROR');
    expect(gcp.severityForStatus(503)).toBe('ERROR');
  });

  test('preserves the original log shape so existing tooling still matches', () => {
    const e = gcp.accessLogEntry(mkReq(), { statusCode: 200 }, 42);
    expect(e.type).toBe('http');
    expect(e.requestId).toBe('req-1');
    expect(e.method).toBe('GET');
    expect(e.path).toBe('/api/projects?page=2');
    expect(e.status).toBe(200);
    expect(e.ms).toBe(42);
  });

  test('emits an httpRequest object with latency in the duration format Cloud Logging expects', () => {
    const e = gcp.accessLogEntry(mkReq(), { statusCode: 201 }, 1500);
    expect(e.httpRequest).toEqual({
      requestMethod: 'GET',
      requestUrl: '/api/projects?page=2',
      status: 201,
      latency: '1.500s',      // seconds with an 's' suffix, not milliseconds
      userAgent: 'jest',
      remoteIp: '203.0.113.9',
      protocol: 'https',
    });
  });
});

describe('trace correlation', () => {
  test('parses X-Cloud-Trace-Context into fully-qualified trace and span fields', () => {
    process.env.GCP_PROJECT_ID = 'my-proj';
    const f = gcp.traceFields(mkReq({ 'x-cloud-trace-context': 'abc123def456/7891011;o=1' }));
    expect(f['logging.googleapis.com/trace']).toBe('projects/my-proj/traces/abc123def456');
    expect(f['logging.googleapis.com/spanId']).toBe('7891011');
  });

  test('omits trace fields entirely when the project id is unknown', () => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    // A trace field without the right project prefix is silently dropped by
    // Cloud Logging, so a half-formed one is worse than none.
    expect(gcp.traceFields(mkReq({ 'x-cloud-trace-context': 'abc/1;o=1' }))).toEqual({});
  });

  test('omits trace fields off-GCP, where the header is absent', () => {
    process.env.GCP_PROJECT_ID = 'my-proj';
    expect(gcp.traceFields(mkReq())).toEqual({});
  });

  test('handles a trace header with no span without emitting a bogus spanId', () => {
    process.env.GCP_PROJECT_ID = 'my-proj';
    const f = gcp.traceFields(mkReq({ 'x-cloud-trace-context': 'abc123' }));
    expect(f['logging.googleapis.com/trace']).toBe('projects/my-proj/traces/abc123');
    expect(f['logging.googleapis.com/spanId']).toBeUndefined();
  });
});
