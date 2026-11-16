import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, SetPaperTradingModeRequest } from '@core/api/api.types';

export interface PaperTradingStatus {
  isPaperMode: boolean;
  reason?: string | null;
  changedAt?: string | null;
}

/** Engine `PaperExecutionSummaryDto` (GET paper-trading/executions/summary). Money in account currency. */
export interface PaperExecutionSummaryDto {
  days: number;
  total: number;
  open: number;
  closed: number;
  expired: number;
  failed: number;
  synthetic: number;
  netPnl: number;
  wins: number;
  lastAtUtc: string | null;
  strategiesInPaperStage: number;
  strategies: PaperStrategySummaryDto[];
  recentExecutions: PaperExecutionRowDto[];
}

export interface PaperStrategySummaryDto {
  strategyId: number;
  name: string | null;
  status: string | null;
  lifecycleStage: string | null;
  symbol: string | null;
  /** The strategy was deleted or is unknown — no page to link to. */
  strategyDeleted?: boolean;
  executions: number;
  open: number;
  closed: number;
  expired: number;
  wins: number;
  netPnl: number;
  lastAtUtc: string | null;
}

export interface PaperExecutionRowDto {
  id: number;
  strategyId: number;
  symbol: string;
  direction: string;
  status: string;
  lotSize: number;
  simulatedFillPrice: number;
  simulatedFillAt: string;
  closedAt: string | null;
  exitReason: string | null;
  netPnl: number | null;
  isSynthetic: boolean;
  tradeSignalId: number | null;
}

/** Bare boolean (engine today) or an object → `PaperTradingStatus`; anything else → null. */
export function normalisePaperStatus(
  data: PaperTradingStatus | boolean | null | undefined,
): PaperTradingStatus | null {
  if (typeof data === 'boolean') return { isPaperMode: data };
  if (data && typeof data === 'object' && typeof data.isPaperMode === 'boolean') return data;
  return null;
}

@Injectable({ providedIn: 'root' })
export class PaperTradingService {
  private readonly api = inject(ApiService);

  private readonly _status = signal<PaperTradingStatus | null>(null);
  readonly status = this._status.asReadonly();
  readonly isPaperMode = computed(() => this._status()?.isPaperMode ?? false);

  setMode(data: SetPaperTradingModeRequest): Observable<ResponseData<void>> {
    return this.api.put<ResponseData<void>>(`/paper-trading/mode`, data).pipe(
      tap((res) => {
        // HTTP 200 with status:false is a refusal (and '-202-approval' parks it for a second
        // operator) — the mode has NOT changed, so the banner must not claim it has.
        if (res?.status !== true) return;
        this._status.update((s) => ({
          ...(s ?? { isPaperMode: false }),
          isPaperMode: data.isPaperMode,
          reason: data.reason,
        }));
      }),
    );
  }

  /**
   * The engine's GET paper-trading/status returns a BARE `ResponseData<bool>` (the mode flag
   * itself), not a status object. Normalise it so `isPaperMode()` reflects the engine; an
   * object payload (a future richer DTO) is accepted as-is.
   */
  getStatus(): Observable<ResponseData<PaperTradingStatus>> {
    return this.api
      .get<ResponseData<PaperTradingStatus | boolean>>(`/paper-trading/status`)
      .pipe(
        map((res) => ({ ...res, data: normalisePaperStatus(res?.data) }) as ResponseData<PaperTradingStatus>),
        tap((res) => {
          if (res.status !== false && res.data) this._status.set(res.data);
        }),
      );
  }

  /** The per-strategy paper track record over the last `days` days plus the newest executions. */
  getExecutionSummary(days = 90, recent = 25): Observable<ResponseData<PaperExecutionSummaryDto>> {
    return this.api.get(`/paper-trading/executions/summary?days=${days}&recent=${recent}`, {
      silent: true,
    });
  }

  backfill(strategyId: number): Observable<ResponseData<void>> {
    return this.api.post(`/paper-trading/backfill`, { strategyId });
  }
}
