import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  OrderDto,
  UpdateOrderRequest,
  ModifyOrderRequest,
  BatchCancelOrdersRequest,
  BatchCancelOrdersResult,
} from '@core/api/api.types';

/**
 * Execution-latency timestamps for an order, from `GET /order/{id}/timing`.
 * Any field is null when the Order → TradeSignal link is missing.
 */
export interface OrderTimingDto {
  orderId: number;
  signalTriggeredAt: string | null;
  signalGeneratedAt: string | null;
  orderPlacedAt: string | null;
  orderFilledAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<OrderDto>> {
    return this.api.get(`/order/${id}`);
  }

  /**
   * Execution-latency timestamps for an order (signal fired vs. order placed),
   * resolved server-side via Order → TradeSignal.
   */
  getTiming(id: number): Observable<ResponseData<OrderTimingDto>> {
    return this.api.get(`/order/${id}/timing`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<OrderDto>>> {
    return this.api.post(`/order/list`, params);
  }

  // SP-I4: no `create` / `submit` here any more. An order typed in is never placed (no EA command places an order;
  // the EA executes signals) — a manual trade is a manual signal: the chart's order ticket (trade-signal/manual) or the
  // Signals page's "New manual signal".

  update(id: number, data: UpdateOrderRequest): Observable<ResponseData<OrderDto>> {
    return this.api.put(`/order/${id}`, data);
  }

  cancel(id: number): Observable<ResponseData<OrderDto>> {
    return this.api.post(`/order/${id}/cancel`);
  }

  cancelBatch(
    request: BatchCancelOrdersRequest,
  ): Observable<ResponseData<BatchCancelOrdersResult>> {
    return this.api.post(`/order/cancel/batch`, request);
  }

  modify(id: number, data: ModifyOrderRequest): Observable<ResponseData<OrderDto>> {
    return this.api.put(`/order/${id}/modify`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/order/${id}`);
  }
}
