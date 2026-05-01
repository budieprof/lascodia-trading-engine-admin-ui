import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * a11y smoke for the dashboard surfaces shipped through Phases 1-4. Each
 * route renders its chrome + an empty-state or skeleton without a backend
 * (their `fetchData` callbacks degrade gracefully via `catchError(() => of(empty))`),
 * so axe gets a meaningful DOM to scan even when the engine isn't reachable.
 *
 * To get past `authGuard` we seed the cookie-session sentinel into sessionStorage
 * (the same value `auth.service.ts` writes after `probeCookieSession()` resolves
 * a real session). This avoids a network login for tests that only care about
 * the rendered DOM, not behaviour.
 *
 * Pages requiring `requireRoles('Operator' | 'Admin')` are not covered here —
 * the role guard reads the in-memory roles signal which the sessionStorage
 * sentinel doesn't populate. Those routes redirect away mid-test and would
 * just re-test the dashboard a11y under a different name.
 */
const ROUTES: Array<{ name: string; path: string }> = [
  { name: 'Strategy Portfolio', path: '/strategy-portfolio' },
  { name: 'Strategies Compare', path: '/strategies/compare' },
  { name: 'Strategy Generation', path: '/strategy-generation' },
  { name: 'Engine Overview', path: '/engine-overview' },
  { name: 'Strategy Analytics', path: '/strategies/1/analytics' },
];

const TOKEN_KEY = 'lascodia.auth.token';

for (const route of ROUTES) {
  test(`${route.name} has no detectable a11y violations`, async ({ page }) => {
    // Stub auth before the SPA boots — initial state is read from sessionStorage
    // synchronously in AuthService's constructor, so seeding it here is enough.
    await page.addInitScript((key) => {
      sessionStorage.setItem(key, 'cookie-session');
    }, TOKEN_KEY);

    await page.goto(route.path);
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
