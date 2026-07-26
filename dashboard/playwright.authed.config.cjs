// Playwright config for automated WCAG 2.2 AA scanning + keyboard-navigation
// checks of the AUTHENTICATED dashboard — the gap public-pages.spec.cjs's own
// comment flags (it only covers the public marketing/legal surface, since
// that one runs against a static `npm run preview` build with no backend).
// This one needs a real API + database, so its webServer boots the actual
// Express server (SERVE_DASHBOARD=1) against a disposable SQLite DB rather
// than the static preview server.
const path = require('path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './a11y',
  testMatch: /authenticated-pages\.spec\.cjs/,
  timeout: 30_000,
  fullyParallel: false, // tests share one logged-in session; run serially
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    // Migrates its own disposable DB first so `npm run test:a11y:authed`
    // works standalone, without an external pre-migration step.
    command: 'npx prisma migrate deploy && node index.js',
    cwd: path.resolve(__dirname, '../server'),
    env: {
      SERVE_DASHBOARD: '1',
      NODE_ENV: 'development',
      PORT: '4173',
      DATABASE_URL: 'file:./a11y-test.db',
      CORS_ORIGIN: 'http://localhost:4173',
    },
    url: 'http://localhost:4173/api/health/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
