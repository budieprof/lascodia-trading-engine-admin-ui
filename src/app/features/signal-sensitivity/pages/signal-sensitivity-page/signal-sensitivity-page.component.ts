import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import { SignalSensitivityService } from '@core/services/signal-sensitivity.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { MarketDataService } from '@core/services/market-data.service';
import { ThemeService } from '@core/theme/theme.service';
import {
  AnalyzeSignalSensitivityResultDto,
  AnalyzeSignalSensitivityEquityPointDto,
  AnalyzeSignalSensitivitySignalDto,
  CandleDto,
  RiskProfileDto,
  SignalSensitivityHeatmapCellDto,
  Timeframe,
} from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

const SOURCES = ['SpotAnalysis', 'Strategy', 'Manual', 'SyntheticAnalyser'] as const;
const WINDOW_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
];

/**
 * Signal Sensitivity Analysis page. Lets the operator replay historic
 * TradeSignal rows under hypothetical (TP, SL) multipliers and see how
 * win-rate / P&L move. The TP-sweep chart shows the win-rate response
 * curve across a span of TP shrink/widen values; the per-signal table
 * shows each replay's outcome for drill-in.
 *
 * Backend at POST /trade-signal/sensitivity-analysis.
 */
@Component({
  selector: 'app-signal-sensitivity-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    PercentPipe,
    FormsModule,
    NgxEchartsDirective,
    PageHeaderComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Signal Sensitivity Analysis"
        subtitle="Replay historic signals against actual subsequent candles under hypothetical TP/SL multipliers"
      />

      <form class="filter-card" (ngSubmit)="run()">
        <div class="filter-row">
          <label class="field">
            <span>Window</span>
            <select [(ngModel)]="windowDays" name="windowDays">
              @for (w of windows; track w.days) {
                <option [ngValue]="w.days">{{ w.label }}</option>
              }
            </select>
          </label>
          <label class="field field--wide">
            <span>Symbols <small>(empty = all)</small></span>
            <div class="symbol-multiselect">
              <!-- Selected-chip tray -->
              @if (selectedSymbols().length > 0) {
                <div class="symbol-chips">
                  @for (s of selectedSymbols(); track s) {
                    <span class="symbol-chip">
                      {{ s }}
                      <button
                        type="button"
                        class="symbol-chip-remove"
                        (click)="removeSymbol(s)"
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </span>
                  }
                </div>
              }
              <!-- Native datalist autocomplete: free-text + browser-rendered
                   suggestion list of every loaded CurrencyPair symbol.
                   Enter or comma commits the typed value. -->
              <input
                type="text"
                list="symbol-options"
                [placeholder]="
                  selectedSymbols().length === 0
                    ? 'pick or type — Enter / comma to add'
                    : 'add another…'
                "
                [(ngModel)]="symbolInput"
                name="symbolInput"
                (keydown.enter)="$event.preventDefault(); commitSymbolInput()"
                (keydown.comma)="$event.preventDefault(); commitSymbolInput()"
                (change)="commitSymbolInput()"
              />
              <datalist id="symbol-options">
                @for (sym of availableSymbols(); track sym) {
                  <option [value]="sym"></option>
                }
              </datalist>
            </div>
          </label>
          <label class="field">
            <span>Direction</span>
            <div class="source-chips">
              @for (d of directionsAvail; track d) {
                <label class="chip-checkbox">
                  <input
                    type="checkbox"
                    [checked]="selectedDirections().includes(d)"
                    (change)="toggleDirection(d)"
                  />
                  {{ d }}
                </label>
              }
            </div>
          </label>
          <label class="field field--wide">
            <span>Sources</span>
            <div class="source-chips">
              @for (s of sourcesAvail; track s) {
                <label class="chip-checkbox">
                  <input
                    type="checkbox"
                    [checked]="selectedSources().includes(s)"
                    (change)="toggleSource(s)"
                  />
                  {{ s }}
                </label>
              }
            </div>
          </label>
        </div>
        <div class="filter-row">
          <label class="field">
            <span>TP Multiplier</span>
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="3"
              [(ngModel)]="tpMultiplier"
              name="tpMultiplier"
            />
          </label>
          <label class="field">
            <span>SL Multiplier</span>
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="3"
              [(ngModel)]="slMultiplier"
              name="slMultiplier"
            />
          </label>
          <label class="field field--wide">
            <span>TP Sweep (comma-separated)</span>
            <input
              type="text"
              [(ngModel)]="sweepInput"
              name="sweepInput"
              placeholder="0.5, 0.75, 1.0, 1.25, 1.5"
            />
          </label>
          <label class="field">
            <span>Expiry override (hours)</span>
            <input
              type="number"
              step="0.5"
              min="0"
              [(ngModel)]="expiryOverrideHours"
              name="expiryOverrideHours"
              placeholder="use signal's own"
            />
          </label>
        </div>
        <div class="filter-row">
          <label class="field field--wide">
            <span>Risk Profile (optional — enables equity curve)</span>
            <select [(ngModel)]="riskProfileId" name="riskProfileId">
              <option [ngValue]="null">— Use signal SuggestedLotSize —</option>
              @for (rp of riskProfiles(); track rp.id) {
                <option [ngValue]="rp.id">
                  {{ rp.name || '#' + rp.id }} ({{ rp.maxRiskPerTradePct | number: '1.1-2' }}%
                  risk/trade)
                </option>
              }
            </select>
          </label>
          <label class="field">
            <span>Starting Balance</span>
            <input
              type="number"
              step="100"
              min="100"
              [(ngModel)]="startingBalance"
              name="startingBalance"
              [disabled]="riskProfileId() === null"
            />
          </label>
          <button type="submit" class="run-btn" [disabled]="loading()">
            {{ loading() ? 'Analysing…' : 'Analyse' }}
          </button>
        </div>
      </form>

      @if (errorMessage()) {
        <div class="status error">{{ errorMessage() }}</div>
      }

      @if (result(); as r) {
        <section class="window-meta">
          {{ r.fromUtc | date: 'short' }} → {{ r.toUtc | date: 'short' }} ·
          {{ r.signalCount | number }} signals
          @if (r.symbol) {
            · {{ r.symbol }}
          }
          @if (r.sources.length) {
            · sources: {{ r.sources.join(', ') }}
          }
          · TP×{{ r.tpMultiplier | number: '1.2-2' }} · SL×{{ r.slMultiplier | number: '1.2-2' }}
        </section>

        <!-- ── KPI strip for the operator's chosen point ─────────────────── -->
        <section class="kpi-grid">
          <div class="kpi">
            <div class="kpi-label">Win rate</div>
            <div
              class="kpi-value"
              [class.profit]="r.aggregate.winRatePct >= 50"
              [class.loss]="r.aggregate.winRatePct < 50"
            >
              {{ r.aggregate.winRatePct | number: '1.1-1' }}%
            </div>
            <div class="kpi-sub">{{ r.aggregate.winCount }} W / {{ r.aggregate.lossCount }} L</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Realized P&amp;L</div>
            <div
              class="kpi-value"
              [class.profit]="r.aggregate.realizedPnL > 0"
              [class.loss]="r.aggregate.realizedPnL < 0"
            >
              {{ r.aggregate.realizedPnL | currency: 'USD' }}
            </div>
            <div class="kpi-sub">
              from {{ r.aggregate.winCount + r.aggregate.lossCount }} closed
            </div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Unrealized P&amp;L</div>
            <div
              class="kpi-value"
              [class.profit]="r.aggregate.unrealizedPnL > 0"
              [class.loss]="r.aggregate.unrealizedPnL < 0"
            >
              {{ r.aggregate.unrealizedPnL | currency: 'USD' }}
            </div>
            <div class="kpi-sub">from {{ r.aggregate.expiredCount }} expired · mark-to-market</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Profit factor</div>
            <div class="kpi-value">{{ r.aggregate.profitFactor | number: '1.2-2' }}</div>
            <div class="kpi-sub">
              avg W {{ r.aggregate.avgWinPnL | currency: 'USD' }} / avg L
              {{ r.aggregate.avgLossPnL | currency: 'USD' }}
            </div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Outcome mix</div>
            <div class="kpi-value">{{ r.aggregate.walkable | number }}</div>
            <div class="kpi-sub">
              {{ r.aggregate.hitTpCount }} TP / {{ r.aggregate.hitSlCount }} SL /
              {{ r.aggregate.expiredCount }} exp
              @if (r.aggregate.entryNotReachedCount > 0) {
                · {{ r.aggregate.entryNotReachedCount }} unfilled
              }
              @if (r.aggregate.noCandlesCount > 0) {
                · {{ r.aggregate.noCandlesCount }} no-data
              }
            </div>
          </div>
        </section>

        <!-- ── Equity-curve KPIs + sparkline (when RiskProfile mode is on) ── -->
        @if (r.riskProfileId !== null && r.riskProfileId !== undefined) {
          <section class="equity-card">
            <header class="equity-header">
              <h2>
                Equity curve
                <small>
                  · {{ r.riskProfileName }} · starting {{ r.startingBalance | currency: 'USD' }} ·
                  realized only
                </small>
              </h2>
              <div class="equity-kpis">
                <div class="equity-kpi">
                  <span class="equity-kpi-label">Final balance</span>
                  <span
                    class="equity-kpi-value"
                    [class.profit]="(r.finalBalance ?? 0) > (r.startingBalance ?? 0)"
                    [class.loss]="(r.finalBalance ?? 0) < (r.startingBalance ?? 0)"
                  >
                    {{ r.finalBalance | currency: 'USD' }}
                  </span>
                </div>
                <div class="equity-kpi">
                  <span class="equity-kpi-label">Floating equity</span>
                  <span
                    class="equity-kpi-value"
                    [class.profit]="
                      (r.finalBalance ?? 0) + r.aggregate.unrealizedPnL > (r.startingBalance ?? 0)
                    "
                    [class.loss]="
                      (r.finalBalance ?? 0) + r.aggregate.unrealizedPnL < (r.startingBalance ?? 0)
                    "
                  >
                    {{ (r.finalBalance ?? 0) + r.aggregate.unrealizedPnL | currency: 'USD' }}
                  </span>
                  <small class="equity-kpi-hint">
                    incl. {{ r.aggregate.unrealizedPnL | currency: 'USD' }} unrealized
                  </small>
                </div>
                <div class="equity-kpi">
                  <span class="equity-kpi-label">Return</span>
                  <span
                    class="equity-kpi-value"
                    [class.profit]="(r.returnPct ?? 0) > 0"
                    [class.loss]="(r.returnPct ?? 0) < 0"
                  >
                    {{ r.returnPct | number: '1.2-2' }}%
                  </span>
                </div>
                <div class="equity-kpi">
                  <span class="equity-kpi-label">Max drawdown</span>
                  <span class="equity-kpi-value loss">
                    {{ r.maxDrawdown | currency: 'USD' }}
                    <small>({{ r.maxDrawdownPct | number: '1.2-2' }}%)</small>
                  </span>
                </div>
              </div>
            </header>
            <svg
              class="equity-spark"
              [attr.viewBox]="equityViewBox()"
              preserveAspectRatio="none"
              aria-label="Equity curve"
            >
              <polyline class="equity-baseline" [attr.points]="equityBaselinePoints()" />
              <polyline class="equity-line" [attr.points]="equityLinePoints()" />
            </svg>
          </section>
        }

        <!-- ── Cohort breakdowns (symbol / direction / source) ──────────── -->
        <section class="breakdown-grid">
          <article class="breakdown-card">
            <header class="breakdown-header">
              <h2>
                By symbol <small>({{ r.breakdownsBySymbol.length }} pairs)</small>
              </h2>
            </header>
            <div class="table-scroll">
              <table class="breakdown-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="num">N</th>
                    <th class="num">Win%</th>
                    <th class="num">TP</th>
                    <th class="num">SL</th>
                    <th class="num">Exp</th>
                    <th class="num">Realized</th>
                    <th class="num">Unrealized</th>
                    <th class="num">PF</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.breakdownsBySymbol; track row.key) {
                    <tr>
                      <td class="key">{{ row.key }}</td>
                      <td class="num">{{ row.aggregate.walkable | number }}</td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.winRatePct >= 50"
                        [class.loss]="row.aggregate.winRatePct < 50"
                      >
                        {{ row.aggregate.winRatePct | number: '1.0-1' }}
                      </td>
                      <td class="num">{{ row.aggregate.hitTpCount | number }}</td>
                      <td class="num">{{ row.aggregate.hitSlCount | number }}</td>
                      <td class="num">{{ row.aggregate.expiredCount | number }}</td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.realizedPnL > 0"
                        [class.loss]="row.aggregate.realizedPnL < 0"
                      >
                        {{ row.aggregate.realizedPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                      </td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.unrealizedPnL > 0"
                        [class.loss]="row.aggregate.unrealizedPnL < 0"
                      >
                        {{ row.aggregate.unrealizedPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                      </td>
                      <td class="num">{{ row.aggregate.profitFactor | number: '1.2-2' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </article>

          <article class="breakdown-card">
            <header class="breakdown-header">
              <h2>By direction</h2>
            </header>
            <div class="table-scroll">
              <table class="breakdown-table">
                <thead>
                  <tr>
                    <th>Side</th>
                    <th class="num">N</th>
                    <th class="num">Win%</th>
                    <th class="num">Realized</th>
                    <th class="num">Unrealized</th>
                    <th class="num">PF</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.breakdownsByDirection; track row.key) {
                    <tr>
                      <td class="key">{{ row.key }}</td>
                      <td class="num">{{ row.aggregate.walkable | number }}</td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.winRatePct >= 50"
                        [class.loss]="row.aggregate.winRatePct < 50"
                      >
                        {{ row.aggregate.winRatePct | number: '1.0-1' }}
                      </td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.realizedPnL > 0"
                        [class.loss]="row.aggregate.realizedPnL < 0"
                      >
                        {{ row.aggregate.realizedPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                      </td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.unrealizedPnL > 0"
                        [class.loss]="row.aggregate.unrealizedPnL < 0"
                      >
                        {{ row.aggregate.unrealizedPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                      </td>
                      <td class="num">{{ row.aggregate.profitFactor | number: '1.2-2' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </article>

          <article class="breakdown-card">
            <header class="breakdown-header">
              <h2>By source</h2>
            </header>
            <div class="table-scroll">
              <table class="breakdown-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th class="num">N</th>
                    <th class="num">Win%</th>
                    <th class="num">Realized</th>
                    <th class="num">Unrealized</th>
                    <th class="num">PF</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.breakdownsBySource; track row.key) {
                    <tr>
                      <td class="key">{{ row.key }}</td>
                      <td class="num">{{ row.aggregate.walkable | number }}</td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.winRatePct >= 50"
                        [class.loss]="row.aggregate.winRatePct < 50"
                      >
                        {{ row.aggregate.winRatePct | number: '1.0-1' }}
                      </td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.realizedPnL > 0"
                        [class.loss]="row.aggregate.realizedPnL < 0"
                      >
                        {{ row.aggregate.realizedPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                      </td>
                      <td
                        class="num"
                        [class.profit]="row.aggregate.unrealizedPnL > 0"
                        [class.loss]="row.aggregate.unrealizedPnL < 0"
                      >
                        {{ row.aggregate.unrealizedPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                      </td>
                      <td class="num">{{ row.aggregate.profitFactor | number: '1.2-2' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </article>
        </section>

        <!-- ── 2D TP × SL heatmap ───────────────────────────────────────── -->
        <section class="heatmap-card">
          <header class="heatmap-header">
            <h2>
              TP × SL sweep <small>· cell colour = {{ heatmapMetricLabel() }}</small>
            </h2>
            <div class="heatmap-controls">
              <label class="heatmap-control">
                <span>Colour by</span>
                <select [ngModel]="heatmapMetric()" (ngModelChange)="heatmapMetric.set($event)">
                  <option value="realizedPnL">Realized P&amp;L</option>
                  <option value="sumPnL">Total P&amp;L</option>
                  <option value="winRatePct">Win rate %</option>
                  <option value="profitFactor">Profit factor</option>
                  <option value="expectancy">Expectancy / signal</option>
                </select>
              </label>
            </div>
          </header>
          <div
            echarts
            [options]="heatmapOptions()"
            [theme]="echartsTheme()"
            [autoResize]="true"
            class="heatmap-chart"
          ></div>
          <p class="heatmap-hint">
            Operator-selected cell is highlighted. Cell tooltip shows full KPI set; click a cell to
            see the heatmap diverge around it (lighter = neutral, deeper colour = better/worse than
            the active cell).
          </p>
        </section>

        <!-- ── Distributions + streaks + risk metrics ─────────────────────── -->
        <section class="analytics-grid">
          <article class="analytics-card">
            <header class="analytics-header">
              <h2>Hold-time distribution</h2>
              <small>Time from signal fire → exit (or expiry)</small>
            </header>
            <table class="dist-table">
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>Bar</th>
                  <th class="num">Count</th>
                  <th class="num">Win%</th>
                  <th class="num">TP</th>
                  <th class="num">SL</th>
                  <th class="num">Exp</th>
                  <th class="num">Avg P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                @for (b of r.holdTimeBuckets; track b.label) {
                  <tr>
                    <td>{{ b.label }}</td>
                    <td class="bar-cell">
                      <div
                        class="dist-bar"
                        [style.width.%]="distPct(b.count, maxHoldCount())"
                      ></div>
                    </td>
                    <td class="num">{{ b.count | number }}</td>
                    <td
                      class="num"
                      [class.profit]="b.winRatePct >= 50"
                      [class.loss]="b.winRatePct < 50 && b.hitTpCount + b.hitSlCount > 0"
                    >
                      {{ b.winRatePct | number: '1.0-1' }}
                    </td>
                    <td class="num">{{ b.hitTpCount | number }}</td>
                    <td class="num">{{ b.hitSlCount | number }}</td>
                    <td class="num">{{ b.expiredCount | number }}</td>
                    <td class="num" [class.profit]="b.avgPnL > 0" [class.loss]="b.avgPnL < 0">
                      {{ b.avgPnL | currency: 'USD' : 'symbol' : '1.0-0' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </article>

          <article class="analytics-card">
            <header class="analytics-header">
              <h2>R-multiple distribution</h2>
              <small>P&amp;L normalised by SL-risk per signal</small>
            </header>
            <table class="dist-table">
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>Bar</th>
                  <th class="num">Count</th>
                  <th class="num">% of total</th>
                </tr>
              </thead>
              <tbody>
                @for (b of r.rMultipleBuckets; track b.label) {
                  <tr>
                    <td>{{ b.label }}</td>
                    <td class="bar-cell">
                      <div
                        class="dist-bar"
                        [class.dist-bar--loss]="(b.maxR ?? 0) <= 0"
                        [class.dist-bar--profit]="(b.minR ?? 0) >= 0"
                        [style.width.%]="distPct(b.count, maxRCount())"
                      ></div>
                    </td>
                    <td class="num">{{ b.count | number }}</td>
                    <td class="num">{{ rBucketPct(b.count) | number: '1.0-1' }}%</td>
                  </tr>
                }
              </tbody>
            </table>
          </article>

          <article class="analytics-card">
            <header class="analytics-header">
              <h2>Streaks &amp; risk metrics</h2>
              <small>Resolved signals only · chronological</small>
            </header>
            <div class="metric-grid">
              <div class="metric">
                <span class="metric-label">Max win streak</span>
                <span class="metric-value profit">{{ r.streaks.maxWinStreak }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Max loss streak</span>
                <span class="metric-value loss">{{ r.streaks.maxLossStreak }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Current streak</span>
                <span
                  class="metric-value"
                  [class.profit]="r.streaks.currentStreakType === 'Win'"
                  [class.loss]="r.streaks.currentStreakType === 'Loss'"
                >
                  {{
                    r.streaks.currentStreakType === 'None'
                      ? '—'
                      : r.streaks.currentStreakLength + ' ' + r.streaks.currentStreakType
                  }}
                </span>
              </div>
              <div class="metric">
                <span class="metric-label">Expectancy / signal</span>
                <span
                  class="metric-value"
                  [class.profit]="r.riskMetrics.expectancy > 0"
                  [class.loss]="r.riskMetrics.expectancy < 0"
                >
                  {{ r.riskMetrics.expectancy | currency: 'USD' }}
                </span>
              </div>
              <div class="metric">
                <span class="metric-label">Payoff ratio</span>
                <span class="metric-value">{{ r.riskMetrics.payoffRatio | number: '1.2-2' }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Sharpe proxy</span>
                <span
                  class="metric-value"
                  [class.profit]="r.riskMetrics.sharpeProxy > 0"
                  [class.loss]="r.riskMetrics.sharpeProxy < 0"
                >
                  {{ r.riskMetrics.sharpeProxy | number: '1.3-3' }}
                </span>
              </div>
            </div>
            <p class="metric-hint">
              Expectancy = (winRate × avgWin) − (lossRate × |avgLoss|). Payoff = avgWin / |avgLoss|.
              Sharpe proxy is mean / stddev of realized per-signal P&amp;L; requires RiskProfile
              mode to be meaningful.
            </p>
          </article>
        </section>

        <!-- ── Per-signal table ────────────────────────────────────────────── -->
        <section class="signals-card">
          <h2>
            Per-signal outcomes <small>({{ r.signals.length }} of {{ r.signalCount }})</small>
          </h2>
          <div class="table-scroll">
            <table class="signal-table">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Source</th>
                  <th>Dir</th>
                  <th class="num">Entry</th>
                  <th class="num">SL</th>
                  <th class="num">TP</th>
                  <th>Outcome</th>
                  <th class="num">Exit</th>
                  <th class="num">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                @for (s of r.signals; track s.signalId) {
                  <tr
                    class="signal-row"
                    [class.row--win]="s.outcome === 'HitTP'"
                    [class.row--loss]="s.outcome === 'HitSL'"
                    (click)="openSignalChart(s)"
                    [attr.title]="'Click to view chart'"
                  >
                    <td>{{ s.signalId }}</td>
                    <td>{{ s.generatedAt | date: 'short' }}</td>
                    <td>{{ s.symbol }}</td>
                    <td>{{ s.source }}</td>
                    <td>{{ s.direction }}</td>
                    <td class="num">{{ s.entryPrice | number: '1.5-5' }}</td>
                    <td class="num">{{ s.originalSL | number: '1.5-5' }}</td>
                    <td class="num">{{ s.originalTP | number: '1.5-5' }}</td>
                    <td>
                      <span
                        class="outcome-chip"
                        [class.chip--tp]="s.outcome === 'HitTP'"
                        [class.chip--sl]="s.outcome === 'HitSL'"
                        [class.chip--exp]="s.outcome === 'Expired'"
                        [class.chip--unfilled]="s.outcome === 'EntryNotReached'"
                      >
                        {{ s.outcome }}
                      </span>
                    </td>
                    <td class="num">
                      {{ s.exitPrice !== null ? (s.exitPrice | number: '1.5-5') : '—' }}
                    </td>
                    <td
                      class="num"
                      [class.profit]="s.scenarioPnL > 0"
                      [class.loss]="s.scenarioPnL < 0"
                    >
                      {{ s.scenarioPnL | currency: 'USD' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else if (loading()) {
        <div class="status">Analysing…</div>
      } @else {
        <div class="status hint">
          Pick filters + multipliers, then press <b>Analyse</b>. The query replays each matching
          signal against actual candles between its <code>GeneratedAt</code> and
          <code>ExpiresAt</code>, applying your TP/SL multipliers to compute the outcome.
        </div>
      }

      <!-- ── Signal-chart modal ─────────────────────────────────────────── -->
      @if (selectedSignal(); as s) {
        <div class="modal-scrim" (click)="closeSignalChart()" role="dialog" aria-modal="true">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <header class="modal-header">
              <div>
                <h2>
                  Signal #{{ s.signalId }} · {{ s.symbol }} · {{ s.direction }}
                  <span
                    class="outcome-chip"
                    [class.chip--tp]="s.outcome === 'HitTP'"
                    [class.chip--sl]="s.outcome === 'HitSL'"
                    [class.chip--exp]="s.outcome === 'Expired'"
                  >
                    {{ s.outcome }}
                  </span>
                </h2>
                <p class="modal-sub">
                  Triggered {{ s.triggeredAt | date: 'medium' }} · Generated
                  {{ s.generatedAt | date: 'medium' }} → expires {{ s.expiresAt | date: 'short' }} ·
                  {{ s.source }} · scenario P&amp;L
                  <strong [class.profit]="s.scenarioPnL > 0" [class.loss]="s.scenarioPnL < 0">
                    {{ s.scenarioPnL | currency: 'USD' }}
                  </strong>
                </p>
              </div>
              <div class="modal-header-right">
                <div class="tf-toolbar" role="group" aria-label="Timeframe">
                  @for (tf of chartTimeframes; track tf) {
                    <button
                      type="button"
                      class="tf-btn"
                      [class.tf-btn--active]="selectedTimeframe() === tf"
                      (click)="setChartTimeframe(tf)"
                    >
                      {{ tf }}
                    </button>
                  }
                </div>
                <button
                  type="button"
                  class="modal-close"
                  (click)="closeSignalChart()"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
            </header>
            <div class="modal-body">
              @if (chartLoading()) {
                <div class="status">Loading candles…</div>
              } @else if (chartError()) {
                <div class="status error">{{ chartError() }}</div>
              } @else if (chartOptions(); as opts) {
                <div
                  echarts
                  [options]="opts"
                  [theme]="echartsTheme()"
                  [autoResize]="true"
                  class="chart-instance"
                ></div>
                <div class="chart-legend">
                  <span class="legend-item">
                    <span class="dot dot--entry"></span>Entry
                    {{ s.entryPrice | number: '1.5-5' }}
                    @if (s.fillAt) {
                      <small>· filled {{ s.fillAt | date: 'short' }}</small>
                    }
                  </span>
                  <span class="legend-item"
                    ><span class="dot dot--tp"></span>Original TP
                    {{ s.originalTP | number: '1.5-5' }}</span
                  >
                  <span class="legend-item"
                    ><span class="dot dot--sl"></span>Original SL
                    {{ s.originalSL | number: '1.5-5' }}</span
                  >
                  @if (result()!.tpMultiplier !== 1 || result()!.slMultiplier !== 1) {
                    <span class="legend-item"
                      ><span class="dot dot--tp-scenario"></span>Scenario TP ×
                      {{ result()!.tpMultiplier }}</span
                    >
                    <span class="legend-item"
                      ><span class="dot dot--sl-scenario"></span>Scenario SL ×
                      {{ result()!.slMultiplier }}</span
                    >
                  }
                  @if (s.exitPrice !== null) {
                    <span class="legend-item">
                      <span class="dot dot--exit"></span>Exit {{ s.exitPrice | number: '1.5-5' }} @
                      {{ s.exitAt | date: 'short' }}
                    </span>
                  }
                </div>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .filter-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .filter-row {
        display: flex;
        gap: 1.25rem;
        flex-wrap: wrap;
        align-items: flex-end;
      }
      .field {
        display: inline-flex;
        flex-direction: column;
        gap: 6px;
        font-size: 0.85rem;
      }
      .field > span {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .field--wide {
        flex: 1 1 280px;
      }
      .field input,
      .field select {
        padding: 0.45rem 0.6rem;
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 4px;
        min-width: 100px;
        font-size: 0.9rem;
      }
      .field input:focus,
      .field select:focus {
        outline: none;
        border-color: var(--accent);
        background: var(--bg-primary);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
      }
      .source-chips {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .chip-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.35rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: 9999px;
        font-size: 0.8rem;
        cursor: pointer;
        background: var(--bg-primary);
        color: var(--text-primary);
        user-select: none;
      }
      .chip-checkbox:hover {
        background: var(--bg-tertiary);
      }
      .symbol-multiselect {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        width: 100%;
      }
      .symbol-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .symbol-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.25rem 0.4rem 0.25rem 0.65rem;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 600;
        background: rgba(0, 113, 227, 0.15);
        color: var(--accent);
        font-variant-numeric: tabular-nums;
      }
      .symbol-chip-remove {
        background: transparent;
        border: none;
        color: inherit;
        font-size: 1rem;
        line-height: 1;
        padding: 0 0.25rem;
        cursor: pointer;
        border-radius: 9999px;
        opacity: 0.7;
      }
      .symbol-chip-remove:hover {
        opacity: 1;
        background: rgba(0, 113, 227, 0.25);
      }
      .run-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 0.5rem 1.25rem;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
      }
      .run-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .status {
        padding: 0.75rem;
        opacity: 0.8;
        font-size: 0.9rem;
      }
      .status.error {
        color: #f66;
      }
      .status.hint code {
        background: rgba(255, 255, 255, 0.06);
        padding: 0.05rem 0.3rem;
        border-radius: 3px;
      }
      .window-meta {
        font-size: 0.85rem;
        opacity: 0.7;
      }

      .kpi-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .kpi-label {
        font-size: 0.75rem;
        opacity: 0.7;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kpi-value {
        font-size: 1.6rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .kpi-sub {
        font-size: 0.75rem;
        opacity: 0.7;
      }
      /* .profit / .loss colours defined below (theme-aware). */

      .sweep-card,
      .signals-card,
      .equity-card,
      .breakdown-card,
      .heatmap-card,
      .analytics-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.75rem 1rem;
      }
      .analytics-grid {
        display: grid;
        grid-template-columns: 1.2fr 1fr 1fr;
        gap: 1rem;
      }
      @media (max-width: 1100px) {
        .analytics-grid {
          grid-template-columns: 1fr;
        }
      }
      .analytics-header h2 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .analytics-header small {
        opacity: 0.6;
        font-size: 0.75rem;
        display: block;
        margin-top: 2px;
      }
      .dist-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.82rem;
        margin-top: 0.5rem;
      }
      .dist-table th,
      .dist-table td {
        text-align: left;
        padding: 0.3rem 0.5rem;
        border-bottom: 1px solid var(--border);
      }
      .dist-table th.num,
      .dist-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .dist-table th {
        font-weight: 600;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        opacity: 0.65;
      }
      .bar-cell {
        width: 35%;
        min-width: 80px;
      }
      .dist-bar {
        height: 0.65rem;
        background: var(--accent);
        border-radius: 2px;
        opacity: 0.6;
      }
      .dist-bar--loss {
        background: #c4290a;
      }
      .dist-bar--profit {
        background: #1f8a3d;
      }
      .metric-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem 1rem;
        margin-top: 0.5rem;
      }
      .metric {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .metric-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .metric-value {
        font-size: 1.05rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .metric-hint {
        font-size: 0.7rem;
        opacity: 0.6;
        margin: 0.75rem 0 0;
      }
      .heatmap-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 0.5rem;
      }
      .heatmap-header h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .heatmap-header h2 small {
        font-weight: 400;
        opacity: 0.6;
      }
      .heatmap-controls {
        display: flex;
        gap: 0.75rem;
      }
      .heatmap-control {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .heatmap-control span {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .heatmap-control select {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 0.3rem 0.5rem;
        font-size: 0.85rem;
      }
      .heatmap-chart {
        width: 100%;
        height: 380px;
      }
      .heatmap-hint {
        font-size: 0.78rem;
        opacity: 0.65;
        margin: 0.5rem 0 0;
      }
      .breakdown-grid {
        display: grid;
        grid-template-columns: 1.6fr 1fr 1fr;
        gap: 1rem;
      }
      @media (max-width: 1100px) {
        .breakdown-grid {
          grid-template-columns: 1fr;
        }
      }
      .breakdown-header h2 {
        margin: 0 0 0.5rem;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .breakdown-header h2 small {
        font-weight: 400;
        opacity: 0.6;
        margin-left: 0.35rem;
      }
      .breakdown-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.82rem;
      }
      .breakdown-table th,
      .breakdown-table td {
        text-align: left;
        padding: 0.3rem 0.55rem;
        border-bottom: 1px solid var(--border);
      }
      .breakdown-table th.num,
      .breakdown-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .breakdown-table th {
        font-weight: 600;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        opacity: 0.65;
      }
      .breakdown-table td.key {
        font-weight: 600;
      }
      .breakdown-table tbody tr:last-child td {
        border-bottom: none;
      }
      .equity-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 0.75rem;
      }
      .equity-header h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .equity-header h2 small {
        font-weight: 400;
        opacity: 0.7;
        margin-left: 0.5rem;
      }
      .equity-kpis {
        display: flex;
        gap: 1.5rem;
        flex-wrap: wrap;
      }
      .equity-kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .equity-kpi-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .equity-kpi-value {
        font-size: 1.1rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .equity-kpi-value small {
        font-size: 0.75rem;
        opacity: 0.7;
        font-weight: 400;
        margin-left: 0.25rem;
      }
      .equity-kpi-hint {
        font-size: 0.7rem;
        opacity: 0.65;
        margin-top: 2px;
      }
      .equity-spark {
        width: 100%;
        height: 160px;
        display: block;
      }
      .equity-line {
        fill: none;
        stroke: var(--accent);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .equity-baseline {
        fill: none;
        stroke: var(--text-tertiary);
        stroke-width: 1;
        stroke-dasharray: 4 4;
        vector-effect: non-scaling-stroke;
        opacity: 0.5;
      }
      .sweep-card h2,
      .signals-card h2 {
        margin: 0 0 0.5rem 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .sweep-card small,
      .signals-card small {
        font-weight: 400;
        opacity: 0.7;
        margin-left: 0.5rem;
      }
      .sweep-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .sweep-table th,
      .sweep-table td {
        padding: 0.35rem 0.5rem;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .sweep-table th.num,
      .sweep-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .sweep-table tr.row--active td {
        background: rgba(0, 113, 227, 0.1);
        font-weight: 600;
      }
      .curve {
        width: 200px;
      }
      .curve-bar {
        height: 12px;
        border-radius: 6px;
      }
      .curve-bar--profit {
        background: rgba(79, 209, 197, 0.6);
      }
      .curve-bar--loss {
        background: rgba(255, 122, 122, 0.6);
      }

      .table-scroll {
        overflow-x: auto;
        max-height: 60vh;
      }
      .signal-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .signal-table th,
      .signal-table td {
        padding: 0.3rem 0.5rem;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .signal-table th.num,
      .signal-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .signal-table tr.row--win td {
        background: rgba(48, 209, 88, 0.08);
      }
      .signal-table tr.row--loss td {
        background: rgba(255, 69, 58, 0.08);
      }

      .outcome-chip {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.15rem 0.5rem;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-weight: 600;
      }
      .chip--tp {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .chip--sl {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .chip--exp {
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }
      .chip--unfilled {
        background: rgba(0, 113, 227, 0.15);
        color: #0071e3;
      }
      .profit {
        color: #1f8a3d;
      }
      .loss {
        color: #c4290a;
      }
      :host-context([data-theme='dark']) .chip--tp {
        color: #5dd47e;
      }
      :host-context([data-theme='dark']) .chip--sl {
        color: #ff8278;
      }
      :host-context([data-theme='dark']) .profit {
        color: #5dd47e;
      }
      :host-context([data-theme='dark']) .loss {
        color: #ff8278;
      }

      /* ── Signal row click affordance + chart modal ───────────────────── */
      .signal-table tr.signal-row {
        cursor: pointer;
        transition: background 0.1s ease;
      }
      .signal-table tr.signal-row:hover td {
        background: var(--bg-tertiary);
      }

      .modal-scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 2rem;
      }
      .modal-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: min(1100px, 100%);
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      }
      .modal-header {
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
      }
      .modal-header h2 {
        margin: 0;
        font-size: 1.05rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .modal-sub {
        margin: 0.25rem 0 0;
        font-size: 0.85rem;
        opacity: 0.7;
      }
      .modal-header-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .tf-toolbar {
        display: inline-flex;
        gap: 2px;
        background: var(--bg-tertiary);
        border-radius: 6px;
        padding: 2px;
      }
      .tf-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        font-size: 0.78rem;
        font-weight: 600;
        padding: 0.3rem 0.55rem;
        border-radius: 4px;
        cursor: pointer;
        transition:
          background 0.12s,
          color 0.12s;
      }
      .tf-btn:hover {
        color: var(--text-primary);
      }
      .tf-btn--active {
        background: var(--accent);
        color: #ffffff;
      }
      .tf-btn--active:hover {
        color: #ffffff;
      }
      .modal-close {
        background: transparent;
        border: none;
        color: inherit;
        font-size: 1.5rem;
        cursor: pointer;
        line-height: 1;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
      }
      .modal-close:hover {
        background: var(--bg-tertiary);
      }
      .modal-body {
        flex: 1;
        padding: 1rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-height: 480px;
      }
      .chart-instance {
        flex: 1;
        min-height: 420px;
      }
      .chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        font-size: 0.8rem;
        opacity: 0.85;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      .dot {
        display: inline-block;
        width: 14px;
        height: 3px;
        border-radius: 1px;
      }
      .dot--entry {
        background: #6e6e73;
      }
      .dot--tp {
        background: #1f8a3d;
      }
      .dot--sl {
        background: #c4290a;
      }
      .dot--tp-scenario {
        background: #1f8a3d;
        opacity: 0.55;
      }
      .dot--sl-scenario {
        background: #c4290a;
        opacity: 0.55;
      }
      .dot--exit {
        background: var(--accent);
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
    `,
  ],
})
export class SignalSensitivityPageComponent implements OnInit {
  private readonly svc = inject(SignalSensitivityService);
  private readonly riskProfilesSvc = inject(RiskProfilesService);
  private readonly marketDataSvc = inject(MarketDataService);
  private readonly currencyPairsSvc = inject(CurrencyPairsService);
  private readonly themeSvc = inject(ThemeService);

  readonly sourcesAvail = SOURCES;
  readonly directionsAvail = ['Buy', 'Sell'] as const;
  readonly windows = WINDOW_OPTIONS;

  // ── Signal-chart modal state ───────────────────────────────────────────
  readonly selectedSignal = signal<AnalyzeSignalSensitivitySignalDto | null>(null);
  readonly chartLoading = signal(false);
  readonly chartError = signal<string | null>(null);
  readonly chartCandles = signal<CandleDto[]>([]);
  readonly echartsTheme = computed(() => (this.themeSvc.theme() === 'dark' ? 'dark' : ''));

  // Timeframe the operator picks from the chart toolbar. Default H1 because
  // SpotAnalysis writes at H1 — candles are guaranteed to exist. M5/M15 give
  // finer granularity when investigating short-lived signals; H4/D1 widen
  // the macro context for long-horizon signals.
  readonly chartTimeframes: Timeframe[] = ['M5', 'M15', 'H1', 'H4', 'D1'];
  readonly selectedTimeframe = signal<Timeframe>('H1');

  readonly windowDays = signal<number>(30);
  /** Symbols the operator has committed to filter on. Empty = all symbols. */
  readonly selectedSymbols = signal<string[]>([]);
  /** Live free-text input — committed to selectedSymbols on Enter / comma / blur. */
  readonly symbolInput = signal<string>('');
  /** Full list of tradable pair symbols loaded once at page init for the datalist. */
  readonly availableSymbols = signal<string[]>([]);
  readonly selectedSources = signal<string[]>(['SpotAnalysis']);
  readonly selectedDirections = signal<string[]>([]);
  readonly tpMultiplier = signal<number>(1.0);
  readonly slMultiplier = signal<number>(1.0);
  readonly sweepInput = signal<string>('0.5, 0.75, 1.0, 1.25, 1.5');
  /** Hours override for signal validity. null = use signal's persisted ExpiresAt. */
  readonly expiryOverrideHours = signal<number | null>(null);
  readonly riskProfileId = signal<number | null>(null);
  readonly startingBalance = signal<number>(10000);

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly result = signal<AnalyzeSignalSensitivityResultDto | null>(null);
  readonly riskProfiles = signal<RiskProfileDto[]>([]);

  /** Metric the operator wants the heatmap to colour by. */
  readonly heatmapMetric = signal<
    'realizedPnL' | 'sumPnL' | 'winRatePct' | 'profitFactor' | 'expectancy'
  >('realizedPnL');

  /** SVG viewBox spanning the equity curve. Computed so the sparkline renders
   *  with consistent y-padding regardless of absolute balance magnitudes. */
  readonly equityViewBox = computed(() => {
    const pts = this.result()?.equityCurve ?? [];
    if (pts.length < 2) return '0 0 100 100';
    const xs = pts.map((_, i) => i);
    const ys = pts.map((p) => p.balance);
    const minY = Math.min(...ys, this.result()?.startingBalance ?? 0);
    const maxY = Math.max(...ys, this.result()?.startingBalance ?? 0);
    const pad = Math.max((maxY - minY) * 0.1, 1);
    const w = Math.max(xs.length - 1, 1);
    return `0 ${minY - pad} ${w} ${maxY - minY + 2 * pad}`;
  });

  /** Points string for the equity polyline. SVG y-axis is flipped — we render
   *  high balance UP, so we invert with maxY + (range - currentY). */
  readonly equityLinePoints = computed(() => {
    const r = this.result();
    if (!r || r.equityCurve.length < 2) return '';
    const ys = r.equityCurve.map((p) => p.balance);
    const minY = Math.min(...ys, r.startingBalance ?? 0);
    const maxY = Math.max(...ys, r.startingBalance ?? 0);
    const pad = Math.max((maxY - minY) * 0.1, 1);
    const flip = (y: number) => maxY + pad - (y - (minY - pad));
    return r.equityCurve.map((p, i) => `${i},${flip(p.balance)}`).join(' ');
  });

  /** Max bucket count across hold-time buckets — for percent-width sizing of bars. */
  readonly maxHoldCount = computed(() => {
    const buckets = this.result()?.holdTimeBuckets ?? [];
    return Math.max(1, ...buckets.map((b) => b.count));
  });

  /** Max bucket count across R-multiple buckets. */
  readonly maxRCount = computed(() => {
    const buckets = this.result()?.rMultipleBuckets ?? [];
    return Math.max(1, ...buckets.map((b) => b.count));
  });

  /** Percent of the widest bar — used for inline distribution bars. */
  distPct(count: number, max: number): number {
    return max > 0 ? (count / max) * 100 : 0;
  }

  /** R-multiple bucket count as percentage of all R-classified signals. */
  rBucketPct(count: number): number {
    const total = (this.result()?.rMultipleBuckets ?? []).reduce((sum, b) => sum + b.count, 0);
    return total > 0 ? (count / total) * 100 : 0;
  }

  /** Human-readable label for the metric the heatmap is colouring by. */
  readonly heatmapMetricLabel = computed(() => {
    switch (this.heatmapMetric()) {
      case 'realizedPnL':
        return 'Realized P&L';
      case 'sumPnL':
        return 'Total P&L (Realized + Unrealized)';
      case 'winRatePct':
        return 'Win rate %';
      case 'profitFactor':
        return 'Profit factor';
      case 'expectancy':
        return 'Expectancy / signal';
    }
  });

  /** Extract the scalar value the heatmap should colour by for a given cell. */
  private heatmapCellValue(cell: SignalSensitivityHeatmapCellDto): number {
    const a = cell.aggregate;
    switch (this.heatmapMetric()) {
      case 'realizedPnL':
        return a.realizedPnL ?? 0;
      case 'sumPnL':
        return a.sumPnL ?? 0;
      case 'winRatePct':
        return a.winRatePct ?? 0;
      case 'profitFactor':
        // Cap at 5 for colouring — the backend returns 999 sentinel for
        // no-loss cohorts, which would saturate the scale.
        return Math.min(a.profitFactor ?? 0, 5);
      case 'expectancy': {
        const resolved = (a.winCount ?? 0) + (a.lossCount ?? 0);
        return resolved > 0 ? (a.realizedPnL ?? 0) / resolved : 0;
      }
    }
  }

  /** ECharts heatmap config. Diverging colour scale centred on zero so
   *  loss cells go red, profit cells go green. Active cell is marked. */
  readonly heatmapOptions = computed<EChartsOption | null>(() => {
    const r = this.result();
    if (!r || !r.heatmap?.length) return null;

    // ECharts heatmap wants [xIndex, yIndex, value] triples. We use SL as
    // x-axis and TP as y-axis (matches operator convention of plotting risk
    // horizontally).
    const slAxis = r.slSweepAxis ?? [];
    const tpAxis = r.tpSweepAxis ?? [];
    const slIdx = new Map(slAxis.map((v, i) => [v, i]));
    const tpIdx = new Map(tpAxis.map((v, i) => [v, i]));

    const data = r.heatmap.map((c) => [
      slIdx.get(c.slMultiplier) ?? 0,
      tpIdx.get(c.tpMultiplier) ?? 0,
      this.heatmapCellValue(c),
    ]);
    const values = data.map((d) => d[2] as number);
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values, 0);
    const absMax = Math.max(Math.abs(minV), Math.abs(maxV), 1);

    // Highlight the operator's active cell with a markPoint.
    const activeSlIdx = slIdx.get(r.slMultiplier) ?? -1;
    const activeTpIdx = tpIdx.get(r.tpMultiplier) ?? -1;

    return <EChartsOption>{
      animation: false,
      tooltip: {
        position: 'top',
        formatter: (params: any) => {
          const [sx, ty] = params.value as [number, number, number];
          const cell = r.heatmap.find(
            (c) =>
              (slIdx.get(c.slMultiplier) ?? -1) === sx && (tpIdx.get(c.tpMultiplier) ?? -1) === ty,
          );
          if (!cell) return '';
          const a = cell.aggregate;
          const fmt = (n: number) => (n == null ? '—' : n.toFixed(2));
          const cur = (n: number) => (n == null ? '—' : '$' + n.toFixed(0));
          return `
            <b>TP×${cell.tpMultiplier} · SL×${cell.slMultiplier}</b><br/>
            Win rate: ${fmt(a.winRatePct)}% (${a.winCount}/${a.lossCount})<br/>
            Realized: ${cur(a.realizedPnL)}<br/>
            Unrealized: ${cur(a.unrealizedPnL)}<br/>
            Profit factor: ${fmt(a.profitFactor)}<br/>
            Walkable: ${a.walkable} · Expired: ${a.expiredCount}
          `;
        },
      },
      grid: { left: 60, right: 30, top: 30, bottom: 60, containLabel: true },
      xAxis: {
        type: 'category',
        name: 'SL ×',
        nameLocation: 'middle',
        nameGap: 30,
        data: slAxis.map((v) => v.toString()),
        splitArea: { show: true },
      },
      yAxis: {
        type: 'category',
        name: 'TP ×',
        nameLocation: 'middle',
        nameGap: 40,
        data: tpAxis.map((v) => v.toString()),
        splitArea: { show: true },
      },
      visualMap: {
        min: -absMax,
        max: absMax,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        // Diverging red-white-green palette (matches profit/loss conventions).
        inRange: { color: ['#c4290a', '#f1eee5', '#1f8a3d'] },
      },
      series: [
        {
          name: this.heatmapMetricLabel(),
          type: 'heatmap',
          data,
          label: {
            show: true,
            formatter: (params: any) => {
              const v = params.value[2] as number;
              if (this.heatmapMetric() === 'winRatePct') return v.toFixed(0) + '%';
              if (this.heatmapMetric() === 'profitFactor') return v.toFixed(2);
              return Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);
            },
            fontSize: 10,
          },
          emphasis: { itemStyle: { borderColor: '#000', borderWidth: 2 } },
          markPoint:
            activeSlIdx >= 0 && activeTpIdx >= 0
              ? {
                  symbol: 'pin',
                  symbolSize: 28,
                  itemStyle: { color: '#0071e3' },
                  label: {
                    show: true,
                    formatter: '★',
                    color: '#ffffff',
                    fontSize: 12,
                  },
                  data: [{ coord: [activeSlIdx, activeTpIdx] }],
                }
              : undefined,
        },
      ],
    };
  });

  /** Horizontal baseline at the starting-balance level (visual reference). */
  readonly equityBaselinePoints = computed(() => {
    const r = this.result();
    if (!r || r.equityCurve.length < 2 || r.startingBalance == null) return '';
    const ys = r.equityCurve.map((p) => p.balance);
    const minY = Math.min(...ys, r.startingBalance);
    const maxY = Math.max(...ys, r.startingBalance);
    const pad = Math.max((maxY - minY) * 0.1, 1);
    const flip = (y: number) => maxY + pad - (y - (minY - pad));
    const yBase = flip(r.startingBalance);
    return `0,${yBase} ${r.equityCurve.length - 1},${yBase}`;
  });

  ngOnInit() {
    // Load risk profiles for the dropdown — wide page size since the profile
    // catalogue is small (operator-curated). Failure is non-fatal: the
    // dropdown stays empty and the operator can still run sweep-only mode.
    this.riskProfilesSvc
      .list({ currentPage: 1, itemCountPerPage: 200 })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.status && res.data?.data) {
          this.riskProfiles.set(res.data.data);
        }
      });

    // Load the full active-pair catalogue for the Symbols multi-select
    // datalist. Same failure posture as risk profiles — if the call fails,
    // the operator can still free-type symbols (datalist autocomplete just
    // shows no suggestions). Page size is generous because the catalogue
    // is bounded (~20-50 pairs in practice).
    this.currencyPairsSvc
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.status && res.data?.data) {
          const symbols = res.data.data
            .filter((p) => p.isActive && !!p.symbol)
            .map((p) => p.symbol!.toUpperCase())
            .sort();
          this.availableSymbols.set(symbols);
        }
      });
  }

  toggleSource(s: string) {
    const current = this.selectedSources();
    this.selectedSources.set(
      current.includes(s) ? current.filter((x) => x !== s) : [...current, s],
    );
  }

  toggleDirection(d: string) {
    const current = this.selectedDirections();
    this.selectedDirections.set(
      current.includes(d) ? current.filter((x) => x !== d) : [...current, d],
    );
  }

  /**
   * Commit whatever's in the input box to the selected-chip list. Accepts
   * comma-separated lists too, so an operator can paste
   * "NZDUSD, USDCAD, USDJPY" and get three chips at once. Case-normalises
   * to upper and de-duplicates against already-selected entries.
   */
  commitSymbolInput() {
    const raw = this.symbolInput().trim();
    if (!raw) return;
    const tokens = raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (tokens.length === 0) {
      this.symbolInput.set('');
      return;
    }
    const current = this.selectedSymbols();
    const merged = [...current];
    for (const t of tokens) if (!merged.includes(t)) merged.push(t);
    this.selectedSymbols.set(merged);
    this.symbolInput.set('');
  }

  removeSymbol(symbol: string) {
    this.selectedSymbols.set(this.selectedSymbols().filter((s) => s !== symbol));
  }

  run() {
    if (this.loading()) return;
    this.loading.set(true);
    this.errorMessage.set(null);

    const now = new Date();
    const fromUtc = new Date(now.getTime() - this.windowDays() * 24 * 60 * 60 * 1000);

    const sweep = this.sweepInput()
      .split(',')
      .map((v) => parseFloat(v.trim()))
      .filter((n) => !isNaN(n) && n > 0);

    const riskProfileId = this.riskProfileId();
    const startingBalance = riskProfileId !== null ? this.startingBalance() : undefined;

    // If the operator left text in the input box without committing it (no
    // Enter / comma / blur), flush it into the selected list first so we
    // don't silently drop their last symbol.
    if (this.symbolInput().trim().length > 0) this.commitSymbolInput();
    const symbolList = this.selectedSymbols();

    this.svc
      .analyze({
        sources: this.selectedSources().length ? this.selectedSources() : undefined,
        symbols: symbolList.length ? symbolList : undefined,
        directions: this.selectedDirections().length ? this.selectedDirections() : undefined,
        fromUtc: fromUtc.toISOString(),
        toUtc: now.toISOString(),
        tpMultiplier: this.tpMultiplier(),
        slMultiplier: this.slMultiplier(),
        tpSweepValues: sweep.length ? sweep : undefined,
        signalDetailCap: 200,
        riskProfileId: riskProfileId ?? undefined,
        startingBalance,
        // Operator's what-if expiry override (hours). Empty/0 → omit so the
        // walker uses each signal's persisted ExpiresAt.
        expiryOverrideHours:
          this.expiryOverrideHours() && this.expiryOverrideHours()! > 0
            ? this.expiryOverrideHours()!
            : undefined,
      })
      .pipe(
        catchError((err) => {
          this.errorMessage.set(err?.message ?? 'Sensitivity query failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) this.result.set(res.data);
        else if (res && !res.status)
          this.errorMessage.set(res.message ?? 'Query returned failure.');
      });
  }

  /**
   * Open the chart modal for a signal. Default timeframe is H1 (LLM/Spot
   * analysers write at H1, candles always exist). The operator can switch
   * granularity from the chart toolbar.
   */
  openSignalChart(s: AnalyzeSignalSensitivitySignalDto) {
    this.selectedSignal.set(s);
    this.selectedTimeframe.set('H1');
    this.reloadChart();
  }

  setChartTimeframe(tf: Timeframe) {
    if (this.selectedTimeframe() === tf) return;
    this.selectedTimeframe.set(tf);
    if (this.selectedSignal()) this.reloadChart();
  }

  /**
   * Fetch candles for the current signal + timeframe. Window is dynamic:
   * we aim for ~150 bars total at the chosen timeframe, biased toward
   * pre-context (so the "Signal fired" marker isn't pinned to the right
   * edge). The window also expands to cover the signal's full lifespan
   * (GeneratedAt → ExpiresAt) plus 2× duration of post-expiry drift.
   */
  private reloadChart() {
    const s = this.selectedSignal();
    if (!s) return;

    this.chartCandles.set([]);
    this.chartError.set(null);
    this.chartLoading.set(true);

    const tf = this.selectedTimeframe();
    const tfMin = this.timeframeMinutes(tf);
    const generated = new Date(s.generatedAt);
    const expires = new Date(s.expiresAt);
    const durationMin = Math.max(
      (expires.getTime() - generated.getTime()) / 60_000,
      tfMin, // floor so duration-scaled padding is never zero
    );

    // Target ~75 bars before signal fire, 75 bars after expiry. Also expand
    // to whichever is wider: bar-count-driven window or duration-driven window.
    const preMin = Math.max(75 * tfMin, durationMin * 4);
    const postMin = Math.max(75 * tfMin, durationMin * 2);

    const from = new Date(generated.getTime() - preMin * 60_000);
    const to = new Date(expires.getTime() + postMin * 60_000);

    this.marketDataSvc
      .listCandles({
        currentPage: 1,
        itemCountPerPage: 500,
        sortBy: 'timestamp',
        sortDirection: 'asc',
        filter: {
          symbol: s.symbol,
          timeframe: tf,
          from: from.toISOString(),
          to: to.toISOString(),
        },
      })
      .pipe(
        catchError((err) => {
          this.chartError.set(err?.message ?? 'Failed to load candles.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.chartLoading.set(false);
        if (res?.status && res.data?.data) {
          // Defensively sort ASC by timestamp — the API's sort safelist
          // may not honour 'timestamp' for the candle endpoint, in which
          // case the data lands in some other order (DESC observed live).
          // Without this, the X-axis renders right-to-left and the markPoint
          // exit coordinate misaligns with the candle category index.
          const sorted = [...res.data.data].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );
          this.chartCandles.set(sorted);
          if (sorted.length === 0) {
            this.chartError.set(
              `No ${tf} candles in the window. Try a different timeframe — the signal may pre-date ${tf} candle ingest.`,
            );
          }
        }
      });
  }

  private timeframeMinutes(tf: Timeframe): number {
    switch (tf) {
      case 'M1':
        return 1;
      case 'M5':
        return 5;
      case 'M15':
        return 15;
      case 'H1':
        return 60;
      case 'H4':
        return 240;
      case 'D1':
        return 1440;
    }
  }

  closeSignalChart() {
    this.selectedSignal.set(null);
    this.chartCandles.set([]);
    this.chartError.set(null);
  }

  /**
   * ECharts candlestick options with horizontal markLines for entry / original
   * SL / original TP, and dashed lines for the scenario-multiplier SL/TP when
   * they differ from the originals. Marks the exit point with a scatter dot.
   */
  readonly chartOptions = computed<EChartsOption | null>(() => {
    const s = this.selectedSignal();
    const r = this.result();
    const candles = this.chartCandles();
    if (!s || !r || candles.length === 0) return null;

    const isLong = s.direction === 'Buy';
    const tpMul = r.tpMultiplier;
    const slMul = r.slMultiplier;
    const scenarioTp = isLong
      ? s.entryPrice + (s.originalTP - s.entryPrice) * tpMul
      : s.entryPrice - (s.entryPrice - s.originalTP) * tpMul;
    const scenarioSl = isLong
      ? s.entryPrice - (s.entryPrice - s.originalSL) * slMul
      : s.entryPrice + (s.originalSL - s.entryPrice) * slMul;

    // ── Time-axis chart ──────────────────────────────────────────────────
    // We use a `type: 'time'` x-axis (not category) so signal-fire and exit
    // markers land at their exact timestamps rather than snapping to the
    // nearest candle index. This means:
    //   * Signal fired at 9:32 lands INSIDE the 9:00 H1 bar (not at 10:00).
    //   * Exit at 9:33 lands 1 minute after signal-fire, visually distinct
    //     from the signal-fire vertical even though both fall in the same
    //     H1 bar.
    // Candlestick data on a time axis is [timestamp, open, close, low, high].
    const tfMin = this.timeframeMinutes(this.selectedTimeframe());
    const tfMs = tfMin * 60_000;
    const signalMs = new Date(s.generatedAt).getTime();
    const exitMs = s.exitAt ? new Date(s.exitAt).getTime() : 0;
    const lastCandleMs = candles.length
      ? new Date(candles[candles.length - 1].timestamp).getTime()
      : signalMs;
    // The chart's x-range must extend past the signal/exit time even when
    // the last real candle hasn't caught up yet (fresh signal, candle
    // ingest lag). The padding "ghost" point gives the time axis room to
    // place the verticals without clipping them at the right edge.
    const lastChartMs = Math.max(lastCandleMs, Math.max(signalMs, exitMs) + tfMs);

    const candleData: (number | string)[][] = candles.map((c) => [
      new Date(c.timestamp).getTime(),
      c.open,
      c.close,
      c.low,
      c.high,
    ]);
    if (lastChartMs > lastCandleMs) {
      // Add a single placeholder so the axis extends without drawing a bar.
      candleData.push([lastChartMs, '-', '-', '-', '-']);
    }

    // Decimal precision: match the price's natural scale (4-digit JPY pairs,
    // 5-digit majors).
    const pricePrecision = s.entryPrice > 50 ? 3 : 5;
    const fmt = (n: number) => n.toFixed(pricePrecision);

    // HH:mm clock format for the vertical timing labels.
    const formatClockTime = (iso: string) => {
      const d = new Date(iso);
      return `${d.getHours().toString().padStart(2, '0')}:${d
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
    };

    // Exit colour from outcome.
    const exitColour =
      s.outcome === 'HitTP' ? '#1f8a3d' : s.outcome === 'HitSL' ? '#c4290a' : '#0071e3';

    // Filled bands from signal-fire onwards (TP zone above/below entry, SL
    // zone on the other side). Time-axis xAxis values are ms timestamps.
    const markAreaData: any[][] = [
      [
        {
          yAxis: s.entryPrice,
          xAxis: signalMs,
          itemStyle: { color: 'rgba(31, 138, 61, 0.12)' },
          name: 'TP zone',
        },
        { yAxis: s.originalTP, xAxis: lastChartMs },
      ],
      [
        {
          yAxis: s.entryPrice,
          xAxis: signalMs,
          itemStyle: { color: 'rgba(196, 41, 10, 0.12)' },
          name: 'SL zone',
        },
        { yAxis: s.originalSL, xAxis: lastChartMs },
      ],
    ];

    // Markers at exact (timestamp, price) coordinates:
    //   * Entry dot at the FILL bar timestamp (when the limit was actually
    //     filled). Black to match the Entry horizontal-line styling.
    //   * Exit dot at the exit bar timestamp with outcome colour.
    const markPointData: any[] = [];
    if (s.fillAt) {
      markPointData.push({
        coord: [new Date(s.fillAt).getTime(), s.entryPrice],
        symbol: 'circle',
        symbolSize: 10,
        itemStyle: { color: '#000000', borderColor: '#ffffff', borderWidth: 2 },
        label: { show: false },
      });
    }
    if (exitMs > 0 && s.exitPrice !== null) {
      markPointData.push({
        coord: [exitMs, s.exitPrice],
        symbol: 'circle',
        symbolSize: 10,
        itemStyle: { color: exitColour, borderColor: '#ffffff', borderWidth: 2 },
        label: { show: false },
      });
    }

    // Y-axis bounds with 15% padding so reference lines that sit outside the
    // candle range still render with margin.
    const lows = candles.map((c) => c.low);
    const highs = candles.map((c) => c.high);
    const allYs = [
      ...lows,
      ...highs,
      s.entryPrice,
      s.originalTP,
      s.originalSL,
      scenarioTp,
      scenarioSl,
      s.exitPrice ?? s.entryPrice,
    ];
    const yMin = Math.min(...allYs);
    const yMax = Math.max(...allYs);
    const yPad = (yMax - yMin) * 0.15;

    // Reference price lines (Entry/TP/SL/scenario/Exit). With a time axis,
    // each line is just two points: (signalMs, y) → (lastChartMs, y). The
    // line is invisible before signalMs because it has no data there.
    const flat = (y: number): [number, number][] => [
      [signalMs, y],
      [lastChartMs, y],
    ];
    const lineSeries: any[] = [
      {
        name: 'Entry',
        type: 'line',
        data: flat(s.entryPrice),
        symbol: 'none',
        lineStyle: { color: '#000000', width: 2.5, type: 'solid' },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `ENTRY ${fmt(s.entryPrice)}`,
          backgroundColor: '#000000',
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      },
      {
        name: 'TP',
        type: 'line',
        data: flat(s.originalTP),
        symbol: 'none',
        lineStyle: { color: '#1f8a3d', width: 2.5, type: 'solid' },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `TP ${fmt(s.originalTP)}`,
          backgroundColor: '#1f8a3d',
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      },
      {
        name: 'SL',
        type: 'line',
        data: flat(s.originalSL),
        symbol: 'none',
        lineStyle: { color: '#c4290a', width: 2.5, type: 'solid' },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `SL ${fmt(s.originalSL)}`,
          backgroundColor: '#c4290a',
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      },
    ];

    if (tpMul !== 1 || slMul !== 1) {
      lineSeries.push(
        {
          name: `TP×${tpMul}`,
          type: 'line',
          data: flat(scenarioTp),
          symbol: 'none',
          lineStyle: { color: '#1f8a3d', width: 2, type: 'dashed' },
          tooltip: { show: false },
          z: 9,
          endLabel: {
            show: true,
            formatter: `TP×${tpMul} ${fmt(scenarioTp)}`,
            backgroundColor: '#1f8a3d',
            color: '#ffffff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 10,
            offset: [0, 18],
          },
        },
        {
          name: `SL×${slMul}`,
          type: 'line',
          data: flat(scenarioSl),
          symbol: 'none',
          lineStyle: { color: '#c4290a', width: 2, type: 'dashed' },
          tooltip: { show: false },
          z: 9,
          endLabel: {
            show: true,
            formatter: `SL×${slMul} ${fmt(scenarioSl)}`,
            backgroundColor: '#c4290a',
            color: '#ffffff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 10,
            offset: [0, 18],
          },
        },
      );
    }

    if (s.exitPrice !== null) {
      lineSeries.push({
        name: 'Exit',
        type: 'line',
        data: flat(s.exitPrice),
        symbol: 'none',
        lineStyle: { color: exitColour, width: 2, type: 'solid' },
        tooltip: { show: false },
        z: 11,
        endLabel: {
          show: true,
          formatter: `EXIT ${fmt(s.exitPrice)}`,
          backgroundColor: exitColour,
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }

    // Default zoom: ~24 bars of pre-signal context to chart end. With time
    // axis we use startValue/endValue (ms) instead of percentages.
    const focusStartMs = signalMs - 24 * tfMs;

    return <EChartsOption>{
      animation: false,
      grid: { left: 70, right: 100, top: 32, bottom: 64 },
      xAxis: {
        type: 'time',
        axisLabel: {
          formatter: (val: number) => {
            const d = new Date(val);
            return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          },
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        min: yMin - yPad,
        max: yMax + yPad,
        axisLabel: { formatter: (val: number) => val.toFixed(pricePrecision) },
        splitLine: { show: true },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          const arr = Array.isArray(params) ? params : [params];
          const candle = arr.find((p: any) => p.seriesType === 'candlestick');
          if (!candle?.data) return '';
          const [ts, o, cl, lo, hi] = candle.data;
          const d = new Date(ts);
          const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `<b>${label}</b><br/>O ${o}<br/>H ${hi}<br/>L ${lo}<br/>C ${cl}`;
        },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, startValue: focusStartMs, endValue: lastChartMs },
        {
          type: 'slider',
          xAxisIndex: 0,
          height: 24,
          bottom: 8,
          startValue: focusStartMs,
          endValue: lastChartMs,
        },
      ],
      series: [
        {
          type: 'candlestick',
          data: candleData,
          itemStyle: {
            color: '#1f8a3d', // bullish body fill
            color0: '#c4290a', // bearish body fill
            borderColor: '#1f8a3d',
            borderColor0: '#c4290a',
          },
          z: 5,
          markArea: {
            silent: true,
            z: 0,
            data: markAreaData,
          },
          markLine: {
            symbol: 'none',
            z: 12,
            // Vertical timing markers placed by exact timestamp (time axis),
            // not by category index. Signal-fire at 9:32 and exit at 9:33
            // sit 1 minute apart visually rather than collapsing onto the
            // same bar. Solid blue for signal-fire, dashed outcome-colour
            // for exit.
            data: [
              {
                xAxis: signalMs,
                lineStyle: { color: '#0071e3', type: 'solid', width: 2, opacity: 0.9 },
                label: {
                  show: true,
                  formatter: `Signal fired ${formatClockTime(s.generatedAt)}`,
                  position: 'insideStartTop',
                  color: '#ffffff',
                  backgroundColor: '#0071e3',
                  padding: [3, 6],
                  borderRadius: 3,
                  fontWeight: 'bold',
                  fontSize: 11,
                },
              },
              ...(exitMs > 0 && s.exitAt
                ? [
                    {
                      xAxis: exitMs,
                      lineStyle: {
                        color: exitColour,
                        type: 'dashed' as const,
                        width: 2,
                        opacity: 0.9,
                      },
                      label: {
                        show: true,
                        formatter: `Exit ${formatClockTime(s.exitAt)}`,
                        position: 'insideEndTop' as const,
                        color: '#ffffff',
                        backgroundColor: exitColour,
                        padding: [3, 6],
                        borderRadius: 3,
                        fontWeight: 'bold' as const,
                        fontSize: 11,
                      },
                    },
                  ]
                : []),
            ],
            silent: true,
            animation: false,
          },
          markPoint: {
            data: markPointData,
            z: 13,
            silent: true,
            animation: false,
          },
        },
        ...lineSeries,
      ],
    };
  });
}
