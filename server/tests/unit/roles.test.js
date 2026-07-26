const { requireRole, requireWrite, isWriteRole, roleNames } = require('../../lib/roles');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('RBAC (spec-driven roles, Phase 2.4)', () => {
  test('role catalog is non-empty', () => {
    expect(roleNames().length).toBeGreaterThan(0);
  });

  test('requireRole allows a listed role', () => {
    let called = false;
    requireRole('manager')({ user: { role: 'manager' } }, mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });

  test('requireRole 403s a non-listed role', () => {
    const res = mockRes();
    let called = false;
    requireRole('manager')({ user: { role: 'someoneelse' } }, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('admin always passes requireRole', () => {
    let called = false;
    requireRole('manager')({ user: { role: 'admin' } }, mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });

  test('requireWrite blocks read-only / unknown roles, allows admin', () => {
    const res = mockRes();
    let blocked = true;
    requireWrite({ user: { role: 'viewer' } }, res, () => { blocked = false; });
    expect(res.statusCode).toBe(403);
    expect(blocked).toBe(true);
    expect(isWriteRole('admin')).toBe(true);
  });

  test('unauthenticated requests are rejected', () => {
    const res = mockRes();
    requireWrite({}, res, () => {});
    expect(res.statusCode).toBe(401);
  });
});

