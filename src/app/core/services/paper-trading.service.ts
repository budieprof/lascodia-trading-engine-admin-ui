import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, SetPaperTradingModeRequest } from '@core/api/api.types';

export interface PaperTradingStatus {
  isPaperMode: boolean;
  reason?: string | null;
  changedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class PaperTradingService {
  private readonly api = inject(ApiService);

  private readonly _status = signal<PaperTradingStatus | null>(null);
  readonly status = this._status.asReadonly();
  readonly isPaperMode = computed(() => this._status()?.isPaperMode ?? false);

  setMode(data: SetPaperTradingModeRequest): Observable<ResponseData<void>> {
    return this.api
      .put<ResponseData<void>>(`/paper-trading/mode`, data)
      .pipe(
        tap(() =>
          this._status.update((s) => ({
            ...(s ?? { isPaperMode: false }),
            isPaperMode: data.isPaperMode,
            reason: data.reason,
          })),
        ),
      );
  }

  getStatus(): Observable<ResponseData<PaperTradingStatus>> {
    return this.api.get<ResponseData<PaperTradingStatus>>(`/paper-trading/status`).pipe(
      tap((res) => {
        if (res.data) this._status.set(res.data);
      }),
    );
  }

  backfill(strategyId: number): Observable<ResponseData<void>> {
    return this.api.post(`/paper-trading/backfill`, { strategyId });
  }
}
