import { effect, signal, untracked } from '@angular/core';

import type { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type { ChartMarker } from '../../chart/chart-host.component';
import type { Bar } from '../../datafeed/candle-feed.service';
import { timelineMarkers, timelineSummary, timelineWindow } from '../../trading/trade-timeline';

/** What the trade timeline reads on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartTradeTimelineDeps {
  /** The engine strategy script on the chart, if any — a memoised signal: the timeline reloads only when it changes. */
  strategyId: () => number | null;
  symbol: () => string;
  bars: () => Bar[];
  scriptStrategies: Pick<ScriptStrategyService, 'getParityTimeline'>;
}

/**
 * b9-maint — BX-1: the chart strategy's trade timeline (backtest, live session, paper and broker fills) as chart markers,
 * moved out of ChartAnalysisPageComponent behaviour for behaviour (build it as a page field: the load is an effect). The
 * page aliases {@link show} / {@link info} for the overlays menu and draws {@link markers}.
 */
export class ChartTradeTimeline {
  constructor(private readonly deps: ChartTradeTimelineDeps) {}

  /** The timeline is drawn (overlays menu "Trade timeline"); it needs an engine strategy script on the chart. */
  readonly show = signal(false);
  readonly markers = signal<ChartMarker[]>([]);
  /** What the drawn timeline holds, or why nothing is drawn (the overlays menu shows it). */
  readonly info = signal<string | null>(null);
  private seq = 0;
  private readonly load = effect((onCleanup) => {
    const show = this.show();
    const strategyId = this.deps.strategyId();
    const symbol = this.deps.symbol();
    const seq = ++this.seq;
    if (!show || strategyId === null) {
      this.markers.set([]);
      this.info.set(show ? 'Add an engine strategy script to the chart to draw its trades.' : null);
      return;
    }
    const oldest = untracked(() => this.deps.bars()[0]?.time ?? null);
    const sub = this.deps.scriptStrategies
      .getParityTimeline(strategyId, timelineWindow(oldest, Date.now()))
      .subscribe({
        next: (res) => {
          if (seq !== this.seq) return;
          if (!res?.status || !res.data) {
            this.markers.set([]);
            this.info.set(res?.message || 'The trade timeline could not be loaded.');
            return;
          }
          this.markers.set(timelineMarkers(res.data, symbol));
          this.info.set(
            res.data.symbol.toUpperCase() === symbol.toUpperCase()
              ? [timelineSummary(res.data), ...res.data.notes].join(' — ')
              : `The strategy trades ${res.data.symbol}, not ${symbol}.`,
          );
        },
        error: () => {
          if (seq === this.seq) this.info.set('The engine did not answer.');
        },
      });
    onCleanup(() => sub.unsubscribe());
  });
}
