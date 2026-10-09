import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import type { AlertFiredPayload } from '@core/api/alerts.types';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  ChartScriptAlertDto,
  ChartScriptAlertFireDto,
  ChartScriptAlertInput,
} from './chart-script-alerts.types';

/**
 * Alerts on chart scripts (SS-I1, `scripting/alerts`, owner-scoped on the engine): the operator's alerts in one signal
 * the alert manager's "Script alerts" tab and the chart's "Create alert on <script>" read and write.
 */
@Injectable({ providedIn: 'root' })
export class ChartScriptAlertsService {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);

  private readonly _alerts = signal<ChartScriptAlertDto[]>([]);
  private readonly _loaded = signal(false);

  /** Every alert of the operator, newest first. */
  readonly alerts = this._alerts.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // A fire moves its counts (and a "once" alert pauses itself): re-read the list.
    this.realtime.on<AlertFiredPayload>('alertFired').subscribe((fired) => {
      if (fired?.source === 'chart-script' && this._loaded()) this.refresh();
    });
  }

  /** The alerts watching `symbol` (watchlist alerts included: their symbols change). */
  forSymbol(symbol: string): ChartScriptAlertDto[] {
    const s = symbol.toUpperCase();
    return this._alerts().filter((a) => a.watchlistId !== null || a.symbols.some((x) => x.toUpperCase() === s));
  }

  refresh(): void {
    this.loading.set(true);
    this.api.get<ResponseData<ChartScriptAlertDto[]>>('/scripting/alerts', { silent: true }).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this._alerts.set(res.data);
          this._loaded.set(true);
          this.error.set(null);
        } else {
          this.error.set(res?.message || 'Could not load the script alerts.');
        }
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load the script alerts.');
      },
    });
  }

  ensureLoaded(): void {
    if (!this._loaded() && !this.loading()) this.refresh();
  }

  get(id: number): Observable<ResponseData<ChartScriptAlertDto>> {
    return this.api.get(`/scripting/alerts/${id}`, { silent: true });
  }

  create(input: ChartScriptAlertInput): Observable<ResponseData<ChartScriptAlertDto>> {
    return this.api
      .post<ResponseData<ChartScriptAlertDto>>('/scripting/alerts', input, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  update(id: number, input: ChartScriptAlertInput): Observable<ResponseData<ChartScriptAlertDto>> {
    return this.api
      .put<ResponseData<ChartScriptAlertDto>>(`/scripting/alerts/${id}`, input, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  pause(id: number): Observable<ResponseData<ChartScriptAlertDto>> {
    return this.api
      .post<ResponseData<ChartScriptAlertDto>>(`/scripting/alerts/${id}/pause`, {}, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  resume(id: number): Observable<ResponseData<ChartScriptAlertDto>> {
    return this.api
      .post<ResponseData<ChartScriptAlertDto>>(`/scripting/alerts/${id}/resume`, {}, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  delete(id: number): Observable<ResponseData<boolean>> {
    return this.api.delete<ResponseData<boolean>>(`/scripting/alerts/${id}`, { silent: true }).pipe(
      tap((res) => {
        if (res?.status) this._alerts.update((list) => list.filter((a) => a.id !== id));
      }),
    );
  }

  /** One alert's fires, newest first, with each channel's outcome. */
  fires(id: number, limit = 20): Observable<ResponseData<ChartScriptAlertFireDto[]>> {
    return this.api.get(`/scripting/alerts/${id}/fires?limit=${limit}`, { silent: true });
  }

  /** The fire log across the operator's script alerts. */
  allFires(limit = 50): Observable<ResponseData<ChartScriptAlertFireDto[]>> {
    return this.api.get(`/scripting/alerts/fires?limit=${limit}`, { silent: true });
  }

  private upsert(res: ResponseData<ChartScriptAlertDto> | null | undefined): void {
    const row = res?.status ? res.data : null;
    if (!row) return;
    this._alerts.update((list) => {
      const i = list.findIndex((a) => a.id === row.id);
      if (i < 0) return [row, ...list];
      const next = [...list];
      next[i] = row;
      return next;
    });
  }
}
