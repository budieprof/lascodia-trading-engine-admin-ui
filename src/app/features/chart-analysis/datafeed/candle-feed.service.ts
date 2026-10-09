import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { ScriptingService } from '@core/services/scripting.service';
import type { CandleDto } from '@core/api/api.types';
import type { ChartBarDto, ChartBarsResult } from '@core/api/scripting.types';
import { aggregateCandles } from './aggregate';
import {
  isSessionResolution,
  resolutionSource,
  sourceBarsNeeded,
  type TvResolution,
} from './resolution';
import { MAX_CHART_BARS, asBar, tailCount } from './session-bars';
import type { SessionSpec } from './session-calendar';

/** One bar in TradingView's shape. `time` is the bar's open, in ms. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * The exclusive close of the bar's period, in ms — set on the session grid (2h … 1M), where the
   * engine lays periods out and says where each one ends. Absent on the stored grid (1m … 1h), whose
   * bars are fixed widths on the UTC epoch grid.
   */
  closeTime?: number;
}

/** A session-grid bar as `scripting/chart-bars` sent it: with its close, and whether it is the period still forming. */
export interface SessionBar extends Bar {
  forming: boolean;
}

export interface BarsResult {
  bars: Bar[];
  /** True when the range holds no data AND none is expected further back. */
  noData: boolean;
}

/** Hard ceiling on rows per request, so a wide window can't ask for millions. */
const MAX_PAGE = 5000;
/**
 * Series the bar cache keeps (CC-24): the least recently used goes first. A session of switching
 * symbols and timeframes — the watchlist, the technicals, compare studies — used to keep every
 * series it ever loaded for the page's life.
 */
export const MAX_CACHED_SERIES = 24;
/**
 * A window ending this close to now is a live one: on the session grid it is asked for with no `to`,
 * so the engine adds the period still forming.
 */
const LIVE_EDGE_MS = 5_000;

/**
 * Fetches candles for the chart, in TradingView's terms, from one of two engine sources
 * (`resolution.ts`): stored candles for 1m … 1h, the session grid for 2h, 4h, 1D, 1W and 1M.
 *
 * Two engine behaviours drive the stored path, both verified against
 * `GetCandlesQueryHandler` on 2026-09-19:
 *
 * 1. **The handler orders by `Timestamp` DESCENDING and then pages.** So page 1
 *    with a `to` cutoff and `itemCountPerPage: n` is exactly "the n most recent
 *    bars at or before `to`" — which is precisely `countBack` semantics. We ask
 *    that way and reverse, rather than paging forward from `from` and hoping the
 *    count lands right.
 *
 * 2. **The filter must be NESTED under `filter`.** Sent flat, the criteria are
 *    unknown members that get discarded in silence and the handler answers with
 *    page 1 of the entire unfiltered table — HTTP 200, well-formed rows, wrong
 *    data. The engine now rejects flat filter fields with responseCode `-12`,
 *    but the nested shape is the contract; don't rely on the guard.
 *
 * The session path (`scripting/chart-bars`) pages the same way — "the last `count` bars whose open
 * is before `to`" — and answers ascending, each bar with its own close. A window that ends now is
 * asked for with no `to`, so the period still forming comes too, built by the engine.
 */
@Injectable({ providedIn: 'root' })
export class CandleFeedService {
  private readonly marketData = inject(MarketDataService);
  private readonly scripting = inject(ScriptingService);

  /**
   * Cache of ascending bars per `symbol|resolution`.
   *
   * Scroll-back re-asks for windows it has already seen, so without this the
   * chart refetches the same thousands of rows every time the operator drags
   * left. Keyed on the TARGET resolution, i.e. aggregated bars are cached in
   * their aggregated form — aggregating a long M15 range into `30` on every
   * pan is the other half of the same cost.
   */
  private readonly cache = new Map<string, Bar[]>();

  private key(symbol: string, resolution: TvResolution): string {
    return `${symbol}|${resolution}`;
  }

  /**
   * Each symbol's session as the engine reported it with its chart bars (`session`, `timeZone`):
   * the trading days its day-based studies count in (`TradingCalendar`). A signal, so a chart that
   * learns it after drawing recomputes them. A symbol whose session never came stays out, and
   * counts UTC days.
   */
  private readonly sessions = signal<ReadonlyMap<string, SessionSpec>>(new Map());
  /** {@link learnSession} requests in flight, by symbol. */
  private readonly learning = new Map<string, Promise<SessionSpec | null>>();

  /** `symbol`'s session, once the engine has reported it; null until then (or if it has none). */
  sessionOf(symbol: string): SessionSpec | null {
    return this.sessions().get(symbol.toUpperCase()) ?? null;
  }

  /**
   * Make sure `symbol`'s session is known. Any session-grid load reports it (`fetchSession`); a chart
   * on the stored grid (1m … 1h) loads none, so it asks once — the smallest `scripting/chart-bars`
   * request, one daily bar, nothing forming — and remembers the answer for the page's life. A failure
   * is not remembered: the next switch to the symbol asks again.
   */
  learnSession(symbol: string): Promise<SessionSpec | null> {
    const key = symbol.toUpperCase();
    const known = this.sessionOf(key);
    if (known) return Promise.resolve(known);
    let pending = this.learning.get(key);
    if (!pending) {
      pending = firstValueFrom(
        this.scripting.chartBars({ symbol: key, timeframe: '1D', count: 1, includeForming: false }),
      )
        .then((res) => this.recordSession(key, res))
        .catch(() => null)
        .finally(() => this.learning.delete(key));
      this.learning.set(key, pending);
    }
    return pending;
  }

  /** Keep the session a `scripting/chart-bars` answer reports for `symbol`. */
  private recordSession(
    symbol: string,
    res: Pick<ChartBarsResult, 'session' | 'timeZone'>,
  ): SessionSpec | null {
    const session = typeof res?.session === 'string' ? res.session.trim() : '';
    if (!session) return null;
    const key = symbol.toUpperCase();
    const zone = typeof res.timeZone === 'string' ? res.timeZone.trim() : '';
    const timeZone = zone || 'Etc/UTC';
    const held = this.sessions().get(key);
    if (held?.session === session && held.timeZone === timeZone) return held;
    const spec: SessionSpec = { session, timeZone };
    this.sessions.update((m) => new Map(m).set(key, spec));
    return spec;
  }

  /** Drop cached bars. Call when the symbol's data is known to have changed. */
  invalidate(symbol?: string, resolution?: TvResolution): void {
    if (!symbol) {
      this.cache.clear();
      return;
    }
    if (resolution) {
      this.cache.delete(this.key(symbol, resolution));
      return;
    }
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(`${symbol}|`)) this.cache.delete(k);
    }
  }

  /**
   * Every stored M1 bar from `sinceMs` to now, ascending, uncached.
   *
   * <p>The raw material for the bar that is still forming. Returns null — not an empty list — when
   * the window is too wide to cover in one request, because a fold over a truncated window builds a
   * bar whose open is simply wrong, which is worse than keeping the tick-built one.</p>
   */
  async minuteBarsSince(symbol: string, sinceMs: number): Promise<Bar[] | null> {
    const now = Date.now();
    const needed = Math.ceil((now - sinceMs) / 60_000) + 2;
    if (needed <= 0) return [];
    if (needed > MAX_PAGE) return null;
    // Headroom for duplicate rows: the handler pages by ROW, newest first, so if a minute is
    // stored twice the page stops short of `sinceMs` and the oldest bucket folds from a partial
    // set of minutes — a wrong open, which is the bug this exists to fix.
    const rows = Math.min(MAX_PAGE, needed * 2);

    const res = await firstValueFrom(
      this.marketData.listCandles({
        currentPage: 1,
        itemCountPerPage: rows,
        filter: { symbol, timeframe: 'M1', to: new Date(now).toISOString() },
      }),
    ).catch(() => null);
    if (!res?.status || !res.data) return null;

    const all = (res.data.data ?? []).map(toBar).filter((b) => Number.isFinite(b.time));
    // A full page whose oldest row is still after `sinceMs` did not reach back far enough.
    if (all.length >= rows && all.every((b) => b.time > sinceMs)) return null;

    return all.filter((b) => b.time >= sinceMs).sort((a, b) => a.time - b.time);
  }

  /**
   * Bars at or before `toMs`, at least `countBack` of them where they exist.
   *
   * `countBack` rather than `fromMs` is the authority: from v29 the library
   * asks for a bar count ending at `to` and a short answer leaves a visibly
   * truncated chart. `fromMs` is used only to trim the result.
   *
   * Rejects when the engine refuses or cannot be reached, on both grids — "no bars" would read as
   * "the engine has no data" (CC-14).
   */
  async getBars(
    symbol: string,
    resolution: TvResolution,
    fromMs: number,
    toMs: number,
    countBack: number,
  ): Promise<BarsResult> {
    if (isSessionResolution(resolution)) {
      return this.getSessionBars(symbol, resolution, fromMs, toMs, countBack);
    }
    const src = resolutionSource(resolution);
    if (!src || src.kind !== 'stored') return { bars: [], noData: true };

    const cached = this.cached(symbol, resolution);
    const servedFromCache = this.sliceCache(cached, fromMs, toMs, countBack);
    if (servedFromCache) return { bars: servedFromCache, noData: false };

    // Over-fetch by the aggregation factor: 10 thirty-minute bars need 20 M15
    // ones, and asking for 10 would render a chart half as long.
    const rows = Math.min(MAX_PAGE, Math.max(1, sourceBarsNeeded(resolution, countBack)));

    // A refusal or an unreachable engine REJECTS, as the session grid does (CC-14): read as "no
    // data", a network failure on 1m … 1h told the operator "No 1h candles stored for EURUSD".
    const res = await firstValueFrom(
      this.marketData.listCandles({
        currentPage: 1,
        itemCountPerPage: rows,
        filter: {
          symbol,
          timeframe: src.timeframe,
          to: new Date(toMs).toISOString(),
        },
      }),
    ).catch((e: unknown) => {
      throw e instanceof Error && e.message ? e : new Error('the engine could not be reached');
    });

    if (!res?.status || !res.data)
      throw new Error(res?.message || 'the engine refused the candle request');

    const bars = normaliseRows(res.data.data ?? [], resolution);
    if (bars.length === 0) return { bars: [], noData: true };

    this.mergeIntoCache(symbol, resolution, bars);

    const windowed = bars.filter((b) => b.time >= fromMs && b.time <= toMs);
    // An empty window with bars present means the request reached past the
    // start of history — tell the library so it stops walking backwards.
    return { bars: windowed, noData: windowed.length === 0 };
  }

  /**
   * `getBars` on the session grid: the same cache and the same "the last `countBack` bars at or
   * before `toMs`", from `scripting/chart-bars`. A window ending now asks with no `to` — the engine
   * then adds the period still forming; an earlier one asks for the bars whose open is before
   * `toMs + 1` (the endpoint's `to` is exclusive, `toMs` here is not).
   */
  private async getSessionBars(
    symbol: string,
    resolution: TvResolution,
    fromMs: number,
    toMs: number,
    countBack: number,
  ): Promise<BarsResult> {
    const live = toMs >= Date.now() - LIVE_EDGE_MS;
    if (!live) {
      const cached = this.cached(symbol, resolution);
      const servedFromCache = this.sliceCache(cached, fromMs, toMs, countBack);
      if (servedFromCache) return { bars: servedFromCache, noData: false };
    }

    const fetched = await this.fetchSession(
      symbol,
      resolution,
      live ? null : toMs + 1,
      Math.min(MAX_CHART_BARS, Math.max(1, Math.round(countBack))),
    );
    const bars = fetched.map(asBar);
    if (bars.length === 0) return { bars: [], noData: true };

    this.mergeIntoCache(symbol, resolution, bars);

    // A live window is "up to now" on the engine's clock: a period it opened is not cut off for
    // starting after a browser clock that runs behind.
    const windowed = bars.filter((b) => b.time >= fromMs && (live || b.time <= toMs));
    return { bars: windowed, noData: windowed.length === 0 };
  }

  /**
   * The newest bars of a session-grid resolution — from the one before the bar opening at `sinceMs`
   * (the newest the caller holds) to the period still forming — straight from the engine on every
   * call: this is how the chart learns that a period closed and the next one opened, so nothing
   * cached may answer it. Merged into the cache too. Null when the request fails or the resolution
   * is not on the session grid.
   */
  async sessionTail(
    symbol: string,
    resolution: TvResolution,
    sinceMs: number,
  ): Promise<SessionBar[] | null> {
    if (!isSessionResolution(resolution)) return null;
    const bars = await this.fetchSession(
      symbol,
      resolution,
      null,
      tailCount(resolution, sinceMs, Date.now()),
    ).catch(() => null);
    if (bars?.length) this.mergeIntoCache(symbol, resolution, bars.map(asBar));
    return bars;
  }

  /**
   * One `scripting/chart-bars` request. `to` null: up to now, with the period still forming. The
   * session the bars are laid out on comes with them, and is kept ({@link sessionOf}).
   */
  private async fetchSession(
    symbol: string,
    resolution: TvResolution,
    to: number | null,
    count: number,
  ): Promise<SessionBar[]> {
    const res = await firstValueFrom(
      this.scripting.chartBars({
        symbol,
        timeframe: resolution,
        to,
        count,
        includeForming: to === null,
      }),
    );
    this.recordSession(symbol, res);
    return res.bars.map(toSessionBar);
  }

  /**
   * Serve from cache only when the cache demonstrably covers the request: it
   * holds a bar at or before `fromMs` (so we know we are not missing older
   * data) and enough bars in the window. Anything less falls through to a
   * fetch, because a partially-filled window renders as a chart that simply
   * stops.
   */
  private sliceCache(cached: Bar[], fromMs: number, toMs: number, countBack: number): Bar[] | null {
    if (cached.length === 0) return null;
    if (cached[0].time > fromMs) return null;
    const windowed = cached.filter((b) => b.time >= fromMs && b.time <= toMs);
    return windowed.length >= Math.min(countBack, 1) && windowed.length > 0 ? windowed : null;
  }

  /** A series' cached bars, marked as just used (CC-24). */
  private cached(symbol: string, resolution: TvResolution): Bar[] {
    const k = this.key(symbol, resolution);
    const bars = this.cache.get(k);
    if (!bars) return [];
    this.cache.delete(k);
    this.cache.set(k, bars);
    return bars;
  }

  /** Keep `bars` for a series as its most recently used, dropping the least recently used past the cap. */
  private store(k: string, bars: Bar[]): void {
    this.cache.delete(k);
    this.cache.set(k, bars);
    while (this.cache.size > MAX_CACHED_SERIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** How many series the cache holds (tests). */
  cachedSeries(): number {
    return this.cache.size;
  }

  private mergeIntoCache(symbol: string, resolution: TvResolution, incoming: Bar[]): void {
    const k = this.key(symbol, resolution);
    const existing = this.cache.get(k);
    if (!existing || existing.length === 0) {
      this.store(k, incoming);
      return;
    }
    const byTime = new Map<number, Bar>();
    for (const b of existing) byTime.set(b.time, b);
    // Incoming wins: a re-fetched bar is fresher than a cached one, which
    // matters for the most recent bar while it is still forming.
    for (const b of incoming) byTime.set(b.time, b);
    this.store(
      k,
      [...byTime.values()].sort((a, b) => a.time - b.time),
    );
  }
}

/**
 * Turn a raw `candle/list` page into ascending bars at `resolution`.
 *
 * Exported and pure so the one genuinely dangerous step here is directly
 * testable: **the engine returns candles NEWEST-FIRST** (`GetCandlesQueryHandler`
 * does `OrderByDescending(x => x.Timestamp)` before paging). Aggregation takes
 * `open` from the first bar it sees in a bucket and `close` from the last, so
 * folding a descending page does not throw — it silently inverts every candle.
 * That is a wrong chart, not a broken one, which is far worse.
 */
export function normaliseRows(rows: CandleDto[], resolution: TvResolution): Bar[] {
  const ascending = rows.slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (ascending.length === 0) return [];
  return aggregateCandles(ascending, resolution)
    .map(toBar)
    .filter((b) => Number.isFinite(b.time));
}

export function toBar(c: CandleDto): Bar {
  return {
    time: Date.parse(c.timestamp),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

/** A `scripting/chart-bars` bar in the chart's shape; `closeTime` only when the engine sent a real one. */
export function toSessionBar(b: ChartBarDto): SessionBar {
  const bar: SessionBar = {
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
    forming: b.forming,
  };
  if (Number.isFinite(b.tc) && b.tc > b.t) bar.closeTime = b.tc;
  return bar;
}
