import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import { catchError, of } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto, MarketAnalysisRecommendationDto } from '@core/api/api.types';
import { buildRecPreviewChartOption, priceDecimals } from './rec-preview-chart';

/**
 * Renders an analysis's actionable recommendations as cards with an inline
 * candle chart visualising entry / SL / TP (+ profit/risk zones and the TP
 * shrinkage gap when applied). The operator can switch the chart timeframe and
 * bar count (up to 1000). Hold / geometry-less recs are skipped. Reused by the
 * conversations page and the spot-analysis modal.
 */
@Component({
  selector: 'app-analysis-recommendations',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective, FormsModule],
  template: `
    @if (chartableRecs().length > 0) {
      <div class="rec-controls">
        <label>
          <span>TF</span>
          <select [ngModel]="selectedTf()" (ngModelChange)="selectedTf.set($event)">
            @for (tf of timeframes; track tf) {
              <option [ngValue]="tf">{{ tf }}</option>
            }
          </select>
        </label>
        <label>
          <span>Bars</span>
          <select [ngModel]="barCount()" (ngModelChange)="barCount.set($event)">
            @for (n of barCounts; track n) {
              <option [ngValue]="n">{{ n }}</option>
            }
          </select>
        </label>
        @if (candlesLoading()) {
          <span class="loading">loading…</span>
        }
      </div>

      @for (item of charts(); track item.key) {
        <div class="rec" [attr.data-action]="item.rec.action">
          <div class="rec-head">
            <span class="action" [attr.data-action]="item.rec.action">{{ item.rec.action }}</span>
            <span class="conf">{{ (item.rec.confidence * 100).toFixed(0) }}% confidence</span>
            <span class="levels">
              <span><label>Entry</label>{{ fmt(item.rec.entryPrice) }}</span>
              <span class="sl"><label>SL</label>{{ fmt(item.rec.stopLoss) }}</span>
              <span class="tp">
                <label>TP</label>{{ fmt(item.rec.takeProfit) }}
                @if (
                  item.rec.originalTakeProfit !== null &&
                  item.rec.originalTakeProfit !== undefined &&
                  item.rec.originalTakeProfit !== item.rec.takeProfit
                ) {
                  <span class="shrink" [title]="'LLM TP ' + fmt(item.rec.originalTakeProfit)"
                    >shrunk</span
                  >
                }
              </span>
            </span>
          </div>
          <div class="chart-wrap">
            @if (item.option) {
              <div echarts [options]="item.option" [autoResize]="true" class="chart"></div>
            } @else {
              <div class="chart-state">
                {{ candlesLoading() ? 'Loading bars…' : 'No candle data to preview.' }}
              </div>
            }
          </div>
        </div>
      }
    }
  `,
  styles: [
    `
      .rec-controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-2);
      }
      .rec-controls label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .rec-controls select {
        font: inherit;
        font-size: var(--text-xs);
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .rec-controls .loading {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .rec {
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        background: var(--bg-primary);
        margin-bottom: var(--space-3);
      }
      .rec[data-action='Buy'] {
        border-left-color: #1d8a3e;
      }
      .rec[data-action='Sell'] {
        border-left-color: #c93631;
      }
      .rec-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
        margin-bottom: var(--space-2);
      }
      .action {
        font-weight: var(--font-bold);
        font-size: var(--text-sm);
      }
      .action[data-action='Buy'] {
        color: #1d8a3e;
      }
      .action[data-action='Sell'] {
        color: #c93631;
      }
      .conf {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .levels {
        display: inline-flex;
        gap: var(--space-4);
        margin-left: auto;
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
      }
      .levels label {
        display: block;
        font-size: 10px;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }
      .levels .sl {
        color: #c93631;
      }
      .levels .tp {
        color: #1d8a3e;
      }
      .shrink {
        margin-left: 5px;
        padding: 1px 5px;
        font-size: 9px;
        background: rgba(255, 149, 0, 0.16);
        color: #b45309;
        border-radius: var(--radius-full);
        cursor: help;
      }
      .chart-wrap {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .chart {
        width: 100%;
        height: 300px;
      }
      .chart-state {
        padding: var(--space-3);
        font-size: var(--text-xs);
        text-align: center;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class AnalysisRecommendationsComponent {
  private readonly marketData = inject(MarketDataService);

  readonly symbol = input.required<string>();
  readonly timeframe = input.required<string>();
  readonly recommendations = input<MarketAnalysisRecommendationDto[]>([]);

  protected readonly timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
  protected readonly barCounts = [60, 120, 250, 500, 1000];

  /** Chart timeframe — defaults to (and resets with) the analysis timeframe,
   *  but the operator can switch it to view the same levels on another TF. */
  protected readonly selectedTf = linkedSignal(() => this.timeframe());
  protected readonly barCount = signal(250);

  protected readonly candles = signal<CandleDto[]>([]);
  protected readonly candlesLoading = signal(false);
  /** Bumped on every candle (re)load so chart keys change → ECharts re-inits
   *  fresh (its markLine merge otherwise caches a stale y-position). */
  private readonly candleVersion = signal(0);

  protected readonly chartableRecs = computed(() =>
    this.recommendations().filter((r) => r.action !== 'Hold' && r.entryPrice != null),
  );

  /** Stable per-(candles,recs) chart options, keyed by candle version so a
   *  reload recreates the ECharts element instead of merge-patching it. */
  protected readonly charts = computed(() => {
    const cs = this.candles();
    const sym = this.symbol();
    const ver = this.candleVersion();
    return this.chartableRecs().map((rec, i) => ({
      rec,
      key: `${i}#${ver}`,
      option: buildRecPreviewChartOption(rec, cs, sym),
    }));
  });

  constructor() {
    // (Re)load bars whenever symbol / timeframe / bar-count / chartability change.
    effect(() => {
      const sym = this.symbol();
      const tf = this.selectedTf();
      const count = this.barCount();
      const hasChartable = this.chartableRecs().length > 0;
      if (!sym || !tf || !hasChartable) {
        this.candles.set([]);
        return;
      }
      this.loadCandles(sym, tf, count);
    });
  }

  protected fmt(price: number | null): string {
    if (price == null) return '—';
    return price.toFixed(priceDecimals(this.symbol()));
  }

  private loadCandles(symbol: string, timeframe: string, count: number): void {
    this.candlesLoading.set(true);
    this.marketData
      .listCandles({ currentPage: 1, itemCountPerPage: count, filter: { symbol, timeframe } })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.candlesLoading.set(false);
        const rows = res?.data?.data ?? [];
        this.candles.set(
          [...rows].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          ),
        );
        this.candleVersion.update((v) => v + 1);
      });
  }
}
