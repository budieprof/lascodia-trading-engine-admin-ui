import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  BacktestRunDto,
  CreateBacktestRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class BacktestsService {
  private readonly api = inject(ApiService);

  create(data: CreateBacktestRequest): Observable<ResponseData<BacktestRunDto>> {
    return this.api.post(`/backtest`, data);
  }

  getById(id: number): Observable<ResponseData<BacktestRunDto>> {
    return this.api.get(`/backtest/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<BacktestRunDto>>> {
    return this.api.post(`/backtest/list`, params);
  }
}
