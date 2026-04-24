import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import type { EChartsOption } from 'echarts';

import { SentimentService } from '@core/services/sentiment.service';
import { MarketRegimeService } from '@core/services/market-regime.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import type {
  MarketRegime,
  MarketRegimeSnapshotDto,
  SentimentSnapshotDto,
  Timeframe,
} from '@core/api/api.types';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { createPolledResource } from '@core/polling/polled-resource';

interface SymbolSentiment {
  symbol: string;
  regime: MarketRegime | 'Unknown';
  regimeConfidence: number;
  direction: 'Bullish' | 'Bearish' | 'Neutral';
  score: number;
}

const DEFAULT_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const DEFAULT_TIMEFRAME: Timeframe = 'H1';

@Component({
  selector: 'app-sentiment-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChartCardComponent,
    PageHeaderComponent,
    StatusBadgeComponent,
    TabsComponent,
    EmptyStateComponent,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Sentiment &amp; Regime"
        subtitle="Live market regime detection and sentiment readings"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          @if (sentimentCards().length > 0) {
            <div class="symbol-grid">
              @for (item of sentimentCards(); track item.symbol) {
                <div class="symbol-card">
                  <div class="symbol-header">
                    <span class="symbol-name">{{ item.symbol }}</span>
                    <app-status-badge [status]="item.regime" type="default" />
                  </div>
                  <div class="sentiment-row">
                    <span
                      class="direction-arrow"
                      [class.bullish]="item.direction === 'Bullish'"
                      [class.bearish]="item.direction === 'Bearish'"
                    >
                      {{
                        item.direction === 'Bullish'
                          ? '↑'
                          : item.direction === 'Bearish'
                            ? '↓'
                            : '↔'
                      }}
                    </span>
                    <span class="direction-label">{{ item.direction }}</span>
                    <span class="score">{{ item.score }}/100</span>
                  </div>
                  <div class="confidence-row">
                    <span class="muted">Regime confidence:</span>
                    <span class="mono">{{ item.regimeConfidence * 100 | number: '1.0-1' }}%</span>
                  </div>
                </div>
              }
            </div>
          } @else {
            <app-empty-state
              title="No sentiment data yet"
              description="The engine has not yet recorded sentiment or regime snapshots for monitored symbols."
            />
          }
        }

        @if (activeTab() === 'regime') {
          <div class="charts-grid">
            <app-chart-card
              title="ADX + Volatility Time Series"
              [subtitle]="
                'Trend strength (ADX) and volatility (ATR) on ' +
                primarySymbol() +
                ' ' +
                DEFAULT_TIMEFRAME
              "
              [options]="adxVolOptions()"
              height="360px"
            />
            <app-chart-card
              title="Regime Distribution"
              [subtitle]="'Time spent in each regime across ' + DEFAULT_SYMBOLS.length + ' symbols'"
              [options]="regimeDonutOptions()"
              height="360px"
            />
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .symbol-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      .symbol-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .symbol-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--space-3);
      }
      .symbol-name {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sentiment-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .direction-arrow {
        font-size: 20px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .direction-arrow.bullish {
        color: var(--profit);
      }
      .direction-arrow.bearish {
        color: var(--loss);
      }
      .direction-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .score {
        margin-left: auto;
        font-size: var(--text-sm);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .confidence-row {
        margin-top: var(--space-2);
        font-size: var(--text-xs);
        display: flex;
        justify-content: space-between;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .mono {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1024px) {
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class SentimentPageComponent {
  private readonly sentimentService = inject(SentimentService);
  private readonly regimeService = inject(MarketRegimeService);
  private readonly currencyPairsService = inject(CurrencyPairsService);

  readonly DEFAULT_TIMEFRAME = DEFAULT_TIMEFRAME;
  readonly DEFAULT_SYMBOLS = DEFAULT_SYMBOLS;

  readonly tabs: TabItem[] = [
    { label: 'Market Overview', value: 'overview' },
    { label: 'Regime Analysis', value: 'regime' },
  ];
  readonly activeTab = signal('overview');
  readonly primarySymbol = signal(DEFAULT_SYMBOLS[0]);

  // Live sentiment + regime per symbol (poll every 60s).
  private readonly cardResource = createPolledResource(
    () =>
      forkJoin(
        DEFAULT_SYMBOLS.map((symbol) =>
          forkJoin({
            sentiment: this.sentimentService.getLatest(symbol).pipe(
              map((r) => r.data),
              catchError(() => of(null as SentimentSnapshotDto | null)),
            ),
            regime: this.regimeService.getLatest(symbol, DEFAULT_TIMEFRAME).pipe(
              map((r) => r.data),
              catchError(() => of(null as MarketRegimeSnapshotDto | null)),
            ),
          }).pipe(map(({ sentiment, regime }) => buildCard(symbol, sentiment, regime))),
        ),
      ),
    { intervalMs: 60_000 },
  );

  readonly sentimentCards = computed(() => this.cardResource.value() ?? []);

  // Recent regime snapshots for the primary symbol (poll every 60s).
  private readonly regimeResource = createPolledResource(
    () =>
      this.regimeService
        .list({
          currentPage: 1,
          itemCountPerPage: 60,
          filter: { symbol: this.primarySymbol(), timeframe: DEFAULT_TIMEFRAME },
        })
        .pipe(
          map((r) => r.data?.data ?? []),
          catchError(() => of([] as MarketRegimeSnapshotDto[])),
        ),
    { intervalMs: 60_000 },
  );

  readonly adxVolOptions = computed<EChartsOption>(() => {
    const snaps = [...(this.regimeResource.value() ?? [])].sort(
      (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
    );
    if (snaps.length === 0) return emptyChart('No regime snapshots yet');
    const labels = snaps.map((s) =>
      new Date(s.detectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    );
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['ADX', 'ATR'], bottom: 0 },
      grid: { left: 50, right: 50, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
      yAxis: [
        { type: 'value', name: 'ADX', position: 'left' },
        { type: 'value', name: 'ATR', position: 'right', splitLine: { show: false } },
      ],
      series: [
        {
          name: 'ADX',
          type: 'line',
          yAxisIndex: 0,
          smooth: true,
          data: snaps.map((s) => s.adx),
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
        {
          name: 'ATR',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          data: snaps.map((s) => s.atr),
          lineStyle: { color: '#FF9500', width: 2 },
          itemStyle: { color: '#FF9500' },
        },
      ],
    };
  });

  readonly regimeDonutOptions = computed<EChartsOption>(() => {
    // Aggregate across the primary symbol's recent snapshots.
    const snaps = this.regimeResource.value() ?? [];
    if (snaps.length === 0) return emptyChart('No regime snapshots yet');
    const counts = new Map<string, number>();
    for (const s of snaps) {
      counts.set(s.regime, (counts.get(s.regime) ?? 0) + 1);
    }
    const palette: Record<string, string> = {
      Trending: '#0071E3',
      Ranging: '#34C759',
      HighVolatility: '#FF9500',
      LowVolatility: '#5AC8FA',
      Crisis: '#FF3B30',
      Breakout: '#AF52DE',
    };
    const data = Array.from(counts.entries()).map(([name, value]) => ({
      name,
      value,
      itemStyle: { color: palette[name] ?? '#8E8E93' },
    }));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      legend: { bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 12 },
          data,
        },
      ],
    };
  });
}

function buildCard(
  symbol: string,
  sentiment: SentimentSnapshotDto | null,
  regime: MarketRegimeSnapshotDto | null,
): SymbolSentiment {
  const score = sentiment?.sentimentScore ?? 0; // typically -1..1
  const score100 = Math.round(((score + 1) / 2) * 100); // map to 0..100
  const direction: 'Bullish' | 'Bearish' | 'Neutral' =
    score > 0.1 ? 'Bullish' : score < -0.1 ? 'Bearish' : 'Neutral';
  return {
    symbol,
    regime: regime?.regime ?? 'Unknown',
    regimeConfidence: regime?.confidence ?? 0,
    direction,
    score: Number.isFinite(score100) ? score100 : 50,
  };
}

function emptyChart(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'center',
      textStyle: { color: '#8E8E93', fontSize: 14, fontWeight: 'normal' as const },
    },
  };
}
