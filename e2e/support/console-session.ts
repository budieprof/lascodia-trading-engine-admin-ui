import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

/**
 * Signs a spec into the console with a stand-in session, without any engine.
 *
 * The console signs people in through the BFF: it asks `<apiBaseUrl>/bff/session` who is signed in and
 * sends engine calls with the session cookie. In BFF mode it also discards the legacy sessionStorage token
 * at start-up, so the old `sessionStorage['lascodia.auth.token'] = 'cookie-session'` stub ends at the
 * landing page (`/`) or `/login` (anything else). Every signed-in spec rendered the sign-in screen instead
 * of the page it named until this fixture replaced the stub.
 *
 * Everything sent to the engine origin is answered here, so a spec never depends on (or reaches) a real
 * engine, even on a laptop where :5081 is tunnelled to production:
 *   - `/bff/session` answers the house organisation, platform staff, every permission the console knows;
 *   - other `/bff/*` calls answer 204;
 *   - every other call answers 404, reads and writes alike, so pages show their own empty/unavailable
 *     state, the same on every run. Not 5xx and not an abort: the console raises a toast over the page
 *     for a 5xx ("A server error occurred") and for status 0 ("Unable to connect"), but not for a 404.
 *     Many reads are POSTs (paged lists), so writes cannot simply be aborted either.
 */
const ENGINE_ORIGIN = 'http://localhost:5081';

const PERMISSIONS = [
  ...readFileSync(
    resolve(process.cwd(), 'src/app/core/auth/permissions.generated.ts'),
    'utf8',
  ).matchAll(/key: '([a-z0-9_.:-]+)'/g),
].map((m) => m[1]);

function session(): Record<string, unknown> {
  // A fixed clock keeps the session identical between runs (visual baselines).
  const signedInAt = '2026-01-01T00:00:00.000Z';
  return {
    user: { id: 1, username: 'e2e', displayName: 'E2E Operator', email: 'e2e@example.test' },
    activeTenant: { id: 1, slug: 'house', name: 'House', kind: 'House' },
    memberships: [{ tenantId: 1, slug: 'house', name: 'House', status: 'Active' }],
    permissions: PERMISSIONS,
    isPlatformStaff: true,
    impersonation: null,
    csrfToken: 'e2e',
    mfa: { satisfied: true, authTimeUtc: signedInAt },
    sessionId: 'e2e',
    expiresAtUtc: '2099-01-01T00:00:00.000Z',
    idleTimeoutSeconds: 8 * 3600,
  };
}

/**
 * Shared set-up for both states:
 *   - live-update sockets to the engine origin are refused, so none can reach a real engine either;
 *   - the Google Fonts stylesheet (`styles.scss` imports Inter from it) answers empty, so every run
 *     renders with the same local fallback font. Whether and when the web font arrived used to decide
 *     every glyph on the page, which made the visual baselines differ run to run.
 */
async function isolate(page: Page): Promise<void> {
  await page.routeWebSocket(/^wss?:\/\/localhost:5081\//, (ws) => ws.close());
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
}

export async function signIn(page: Page): Promise<void> {
  await isolate(page);
  await page.route(`${ENGINE_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/bff/session') return route.fulfill({ json: session() });
    if (path.startsWith('/bff/')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({
      status: 404,
      json: { status: false, message: 'engine not available in e2e' },
    });
  });
}

/** Signed out: the engine answers that nobody is signed in, and nothing reaches a real engine. */
export async function signedOut(page: Page): Promise<void> {
  await isolate(page);
  await page.route(`${ENGINE_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 401, json: { status: false, message: 'not signed in' } }),
  );
}
