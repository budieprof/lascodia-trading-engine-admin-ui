import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * a11y smoke for the v2 feature waves shipped this cycle (CompositeML console,
 * ML lifecycle additions, Strategy v2 net-new pages, EA detail, market-data
 * net-new pages, system diagnostics). Routes are picked for backend-independence:
 * each renders its chrome + an empty-state or skeleton without engine data
 * (every page wires `catchError(() => of([]))` on its polled-resource).
 *
 * Auth is stubbed via the cookie-session sentinel pattern the dashboard-pages
 * spec already uses — `authGuard` consults `AuthService.isAuthenticated()` which
 * reads sessionStorage synchronously in its constructor, so seeding the key
 * before SPA boot is enough.
 *
 * Role-gated routes (Operator+ / Admin) are NOT included; their guards redirect
 * mid-test under the cookie-session stub since the in-memory roles signal is
 * not populated.
 */
const ROUTES: Array<{ name: string; path: string }> = [
  // CompositeML Operator Console (Phase 1)
  { name: 'CompositeML — Active Policies', path: '/composite-ml' },
  { name: 'CompositeML — Layer Health', path: '/composite-ml/layer-health' },
  { name: 'CompositeML — Policy Diff', path: '/composite-ml/diff' },
  { name: 'CompositeML — Layer Skill', path: '/composite-ml/layer-skill' },
  { name: 'CompositeML — Trainer Skill', path: '/composite-ml/trainer-skill' },
  { name: 'CompositeML — Drift Summary', path: '/composite-ml/drift' },
  { name: 'CompositeML — Cold Start', path: '/composite-ml/cold-start' },
  { name: 'CompositeML — Gate Cutover', path: '/composite-ml/gate-cutover' },

  // ML Lifecycle v2 (Phase 2)
  { name: 'ML — Overfit Watchlist', path: '/ml-models/overfit-watchlist' },
  { name: 'ML — Symbolic Features', path: '/ml-models/symbolic-features' },

  // Strategy v2 (Phase 3)
  { name: 'Strategies — LLM Proposals', path: '/strategies/llm-proposals' },
  { name: 'Strategies — Rejection Summary', path: '/strategies/rejections' },
  { name: 'Strategies — Templates', path: '/strategies/templates' },

  // EA Control + Market Data (Phase 5)
  { name: 'EA Detail (id 1)', path: '/ea-instances/1' },
  { name: 'Market Data — Order Book', path: '/market-data/order-book' },
  { name: 'Market Data — Candle Coverage', path: '/market-data/coverage' },

  // System diagnostics (Phase 6)
  { name: 'System — Worker Override Knobs', path: '/system-health/worker-override-knobs' },
];

const TOKEN_KEY = 'lascodia.auth.token';

for (const route of ROUTES) {
  test(`${route.name} has no detectable a11y violations`, async ({ page }) => {
    await page.addInitScript((key) => {
      sessionStorage.setItem(key, 'cookie-session');
    }, TOKEN_KEY);

    await page.goto(route.path);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Match the existing a11y suites — design-token combos routinely flag
      // here even when real-world contrast is fine.
      .disableRules(['color-contrast'])
      .analyze();

    expect.soft(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
