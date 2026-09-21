import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto } from '@core/api/api.types';
import { aggregateCandles } from './aggregate';
import { resolutionSource, sourceBarsNeeded, type TvResolution } from './resolution';

/** One bar in TradingView's shape. `time` is the bar's open, in ms. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarsResult {
  bars: Bar[];
  /** True when the range holds no data AND none is expected further back. */
  noData: boolean;
}

/** Hard ceiling on rows per request, so a wide window can't ask for millions. */
const MAX_PAGE = 5000;

/**
 * Fetches candles for the chart, in TradingView's terms.
 *
 * Two engine behaviours drive this design, both verified against
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
 */
@Injectable({ providedIn: 'root' })
export class CandleFeedService {
  private readonly marketData = inject(MarketDataService);

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
   */
  async getBars(
    symbol: string,
    resolution: TvResolution,
    fromMs: number,
    toMs: number,
    countBack: number,
  ): Promise<BarsResult> {
    const src = resolutionSource(resolution);
    if (!src) return { bars: [], noData: true };

    const cached = this.cache.get(this.key(symbol, resolution)) ?? [];
    const servedFromCache = this.sliceCache(cached, fromMs, toMs, countBack);
    if (servedFromCache) return { bars: servedFromCache, noData: false };

    // Over-fetch by the aggregation factor: 10 weekly bars need up to 70 daily
    // ones, and asking for 10 would render a chart ten times too short.
    const rows = Math.min(MAX_PAGE, Math.max(1, sourceBarsNeeded(resolution, countBack)));

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
    ).catch(() => null);

    if (!res?.status || !res.data) return { bars: [], noData: true };

    const bars = normaliseRows(res.data.data ?? [], resolution);
    if (bars.length === 0) return { bars: [], noData: true };

    this.mergeIntoCache(symbol, resolution, bars);

    const windowed = bars.filter((b) => b.time >= fromMs && b.time <= toMs);
    // An empty window with bars present means the request reached past the
    // start of history — tell the library so it stops walking backwards.
    return { bars: windowed, noData: windowed.length === 0 };
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

  private mergeIntoCache(symbol: string, resolution: TvResolution, incoming: Bar[]): void {
    const k = this.key(symbol, resolution);
    const existing = this.cache.get(k);
    if (!existing || existing.length === 0) {
      this.cache.set(k, incoming);
      return;
    }
    const byTime = new Map<number, Bar>();
    for (const b of existing) byTime.set(b.time, b);
    // Incoming wins: a re-fetched bar is fresher than a cached one, which
    // matters for the most recent bar while it is still forming.
    for (const b of incoming) byTime.set(b.time, b);
    this.cache.set(
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
