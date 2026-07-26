/**
 * Separate Jest config for tests that require a real Postgres with RLS
 * applied — kept apart from jest.config.js (SQLite, has no RLS at all) so
 * `npm test` never silently skips these and CI can gate them explicitly.
 *
 * Requires DATABASE_URL to already point at Postgres (as a NON-superuser
 * role — see .github/workflows/ci.yml — superusers bypass RLS regardless
 * of policy, which would make every test in here pass for the wrong
 * reason) with migrations applied and rls.sql already run.
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/postgres/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testTimeout: 20000,
};
