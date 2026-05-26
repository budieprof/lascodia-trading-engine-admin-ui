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
import { MarketDataService } from '@core/services/market-data.service';
import { ThemeService } from '@core/theme/theme.service';
import {
  AnalyzeSignalSensitivityResultDto,
  AnalyzeSignalSensitivityEquityPointDto,
  AnalyzeSignalSensitivitySignalDto,
  CandleDto,
  RiskProfileDto,
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
          <label class="field">
            <span>Symbol</span>
            <input
              type="text"
              maxlength="12"
              placeholder="any"
              [(ngModel)]="symbolFilter"
              name="symbol"
            />
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
            <div class="kpi-label">Sum P&amp;L</div>
            <div
              class="kpi-value"
              [class.profit]="r.aggregate.sumPnL > 0"
              [class.loss]="r.aggregate.sumPnL < 0"
            >
              {{ r.aggregate.sumPnL | currency: 'USD' }}
            </div>
            <div class="kpi-sub">avg {{ r.aggregate.avgPnL | currency: 'USD' }}/sig</div>
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
                  · {{ r.riskProfileName }} · starting {{ r.startingBalance | currency: 'USD' }}
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

        <!-- ── TP sweep curve as a table + ASCII bar visual ───────────────── -->
        <section class="sweep-card">
          <h2>
            TP-multiplier sweep <small>(SL × {{ r.slMultiplier | number: '1.2-2' }})</small>
          </h2>
          <table class="sweep-table">
            <thead>
              <tr>
                <th>TP×</th>
                <th>Win rate</th>
                <th>Win curve</th>
                <th class="num">W</th>
                <th class="num">L</th>
                <th class="num">PF</th>
                <th class="num">Sum P&amp;L</th>
                <th class="num">Avg P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              @for (row of r.tpSweep; track row.tpMultiplier) {
                <tr [class.row--active]="row.tpMultiplier === r.tpMultiplier">
                  <td>{{ row.tpMultiplier | number: '1.2-2' }}</td>
                  <td [class.profit]="row.winRatePct >= 50" [class.loss]="row.winRatePct < 50">
                    {{ row.winRatePct | number: '1.1-1' }}%
                  </td>
                  <td class="curve">
                    <div
                      class="curve-bar"
                      [style.width.%]="row.winRatePct"
                      [class.curve-bar--profit]="row.winRatePct >= 50"
                      [class.curve-bar--loss]="row.winRatePct < 50"
                    ></div>
                  </td>
                  <td class="num">{{ row.winCount | number }}</td>
                  <td class="num">{{ row.lossCount | number }}</td>
                  <td class="num">{{ row.profitFactor | number: '1.2-2' }}</td>
                  <td class="num" [class.profit]="row.sumPnL > 0" [class.loss]="row.sumPnL < 0">
                    {{ row.sumPnL | currency: 'USD' }}
                  </td>
                  <td class="num">{{ row.avgPnL | currency: 'USD' }}</td>
                </tr>
              }
            </tbody>
          </table>
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
                  <span class="legend-item"
                    ><span class="dot dot--entry"></span>Entry
                    {{ s.entryPrice | number: '1.5-5' }}</span
                  >
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
      .equity-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.75rem 1rem;
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
  private readonly themeSvc = inject(ThemeService);

  readonly sourcesAvail = SOURCES;
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
  readonly symbolFilter = signal<string>('');
  readonly selectedSources = signal<string[]>(['SpotAnalysis']);
  readonly tpMultiplier = signal<number>(1.0);
  readonly slMultiplier = signal<number>(1.0);
  readonly sweepInput = signal<string>('0.5, 0.75, 1.0, 1.25, 1.5');
  readonly riskProfileId = signal<number | null>(null);
  readonly startingBalance = signal<number>(10000);

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly result = signal<AnalyzeSignalSensitivityResultDto | null>(null);
  readonly riskProfiles = signal<RiskProfileDto[]>([]);

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
  }

  toggleSource(s: string) {
    const current = this.selectedSources();
    this.selectedSources.set(
      current.includes(s) ? current.filter((x) => x !== s) : [...current, s],
    );
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

    this.svc
      .analyze({
        sources: this.selectedSources().length ? this.selectedSources() : undefined,
        symbol: this.symbolFilter().trim() || undefined,
        fromUtc: fromUtc.toISOString(),
        toUtc: now.toISOString(),
        tpMultiplier: this.tpMultiplier(),
        slMultiplier: this.slMultiplier(),
        tpSweepValues: sweep.length ? sweep : undefined,
        signalDetailCap: 200,
        riskProfileId: riskProfileId ?? undefined,
        startingBalance,
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

    // Candlestick series wants [open, close, low, high] per bar.
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const xLabels = candles.map((c) => c.timestamp);

    // Decimal precision: match the price's natural scale (4-digit JPY pairs,
    // 5-digit majors). Crude but effective for the formatter labels + axis.
    const pricePrecision = s.entryPrice > 50 ? 3 : 5;
    const fmt = (n: number) => n.toFixed(pricePrecision);

    // Find the candle index whose timestamp is closest to exitAt — markPoint
    // on a category xAxis needs the coord's x to match a category exactly,
    // OR it can use a numeric index. We use the index for robustness.
    const findClosestIndex = (iso: string): number => {
      const target = new Date(iso).getTime();
      let bestIdx = 0;
      let bestDelta = Infinity;
      for (let i = 0; i < candles.length; i++) {
        const delta = Math.abs(new Date(candles[i].timestamp).getTime() - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      }
      return bestIdx;
    };

    // Filled bands for the "reward zone" (entry → TP, green) and "risk zone"
    // (entry → SL, red) — much louder than thin horizontal lines that blend
    // into the chart's horizontal gridlines.
    const markAreaData: any[][] = [
      [
        { yAxis: s.entryPrice, itemStyle: { color: 'rgba(31, 138, 61, 0.12)' }, name: 'TP zone' },
        { yAxis: s.originalTP },
      ],
      [
        { yAxis: s.entryPrice, itemStyle: { color: 'rgba(196, 41, 10, 0.12)' }, name: 'SL zone' },
        { yAxis: s.originalSL },
      ],
    ];

    // Exit timing + color. We render exit both as a horizontal line (price
    // level, drawn via a dedicated series below) and as a dot at the exact
    // (timestamp, price) coordinate so the operator can read WHEN as well as
    // WHERE the exit happened.
    let exitColour = '#0071e3';
    let exitIdx: number | null = null;
    if (s.exitPrice !== null && s.exitAt) {
      exitIdx = findClosestIndex(s.exitAt);
      exitColour =
        s.outcome === 'HitTP' ? '#1f8a3d' : s.outcome === 'HitSL' ? '#c4290a' : '#0071e3';
    }

    // Closest candle to GeneratedAt for the vertical "Signal fired" marker.
    const signalIdx = findClosestIndex(s.generatedAt);

    // Dot at the exact exit (timestamp, price) — companion to the exit
    // horizontal line so the operator gets WHEN + WHERE at a glance.
    const markPointData: any[] = [];
    if (exitIdx !== null && s.exitPrice !== null) {
      markPointData.push({
        coord: [exitIdx, s.exitPrice],
        symbol: 'circle',
        symbolSize: 10,
        itemStyle: { color: exitColour, borderColor: '#ffffff', borderWidth: 2 },
        label: { show: false },
      });
    }

    // Y-axis bounds: ensure entry/TP/SL all visible with a 15% padding.
    // ECharts' default scale doesn't always span our reference lines if they
    // sit outside the candle high/low range — common when TP / SL haven't been
    // touched yet by the visible bars.
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

    // Dedicated horizontal-line series for Entry/TP/SL/Exit. We render these
    // as real `type: 'line'` series rather than relying on markLine because
    // markLine on a candlestick series is rendered unreliably (z-order +
    // clipping quirks observed live). Each series carries a constant Y across
    // every bar, producing a flat horizontal line that's guaranteed to draw.
    const flat = (y: number): number[] => candles.map(() => y);
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

    return <EChartsOption>{
      animation: false,
      grid: { left: 70, right: 100, top: 32, bottom: 64 },
      xAxis: {
        type: 'category',
        data: xLabels,
        axisLabel: {
          formatter: (val: string) => {
            const d = new Date(val);
            return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
          },
        },
        boundaryGap: true,
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
          const [, o, cl, lo, hi] = candle.data;
          return `<b>${candle.name}</b><br/>O ${o}<br/>H ${hi}<br/>L ${lo}<br/>C ${cl}`;
        },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, height: 24, bottom: 8 },
      ],
      series: [
        {
          type: 'candlestick',
          data: ohlc,
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
            // Only the vertical "Signal fired" marker lives on markLine —
            // horizontal price levels are dedicated line series above so
            // they're guaranteed to render.
            data: [
              {
                xAxis: signalIdx,
                lineStyle: { color: '#0071e3', type: 'solid', width: 1.5, opacity: 0.6 },
                label: {
                  show: true,
                  formatter: 'Signal fired',
                  position: 'insideStartTop',
                  color: '#0071e3',
                  fontWeight: 'bold',
                  fontSize: 11,
                },
              },
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
