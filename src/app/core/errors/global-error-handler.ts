import { ErrorHandler, Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NotificationService } from '@core/notifications/notification.service';
import { reportError } from '@core/observability/sentry';
import { ApiError } from '@core/api/api.types';

/**
 * Catch-all ErrorHandler. Replaces Angular's default (which logs to console and
 * stops). This one:
 *   - Skips errors we already handled elsewhere (HttpErrorResponse is routed via
 *     the error interceptor; ApiError is thrown by the envelope helpers and is
 *     expected to be caught by the caller).
 *   - Shows an operator-visible toast for everything else so silent failures stop.
 *   - Still logs to console so the devtools stack is preserved.
 *   - Ships the exception to Sentry when a DSN is configured; a noop otherwise.
 */
@Injectable({ providedIn: 'root' })
export class GlobalErrorHandler implements ErrorHandler {
  private readonly notifications = inject(NotificationService);

  handleError(error: unknown): void {
    // Preserve the stack for devtools.

    console.error('[GlobalErrorHandler]', error);

    // Always ship to Sentry — even errors we mark "already handled" may be
    // worth investigating (e.g. repeated 500s from a specific endpoint).
    reportError(error);

    if (this.isAlreadyHandled(error)) return;

    const message = this.describe(error);
    this.notifications.error(`Unexpected error: ${message}`);
  }

  private isAlreadyHandled(error: unknown): boolean {
    if (error instanceof HttpErrorResponse) return true;
    if (error instanceof ApiError) return true;
    // Angular re-throws RxJS errors wrapped in its own Error; unwrap common shells.
    if (error instanceof Error && 'rejection' in error) {
      const inner = (error as unknown as { rejection: unknown }).rejection;
      if (inner instanceof HttpErrorResponse) return true;
      if (inner instanceof ApiError) return true;
    }
    return false;
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown error';
    }
  }
}
