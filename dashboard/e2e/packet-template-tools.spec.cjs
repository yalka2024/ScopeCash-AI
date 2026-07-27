/**
 * Real-browser coverage for PacketTemplateTools.js. See TODO.md
 * "Packet template versioning".
 */
const path = require('path');
const { test, expect } = require('@playwright/test');

process.env.DATABASE_URL = 'file:' + path.resolve(__dirname, '../../server/e2e-test.db');
const prisma = require('../../server/lib/prisma');

function uid(prefix) { return `${prefix}_${Date.now()}`; }

const EMAIL = `packet-template-${Date.now()}@test.local`;
const PASSWORD = 'Correct-Horse-Battery-9!';

let sharedContext, sharedPage;

test.beforeAll(async ({ browser }) => {
  sharedContext = await browser.newContext();
  sharedPage = await sharedContext.newPage();
  await sharedPage.goto('/#login');
  await sharedPage.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  await sharedPage.getByRole('button', { name: /Don.t have an account\?/ }).click();
  await sharedPage.getByLabel('Full name').fill('Packet Template Owner');
  await sharedPage.getByLabel('Email address').fill(EMAIL);
  await sharedPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await sharedPage.getByRole('button', { name: 'Create Account' }).click();
  await sharedPage.waitForSelector('.sidebar', { timeout: 20_000 });
});

test.afterAll(async () => {
  await sharedContext.close();
  await prisma.$disconnect();
});

test('full packet template lifecycle in a real browser: create draft, publish, new version, publish supersedes', async () => {
  await sharedPage.goto('/#app');
  await sharedPage.waitForSelector('.sidebar');
  await sharedPage.getByRole('button', { name: 'Packets', exact: true }).click();
  await expect(sharedPage.getByText('Packet template tools')).toBeVisible();

  const name = uid('E2E Template');
  const templateSection = sharedPage.locator('section', { has: sharedPage.getByRole('heading', { name: /Packet Templates/ }) });
  await templateSection.getByPlaceholder('Name').fill(name);
  await templateSection.getByPlaceholder('Sections').fill('disclaimer,body,approval');
  await templateSection.getByRole('button', { name: 'Add' }).click();
  await expect(templateSection.getByRole('cell', { name, exact: true })).toBeVisible({ timeout: 10_000 });

  await sharedPage.getByLabel('Template', { exact: true }).selectOption({ label: `${name} v1 (draft)` });
  await sharedPage.getByRole('button', { name: 'Publish' }).click();
  await expect(sharedPage.getByText(/Published v1 as the active template/)).toBeVisible({ timeout: 10_000 });
  await expect(sharedPage.getByLabel('Template', { exact: true }).locator('option', { hasText: `${name} v1 (active)` })).toHaveCount(1);

  await sharedPage.getByRole('button', { name: 'Create new version' }).click();
  await expect(sharedPage.getByText(/Created draft v2/)).toBeVisible({ timeout: 10_000 });

  const v1 = await prisma.packetTemplate.findFirst({ where: { name, version: 1 } });
  const v2 = await prisma.packetTemplate.findFirst({ where: { name, version: 2 } });
  expect(v1.status).toBe('active');
  expect(v2.status).toBe('draft');
  expect(v2.sections).toBe('disclaimer,body,approval'); // cloned from v1

  await sharedPage.getByRole('button', { name: 'Publish' }).click();
  await expect(sharedPage.getByText(/Published v2 as the active template/)).toBeVisible({ timeout: 10_000 });
  const v1After = await prisma.packetTemplate.findUnique({ where: { id: v1.id } });
  expect(v1After.status).toBe('superseded');
});
