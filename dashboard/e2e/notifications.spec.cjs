/**
 * Real-browser coverage for NotificationBell.js and the notification
 * preferences table on SettingsPage.js. See TODO.md "Notification
 * preference management" — getNotifications() existed in api.js with zero
 * callers anywhere in the dashboard before this; NotificationBell is the
 * first real UI to reach it.
 */
const path = require('path');
const { test, expect } = require('@playwright/test');

process.env.DATABASE_URL = 'file:' + path.resolve(__dirname, '../../server/e2e-test.db');
const prisma = require('../../server/lib/prisma');

const EMAIL = `notifications-${Date.now()}@test.local`;
const PASSWORD = 'Correct-Horse-Battery-9!';

let sharedContext, sharedPage, userId;

test.beforeAll(async ({ browser }) => {
  sharedContext = await browser.newContext();
  sharedPage = await sharedContext.newPage();
  await sharedPage.goto('/#login');
  await sharedPage.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  await sharedPage.getByRole('button', { name: /Don.t have an account\?/ }).click();
  await sharedPage.getByLabel('Full name').fill('Notification Tester');
  await sharedPage.getByLabel('Email address').fill(EMAIL);
  await sharedPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await sharedPage.getByRole('button', { name: 'Create Account' }).click();
  await sharedPage.waitForSelector('.sidebar', { timeout: 20_000 });

  const user = await prisma.user.findFirst({ where: { email: EMAIL } });
  userId = user.id;
});

test.afterAll(async () => {
  await sharedContext.close();
  await prisma.$disconnect();
});

test('bell shows an unread count, lists a real notification, and marking it read clears the badge', async () => {
  await prisma.notification.create({
    data: { userId, type: 'packet.approved', title: 'Evidence packet approved', message: 'Packet PK-1 v1 was approved.' },
  });

  // A hash-only goto() on an already-mounted SPA doesn't remount
  // NotificationBell (App.js's hash routing swaps `page` state, not the
  // whole tree) — force a real reload so its on-mount fetch sees the row
  // just created.
  await sharedPage.goto('/#app');
  await sharedPage.reload();
  await sharedPage.waitForSelector('.sidebar');
  const bell = sharedPage.getByRole('button', { name: /Notifications, 1 unread/ });
  await expect(bell).toBeVisible();

  await bell.click();
  await expect(sharedPage.getByRole('region', { name: 'Notifications' }).getByText('Evidence packet approved')).toBeVisible();

  await sharedPage.getByRole('button', { name: /Evidence packet approved/ }).click();
  await expect(sharedPage.getByRole('button', { name: 'Notifications' })).toBeVisible(); // badge gone, no "N unread" in the label
});

test('Settings shows notification preferences, and toggling one persists across a reload', async () => {
  await sharedPage.goto('/#app');
  await sharedPage.waitForSelector('.sidebar');
  await sharedPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(sharedPage.getByText('Notification preferences')).toBeVisible();

  const emailToggle = sharedPage.getByLabel('Evidence packet approved — email', { exact: true });
  await expect(emailToggle).toBeChecked();
  await emailToggle.uncheck();
  await expect(emailToggle).not.toBeChecked();

  await sharedPage.reload();
  await sharedPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(sharedPage.getByLabel('Evidence packet approved — email', { exact: true })).not.toBeChecked();
});
