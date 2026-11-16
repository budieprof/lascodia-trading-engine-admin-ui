import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { retry, timer, throwError } from 'rxjs';

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 400;

/**
 * Retry GET requests twice with exponential backoff (800ms → 1600ms) when the
 * failure looks transient: network blip (status 0), gateway (502/503/504),
 * or rate-limit (429). Only GETs — never retry a POST/PUT/DELETE, those
 * aren't safe to repeat.
 *
 * Listed AFTER errorInterceptor in app.config.ts: an earlier interceptor wraps the later ones,
 * so the error interceptor only sees the failure this one finally gives up on — one toast per
 * request, not one per attempt. Each attempt re-sends the request as the interceptors above
 * built it (auth / CSRF / expected-tenant headers included).
 */
export const retryInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET') return next(req);

  return next(req).pipe(
    retry({
      count: MAX_RETRIES,
      delay: (error, attemptIndex) => {
        if (!isTransient(error)) return throwError(() => error);
        const wait = BASE_DELAY_MS * Math.pow(2, attemptIndex);
        return timer(wait);
      },
    }),
  );
};

function isTransient(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse)) return false;
  const s = error.status;
  return s === 0 || s === 429 || s === 502 || s === 503 || s === 504;
}
