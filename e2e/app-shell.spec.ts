import { expect, test, type Page } from '@playwright/test';

import { signedOut, signIn } from './support/console-session';

/**
 * Boot smoke test: load the app, wait for the Angular bundle to mount and check
 * the shell renders. The engine is answered by `support/console-session.ts`, so
 * the test only asserts on DOM shipped by the admin UI itself.
 *
 * Since the public landing page (2026-10-28), `/` serves the landing page to a
 * visitor who is not signed in and the console to one who is.
 */
async function openConsole(page: Page): Promise<void> {
  await signIn(page);
  await page.goto('/');
  // The layout renders the sidebar as soon as bootstrap completes, whether or
  // not the API is reachable.
  await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('public landing', () => {
  test('a signed-out visitor at / gets the landing page', async ({ page }) => {
    await signedOut(page);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toHaveCount(0);
  });
});

test.describe('app shell', () => {
  test('bundle mounts at /', async ({ page }) => {
    await openConsole(page);
  });

  test('sidebar exposes major navigation groups', async ({ page }) => {
    await openConsole(page);
    // Nav labels appear when the sidebar is expanded (default state on desktop viewport).
    for (const label of ['Dashboard', 'Orders', 'Strategies', 'ML Models']) {
      await expect(
        page
          .getByRole('complementary', { name: 'Primary navigation' })
          .getByText(label, { exact: true })
          .first(),
      ).toBeVisible();
    }
  });

  test('⌘K opens the command palette', async ({ page, browserName }) => {
    await openConsole(page);
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+KeyK`);
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /command palette/i })).toHaveCount(0);
  });

  test('? opens the keyboard-help overlay', async ({ page }) => {
    await openConsole(page);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
  });
});
