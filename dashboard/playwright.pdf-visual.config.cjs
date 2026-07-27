// Playwright config for pixel-level visual regression of generated PDFs —
// distinct from the other 3 configs (a11y/a11y-authed/e2e), none of which
// do any screenshot comparison. webServer here is a tiny hand-written
// static file server (pdf-visual/static-server.cjs, no new dependency),
// not the real Express app — these tests never touch the API or a
// database, they call lib/tools/pdfpacketrenderer.js directly in Node.
// The server exists only so harness.html can load pdfjs-dist as an ES
// module: Chromium blocks that over file:// with a CORS error, but
// same-origin http:// works normally.
const path = require('path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './pdf-visual',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4175',
  },
  webServer: {
    command: `node ${path.resolve(__dirname, 'pdf-visual/static-server.cjs')}`,
    url: 'http://localhost:4175/pdf-visual/harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
