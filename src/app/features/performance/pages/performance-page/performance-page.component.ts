import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, merge, of, throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { PerformanceService } from '@core/services/performance.service';
import type { StrategyPerformanceSnapshotDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RealtimeService } from '@core/realtime/realtime.service';

import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';

@Component({
  selector: 'app-performance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MetricCardComponent,
    ChartCardComponent,
    PageHeaderComponent,
    TabsComponent,
    EmptyStateComponent,
    CardSkeletonComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Performance"
        subtitle="Strategy performance snapshots from the engine"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          @if (loading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (snapshots().length > 0) {
            <!-- 8-card KPI strip — fleet-wide performance roll-ups -->
            <div class="perf-kpis">
              <app-metric-card
                label="Total P&amp;L"
                [value]="totalPnl()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Strategies tracked"
                [value]="snapshots().length"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Profitable"
                [value]="profitableCount()"
                format="number"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Losing"
                [value]="losingCount()"
                format="number"
                [dotColor]="losingCount() > 0 ? '#FF3B30' : '#34C759'"
              />
              <app-metric-card
                label="Avg win rate"
                [value]="avgWinRate() * 100"
                format="percent"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Avg profit factor"
                [value]="avgProfitFactor()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Avg Sharpe"
                [value]="avgSharpe()"
                format="number"
                [colorByValue]="true"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Max drawdown"
                [value]="maxDrawdown()"
                format="percent"
                dotColor="#FF3B30"
              />
            </div>

            <!-- Existing 2-col chart row -->
            <div class="charts-grid">
              <app-chart-card
                title="P&amp;L by Strategy"
                subtitle="Total P&amp;L per active strategy"
                [options]="pnlByStrategyChart()"
                height="320px"
              />
              <app-chart-card
                title="Sharpe Ratio Leaderboard"
                subtitle="Risk-adjusted return by strategy"
                [options]="sharpeChart()"
                height="320px"
              />
            </div>

            <!-- 3-col chart row: health donut + win-rate dist + drawdown dist -->
            <div class="perf-charts">
              <app-chart-card
                title="Health distribution"
                subtitle="Healthy · Degrading · Critical"
                [options]="healthDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="Win-rate distribution"
                subtitle="Histogram of per-strategy win rates"
                [options]="winRateHistogramOptions()"
                height="240px"
              />
              <app-chart-card
                title="Drawdown distribution"
                subtitle="Histogram of per-strategy max drawdown"
                [options]="ddHistogramOptions()"
                height="240px"
              />
            </div>

            <!-- 2-col tables: top winners + worst losers -->
            <div class="perf-board-row">
              <section class="table-card">
                <header class="card-head">
                  <h3>Top winners</h3>
                  <span class="card-sub">Highest total P&amp;L</span>
                </header>
                @if (topWinners().length > 0) {
                  <table class="table compact">
                    <thead>
                      <tr>
                        <th>Strategy</th>
                        <th class="num">P&amp;L</th>
                        <th class="num">Win %</th>
                        <th class="num">Sharpe</th>
                        <th class="num">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of topWinners(); track s.strategyId) {
                        <tr>
                          <td class="mono">#{{ s.strategyId }}</td>
                          <td class="num profit">+{{ (s.totalPnL ?? 0).toFixed(2) }}</td>
                          <td class="num">{{ ((s.winRate ?? 0) * 100).toFixed(1) }}%</td>
                          <td class="num">{{ (s.sharpeRatio ?? 0).toFixed(2) }}</td>
                          <td class="num">{{ s.windowTrades ?? 0 }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="muted" style="padding: var(--space-4)">
                    No profitable strategies in the current window.
                  </p>
                }
              </section>

              <section class="table-card">
                <header class="card-head">
                  <h3>Worst losers</h3>
                  <span class="card-sub">Lowest total P&amp;L — candidates for review</span>
                </header>
                @if (worstLosers().length > 0) {
                  <table class="table compact">
                    <thead>
                      <tr>
                        <th>Strategy</th>
                        <th class="num">P&amp;L</th>
                        <th class="num">Win %</th>
                        <th class="num">Max DD</th>
                        <th class="num">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of worstLosers(); track s.strategyId) {
                        <tr>
                          <td class="mono">#{{ s.strategyId }}</td>
                          <td class="num loss">{{ (s.totalPnL ?? 0).toFixed(2) }}</td>
                          <td class="num">{{ ((s.winRate ?? 0) * 100).toFixed(1) }}%</td>
                          <td class="num loss">{{ (s.maxDrawdownPct ?? 0).toFixed(1) }}%</td>
                          <td class="num">{{ s.windowTrades ?? 0 }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="muted" style="padding: var(--space-4)">
                    No losing strategies — fleet is fully profitable.
                  </p>
                }
              </section>
            </div>

            <section class="table-card">
              <header class="card-head">
                <h3>Strategy Leaderboard</h3>
                <span class="card-sub">{{ snapshots().length }} strategies · sortable below</span>
              </header>
              <div class="lb-scroll">
                <table class="table sticky-head">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th class="num">Trades</th>
                      <th class="num">Win Rate</th>
                      <th class="num">Profit Factor</th>
                      <th class="num">Sharpe</th>
                      <th class="num">Max DD</th>
                      <th class="num">Total P&amp;L</th>
                      <th>Regime</th>
                      <th>Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of snapshots(); track s.strategyId) {
                      <tr>
                        <td class="mono">#{{ s.strategyId }}</td>
                        <td class="num">{{ s.windowTrades ?? 0 }}</td>
                        <td class="num">{{ ((s.winRate ?? 0) * 100).toFixed(1) }}%</td>
                        <td class="num">{{ formatNumber(s.profitFactor) }}</td>
                        <td
                          class="num"
                          [class.profit]="(s.sharpeRatio ?? 0) > 1"
                          [class.loss]="(s.sharpeRatio ?? 0) < 0"
                        >
                          {{ formatNumber(s.sharpeRatio) }}
                        </td>
                        <td class="num loss">{{ (s.maxDrawdownPct ?? 0).toFixed(1) }}%</td>
                        <td
                          class="num"
                          [class.profit]="(s.totalPnL ?? 0) > 0"
                          [class.loss]="(s.totalPnL ?? 0) < 0"
                        >
                          {{ (s.totalPnL ?? 0) >= 0 ? '+' : '' }}{{ (s.totalPnL ?? 0).toFixed(2) }}
                        </td>
                        <td class="mono">{{ s.marketRegime ?? '—' }}</td>
                        <td>
                          <span
                            class="pill"
                            [class.healthy]="s.healthStatus === 'Healthy'"
                            [class.degrading]="s.healthStatus === 'Degrading'"
                            [class.critical]="s.healthStatus === 'Critical'"
                          >
                            {{ s.healthStatus ?? '—' }}
                          </span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          } @else {
            <app-empty-state
              title="No performance snapshots available"
              description="The engine has not yet evaluated any active strategies, or none are running."
            />
          }
        }

        @if (activeTab() === 'attribution') {
          @if (loading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (snapshots().length > 0) {
            <!-- 8-card attribution KPI strip — fleet-wide P&L attribution -->
            <div class="perf-kpis">
              <app-metric-card
                label="Total P&amp;L"
                [value]="totalPnl()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Profitable P&amp;L"
                [value]="positivePnlSum()"
                format="currency"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Losing P&amp;L"
                [value]="negativePnlSum()"
                format="currency"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Healthy share"
                [value]="healthyShare()"
                format="percent"
                [dotColor]="healthyShare() >= 50 ? '#34C759' : '#FF9500'"
              />
              <app-metric-card
                label="Regimes covered"
                [value]="regimesCovered()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Top contributor"
                [value]="topContributorPnl()"
                format="currency"
                [colorByValue]="true"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Top detractor"
                [value]="topDetractorPnl()"
                format="currency"
                [colorByValue]="true"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Concentration (top 3)"
                [value]="top3Concentration()"
                format="percent"
                [dotColor]="top3Concentration() > 60 ? '#FF9500' : '#34C759'"
              />
            </div>

            <!-- Existing 3-col chart row -->
            <div class="perf-charts">
              <app-chart-card
                title="P&amp;L by market regime"
                subtitle="Sum of total P&amp;L bucketed by reported regime"
                [options]="pnlByRegimeOptions()"
                height="280px"
              />
              <app-chart-card
                title="P&amp;L by health bucket"
                subtitle="Healthy strategies typically carry the book"
                [options]="pnlByHealthOptions()"
                height="280px"
              />
              <app-chart-card
                title="Profit-factor distribution"
                subtitle="Histogram of per-strategy profit factor"
                [options]="pfHistogramOptions()"
                height="280px"
              />
            </div>

            <!-- New 2-col: contribution waterfall + per-health breakdown -->
            <div class="perf-board-row">
              <app-chart-card
                title="P&amp;L contribution by strategy"
                subtitle="Each bar = one strategy's net contribution to total book P&amp;L"
                [options]="contributionWaterfallOptions()"
                height="320px"
              />

              <section class="table-card">
                <header class="card-head">
                  <h3>Per-health breakdown</h3>
                  <span class="card-sub">Strategies grouped by health status</span>
                </header>
                <table class="table compact">
                  <thead>
                    <tr>
                      <th>Health</th>
                      <th class="num">Count</th>
                      <th class="num">Total P&amp;L</th>
                      <th class="num">Share %</th>
                      <th class="num">Avg PF</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of perHealthBreakdown(); track row.bucket) {
                      <tr>
                        <td>
                          <span
                            class="pill"
                            [class.healthy]="row.bucket === 'Healthy'"
                            [class.degrading]="row.bucket === 'Degrading'"
                            [class.critical]="row.bucket === 'Critical'"
                          >
                            {{ row.bucket }}
                          </span>
                        </td>
                        <td class="num">{{ row.count }}</td>
                        <td
                          class="num"
                          [class.profit]="row.totalPnl > 0"
                          [class.loss]="row.totalPnl < 0"
                        >
                          {{ row.totalPnl >= 0 ? '+' : '' }}{{ row.totalPnl.toFixed(2) }}
                        </td>
                        <td class="num">{{ row.sharePct.toFixed(1) }}%</td>
                        <td class="num">
                          {{ row.avgPf !== null ? row.avgPf.toFixed(2) : '—' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            </div>

            <section class="table-card">
              <header class="card-head">
                <h3>Per-regime breakdown</h3>
                <span class="card-sub"
                  >Drill into per-strategy attribution at /performance/{{ '{' }}strategyId{{
                    '}'
                  }}</span
                >
              </header>
              <table class="table">
                <thead>
                  <tr>
                    <th>Regime</th>
                    <th class="num">Strategies</th>
                    <th class="num">Total P&amp;L</th>
                    <th class="num">Avg Sharpe</th>
                    <th class="num">Avg PF</th>
                    <th class="num">Avg DD</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perRegimeBreakdown(); track row.regime) {
                    <tr>
                      <td class="mono">{{ row.regime }}</td>
                      <td class="num">{{ row.count }}</td>
                      <td
                        class="num"
                        [class.profit]="row.totalPnl > 0"
                        [class.loss]="row.totalPnl < 0"
                      >
                        {{ row.totalPnl >= 0 ? '+' : '' }}{{ row.totalPnl.toFixed(2) }}
                      </td>
                      <td class="num">
                        {{ row.avgSharpe !== null ? row.avgSharpe.toFixed(2) : '—' }}
                      </td>
                      <td class="num">{{ row.avgPf !== null ? row.avgPf.toFixed(2) : '—' }}</td>
                      <td class="num loss">{{ row.avgDd.toFixed(1) }}%</td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>

            <!-- Per-strategy attribution table — every strategy's contribution
                 to total P&L with share %, sortable & scrollable. -->
            <section class="table-card">
              <header class="card-head">
                <h3>Per-strategy attribution</h3>
                <span class="card-sub">
                  {{ snapshots().length }} strategies · ranked by absolute contribution
                </span>
              </header>
              <div class="lb-scroll">
                <table class="table sticky-head compact">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Regime</th>
                      <th>Health</th>
                      <th class="num">Trades</th>
                      <th class="num">Total P&amp;L</th>
                      <th class="num">Share %</th>
                      <th class="num">Sharpe</th>
                      <th class="num">PF</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of perStrategyAttribution(); track row.strategyId) {
                      <tr>
                        <td class="mono">#{{ row.strategyId }}</td>
                        <td class="mono">{{ row.regime }}</td>
                        <td>
                          <span
                            class="pill"
                            [class.healthy]="row.health === 'Healthy'"
                            [class.degrading]="row.health === 'Degrading'"
                            [class.critical]="row.health === 'Critical'"
                          >
                            {{ row.health }}
                          </span>
                        </td>
                        <td class="num">{{ row.trades }}</td>
                        <td class="num" [class.profit]="row.pnl > 0" [class.loss]="row.pnl < 0">
                          {{ row.pnl >= 0 ? '+' : '' }}{{ row.pnl.toFixed(2) }}
                        </td>
                        <td
                          class="num"
                          [class.profit]="row.sharePct > 0"
                          [class.loss]="row.sharePct < 0"
                        >
                          {{ row.sharePct >= 0 ? '+' : '' }}{{ row.sharePct.toFixed(1) }}%
                        </td>
                        <td class="num">{{ formatNumber(row.sharpe) }}</td>
                        <td class="num">{{ formatNumber(row.pf) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          } @else {
            <app-empty-state
              title="Attribution requires snapshots"
              description="The engine has not yet evaluated any active strategies, or none are running."
            />
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .metrics-row,
      .perf-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .perf-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .perf-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .perf-charts {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .perf-charts {
          grid-template-columns: 1fr;
        }
      }
      .perf-board-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .perf-board-row {
          grid-template-columns: 1fr;
        }
      }
      .table.compact th,
      .table.compact td {
        padding: 6px var(--space-3);
        font-size: var(--text-xs);
      }
      .card-sub {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin-left: var(--space-3);
      }
      .lb-scroll {
        max-height: 480px;
        overflow-y: auto;
      }
      .table.sticky-head thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .table th.num,
      .table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .profit {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      .loss {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .pill.healthy {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill.degrading {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill.critical {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      @media (max-width: 1200px) {
        .metrics-row {
          grid-template-columns: repeat(3, 1fr);
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 768px) {
        .metrics-row {
          grid-template-columns: repeat(2, 1fr);
        }
      }
    `,
  ],
})
export class PerformancePageComponent {
  private readonly service = inject(PerformanceService);
  private readonly realtime = inject(RealtimeService);

  readonly tabs: TabItem[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Attribution', value: 'attribution' },
  ];
  readonly activeTab = signal('overview');

  private readonly resource = createPolledResource(
    () =>
      this.service.getAll().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as StrategyPerformanceSnapshotDto[])),
      ),
    { intervalMs: 60_000 },
  );

  constructor() {
    // Push-refresh the leaderboard when the engine reports a closed position
    // or a new fill — both nudge the per-strategy P&L, Sharpe, win-rate, etc.
    // Throttled at 5s so a burst of rapid fills during a close-out doesn't
    // hammer `/performance/all` while still beating the 60s poll interval.
    merge(this.realtime.on('positionClosed'), this.realtime.on('orderFilled'))
      .pipe(throttleTime(5_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.resource.refresh());
  }

  readonly snapshots = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  // Numeric averages must filter out NaN / Infinity / null — otherwise a
  // single bad snapshot poisons the whole reduce and renders KPI cards as
  // "NaN". Helper keeps the per-metric averages clean.
  private avgOf(
    getter: (x: StrategyPerformanceSnapshotDto) => number | null | undefined,
  ): number | null {
    let sum = 0;
    let count = 0;
    for (const s of this.snapshots()) {
      const v = getter(s);
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  }

  readonly totalPnl = computed(() =>
    this.snapshots().reduce((s, x) => s + (Number.isFinite(x.totalPnL) ? x.totalPnL : 0), 0),
  );
  readonly totalTrades = computed(() =>
    this.snapshots().reduce(
      (s, x) => s + (Number.isFinite(x.windowTrades) ? x.windowTrades : 0),
      0,
    ),
  );
  readonly maxDrawdown = computed(() => {
    const all = this.snapshots()
      .map((x) => x.maxDrawdownPct)
      .filter((v) => v != null && Number.isFinite(v));
    return all.length > 0 ? Math.max(...all) : 0;
  });
  readonly avgWinRate = computed(() => this.avgOf((x) => x.winRate) ?? 0);
  readonly avgProfitFactor = computed(() => this.avgOf((x) => x.profitFactor));
  readonly avgSharpe = computed(() => this.avgOf((x) => x.sharpeRatio) ?? 0);

  // Profitable / losing counts for the new KPI tiles.
  readonly profitableCount = computed(
    () => this.snapshots().filter((x) => (x.totalPnL ?? 0) > 0).length,
  );
  readonly losingCount = computed(
    () => this.snapshots().filter((x) => (x.totalPnL ?? 0) < 0).length,
  );

  readonly topWinners = computed(() =>
    [...this.snapshots()]
      .filter((s) => (s.totalPnL ?? 0) > 0)
      .sort((a, b) => (b.totalPnL ?? 0) - (a.totalPnL ?? 0))
      .slice(0, 6),
  );
  readonly worstLosers = computed(() =>
    [...this.snapshots()]
      .filter((s) => (s.totalPnL ?? 0) < 0)
      .sort((a, b) => (a.totalPnL ?? 0) - (b.totalPnL ?? 0))
      .slice(0, 6),
  );

  readonly healthDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const s of this.snapshots()) {
      const k = s.healthStatus ?? 'Unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Healthy: '#34C759',
      Degrading: '#FF9500',
      Critical: '#FF3B30',
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
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  readonly winRateHistogramOptions = computed<EChartsOption>(() =>
    this.histogram(
      this.snapshots()
        .map((s) => s.winRate)
        .filter((v): v is number => v != null && Number.isFinite(v))
        .map((v) => v * 100),
      '%',
      '#34C759',
    ),
  );

  readonly ddHistogramOptions = computed<EChartsOption>(() =>
    this.histogram(
      this.snapshots()
        .map((s) => s.maxDrawdownPct)
        .filter((v): v is number => v != null && Number.isFinite(v)),
      '%',
      '#FF3B30',
    ),
  );

  readonly pfHistogramOptions = computed<EChartsOption>(() =>
    this.histogram(
      this.snapshots()
        .map((s) => s.profitFactor)
        .filter((v): v is number => v != null && Number.isFinite(v)),
      '',
      '#0071E3',
    ),
  );

  // ── Attribution-tab KPIs ─────────────────────────────────────────────
  readonly positivePnlSum = computed(() =>
    this.snapshots()
      .filter((s) => Number.isFinite(s.totalPnL) && s.totalPnL > 0)
      .reduce((sum, s) => sum + s.totalPnL, 0),
  );
  readonly negativePnlSum = computed(() =>
    this.snapshots()
      .filter((s) => Number.isFinite(s.totalPnL) && s.totalPnL < 0)
      .reduce((sum, s) => sum + s.totalPnL, 0),
  );
  readonly healthyShare = computed(() => {
    const all = this.snapshots();
    if (all.length === 0) return 0;
    return (all.filter((s) => s.healthStatus === 'Healthy').length / all.length) * 100;
  });
  readonly regimesCovered = computed(() => {
    const set = new Set<string>();
    for (const s of this.snapshots()) set.add(s.marketRegime ?? 'Unknown');
    return set.size;
  });
  readonly topContributorPnl = computed(() => {
    const sorted = [...this.snapshots()].sort((a, b) => (b.totalPnL ?? 0) - (a.totalPnL ?? 0));
    return sorted.length > 0 ? (sorted[0].totalPnL ?? 0) : 0;
  });
  readonly topDetractorPnl = computed(() => {
    const sorted = [...this.snapshots()].sort((a, b) => (a.totalPnL ?? 0) - (b.totalPnL ?? 0));
    return sorted.length > 0 ? (sorted[0].totalPnL ?? 0) : 0;
  });
  // Concentration ratio: |top-3 by absolute P&L| / |total absolute P&L|.
  // Tells you whether the book's outcome is driven by a handful of strategies.
  readonly top3Concentration = computed(() => {
    const all = this.snapshots()
      .map((s) => Math.abs(s.totalPnL ?? 0))
      .filter((v) => Number.isFinite(v));
    const total = all.reduce((sum, v) => sum + v, 0);
    if (total === 0) return 0;
    const top3 = [...all]
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((sum, v) => sum + v, 0);
    return (top3 / total) * 100;
  });

  readonly contributionWaterfallOptions = computed<EChartsOption>(() => {
    const sorted = [...this.snapshots()]
      .filter((s) => Number.isFinite(s.totalPnL))
      .sort((a, b) => b.totalPnL - a.totalPnL);
    if (sorted.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 30, bottom: 50, left: 60 },
      xAxis: {
        type: 'category',
        data: sorted.map((s) => `#${s.strategyId}`),
        axisLabel: { fontSize: 9, color: '#6E6E73', interval: 0, rotate: 35 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map((s) => ({
            value: +s.totalPnL.toFixed(2),
            itemStyle: { color: s.totalPnL >= 0 ? '#34C759' : '#FF3B30' },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  readonly perHealthBreakdown = computed(() => {
    type Row = {
      bucket: string;
      count: number;
      totalPnl: number;
      sharePct: number;
      avgPf: number | null;
      _pfSum: number;
      _pfCount: number;
    };
    const groups: Record<string, Row> = {};
    let totalAbsPnl = 0;
    for (const s of this.snapshots()) {
      const k = s.healthStatus ?? 'Unknown';
      if (!groups[k])
        groups[k] = {
          bucket: k,
          count: 0,
          totalPnl: 0,
          sharePct: 0,
          avgPf: null,
          _pfSum: 0,
          _pfCount: 0,
        };
      const g = groups[k];
      g.count++;
      const pnl = Number.isFinite(s.totalPnL) ? s.totalPnL : 0;
      g.totalPnl += pnl;
      totalAbsPnl += Math.abs(pnl);
      if (s.profitFactor != null && Number.isFinite(s.profitFactor)) {
        g._pfSum += s.profitFactor;
        g._pfCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        sharePct: totalAbsPnl > 0 ? (Math.abs(g.totalPnl) / totalAbsPnl) * 100 : 0,
        avgPf: g._pfCount > 0 ? +(g._pfSum / g._pfCount).toFixed(2) : null,
      }))
      .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
  });

  readonly perStrategyAttribution = computed(() => {
    const totalAbs = this.snapshots()
      .map((s) => Math.abs(Number.isFinite(s.totalPnL) ? s.totalPnL : 0))
      .reduce((sum, v) => sum + v, 0);
    return [...this.snapshots()]
      .map((s) => {
        const pnl = Number.isFinite(s.totalPnL) ? s.totalPnL : 0;
        return {
          strategyId: s.strategyId,
          regime: s.marketRegime ?? 'Unknown',
          health: s.healthStatus ?? 'Unknown',
          trades: s.windowTrades ?? 0,
          pnl,
          // Signed share: positive contributors get +%, losers get −%.
          // Computed against |total| so the sum of absolutes is 100%.
          sharePct: totalAbs > 0 ? (pnl / totalAbs) * 100 : 0,
          sharpe: s.sharpeRatio,
          pf: s.profitFactor,
        };
      })
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  });

  // ── Existing per-regime breakdown ─────────────────────────────────────
  readonly perRegimeBreakdown = computed(() => {
    type Row = {
      regime: string;
      count: number;
      totalPnl: number;
      avgSharpe: number | null;
      avgPf: number | null;
      avgDd: number;
      _shSum: number;
      _shCount: number;
      _pfSum: number;
      _pfCount: number;
      _ddSum: number;
      _ddCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const s of this.snapshots()) {
      const k = s.marketRegime ?? 'Unknown';
      if (!groups[k])
        groups[k] = {
          regime: k,
          count: 0,
          totalPnl: 0,
          avgSharpe: null,
          avgPf: null,
          avgDd: 0,
          _shSum: 0,
          _shCount: 0,
          _pfSum: 0,
          _pfCount: 0,
          _ddSum: 0,
          _ddCount: 0,
        };
      const g = groups[k];
      g.count++;
      g.totalPnl += Number.isFinite(s.totalPnL) ? s.totalPnL : 0;
      if (s.sharpeRatio != null && Number.isFinite(s.sharpeRatio)) {
        g._shSum += s.sharpeRatio;
        g._shCount++;
      }
      if (s.profitFactor != null && Number.isFinite(s.profitFactor)) {
        g._pfSum += s.profitFactor;
        g._pfCount++;
      }
      if (s.maxDrawdownPct != null && Number.isFinite(s.maxDrawdownPct)) {
        g._ddSum += s.maxDrawdownPct;
        g._ddCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        avgSharpe: g._shCount > 0 ? +(g._shSum / g._shCount).toFixed(3) : null,
        avgPf: g._pfCount > 0 ? +(g._pfSum / g._pfCount).toFixed(3) : null,
        avgDd: g._ddCount > 0 ? +(g._ddSum / g._ddCount).toFixed(2) : 0,
      }))
      .sort((a, b) => b.totalPnl - a.totalPnl);
  });

  readonly pnlByRegimeOptions = computed<EChartsOption>(() => {
    const rows = this.perRegimeBreakdown();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 40, left: 60 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.regime),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: +r.totalPnl.toFixed(2),
            itemStyle: { color: r.totalPnl >= 0 ? '#34C759' : '#FF3B30' },
          })),
          barWidth: '50%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly pnlByHealthOptions = computed<EChartsOption>(() => {
    const buckets: Record<string, number> = {};
    for (const s of this.snapshots()) {
      const k = s.healthStatus ?? 'Unknown';
      buckets[k] = (buckets[k] ?? 0) + (Number.isFinite(s.totalPnL) ? s.totalPnL : 0);
    }
    const entries = Object.entries(buckets);
    if (entries.length === 0) return {};
    const colors: Record<string, string> = {
      Healthy: '#34C759',
      Degrading: '#FF9500',
      Critical: '#FF3B30',
      Unknown: '#8E8E93',
    };
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 40, left: 60 },
      xAxis: {
        type: 'category',
        data: entries.map(([k]) => k),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'bar',
          data: entries.map(([name, v]) => ({
            value: +v.toFixed(2),
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
          barWidth: '50%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // Generic histogram helper used by win-rate / DD / PF charts.
  private histogram(values: number[], unit: string, color: string): EChartsOption {
    if (values.length === 0) return {};
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) {
      return {
        grid: { top: 10, right: 20, bottom: 30, left: 40 },
        xAxis: { type: 'category', data: [`${min.toFixed(1)}${unit}`] },
        yAxis: { type: 'value' },
        series: [
          { type: 'bar', data: [{ value: values.length, itemStyle: { color } }], barWidth: '40%' },
        ],
      };
    }
    const bins = 10;
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    const labels: string[] = [];
    for (let i = 0; i < bins; i++) labels.push(`${(min + i * width).toFixed(1)}${unit}`);
    for (const v of values) {
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
          data: counts.map((c) => ({ value: c, itemStyle: { color, borderRadius: [4, 4, 0, 0] } })),
          barWidth: '80%',
        },
      ],
    };
  }

  // Format any nullable / non-finite number safely for table cells.
  formatNumber(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
  }

  readonly pnlByStrategyChart = computed<EChartsOption>(() => {
    const data = [...this.snapshots()].sort((a, b) => b.totalPnL - a.totalPnL);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 80, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'value', name: 'P&L' },
      yAxis: { type: 'category', data: data.map((d) => `#${d.strategyId}`) },
      series: [
        {
          type: 'bar',
          data: data.map((d) => ({
            value: d.totalPnL,
            itemStyle: { color: d.totalPnL >= 0 ? '#34C759' : '#FF3B30' },
          })),
          barWidth: '70%',
        },
      ],
    };
  });

  readonly sharpeChart = computed<EChartsOption>(() => {
    const data = [...this.snapshots()].sort((a, b) => b.sharpeRatio - a.sharpeRatio);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 80, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'value', name: 'Sharpe' },
      yAxis: { type: 'category', data: data.map((d) => `#${d.strategyId}`) },
      series: [
        {
          type: 'bar',
          data: data.map((d) => d.sharpeRatio),
          itemStyle: { color: '#0071E3' },
          barWidth: '70%',
        },
      ],
    };
  });
}
