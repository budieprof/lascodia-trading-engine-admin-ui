import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
  effect,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable, map } from 'rxjs';
import type { EChartsOption } from 'echarts';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { TabsComponent } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';
import { BacktestsService } from '@core/services/backtests.service';
import { WalkForwardService } from '@core/services/walk-forward.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ColDef } from 'ag-grid-community';
import {
  PagedData,
  PagerRequest,
  BacktestRunDto,
  WalkForwardRunDto,
  ResponseData,
} from '@core/api/api.types';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-backtests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    TabsComponent,
    ChartCardComponent,
    FormsModule,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Backtesting"
        subtitle="Run and review historical strategy simulations"
      >
        <button class="btn-primary" (click)="showForm.set(!showForm())">
          {{ showForm() ? 'Cancel' : 'Queue Backtest' }}
        </button>
      </app-page-header>

      @if (showForm()) {
        <div class="form-card">
          <h3 class="form-title">Queue New Backtest</h3>
          <div class="form-grid">
            <div class="field">
              <label>Strategy ID</label>
              <input type="number" [(ngModel)]="formData.strategyId" placeholder="1" />
            </div>
            <div class="field">
              <label>Symbol</label>
              <input type="text" [(ngModel)]="formData.symbol" placeholder="EUR/USD" />
            </div>
            <div class="field">
              <label>Timeframe</label>
              <select [(ngModel)]="formData.timeframe">
                <option value="M1">1 Min</option>
                <option value="M5">5 Min</option>
                <option value="M15">15 Min</option>
                <option value="H1">1 Hour</option>
                <option value="H4">4 Hours</option>
                <option value="D1">Daily</option>
              </select>
            </div>
            <div class="field">
              <label>Initial Balance</label>
              <input type="number" [(ngModel)]="formData.initialBalance" placeholder="10000" />
            </div>
            <div class="field">
              <label>From Date</label>
              <input type="date" [(ngModel)]="formData.fromDate" />
            </div>
            <div class="field">
              <label>To Date</label>
              <input type="date" [(ngModel)]="formData.toDate" />
            </div>
          </div>
          <div class="form-actions">
            <button class="btn-secondary" (click)="showForm.set(false)">Cancel</button>
            <button class="btn-primary" (click)="queueBacktest()">Queue</button>
          </div>
        </div>
      }

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      @if (activeTab() === 'backtests') {
        <!-- 8-card KPI strip -->
        <div class="bt-kpis">
          <div class="bt-kpi">
            <span class="kpi-label">Total runs</span>
            <span class="kpi-value">{{ btStats().total }}</span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Completed</span>
            <span class="kpi-value good">{{ btStats().completed }}</span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Failed</span>
            <span
              class="kpi-value"
              [class.bad]="btStats().failed > 0"
              [class.good]="btStats().failed === 0"
            >
              {{ btStats().failed }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg total return</span>
            <span
              class="kpi-value"
              [class.good]="btStats().avgReturn !== null && btStats().avgReturn! > 0"
              [class.bad]="btStats().avgReturn !== null && btStats().avgReturn! < 0"
            >
              @if (btStats().avgReturn !== null) {
                {{ btStats().avgReturn! >= 0 ? '+' : ''
                }}{{ (btStats().avgReturn! * 100).toFixed(2) }}%
              } @else {
                —
              }
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Best return</span>
            <span class="kpi-value good">
              {{
                btStats().bestReturn !== null
                  ? '+' + (btStats().bestReturn! * 100).toFixed(2) + '%'
                  : '—'
              }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg win rate</span>
            <span class="kpi-value">
              {{
                btStats().avgWinRate !== null ? (btStats().avgWinRate! * 100).toFixed(1) + '%' : '—'
              }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg trades</span>
            <span class="kpi-value">{{
              btStats().avgTrades !== null ? btStats().avgTrades : '—'
            }}</span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Symbols × strategies</span>
            <span class="kpi-value"
              >{{ btStats().symbolCount }} × {{ btStats().strategyCount }}</span
            >
          </div>
        </div>

        <!-- 3-col chart row -->
        <div class="bt-charts">
          <app-chart-card
            title="Status distribution"
            subtitle="Completed · Failed · Running · Pending"
            [options]="btStatusDonutOptions()"
            height="240px"
          />
          <app-chart-card
            title="Return distribution"
            subtitle="Histogram of total return % across completed runs"
            [options]="btReturnHistogramOptions()"
            height="240px"
          />
          <app-chart-card
            title="Runs by symbol"
            subtitle="Top 12 symbols by run count"
            [options]="btBySymbolOptions()"
            height="240px"
          />
        </div>

        <!-- 2-col tables: top performers + per-symbol -->
        <div class="bt-board-row">
          <section class="bt-board">
            <header class="bt-board-head">
              <h3>Top performers</h3>
              <span class="muted">Highest total return across completed runs</span>
            </header>
            @if (btTopReturns().length > 0) {
              <table class="bt-board-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th class="num">Return</th>
                    <th class="num">PF</th>
                    <th class="num">Sharpe</th>
                    <th class="num">Max DD</th>
                    <th class="num">Trades</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of btTopReturns(); track r.id) {
                    <tr (click)="onBacktestClick(r)">
                      <td class="mono">#{{ r.id }}</td>
                      <td class="mono">#{{ r.strategyId }}</td>
                      <td class="mono">{{ r.symbol }}</td>
                      <td class="num mono profit">
                        +{{ ((r.totalReturn ?? 0) * 100).toFixed(2) }}%
                      </td>
                      <td class="num mono">
                        {{ r.profitFactor !== null ? r.profitFactor.toFixed(2) : '—' }}
                      </td>
                      <td class="num mono">
                        {{ r.sharpeRatio !== null ? r.sharpeRatio.toFixed(2) : '—' }}
                      </td>
                      <td class="num mono loss">
                        {{ r.maxDrawdownPct !== null ? r.maxDrawdownPct.toFixed(2) + '%' : '—' }}
                      </td>
                      <td class="num mono">{{ r.totalTrades ?? '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted" style="padding: var(--space-4)">
                No completed runs with measurable returns yet.
              </p>
            }
          </section>

          <section class="bt-board">
            <header class="bt-board-head">
              <h3>Per-symbol breakdown</h3>
              <span class="muted">Avg metrics grouped by symbol</span>
            </header>
            @if (btPerSymbol().length > 0) {
              <table class="bt-board-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="num">Runs</th>
                    <th class="num">Avg return</th>
                    <th class="num">Best return</th>
                    <th class="num">Avg Sharpe</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of btPerSymbol(); track row.symbol) {
                    <tr>
                      <td class="mono">{{ row.symbol }}</td>
                      <td class="num mono">{{ row.runs }}</td>
                      <td
                        class="num mono"
                        [class.profit]="row.avgReturn !== null && row.avgReturn > 0"
                        [class.loss]="row.avgReturn !== null && row.avgReturn < 0"
                      >
                        @if (row.avgReturn !== null) {
                          {{ row.avgReturn >= 0 ? '+' : '' }}{{ (row.avgReturn * 100).toFixed(2) }}%
                        } @else {
                          —
                        }
                      </td>
                      <td class="num mono profit">
                        {{
                          row.bestReturn !== null
                            ? '+' + (row.bestReturn * 100).toFixed(2) + '%'
                            : '—'
                        }}
                      </td>
                      <td class="num mono">
                        {{ row.avgSharpe !== null ? row.avgSharpe.toFixed(2) : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        </div>

        <section class="bt-board">
          <header class="bt-board-head">
            <h3>All backtest runs</h3>
            <span class="muted">Server-paged — click any row for the detail page</span>
          </header>
          <app-data-table
            [columnDefs]="backtestColumns"
            [fetchData]="fetchBacktests"
            (rowClick)="onBacktestClick($event)"
          />
        </section>
      } @else {
        <!-- Walk-Forward analytics -->
        <div class="bt-kpis">
          <div class="bt-kpi">
            <span class="kpi-label">Total runs</span>
            <span class="kpi-value">{{ wfStats().total }}</span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Completed</span>
            <span class="kpi-value good">{{ wfStats().completed }}</span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Failed</span>
            <span
              class="kpi-value"
              [class.bad]="wfStats().failed > 0"
              [class.good]="wfStats().failed === 0"
            >
              {{ wfStats().failed }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg OOS score</span>
            <span class="kpi-value">
              {{
                wfStats().avgOosScore !== null
                  ? (wfStats().avgOosScore! * 100).toFixed(1) + '%'
                  : '—'
              }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Best OOS score</span>
            <span class="kpi-value good">
              {{
                wfStats().bestOosScore !== null
                  ? (wfStats().bestOosScore! * 100).toFixed(1) + '%'
                  : '—'
              }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg consistency</span>
            <span class="kpi-value">
              {{ wfStats().avgConsistency !== null ? wfStats().avgConsistency!.toFixed(3) : '—' }}
            </span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg IS days</span>
            <span class="kpi-value">{{ wfStats().avgIsDays }}</span>
          </div>
          <div class="bt-kpi">
            <span class="kpi-label">Avg OOS days</span>
            <span class="kpi-value">{{ wfStats().avgOosDays }}</span>
          </div>
        </div>

        <div class="bt-charts">
          <app-chart-card
            title="Status distribution"
            subtitle="Completed · Failed · Running · Pending"
            [options]="wfStatusDonutOptions()"
            height="240px"
          />
          <app-chart-card
            title="OOS score distribution"
            subtitle="Histogram of avg out-of-sample scores"
            [options]="wfOosHistogramOptions()"
            height="240px"
          />
          <app-chart-card
            title="Runs by symbol"
            subtitle="Top 12 symbols by run count"
            [options]="wfBySymbolOptions()"
            height="240px"
          />
        </div>

        <div class="bt-board-row">
          <section class="bt-board">
            <header class="bt-board-head">
              <h3>Top performers</h3>
              <span class="muted">Highest avg OOS score across completed runs</span>
            </header>
            @if (wfTopOos().length > 0) {
              <table class="bt-board-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th class="num">Avg OOS</th>
                    <th class="num">Consistency</th>
                    <th class="num">IS days</th>
                    <th class="num">OOS days</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of wfTopOos(); track r.id) {
                    <tr (click)="onWalkForwardClick(r)">
                      <td class="mono">#{{ r.id }}</td>
                      <td class="mono">#{{ r.strategyId }}</td>
                      <td class="mono">{{ r.symbol }}</td>
                      <td class="num mono profit">
                        {{
                          r.averageOutOfSampleScore !== null
                            ? (r.averageOutOfSampleScore * 100).toFixed(1) + '%'
                            : '—'
                        }}
                      </td>
                      <td class="num mono">
                        {{ r.scoreConsistency !== null ? r.scoreConsistency.toFixed(3) : '—' }}
                      </td>
                      <td class="num mono">{{ r.inSampleDays }}</td>
                      <td class="num mono">{{ r.outOfSampleDays }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted" style="padding: var(--space-4)">
                No completed runs with OOS scores yet.
              </p>
            }
          </section>

          <section class="bt-board">
            <header class="bt-board-head">
              <h3>Per-symbol breakdown</h3>
              <span class="muted">Avg metrics grouped by symbol</span>
            </header>
            @if (wfPerSymbol().length > 0) {
              <table class="bt-board-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="num">Runs</th>
                    <th class="num">Avg OOS</th>
                    <th class="num">Best OOS</th>
                    <th class="num">Avg consist.</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of wfPerSymbol(); track row.symbol) {
                    <tr>
                      <td class="mono">{{ row.symbol }}</td>
                      <td class="num mono">{{ row.runs }}</td>
                      <td class="num mono">
                        {{ row.avgOos !== null ? (row.avgOos * 100).toFixed(1) + '%' : '—' }}
                      </td>
                      <td class="num mono profit">
                        {{ row.bestOos !== null ? (row.bestOos * 100).toFixed(1) + '%' : '—' }}
                      </td>
                      <td class="num mono">
                        {{ row.avgConsistency !== null ? row.avgConsistency.toFixed(3) : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        </div>

        <section class="bt-board">
          <header class="bt-board-head">
            <h3>All walk-forward runs</h3>
            <span class="muted">Server-paged — click any row for the detail page</span>
          </header>
          <app-data-table
            [columnDefs]="walkForwardColumns"
            [fetchData]="fetchWalkForward"
            (rowClick)="onWalkForwardClick($event)"
          />
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .btn-primary {
        height: 36px;
        padding: 0 var(--space-5);
        background: var(--accent);
        color: white;
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s ease;
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }
      .btn-primary:active {
        transform: scale(0.97);
      }
      .btn-secondary {
        height: 36px;
        padding: 0 var(--space-5);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
      }

      .form-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .form-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        margin: 0 0 var(--space-4);
        color: var(--text-primary);
      }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .field label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input,
      .field select {
        height: 40px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-base);
        font-family: inherit;
        outline: none;
      }
      .field input:focus,
      .field select:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3);
      }
      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }

      /* Backtests density additions */
      .bt-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .bt-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .bt-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .bt-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .kpi-value.good {
        color: var(--profit);
      }
      .kpi-value.bad {
        color: var(--loss);
      }

      .bt-charts {
        display: grid;
        grid-template-columns: 1fr 1.2fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .bt-charts {
          grid-template-columns: 1fr;
        }
      }

      .bt-board-row {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .bt-board-row {
          grid-template-columns: 1fr;
        }
      }

      .bt-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .bt-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .bt-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .bt-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .bt-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .bt-board-table th,
      .bt-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .bt-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .bt-board-table tbody tr {
        cursor: pointer;
        transition: background 0.1s;
      }
      .bt-board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .bt-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .bt-board-table th.num,
      .bt-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .bt-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .bt-board-table .profit {
        color: var(--profit);
      }
      .bt-board-table .loss {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class BacktestsPageComponent implements OnInit {
  private backtestsService = inject(BacktestsService);
  private walkForwardService = inject(WalkForwardService);
  private notifications = inject(NotificationService);
  private router = inject(Router);

  tabs = [
    { label: 'Backtest Runs', value: 'backtests' },
    { label: 'Walk-Forward Runs', value: 'walkforward' },
  ];
  activeTab = signal('backtests');
  showForm = signal(false);

  formData = {
    strategyId: 1,
    symbol: 'EUR/USD',
    timeframe: 'H1',
    initialBalance: 10000,
    fromDate: '2025-01-01',
    toDate: '2025-12-31',
  };

  // ── Analytics samples (probe-and-fetch, capped at 5000) ─────────────
  readonly btSample = signal<BacktestRunDto[]>([]);
  readonly wfSample = signal<WalkForwardRunDto[]>([]);
  private wfLoaded = false;

  constructor() {
    // Lazy-load walk-forward analytics the first time the user opens that tab.
    effect(() => {
      if (this.activeTab() === 'walkforward' && !this.wfLoaded) {
        this.loadWfAnalyticsSample();
      }
    });
  }

  ngOnInit(): void {
    this.loadBtAnalyticsSample();
  }

  // ── Backtest analytics ─────────────────────────────────────────────
  btStats = computed(() => {
    const all = this.btSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        avgReturn: null as number | null,
        bestReturn: null as number | null,
        avgWinRate: null as number | null,
        avgTrades: null as number | null,
        symbolCount: 0,
        strategyCount: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let returnSum = 0;
    let returnCount = 0;
    let bestReturn = -Infinity;
    let winRateSum = 0;
    let winRateCount = 0;
    let tradesSum = 0;
    let tradesCount = 0;
    const symbols = new Set<string>();
    const strategies = new Set<number>();
    for (const r of all) {
      const status = String(r.status);
      if (status === 'Completed') completed++;
      else if (status === 'Failed') failed++;
      if (r.symbol) symbols.add(r.symbol);
      strategies.add(r.strategyId);
      if (r.totalReturn != null) {
        returnSum += r.totalReturn;
        returnCount++;
        if (r.totalReturn > bestReturn) bestReturn = r.totalReturn;
      }
      if (r.winRate != null) {
        winRateSum += r.winRate;
        winRateCount++;
      }
      if (r.totalTrades != null) {
        tradesSum += r.totalTrades;
        tradesCount++;
      }
    }
    return {
      total: all.length,
      completed,
      failed,
      avgReturn: returnCount > 0 ? +(returnSum / returnCount).toFixed(4) : null,
      bestReturn: bestReturn === -Infinity ? null : +bestReturn.toFixed(4),
      avgWinRate: winRateCount > 0 ? +(winRateSum / winRateCount).toFixed(4) : null,
      avgTrades: tradesCount > 0 ? Math.round(tradesSum / tradesCount) : null,
      symbolCount: symbols.size,
      strategyCount: strategies.size,
    };
  });

  btStatusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.btSample()) {
      const k = String(r.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Completed: '#34C759',
      Failed: '#FF3B30',
      Running: '#0071E3',
      Pending: '#5AC8FA',
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
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  btReturnHistogramOptions = computed<EChartsOption>(() => {
    const returns = this.btSample()
      .filter((r) => r.totalReturn != null)
      .map((r) => (r.totalReturn ?? 0) * 100);
    if (returns.length === 0) return {};
    const min = Math.min(...returns);
    const max = Math.max(...returns);
    if (max === min) {
      return {
        grid: { top: 10, right: 20, bottom: 30, left: 40 },
        xAxis: { type: 'category', data: [`${min.toFixed(0)}%`] },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'bar',
            data: [
              { value: returns.length, itemStyle: { color: min >= 0 ? '#34C759' : '#FF3B30' } },
            ],
            barWidth: '40%',
          },
        ],
      };
    }
    const bins = 12;
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    const labels: string[] = [];
    for (let i = 0; i < bins; i++) labels.push(`${(min + i * width).toFixed(0)}%`);
    for (const v of returns) {
      const idx = Math.min(Math.floor((v - min) / width), bins - 1);
      counts[idx]++;
    }
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            itemStyle: {
              color: min + (i + 0.5) * width >= 0 ? '#34C759' : '#FF3B30',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  btBySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.btSample()) {
      const k = r.symbol ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 90 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  btTopReturns = computed(() =>
    [...this.btSample()]
      .filter((r) => r.totalReturn != null)
      .sort((a, b) => (b.totalReturn ?? 0) - (a.totalReturn ?? 0))
      .slice(0, 8),
  );

  btPerSymbol = computed(() => {
    type Row = {
      symbol: string;
      runs: number;
      avgReturn: number | null;
      bestReturn: number | null;
      avgSharpe: number | null;
      _retSum: number;
      _retCount: number;
      _shSum: number;
      _shCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const r of this.btSample()) {
      const k = r.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = {
          symbol: k,
          runs: 0,
          avgReturn: null,
          bestReturn: null,
          avgSharpe: null,
          _retSum: 0,
          _retCount: 0,
          _shSum: 0,
          _shCount: 0,
        };
      const g = groups[k];
      g.runs++;
      if (r.totalReturn != null) {
        g._retSum += r.totalReturn;
        g._retCount++;
        if (g.bestReturn == null || r.totalReturn > g.bestReturn) g.bestReturn = r.totalReturn;
      }
      if (r.sharpeRatio != null) {
        g._shSum += r.sharpeRatio;
        g._shCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        symbol: g.symbol,
        runs: g.runs,
        avgReturn: g._retCount > 0 ? +(g._retSum / g._retCount).toFixed(4) : null,
        bestReturn: g.bestReturn != null ? +g.bestReturn.toFixed(4) : null,
        avgSharpe: g._shCount > 0 ? +(g._shSum / g._shCount).toFixed(2) : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  // ── Walk-forward analytics ────────────────────────────────────────────
  wfStats = computed(() => {
    const all = this.wfSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        avgOosScore: null as number | null,
        bestOosScore: null as number | null,
        avgConsistency: null as number | null,
        avgIsDays: 0,
        avgOosDays: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let oosSum = 0;
    let oosCount = 0;
    let bestOos = -Infinity;
    let consSum = 0;
    let consCount = 0;
    let isSum = 0;
    let oosDaysSum = 0;
    for (const r of all) {
      const status = String(r.status);
      if (status === 'Completed') completed++;
      else if (status === 'Failed') failed++;
      if (r.averageOutOfSampleScore != null) {
        oosSum += r.averageOutOfSampleScore;
        oosCount++;
        if (r.averageOutOfSampleScore > bestOos) bestOos = r.averageOutOfSampleScore;
      }
      if (r.scoreConsistency != null) {
        consSum += r.scoreConsistency;
        consCount++;
      }
      isSum += r.inSampleDays ?? 0;
      oosDaysSum += r.outOfSampleDays ?? 0;
    }
    return {
      total: all.length,
      completed,
      failed,
      avgOosScore: oosCount > 0 ? +(oosSum / oosCount).toFixed(4) : null,
      bestOosScore: bestOos === -Infinity ? null : +bestOos.toFixed(4),
      avgConsistency: consCount > 0 ? +(consSum / consCount).toFixed(3) : null,
      avgIsDays: Math.round(isSum / all.length),
      avgOosDays: Math.round(oosDaysSum / all.length),
    };
  });

  wfStatusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.wfSample()) {
      const k = String(r.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Completed: '#34C759',
      Failed: '#FF3B30',
      Running: '#0071E3',
      Pending: '#5AC8FA',
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
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  wfOosHistogramOptions = computed<EChartsOption>(() => {
    const scores = this.wfSample()
      .filter((r) => r.averageOutOfSampleScore != null)
      .map((r) => (r.averageOutOfSampleScore ?? 0) * 100);
    if (scores.length === 0) return {};
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    if (max === min) {
      return {
        grid: { top: 10, right: 20, bottom: 30, left: 40 },
        xAxis: { type: 'category', data: [`${min.toFixed(0)}%`] },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'bar',
            data: [{ value: scores.length, itemStyle: { color: '#0071E3' } }],
            barWidth: '40%',
          },
        ],
      };
    }
    const bins = 12;
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    const labels: string[] = [];
    for (let i = 0; i < bins; i++) labels.push(`${(min + i * width).toFixed(0)}%`);
    for (const v of scores) {
      const idx = Math.min(Math.floor((v - min) / width), bins - 1);
      counts[idx]++;
    }
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c) => ({
            value: c,
            itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  wfBySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.wfSample()) {
      const k = r.symbol ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 90 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  wfTopOos = computed(() =>
    [...this.wfSample()]
      .filter((r) => r.averageOutOfSampleScore != null)
      .sort((a, b) => (b.averageOutOfSampleScore ?? 0) - (a.averageOutOfSampleScore ?? 0))
      .slice(0, 8),
  );

  wfPerSymbol = computed(() => {
    type Row = {
      symbol: string;
      runs: number;
      avgOos: number | null;
      bestOos: number | null;
      avgConsistency: number | null;
      _oosSum: number;
      _oosCount: number;
      _consSum: number;
      _consCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const r of this.wfSample()) {
      const k = r.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = {
          symbol: k,
          runs: 0,
          avgOos: null,
          bestOos: null,
          avgConsistency: null,
          _oosSum: 0,
          _oosCount: 0,
          _consSum: 0,
          _consCount: 0,
        };
      const g = groups[k];
      g.runs++;
      if (r.averageOutOfSampleScore != null) {
        g._oosSum += r.averageOutOfSampleScore;
        g._oosCount++;
        if (g.bestOos == null || r.averageOutOfSampleScore > g.bestOos)
          g.bestOos = r.averageOutOfSampleScore;
      }
      if (r.scoreConsistency != null) {
        g._consSum += r.scoreConsistency;
        g._consCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        symbol: g.symbol,
        runs: g.runs,
        avgOos: g._oosCount > 0 ? +(g._oosSum / g._oosCount).toFixed(4) : null,
        bestOos: g.bestOos != null ? +g.bestOos.toFixed(4) : null,
        avgConsistency: g._consCount > 0 ? +(g._consSum / g._consCount).toFixed(3) : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  private loadBtAnalyticsSample(): void {
    this.backtestsService.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.btSample.set([]);
          return;
        }
        this.backtestsService
          .list({ currentPage: 1, itemCountPerPage: Math.min(total, 5000), filter: null })
          .subscribe({
            next: (full) => this.btSample.set(full?.data?.data ?? []),
          });
      },
    });
  }

  private loadWfAnalyticsSample(): void {
    if (this.wfLoaded) return;
    this.wfLoaded = true;
    this.walkForwardService.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.wfSample.set([]);
          return;
        }
        this.walkForwardService
          .list({ currentPage: 1, itemCountPerPage: Math.min(total, 5000), filter: null })
          .subscribe({
            next: (full) => this.wfSample.set(full?.data?.data ?? []),
            error: () => (this.wfLoaded = false),
          });
      },
      error: () => (this.wfLoaded = false),
    });
  }

  backtestColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'strategyId', headerName: 'Strategy', width: 90 },
    { field: 'symbol', headerName: 'Symbol', width: 100 },
    { field: 'timeframe', headerName: 'TF', width: 70 },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Run status' },
    },
    {
      field: 'totalTrades',
      headerName: 'Trades',
      width: 90,
      valueFormatter: (p: any) => (p.value != null ? p.value : '—'),
    },
    {
      field: 'winRate',
      headerName: 'Win %',
      width: 90,
      valueFormatter: (p: any) => (p.value != null ? `${(p.value * 100).toFixed(1)}%` : '—'),
    },
    {
      field: 'profitFactor',
      headerName: 'PF',
      width: 80,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(2) : '—'),
    },
    {
      field: 'sharpeRatio',
      headerName: 'Sharpe',
      width: 90,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(2) : '—'),
    },
    {
      field: 'maxDrawdownPct',
      headerName: 'Max DD',
      width: 100,
      valueFormatter: (p: any) => (p.value != null ? `${p.value.toFixed(2)}%` : '—'),
    },
    {
      field: 'totalReturn',
      headerName: 'Return',
      width: 100,
      valueFormatter: (p: any) => (p.value != null ? `${(p.value * 100).toFixed(2)}%` : '—'),
    },
    {
      field: 'finalBalance',
      headerName: 'Final',
      width: 110,
      valueFormatter: (p: any) => (p.value != null ? `$${p.value.toLocaleString()}` : '—'),
    },
    {
      field: 'completedAt',
      headerName: 'Completed',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
  ];

  walkForwardColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'strategyId', headerName: 'Strategy', width: 90 },
    { field: 'symbol', headerName: 'Symbol', width: 100 },
    { field: 'timeframe', headerName: 'TF', width: 70 },
    { field: 'status', headerName: 'Status', width: 110 },
    { field: 'inSampleDays', headerName: 'IS days', width: 90 },
    { field: 'outOfSampleDays', headerName: 'OOS days', width: 100 },
    {
      field: 'averageOutOfSampleScore',
      headerName: 'Avg OOS',
      width: 110,
      valueFormatter: (p: any) => (p.value != null ? `${(p.value * 100).toFixed(1)}%` : '—'),
    },
    {
      field: 'scoreConsistency',
      headerName: 'Consistency',
      width: 120,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(3) : '—'),
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
  ];

  fetchBacktests = (params: PagerRequest): Observable<PagedData<BacktestRunDto>> => {
    return this.backtestsService.list(params).pipe(
      map(
        (res: ResponseData<PagedData<BacktestRunDto>>) =>
          res.data ?? {
            pager: {
              totalItemCount: 0,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 0,
              pageSize: 25,
              filter: null,
            },
            data: [],
          },
      ),
    );
  };

  fetchWalkForward = (params: PagerRequest): Observable<PagedData<WalkForwardRunDto>> => {
    return this.walkForwardService.list(params).pipe(
      map(
        (res: ResponseData<PagedData<WalkForwardRunDto>>) =>
          res.data ?? {
            pager: {
              totalItemCount: 0,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 0,
              pageSize: 25,
              filter: null,
            },
            data: [],
          },
      ),
    );
  };

  onBacktestClick(row: BacktestRunDto) {
    this.router.navigate(['/backtests', row.id]);
  }

  onWalkForwardClick(row: WalkForwardRunDto) {
    this.router.navigate(['/walk-forward', row.id]);
  }

  queueBacktest() {
    this.backtestsService
      .create({
        strategyId: this.formData.strategyId,
        symbol: this.formData.symbol,
        timeframe: this.formData.timeframe as any,
        initialBalance: this.formData.initialBalance,
        fromDate: this.formData.fromDate,
        toDate: this.formData.toDate,
      })
      .subscribe({
        next: () => {
          this.notifications.success('Backtest queued successfully');
          this.showForm.set(false);
          this.loadBtAnalyticsSample();
        },
        error: () => this.notifications.error('Failed to queue backtest'),
      });
  }
}
