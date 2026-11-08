import { computed, effect, signal, untracked } from '@angular/core';

import type { InstrumentAssetClass } from '@core/instruments/instrument.types';
import type { Bar, CandleFeedService } from '../../datafeed/candle-feed.service';
import type { SeriesOptions } from '../../datafeed/chart-market-chips.component';
import type { FuturesRollsService } from '../../datafeed/futures-rolls.service';
import { continuousInfo, rollMarkers, type FutureRoll } from '../../datafeed/futures-series';

/** What the series adjustments read on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartSeriesAdjustmentsDeps {
  symbol: () => string;
  bars: () => Bar[];
  precision: () => number;
  /** The instrument facts' asset class (when the feed has not said it). */
  assetClass: () => InstrumentAssetClass | null | undefined;
  selectSymbol: (symbol: string) => void;
  reload: () => Promise<void>;
  feed: Pick<CandleFeedService, 'factsOf' | 'adjustmentOf' | 'setAdjustment'>;
  futuresRolls: Pick<FuturesRollsService, 'rolls'>;
}

/**
 * b9-maint — UD11: a continuous future's adjusted / raw series and its roll markers, and an equity's corporate-action
 * adjustment, moved out of ChartAnalysisPageComponent behaviour for behaviour (build it as a page field: the rolls load
 * and the adjustment follow are effects). The page aliases {@link rollMarkers} and {@link seriesOptions}; the template
 * calls the two actions as `seriesAdjustments.*`.
 */
export class ChartSeriesAdjustments {
  constructor(private readonly deps: ChartSeriesAdjustmentsDeps) {}

  /** The rolls of the continuous future on the chart: null = not one / not read; [] = none recorded. */
  private readonly rolls = signal<{ root: string; rolls: FutureRoll[] | null } | null>(null);
  private readonly rollsLoad = effect(() => {
    const info = continuousInfo(this.deps.symbol());
    untracked(() => {
      if (!info) {
        this.rolls.set(null);
        return;
      }
      if (this.rolls()?.root === info.root) return;
      this.rolls.set({ root: info.root, rolls: null });
      void this.deps.futuresRolls.rolls(info.root).then((rolls) => {
        if (continuousInfo(this.deps.symbol())?.root === info.root)
          this.rolls.set({ root: info.root, rolls });
      });
    });
  });
  readonly rollMarkers = computed(() => {
    const info = continuousInfo(this.deps.symbol());
    const held = this.rolls();
    if (!info || !held?.rolls?.length || held.root !== info.root) return [];
    return rollMarkers(held.rolls, info, this.deps.bars(), this.deps.precision());
  });
  readonly seriesOptions = computed<SeriesOptions | null>(() => {
    const symbol = this.deps.symbol();
    const info = continuousInfo(symbol);
    const held = this.rolls();
    const facts = this.deps.feed.factsOf(symbol);
    const ac = facts?.assetClass ?? this.deps.assetClass();
    const n = held?.rolls?.length ?? 0;
    const continuous = info
      ? {
          adjusted: info.adjusted,
          rollsNote:
            held?.rolls == null
              ? 'rolls not read'
              : n
                ? `${n} roll${n === 1 ? '' : 's'}`
                : 'no rolls recorded yet',
        }
      : null;
    const equity =
      ac === 'Equity' || ac === 'Etf'
        ? { asked: this.seriesAdjustment(), applied: facts?.adjustment ?? null }
        : null;
    return continuous || equity ? { continuous, equity } : null;
  });
  /** The equity adjustment asked for the chart's symbol (mirrors the feed's; a signal for the template). */
  private readonly seriesAdjustment = signal<'none' | 'splits' | 'all' | null>(null);
  private readonly seriesAdjustmentFollow = effect(() => {
    const symbol = this.deps.symbol();
    untracked(() => this.seriesAdjustment.set(this.deps.feed.adjustmentOf(symbol)));
  });
  /** Switch a continuous future between its back-adjusted and raw series (`ES1!` ⇄ `ES1!U`). */
  switchContinuousSeries(): void {
    const info = continuousInfo(this.deps.symbol());
    if (info) this.deps.selectSymbol(info.counterpart);
  }
  /** An equity's corporate-action adjustment: the feed asks chart-bars with it, and the chart reloads. */
  setSeriesAdjustment(adjustment: 'none' | 'splits' | 'all' | null): void {
    const symbol = this.deps.symbol();
    if (this.deps.feed.adjustmentOf(symbol) === adjustment) return;
    this.deps.feed.setAdjustment(symbol, adjustment);
    this.seriesAdjustment.set(adjustment);
    void this.deps.reload();
  }
}
