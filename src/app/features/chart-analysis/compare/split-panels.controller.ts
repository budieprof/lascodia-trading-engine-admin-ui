import { signal, untracked } from '@angular/core';

import type { Bar } from '../datafeed/candle-feed.service';
import type { TvResolution } from '../datafeed/resolution';
import type { TradingCalendar } from '../datafeed/session-calendar';
import type { BarGrid } from '../datafeed/aggregate';
import { liveTick, tickPrice, tickTimeMs, type PriceTick } from '../datafeed/live-tick';
import type { LegendSnapshot } from '../chart/chart-host.component';
import type { ExchangeSessions } from '../indicators/exchange-sessions';
import type { PanelScript } from '../workspace/chart-panels';
import { freshRuns } from '../pages/chart-analysis-page/chart-page.helpers';
import type { ActiveIndicator } from '../chart/chart-host.component';
import { panelLoadError, withView, type PanelLoad, type PanelView } from './split-panels';

/** One of the split view's other charts. */
export interface ComparePanel {
  id: string;
  symbol: string;
  resolution: TvResolution;
  bars: Bar[];
  /** Its oldest bar is the start of the engine's history: scroll-back stops asking (CC-14). */
  historyComplete?: boolean;
  /** Its own built-in studies (CC-I5). */
  indicators: ActiveIndicator[];
  /** Its link group, 1 … 3; 0: not linked (CC-I5). */
  link: number;
  /** Its own Pine indicators (CC-I5). */
  scripts: PanelScript[];
  /** US03: its own style / scale / volume (absent: the main chart's style and scale, no volume). */
  view?: PanelView;
  /** US03: loading, on screen, nothing to show (and why), or failed. */
  load?: PanelLoad;
}

export type SplitLayoutId = '1' | '2h' | '2v' | '4' | '6' | '8';

export const SPLIT_LAYOUTS: ReadonlyArray<{ id: SplitLayoutId; label: string; panels: number }> = [
  { id: '1', label: '▢', panels: 0 },
  { id: '2h', label: '◫', panels: 1 },
  { id: '2v', label: '⊟', panels: 1 },
  { id: '4', label: '⊞', panels: 3 },
  { id: '6', label: '⊟⊞', panels: 5 },
  { id: '8', label: '⊞⊞', panels: 7 },
];

/** Page size of a panel's history request. */
const PAGE = 1500;

export interface SplitPanelsDeps {
  feed: {
    getBars(symbol: string, resolution: TvResolution, from: number, to: number, count: number): Promise<{ bars: Bar[] }>;
    learnSession(symbol: string): Promise<unknown>;
    gridOf(symbol: string): BarGrid;
  };
  /** Whether a timeframe is on the engine's session grid (its bars carry their session). */
  isSessionResolution(resolution: TvResolution): boolean;
  /** Why a series has no bars, in words (the main chart's "no data" text). */
  noDataMessage(symbol: string, resolution: TvResolution): string;
  /** The symbols new panels open on, besides those `taken` (US03: the broker's, then the catalogue's). */
  candidates(taken: string[]): string[];
  mainSymbol(): string;
  mainResolution(): TvResolution;
  /** The panel chart host at `index` (scroll-back tells it the page landed). */
  hostAt(index: number): { historyLoaded(): void } | undefined;
  /** The engine's clock. */
  now(): number;
  calendarOf(symbol: string): TradingCalendar | null;
  /** A symbol's trading-calendar code (C1, then the catalogue), for its Exchange-sessions study. */
  calendarCodeOf(symbol: string): string | null;
  loadCalendar(code: string): Promise<ExchangeSessions | null>;
  /** With symbol / interval sync on, the charts linked to `id` follow it (CC-I5). */
  linkSymbol(id: string, symbol: string): void;
  linkInterval(id: string, resolution: string): void;
}

/**
 * US02 (from ChartAnalysisPageComponent, behaviour unchanged): the split view's other charts — the arrangement, each
 * panel's series, bars, legend, own look and load state, scroll-back, live prices, and the Exchange sessions their
 * studies read. The page keeps what ties them to the main chart (focus, link groups, their studies and scripts).
 */
export class SplitPanelsController {
  readonly layout = signal<SplitLayoutId>('1');
  readonly panels = signal<ComparePanel[]>([]);
  /** Each split panel's legend: the bar under its crosshair (CC-12). */
  readonly legends = signal<Record<string, LegendSnapshot>>({});
  /** US03: Pre / Regular / Post sessions by calendar code (loaded once per code). */
  private readonly calendars = signal<Record<string, ExchangeSessions | null>>({});

  constructor(private readonly deps: SplitPanelsDeps) {}

  setLayout(id: SplitLayoutId): void {
    this.layout.set(id);
    const wanted = SPLIT_LAYOUTS.find((l) => l.id === id)?.panels ?? 0;
    const current = this.panels();
    if (current.length === wanted) return;

    if (current.length > wanted) {
      this.panels.set(current.slice(0, wanted));
      return;
    }
    // New panels open on a different symbol from the primary chart: two
    // identical charts side by side is never what the operator wanted.
    const main = this.deps.mainSymbol();
    const candidates = this.deps.candidates([main, ...current.map((p) => p.symbol)]);
    const added: ComparePanel[] = [];
    for (let i = current.length; i < wanted; i++) {
      const symbol = candidates[i - current.length] ?? main;
      added.push({
        id: `p${Date.now().toString(36)}${i}`,
        symbol,
        resolution: this.deps.mainResolution(),
        bars: [],
        indicators: [],
        link: 0,
        scripts: [],
      });
    }
    this.panels.set([...current, ...added]);
    for (const panel of added) void this.load(panel.id);
  }

  /**
   * A panel's bars (US03): says it is loading, then shows them — or why there are none, or that the request failed,
   * with a retry (a failure used to leave an empty panel saying nothing). An answer for a series the panel has left
   * meanwhile is dropped.
   */
  async load(id: string): Promise<void> {
    const panel = this.panels().find((p) => p.id === id);
    if (!panel) return;
    const { symbol, resolution } = panel;
    const land = (patch: Partial<ComparePanel>): void =>
      this.panels.update((list) =>
        list.map((p) =>
          p.id === id && p.symbol === symbol && p.resolution === resolution ? { ...p, ...patch } : p,
        ),
      );
    land({ load: { kind: 'loading' } });
    // As on the main chart: the stored grid's candles carry no session (nor the C1 facts), so they are asked for once.
    if (!this.deps.isSessionResolution(resolution)) void this.deps.feed.learnSession(symbol);
    try {
      const { bars } = await this.deps.feed.getBars(symbol, resolution, 0, Date.now(), PAGE);
      land({
        bars,
        load: bars.length
          ? { kind: 'ready' }
          : { kind: 'empty', message: this.deps.noDataMessage(symbol, resolution) },
      });
    } catch (e) {
      land({ bars: [], load: { kind: 'error', message: panelLoadError(e) } });
    }
  }

  /**
   * Scroll-back on a split panel (CC-12: panels held their first 1,500 bars and never loaded more):
   * the page before its oldest bar, prepended; an empty page is the start of its history.
   */
  async loadOlder(id: string): Promise<void> {
    const index = this.panels().findIndex((p) => p.id === id);
    const panel = this.panels()[index];
    const host = () => this.deps.hostAt(index);
    if (!panel?.bars.length || panel.historyComplete) {
      host()?.historyLoaded();
      return;
    }
    const oldest = panel.bars[0].time;
    try {
      const { bars } = await this.deps.feed.getBars(panel.symbol, panel.resolution, 0, oldest - 1, PAGE);
      const older = bars.filter((b) => b.time < oldest);
      this.panels.update((list) =>
        list.map((p) => {
          // A panel switched meanwhile has bars of its own.
          if (p.id !== id || p.symbol !== panel.symbol || p.resolution !== panel.resolution) return p;
          return older.length
            ? { ...p, bars: [...older, ...p.bars.filter((b) => b.time >= oldest)] }
            : { ...p, historyComplete: true };
        }),
      );
    } catch {
      // Unreachable: the panel keeps what it has, and the next scroll to the edge asks again.
    } finally {
      host()?.historyLoaded();
    }
  }

  onLegend(id: string, snapshot: LegendSnapshot): void {
    this.legends.update((all) => ({ ...all, [id]: snapshot }));
  }

  setSymbol(id: string, symbol: string, propagate = true): void {
    if (propagate) this.deps.linkSymbol(id, symbol.toUpperCase());
    this.panels.update((list) =>
      list.map((p) =>
        p.id === id ? { ...p, symbol: symbol.toUpperCase(), bars: [], scripts: freshRuns(p.scripts) } : p,
      ),
    );
    void this.load(id);
  }

  setResolution(id: string, resolution: string, propagate = true): void {
    if (propagate) this.deps.linkInterval(id, resolution);
    this.panels.update((list) =>
      list.map((p) =>
        p.id === id
          ? { ...p, resolution: resolution as TvResolution, bars: [], scripts: freshRuns(p.scripts) }
          : p,
      ),
    );
    void this.load(id);
  }

  /** US03: one of a panel's own settings; '' follows the main chart again. */
  setView<K extends keyof PanelView>(id: string, key: K, value: PanelView[K] | '' | undefined): void {
    this.panels.update((list) =>
      list.map((p) => (p.id === id ? { ...p, view: withView(p.view, key, value === '' ? undefined : value) } : p)),
    );
  }

  /** A live price moves the split panels that show its symbol (CC-12: they were static). */
  applyTick(tick: PriceTick): void {
    const symbol = tick?.symbol?.toUpperCase();
    const price = tickPrice(tick);
    if (!symbol || price === null) return;
    const panels = this.panels();
    if (!panels.some((p) => p.symbol.toUpperCase() === symbol && p.bars.length)) return;
    const now = tickTimeMs(tick, this.deps.now());
    this.panels.set(
      panels.map((p) => {
        if (p.symbol.toUpperCase() !== symbol || !p.bars.length) return p;
        const next = liveTick(
          p.bars,
          price,
          now,
          p.resolution,
          this.deps.calendarOf(symbol),
          this.deps.feed.gridOf(symbol),
        );
        return next ? { ...p, bars: next } : p;
      }),
    );
  }

  /** US03: a panel symbol's Pre / Regular / Post sessions, once its calendar has loaded. */
  exchangeSessionsOf(symbol: string): ExchangeSessions | null {
    const code = this.deps.calendarCodeOf(symbol);
    return code ? (this.calendars()[code] ?? null) : null;
  }

  /** Load the calendars the panels' symbols need, once per code (the page runs this in an effect). */
  loadCalendars(): void {
    const codes = new Set<string>();
    for (const p of this.panels()) {
      const code = this.deps.calendarCodeOf(p.symbol);
      if (code) codes.add(code);
    }
    untracked(() => {
      const have = this.calendars();
      for (const code of codes) {
        if (code in have) continue;
        this.calendars.update((all) => ({ ...all, [code]: null }));
        void this.deps.loadCalendar(code).then((cal) => this.calendars.update((all) => ({ ...all, [code]: cal })));
      }
    });
  }
}
