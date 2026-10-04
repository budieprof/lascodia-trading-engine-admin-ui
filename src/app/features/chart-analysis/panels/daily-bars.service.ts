import { Injectable, inject } from '@angular/core';
import { CandleFeedService, type Bar } from '../datafeed/candle-feed.service';
import { foldBars } from '../datafeed/aggregate';

/** Daily bars covering the current year plus two full prior years (FX ≈ 260 bars/yr). */
const DAILY_COUNT_BACK = 900;
const TTL_MS = 5 * 60_000;
/** The side panels compare this many prior years to the current one. */
const DEFAULT_YEARS = 2;
const H1_PAGE = 5000;
/** ~6,200 H1 bars per FX year; one spare page for the base close and gaps. */
const pagesFor = (years: number) => Math.ceil(((years + 1) * 6300) / H1_PAGE) + 1;

/**
 * Prepend days folded from H1 where the engine holds no D1. Its D1 history is
 * short (EURUSD: from 2024-10-01) while H1 goes back to 2010, so without this a
 * prior year in Seasonals began in October at 0% — a gap and a jump where
 * TradingView draws the full year. Pure, so tested directly.
 */
export function backfillDaily(d1: readonly Bar[], h1: readonly Bar[]): Bar[] {
  const first = d1[0]?.time ?? Infinity;
  const older = foldBars(
    h1.filter((b) => b.time < first),
    '1D',
  ) as Bar[];
  return [...older, ...d1];
}

/**
 * One shared daily-bar fetch per symbol for the side panels (performance tiles
 * and seasonals both read the same ~3 years of D1 bars). Goes through the
 * chart's `CandleFeedService`, so it uses the same nested-filter candle query
 * and cache as the chart itself.
 */
@Injectable({ providedIn: 'root' })
export class DailyBarsService {
  private readonly feed = inject(CandleFeedService);
  private readonly inflight = new Map<string, { at: number; p: Promise<Bar[]> }>();

  /** Daily bars reaching back to 1 January `priorYears` years before the latest. */
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
    const d1 = (await this.feed.getBars(symbol, '1D', 0, Date.now(), DAILY_COUNT_BACK)).bars;
    const latest = d1.length
      ? new Date(d1[d1.length - 1].time).getUTCFullYear()
      : new Date().getUTCFullYear();
    // A few days before the earliest year, so that year has a prior close as its base.
    const target = Date.UTC(latest - priorYears, 0, 1) - 7 * 86_400_000;
    let to = (d1[0]?.time ?? Date.now()) - 1;
    if (to <= target) return d1;
    const h1: Bar[] = [];
    for (let page = 0; page < pagesFor(priorYears) && to > target; page++) {
      const chunk = (await this.feed.getBars(symbol, '60', 0, to, H1_PAGE)).bars.filter(
        (b) => b.time <= to,
      );
      if (!chunk.length) break;
      h1.unshift(...chunk);
      to = chunk[0].time - 1;
    }
    return backfillDaily(d1, h1);
  }
}
