import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  TradingAccountDto,
  CreateTradingAccountRequest,
  UpdateTradingAccountRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class TradingAccountsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<TradingAccountDto>> {
    return this.api.get(`/trading-account/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<TradingAccountDto>>> {
    return this.api.post(`/trading-account/list`, params);
  }

  create(data: CreateTradingAccountRequest): Observable<ResponseData<TradingAccountDto>> {
    return this.api.post(`/trading-account`, data);
  }

  update(id: number, data: UpdateTradingAccountRequest): Observable<ResponseData<TradingAccountDto>> {
    return this.api.put(`/trading-account/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/trading-account/${id}`);
  }

  activate(id: number): Observable<ResponseData<TradingAccountDto>> {
    return this.api.put(`/trading-account/${id}/activate`);
  }

  sync(id: number): Observable<ResponseData<TradingAccountDto>> {
    return this.api.put(`/trading-account/${id}/sync`);
  }

  getActive(brokerId: number): Observable<ResponseData<TradingAccountDto[]>> {
    return this.api.get(`/trading-account/active/${brokerId}`);
  }
}
