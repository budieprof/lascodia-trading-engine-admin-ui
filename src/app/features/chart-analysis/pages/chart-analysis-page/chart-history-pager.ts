import type { WritableSignal } from '@angular/core';

import type { Bar } from '../../datafeed/candle-feed.service';
import { sameSeries, type SeriesId } from '../../scripts/live-bar';
import { PAGE_BARS } from './chart-page.config';

/** What the pager reads and writes on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartHistoryPagerDeps {
  symbol: () => string;
  resolution: () => string;
  bars: WritableSignal<Bar[]>;
  barsFor: () => SeriesId | null;
  loading: WritableSignal<boolean>;
  historyStart: WritableSignal<string | null>;
  feed: {
    getBars(
      symbol: string,
      resolution: string,
      from: number,
      to: number,
      limit: number,
    ): Promise<{ bars: Bar[] }>;
  };
  replay: () => { shift(added: number): void };
  host: () => { historyLoaded(): void } | null | undefined;
  loadEvents: (extend: boolean) => void;
  extendCompareBars: (oldestMs: number) => Promise<void>;
}

/**
 * The chart page's scroll-back paging (U13: moved out of ChartAnalysisPageComponent, behaviour unchanged).
 */
export class ChartHistoryPager {
  constructor(private readonly deps: ChartHistoryPagerDeps) {}

  /**
   * Scroll-back paging: fetch the window ENDING just before the oldest bar we hold
   * and prepend it. Asking by `to` rather than by `from` matches how the engine
   * pages (newest-first from a cutoff), so each page is a clean extension
   * backwards with no gap and no overlap to reconcile.
   *
   * The cutoff is the oldest bar's open less 1 ms, not less one bar width: on the
   * session grid a period is not a fixed width (a month, a week across a DST
   * change), and `oldest − width` skipped the bar before; on 30m it cut the M15
   * page between the two halves of the bar before, which then joined the chart
   * half-built.
   */
  async loadOlder(): Promise<void> {
    const d = this.deps;
    const series: SeriesId = { symbol: d.symbol(), resolution: d.resolution() };
    const held = d.bars();
    // Nothing to extend, a load under way, or the bars on screen are not this series' yet.
    if (held.length === 0 || d.loading() || !sameSeries(d.barsFor(), series)) {
      d.host()?.historyLoaded();
      return;
    }
    const oldest = held[0].time;
    d.loading.set(true);
    try {
      const { bars } = await d.feed.getBars(
        series.symbol,
        series.resolution,
        0,
        oldest - 1,
        PAGE_BARS,
      );
      // After a switch made meanwhile these are another series' history: not prepended.
      if (sameSeries(d.barsFor(), series)) {
        const older = bars.filter((b) => b.time < oldest);
        if (older.length === 0) {
          // Nothing before the oldest bar: the start of history. Stop asking at the left edge.
          d.historyStart.set(`${series.symbol}|${series.resolution}`);
        } else {
          const merged = new Map<number, Bar>();
          for (const b of older) merged.set(b.time, b);
          // The bars as they are now: ticks may have moved the newest one during the load.
          for (const b of d.bars()) merged.set(b.time, b);
          const next = [...merged.values()].sort((a, b) => a.time - b.time);
          const added = next.length - d.bars().length;
          d.bars.set(next);
          // Replay counts bars from the left: the head stays on its bar (CC-11 — it jumped ~1,500
          // bars into the future with every page of history).
          d.replay().shift(added);
          // The events of the history just loaded (the layer covered the first window only), and the
          // compare studies' other symbols over it.
          d.loadEvents(true);
          void d.extendCompareBars(next[0].time);
        }
      }
    } catch {
      // The engine refused or could not be reached: the history stays as it is, and the next
      // scroll to the left edge asks again.
    } finally {
      d.loading.set(false);
      d.host()?.historyLoaded();
    }
  }
}
