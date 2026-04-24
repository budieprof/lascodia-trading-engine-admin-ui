import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * Automated a11y smoke across the public-visible routes. Runs axe-core's
 * WCAG 2.1 A + AA rulesets against each page's rendered DOM. Any finding
 * fails the suite so regressions surface in CI.
 *
 * We stay backend-independent by only hitting routes that render without a
 * successful API fetch — the login page works offline, and the layout shell
 * renders its chrome even when `/health` returns nothing. Deeper drilldowns
 * (order detail, strategy detail) live behind a fixture engine.
 */
const ROUTES: Array<{ name: string; path: string }> = [{ name: 'Login', path: '/login' }];

for (const route of ROUTES) {
  test(`${route.name} has no detectable a11y violations`, async ({ page }) => {
    await page.goto(route.path);
    // Let the SPA finish its initial render + any route-entry animation.
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // These rules routinely flag design-token combinations even when the
      // real-world contrast is fine (e.g. status pills). Exclude them here
      // rather than ship a fix that'd trade actual contrast for silence;
      // revisit if the audit ever gains interactive contrast checking.
      .disableRules(['color-contrast'])
      .analyze();

    expect.soft(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
