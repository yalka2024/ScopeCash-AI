/**
 * lib/api-call-meter.js — the buffered api_calls_per_month counter.
 *
 * This meter deliberately does NOT write to the database on every request
 * (see the module header for why), so the things worth pinning down are the
 * buffering behaviours: that enforcement sees buffered-but-unpersisted
 * counts, that a flush failure doesn't silently lose units, and that the
 * flush timer can never hold a process open.
 */
jest.mock('../../lib/usage-meter', () => ({
  recordUsage: jest.fn().mockResolvedValue({ ok: true }),
  getUsage: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../lib/entitlements', () => ({
  getLimit: jest.fn().mockResolvedValue(5),
  currentPeriodKey: () => '2026-07',
}));

const usageMeter = require('../../lib/usage-meter');
const ent = require('../../lib/entitlements');
const apiCalls = require('../../lib/api-call-meter');

describe('api-call-meter', () => {
  beforeEach(() => {
    apiCalls._reset();
    jest.clearAllMocks();
    usageMeter.recordUsage.mockResolvedValue({ ok: true });
    usageMeter.getUsage.mockResolvedValue(0);
    ent.getLimit.mockResolvedValue(5);
  });
  afterEach(() => apiCalls._reset());

  test('counts the call being checked, so a limit of N permits exactly N calls', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await apiCalls.checkAndRecord('org1'));
    expect(results.map(r => r.used)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.map(r => r.allowed)).toEqual([true, true, true, true, true, false]);
  });

  test('enforces against buffered counts that have not been flushed yet', async () => {
    for (let i = 0; i < 5; i++) await apiCalls.checkAndRecord('org1');
    // Nothing has been persisted at this point...
    expect(usageMeter.recordUsage).not.toHaveBeenCalled();
    // ...but the 6th call is still correctly rejected.
    expect((await apiCalls.checkAndRecord('org1')).allowed).toBe(false);
  });

  test('flush persists one aggregated row per org, not one per request', async () => {
    for (let i = 0; i < 3; i++) await apiCalls.checkAndRecord('org1');
    await apiCalls.checkAndRecord('org2');
    await apiCalls.flush();

    expect(usageMeter.recordUsage).toHaveBeenCalledTimes(2);
    const byOrg = Object.fromEntries(
      usageMeter.recordUsage.mock.calls.map(([a]) => [a.orgId, a.quantity]));
    expect(byOrg).toEqual({ org1: 3, org2: 1 });
  });

  test('a flushed count is not double-counted on the next check', async () => {
    for (let i = 0; i < 3; i++) await apiCalls.checkAndRecord('org1');
    await apiCalls.flush();
    // getUsage still reports 0 (the mock DB never really changed), so if the
    // flush didn't fold its own write into the cache this would regress to 1.
    expect((await apiCalls.checkAndRecord('org1')).used).toBe(4);
  });

  test('units are put back when persistence fails, rather than silently lost', async () => {
    for (let i = 0; i < 3; i++) await apiCalls.checkAndRecord('org1');
    usageMeter.recordUsage.mockResolvedValueOnce({ ok: false });
    await apiCalls.flush();

    // The failed units are still buffered, so the next successful flush writes them.
    usageMeter.recordUsage.mockResolvedValue({ ok: true });
    await apiCalls.flush();
    const last = usageMeter.recordUsage.mock.calls.at(-1)[0];
    expect(last.quantity).toBe(3);
  });

  test('an unlimited plan is counted but never blocked', async () => {
    ent.getLimit.mockResolvedValue(-1);
    for (let i = 0; i < 50; i++) await apiCalls.checkAndRecord('org1');
    const res = await apiCalls.checkAndRecord('org1');
    expect(res.allowed).toBe(true);
    expect(res.limit).toBe(-1);
    await apiCalls.flush();
    expect(usageMeter.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ quantity: 51 }));
  });

  test('a call with no org resolves permissively instead of throwing', async () => {
    const res = await apiCalls.checkAndRecord(null);
    expect(res.allowed).toBe(true);
    expect(usageMeter.getUsage).not.toHaveBeenCalled();
  });

  test('the flush timer is unref\'d so it can never hold the process open', async () => {
    await apiCalls.checkAndRecord('org1');
    const timers = process._getActiveHandles().filter(h => h.constructor?.name === 'Timeout');
    // Every timer this module created must be unref'd (hasRef() === false).
    // A ref'd interval here would hang Jest and, in production, block exit.
    const ours = timers.filter(t => typeof t.hasRef === 'function' && t.hasRef());
    expect(ours.every(t => t._idleTimeout !== apiCalls.FLUSH_INTERVAL_MS)).toBe(true);
  });

  test('flush is a no-op when nothing is buffered', async () => {
    expect(await apiCalls.flush()).toEqual({ flushed: 0 });
    expect(usageMeter.recordUsage).not.toHaveBeenCalled();
  });
});
