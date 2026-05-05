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
import { RealtimeService } from '@core/realtime/realtime.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { throttleTime } from 'rxjs/operators';

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
            <!-- 8-card KPI strip — fleet-wide sentiment + regime overview -->
            <div class="sn-kpis">
              <div class="sn-kpi">
                <span class="kpi-label">Symbols tracked</span>
                <span class="kpi-value">{{ sentimentCards().length }}</span>
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Bullish</span>
                <span class="kpi-value good">{{ overviewStats().bullish }}</span>
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Bearish</span>
                <span class="kpi-value bad">{{ overviewStats().bearish }}</span>
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Neutral</span>
                <span class="kpi-value muted-val">{{ overviewStats().neutral }}</span>
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Avg score</span>
                <span
                  class="kpi-value"
                  [class.good]="overviewStats().avgScore > 55"
                  [class.bad]="overviewStats().avgScore < 45"
                >
                  {{ overviewStats().avgScore.toFixed(0) }}/100
                </span>
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Avg regime conf.</span>
                <span class="kpi-value"
                  >{{ (overviewStats().avgConfidence * 100).toFixed(0) }}%</span
                >
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Dominant regime</span>
                <span class="kpi-value sm">{{ overviewStats().dominantRegime }}</span>
              </div>
              <div class="sn-kpi">
                <span class="kpi-label">Regimes seen</span>
                <span class="kpi-value">{{ overviewStats().regimesSeen }}</span>
              </div>
            </div>

            <!-- 2-col chart row: sentiment compass + regime donut -->
            <div class="charts-grid">
              <app-chart-card
                title="Sentiment compass"
                subtitle="Per-symbol sentiment scores (0–100)"
                [options]="sentimentCompassOptions()"
                height="280px"
              />
              <app-chart-card
                title="Regime distribution"
                subtitle="How many symbols are in each regime right now"
                [options]="overviewRegimeDonutOptions()"
                height="280px"
              />
            </div>

            <!-- Existing symbol cards — denser layout with sparkline -->
            <div class="symbol-grid">
              @for (item of sentimentCards(); track item.symbol) {
                <div
                  class="symbol-card"
                  [class.bullish-border]="item.direction === 'Bullish'"
                  [class.bearish-border]="item.direction === 'Bearish'"
                >
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
                  <!-- 0–100 score bar -->
                  <div class="score-bar">
                    <div
                      class="score-fill"
                      [style.width.%]="item.score"
                      [class.bullish]="item.direction === 'Bullish'"
                      [class.bearish]="item.direction === 'Bearish'"
                    ></div>
                  </div>
                  <div class="confidence-row">
                    <span class="muted">Regime confidence:</span>
                    <span class="mono">{{ item.regimeConfidence * 100 | number: '1.0-1' }}%</span>
                  </div>
                </div>
              }
            </div>

            <!-- Per-regime breakdown table — fleet-wide regime composition -->
            <section class="sn-board">
              <header class="sn-board-head">
                <h3>Per-regime breakdown</h3>
                <span class="muted">Symbols grouped by current regime</span>
              </header>
              <table class="sn-board-table">
                <thead>
                  <tr>
                    <th>Regime</th>
                    <th class="num">Symbols</th>
                    <th class="num">Avg confidence</th>
                    <th class="num">Avg score</th>
                    <th>Members</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perRegimeOverview(); track row.regime) {
                    <tr>
                      <td>
                        <app-status-badge [status]="row.regime" type="default" />
                      </td>
                      <td class="num mono">{{ row.count }}</td>
                      <td class="num mono">{{ (row.avgConfidence * 100).toFixed(1) }}%</td>
                      <td
                        class="num mono"
                        [class.good]="row.avgScore > 55"
                        [class.bad]="row.avgScore < 45"
                      >
                        {{ row.avgScore.toFixed(0) }}/100
                      </td>
                      <td class="sn-pair-list">
                        @for (s of row.members; track s) {
                          <span class="sn-pill">{{ s }}</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          } @else {
            <app-empty-state
              title="No sentiment data yet"
              description="The engine has not yet recorded sentiment or regime snapshots for monitored symbols."
            />
          }
        }

        @if (activeTab() === 'regime') {
          <!-- Multi-symbol regime strip — at-a-glance view of every tracked
               symbol's current regime, with click-to-select. Lets the operator
               jump between symbols without using the dropdown for routine
               cross-symbol scans. -->
          <div class="sn-symbol-strip">
            @for (item of sentimentCards(); track item.symbol) {
              <button
                class="sn-symbol-cell"
                [class.active]="item.symbol === primarySymbol()"
                (click)="selectSymbol(item.symbol)"
              >
                <span class="ssc-symbol">{{ item.symbol }}</span>
                <app-status-badge [status]="item.regime" type="default" />
                <span class="ssc-meta">
                  <span class="ssc-conf mono">{{ (item.regimeConfidence * 100).toFixed(0) }}%</span>
                  <span
                    class="ssc-arrow"
                    [class.bullish]="item.direction === 'Bullish'"
                    [class.bearish]="item.direction === 'Bearish'"
                  >
                    {{
                      item.direction === 'Bullish' ? '↑' : item.direction === 'Bearish' ? '↓' : '↔'
                    }}
                  </span>
                </span>
              </button>
            }
          </div>

          <!-- Symbol picker — switches the primary symbol the time-series + stats reflect -->
          <div class="sn-picker">
            <label class="sn-picker-label">Primary symbol</label>
            <select class="sn-select" [value]="primarySymbol()" (change)="onSymbolChange($event)">
              @for (s of DEFAULT_SYMBOLS; track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
            <span class="sn-stability">
              <span class="muted">Stability:</span>
              <span
                class="mono"
                [class.good]="regimeStats().stabilityPct >= 70"
                [class.warn]="regimeStats().stabilityPct < 50"
              >
                {{ regimeStats().stabilityPct.toFixed(0) }}%
              </span>
              <span class="muted">in current regime</span>
            </span>
          </div>

          <!-- 6-card KPI strip — regime stats for the primary symbol -->
          <div class="sn-kpis sn-kpis-six">
            <div class="sn-kpi">
              <span class="kpi-label">Snapshots ({{ primarySymbol() }})</span>
              <span class="kpi-value">{{ regimeStats().total }}</span>
            </div>
            <div class="sn-kpi">
              <span class="kpi-label">Current regime</span>
              <span class="kpi-value sm">{{ regimeStats().currentRegime }}</span>
            </div>
            <div class="sn-kpi">
              <span class="kpi-label">Avg ADX</span>
              <span class="kpi-value">{{ regimeStats().avgAdx.toFixed(1) }}</span>
            </div>
            <div class="sn-kpi">
              <span class="kpi-label">Avg ATR</span>
              <span class="kpi-value">{{ regimeStats().avgAtr.toFixed(4) }}</span>
            </div>
            <div class="sn-kpi">
              <span class="kpi-label">Avg BB width</span>
              <span class="kpi-value">{{ regimeStats().avgBbw.toFixed(4) }}</span>
            </div>
            <div class="sn-kpi">
              <span class="kpi-label">Regime changes</span>
              <span class="kpi-value">{{ regimeStats().transitions }}</span>
            </div>
          </div>

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
              height="320px"
            />
            <app-chart-card
              title="Regime Distribution"
              [subtitle]="'Time spent in each regime on ' + primarySymbol()"
              [options]="regimeDonutOptions()"
              height="320px"
            />
          </div>

          <!-- 2-col: confidence over time + Bollinger Band width over time -->
          <div class="charts-grid">
            <app-chart-card
              title="Regime confidence over time"
              [subtitle]="'How sure the engine is about ' + primarySymbol() + '\\'s regime'"
              [options]="confidenceTimeOptions()"
              height="240px"
            />
            <app-chart-card
              title="Bollinger Band width over time"
              [subtitle]="'Volatility envelope width on ' + primarySymbol()"
              [options]="bbwTimeOptions()"
              height="240px"
            />
          </div>

          <!-- 2-col: ADX vs ATR scatter (regime-coloured) + per-regime duration table -->
          <div class="charts-grid">
            <app-chart-card
              title="ADX vs ATR scatter"
              [subtitle]="'Each dot = one snapshot · color = regime · top-right quadrant = trending high-vol'"
              [options]="adxAtrScatterOptions()"
              height="320px"
            />
            <section class="sn-board sn-board-flush">
              <header class="sn-board-head">
                <h3>Per-regime duration</h3>
                <span class="muted">Avg / max snapshots per regime episode</span>
              </header>
              @if (perRegimeDuration().length > 0) {
                <table class="sn-board-table">
                  <thead>
                    <tr>
                      <th>Regime</th>
                      <th class="num">Episodes</th>
                      <th class="num">Snapshots</th>
                      <th class="num">Avg dur</th>
                      <th class="num">Max dur</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of perRegimeDuration(); track row.regime) {
                      <tr>
                        <td>
                          <app-status-badge [status]="row.regime" type="default" />
                        </td>
                        <td class="num mono">{{ row.episodes }}</td>
                        <td class="num mono">{{ row.totalSnapshots }}</td>
                        <td class="num mono">{{ row.avgDuration.toFixed(1) }}</td>
                        <td class="num mono">{{ row.maxDuration }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="muted" style="padding: var(--space-4)">
                  Not enough snapshots to derive durations.
                </p>
              }
            </section>
          </div>

          <!-- Recent regime transitions table -->
          <section class="sn-board">
            <header class="sn-board-head">
              <h3>Regime transitions</h3>
              <span class="muted">Last 10 changes on {{ primarySymbol() }}</span>
            </header>
            @if (regimeTransitions().length > 0) {
              <table class="sn-board-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th class="num">ADX</th>
                    <th class="num">ATR</th>
                    <th class="num">Confidence</th>
                    <th>Detected</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of regimeTransitions(); track $index) {
                    <tr>
                      <td>
                        <app-status-badge [status]="t.from" type="default" />
                      </td>
                      <td>
                        <app-status-badge [status]="t.to" type="default" />
                      </td>
                      <td class="num mono">{{ t.adx.toFixed(1) }}</td>
                      <td class="num mono">{{ t.atr.toFixed(4) }}</td>
                      <td class="num mono">{{ (t.confidence * 100).toFixed(0) }}%</td>
                      <td class="mono">{{ t.detectedAt.slice(0, 16).replace('T', ' ') }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted" style="padding: var(--space-4)">
                No regime transitions in the recent snapshot window.
              </p>
            }
          </section>
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

      /* Sentiment density additions */
      .sn-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      .sn-kpis.sn-kpis-six {
        grid-template-columns: repeat(6, 1fr);
      }
      @media (max-width: 1400px) {
        .sn-kpis,
        .sn-kpis.sn-kpis-six {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .sn-kpis,
        .sn-kpis.sn-kpis-six {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .sn-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .sn-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sn-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .sn-kpi .kpi-value.good {
        color: var(--profit);
      }
      .sn-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .sn-kpi .kpi-value.muted-val {
        color: var(--text-tertiary);
      }
      .sn-kpi .kpi-value.sm {
        font-size: var(--text-base);
      }

      /* Score bar inside symbol cards */
      .score-bar {
        margin-top: var(--space-2);
        height: 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }
      .score-fill {
        height: 100%;
        background: var(--text-tertiary);
        transition: width 0.2s ease;
      }
      .score-fill.bullish {
        background: var(--profit);
      }
      .score-fill.bearish {
        background: var(--loss);
      }
      .symbol-card.bullish-border {
        border-left: 3px solid var(--profit);
      }
      .symbol-card.bearish-border {
        border-left: 3px solid var(--loss);
      }

      /* Symbol picker for the regime tab */
      .sn-picker {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .sn-picker-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sn-select {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      /* Sentiment board (per-regime + transitions tables) */
      .sn-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-3);
      }
      .sn-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .sn-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .sn-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .sn-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .sn-board-table th,
      .sn-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .sn-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .sn-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sn-board-table th.num,
      .sn-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .sn-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .sn-board-table .good {
        color: var(--profit);
      }
      .sn-board-table .bad {
        color: var(--loss);
      }
      .sn-pair-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .sn-pill {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      /* Multi-symbol strip on the regime tab */
      .sn-symbol-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      .sn-symbol-cell {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        cursor: pointer;
        font-family: inherit;
        text-align: left;
        transition: all 0.15s ease;
      }
      .sn-symbol-cell:hover {
        border-color: var(--text-tertiary);
        transform: translateY(-1px);
      }
      .sn-symbol-cell.active {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.15);
      }
      .ssc-symbol {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .ssc-meta {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-left: auto;
      }
      .ssc-conf {
        font-size: 10.5px;
        color: var(--text-tertiary);
      }
      .ssc-arrow {
        font-size: 13px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .ssc-arrow.bullish {
        color: var(--profit);
      }
      .ssc-arrow.bearish {
        color: var(--loss);
      }

      /* Stability indicator inside the picker bar */
      .sn-stability {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-xs);
      }
      .sn-stability .good {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      .sn-stability .warn {
        color: #c93400;
        font-weight: var(--font-semibold);
      }

      /* Allow boards to live inside .charts-grid without doubled padding */
      .sn-board.sn-board-flush {
        margin-bottom: 0;
      }
    `,
  ],
})
export class SentimentPageComponent {
  private readonly sentimentService = inject(SentimentService);
  private readonly regimeService = inject(MarketRegimeService);
  private readonly currencyPairsService = inject(CurrencyPairsService);
  private readonly realtime = inject(RealtimeService);

  constructor() {
    // Push-refresh sentiment cards when new snapshots land. 3s throttle so a
    // burst of ingestion on startup doesn't thrash the per-symbol forkJoin.
    this.realtime
      .on('sentimentSnapshotCreated')
      .pipe(throttleTime(3_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.cardResource.refresh());
  }

  readonly DEFAULT_TIMEFRAME = DEFAULT_TIMEFRAME;
  readonly DEFAULT_SYMBOLS = DEFAULT_SYMBOLS;

  readonly tabs: TabItem[] = [
    { label: 'Market Overview', value: 'overview' },
    { label: 'Regime Analysis', value: 'regime' },
  ];
  readonly activeTab = signal('overview');
  readonly primarySymbol = signal(DEFAULT_SYMBOLS[0]);

  // Live sentiment + regime per symbol (poll every 60s, plus SignalR push).
  // The engine now fires `sentimentSnapshotCreated` when a snapshot lands;
  // we throttle to 3 s to dedup bursts and still refresh in near-real-time.
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

  // ── Overview-tab roll-ups ───────────────────────────────────────────
  readonly overviewStats = computed(() => {
    const cards = this.sentimentCards();
    if (cards.length === 0) {
      return {
        bullish: 0,
        bearish: 0,
        neutral: 0,
        avgScore: 0,
        avgConfidence: 0,
        dominantRegime: '—',
        regimesSeen: 0,
      };
    }
    let bullish = 0;
    let bearish = 0;
    let neutral = 0;
    let scoreSum = 0;
    let confSum = 0;
    const regimeCounts: Record<string, number> = {};
    for (const c of cards) {
      if (c.direction === 'Bullish') bullish++;
      else if (c.direction === 'Bearish') bearish++;
      else neutral++;
      scoreSum += c.score;
      confSum += c.regimeConfidence;
      const r = String(c.regime);
      regimeCounts[r] = (regimeCounts[r] ?? 0) + 1;
    }
    const dominant = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      bullish,
      bearish,
      neutral,
      avgScore: scoreSum / cards.length,
      avgConfidence: confSum / cards.length,
      dominantRegime: dominant ? dominant[0] : '—',
      regimesSeen: Object.keys(regimeCounts).length,
    };
  });

  readonly perRegimeOverview = computed(() => {
    type Row = {
      regime: string;
      count: number;
      avgConfidence: number;
      avgScore: number;
      members: string[];
    };
    const groups: Record<string, { confSum: number; scoreSum: number; members: string[] }> = {};
    for (const c of this.sentimentCards()) {
      const r = String(c.regime);
      if (!groups[r]) groups[r] = { confSum: 0, scoreSum: 0, members: [] };
      groups[r].confSum += c.regimeConfidence;
      groups[r].scoreSum += c.score;
      groups[r].members.push(c.symbol);
    }
    const out: Row[] = [];
    for (const [regime, g] of Object.entries(groups)) {
      out.push({
        regime,
        count: g.members.length,
        avgConfidence: g.confSum / g.members.length,
        avgScore: g.scoreSum / g.members.length,
        members: g.members,
      });
    }
    return out.sort((a, b) => b.count - a.count);
  });

  readonly sentimentCompassOptions = computed<EChartsOption>(() => {
    const cards = this.sentimentCards();
    if (cards.length === 0) return emptyChart('No sentiment yet');
    const sorted = [...cards].sort((a, b) => b.score - a.score);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 30, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((c) => c.symbol).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: sorted
            .map((c) => ({
              value: c.score,
              itemStyle: {
                color:
                  c.direction === 'Bullish'
                    ? '#34C759'
                    : c.direction === 'Bearish'
                      ? '#FF3B30'
                      : '#8E8E93',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 16,
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#8E8E93', type: 'dashed' },
            data: [{ xAxis: 50 }],
          },
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly overviewRegimeDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const c of this.sentimentCards()) {
      counts[String(c.regime)] = (counts[String(c.regime)] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return emptyChart('No regime data yet');
    const palette: Record<string, string> = {
      Trending: '#0071E3',
      Ranging: '#34C759',
      HighVolatility: '#FF9500',
      LowVolatility: '#5AC8FA',
      Crisis: '#FF3B30',
      Breakout: '#AF52DE',
      Unknown: '#8E8E93',
    };
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: Object.entries(counts).map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: palette[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  // ── Regime-tab roll-ups ─────────────────────────────────────────────
  readonly regimeStats = computed(() => {
    const snaps = this.regimeResource.value() ?? [];
    if (snaps.length === 0) {
      return {
        total: 0,
        currentRegime: '—',
        avgAdx: 0,
        avgAtr: 0,
        avgBbw: 0,
        transitions: 0,
        stabilityPct: 0,
      };
    }
    const sorted = [...snaps].sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );
    let transitions = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].regime !== sorted[i].regime) transitions++;
    }
    const currentRegime = String(sorted[0].regime);
    const inCurrent = sorted.filter((s) => String(s.regime) === currentRegime).length;
    return {
      total: sorted.length,
      currentRegime,
      avgAdx: sorted.reduce((s, x) => s + x.adx, 0) / sorted.length,
      avgAtr: sorted.reduce((s, x) => s + x.atr, 0) / sorted.length,
      avgBbw: sorted.reduce((s, x) => s + x.bollingerBandWidth, 0) / sorted.length,
      transitions,
      // % of recent snapshots that share the current regime — high stability
      // means the current regime call is well-supported by history.
      stabilityPct: (inCurrent / sorted.length) * 100,
    };
  });

  readonly adxAtrScatterOptions = computed<EChartsOption>(() => {
    const snaps = this.regimeResource.value() ?? [];
    if (snaps.length === 0) return emptyChart('No snapshots yet');
    const palette: Record<string, string> = {
      Trending: '#0071E3',
      Ranging: '#34C759',
      HighVolatility: '#FF9500',
      LowVolatility: '#5AC8FA',
      Crisis: '#FF3B30',
      Breakout: '#AF52DE',
    };
    // Group by regime so each gets its own series + legend entry.
    const byRegime: Record<string, [number, number][]> = {};
    for (const s of snaps) {
      const k = String(s.regime);
      if (!byRegime[k]) byRegime[k] = [];
      byRegime[k].push([+s.adx.toFixed(2), +s.atr.toFixed(5)]);
    }
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) =>
          `${p.seriesName}<br/>ADX: ${p.value[0]}<br/>ATR: ${p.value[1].toFixed(5)}`,
      },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 10, right: 30, bottom: 50, left: 60 },
      xAxis: {
        type: 'value',
        name: 'ADX',
        nameLocation: 'middle',
        nameGap: 28,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'value',
        name: 'ATR',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: Object.entries(byRegime).map(([name, data]) => ({
        name,
        type: 'scatter',
        symbolSize: 9,
        data,
        itemStyle: { color: palette[name] ?? '#8E8E93', opacity: 0.75 },
      })),
    };
  });

  readonly perRegimeDuration = computed(() => {
    const snaps = [...(this.regimeResource.value() ?? [])].sort(
      (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
    );
    type Episode = { regime: string; length: number };
    const episodes: Episode[] = [];
    if (snaps.length === 0) return [];
    let current: Episode = { regime: String(snaps[0].regime), length: 1 };
    for (let i = 1; i < snaps.length; i++) {
      const r = String(snaps[i].regime);
      if (r === current.regime) {
        current.length++;
      } else {
        episodes.push(current);
        current = { regime: r, length: 1 };
      }
    }
    episodes.push(current);

    const groups: Record<
      string,
      { episodes: number; totalSnapshots: number; maxDuration: number }
    > = {};
    for (const e of episodes) {
      if (!groups[e.regime]) groups[e.regime] = { episodes: 0, totalSnapshots: 0, maxDuration: 0 };
      const g = groups[e.regime];
      g.episodes++;
      g.totalSnapshots += e.length;
      if (e.length > g.maxDuration) g.maxDuration = e.length;
    }
    return Object.entries(groups)
      .map(([regime, g]) => ({
        regime,
        ...g,
        avgDuration: g.totalSnapshots / g.episodes,
      }))
      .sort((a, b) => b.totalSnapshots - a.totalSnapshots);
  });

  readonly confidenceTimeOptions = computed<EChartsOption>(() => {
    const snaps = [...(this.regimeResource.value() ?? [])].sort(
      (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
    );
    if (snaps.length === 0) return emptyChart('No data yet');
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: snaps.map((s) =>
          new Date(s.detectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        ),
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        axisLabel: { formatter: (v: number) => (v * 100).toFixed(0) + '%', fontSize: 10 },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: snaps.map((s) => +s.confidence.toFixed(3)),
          lineStyle: { color: '#5AC8FA', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(90,200,250,0.25)' },
                { offset: 1, color: 'rgba(90,200,250,0.02)' },
              ],
            },
          },
        },
      ],
    };
  });

  readonly bbwTimeOptions = computed<EChartsOption>(() => {
    const snaps = [...(this.regimeResource.value() ?? [])].sort(
      (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
    );
    if (snaps.length === 0) return emptyChart('No data yet');
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 60 },
      xAxis: {
        type: 'category',
        data: snaps.map((s) =>
          new Date(s.detectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        ),
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: snaps.map((s) => +s.bollingerBandWidth.toFixed(5)),
          lineStyle: { color: '#AF52DE', width: 2 },
        },
      ],
    };
  });

  // Last 10 regime transitions on the primary symbol — newest first.
  readonly regimeTransitions = computed(() => {
    const snaps = [...(this.regimeResource.value() ?? [])].sort(
      (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
    );
    const transitions: {
      from: string;
      to: string;
      adx: number;
      atr: number;
      confidence: number;
      detectedAt: string;
    }[] = [];
    for (let i = 1; i < snaps.length; i++) {
      if (snaps[i - 1].regime !== snaps[i].regime) {
        transitions.push({
          from: String(snaps[i - 1].regime),
          to: String(snaps[i].regime),
          adx: snaps[i].adx,
          atr: snaps[i].atr,
          confidence: snaps[i].confidence,
          detectedAt: snaps[i].detectedAt,
        });
      }
    }
    return transitions.reverse().slice(0, 10);
  });

  onSymbolChange(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.primarySymbol.set(v);
    this.regimeResource.refresh();
  }

  selectSymbol(symbol: string): void {
    this.primarySymbol.set(symbol);
    this.regimeResource.refresh();
  }

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
