import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  PositionDto,
  PositionLifecycleEventDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class PositionsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<PositionDto>> {
    return this.api.get(`/position/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<PositionDto>>> {
    return this.api.post(`/position/list`, params);
  }

  /**
   * Manually close (or partially close) an open position. The engine
   * updates the position record AND queues an EA command for MT5 to
   * flatten the trade. `closeLots` is optional — when omitted the engine
   * defaults to closing all open lots.
   */
  close(id: number, closePrice: number, closeLots?: number): Observable<ResponseData<string>> {
    return this.api.post(`/position/${id}/close`, {
      id,
      closePrice,
      closeLots: closeLots ?? null,
    });
  }

  /**
   * Modify SL and/or TP on an open position. At least one of `stopLoss`,
   * `takeProfit` must be a number; pass `null` to leave a level unchanged.
   * The engine updates the position row and queues a ModifySLTP EACommand
   * so MT5 applies the new levels broker-side. Operator entry point: drag
   * the SL/TP horizontal line on the trading chart.
   */
  modifySlTp(
    id: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ): Observable<ResponseData<string>> {
    return this.api.post(`/position/${id}/modify-sl-tp`, {
      stopLoss,
      takeProfit,
    });
  }

  /**
   * GET /position/{id}/lifecycle — chronological lifecycle / delta timeline.
   * Returns an empty list until the writer-side wiring lands across the
   * position-management command handlers (see engine commit 3fb257d).
   */
  getLifecycle(id: number, limit?: number): Observable<ResponseData<PositionLifecycleEventDto[]>> {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return this.api.get(`/position/${id}/lifecycle${qs}`);
  }

  /**
   * POST /position/lifecycle/list — fleet-wide position-delta feed
   * (PRD-V2 FR-5.8). The filter shape on the engine accepts substring
   * matches on eventType / source via ILIKE, so a `source: 'PositionWorker'`
   * filter catches all the colon-suffixed close-reason variants
   * ("PositionWorker:StopLoss", "PositionWorker:TakeProfit", etc.).
   */
  listLifecycleEvents(
    params: PagerRequest & {
      filter?: {
        positionId?: number | null;
        eventType?: string | null;
        source?: string | null;
        from?: string | null;
        to?: string | null;
      };
    },
  ): Observable<ResponseData<PagedData<PositionLifecycleEventDto>>> {
    return this.api.post(`/position/lifecycle/list`, params);
  }
}
