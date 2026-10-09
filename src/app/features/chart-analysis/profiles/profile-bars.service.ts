import { Injectable, inject, signal } from '@angular/core';
import { CandleFeedService, type Bar } from '../datafeed/candle-feed.service';
import type { TvResolution } from '../datafeed/resolution';

/** Bars per request (the candle feed pages at 5,000 rows). */
const PAGE = 5_000;

/**
 * Lower-timeframe bars for the profile studies (DR-I7): one series per `symbol|resolution`, loaded over the chart's
 * range in pages through the candle feed (and its cache), extended at either end as the chart scrolls back or a new
 * bar opens. `version` bumps when bars land, so the chart re-profiles.
 */
@Injectable({ providedIn: 'root' })
export class ProfileBarsService {
  private readonly feed = inject(CandleFeedService);
  private readonly held = new Map<string, Bar[]>();
  private readonly loading = new Map<string, Promise<void>>();
  /** When each series last fetched its new end: the bars closing since are fetched at most this often. */
  private readonly tailAt = new Map<string, number>();
  private static readonly TAIL_EVERY_MS = 30_000;

  /** Bumped whenever a series gains bars. */
  readonly version = signal(0);

  private key(symbol: string, resolution: TvResolution): string {
    return `${symbol.toUpperCase()}|${resolution}`;
  }

  /** What is held for `symbol` at `resolution` within [fromMs, toMs] (possibly not all of it yet). */
  bars(symbol: string, resolution: TvResolution, fromMs: number, toMs: number): Bar[] {
    const all = this.held.get(this.key(symbol, resolution)) ?? [];
    return all.filter((b) => b.time >= fromMs && b.time <= toMs);
  }

  /**
   * Make sure [fromMs, toMs] is held: loads what is missing at the old end (scroll-back) and at the new end (bars
   * closed since), newest first, page by page. One load per series at a time; a failure leaves what was held.
   */
  ensure(symbol: string, resolution: TvResolution, fromMs: number, toMs: number): void {
    const key = this.key(symbol, resolution);
    if (this.loading.has(key)) return;
    const held = this.held.get(key) ?? [];
    const first = held[0]?.time;
    const last = held[held.length - 1]?.time;
    const needOld = first === undefined || first > fromMs;
    let needNew = last === undefined || last < toMs;
    // The new end moves with every bar; while the old end is held, catch up with it now and then, not per tick.
    if (
      needNew &&
      !needOld &&
      Date.now() - (this.tailAt.get(key) ?? 0) < ProfileBarsService.TAIL_EVERY_MS
    )
      needNew = false;
    if (!needOld && !needNew) return;
    if (needNew) this.tailAt.set(key, Date.now());
    const run = (async () => {
      const added: Bar[] = [];
      // The new end first (what the operator is looking at), then back to the window's start.
      let to = toMs;
      const stopAt = needOld ? fromMs : (last ?? fromMs);
      for (let guard = 0; guard < 40 && to > stopAt; guard++) {
        const res = await this.feed.getBars(symbol, resolution, stopAt, to, PAGE);
        if (!res.bars.length) break;
        added.push(...res.bars);
        const oldest = res.bars[0].time;
        if (oldest <= stopAt || res.bars.length < 2) break;
        to = oldest - 1;
      }
      if (!added.length) return;
      const byTime = new Map<number, Bar>((this.held.get(key) ?? []).map((b) => [b.time, b]));
      for (const b of added) byTime.set(b.time, b);
      this.held.set(
        key,
        [...byTime.values()].sort((a, b) => a.time - b.time),
      );
      this.version.update((v) => v + 1);
    })()
      .catch(() => undefined)
      .finally(() => this.loading.delete(key));
    this.loading.set(key, run);
  }
}
