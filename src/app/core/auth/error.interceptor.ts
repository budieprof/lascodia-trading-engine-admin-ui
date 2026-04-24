import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { NotificationService } from '../notifications/notification.service';
import { ResponseData } from '../api/api.types';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const notificationService = inject(NotificationService);

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
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
