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

/** One day of an account (engine `AccountPerformanceDayDto`). `dailyReturn` is a FRACTION. */
export interface AccountPerformanceDayDto {
  date: string;
  startEquity: number;
  endEquity: number;
  realizedPnl: number;
  dailyReturn: number;
  executionCosts: number;
  trades: number;
}

/** One account over the window (engine `AccountPerformanceSeriesDto`). Returns and win rate are FRACTIONS. */
export interface AccountPerformanceSeriesDto {
  tradingAccountId: number;
  accountName: string;
  accountLogin: string;
  brokerName: string;
  accountType: string;
  currency: string;
  isActive: boolean;
  isPaper: boolean;
  startEquity: number;
  endEquity: number;
  equityChange: number;
  compoundedReturn: number;
  realizedPnl: number;
  executionCosts: number;
  trades: number;
  winRate: number | null;
  sharpeRatio30d: number;
  sortinoRatio30d: number;
  calmarRatio30d: number;
  lastDate: string | null;
  /** Days left out because the row recorded no end-of-day equity (account not reporting — not a −100 % day). */
  unreportedDays?: number;
  daily: AccountPerformanceDayDto[];
}

/** A strategy's or a symbol's contribution summed across accounts and days. */
export interface AttributionSliceDto {
  key: string;
  strategyId: number | null;
  label: string;
  realizedPnl: number;
  executionCosts: number;
  pnl: number;
  trades: number;
  wins: number;
  accounts: number;
}

export interface StrategySnapshotCoverageDto {
  scoredActiveStrategies: number;
  activeSentinels: string[];
  activeSentinelIds: number[];
  lastSnapshotAtUtc: string | null;
}

/** `GET performance/accounts?days=` (engine `AccountPerformanceOverviewDto`). */
export interface AccountPerformanceOverviewDto {
  days: number;
  fromUtc: string;
  accounts: AccountPerformanceSeriesDto[];
  strategies: AttributionSliceDto[];
  symbols: AttributionSliceDto[];
  coverage: StrategySnapshotCoverageDto;
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

  /** Account performance from the daily attribution rows (account-scoped by the engine). */
  getAccounts(days = 30): Observable<ResponseData<AccountPerformanceOverviewDto>> {
    return this.api.get(`/performance/accounts?days=${days}`, { silent: true });
  }
}
