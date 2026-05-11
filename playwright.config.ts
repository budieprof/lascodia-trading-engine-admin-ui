import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for E2E smoke tests. The dev server is started automatically
 * via `webServer` — individual tests gracefully skip when the trading engine
 * isn't reachable (they look for evidence of booted content, not just a 200).
 *
 * Run with:
 *   npx playwright install      # one-time browser download
 *   npm run e2e                 # headless
 *   npm run e2e:ui              # interactive runner
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Visual regression posture: small per-pixel tolerance + a max
  // diff-pixel cap so anti-aliased text and animation frames don't
  // trigger false positives. Baselines are platform-specific (Ubuntu
  // for CI; macOS-darker fonts will diff against them) — use the
  // `visual-baseline` workflow (manual dispatch) to refresh baselines
  // from CI.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      maxDiffPixels: 800,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  // Co-locate snapshot binaries with their spec so the e2e/ tree is
  // self-contained — easier to scan when reviewing baseline changes.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env['E2E_BASE_URL']
    ? undefined
    : {
        command: 'npm start',
        url: 'http://localhost:4200',
        reuseExistingServer: !process.env['CI'],
        timeout: 120_000,
      },
});
