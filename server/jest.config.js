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
};

