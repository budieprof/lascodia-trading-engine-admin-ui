import { inject } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService, isStepUpError } from './auth.service';
import { NotificationService } from '../notifications/notification.service';
import { ResponseData } from '../api/api.types';
import { SUPPRESS_ERROR_TOAST } from '../api/api.service';
import { AuthResponseCode, CSRF_HEADER } from './bff.types';
import { CSRF_RETRIED, SKIP_SESSION_HANDLING } from './http-context';
import { StepUpService } from './step-up.service';
import { quotaRefusalMessage } from '../plans/quota-refusal';

function responseCodeOf(error: HttpErrorResponse): string | null {
  const body = error.error as { responseCode?: unknown } | null;
  return body && typeof body === 'object' && typeof body.responseCode === 'string'
    ? body.responseCode
    : null;
}

/**
 * `bffAuth` on (contract C3.1/C3.2): the browser holds no token, so there is nothing to refresh —
 * the engine refreshes the session's tokens itself. A 401 is therefore one of two things:
 *  - a step-up challenge (`-401-stepup`): go and sign in again with a second factor, then offer to
 *    finish the refused action ({@link StepUpService});
 *  - the session is gone (revoked, expired, idle): send the person to sign in again.
 * A 403 `-403-csrf` means our CSRF token is stale (the session rotated it): re-read the session
 * and retry the request ONCE with the new token.
 * Returns null when the error is not one of these, so the common handling applies.
 */
function handleBffAuthError(
  req: HttpRequest<unknown>,
  retry: (r: HttpRequest<unknown>) => Observable<HttpEvent<unknown>>,
  error: HttpErrorResponse,
  auth: AuthService,
  notify: NotificationService,
  stepUp: StepUpService,
): Observable<HttpEvent<unknown>> | null {
  if (req.context.get(SKIP_SESSION_HANDLING)) return null;

  if (error.status === 401) {
    if (isStepUpError(error)) {
      stepUp.challenge(req);
      return throwError(() => error);
    }
    if (auth.isAuthenticated()) {
      notify.error('Your session has ended. Sign in again to continue.');
      auth.sessionEnded();
    }
    return throwError(() => error);
  }

  if (
    error.status === 403 &&
    responseCodeOf(error) === AuthResponseCode.Csrf &&
    !req.context.get(CSRF_RETRIED)
  ) {
    return from(auth.refreshSession()).pipe(
      switchMap((session) => {
        if (!session?.csrfToken) return throwError(() => error);
        // Through the whole error handling again (a second refusal is explained, not retried).
        return retry(
          req.clone({
            setHeaders: { [CSRF_HEADER]: session.csrfToken },
            context: req.context.set(CSRF_RETRIED, true),
          }),
        );
      }),
    );
  }
  return null;
}

/**
 * Paths we never try to silently refresh on a 401 — refreshing during login
 * or refresh itself would loop forever, and the logout endpoint failing with
 * 401 just means the server has already moved on (no need to fight it).
 */
const REFRESH_EXEMPT = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/token'];

/**
 * Of the refresh-exempt paths, only a failed *refresh* means the session is
 * genuinely beyond saving. A 401 from a login endpoint means the credentials
 * were wrong — the login form reports that itself — and from logout it means
 * the server has already dropped the session. Tearing down on those was
 * actively harmful: it re-navigated to /login, which discarded the returnUrl
 * the user was carrying, and toasted "Session expired" over a plain typo.
 *
 * Substring-matched, so `/admin/auth/refresh` is covered by the same entry.
 */
const SESSION_ENDING_PATHS = ['/auth/refresh'];

function shouldAttemptRefresh(req: HttpRequest<unknown>): boolean {
  // Marker header set by the retried request — never refresh more than once
  // per original call to avoid recursive loops on a genuinely-bad token.
  if (req.headers.has('X-Skip-Auth-Retry')) return false;
  return !REFRESH_EXEMPT.some((p) => req.url.includes(p));
}

export const errorInterceptor: HttpInterceptorFn = (original, next) => {
  const authService = inject(AuthService);
  const notificationService = inject(NotificationService);
  const stepUp = authService.mode === 'bff' ? inject(StepUpService) : null;

  const run = (req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> =>
    next(req).pipe(
      catchError((error: HttpErrorResponse) => {
        if (stepUp) {
          const handled = handleBffAuthError(
            req,
            run,
            error,
            authService,
            notificationService,
            stepUp,
          );
          if (handled) return handled;
          // A 401 the BFF branch passed over (a session probe) is the caller's to explain.
          if (error.status === 401) return throwError(() => error);
          // Refusals carry a specific reason in BFF mode (read-only impersonation, wrong
          // organisation, policy) — show it rather than the generic line.
          if (error.status === 403 && !req.context.get(SUPPRESS_ERROR_TOAST)) {
            const body = error.error as ResponseData<unknown> | null;
            notificationService.error(
              quotaRefusalMessage(error) ??
                (body?.message || 'You do not have permission to perform this action.'),
            );
            return throwError(() => error);
          }
        }

        if (error.status === 401) {
          // Try to silently renew the session before giving up. The product
          // requirement is "never log me out automatically" — every 401 first
          // gets one refresh attempt; only if refresh ITSELF fails do we tear
          // the session down and route to /login.
          if (shouldAttemptRefresh(req)) {
            return authService.refreshToken().pipe(
              switchMap((newToken) => {
                if (!newToken) {
                  // Refresh failed too — the token is genuinely beyond saving
                  // (jti revoked, past grace window, account deactivated).
                  // This is the only path that drops the session.
                  //
                  // expired:true so the route the user was on is captured as a
                  // returnUrl and login puts them back there rather than on the
                  // dashboard.
                  //
                  // Guarded on actually HAVING a session: on a cold boot the
                  // first probe 401s, the refresh has nothing to renew, and a
                  // visitor who never logged in would be told their session
                  // expired over an empty state.
                  if (authService.isAuthenticated()) {
                    authService.logout({ expired: true });
                    notificationService.error('Session expired. Please log in again.');
                  }
                  return throwError(() => error);
                }
                // Re-issue the original request with the fresh bearer attached
                // and an X-Skip-Auth-Retry marker so a *second* 401 from the
                // retry doesn't kick off another refresh cycle.
                const retried = req.clone({
                  setHeaders: {
                    Authorization: `Bearer ${newToken}`,
                    'X-Skip-Auth-Retry': '1',
                  },
                });
                return next(retried);
              }),
            );
          }

          // Refresh-exempt path hit a 401. Only refresh failing here is a dead
          // session; login/logout 401s are handled by their own callers.
          if (
            SESSION_ENDING_PATHS.some((p) => req.url.includes(p)) &&
            authService.isAuthenticated()
          ) {
            authService.logout({ expired: true });
            notificationService.error('Session expired. Please log in again.');
          }
          return throwError(() => error);
        }

        // The caller owns the error presentation (inline error state + retry).
        // Session handling above still applies; only the toast is withheld.
        if (req.context.get(SUPPRESS_ERROR_TOAST)) {
          return throwError(() => error);
        }

        if (error.status === 403) {
          // A plan quota refusal says what the plan allows; anything else is a permission refusal.
          notificationService.error(
            quotaRefusalMessage(error) ?? 'You do not have permission to perform this action.',
          );
          return throwError(() => error);
        }

        // Check for business error in response body
        const body = error.error as ResponseData<unknown> | null;
        if (body && body.responseCode && !body.status) {
          const message = body.message ?? `Request failed [${body.responseCode}]`;
          notificationService.error(message);
          return throwError(() => error);
        }

        if (error.status === 0) {
          notificationService.error('Unable to connect to the server. Please check your network.');
        } else if (error.status >= 500) {
          notificationService.error('A server error occurred. Please try again later.');
        } else if (error.status !== 404) {
          const fallbackMessage =
            error.error?.message ?? error.message ?? 'An unexpected error occurred.';
          notificationService.error(fallbackMessage);
        }

        return throwError(() => error);
      }),
    );

  return run(original);
};
