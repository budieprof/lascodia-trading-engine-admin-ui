import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

import type {
  EaCommandStatus,
  ManualTradePreview,
  ManualTradeRequest,
  ManualTradeResult,
  OrderEntryMovePreview,
  PositionChangePreview,
} from './manual-trading.types';

/**
 * The engine side of trading from the chart. The ticket only ever previews and submits a manual SIGNAL: the engine
 * judges it again on submission, and a live one then passes Tier 1 and Tier 2 like any signal.
 */
@Injectable({ providedIn: 'root' })
export class ManualTradingService {
  private readonly api = inject(ApiService);

  /** `POST trade-signal/preview` — the dry run. Writes nothing. */
  preview(request: ManualTradeRequest): Observable<ResponseData<ManualTradePreview>> {
    return this.api.post('/trade-signal/preview', request);
  }

  /** `POST trade-signal/manual` — submits the ticket (paper or live); refused with the reason unless it passes. */
  submit(request: ManualTradeRequest): Observable<ResponseData<ManualTradeResult>> {
    return this.api.post('/trade-signal/manual', request);
  }

  // ── Open positions and working orders (SP-I3): the existing commands, with a correlation id ──

  /** `POST position/{id}/change-preview` — the confirm dialog's numbers and checks. Writes nothing. */
  positionChangePreview(
    positionId: number,
    change: { stopLoss?: number | null; takeProfit?: number | null; closeLots?: number | null },
  ): Observable<ResponseData<PositionChangePreview>> {
    return this.api.post(`/position/${positionId}/change-preview`, change);
  }

  /** `POST position/{id}/modify-sl-tp` through the EA only; the engine applies the stop guard again. */
  modifyPosition(
    positionId: number,
    stopLoss: number | null,
    takeProfit: number | null,
    correlationId: string,
  ): Observable<ResponseData<string>> {
    return this.api.post(`/position/${positionId}/modify-sl-tp`, {
      stopLoss,
      takeProfit,
      correlationId,
      brokerRouteOnly: true,
    });
  }

  /** `POST position/{id}/close` (closeLots < open lots = a partial close) through the EA only. */
  closePosition(
    positionId: number,
    closePrice: number,
    closeLots: number,
    correlationId: string,
  ): Observable<ResponseData<string>> {
    return this.api.post(`/position/${positionId}/close`, {
      id: positionId,
      closePrice,
      closeLots,
      correlationId,
      brokerRouteOnly: true,
    });
  }

  /** `PUT order/{id}/modify` — a working order's stop / target. */
  modifyOrder(
    orderId: number,
    stopLoss: number | null,
    takeProfit: number | null,
    correlationId: string,
  ): Observable<ResponseData<string>> {
    return this.api.put(`/order/${orderId}/modify`, { stopLoss, takeProfit, correlationId });
  }

  /** `POST order/{id}/move-preview` — what moving a working order's entry would mean. Writes nothing. */
  orderEntryMovePreview(
    orderId: number,
    move: { price: number; stopLoss: number | null; takeProfit: number | null },
  ): Observable<ResponseData<OrderEntryMovePreview>> {
    return this.api.post(`/order/${orderId}/move-preview`, move);
  }

  /**
   * `POST order/{id}/move-entry` — moves a working order's entry (with the stop and target sent) at the broker through
   * the account's EA; the engine runs every check of the preview again and refuses (-11) unless all pass.
   */
  moveOrderEntry(
    orderId: number,
    move: { price: number; stopLoss: number | null; takeProfit: number | null },
    correlationId: string,
  ): Observable<ResponseData<string>> {
    return this.api.post(`/order/${orderId}/move-entry`, { ...move, correlationId });
  }

  /** `POST order/{id}/cancel?correlationId=`. */
  cancelOrder(orderId: number, correlationId: string): Observable<ResponseData<string>> {
    return this.api.post(
      `/order/${orderId}/cancel?correlationId=${encodeURIComponent(correlationId)}`,
    );
  }

  /** `GET position/command-status?correlationId=` — has the EA acknowledged it, and did it apply it. */
  commandStatus(correlationId: string): Observable<ResponseData<EaCommandStatus>> {
    return this.api.get(
      `/position/command-status?correlationId=${encodeURIComponent(correlationId)}`,
    );
  }
}
