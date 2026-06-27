import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '@core/api/api.service';
import {
  DEFAULT_SPREAD_REACTIVE_CONFIG,
  SpreadBaselineFloor,
  SpreadReactiveConfig,
  SpreadStateEntry,
  UpsertSpreadBaselineFloorRequest,
} from '@features/spread-reactive/spread-reactive.types';

/**
 * Data access for the spread-reactive subsystem — config CRUD plus the
 * live spread-state snapshot consumed by the monitor dashboard.
 * Engine endpoints under `/spread-reactive/*` (see SpreadReactiveController).
 */
@Injectable({ providedIn: 'root' })
export class SpreadReactiveService {
  private readonly api = inject(ApiService);

  getConfig(): Observable<SpreadReactiveConfig> {
    // Backfill missing slots so a config served by an older engine still
    // renders every form field — same pattern as SpotSweepService.
    return this.api
      .getEnvelope<SpreadReactiveConfig>('/spread-reactive/config')
      .pipe(map((c) => ({ ...DEFAULT_SPREAD_REACTIVE_CONFIG, ...c })));
  }

  saveConfig(config: SpreadReactiveConfig): Observable<SpreadReactiveConfig> {
    return this.api
      .putEnvelope<SpreadReactiveConfig>('/spread-reactive/config', config)
      .pipe(map((c) => ({ ...DEFAULT_SPREAD_REACTIVE_CONFIG, ...c })));
  }

  getState(): Observable<SpreadStateEntry[]> {
    return this.api.getEnvelope<SpreadStateEntry[]>('/spread-reactive/state');
  }

  /**
   * Persistent floor-baseline rows.  One per `(TradingAccount, Symbol)`.
   * Filters all serialise to query params — null/undefined → omitted.
   */
  getFloors(
    filters: {
      tradingAccountId?: number;
      symbol?: string;
      source?: 'AutoCapture' | 'OperatorOverride';
    } = {},
  ): Observable<SpreadBaselineFloor[]> {
    const qs = new URLSearchParams();
    if (filters.tradingAccountId != null)
      qs.set('tradingAccountId', String(filters.tradingAccountId));
    if (filters.symbol) qs.set('symbol', filters.symbol);
    if (filters.source) qs.set('source', filters.source);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.api.getEnvelope<SpreadBaselineFloor[]>(`/spread-reactive/floors${suffix}`);
  }

  /** Operator override / first-time set of a floor for one pair. */
  upsertFloor(body: UpsertSpreadBaselineFloorRequest): Observable<SpreadBaselineFloor> {
    return this.api.putEnvelope<SpreadBaselineFloor>('/spread-reactive/floors', body);
  }

  /** Clear the floor for one pair — pair returns to stand-down. */
  resetFloor(tradingAccountId: number, symbol: string): Observable<string> {
    const qs = new URLSearchParams({ tradingAccountId: String(tradingAccountId), symbol });
    return this.api.deleteEnvelope<string>(`/spread-reactive/floors?${qs.toString()}`);
  }

  /**
   * Manually trigger the pre-emptive widening pass.  Same code path as the
   * daily schedule — returns the number of positions bumped.
   */
  firePreEmptiveNow(triggerLabel?: string): Observable<number> {
    return this.api.postEnvelope<number>('/spread-reactive/pre-emption/fire', {
      triggerLabel: triggerLabel ?? 'manual',
    });
  }
}
