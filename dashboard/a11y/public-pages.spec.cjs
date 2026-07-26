/**
 * Automated WCAG 2.2 AA scan (axe-core) of every public, unauthenticated
 * page — landing, pricing, and all legal pages. Fails on any "serious" or
 * "critical" violation; "moderate"/"minor" are logged but don't fail the
 * build (keeps the gate meaningful without blocking on borderline rules).
 *
 * This covers automated WCAG testing. It does NOT cover manual assistive-
 * technology testing (screen reader walkthroughs, keyboard-only navigation
 * review by a human) — axe-core catches roughly 30-50% of WCAG issues by
 * design; the rest genuinely needs a human. See TODO.md.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const PAGES = [
  { path: '/', name: 'landing' },
  { path: '/#pricing', name: 'pricing' },
  { path: '/#security', name: 'security' },
  { path: '/#privacy', name: 'privacy' },
  { path: '/#terms', name: 'terms' },
  { path: '/#ai-limitations', name: 'ai-limitations' },
  { path: '/#about', name: 'about' },
];

const BLOCKING_IMPACT = new Set(['serious', 'critical']);

for (const { path, name } of PAGES) {
  test(`${name} page has no serious/critical WCAG 2.2 AA violations`, async ({ page }) => {
    await page.goto(path);
    // Hash-route pages need the app's hashchange listener to settle.
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    const blocking = results.violations.filter((v) => BLOCKING_IMPACT.has(v.impact));
    const nonBlocking = results.violations.filter((v) => !BLOCKING_IMPACT.has(v.impact));

    if (nonBlocking.length) {
      console.log(`[a11y] ${name}: ${nonBlocking.length} non-blocking (moderate/minor) violation(s): ${nonBlocking.map((v) => v.id).join(', ')}`);
    }
    if (blocking.length) {
      const detail = blocking.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join('\n');
      console.log(`[a11y] ${name}: BLOCKING violations:\n${detail}`);
    }
    expect(blocking, `${name} page has serious/critical WCAG violations`).toEqual([]);
  });
}
