import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  MarketRegimeSnapshotDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class MarketRegimeService {
  private readonly api = inject(ApiService);

  getLatest(symbol: string, timeframe: string): Observable<ResponseData<MarketRegimeSnapshotDto>> {
    return this.api.get(`/market-regime/latest?symbol=${symbol}&timeframe=${timeframe}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<MarketRegimeSnapshotDto>>> {
    return this.api.post(`/market-regime/list`, params);
  }
}
