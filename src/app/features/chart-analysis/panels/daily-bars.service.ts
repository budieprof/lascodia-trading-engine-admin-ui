import { Injectable, inject } from '@angular/core';
import { CandleFeedService, type Bar } from '../datafeed/candle-feed.service';

/** Daily bars covering the current year plus two full prior years (FX ≈ 260 bars/yr). */
const DAILY_COUNT_BACK = 900;
const TTL_MS = 5 * 60_000;

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

  daily(symbol: string): Promise<Bar[]> {
    const key = symbol.toUpperCase();
    const hit = this.inflight.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
    const p = this.feed
      .getBars(key, '1D', 0, Date.now(), DAILY_COUNT_BACK)
      .then((r) => r.bars)
      .catch(() => {
        this.inflight.delete(key);
        return [] as Bar[];
      });
    this.inflight.set(key, { at: Date.now(), p });
    return p;
  }
}
