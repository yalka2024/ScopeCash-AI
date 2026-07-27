/**
 * lib/lifecycle.js — the graceful-drain mechanism SIGTERM triggers in
 * index.js. Zero test coverage existed before this (TODO.md "DR/regional
 * failover exercises" — see STATUS.md for why a REAL regional failover
 * drill is out of reach in this environment, and why this narrower,
 * genuinely drillable piece was picked instead: it's the one resiliency
 * mechanism a rolling deploy, a zone eviction, or an actual regional
 * failover would all depend on at the single-instance level, i.e. "does
 * this process shut down without dropping in-flight requests or accepting
 * new ones it can't finish" -- necessary but not sufficient for real
 * regional failover, which additionally needs multi-region infrastructure
 * this deployment doesn't have.
 */
const lifecycle = require('../../lib/lifecycle');

function fakeReqRes(path = '/api/customers') {
  const handlers = {};
  const req = { path };
  const res = { on: (evt, fn) => { handlers[evt] = fn; }, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return { req, res, finish: () => handlers.finish && handlers.finish(), close: () => handlers.close && handlers.close() };
}

// lifecycle.js holds its `draining`/`inFlight` state at module scope (no
// reset export) since it models a real singleton server process where
// that's correct -- tests below are written to never rely on either
// starting at a specific baseline, only on the RELATIVE change each
// action causes.
describe('trackInFlight', () => {
  test('increments on request start, decrements on response finish', async () => {
    const before = lifecycle.stats().inFlight;
    const { req, res, finish } = fakeReqRes();
    const next = jest.fn();
    lifecycle.trackInFlight(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(lifecycle.stats().inFlight).toBe(before + 1);
    finish();
    expect(lifecycle.stats().inFlight).toBe(before);
  });

  test('decrements on response close too (client disconnect before finish)', () => {
    const before = lifecycle.stats().inFlight;
    const { req, res, close } = fakeReqRes();
    lifecycle.trackInFlight(req, res, jest.fn());
    close();
    expect(lifecycle.stats().inFlight).toBe(before);
  });

  test('never goes negative even if close fires after finish already decremented it', () => {
    const before = lifecycle.stats().inFlight;
    const { req, res, finish, close } = fakeReqRes();
    lifecycle.trackInFlight(req, res, jest.fn());
    finish();
    close(); // spurious second decrement -- must clamp, not go negative
    expect(lifecycle.stats().inFlight).toBe(Math.max(0, before));
  });
});

describe('drainGuard', () => {
  // beforeEach, not afterEach: gives every test (including the first) a
  // fresh, undrained module instead of depending on execution order to
  // supply that -- there's no public reset, so this relies on the
  // module's own state shape (draining is a plain boolean startDrain()
  // only ever sets true, so the only way back to false in a test is a
  // fresh require).
  beforeEach(() => { jest.resetModules(); });

  test('passes through when not draining', () => {
    const fresh = require('../../lib/lifecycle');
    const { req, res } = fakeReqRes();
    const next = jest.fn();
    fresh.drainGuard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('rejects new requests with 503 + Retry-After once draining', () => {
    const fresh = require('../../lib/lifecycle');
    fresh.startDrain();
    const { req, res } = fakeReqRes('/api/customers');
    const next = jest.fn();
    fresh.drainGuard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'draining' }));
  });

  test('still lets health-check paths through while draining, so an orchestrator can observe drain state', () => {
    const fresh = require('../../lib/lifecycle');
    fresh.startDrain();
    const { req, res } = fakeReqRes('/api/health/ready');
    const next = jest.fn();
    fresh.drainGuard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('waitForInFlight', () => {
  test('resolves true immediately when nothing is in flight', async () => {
    jest.resetModules();
    const fresh = require('../../lib/lifecycle');
    const ok = await fresh.waitForInFlight(1000, 10);
    expect(ok).toBe(true);
  });

  test('waits for an in-flight request to finish, then resolves true', async () => {
    jest.resetModules();
    const fresh = require('../../lib/lifecycle');
    const { req, res, finish } = fakeReqRes();
    fresh.trackInFlight(req, res, jest.fn());
    setTimeout(finish, 150);
    const start = Date.now();
    const ok = await fresh.waitForInFlight(2000, 20);
    expect(ok).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140); // genuinely waited, not a no-op
  });

  test('times out and resolves false if the in-flight request never finishes', async () => {
    jest.resetModules();
    const fresh = require('../../lib/lifecycle');
    const { req, res } = fakeReqRes(); // never call finish()
    fresh.trackInFlight(req, res, jest.fn());
    const ok = await fresh.waitForInFlight(200, 20);
    expect(ok).toBe(false);
  });
});
