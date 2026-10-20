import { inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { AuthService } from './auth.service';
import { BffSessionService } from './bff-session.service';
import { CSRF_HEADER } from './bff.types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * True when `url` goes to the engine: under the configured base when there is one (dev), else a
 * same-origin path (a release bakes `apiBaseUrl: ""`). Third-party URLs never get the token.
 */
export function isEngineUrl(url: string, apiBaseUrl: string, origin?: string): boolean {
  const base = apiBaseUrl.replace(/\/$/, '');
  if (base) return url.startsWith(`${base}/`);
  if (url.startsWith('/')) return !url.startsWith('//');
  return !!origin && url.startsWith(`${origin}/`);
}

/**
 * Contract C3.1: an unsafe request (POST, PUT, PATCH, DELETE) authenticated by the session cookie
 * must carry `X-CSRF-Token: <the session's csrfToken>`, or the engine answers 403 `-403-csrf`. Only
 * with `bffAuth` on, and only to the engine.
 */
export const csrfInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (auth.mode !== 'bff' || SAFE_METHODS.has(req.method.toUpperCase())) return next(req);

  const base = inject(RUNTIME_CONFIG).apiBaseUrl;
  const origin = typeof location === 'undefined' ? undefined : location.origin;
  if (!isEngineUrl(req.url, base, origin)) return next(req);

  const token = inject(BffSessionService).csrfToken();
  if (!token || req.headers.has(CSRF_HEADER)) return next(req);
  return next(req.clone({ setHeaders: { [CSRF_HEADER]: token } }));
};
