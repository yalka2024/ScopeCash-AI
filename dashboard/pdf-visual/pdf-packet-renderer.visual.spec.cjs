/**
 * Pixel-level visual regression for lib/tools/pdfpacketrenderer.js's
 * hand-crafted PDF byte stream (raw PDF 1.4 objects/xref/content streams,
 * no PDF library). server/tests/unit/pdf-packet-renderer.test.js already
 * checks WHICH blocks appear and in what order (substring/order checks on
 * the raw buffer); this catches a different failure mode a text-presence
 * check can't: a refactor that keeps the right substrings but corrupts the
 * actual layout — a bad xref offset, a miscalculated /Length, text drawn
 * off-page — invisible to `buffer.includes('DISCLAIMER')`, visible to a
 * pixel diff.
 *
 * 'disclaimer' is deliberately excluded from every fixture here: it embeds
 * a live `Generated : <ISO timestamp>` line (real `new Date()`, not
 * caller-supplied) that changes every run, which would make a pixel
 * snapshot of it permanently unstable. That block's presence is covered by
 * the substring test suite instead, not here — everything else in the
 * fixture below is fully deterministic given fixed input.
 *
 * Rendering: see harness.html for why this doesn't just page.goto() the
 * PDF directly (Chromium downloads instead of rendering it) or use
 * <embed type="application/pdf"> (no PDF viewer plugin in Playwright's
 * bundled Chromium — silently blank, which would make this suite pass by
 * comparing two identical placeholders forever). Generated PDFs are
 * written into pdf-visual/.tmp/ (gitignored) so the static server
 * (playwright.pdf-visual.config.cjs's webServer) can serve them over
 * http:// alongside harness.html.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live';
const renderer = require('../../server/lib/tools/pdfpacketrenderer');

const TMP_DIR = path.resolve(__dirname, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const FIXTURE_PACKET = {
  title: 'HVAC Retrofit — Change Order #3',
  project: 'Riverside Community Center',
  summary: 'Replace 3-ton condenser and reseal ductwork per approved scope change.',
  sources: ['Contract Amendment #3, page 2', 'Site photo 2026-06-01', 'Supplier invoice INV-1042'],
  approval: {
    approver: 'Jane Estimator', timestamp: '2026-06-15T10:00:00.000Z',
    reference: 'PK-1042', status: 'approved', notes: 'Approved after customer walkthrough.',
  },
};

async function renderToTempFile(sections, filename) {
  const res = await renderer.run(
    { packet_data_json: FIXTURE_PACKET, template_id: 'visual-regression-fixture', sections },
    { orgId: 'org-fixed', userId: 'user-fixed' },
  );
  fs.writeFileSync(path.join(TMP_DIR, filename), res.pdf_bytes);
  return filename;
}

async function screenshotPdf(page, baseURL, pdfFilename, pngName) {
  const pdfUrl = `${baseURL}/pdf-visual/.tmp/${pdfFilename}`;
  await page.goto(`/pdf-visual/harness.html?src=${encodeURIComponent(pdfUrl)}`);
  await page.waitForSelector('body[data-rendered]', { timeout: 10_000 });
  const state = await page.locator('body').getAttribute('data-rendered');
  if (state !== 'true') {
    const error = await page.locator('body').getAttribute('data-error');
    throw new Error(`harness.html failed to render ${pdfFilename}: ${error}`);
  }
  await expect(page.locator('#pages')).toHaveScreenshot(pngName);
}

const CASES = [
  { name: 'body', sections: ['body'], title: 'body block renders with a stable layout' },
  { name: 'appendix', sections: ['appendix'], title: 'appendix block renders with a stable layout' },
  { name: 'approval', sections: ['approval'], title: 'approval block renders with a stable layout' },
  {
    name: 'combined', sections: ['body', 'appendix', 'approval'],
    title: 'body+appendix+approval together render with a stable multi-page layout',
  },
];

for (const { name, sections, title } of CASES) {
  test(title, async ({ page, baseURL }) => {
    const pdfFilename = await renderToTempFile(sections, `scopecash-visual-${name}.pdf`);
    await screenshotPdf(page, baseURL, pdfFilename, `${name}.png`);
  });
}
