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
  upsertInstrumentCatalogue,
} from './instrument-math';
import type {
  InstrumentAssetClass,
  InstrumentDto,
  SessionStateDto,
  TradingCalendarDto,
} from './instrument.types';

/** Where the catalogue came from: the engine's instrument master, or derived from its currency pairs (FX fallback). */
export type InstrumentSource = 'instruments' | 'currency-pairs' | null;

/**
 * Where one symbol stands: in the catalogue, still being resolved (the list is loading, or the symbol is being looked
 * up on its own), or known to be missing from the engine's instrument master.
 */
export type InstrumentLookupState = 'found' | 'resolving' | 'missing';

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

  private readonly settledState = signal(false);
  /** The first catalogue load has finished (with rows or without): a symbol not in it is now looked up alone. */
  readonly settled = this.settledState.asReadonly();
  /** Symbols `GET instruments/{symbol}` did not answer (cleared by a forced reload). */
  private readonly missedState = signal<ReadonlySet<string>>(new Set());
  /** Rows found by a single-symbol lookup; kept across list reloads (the list only carries charted symbols). */
  private readonly lookedUp = new Map<string, InstrumentDto>();
  private readonly lookups = new Set<string>();

  /**
   * Every instrument, in the engine's order (for the FX fallback: the currency-pair list's order, so the chart's symbol
   * search lists pairs exactly as it did).
   */
  readonly all = computed(() => [...instrumentCatalogue().values()]);

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
          upsertInstrumentCatalogue([...this.lookedUp.values()]);
          this.sourceState.set(source);
          this.loadedAt = Date.now();
        }
        if (force) {
          this.missedState.set(new Set());
          this.lookups.clear();
        }
        return this.all();
      } finally {
        this.inFlight = null;
        this.settledState.set(true);
      }
    })();
    return this.inFlight;
  }

  /** The instrument for `symbol` (catalogue row, else the symbol-only fallback). Starts a load on first use. */
  get(symbol: string | null | undefined): InstrumentDto {
    if (!this.sourceState() && !this.inFlight) void this.load();
    return resolveInstrument(symbol);
  }

  /**
   * Where `symbol` stands (signal reads: a `computed` follows the load and the lookup). A symbol the list does not
   * carry is looked up once on its own (`GET instruments/{symbol}`) after the list has settled — "resolving" until
   * that answers. Never throws; starts the list load on first use.
   */
  lookupState(symbol: string | null | undefined): InstrumentLookupState {
    const key = (symbol ?? '').trim().toUpperCase();
    if (!key) return 'missing';
    if (instrumentCatalogue().has(key)) return 'found';
    if (!this.settledState()) {
      if (!this.inFlight) void this.load();
      return 'resolving';
    }
    if (this.missedState().has(key)) return 'missing';
    this.lookUp(key);
    return 'resolving';
  }

  private lookUp(key: string): void {
    if (this.lookups.has(key)) return;
    this.lookups.add(key);
    // Every signal write happens after the request answers, so this is safe to start from a `computed`.
    void firstValueFrom(
      this.api.getEnvelope<unknown>(`/instruments/${encodeURIComponent(key)}`, { silent: true }),
    )
      .then((raw) => (raw ? normaliseInstrument(raw as Partial<InstrumentDto>) : null))
      .catch(() => null)
      .then((row) => {
        if (row && row.symbol === key) {
          this.lookedUp.set(key, row);
          upsertInstrumentCatalogue([row]);
        } else {
          this.missedState.update((m) => new Set(m).add(key));
        }
      });
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

  /**
   * Server-side catalogue search (multi-asset chart program UD09, contract C2): `GET instruments?search=&assetClass=&
   * skip=&take=` over the WHOLE master (not only symbols with candles — each row says `hasCandles`), with the matching
   * total from the envelope's `total`. Rows are not added to the catalogue. Rejects when the engine cannot be reached.
   */
  async search(
    query: string,
    opts: { assetClass?: InstrumentAssetClass | null; skip?: number; take?: number } = {},
  ): Promise<{ rows: InstrumentDto[]; total: number | null }> {
    const q = new URLSearchParams();
    q.set('search', query.trim());
    if (opts.assetClass) q.set('assetClass', opts.assetClass);
    q.set('skip', String(Math.max(0, opts.skip ?? 0)));
    q.set('take', String(Math.min(1000, Math.max(1, opts.take ?? 50))));
    const res = await firstValueFrom(
      this.api.get<{ status?: boolean; data?: unknown; total?: number; message?: string }>(
        `/instruments?${q.toString()}`,
        { silent: true },
      ),
    );
    if (res && res.status === false) throw new Error(res.message || 'The engine refused the search.');
    const list = Array.isArray(res?.data) ? res.data : [];
    const rows = list
      .map((r) => normaliseInstrument(r as Partial<InstrumentDto>))
      .filter((r): r is InstrumentDto => !!r);
    const total = typeof res?.total === 'number' && Number.isFinite(res.total) ? res.total : null;
    return { rows, total };
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
        // Only instruments with stored candles: the master holds ~4,600 active crypto tokens, and the
        // engine's default page is the first 200 by symbol ("00-USD" … "AGLD-USDT-PERP") — none with data,
        // and neither BTC-USD nor EURUSD. With hasCandles the catalogue is exactly what can be charted:
        // the EA's FX/CFD pairs plus every futures / crypto / stock symbol the candle builder has built.
        this.api.getEnvelope<unknown>('/instruments?hasCandles=true&take=1000', { silent: true }),
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
