/**
 * Real-browser coverage for RateSheetTools.js — before this, building a
 * rate sheet meant adding items one row at a time through the generic
 * entity-CRUD form. See TODO.md "rate-sheet import/versioning UI".
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { test, expect } = require('@playwright/test');

process.env.DATABASE_URL = 'file:' + path.resolve(__dirname, '../../server/e2e-test.db');
const prisma = require('../../server/lib/prisma');

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

const EMAIL = `rate-sheet-${Date.now()}@test.local`;
const PASSWORD = 'Correct-Horse-Battery-9!';

let sharedContext, sharedPage, tmpDir;

test.beforeAll(async ({ browser }) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopecash-e2e-rs-'));
  sharedContext = await browser.newContext();
  sharedPage = await sharedContext.newPage();
  await sharedPage.goto('/#login');
  await sharedPage.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  await sharedPage.getByRole('button', { name: /Don.t have an account\?/ }).click();
  await sharedPage.getByLabel('Full name').fill('Rate Sheet Owner');
  await sharedPage.getByLabel('Email address').fill(EMAIL);
  await sharedPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await sharedPage.getByRole('button', { name: 'Create Account' }).click();
  await sharedPage.waitForSelector('.sidebar', { timeout: 20_000 });
});

test.afterAll(async () => {
  await sharedContext.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

test('full rate sheet lifecycle in a real browser: create draft, import CSV, publish, new version, publish supersedes', async () => {
  await sharedPage.goto('/#app');
  await sharedPage.waitForSelector('.sidebar');
  await sharedPage.getByRole('button', { name: 'Customers', exact: true }).click();
  await expect(sharedPage.getByText('Rate sheet tools')).toBeVisible();

  // Create a draft rate sheet via the generic entity form (still the right
  // tool for single-row creation of the sheet header itself) — the
  // Customers page renders several entity sections (customer, rateSheet,
  // rateSheetItem, ...), several sharing field names like "Name", so scope
  // every locator to the Rate Sheets section specifically rather than
  // guessing at DOM order with .first()/.last().
  const sheetName = uid('E2E Sheet');
  const rateSheetSection = sharedPage.locator('section', { has: sharedPage.getByRole('heading', { name: /Rate Sheets/ }) });
  await rateSheetSection.getByPlaceholder('Name').fill(sheetName);
  await rateSheetSection.getByPlaceholder('Trade').fill('hvac');
  await rateSheetSection.getByPlaceholder('Status').fill('draft');
  await rateSheetSection.getByRole('button', { name: 'Add' }).click();
  await expect(rateSheetSection.getByRole('cell', { name: sheetName, exact: true })).toBeVisible({ timeout: 10_000 });

  // Select it in the rate sheet tools widget.
  await sharedPage.getByLabel('Rate sheet', { exact: true }).selectOption({ label: `${sheetName} v1 (draft)` });
  await expect(sharedPage.getByRole('button', { name: 'Import CSV' })).toBeVisible();

  const csvPath = path.join(tmpDir, 'rates.csv');
  fs.writeFileSync(csvPath, 'code,description,unit,unitRate,category\nHVAC-01,Replace condenser,ea,4500,equipment\nHVAC-02,Duct sealing,lf,12.5,labor\n');
  const fileInput = sharedPage.locator('input[type=file]');
  await fileInput.setInputFiles(csvPath);
  await expect(sharedPage.getByText('Imported 2 item(s).')).toBeVisible({ timeout: 10_000 });
  await expect(sharedPage.getByRole('cell', { name: 'Replace condenser', exact: true })).toBeVisible({ timeout: 10_000 });

  // Publish the draft.
  await sharedPage.getByRole('button', { name: 'Publish' }).click();
  await expect(sharedPage.getByText(/Published v1 as the active rate sheet/)).toBeVisible({ timeout: 10_000 });
  await expect(sharedPage.getByLabel('Rate sheet', { exact: true }).locator('option', { hasText: `${sheetName} v1 (active)` })).toHaveCount(1);

  // Create a new version — should clone the 2 imported items into a new draft.
  await sharedPage.getByRole('button', { name: 'Create new version' }).click();
  await expect(sharedPage.getByText(/Created draft v2/)).toBeVisible({ timeout: 10_000 });

  const v1 = await prisma.rateSheet.findFirst({ where: { name: sheetName, version: 1 } });
  const v2 = await prisma.rateSheet.findFirst({ where: { name: sheetName, version: 2 } });
  expect(v1.status).toBe('active'); // not yet superseded — v2 hasn't published
  expect(v2.status).toBe('draft');
  const v2Items = await prisma.rateSheetItem.findMany({ where: { rateSheetId: v2.id } });
  expect(v2Items).toHaveLength(2);

  // Publish v2 — v1 should flip to superseded.
  await sharedPage.getByRole('button', { name: 'Publish' }).click();
  await expect(sharedPage.getByText(/Published v2 as the active rate sheet/)).toBeVisible({ timeout: 10_000 });
  const v1After = await prisma.rateSheet.findUnique({ where: { id: v1.id } });
  expect(v1After.status).toBe('superseded');
});
