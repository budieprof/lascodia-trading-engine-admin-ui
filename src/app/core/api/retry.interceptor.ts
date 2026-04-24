import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { retry, timer, throwError } from 'rxjs';

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 400;

/**
 * Retry GET requests twice with exponential backoff (400ms → 800ms) when the
 * failure looks transient: network blip (status 0), gateway (502/503/504),
 * or rate-limit (429). Only GETs — never retry a POST/PUT/DELETE, those
 * aren't safe to repeat.
 *
 * Install after authInterceptor so the retry picks up the current token each
 * attempt, and before errorInterceptor so the toast only fires on final failure.
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
