import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { Subscription } from 'rxjs';

import type { BacktestRunDto, CandleDto } from '@core/api/api.types';
import { MarketDataService } from '@core/services/market-data.service';
import { PineChartComponent } from '@shared/pine-chart/components/pine-chart.component';
import type { PineChartData } from '@shared/pine-chart/model/chart-data';

import type { StrategyReport } from '../report/strategy-report.model';
import { describeFailure, isOk } from '../shared/api-error';
import {
  MAX_RUN_CHART_BARS,
  candleChartData,
  engineTimeframe,
  runWindow,
  storedRunChartData,
  tradesBefore,
} from './run-chart.model';

let nextRunChartUid = 0;

/**
 * The chart of a script strategy's backtest run, above its Strategy report: the run's own bars and
 * outputs when its `resultJson` carries them, else the price from the engine's candle store over
 * the run's window — with the report's trades drawn on it either way.
 */
@Component({
  selector: 'app-script-run-chart',
  standalone: true,
  imports: [PineChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.aria-labelledby]="uid + '-title'">
      <header class="head">
        <h3 class="title" [id]="uid + '-title'">Chart</h3>
        <p class="meta">{{ caption() }}</p>
      </header>
      @if (note(); as n) {
        <p class="note" role="note">{{ n }}</p>
      }
      <div class="chart-host">
        <app-pine-chart
          class="chart"
          [result]="data()"
          [symbol]="symbol()"
          [timeframe]="timeframe()"
          [emptyText]="emptyText()"
        />
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-primary);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-2) var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .meta,
      .note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .chart-host {
        height: 460px;
        min-width: 0;
      }
      .chart {
        height: 100%;
      }
    `,
  ],
})
export class ScriptRunChartComponent {
  private readonly marketData = inject(MarketDataService);

  readonly run = input.required<BacktestRunDto>();
  /** The run's Strategy report (normalised) — its trades are drawn, its meta names the window. */
  readonly report = input<StrategyReport | null>(null);

  readonly uid = `run-chart-${nextRunChartUid++}`;
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly candleData = signal<PineChartData | null>(null);
  /** Set once the candle store answered: how many bars exist in the window and how many trades predate the chart. */
  private readonly candleInfo = signal<{
    total: number;
    shown: number;
    earlierTrades: number;
  } | null>(null);
  private sub: Subscription | null = null;

  /** The run's own bars (and outputs), when `resultJson` carries them. */
  readonly stored = computed(() => storedRunChartData(this.run().resultJson, this.report()));
  readonly data = computed(() => this.stored() ?? this.candleData());
  readonly symbol = computed(() => this.report()?.meta.symbol || this.run().symbol || '');
  readonly timeframe = computed(() => this.report()?.meta.timeframe || this.run().timeframe || '');

  readonly caption = computed(() =>
    this.stored()
      ? 'The run’s own bars and script outputs, with its trades.'
      : 'Price from the candle store over the run’s window, with the run’s trades.',
  );

  readonly note = computed(() => {
    const info = this.candleInfo();
    if (this.stored() || !info) return null;
    const parts: string[] = [];
    if (info.total > info.shown) {
      parts.push(
        `Showing the newest ${info.shown.toLocaleString()} of ${info.total.toLocaleString()} bars in the window.`,
      );
    }
    if (info.earlierTrades > 0) {
      parts.push(
        `${info.earlierTrades.toLocaleString()} earlier trade${info.earlierTrades === 1 ? '' : 's'} closed before the charted bars — see the report's List of trades.`,
      );
    }
    return parts.length ? parts.join(' ') : null;
  });

  readonly emptyText = computed(() => {
    if (this.loading()) return 'Loading the run window’s candles…';
    const err = this.error();
    if (err) return `The candles could not be loaded: ${err}`;
    return `No ${this.timeframe()} candles for ${this.symbol() || 'this symbol'} are stored over the run’s window.`;
  });

  constructor() {
    effect(() => {
      const run = this.run();
      const report = this.report();
      untracked(() => {
        if (!this.stored()) this.loadCandles(run, report);
      });
    });
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  private loadCandles(run: BacktestRunDto, report: StrategyReport | null): void {
    this.sub?.unsubscribe();
    this.candleData.set(null);
    this.candleInfo.set(null);
    this.error.set(null);
    const timeframe = engineTimeframe(report?.meta.timeframe) ?? engineTimeframe(run.timeframe);
    const symbol = (report?.meta.symbol || run.symbol || '').replace(/\//g, '').toUpperCase();
    if (!timeframe || !symbol) {
      this.error.set('the run names no stored symbol / timeframe');
      return;
    }
    const window = runWindow(run, report);
    this.loading.set(true);
    this.sub = this.marketData
      .listCandles(
        {
          currentPage: 1,
          itemCountPerPage: MAX_RUN_CHART_BARS,
          filter: { symbol, timeframe, from: window.from, to: window.to },
        },
        { silent: true },
      )
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          if (!isOk(res)) {
            this.error.set(describeFailure(res, 'the engine refused'));
            return;
          }
          const rows: CandleDto[] = res.data?.data ?? [];
          const data = candleChartData(rows, report);
          this.candleData.set(data);
          const first = data?.bars[0]?.t;
          this.candleInfo.set({
            total: Math.max(res.data?.pager?.totalItemCount ?? rows.length, rows.length),
            shown: data?.bars.length ?? 0,
            earlierTrades: typeof first === 'number' ? tradesBefore(report, first) : 0,
          });
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(describeFailure(err, 'the request failed'));
        },
      });
  }
}
