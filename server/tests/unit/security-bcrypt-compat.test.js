/**
 * Regression coverage for switching lib/security.js's hashPassword/
 * verifyPassword from bcryptjs to @node-rs/bcrypt (TODO.md "Perf/load/soak
 * testing"). Found via load testing: bcryptjs's async compare/hash
 * synchronously blocks Node's single-threaded event loop for the full
 * ~400-600ms of the bcrypt computation, so concurrent logins serialize and
 * stall every other in-flight request on the process, not just login's
 * own. @node-rs/bcrypt is a native (N-API) implementation that runs
 * off-thread. This file locks in the one thing that fix could plausibly
 * break: existing bcryptjs-produced password hashes must keep verifying
 * correctly (bcrypt's hash format is standard and portable across
 * compliant implementations, but that claim is worth a real test, not
 * just an assertion in a commit message).
 */
const bcryptjs = require('bcryptjs');
const security = require('../../lib/security');

describe('security.js hashPassword/verifyPassword (@node-rs/bcrypt)', () => {
  test('a hash produced by the current implementation verifies correctly', async () => {
    const hash = await security.hashPassword('Correct-Horse-Battery-9!');
    expect(await security.verifyPassword('Correct-Horse-Battery-9!', hash)).toBe(true);
    expect(await security.verifyPassword('wrong-password', hash)).toBe(false);
  });

  test('an EXISTING hash produced by bcryptjs (the prior implementation) still verifies correctly', async () => {
    // Simulates every password hash already stored in a real database
    // before this switch -- must keep working unchanged, or every
    // existing user would be locked out.
    const legacyHash = await bcryptjs.hash('Legacy-User-Password-9!', 12);
    expect(await security.verifyPassword('Legacy-User-Password-9!', legacyHash)).toBe(true);
    expect(await security.verifyPassword('wrong-password', legacyHash)).toBe(false);
  });

  test('a hash produced by the current implementation is also verifiable by bcryptjs (bidirectional format compatibility)', async () => {
    const hash = await security.hashPassword('Round-Trip-Password-9!');
    expect(await bcryptjs.compare('Round-Trip-Password-9!', hash)).toBe(true);
    expect(await bcryptjs.compare('wrong-password', hash)).toBe(false);
  });

  test('verify does not block the event loop synchronously (the whole point of the fix)', async () => {
    const hash = await security.hashPassword('Timing-Check-Password-9!');
    const start = Date.now();
    const pending = security.verifyPassword('Timing-Check-Password-9!', hash);
    const elapsedBeforeAwait = Date.now() - start;
    // bcryptjs measured ~400ms+ synchronous block before even returning a
    // pending promise; a genuinely async implementation returns control
    // to the event loop essentially immediately.
    expect(elapsedBeforeAwait).toBeLessThan(50);
    await pending;
  });
});
