import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto, MarketAnalysisRecommendationDto } from '@core/api/api.types';
import { buildRecPreviewChartOption, priceDecimals } from './rec-preview-chart';

/**
 * Renders an analysis's actionable recommendations as cards with an inline
 * candle chart visualising entry / SL / TP (+ profit/risk zones and the TP
 * shrinkage gap when applied). Loads a recent bar window once for the
 * (symbol, timeframe). Hold / geometry-less recs are skipped. Reused by the
 * conversations page and the spot-analysis modal.
 */
@Component({
  selector: 'app-analysis-recommendations',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective],
  template: `
    @if (chartableRecs().length > 0) {
      <div class="recs">
        @for (rec of chartableRecs(); track $index) {
          <div class="rec" [attr.data-action]="rec.action">
            <div class="rec-head">
              <span class="action" [attr.data-action]="rec.action">{{ rec.action }}</span>
              <span class="conf">{{ (rec.confidence * 100).toFixed(0) }}% confidence</span>
              <span class="levels">
                <span><label>Entry</label>{{ fmt(rec.entryPrice) }}</span>
                <span class="sl"><label>SL</label>{{ fmt(rec.stopLoss) }}</span>
                <span class="tp">
                  <label>TP</label>{{ fmt(rec.takeProfit) }}
                  @if (
                    rec.originalTakeProfit !== null &&
                    rec.originalTakeProfit !== undefined &&
                    rec.originalTakeProfit !== rec.takeProfit
                  ) {
                    <span class="shrink" [title]="'LLM TP ' + fmt(rec.originalTakeProfit)"
                      >shrunk</span
                    >
                  }
                </span>
              </span>
            </div>
            <div class="chart-wrap">
              @if (candlesLoading()) {
                <div class="chart-state">Loading bars…</div>
              } @else if (chartFor(rec); as opts) {
                <div echarts [options]="opts" [autoResize]="true" class="chart"></div>
              } @else {
                <div class="chart-state">No candle data to preview.</div>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .recs {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .rec {
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        background: var(--bg-primary);
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
        height: 220px;
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

  protected readonly candles = signal<CandleDto[]>([]);
  protected readonly candlesLoading = signal(false);

  /** Only Buy/Sell recs with a derived entry can be charted. */
  protected readonly chartableRecs = computed(() =>
    this.recommendations().filter((r) => r.action !== 'Hold' && r.entryPrice != null),
  );

  constructor() {
    // (Re)load bars whenever there's something chartable for a (symbol, timeframe).
    effect(() => {
      const sym = this.symbol();
      const tf = this.timeframe();
      const hasChartable = this.chartableRecs().length > 0;
      if (!sym || !tf || !hasChartable) {
        this.candles.set([]);
        return;
      }
      this.loadCandles(sym, tf);
    });
  }

  protected fmt(price: number | null): string {
    if (price == null) return '—';
    return price.toFixed(priceDecimals(this.symbol()));
  }

  protected chartFor(rec: MarketAnalysisRecommendationDto): EChartsOption | null {
    return buildRecPreviewChartOption(rec, this.candles(), this.symbol());
  }

  private loadCandles(symbol: string, timeframe: string): void {
    this.candlesLoading.set(true);
    this.marketData
      .listCandles({ currentPage: 1, itemCountPerPage: 60, filter: { symbol, timeframe } })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.candlesLoading.set(false);
        const rows = res?.data?.data ?? [];
        this.candles.set(
          [...rows].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          ),
        );
      });
  }
}
