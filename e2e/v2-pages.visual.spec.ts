import { expect, test } from '@playwright/test';

/**
 * Visual-regression baseline for the v2 feature waves. Companion to
 * v2-pages.a11y.spec.ts — same route set, same auth-stub pattern, but
 * captures a full-page screenshot per route and compares against the
 * committed baseline.
 *
 * **Operational notes:**
 *   - Baselines live under `e2e/__screenshots__/v2-pages.visual.spec.ts/`
 *     and MUST be generated on the same OS/browser combo as CI (Ubuntu
 *     22.04 + Playwright's bundled Chromium). Running locally on macOS
 *     will diff against committed baselines because of OS-level font
 *     antialiasing differences — that's expected, don't commit the
 *     macOS-rendered images.
 *   - To refresh baselines after intentional UI changes: trigger the
 *     `visual-baseline` workflow_dispatch action. It runs Playwright
 *     with `--update-snapshots` and opens a PR with the new baselines.
 *   - All checks use `expect.soft` so one regression doesn't short-circuit
 *     the rest of the suite — operators see every diff at once in the
 *     Playwright report rather than chasing them one at a time.
 *
 * Tolerance settings live in playwright.config.ts under `expect`:
 * 0.2% pixel ratio + 800 absolute pixels covers AA jitter without
 * masking real layout changes.
 */
const ROUTES: Array<{ name: string; path: string }> = [
  // CompositeML Operator Console (Phase 1)
  { name: 'composite-ml-active-policies', path: '/composite-ml' },
  { name: 'composite-ml-layer-health', path: '/composite-ml/layer-health' },
  { name: 'composite-ml-policy-diff', path: '/composite-ml/diff' },
  { name: 'composite-ml-drift-summary', path: '/composite-ml/drift' },

  // ML Lifecycle v2 (Phase 2)
  { name: 'ml-overfit-watchlist', path: '/ml-models/overfit-watchlist' },
  { name: 'ml-symbolic-features', path: '/ml-models/symbolic-features' },

  // Strategy v2 (Phase 3)
  { name: 'strategies-llm-proposals', path: '/strategies/llm-proposals' },
  { name: 'strategies-rejection-summary', path: '/strategies/rejections' },
  { name: 'strategies-templates', path: '/strategies/templates' },

  // EA Control + Market Data (Phase 5)
  { name: 'market-data-order-book', path: '/market-data/order-book' },
  { name: 'market-data-coverage', path: '/market-data/coverage' },

  // System diagnostics (Phase 6)
  { name: 'system-worker-override-knobs', path: '/system-health/worker-override-knobs' },

  // New feeds (PRD-V2 FR-5.4 / FR-5.8)
  { name: 'trade-signals-feedback', path: '/trade-signals/feedback' },
  { name: 'positions-deltas', path: '/positions/deltas' },
];

const TOKEN_KEY = 'lascodia.auth.token';

for (const route of ROUTES) {
  test(`${route.name} matches visual baseline`, async ({ page }) => {
    await page.addInitScript((key) => {
      sessionStorage.setItem(key, 'cookie-session');
    }, TOKEN_KEY);

    await page.goto(route.path);
    await page.waitForLoadState('networkidle');

    // Settle frame for any final layout shifts (skeleton-to-content
    // transitions, lazy-loaded panel content). Short enough to keep the
    // suite fast; long enough to catch the common cases.
    await page.waitForTimeout(500);

    await expect.soft(page).toHaveScreenshot(`${route.name}.png`, {
      fullPage: true,
    });
  });
}
