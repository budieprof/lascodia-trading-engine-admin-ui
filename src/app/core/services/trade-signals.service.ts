import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  TradeSignalDto,
  RejectTradeSignalRequest,
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

  reject(id: number, data: RejectTradeSignalRequest): Observable<ResponseData<TradeSignalDto>> {
    return this.api.put(`/trade-signal/${id}/reject`, data);
  }

  expire(id: number): Observable<ResponseData<TradeSignalDto>> {
    return this.api.put(`/trade-signal/${id}/expire`);
  }
}
