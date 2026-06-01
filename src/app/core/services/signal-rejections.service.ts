import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  PagedData,
  ResponseData,
  SignalRejectionEventDto,
  SignalRejectionQuery,
} from '@core/api/api.types';

/**
 * Read-only client for the v8.47.172 signal-rejection log.  Two endpoints:
 *
 *  - `GET /signal-rejection` — paged list with full filter surface.
 *    Drives the per-instance "Rejections" tab and the (future) top-level
 *    rejections page.
 *  - `GET /trade-signal/{id}/rejections` — convenience wrapper that
 *    returns the entire history for one signal regardless of date,
 *    used by the "Account attempts" panel on the Trade Signal detail
 *    page.
 *
 * Returns raw `Observable<ResponseData<...>>` to match the existing
 * `EAAdminService` pattern — page components convert to signals via
 * `createPolledResource()` or subscribe directly for one-shot fetches.
 */
@Injectable({ providedIn: 'root' })
export class SignalRejectionsService {
  private readonly api = inject(ApiService);
  private readonly base = '/signal-rejection';

  /**
   * Paged list of rejection events.  Default time window on the engine
   * side is the last 24 hours when neither `createdFrom` nor `createdTo`
   * is supplied — keeps the first response bounded on high-volume
   * accounts.
   */
  list(
    query: SignalRejectionQuery = {},
  ): Observable<ResponseData<PagedData<SignalRejectionEventDto>>> {
    const params: string[] = [];
    if (query.currentPage) params.push(`currentPage=${query.currentPage}`);
    if (query.itemCountPerPage) params.push(`itemCountPerPage=${query.itemCountPerPage}`);
    if (query.eaInstanceId) params.push(`eaInstanceId=${encodeURIComponent(query.eaInstanceId)}`);
    if (query.tradingAccountId !== undefined)
      params.push(`tradingAccountId=${query.tradingAccountId}`);
    if (query.tradingAccountIds && query.tradingAccountIds.length > 0) {
      for (const id of query.tradingAccountIds) params.push(`tradingAccountIds=${id}`);
    }
    if (query.signalId !== undefined) params.push(`signalId=${query.signalId}`);
    if (query.stage) params.push(`stage=${encodeURIComponent(query.stage)}`);
    if (query.subStage) params.push(`subStage=${encodeURIComponent(query.subStage)}`);
    if (query.symbol) params.push(`symbol=${encodeURIComponent(query.symbol)}`);
    if (query.createdFrom) params.push(`createdFrom=${encodeURIComponent(query.createdFrom)}`);
    if (query.createdTo) params.push(`createdTo=${encodeURIComponent(query.createdTo)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.api.get<ResponseData<PagedData<SignalRejectionEventDto>>>(`${this.base}${qs}`);
  }

  /**
   * Per-signal account-attempts view.  Returns the full history (engine
   * default is "last year") for the supplied signal id; the admin UI's
   * Trade Signal detail page surfaces it as a compact one-row-per-
   * account table with stage badges.
   */
  forSignal(
    signalId: number,
    take = 100,
  ): Observable<ResponseData<PagedData<SignalRejectionEventDto>>> {
    return this.api.get<ResponseData<PagedData<SignalRejectionEventDto>>>(
      `/trade-signal/${signalId}/rejections?currentPage=1&itemCountPerPage=${take}`,
    );
  }
}
