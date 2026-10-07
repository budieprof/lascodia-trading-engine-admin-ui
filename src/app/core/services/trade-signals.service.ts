import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  TradeSignalDto,
  RejectTradeSignalRequest,
  CancelTradeSignalResult,
  CreateTradeSignalRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class TradeSignalsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<TradeSignalDto>> {
    return this.api.get(`/trade-signal/${id}`);
  }

  /**
   * Manually create a trade signal. Returns the new signal's id. Operator
   * policy on the engine; the returned signal lands in `Pending` status and
   * flows through the standard approve / reject / expire workflow.
   */
  create(data: CreateTradeSignalRequest): Observable<ResponseData<number>> {
    return this.api.post(`/trade-signal`, data);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<TradeSignalDto>>> {
    return this.api.post(`/trade-signal/list`, params);
  }

  approve(id: number): Observable<ResponseData<TradeSignalDto>> {
    return this.api.put(`/trade-signal/${id}/approve`);
  }

  /**
   * Operator override: flip a Rejected signal back to Pending so it re-flows
   * through Tier-1 risk checks. Original rejection reason is preserved on the
   * server behind an audit marker; Tier-1 may reject again with its own reason
   * (account state / margin / exposure / spread). Idempotent for already-
   * actionable statuses, refuses to flip terminal states (Executed / Expired).
   *
   * Used by the Spot Analysis modal's "Approve" button on viability-gate
   * rejections.
   */
  reapprove(id: number): Observable<ResponseData<string>> {
    return this.api.put(`/trade-signal/${id}/reapprove`);
  }

  reject(id: number, data: RejectTradeSignalRequest): Observable<ResponseData<TradeSignalDto>> {
    return this.api.put(`/trade-signal/${id}/reject`, data);
  }

  expire(id: number): Observable<ResponseData<TradeSignalDto>> {
    return this.api.put(`/trade-signal/${id}/expire`);
  }

  /**
   * Cancel a signal: it becomes Cancelled (terminal — never executed again) and the engine
   * immediately closes every open position and cancels every pending order it produced, on
   * every account. Callable from any status; calling it again re-sweeps anything the first call
   * could not reach (e.g. an offline EA). Labelled `admin-ui` in the engine's audit trail.
   */
  cancel(id: number, reason: string): Observable<ResponseData<CancelTradeSignalResult>> {
    return this.api.put(
      `/trade-signal/${id}/cancel`,
      { reason },
      { headers: { 'X-Lascodia-Actor': 'admin-ui' } },
    );
  }
}
