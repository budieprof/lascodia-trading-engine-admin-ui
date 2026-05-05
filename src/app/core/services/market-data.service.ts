import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  LivePriceDto,
  CandleDto,
  CandleCoverageDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class MarketDataService {
  private readonly api = inject(ApiService);

  getLivePrice(symbol: string): Observable<ResponseData<LivePriceDto>> {
    return this.api.get(`/market-data/live-price/${this.formatSymbol(symbol)}`);
  }

  getLatestCandle(symbol: string, timeframe: string): Observable<ResponseData<CandleDto>> {
    return this.api.get(
      `/market-data/candle/latest?symbol=${this.formatSymbol(symbol)}&timeframe=${timeframe}`,
    );
  }

  listCandles(params: PagerRequest): Observable<ResponseData<PagedData<CandleDto>>> {
    return this.api.post(`/market-data/candle/list`, params);
  }

  getCandleCoverage(
    symbol: string,
    timeframe: string,
    fromIso?: string,
    toIso?: string,
  ): Observable<ResponseData<CandleCoverageDto>> {
    const params = new URLSearchParams({
      symbol: this.formatSymbol(symbol),
      timeframe,
    });
    if (fromIso) params.set('from', fromIso);
    if (toIso) params.set('to', toIso);
    return this.api.get(`/market-data/candle/coverage?${params.toString()}`);
  }

  private formatSymbol(symbol: string): string {
    return symbol.replace(/\//g, '');
  }
}
