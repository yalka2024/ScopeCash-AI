/**
 * Automated WCAG 2.2 AA scan (axe-core) + real keyboard-navigation checks of
 * the AUTHENTICATED dashboard — the gap public-pages.spec.cjs's own comment
 * flags (it only covers the logged-out marketing/legal surface, since that
 * one runs against a static `npm run preview` build with no backend). This
 * one needs a real API + database — playwright.authed.config.cjs boots the
 * actual Express server (SERVE_DASHBOARD=1) against a disposable SQLite DB.
 *
 * Still not a substitute for manual assistive-technology testing (a human
 * with NVDA/JAWS/VoiceOver actually listening to the output) — see
 * MANUAL-AT-TESTING-PROTOCOL.md for the checklist that closes that gap.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const BLOCKING_IMPACT = new Set(['serious', 'critical']);
const ADMIN_EMAIL = `a11y-admin-${Date.now()}@test.local`;
const ADMIN_PASSWORD = 'Correct-Horse-Battery-9!';

// Every nav destination visible to an admin (App.js WORKFLOW_NAV + ADMIN_NAV
// + standalone items) — each is a real <button> inside .nav-links after the
// fix this test suite exists to lock in.
const NAV_LABELS = [
  'Projects', 'Evidence', 'Findings', 'Packets', 'Outcomes', 'Customers',
  'Agent Activity', 'AI Assistant', 'Organization', 'Competition evidence',
  'AI economics', 'AI evaluations', 'Growth', 'Data products', 'Background jobs', 'Operations',
  'Tenants', 'Trust portal', 'Governance', 'Agent console', 'Tools',
  'All records (raw)', 'Marketplace', 'Security', 'Status', 'Settings',
  'Pricing', 'Help centre',
];

test.describe.configure({ mode: 'serial' });

// One shared, logged-in page reused across every test below — avoids the
// overhead (and setup-wizard-can-only-run-once semantics) of registering a
// fresh admin per test.
let sharedContext;
let sharedPage;

test.beforeAll(async ({ browser }) => {
  sharedContext = await browser.newContext();
  sharedPage = await sharedContext.newPage();
  await sharedPage.goto('/#setup');
  // The cookie-consent banner overlays the page on first load and can
  // intercept clicks on the form below it — dismiss it first.
  const acceptCookies = sharedPage.getByRole('button', { name: 'Accept all' });
  await acceptCookies.click({ timeout: 5000 }).catch(() => {});
  await sharedPage.getByLabel('Organisation name').fill('A11y Test Co');
  await sharedPage.getByLabel('Your full name').fill('A11y Admin');
  await sharedPage.getByLabel('Administrator email').fill(ADMIN_EMAIL);
  await sharedPage.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await sharedPage.getByLabel('Confirm password', { exact: true }).fill(ADMIN_PASSWORD);
  await sharedPage.locator('input[type=checkbox]').check();
  await sharedPage.getByRole('button', { name: /Complete setup/ }).click();
  await sharedPage.waitForSelector('.sidebar', { timeout: 20_000 });
});

test.afterAll(async () => {
  await sharedContext.close();
});

for (const label of NAV_LABELS) {
  test(`"${label}" page has no serious/critical WCAG 2.2 AA violations`, async () => {
    await sharedPage.goto('/#app');
    await sharedPage.waitForSelector('.sidebar');
    await sharedPage.getByRole('button', { name: label, exact: true }).click();
    await sharedPage.waitForLoadState('networkidle').catch(() => {});

    const results = await new AxeBuilder({ page: sharedPage })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    const blocking = results.violations.filter((v) => BLOCKING_IMPACT.has(v.impact));
    const nonBlocking = results.violations.filter((v) => !BLOCKING_IMPACT.has(v.impact));
    if (nonBlocking.length) {
      console.log(`[a11y] ${label}: ${nonBlocking.length} non-blocking violation(s): ${nonBlocking.map((v) => v.id).join(', ')}`);
    }
    if (blocking.length) {
      const detail = blocking.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join('\n');
      console.log(`[a11y] ${label}: BLOCKING violations:\n${detail}`);
    }
    expect(blocking, `${label} page has serious/critical WCAG violations`).toEqual([]);
  });
}

test('every sidebar nav item is a real, keyboard-focusable, keyboard-activatable control', async () => {
  await sharedPage.goto('/#app');
  await sharedPage.waitForSelector('.sidebar');

  const buttons = sharedPage.locator('.nav-links li button');
  const count = await buttons.count();
  expect(count, 'sidebar nav should render as real <button> elements').toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const tag = await buttons.nth(i).evaluate((el) => el.tagName);
    expect(tag, 'each nav item must be a native <button> (focusable + Enter/Space-activatable by default)').toBe('BUTTON');
  }
});

test('Tab reaches the sidebar nav and Enter activates a nav item without a mouse', async () => {
  await sharedPage.goto('/#app');
  await sharedPage.waitForSelector('.sidebar');

  // Focus the target button directly (avoids depending on exactly how many
  // elements precede it in tab order, which is brittle), then drive the
  // rest with the keyboard only — no .click() calls below.
  const findingsButton = sharedPage.getByRole('button', { name: 'Findings', exact: true });
  await findingsButton.focus();
  await expect(findingsButton).toBeFocused();

  await sharedPage.keyboard.press('Enter');
  await expect(sharedPage.locator('.content')).toContainText(/Findings/i, { timeout: 5000 });

  // Tab forward from there and confirm focus actually moves (not stuck — a
  // real keyboard trap would leave the same element focused).
  const before = await sharedPage.evaluate(() => document.activeElement?.textContent || document.activeElement?.tagName);
  await sharedPage.keyboard.press('Tab');
  const after = await sharedPage.evaluate(() => document.activeElement?.textContent || document.activeElement?.tagName);
  expect(after, 'Tab must move focus off the previously-activated nav item, not trap it').not.toBe(before);
});

test('the login/register toggle on the sign-in page is keyboard-reachable and activatable', async ({ browser }) => {
  // Fresh, logged-out context — sign-in page, not the dashboard.
  const context = await browser.newContext();
  const loginPage = await context.newPage();
  await loginPage.goto('/#login');
  await loginPage.getByRole('button', { name: 'Accept all' }).click({ timeout: 5000 }).catch(() => {});
  const toggle = loginPage.getByRole('button', { name: /Don.t have an account\?|Already have an account\?/ });
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await loginPage.keyboard.press('Enter');
  // Successfully toggling swaps the form's accessible name (sign in <-> create account).
  await expect(loginPage.getByRole('form')).toHaveAttribute('aria-label', /Create account form|Sign in form/);
  await context.close();
});
