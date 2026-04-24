import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  CurrencyPairDto,
  CreateCurrencyPairRequest,
  UpdateCurrencyPairRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class CurrencyPairsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<CurrencyPairDto>> {
    return this.api.get(`/currency-pair/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<CurrencyPairDto>>> {
    return this.api.post(`/currency-pair/list`, params);
  }

  create(data: CreateCurrencyPairRequest): Observable<ResponseData<CurrencyPairDto>> {
    return this.api.post(`/currency-pair`, data);
  }

  update(id: number, data: UpdateCurrencyPairRequest): Observable<ResponseData<CurrencyPairDto>> {
    return this.api.put(`/currency-pair/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/currency-pair/${id}`);
  }
}
