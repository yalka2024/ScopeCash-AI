// Playwright config for the authenticated nav-smoke e2e suite — promoted
// from an ad hoc QA script (see STATUS.md "Final phase" and TODO.md) used
// to catch real regressions (broken routes, unmounted routers, crashed
// pages) while rewriting the authenticated nav. Distinct from
// playwright.authed.config.cjs (WCAG/keyboard-a11y scanning): this suite's
// job is to assert NOTHING BROKE — no console errors, no uncaught page
// errors, no failed (5xx) network responses, no blank-render crash — while
// walking every authenticated nav destination. An axe scan alone can't
// catch this class of bug: a crashed page that renders an empty DOM
// trivially reports zero accessibility violations and would pass silently.
//
// Own disposable SQLite DB + port so this can run alongside (or instead of)
// playwright.authed.config.cjs without clashing.
const path = require('path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: /nav-smoke\.spec\.cjs/,
  timeout: 30_000,
  fullyParallel: false, // tests share one logged-in session; run serially
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
  },
  webServer: {
    command: 'npx prisma migrate deploy && node index.js',
    cwd: path.resolve(__dirname, '../server'),
    env: {
      SERVE_DASHBOARD: '1',
      NODE_ENV: 'development',
      PORT: '4174',
      DATABASE_URL: 'file:./e2e-test.db',
      CORS_ORIGIN: 'http://localhost:4174',
    },
    url: 'http://localhost:4174/api/health/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
