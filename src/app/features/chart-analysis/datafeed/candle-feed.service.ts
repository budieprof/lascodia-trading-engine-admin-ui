import { Injectable, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { ScriptingService } from '@core/services/scripting.service';
import type { CandleDto } from '@core/api/api.types';
import type { ChartBarDto, ChartBarsResult } from '@core/api/scripting.types';
import { aggregateCandles, EPOCH_GRID, type BarGrid } from './aggregate';
import { parseSynthetic, syntheticBars, type SyntheticBuild, type SyntheticSpec } from '../compare/synthetic';
import {
  isSessionResolution,
  resolutionSource,
  sourceBarsNeeded,
  type TvResolution,
} from './resolution';
import { MAX_CHART_BARS, asBar, tailCount } from './session-bars';
import { addCoverage, coverageOf, serveFromCache, type Coverage } from './bar-cache';
import { TradingCalendar, type SessionClosure, type SessionSpec } from './session-calendar';
import {
  isVenueSource,
  mergeClosures,
  readChartFacts,
  readClosures,
  readFirstBarMs,
  type SymbolFacts,
} from './chart-facts';

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
  /**
   * The bid/ask spread the broker recorded for the bar, in MT5 points (10^-digits of the price), when the engine has
   * it (`Candle.SpreadPoints`, EA v8.47.249+). Bar Replay's paper orders pay it (CC-I4).
   */
  spreadPoints?: number;
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

/** One cached series: its bars and the spans they cover completely (UD03, `bar-cache.ts`). */
interface CachedSeries {
  bars: Bar[];
  spans: Coverage[];
}

/**
 * What a session-grid answer covers: up to `toMs` (a live answer: up to its newest CLOSED bar — the forming one is
 * never served from the cache), from its oldest bar or, when it came back short of `count`, from the start of history.
 */
function sessionCoverage(
  bars: readonly SessionBar[],
  toMs: number,
  live: boolean,
  count: number,
): Coverage | null {
  const closed = live ? bars.filter((b) => !b.forming) : bars;
  return coverageOf(closed, { toMs, live, reachedStart: bars.length < count });
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
   * Cache of ascending bars per `symbol|resolution|source` ({@link key}).
   *
   * Scroll-back re-asks for windows it has already seen, so without this the
   * chart refetches the same thousands of rows every time the operator drags
   * left. Keyed on the TARGET resolution, i.e. aggregated bars are cached in
   * their aggregated form — aggregating a long M15 range into `30` on every
   * pan is the other half of the same cost.
   */
  private readonly cache = new Map<string, CachedSeries>();

  /**
   * `symbol|resolution|source`: the candle source the engine reads the symbol's bars from (C1 `source.id`, once an
   * answer said it) is part of the series' identity (UD07) — when the engine pins another source (MT5 → a venue, one
   * venue → another), bars cached from the old one are never served as the new one's.
   */
  private key(symbol: string, resolution: TvResolution): string {
    const source = untracked(() => this.factsOf(symbol)?.source?.id ?? '');
    const adjustment = this.adjustments.get(symbol.toUpperCase());
    return `${symbol}|${resolution}|${source}${adjustment ? `|${adjustment}` : ''}`;
  }

  /** UD11: the corporate-action adjustment asked for per symbol (equities / ETFs); absent = the engine's default. */
  private readonly adjustments = new Map<string, 'none' | 'splits' | 'all'>();

  /** Ask chart-bars for `symbol`'s bars with `adjustment` (null: the engine's default). Callers reload after. */
  setAdjustment(symbol: string, adjustment: 'none' | 'splits' | 'all' | null): void {
    const key = symbol.toUpperCase();
    if (adjustment) this.adjustments.set(key, adjustment);
    else this.adjustments.delete(key);
  }

  /** The adjustment asked for `symbol`, or null for the engine's default. */
  adjustmentOf(symbol: string): 'none' | 'splits' | 'all' | null {
    return this.adjustments.get(symbol.toUpperCase()) ?? null;
  }

  /**
   * Each symbol's session as the engine reported it with its chart bars (`session`, `timeZone`, and C1 `closures`):
   * the trading days its day-based studies count in (`TradingCalendar`). A signal, so a chart that learns it after
   * drawing recomputes them. A symbol whose session never came stays out, and counts UTC days.
   *
   * The engine is the ONLY authority (multi-asset chart program UD01): the session it lays the bars out on — FX's
   * 17:00 New York day, a CFD's exchange hours with pre/post-market (C6), a venue instrument's calendar — with the
   * holidays, early closes and breaks of the windows it answered for. The client used to replace it with a session it
   * derived from `GET calendars/{code}` (one open-close pair, no holidays, no pre/post): deleted, not layered.
   */
  private readonly sessions = signal<ReadonlyMap<string, SessionSpec>>(new Map());
  /** C1 facts per symbol (asset class, calendar, volume kind, source, adjustment), from the newest chart-bars answer. */
  private readonly factsState = signal<ReadonlyMap<string, SymbolFacts>>(new Map());
  /** C1 `firstBarMs` per `SYMBOL|resolution` (the oldest stored bar), from chart-bars answers. */
  private readonly firstBars = signal<ReadonlyMap<string, number | null>>(new Map());

  /** {@link learnSession} requests in flight, by symbol. */
  private readonly learning = new Map<string, Promise<SessionSpec | null>>();

  /** `symbol`'s session, once the engine has reported it; null until then (or if it has none). */
  sessionOf(symbol: string): SessionSpec | null {
    return this.sessions().get(symbol.toUpperCase()) ?? null;
  }

  /** `symbol`'s C1 facts, once a chart-bars answer carried them; null until then (or from an engine before C1). */
  factsOf(symbol: string): SymbolFacts | null {
    return this.factsState().get(symbol.toUpperCase()) ?? null;
  }

  /**
   * The oldest stored bar of `symbol` at `resolution` (C1 `firstBarMs`): a number once known, null when the engine said
   * it has none, undefined while not known.
   */
  firstBarOf(symbol: string, resolution: TvResolution): number | null | undefined {
    const map = this.firstBars();
    const key = `${symbol.toUpperCase()}|${resolution}`;
    return map.has(key) ? map.get(key)! : undefined;
  }

  /** Calendars built for {@link gridOf}, by session identity. */
  private readonly gridCalendars = new Map<string, TradingCalendar>();

  /**
   * Where `symbol`'s stored bars fall (UD02, {@link BarGrid}): its session's periods for a VENUE instrument whose
   * session is not the UTC clock (the engine builds those bars on the calendar — 1h from 09:30 on NYSE), else the UTC
   * epoch grid: every MT5 symbol (FX unchanged), crypto's 24x7, and any symbol whose source or session is not known yet.
   * Reads signals: a `computed` follows the answer that teaches it.
   */
  gridOf(symbol: string): BarGrid {
    const facts = this.factsOf(symbol);
    const spec = this.sessionOf(symbol);
    if (!facts || !spec || !isVenueSource(facts.source)) return EPOCH_GRID;
    if (/^0000-0000(:1234567)?$/.test(spec.session) && /^(etc\/)?utc$/i.test(spec.timeZone))
      return EPOCH_GRID;
    const key = `${spec.session}|${spec.timeZone}|${spec.closures?.length ?? 0}`;
    let calendar = this.gridCalendars.get(key);
    if (!calendar) {
      calendar = new TradingCalendar(spec);
      if (this.gridCalendars.size > 32) this.gridCalendars.clear();
      this.gridCalendars.set(key, calendar);
    }
    return { kind: 'session', calendar };
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
        .then((res) => this.recordSession(key, res, '1D'))
        .catch(() => null)
        .finally(() => this.learning.delete(key));
      this.learning.set(key, pending);
    }
    return pending;
  }

  /** Keep what a `scripting/chart-bars` answer reports for `symbol`: its session + closures, and its C1 facts. */
  private recordSession(
    symbol: string,
    res: Pick<ChartBarsResult, 'session' | 'timeZone'> & Partial<ChartBarsResult>,
    resolution?: TvResolution,
  ): SessionSpec | null {
    const key = symbol.toUpperCase();
    this.recordFacts(key, res, resolution);
    const session = typeof res?.session === 'string' ? res.session.trim() : '';
    if (!session) return null;
    const zone = typeof res.timeZone === 'string' ? res.timeZone.trim() : '';
    const timeZone = zone || 'Etc/UTC';
    const held = this.sessions().get(key);
    const sameLayout = held?.session === session && held.timeZone === timeZone;
    const closures: SessionClosure[] = mergeClosures(
      sameLayout ? (held?.closures ?? []) : [],
      readClosures(res),
    );
    if (sameLayout && (held?.closures?.length ?? 0) === closures.length) return held!;
    const spec: SessionSpec = closures.length
      ? { session, timeZone, closures }
      : { session, timeZone };
    this.sessions.update((m) => new Map(m).set(key, spec));
    return spec;
  }

  private recordFacts(key: string, res: Partial<ChartBarsResult>, resolution?: TvResolution): void {
    const facts = readChartFacts(res);
    if (facts) {
      const held = this.factsState().get(key);
      if (!held || JSON.stringify(held) !== JSON.stringify(facts))
        this.factsState.update((m) => new Map(m).set(key, facts));
    }
    if (resolution && 'firstBarMs' in (res ?? {})) {
      const k = `${key}|${resolution}`;
      const first = readFirstBarMs(res);
      if (this.firstBars().get(k) !== first || !this.firstBars().has(k))
        this.firstBars.update((m) => new Map(m).set(k, first));
    }
  }

  /** Drop cached bars. Call when the symbol's data is known to have changed. */
  invalidate(symbol?: string, resolution?: TvResolution): void {
    if (!symbol) {
      this.cache.clear();
      return;
    }
    if (resolution) {
      for (const k of [...this.cache.keys()]) {
        if (k.startsWith(`${symbol}|${resolution}|`)) this.cache.delete(k);
      }
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

  /** US04: each synthetic series' last build (`symbol|resolution`): what the chart's notice says about it. */
  private readonly syntheticBuilds = new Map<string, SyntheticBuild>();
  syntheticBuildOf(symbol: string, resolution: TvResolution): SyntheticBuild | null {
    return this.syntheticBuilds.get(`${symbol.toUpperCase()}|${resolution}`) ?? null;
  }

  /** US04: a synthetic's bars from both legs' (each read, cached and refused as any symbol's), joined as of each bar. */
  private async getSyntheticBars(
    symbol: string,
    spec: SyntheticSpec,
    resolution: TvResolution,
    fromMs: number,
    toMs: number,
    countBack: number,
  ): Promise<BarsResult> {
    const [a, b] = await Promise.all([
      this.getBars(spec.a, resolution, fromMs, toMs, countBack),
      this.getBars(spec.b, resolution, fromMs, toMs, countBack),
    ]);
    const build = syntheticBars(spec, a.bars, b.bars);
    this.syntheticBuilds.set(`${symbol.toUpperCase()}|${resolution}`, build);
    return { bars: build.bars, noData: a.noData || b.noData };
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
    // US04: a spread / ratio symbol is built from its legs' bars (compare/synthetic.ts).
    const synthetic = parseSynthetic(symbol);
    if (synthetic) return this.getSyntheticBars(symbol, synthetic, resolution, fromMs, toMs, countBack);
    if (isSessionResolution(resolution)) {
      return this.getSessionBars(symbol, resolution, fromMs, toMs, countBack);
    }
    const src = resolutionSource(resolution);
    if (!src || src.kind !== 'stored') return { bars: [], noData: true };

    const servedFromCache = this.fromCache(symbol, resolution, fromMs, toMs, countBack);
    if (servedFromCache) return { bars: servedFromCache, noData: false };
    const live = toMs >= Date.now() - LIVE_EDGE_MS;

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

    const page = res.data.data ?? [];
    const bars = normaliseRows(page, resolution, this.gridOf(symbol));
    if (bars.length === 0) return { bars: [], noData: true };

    this.mergeIntoCache(
      symbol,
      resolution,
      bars,
      coverageOf(bars, {
        toMs,
        live,
        reachedStart: page.length < rows,
        // A fold's oldest bucket may lack the source rows before the page (30m from one M15).
        oldestPartial: src.aggregate !== 1,
      }),
    );

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
      const servedFromCache = this.fromCache(symbol, resolution, fromMs, toMs, countBack);
      if (servedFromCache) return { bars: servedFromCache, noData: false };
    }

    const count = Math.min(MAX_CHART_BARS, Math.max(1, Math.round(countBack)));
    const fetched = await this.fetchSession(symbol, resolution, live ? null : toMs + 1, count);
    const bars = fetched.map(asBar);
    if (bars.length === 0) return { bars: [], noData: true };

    this.mergeIntoCache(symbol, resolution, bars, sessionCoverage(fetched, toMs, live, count));

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
    if (bars?.length)
      this.mergeIntoCache(
        symbol,
        resolution,
        bars.map(asBar),
        sessionCoverage(bars, Date.now(), true, Number.POSITIVE_INFINITY),
      );
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
        ...(this.adjustmentOf(symbol) ? { adjustment: this.adjustmentOf(symbol) } : {}),
      }),
    );
    this.recordSession(symbol, res, resolution);
    return res.bars.map(toSessionBar);
  }

  /** The cached answer to a window, when one span of the cache covers it with no gap ({@link serveFromCache}). */
  private fromCache(
    symbol: string,
    resolution: TvResolution,
    fromMs: number,
    toMs: number,
    countBack: number,
  ): Bar[] | null {
    const held = this.cached(symbol, resolution);
    return held ? serveFromCache(held.bars, held.spans, fromMs, toMs, countBack) : null;
  }

  /** A series' cached bars, marked as just used (CC-24). */
  private cached(symbol: string, resolution: TvResolution): CachedSeries | null {
    const k = this.key(symbol, resolution);
    const held = this.cache.get(k);
    if (!held) return null;
    this.cache.delete(k);
    this.cache.set(k, held);
    return held;
  }

  /** Keep a series as the most recently used, dropping the least recently used past the cap. */
  private store(k: string, series: CachedSeries): void {
    this.cache.delete(k);
    this.cache.set(k, series);
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

  private mergeIntoCache(
    symbol: string,
    resolution: TvResolution,
    incoming: Bar[],
    covered: Coverage | null,
  ): void {
    const k = this.key(symbol, resolution);
    const existing = this.cache.get(k);
    if (!existing || existing.bars.length === 0) {
      this.store(k, { bars: incoming, spans: addCoverage([], covered) });
      return;
    }
    const byTime = new Map<number, Bar>();
    for (const b of existing.bars) byTime.set(b.time, b);
    // Incoming wins: a re-fetched bar is fresher than a cached one, which
    // matters for the most recent bar while it is still forming.
    for (const b of incoming) byTime.set(b.time, b);
    this.store(k, {
      bars: [...byTime.values()].sort((a, b) => a.time - b.time),
      spans: addCoverage(existing.spans, covered),
    });
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
export function normaliseRows(
  rows: CandleDto[],
  resolution: TvResolution,
  grid: BarGrid = EPOCH_GRID,
): Bar[] {
  const ascending = rows.slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (ascending.length === 0) return [];
  return aggregateCandles(ascending, resolution, grid)
    .map(toBar)
    .filter((b) => Number.isFinite(b.time));
}

export function toBar(c: CandleDto): Bar {
  const bar: Bar = {
    time: Date.parse(c.timestamp),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
  if (typeof c.spreadPoints === 'number' && Number.isFinite(c.spreadPoints) && c.spreadPoints >= 0)
    bar.spreadPoints = c.spreadPoints;
  return bar;
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
