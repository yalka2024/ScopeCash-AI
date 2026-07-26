// Playwright config for automated WCAG 2.2 AA scanning (axe-core) of the
// public, unauthenticated marketing/legal pages. Authenticated dashboard
// pages need a running API + logged-in session to reach — out of scope for
// this static-build scan; see a11y/README.md if extending to authed pages.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './a11y',
  // Scoped to the public spec only — authenticated-pages.spec.cjs lives in
  // the same directory but needs a real backend (see
  // playwright.authed.config.cjs), which this static-preview webServer
  // doesn't provide.
  testMatch: /public-pages\.spec\.cjs/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'npm run preview -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
