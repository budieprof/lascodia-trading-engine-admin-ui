import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { ScriptStatusLineComponent } from '../../scripts/script-status-line.component';
import { MeasuredBottomDirective } from '../../chart/measured-bottom.directive';
import { DecimalPipe } from '@angular/common';
import { ChartSessionStore } from './chart-session-store';
import { legendDigitsFormat } from '../../indicators/study-format';
import {
  ChartMarketChipsComponent,
  type SeriesOptions,
} from '../../datafeed/chart-market-chips.component';
import type { LegendSnapshot } from '../../chart/chart-host.component';
import type { MarketView } from '../../datafeed/market-status';
import type { SymbolChip } from '../../datafeed/symbol-chips';
import { compareTitle, type CompareSeriesSpec } from '../../compare/compare-series';
import type { ScriptAction, ScriptStatusRow } from '../../scripts/script-status';
import { formatResolution } from '../../datafeed/resolution';

/**
 * The floating legend over the main chart: symbol, interval and market status, OHLC, indicator values, compare series and overlay scripts' status lines.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. US02b: it takes what it shows as inputs and reports what the operator does as outputs (it used to
 * read a slice of the page); the symbol and interval come from the page's {@link ChartSessionStore}. Eager change
 * detection as before: it is checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-legend',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    ScriptStatusLineComponent,
    MeasuredBottomDirective,
    DecimalPipe,
    ChartMarketChipsComponent,
  ],
  templateUrl: './chart-legend.component.html',
  styleUrl: './chart-legend.component.scss',
})
export class ChartLegendComponent {
  /** The main series (symbol, timeframe). */
  protected readonly session = inject(ChartSessionStore);

  readonly marketView = input.required<MarketView>();
  readonly symbolChips = input.required<readonly SymbolChip[]>();
  readonly seriesOptions = input.required<SeriesOptions | null>();
  /** The bar under the crosshair (or the newest): OHLC, indicator values. */
  readonly legend = input.required<LegendSnapshot | null>();
  readonly legendUp = input.required<boolean>();
  readonly legendChange = input.required<string | null>();
  readonly legendVolume = input.required<string | null>();
  readonly legendVolumeUnit = input.required<string | null>();
  /** The bar's time as the page prints it (its date label, else its open on the chart's clock). */
  readonly legendTime = input.required<string>();
  readonly precision = input.required<number>();
  readonly compareSeries = input.required<readonly CompareSeriesSpec[]>();
  readonly scriptRows = input.required<readonly ScriptStatusRow[]>();

  /** The legend's measured bottom edge (the page lays the panes' status lines under it). */
  readonly bottomChange = output<number>();
  readonly switchSeries = output<void>();
  readonly adjustmentChange = output<'none' | 'splits' | 'all' | null>();
  readonly scriptAction = output<ScriptAction>();

  protected readonly resolutionLabel = formatResolution;
  protected readonly compareTitleOf = compareTitle;
  /** UA10: a study value's decimals — FX keeps `1.2-5`, other instruments their own. */
  protected readonly digitsFormat = legendDigitsFormat;
}
