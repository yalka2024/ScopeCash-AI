/**
 * Authenticated nav-smoke e2e suite — promoted from the ad hoc Playwright
 * script used to QA the "Final phase" nav rewrite (see STATUS.md), which
 * caught three real bugs (two 500s from a missing createdAt column, an
 * unmounted help.js router, and a route-ordering bug that shadowed public
 * endpoints) that a clean `npm run build` and the WCAG scan both missed.
 * That script was throwaway and never committed; this is the deterministic,
 * committed version.
 *
 * Registers a real (non-admin) user via the actual UI register flow, then
 * clicks every nav destination that role can see, asserting on each:
 *   - no new browser console errors
 *   - no uncaught page errors (`pageerror`)
 *   - no failed (5xx) network responses
 *   - the main content area actually rendered non-empty content (guards
 *     against a crashed render that mounts nothing — which an axe scan
 *     alone would silently pass, since zero DOM means zero violations)
 *
 * Complements, not duplicates, playwright.authed.config.cjs's
 * authenticated-pages.spec.cjs (WCAG + keyboard-a11y, admin session) — this
 * suite's whole point is a DIFFERENT failure signal (crashes/errors) on a
 * DIFFERENT, more representative session (a normal registered user, not an
 * admin walking admin-only pages).
 */
const { test, expect } = require('@playwright/test');

const EMAIL = `nav-smoke-${Date.now()}@test.local`;
const PASSWORD = 'Correct-Horse-Battery-9!';
const NAME = 'Nav Smoke User';

// Every nav destination visible to a NON-admin authenticated user (App.js
// WORKFLOW_NAV + the always-visible standalone items) — matches the 14
// destinations the original ad hoc script walked (see STATUS.md).
const NAV_LABELS = [
  'Projects', 'Evidence', 'Findings', 'Packets', 'Outcomes', 'Customers',
  'Agent Activity', 'AI Assistant', 'Marketplace', 'Security', 'Status',
  'Settings', 'Pricing', 'Help centre',
];

test.describe.configure({ mode: 'serial' });

let sharedContext;
let sharedPage;
let consoleErrors;
let pageErrors;
let failedResponses;

function attachErrorListeners(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('response', (res) => {
    if (res.status() >= 500) failedResponses.push(`${res.status()} ${res.url()}`);
  });
}

test.beforeAll(async ({ browser }) => {
  consoleErrors = [];
  pageErrors = [];
  failedResponses = [];
  sharedContext = await browser.newContext();
  sharedPage = await sharedContext.newPage();
  attachErrorListeners(sharedPage);

  await sharedPage.goto('/#login');
  await sharedPage.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  await sharedPage.getByRole('button', { name: /Don.t have an account\?/ }).click();
  await sharedPage.getByLabel('Full name').fill(NAME);
  await sharedPage.getByLabel('Email address').fill(EMAIL);
  await sharedPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await sharedPage.getByRole('button', { name: 'Create Account' }).click();
  await sharedPage.waitForSelector('.sidebar', { timeout: 20_000 });
});

test.afterAll(async () => {
  await sharedContext.close();
});

test('registration lands on a real, non-empty dashboard with no errors', async () => {
  await expect(sharedPage.locator('.content')).not.toBeEmpty();
  expect(consoleErrors, `console errors during registration:\n${consoleErrors.join('\n')}`).toEqual([]);
  expect(pageErrors, `uncaught page errors during registration:\n${pageErrors.join('\n')}`).toEqual([]);
  expect(failedResponses, `failed (5xx) responses during registration:\n${failedResponses.join('\n')}`).toEqual([]);
});

for (const label of NAV_LABELS) {
  test(`"${label}" renders with no console errors, page errors, or failed requests`, async () => {
    const startConsole = consoleErrors.length;
    const startPage = pageErrors.length;
    const startFailed = failedResponses.length;

    await sharedPage.goto('/#app');
    await sharedPage.waitForSelector('.sidebar');
    await sharedPage.getByRole('button', { name: label, exact: true }).click();
    await sharedPage.waitForLoadState('networkidle').catch(() => {});
    // A couple of pages (e.g. Help centre) issue a fetch that can resolve a
    // beat after 'networkidle' fires — without this, a real failure here
    // gets misattributed to whichever test runs next instead of this one
    // (confirmed by deliberately reintroducing the unmounted-help.js-router
    // bug this suite exists to catch: the 404 initially surfaced on the
    // FOLLOWING test, not this one, until this wait was added).
    await sharedPage.waitForTimeout(250);

    // Guards against a silent crash that mounts nothing — zero DOM content
    // would trivially pass an error-listener-only check.
    await expect(sharedPage.locator('.content')).not.toBeEmpty();

    const newConsoleErrors = consoleErrors.slice(startConsole);
    const newPageErrors = pageErrors.slice(startPage);
    const newFailedResponses = failedResponses.slice(startFailed);
    expect(newConsoleErrors, `"${label}": console errors:\n${newConsoleErrors.join('\n')}`).toEqual([]);
    expect(newPageErrors, `"${label}": uncaught page errors:\n${newPageErrors.join('\n')}`).toEqual([]);
    expect(newFailedResponses, `"${label}": failed (5xx) responses:\n${newFailedResponses.join('\n')}`).toEqual([]);
  });
}

test('sign out returns to the logged-out landing/login surface with no errors', async () => {
  const startConsole = consoleErrors.length;
  const startPage = pageErrors.length;

  await sharedPage.goto('/#app');
  await sharedPage.waitForSelector('.sidebar');
  await sharedPage.getByRole('button', { name: 'Sign Out' }).click();
  await sharedPage.waitForSelector('.sidebar', { state: 'detached', timeout: 10_000 });

  expect(consoleErrors.slice(startConsole)).toEqual([]);
  expect(pageErrors.slice(startPage)).toEqual([]);
});
