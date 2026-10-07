import { Injectable, inject } from '@angular/core';
import { CandleFeedService, type Bar } from '../datafeed/candle-feed.service';
import { MAX_CHART_BARS, tradingDayMs } from '../datafeed/session-bars';

const DAY = 86_400_000;
const TTL_MS = 5 * 60_000;
/** The side panels compare this many prior years to the current one. */
const DEFAULT_YEARS = 2;

/**
 * Session days stamped with their TRADING DAY — 00:00 UTC of the date each session closes on
 * (`tradingDayMs`) — the calendar the side panels count in. Tuesday's session opens on Monday at
 * 21:00 UTC: stamped at its open, the week-ago anchor of a performance tile and a seasonal's day of
 * year would both be a day early, and a 1 January session would count in the year before. Each bar
 * keeps its session's values; `closeTime` goes, as `time` is no longer the open. Pure, so tested
 * directly.
 */
export function tradingDayBars(sessions: readonly Bar[]): Bar[] {
  return sessions.map((b) => ({
    time: tradingDayMs(b),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/** How many session days to ask for to reach back to 1 January `priorYears` years before `nowMs`'s year. */
export function dailyCountFor(priorYears: number, nowMs: number): number {
  // A week before that 1 January, so the earliest year has a prior close as its base. Calendar days
  // over-count trading days by the weekends, which is the headroom.
  const target = Date.UTC(new Date(nowMs).getUTCFullYear() - priorYears, 0, 1) - 7 * DAY;
  return Math.min(MAX_CHART_BARS, Math.ceil((nowMs - target) / DAY) + 1);
}

/**
 * One shared daily-bar fetch per symbol for the side panels: the performance tiles, the seasonals
 * and the swap / carry pane. Session days from the engine (`scripting/chart-bars` — days roll at
 * 17:00 New York, as TradingView's do), through the chart's `CandleFeedService` and its cache, in one
 * request. The engine lays them out from the candles it stores below a day — H1 reaches back to
 * 2010 — so no older stretch is stitched on from another source, as was done when the stored D1
 * (UTC days, from late 2024) was the source.
 */
@Injectable({ providedIn: 'root' })
export class DailyBarsService {
  private readonly feed = inject(CandleFeedService);
  private readonly inflight = new Map<string, { at: number; p: Promise<Bar[]> }>();

  /** Daily bars, stamped by trading day, reaching back to 1 January `priorYears` years before this one. */
  daily(symbol: string, priorYears = DEFAULT_YEARS): Promise<Bar[]> {
    const key = `${symbol.toUpperCase()}|${priorYears}`;
    const hit = this.inflight.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
    const p = this.load(symbol.toUpperCase(), priorYears).catch(() => {
      this.inflight.delete(key);
      return [] as Bar[];
    });
    this.inflight.set(key, { at: Date.now(), p });
    return p;
  }

  private async load(symbol: string, priorYears: number): Promise<Bar[]> {
    const now = Date.now();
    const { bars } = await this.feed.getBars(symbol, '1D', 0, now, dailyCountFor(priorYears, now));
    return tradingDayBars(bars);
  }
}
