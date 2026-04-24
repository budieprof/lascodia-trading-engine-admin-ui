import { expect, test } from '@playwright/test';

/**
 * Boot smoke test: we load the root, wait for the Angular bundle to mount,
 * and verify the app shell renders. The test survives backend outages —
 * we only assert on DOM shipped by the admin UI itself. Deeper workflows
 * (approve signal, toggle kill switch, etc.) are tracked as separate
 * specs and skipped by default until a fixture backend is wired.
 */
test.describe('app shell', () => {
  test('bundle mounts at /', async ({ page }) => {
    await page.goto('/');
    // The layout component renders <app-sidebar> as soon as bootstrap completes,
    // regardless of whether the API is reachable.
    await expect(page.locator('app-sidebar')).toBeVisible({ timeout: 30_000 });
  });

  test('sidebar exposes major navigation groups', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-sidebar')).toBeVisible({ timeout: 30_000 });
    // Nav labels appear when the sidebar is expanded (default state on desktop viewport).
    for (const label of ['Dashboard', 'Orders', 'Strategies', 'ML Models']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test('⌘K opens the command palette', async ({ page, browserName }) => {
    await page.goto('/');
    await expect(page.locator('app-sidebar')).toBeVisible({ timeout: 30_000 });
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+KeyK`);
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /command palette/i })).toHaveCount(0);
  });

  test('? opens the keyboard-help overlay', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-sidebar')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
  });
});
