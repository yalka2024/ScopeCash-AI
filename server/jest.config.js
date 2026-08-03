/**
 * Jest config for the ScopeCash AI server test suite.
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: [
    'lib/**/*.js',
    'middleware/**/*.js',
    'routes/**/*.js',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: { lines: 50, functions: 50, branches: 35, statements: 50 },
  },
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  globalSetup: '<rootDir>/tests/global-setup.js',
  testTimeout: 20000,

  // Every suite shares ONE SQLite file (tests/setup-env.js -> file:./test.db),
  // so suites cannot run in parallel workers. `npm test` passes --runInBand,
  // but that put the constraint in the npm script while the reason for it
  // lives here, in the config that chooses the database. Running bare
  // `npx jest` therefore forked workers against the shared file and produced
  // confusing, non-reproducing failures in whichever suites happened to
  // overlap — the global sweeps are the loudest (lib/evidence-jobs.js
  // #reconcileStuckJobs scans every stuck run in the database, so two suites
  // seeding stuck runs concurrently each sweep the other's rows and both get
  // the wrong count), but anything asserting on a global aggregate is
  // exposed. Pinning it here makes every invocation correct, not just the
  // blessed one.
  maxWorkers: 1,
};

