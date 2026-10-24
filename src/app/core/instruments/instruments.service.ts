import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { CurrencyPairDto, PagedData, ResponseData } from '@core/api/api.types';
import {
  instrumentCatalogue,
  instrumentFromCurrencyPair,
  normaliseInstrument,
  resolveInstrument,
  setInstrumentCatalogue,
} from './instrument-math';
import type {
  InstrumentAssetClass,
  InstrumentDto,
  SessionStateDto,
  TradingCalendarDto,
} from './instrument.types';

/** Where the catalogue came from: the engine's instrument master, or derived from its currency pairs (FX fallback). */
export type InstrumentSource = 'instruments' | 'currency-pairs' | null;

/** Re-read at most this often. */
const MAX_AGE_MS = 5 * 60_000;

/**
 * The instrument catalogue (multi-asset WS7 7.1). Loads `GET instruments` once (silently); when the engine has no such
 * endpoint yet (404, an older build) or it answers nothing, derives FX instruments from `POST currency-pair/list` —
 * so a console in front of today's engine shows exactly what it showed before. The rows land in the module-level
 * catalogue (`instrument-math.ts`) every pure helper resolves through.
 *
 * Calendars (`GET calendars/{code}`) are cached per code; a calendar the engine does not serve is null and callers keep
 * their own session (the chart keeps the session `scripting/chart-bars` reports).
 */
@Injectable({ providedIn: 'root' })
export class InstrumentsService {
  private readonly api = inject(ApiService);
  private readonly sourceState = signal<InstrumentSource>(null);
  private loadedAt = 0;
  private inFlight: Promise<readonly InstrumentDto[]> | null = null;
  private readonly calendars = new Map<string, Promise<TradingCalendarDto | null>>();
  private readonly calendarState = signal<ReadonlyMap<string, TradingCalendarDto>>(new Map());

  /** Which endpoint the catalogue came from (null until loaded). */
  readonly source = this.sourceState.asReadonly();

  /** Every instrument, sorted by symbol. */
  readonly all = computed(() =>
    [...instrumentCatalogue().values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
  );

  /** The asset classes the catalogue holds, in a stable order. */
  readonly assetClasses = computed<InstrumentAssetClass[]>(() => {
    const order: InstrumentAssetClass[] = [
      'Fx',
      'Future',
      'Crypto',
      'Equity',
      'Etf',
      'Index',
      'Commodity',
    ];
    const present = new Set(this.all().map((i) => i.assetClass));
    return order.filter((c) => present.has(c));
  });

  /** Loads (or re-uses a fresh answer). Never throws. */
  load(force = false): Promise<readonly InstrumentDto[]> {
    if (!force && this.sourceState() && Date.now() - this.loadedAt < MAX_AGE_MS)
      return Promise.resolve(this.all());
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        let rows = await this.fromInstruments();
        let source: InstrumentSource = 'instruments';
        if (!rows.length) {
          rows = await this.fromCurrencyPairs();
          source = 'currency-pairs';
        }
        if (rows.length) {
          setInstrumentCatalogue(rows);
          this.sourceState.set(source);
          this.loadedAt = Date.now();
        }
        return this.all();
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** The instrument for `symbol` (catalogue row, else the symbol-only fallback). Starts a load on first use. */
  get(symbol: string | null | undefined): InstrumentDto {
    if (!this.sourceState() && !this.inFlight) void this.load();
    return resolveInstrument(symbol);
  }

  /** The calendar for `code` (cached; null when the engine does not serve it). */
  calendar(code: string | null | undefined): Promise<TradingCalendarDto | null> {
    const key = (code ?? '').trim();
    if (!key) return Promise.resolve(null);
    let pending = this.calendars.get(key);
    if (!pending) {
      pending = firstValueFrom(
        this.api.getEnvelope<TradingCalendarDto>(`/calendars/${encodeURIComponent(key)}`, {
          silent: true,
        }),
      )
        .then((cal) => {
          if (!cal || !Array.isArray(cal.sessions)) return null;
          this.calendarState.update((m) => new Map(m).set(key, cal));
          return cal;
        })
        .catch(() => {
          // Not remembered: a later ask tries again (the engine may have been deployed meanwhile).
          this.calendars.delete(key);
          return null;
        });
      this.calendars.set(key, pending);
    }
    return pending;
  }

  /** A calendar already loaded (signal read), else null. */
  calendarOf(code: string | null | undefined): TradingCalendarDto | null {
    return this.calendarState().get((code ?? '').trim()) ?? null;
  }

  /** `GET instruments/{symbol}/session-state?at=` — null when not served. */
  async sessionState(symbol: string, at?: Date): Promise<SessionStateDto | null> {
    const q = at ? `?at=${encodeURIComponent(at.toISOString())}` : '';
    try {
      return await firstValueFrom(
        this.api.getEnvelope<SessionStateDto>(
          `/instruments/${encodeURIComponent(symbol.toUpperCase())}/session-state${q}`,
          { silent: true },
        ),
      );
    } catch {
      return null;
    }
  }

  private async fromInstruments(): Promise<InstrumentDto[]> {
    try {
      const data = await firstValueFrom(
        this.api.getEnvelope<unknown>('/instruments', { silent: true }),
      );
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? (data as { data: unknown[] }).data
          : [];
      return list
        .map((r) => normaliseInstrument(r as Partial<InstrumentDto>))
        .filter((r): r is InstrumentDto => !!r);
    } catch {
      return [];
    }
  }

  private async fromCurrencyPairs(): Promise<InstrumentDto[]> {
    try {
      const res = await firstValueFrom(
        this.api.post<ResponseData<PagedData<CurrencyPairDto>>>(
          '/currency-pair/list',
          { currentPage: 1, itemCountPerPage: 500, filter: {} },
          { silent: true },
        ),
      );
      if (!res?.status || !res.data) return [];
      return (res.data.data ?? []).filter((p) => p.symbol).map(instrumentFromCurrencyPair);
    } catch {
      return [];
    }
  }
}
