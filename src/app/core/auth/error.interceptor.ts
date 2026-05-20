import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { NotificationService } from '../notifications/notification.service';
import { ResponseData } from '../api/api.types';

/**
 * Paths we never try to silently refresh on a 401 — refreshing during login
 * or refresh itself would loop forever, and the logout endpoint failing with
 * 401 just means the server has already moved on (no need to fight it).
 */
const REFRESH_EXEMPT = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/token'];

function shouldAttemptRefresh(req: HttpRequest<unknown>): boolean {
  // Marker header set by the retried request — never refresh more than once
  // per original call to avoid recursive loops on a genuinely-bad token.
  if (req.headers.has('X-Skip-Auth-Retry')) return false;
  return !REFRESH_EXEMPT.some((p) => req.url.includes(p));
}

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const notificationService = inject(NotificationService);

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
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
                authService.logout();
                notificationService.error('Session expired. Please log in again.');
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

        // Refresh-exempt path (login/refresh/logout itself) hit a 401 — fall
        // through to the legacy "session expired" toast + logout flow.
        authService.logout();
        notificationService.error('Session expired. Please log in again.');
        return throwError(() => error);
      }

      if (error.status === 403) {
        notificationService.error('You do not have permission to perform this action.');
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
};
