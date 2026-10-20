import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { tap } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { AuthResponseCode } from './bff.types';

/** `data` of a `-202-approval` envelope (contract C3.3). */
export interface ApprovalPendingData {
  approvalId: number | string;
  expiresAtUtc: string;
}

/** The two-person answer, or null for any other response. */
export function approvalPending(res: HttpResponse<unknown>): ApprovalPendingData | null {
  if (res.status !== 202) return null;
  const body = res.body as { responseCode?: unknown; data?: Partial<ApprovalPendingData> } | null;
  if (!body || body.responseCode !== AuthResponseCode.ApprovalPending || !body.data) return null;
  const { approvalId, expiresAtUtc } = body.data;
  if (approvalId === undefined || approvalId === null || typeof expiresAtUtc !== 'string') return null;
  return { approvalId, expiresAtUtc };
}

/**
 * Contract C3.3: a two-person action is not done when the engine accepts it — it answers HTTP 202
 * `-202-approval` and waits for a second person. Say so plainly, whichever page made the request,
 * so nobody reads the accepted request as "done". The approval inbox lists it.
 */
export const approvalInterceptor: HttpInterceptorFn = (req, next) => {
  const notify = inject(NotificationService);
  return next(req).pipe(
    tap((event) => {
      if (!(event instanceof HttpResponse)) return;
      const pending = approvalPending(event);
      if (!pending) return;
      const until = new Date(pending.expiresAtUtc);
      const when = Number.isNaN(until.getTime()) ? '' : ` before ${until.toLocaleString()}`;
      notify.info(
        `Sent for approval (request #${pending.approvalId}). It runs once another authorised person approves it${when}.`,
      );
    }),
  );
};
