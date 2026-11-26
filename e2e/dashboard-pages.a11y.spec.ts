import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { signIn } from './support/console-session';

/**
 * a11y smoke for the dashboard surfaces shipped through Phases 1-4. Each
 * route renders its chrome + an empty-state or skeleton without a backend
 * (their `fetchData` callbacks degrade gracefully via `catchError(() => of(empty))`),
 * so axe gets a meaningful DOM to scan even when the engine isn't reachable.
 *
 * Signed in with the stand-in BFF session (`support/console-session.ts`): the house organisation and
 * every permission, with the engine answered locally (GETs 503, writes aborted). Each test first
 * checks the console shell is up, so a spec can never again pass by scanning the sign-in screen.
 */
const ROUTES: Array<{ name: string; path: string }> = [
  { name: 'Strategy Portfolio', path: '/strategy-portfolio' },
  { name: 'Strategies Compare', path: '/strategies/compare' },
  { name: 'Strategy Generation', path: '/strategy-generation' },
  { name: 'Engine Overview', path: '/engine-overview' },
  { name: 'Strategy Analytics', path: '/strategies/1/analytics' },
];

for (const route of ROUTES) {
  test(`${route.name} has no detectable a11y violations`, async ({ page }) => {
    await signIn(page);

    await page.goto(route.path);
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Match the existing a11y spec — design-token combos routinely flag here
      // even when real-world contrast is fine.
      .disableRules(['color-contrast'])
      .analyze();

    expect.soft(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
