/**
 * lib/email.js's console fallback (_sendConsole) is reachable in production
 * two ways: no real provider configured at all, or a real provider's send()
 * call throwing. Both previously logged the FULL envelope — including
 * `text`, which templates embed a raw verification/reset/invite token in —
 * unconditionally via console.log, regardless of NODE_ENV. That would leak
 * every such token straight into centralized production logs. Fixed to only
 * log the token-bearing fields outside production.
 */
const SECRET_TOKEN = 'super-secret-reset-token-should-never-leak-abc123';

function freshEmailModule() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../../lib/email');
  });
  return mod;
}

describe('lib/email.js redaction of console fallback', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  let logSpy, warnSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.RESEND_API_KEY;
    delete process.env.SENDGRID_API_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    jest.resetModules();
  });

  test('outside production, the token-bearing text is still logged (dev convenience preserved)', async () => {
    process.env.NODE_ENV = 'test';
    const email = freshEmailModule();
    await email.send({ to: 'dev@test.local', subject: 'Reset your password', text: `token=${SECRET_TOKEN}` });

    const allLogged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogged).toContain(SECRET_TOKEN);
  });

  test('in production with no provider configured, the token is never logged to console.log', async () => {
    process.env.NODE_ENV = 'production';
    const email = freshEmailModule();
    await email.send({ to: 'user@example.com', subject: 'Reset your password', text: `token=${SECRET_TOKEN}` });

    const allLogCalls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogCalls).not.toContain(SECRET_TOKEN);
    // Safe metadata should still surface for delivery observability, via warn.
    const allWarnCalls = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allWarnCalls).toContain('user@example.com');
    expect(allWarnCalls).not.toContain(SECRET_TOKEN);
  });

  test('in production, a real provider send() failure still falls back to console without leaking the token', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 'test-key-not-real';
    jest.doMock('resend', () => ({
      Resend: class {
        constructor() {}
        get emails() {
          return { send: () => { throw new Error('simulated resend outage'); } };
        }
      },
    }), { virtual: true });

    let email;
    jest.isolateModules(() => {
      email = require('../../lib/email');
    });

    await expect(email.send({
      to: 'user@example.com', subject: 'Reset your password', text: `token=${SECRET_TOKEN}`,
    })).rejects.toThrow();

    const allLogCalls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogCalls).not.toContain(SECRET_TOKEN);

    delete process.env.RESEND_API_KEY;
    jest.dontMock('resend');
  });
});
