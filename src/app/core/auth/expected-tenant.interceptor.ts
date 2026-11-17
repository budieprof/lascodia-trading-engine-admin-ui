import { inject } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { AuthService } from './auth.service';
import { isEngineUrl } from './csrf.interceptor';
import { SessionSyncService } from './session-sync.service';

/** The organisation this tab believes it acts in; the engine refuses a call whose session differs. */
export const EXPECTED_TENANT_HEADER = 'X-Lascodia-Expected-Tenant';
/** HTTP 409 `responseCode` the engine answers when the header disagrees with the session. */
export const TENANT_CHANGED_CODE = '-409-tenant-changed';

/** True for the engine's "the session moved to another organisation" refusal. */
export function isTenantChangedError(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) return false;
  const body = error.error as { responseCode?: unknown } | null;
  return !!body && typeof body === 'object' && body.responseCode === TENANT_CHANGED_CODE;
}

/**
 * True when `url` is a same-origin call into the engine's API (`/api/…`), excluding the BFF's own
 * session endpoints (`/bff/*`). Cross-origin (the dev `localhost:5081` base) is skipped: a custom
 * header there would need a CORS pre-flight the engine does not allow for it.
 */
export function isSameOriginEngineApi(
  url: string,
  apiBaseUrl: string,
  origin: string | undefined,
): boolean {
  if (!origin || !isEngineUrl(url, apiBaseUrl, origin)) return false;
  let abs: URL;
  try {
    abs = new URL(url, `${origin}/`);
  } catch {
    return false;
  }
  if (abs.origin !== origin) return false;
  if (abs.pathname.startsWith('/bff/')) return false;
  return abs.pathname.startsWith('/api/');
}

/**
 * The expected-tenant header for a write that bypasses HttpClient (`fetch` keepalive on page unload),
 * so it gets the same "no header, no check" protection: without it a tab closing after another tab
 * switched organisation saved its chart state into the new organisation (review 2026-11-17).
 */
export function expectedTenantHeaders(
  auth: Pick<AuthService, 'mode' | 'activeTenant'>,
): Record<string, string> {
  if (auth.mode !== 'bff') return {};
  const tenantId = auth.activeTenant()?.id;
  return tenantId === undefined || tenantId === null
    ? {}
    : { [EXPECTED_TENANT_HEADER]: String(tenantId) };
}

/**
 * Review A3 (2026-11-16): every engine API call in BFF mode says which organisation this tab acts
 * in, as `X-Lascodia-Expected-Tenant: <active tenant id>`. When another tab has switched the shared
 * cookie session to a different organisation the engine refuses with HTTP 409
 * `{ status: false, responseCode: "-409-tenant-changed" }` instead of silently applying the write
 * to the other organisation; this tab then says so and reloads ({@link SessionSyncService}).
 *
 * Sits INSIDE the error interceptor, which passes that refusal through without a toast of its own.
 */
export const expectedTenantInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (auth.mode !== 'bff') return next(req);
  const tenantId = auth.activeTenant()?.id;
  if (tenantId === undefined || tenantId === null || req.headers.has(EXPECTED_TENANT_HEADER))
    return next(req);

  const origin = typeof location === 'undefined' ? undefined : location.origin;
  if (!isSameOriginEngineApi(req.url, inject(RUNTIME_CONFIG).apiBaseUrl, origin)) return next(req);

  const sync = inject(SessionSyncService);
  return next(req.clone({ setHeaders: { [EXPECTED_TENANT_HEADER]: String(tenantId) } })).pipe(
    catchError((error: unknown) => {
      if (isTenantChangedError(error)) sync.tenantChangedElsewhere();
      return throwError(() => error);
    }),
  );
};
