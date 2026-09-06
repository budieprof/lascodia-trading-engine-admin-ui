import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData } from '@core/api/api.types';

/**
 * Shape actually returned by `GET /performance/{id}` and `/performance/all`
 * (engine `PerformanceAttributionDto`). This is NOT a strategy performance
 * snapshot: there is no profit factor, health status or market regime here,
 * and the trade count lives in `totalTrades`, not `windowTrades`. The page
 * used to type the response as `StrategyPerformanceSnapshotDto`, which is why
 * every strategy rendered 0 trades and "Unknown" health.
 */
export interface PerformanceAttributionDto {
  strategyId: number;
  strategyName: string | null;
  totalTrades: number;
  winRate: number;
  totalPnL: number;
  averagePnLPerTrade: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  /** Mean net-R expectancy over the window; null when no position had a computable R. */
  netRExpectancy: number | null;
  rComputableTrades: number;
}

@Injectable({ providedIn: 'root' })
export class PerformanceService {
  private readonly api = inject(ApiService);

  getByStrategy(strategyId: number): Observable<ResponseData<PerformanceAttributionDto>> {
    return this.api.get(`/performance/${strategyId}`);
  }

  getAll(): Observable<ResponseData<PerformanceAttributionDto[]>> {
    return this.api.get(`/performance/all`);
  }
}
