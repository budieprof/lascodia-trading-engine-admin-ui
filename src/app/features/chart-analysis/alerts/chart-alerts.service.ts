import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import type { AlertFiredPayload } from '@core/api/alerts.types';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { LiveQuote } from './chart-alert-rules';
import type { ChartAlertDto, ChartAlertFireDto, ChartAlertInput } from './chart-alerts.types';

/**
 * Chart alerts v2: the operator's alerts (`chart-alert`, owner-scoped on the engine), kept in one signal the alert
 * manager, the chart's alert lines and the pop-ups read; plus the live bid AND ask of every symbol on the price stream
 * (the chart page keeps only the bid), which the alert form needs for its side and its "already met" check.
 */
@Injectable({ providedIn: 'root' })
export class ChartAlertsService {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);

  private readonly _alerts = signal<ChartAlertDto[]>([]);
  private readonly _loaded = signal(false);
  private readonly _quotes = signal<Record<string, LiveQuote>>({});

  /** Every alert of the operator, newest first. */
  readonly alerts = this._alerts.asReadonly();
  /** True once the list has been read. */
  readonly loaded = this._loaded.asReadonly();
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly quotes = this._quotes.asReadonly();

  readonly activeCount = computed(() => this._alerts().filter((a) => a.status === 'Active').length);

  constructor() {
    this.realtime
      .on<{ symbol?: string; bid?: number; ask?: number; price?: number }>('priceUpdated')
      .subscribe((tick) => this.recordQuote(tick));
    // A fire changes the alert (a "once" alert is now Fired, counts move): re-read the list.
    this.realtime.on<AlertFiredPayload>('alertFired').subscribe((fired) => {
      if (fired?.source === 'price' || fired?.source === 'drawing') this.refresh();
    });
  }

  /** The latest quote of `symbol`, if the price stream has reported one. */
  quote(symbol: string): LiveQuote | null {
    return this._quotes()[symbol.toUpperCase()] ?? null;
  }

  /** The operator's alerts on `symbol`. */
  forSymbol(symbol: string): ChartAlertDto[] {
    const s = symbol.toUpperCase();
    return this._alerts().filter((a) => a.symbol.toUpperCase() === s);
  }

  /** (Re)reads every alert of the operator. */
  refresh(): void {
    this.loading.set(true);
    this.api.get<ResponseData<ChartAlertDto[]>>('/chart-alert', { silent: true }).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this._alerts.set(res.data);
          this._loaded.set(true);
          this.error.set(null);
        } else {
          this.error.set(res?.message || 'Could not load the alerts.');
        }
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load the alerts.');
      },
    });
  }

  /** Reads the list once, unless it is already loaded. */
  ensureLoaded(): void {
    if (!this._loaded() && !this.loading()) this.refresh();
  }

  get(id: number): Observable<ResponseData<ChartAlertDto>> {
    return this.api.get(`/chart-alert/${id}`, { silent: true });
  }

  create(input: ChartAlertInput): Observable<ResponseData<ChartAlertDto>> {
    return this.api
      .post<ResponseData<ChartAlertDto>>('/chart-alert', input, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  update(id: number, input: ChartAlertInput): Observable<ResponseData<ChartAlertDto>> {
    return this.api
      .put<ResponseData<ChartAlertDto>>(`/chart-alert/${id}`, input, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  pause(id: number): Observable<ResponseData<ChartAlertDto>> {
    return this.api
      .post<ResponseData<ChartAlertDto>>(`/chart-alert/${id}/pause`, {}, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  resume(id: number): Observable<ResponseData<ChartAlertDto>> {
    return this.api
      .post<ResponseData<ChartAlertDto>>(`/chart-alert/${id}/resume`, {}, { silent: true })
      .pipe(tap((res) => this.upsert(res)));
  }

  delete(id: number): Observable<ResponseData<boolean>> {
    return this.api.delete<ResponseData<boolean>>(`/chart-alert/${id}`, { silent: true }).pipe(
      tap((res) => {
        if (res?.status) this._alerts.update((list) => list.filter((a) => a.id !== id));
      }),
    );
  }

  /** One alert's fires, newest first, with each channel's outcome. */
  fires(id: number, limit = 20): Observable<ResponseData<ChartAlertFireDto[]>> {
    return this.api.get(`/chart-alert/${id}/fires?limit=${limit}`, { silent: true });
  }

  /** The fire log across the operator's alerts (optionally one symbol). */
  allFires(symbol: string | null, limit = 50): Observable<ResponseData<ChartAlertFireDto[]>> {
    const q = symbol ? `symbol=${encodeURIComponent(symbol)}&` : '';
    return this.api.get(`/chart-alert/fires?${q}limit=${limit}`, { silent: true });
  }

  private upsert(res: ResponseData<ChartAlertDto> | null | undefined): void {
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

  private recordQuote(tick: { symbol?: string; bid?: number; ask?: number; price?: number }): void {
    const symbol = tick?.symbol?.toUpperCase();
    const bid = tick?.bid ?? tick?.price;
    const ask = tick?.ask ?? bid;
    if (
      !symbol ||
      typeof bid !== 'number' ||
      typeof ask !== 'number' ||
      !Number.isFinite(bid) ||
      !Number.isFinite(ask)
    )
      return;
    this._quotes.update((map) => ({ ...map, [symbol]: { bid, ask, at: Date.now() } }));
  }
}
