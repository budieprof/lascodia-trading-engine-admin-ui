import { signal, type WritableSignal } from '@angular/core';

import type { CompareSeriesSpec } from '../../compare/compare-series';
import type { ScaleMode } from '../../chart/chart-host.component';
import type { Bar } from '../../datafeed/candle-feed.service';
import type { TvResolution } from '../../datafeed/resolution';
import type { TradingCalendar } from '../../datafeed/session-calendar';
import { liveTick } from '../../datafeed/live-tick';
import { GO_TO_DATE_PAGES, PAGE_BARS } from './chart-page.config';
import { scaleAfterCompare } from './chart-page.helpers';

export interface ChartCompareStateDeps {
  feed: {
    getBars(
      symbol: string,
      resolution: string,
      from: number,
      to: number,
      limit: number,
    ): Promise<{ bars: Bar[] }>;
  };
  resolution: () => TvResolution;
  /** The chart's oldest bar (scroll-back extends the compare symbols to it). */
  oldestBarTime: () => number | undefined;
  now: () => number;
  calendarOf: (symbol: string) => TradingCalendar | null;
  scaleMode: () => WritableSignal<ScaleMode>;
  notify: (text: string) => void;
}

/**
 * The chart page's compare state (U13: moved out of ChartAnalysisPageComponent, behaviour unchanged): the compare
 * overlays and synthetic series (CC-I12) and the other symbols' bars the compare studies read (CC-13), kept live by
 * ticks and extended on scroll-back.
 */
export class ChartCompareState {
  readonly series = signal<CompareSeriesSpec[]>([]);
  /** Other symbols' bars for compare studies, keyed by symbol. */
  readonly bars = signal<Record<string, Bar[]>>({});

  constructor(private readonly deps: ChartCompareStateDeps) {}

  /**
   * Add a compare series. A compare symbol goes on the price's scale, so the scale turns to Percent (each line from
   * 0 % at the first bar on screen) unless it already compares (percent or indexed to 100).
   */
  add(spec: CompareSeriesSpec): void {
    this.series.update((l) => [...l, spec]);
    const scale = this.deps.scaleMode();
    const next = scaleAfterCompare(spec, scale());
    if (next.switched) {
      scale.set('percent');
      this.deps.notify(
        'The price scale is now Percent: each symbol starts at 0 % on the first bar on screen.',
      );
    }
  }

  remove(id: string): void {
    this.series.update((l) => l.filter((c) => c.id !== id));
  }

  /**
   * The compare studies' other symbols, on this resolution, back to the chart's oldest bar (CC-13:
   * they read the first 1,500 bars only, never extended nor updated). Ticks keep them live
   * ({@link applyTick}); scroll-back extends them ({@link extendBars}).
   */
  private request = 0;
  async loadBars(symbols: string[], resolution: TvResolution): Promise<void> {
    const request = ++this.request;
    const now = Date.now();
    const next: Record<string, Bar[]> = {};
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          next[sym] = (await this.deps.feed.getBars(sym, resolution, 0, now, PAGE_BARS)).bars;
        } catch {
          // Unknown symbol: the study stays empty rather than failing the chart.
        }
      }),
    );
    // Drop the result if the operator moved on while it loaded.
    if (request !== this.request || resolution !== this.deps.resolution()) return;
    this.bars.set(next);
    const oldest = this.deps.oldestBarTime();
    if (oldest !== undefined) void this.extendBars(oldest);
  }

  /** Extend every compare series back to `oldestMs` (the chart's oldest bar), a page at a time. */
  async extendBars(oldestMs: number): Promise<void> {
    const resolution = this.deps.resolution();
    const request = this.request;
    for (const sym of Object.keys(this.bars())) {
      for (let page = 0; page < GO_TO_DATE_PAGES; page++) {
        const held = this.bars()[sym];
        if (!held?.length || held[0].time <= oldestMs) break;
        let older: Bar[] = [];
        try {
          const res = await this.deps.feed.getBars(sym, resolution, 0, held[0].time - 1, PAGE_BARS);
          older = res.bars.filter((b) => b.time < held[0].time);
        } catch {
          break;
        }
        if (request !== this.request || resolution !== this.deps.resolution()) return;
        if (!older.length) break;
        this.bars.update((all) => {
          const current = all[sym] ?? [];
          return {
            ...all,
            [sym]: [...older.filter((b) => b.time < (current[0]?.time ?? Infinity)), ...current],
          };
        });
      }
    }
  }

  /** A live price of a compare study's other symbol moves its bars (CC-13). */
  applyTick(tick: { symbol?: string; bid?: number; price?: number; ask?: number }): void {
    const symbol = tick?.symbol?.toUpperCase();
    const price = tick?.bid ?? tick?.price ?? tick?.ask;
    if (!symbol || typeof price !== 'number') return;
    const held = this.bars()[symbol];
    if (!held?.length) return;
    const next = liveTick(
      held,
      price,
      this.deps.now(),
      this.deps.resolution(),
      this.deps.calendarOf(symbol),
    );
    if (next) this.bars.update((all) => ({ ...all, [symbol]: next }));
  }
}
