/**
 * Real-browser coverage for EvidenceUpload.js — the dashboard's only real
 * evidence-capture UI (see TODO.md "mobile capture UX + upload resume").
 * Before this component, every upload endpoint (multipart AND signed-URL,
 * both fully built and tested server-side — routes/evidence.js) was
 * unreachable from the app at all: the generic entity-CRUD forms only let a
 * user type a raw storage_uri string.
 *
 * Runs with no STORAGE_DRIVER set, so the server's default 'local' driver
 * is in effect — storage.signedUploadUrl() returns null there, meaning the
 * presigned-URL branch always 501s and every upload in this test exercises
 * the multipart fallback path. That's a real, deliberate exercise of the
 * widget's fallback logic, not a workaround: it's exactly what happens for
 * any demo/local/self-hosted deployment (see routes/evidence.js's own
 * "GCS/S3 only" comment on signedUploadUrl).
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { test, expect } = require('@playwright/test');

// Absolute path so this resolves the same regardless of the Playwright test
// runner's own cwd — the webServer child process (cwd=server/) resolves its
// OWN 'file:./e2e-test.db' relative to ITS cwd; this must point at the exact
// same file from a different process's perspective.
process.env.DATABASE_URL = 'file:' + path.resolve(__dirname, '../../server/e2e-test.db');
const prisma = require('../../server/lib/prisma');
const { runWithSystemAccess } = require('../../server/lib/tenant-context');

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

const EMAIL = `evidence-upload-${Date.now()}@test.local`;
const PASSWORD = 'Correct-Horse-Battery-9!';

let sharedContext, sharedPage, tmpDir, project;

async function openEvidenceTabForProject(page) {
  await page.goto('/#app');
  await page.waitForSelector('.sidebar');
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await page.getByLabel('Project').selectOption({ label: 'E2E Upload Project' });
}

test.beforeAll(async ({ browser }) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopecash-e2e-'));

  sharedContext = await browser.newContext();
  sharedPage = await sharedContext.newPage();
  await sharedPage.goto('/#login');
  await sharedPage.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  await sharedPage.getByRole('button', { name: /Don.t have an account\?/ }).click();
  await sharedPage.getByLabel('Full name').fill('Evidence Uploader');
  await sharedPage.getByLabel('Email address').fill(EMAIL);
  await sharedPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await sharedPage.getByRole('button', { name: 'Create Account' }).click();
  await sharedPage.waitForSelector('.sidebar', { timeout: 20_000 });

  const user = await prisma.user.findUnique({ where: { email: EMAIL.toLowerCase() } });
  project = await runWithSystemAccess(async () => {
    const customer = await prisma.customer.create({ data: { orgId: user.orgId, name: uid('Customer') } });
    return prisma.projectRecord.create({ data: { orgId: user.orgId, customer_id: customer.id, name: 'E2E Upload Project', userId: user.id } });
  });
});

test.afterAll(async () => {
  await sharedContext.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

test('capture-evidence widget uploads a document via the multipart fallback and it appears in the list', async () => {
  await openEvidenceTabForProject(sharedPage);
  await expect(sharedPage.getByText('Capture evidence')).toBeVisible();

  const txtPath = path.join(tmpDir, 'contract.txt');
  fs.writeFileSync(txtPath, 'This is a real contract document for the e2e upload test.');

  // The three file inputs are, in DOM order: photo-capture, generic
  // evidence, document.
  const documentInput = sharedPage.locator('input[type=file]').nth(2);
  await documentInput.setInputFiles(txtPath);

  const fileRow = sharedPage.locator('li', { hasText: 'contract.txt' });
  await expect(fileRow).toBeVisible();
  await expect(fileRow.getByText('Uploaded')).toBeVisible({ timeout: 15_000 });

  // refreshSignal wired this straight into the SourceDocuments table below
  // without a manual reload.
  await expect(sharedPage.getByRole('cell', { name: 'contract.txt', exact: true })).toBeVisible({ timeout: 10_000 });

  const row = await prisma.sourceDocument.findFirst({ where: { project_id: project.id, original_filename: 'contract.txt' } });
  expect(row).toBeTruthy();
  expect(row.document_type).toBeTruthy();
});

test('capture-evidence widget uploads a photo via the multipart fallback and it appears in the list', async () => {
  await openEvidenceTabForProject(sharedPage);

  // Minimal valid PNG signature (8-byte header) — storage.js#sniffMagicBytes
  // only checks the first 4 bytes for PNG, so this is real, sniffable
  // content, not an arbitrary file with a renamed extension.
  const pngPath = path.join(tmpDir, 'sitephoto.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

  const evidenceInput = sharedPage.locator('input[type=file]').nth(1);
  await evidenceInput.setInputFiles(pngPath);

  const fileRow = sharedPage.locator('li', { hasText: 'sitephoto.png' });
  await expect(fileRow).toBeVisible();
  await expect(fileRow.getByText('Uploaded')).toBeVisible({ timeout: 15_000 });

  const row = await prisma.evidenceItem.findFirst({ where: { project_id: project.id, storageUri: { contains: 'sitephoto' } } });
  expect(row).toBeTruthy();
  expect(row.evidenceType).toBe('photo');

  // The "View" link only appears once the server has actually returned the
  // created row's id (FileRow's canView), and points at the real,
  // authenticated view route (see routes/evidence.js's GET .../view,
  // which transcodes HEIC to JPEG on the fly and streams everything else
  // as-is) — following it here exercises the non-HEIC pass-through branch
  // in a real browser tab, end to end.
  const viewLink = fileRow.getByRole('link', { name: 'View' });
  await expect(viewLink).toBeVisible();
  const href = await viewLink.getAttribute('href');
  expect(href).toBe(`/api/evidenceItems/${row.id}/view`);
  const viewResponse = await sharedPage.request.get(href);
  expect(viewResponse.status()).toBe(200);
  expect(viewResponse.headers()['content-type']).toBe('image/png');
});

test('mobile viewport: hamburger menu toggles the sidebar drawer', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/#login');
  await page.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForSelector('.sidebar');

  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  const toggle = page.getByRole('button', { name: 'Open menu' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('.sidebar')).toHaveClass(/open/);

  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);

  await context.close();
});
