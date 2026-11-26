import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { signIn } from './support/console-session';

/**
 * a11y smoke for the v2 feature waves shipped this cycle (CompositeML console,
 * ML lifecycle additions, Strategy v2 net-new pages, EA detail, market-data
 * net-new pages, system diagnostics). Routes are picked for backend-independence:
 * each renders its chrome + an empty-state or skeleton without engine data
 * (every page wires `catchError(() => of([]))` on its polled-resource).
 *
 * Signed in with the stand-in BFF session (`support/console-session.ts`): the house organisation and
 * every permission, with the engine answered locally (GETs 503, writes aborted). Each test first
 * checks the console shell is up, so a spec can never again pass by scanning the sign-in screen.
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
      // Match the existing a11y suites — design-token combos routinely flag
      // here even when real-world contrast is fine.
      .disableRules(['color-contrast'])
      .analyze();

    expect.soft(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
