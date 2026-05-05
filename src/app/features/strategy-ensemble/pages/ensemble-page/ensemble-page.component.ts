import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategyEnsembleService } from '@core/services/strategy-ensemble.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyAllocationDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

const PALETTE = [
  '#0071E3',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#5AC8FA',
  '#FF3B30',
  '#FFCC00',
  '#30D158',
  '#64D2FF',
  '#BF5AF2',
];

@Component({
  selector: 'app-ensemble-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChartCardComponent,
    PageHeaderComponent,
    TabsComponent,
    EmptyStateComponent,
    CardSkeletonComponent,
    ConfirmDialogComponent,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Ensemble"
        subtitle="Sharpe-weighted allocation across active strategies"
      >
        <button
          type="button"
          class="btn btn-primary"
          [disabled]="rebalancing()"
          (click)="showRebalance.set(true)"
        >
          @if (rebalancing()) {
            <span class="spin"></span>
          } @else {
            Rebalance
          }
        </button>
      </app-page-header>

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'allocation') {
          @if (allocationsLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (allocations().length > 0) {
            <!-- 8-card KPI strip — fleet-wide allocation roll-ups -->
            <div class="ens-kpis">
              <div class="ens-kpi">
                <span class="kpi-label">Active strategies</span>
                <span class="kpi-value">{{ allocations().length }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Total weight</span>
                <span
                  class="kpi-value"
                  [class.bad]="Math.abs(totalWeight() - 1) > 0.01"
                  [class.good]="Math.abs(totalWeight() - 1) <= 0.01"
                >
                  {{ (totalWeight() * 100).toFixed(1) }}%
                </span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Avg Sharpe</span>
                <span
                  class="kpi-value"
                  [class.good]="allocStats().avgSharpe > 1"
                  [class.bad]="allocStats().avgSharpe < 0"
                >
                  {{ allocStats().avgSharpe.toFixed(2) }}
                </span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Best Sharpe</span>
                <span class="kpi-value good">{{ allocStats().bestSharpe.toFixed(2) }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Worst Sharpe</span>
                <span class="kpi-value" [class.bad]="allocStats().worstSharpe < 0">
                  {{ allocStats().worstSharpe.toFixed(2) }}
                </span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Top-1 share</span>
                <span
                  class="kpi-value"
                  [class.bad]="allocStats().topShare > 50"
                  [class.good]="allocStats().topShare <= 50"
                >
                  {{ allocStats().topShare.toFixed(1) }}%
                </span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Top-3 concentration</span>
                <span class="kpi-value" [class.bad]="allocStats().top3Share > 75">
                  {{ allocStats().top3Share.toFixed(1) }}%
                </span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Last rebalance</span>
                <span class="kpi-value sm">{{ allocStats().lastRebalanceLabel }}</span>
              </div>
            </div>

            <div class="layout">
              <app-chart-card
                title="Current Allocation"
                subtitle="Portfolio weight distribution"
                [options]="donutChart()"
                height="320px"
              />
              <section class="list">
                <header class="list-head">
                  <h3>Strategy Weights</h3>
                  <span class="muted">Total: {{ (totalWeight() * 100).toFixed(1) }}%</span>
                </header>
                <div class="ens-scroll">
                  <table class="table sticky-head">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Strategy</th>
                        <th class="num">Weight</th>
                        <th class="num">Sharpe</th>
                        <th>Last Rebalanced</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of rankedAllocations(); track row.id; let i = $index) {
                        <tr>
                          <td>{{ i + 1 }}</td>
                          <td>
                            <span class="dot" [style.background]="colorFor(i)"></span>
                            {{ row.strategyName ?? '#' + row.strategyId }}
                          </td>
                          <td class="num">{{ (row.weight * 100).toFixed(1) }}%</td>
                          <td
                            class="num mono"
                            [class.profit]="row.rollingSharpRatio > 1"
                            [class.loss]="row.rollingSharpRatio < 0"
                          >
                            {{ row.rollingSharpRatio.toFixed(2) }}
                          </td>
                          <td class="muted">
                            {{
                              row.lastRebalancedAt
                                ? (row.lastRebalancedAt | date: 'MMM d, HH:mm')
                                : '—'
                            }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <!-- 2-col chart row: Sharpe leaderboard + Weight vs Sharpe scatter -->
            <div class="ens-charts">
              <app-chart-card
                title="Sharpe leaderboard"
                subtitle="Rolling Sharpe across active strategies"
                [options]="sharpeBarOptions()"
                height="280px"
              />
              <app-chart-card
                title="Weight vs Sharpe"
                subtitle="Each dot = one strategy · is the engine sizing the right edge?"
                [options]="weightSharpeScatterOptions()"
                height="280px"
              />
            </div>

            <!-- Per-symbol breakdown: how the allocation maps onto symbols -->
            @if (perSymbolBreakdown().length > 0) {
              <section class="ens-board">
                <header class="ens-board-head">
                  <h3>Per-symbol allocation</h3>
                  <span class="muted">
                    Aggregated weight + avg Sharpe per symbol — diversification view
                  </span>
                </header>
                <table class="ens-board-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="num">Strategies</th>
                      <th class="num">Weight</th>
                      <th class="num">Avg Sharpe</th>
                      <th>Strategy IDs</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of perSymbolBreakdown(); track row.symbol) {
                      <tr>
                        <td class="mono">{{ row.symbol }}</td>
                        <td class="num mono">{{ row.count }}</td>
                        <td class="num mono">{{ (row.weight * 100).toFixed(1) }}%</td>
                        <td
                          class="num mono"
                          [class.profit]="row.avgSharpe > 1"
                          [class.loss]="row.avgSharpe < 0"
                        >
                          {{ row.avgSharpe.toFixed(2) }}
                        </td>
                        <td class="ens-pair-list">
                          @for (id of row.strategyIds; track id) {
                            <span class="ens-pill">#{{ id }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }
          } @else {
            <app-empty-state
              title="No active allocations"
              description="Activate strategies and run a rebalance to populate allocations."
              actionLabel="Rebalance Now"
              (actionClick)="showRebalance.set(true)"
            />
          }
        }

        @if (activeTab() === 'history') {
          @if (historyLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (historyChart()) {
            <!-- 6-card KPI strip — historical rebalance stats -->
            <div class="ens-kpis ens-kpis-six">
              <div class="ens-kpi">
                <span class="kpi-label">Rebalance events</span>
                <span class="kpi-value">{{ historyStats().rebalanceCount }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Strategies tracked</span>
                <span class="kpi-value">{{ historyStats().strategyCount }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">First rebalance</span>
                <span class="kpi-value sm">{{ historyStats().firstDate }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Last rebalance</span>
                <span class="kpi-value sm">{{ historyStats().lastDate }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Avg cadence</span>
                <span class="kpi-value sm">{{ historyStats().avgCadence }}</span>
              </div>
              <div class="ens-kpi">
                <span class="kpi-label">Most-allocated</span>
                <span class="kpi-value sm">{{ historyStats().topStrategyName }}</span>
              </div>
            </div>

            <!-- 2-col chart row: time-series + latest-snapshot donut.
                 The over-time chart is sparse with a single rebalance event;
                 pairing it with the latest snapshot makes both useful from
                 day one. -->
            <div class="ens-charts">
              <app-chart-card
                title="Allocation over Time"
                subtitle="Weight per strategy at each rebalance"
                [options]="historyChart()!"
                height="320px"
              />
              <app-chart-card
                title="Latest rebalance snapshot"
                subtitle="Weights from the most-recent rebalance event"
                [options]="latestSnapshotDonutOptions()"
                height="320px"
              />
            </div>

            <!-- 2-col: avg weight bar + rebalance frequency by week -->
            <div class="ens-charts">
              <app-chart-card
                title="Avg weight by strategy"
                subtitle="Time-averaged across every rebalance event"
                [options]="avgWeightBarOptions()"
                height="280px"
              />
              <app-chart-card
                title="Rebalance frequency"
                subtitle="Rebalance events per ISO week"
                [options]="rebalanceFrequencyOptions()"
                height="280px"
              />
            </div>

            <!-- Per-strategy history table — total time at the table + max weight ever held -->
            @if (perStrategyHistory().length > 0) {
              <section class="ens-board">
                <header class="ens-board-head">
                  <h3>Per-strategy history</h3>
                  <span class="muted">
                    How often each strategy has been allocated and its max weight
                  </span>
                </header>
                <div class="ens-scroll">
                  <table class="ens-board-table sticky-head">
                    <thead>
                      <tr>
                        <th>Strategy</th>
                        <th class="num">Appearances</th>
                        <th class="num">Avg weight</th>
                        <th class="num">Max weight</th>
                        <th class="num">Latest weight</th>
                        <th class="num">Δ since prev</th>
                        <th class="num">Latest Sharpe</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of perStrategyHistory(); track row.strategyId) {
                        <tr>
                          <td class="mono">{{ row.strategyName }}</td>
                          <td class="num mono">{{ row.appearances }}</td>
                          <td class="num mono">{{ (row.avgWeight * 100).toFixed(1) }}%</td>
                          <td class="num mono">{{ (row.maxWeight * 100).toFixed(1) }}%</td>
                          <td class="num mono">{{ (row.latestWeight * 100).toFixed(1) }}%</td>
                          <td
                            class="num mono"
                            [class.profit]="row.deltaPct !== null && row.deltaPct > 0"
                            [class.loss]="row.deltaPct !== null && row.deltaPct < 0"
                          >
                            @if (row.deltaPct === null) {
                              —
                            } @else {
                              {{ row.deltaPct >= 0 ? '+' : '' }}{{ row.deltaPct.toFixed(1) }}pp
                            }
                          </td>
                          <td
                            class="num mono"
                            [class.profit]="row.latestSharpe > 1"
                            [class.loss]="row.latestSharpe < 0"
                          >
                            {{ row.latestSharpe.toFixed(2) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }

            <!-- Rebalance log — each event with its allocated strategies -->
            @if (rebalanceLog().length > 0) {
              <section class="ens-board">
                <header class="ens-board-head">
                  <h3>Rebalance log</h3>
                  <span class="muted">
                    Every rebalance event grouped by date · {{ rebalanceLog().length }} total
                  </span>
                </header>
                <div class="ens-scroll">
                  <table class="ens-board-table sticky-head">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th class="num">Strategies</th>
                        <th class="num">Total weight</th>
                        <th class="num">Top weight</th>
                        <th>Top strategy</th>
                        <th>Members</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of rebalanceLog(); track row.date) {
                        <tr>
                          <td class="mono">{{ row.date }}</td>
                          <td class="num mono">{{ row.strategies }}</td>
                          <td class="num mono">{{ (row.totalWeight * 100).toFixed(1) }}%</td>
                          <td class="num mono">{{ (row.topWeight * 100).toFixed(1) }}%</td>
                          <td class="mono">{{ row.topStrategy }}</td>
                          <td class="ens-pair-list">
                            @for (id of row.strategyIds; track id) {
                              <span class="ens-pill">#{{ id }}</span>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }
          } @else {
            <app-empty-state
              title="No historical allocations"
              description="Allocation history populates as the ensemble rebalances over time."
            />
          }
        }
      </ui-tabs>

      <app-confirm-dialog
        [open]="showRebalance()"
        title="Rebalance Ensemble"
        message="Recompute weights from rolling Sharpe ratios. Active strategies will have their positions sized to match the new weights going forward."
        confirmLabel="Rebalance"
        confirmVariant="primary"
        [loading]="rebalancing()"
        (confirm)="doRebalance()"
        (cancelled)="showRebalance.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .layout {
        display: grid;
        grid-template-columns: 1fr 1.5fr;
        gap: var(--space-4);
      }
      .list {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .list-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .list-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
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
        vertical-align: middle;
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
      .table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-right: var(--space-2);
        vertical-align: middle;
      }
      .spin {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (max-width: 1024px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }

      /* Ensemble density additions */
      .ens-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      .ens-kpis.ens-kpis-six {
        grid-template-columns: repeat(6, 1fr);
      }
      @media (max-width: 1400px) {
        .ens-kpis,
        .ens-kpis.ens-kpis-six {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .ens-kpis,
        .ens-kpis.ens-kpis-six {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .ens-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 4px;
        /* Fixed min-height so a card with a wrapping date value doesn't
           push its row taller than the others. */
        min-height: 72px;
      }
      .ens-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ens-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ens-kpi .kpi-value.good {
        color: var(--profit);
      }
      .ens-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .ens-kpi .kpi-value.sm {
        font-size: var(--text-sm);
        white-space: normal;
        line-height: 1.3;
      }

      /* Page sections inside ui-tabs don't inherit .page's flex gap, so
         each needs its own bottom margin to keep the rhythm consistent. */
      .layout {
        margin-bottom: var(--space-3);
      }
      .ens-charts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .ens-board {
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .ens-charts {
          grid-template-columns: 1fr;
        }
      }

      .ens-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .ens-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .ens-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .ens-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .ens-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .ens-board-table th,
      .ens-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .ens-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .ens-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ens-board-table th.num,
      .ens-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .ens-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .ens-board-table .profit {
        color: var(--profit);
      }
      .ens-board-table .loss {
        color: var(--loss);
      }
      .ens-pair-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .ens-pill {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      /* Sharpe color in the existing table */
      .table .profit {
        color: var(--profit);
      }
      .table .loss {
        color: var(--loss);
      }

      /* Cap the strategy weights table at a sensible height with sticky header */
      .ens-scroll {
        max-height: 360px;
        overflow-y: auto;
      }
      .table.sticky-head thead th,
      .ens-board-table.sticky-head thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
    `,
  ],
})
export class EnsemblePageComponent {
  private readonly service = inject(StrategyEnsembleService);
  private readonly notifications = inject(NotificationService);

  readonly tabs: TabItem[] = [
    { label: 'Current Allocation', value: 'allocation' },
    { label: 'Allocation History', value: 'history' },
  ];
  readonly activeTab = signal('allocation');

  readonly showRebalance = signal(false);
  readonly rebalancing = signal(false);

  private readonly allocationsResource = createPolledResource(
    () =>
      this.service.getAllocations().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as StrategyAllocationDto[])),
      ),
    { intervalMs: 60_000 },
  );

  readonly allocations = computed(() => this.allocationsResource.value() ?? []);
  readonly allocationsLoading = computed(
    () => this.allocationsResource.loading() && this.allocationsResource.value() === null,
  );

  readonly rankedAllocations = computed(() =>
    [...this.allocations()].sort((a, b) => b.weight - a.weight),
  );
  readonly totalWeight = computed(() => this.allocations().reduce((s, a) => s + a.weight, 0));

  // Exposed so templates can call Math.abs() in [class] bindings.
  readonly Math = Math;

  // ── Allocation tab — analytics roll-ups ─────────────────────────────
  readonly allocStats = computed(() => {
    const all = this.allocations();
    if (all.length === 0) {
      return {
        avgSharpe: 0,
        bestSharpe: 0,
        worstSharpe: 0,
        topShare: 0,
        top3Share: 0,
        lastRebalanceLabel: '—',
      };
    }
    const sharpes = all.map((a) => a.rollingSharpRatio).filter((v) => Number.isFinite(v));
    const sortedByWeight = [...all].sort((a, b) => b.weight - a.weight);
    const total = all.reduce((s, a) => s + a.weight, 0) || 1;
    const top3 = sortedByWeight.slice(0, 3).reduce((s, a) => s + a.weight, 0);
    const lastRebalance = all
      .map((a) => (a.lastRebalancedAt ? new Date(a.lastRebalancedAt).getTime() : 0))
      .filter((t) => t > 0)
      .sort((a, b) => b - a)[0];
    return {
      avgSharpe: sharpes.length > 0 ? sharpes.reduce((s, v) => s + v, 0) / sharpes.length : 0,
      bestSharpe: sharpes.length > 0 ? Math.max(...sharpes) : 0,
      worstSharpe: sharpes.length > 0 ? Math.min(...sharpes) : 0,
      topShare: (sortedByWeight[0].weight / total) * 100,
      top3Share: (top3 / total) * 100,
      lastRebalanceLabel: lastRebalance
        ? new Date(lastRebalance).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '—',
    };
  });

  readonly sharpeBarOptions = computed<EChartsOption>(() => {
    const data = [...this.allocations()]
      .filter((a) => Number.isFinite(a.rollingSharpRatio))
      .sort((a, b) => b.rollingSharpRatio - a.rollingSharpRatio);
    if (data.length === 0) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 30, left: 140 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: data.map((d) => d.strategyName ?? `#${d.strategyId}`).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: data
            .map((d) => ({
              value: +d.rollingSharpRatio.toFixed(3),
              itemStyle: {
                color:
                  d.rollingSharpRatio > 1
                    ? '#34C759'
                    : d.rollingSharpRatio < 0
                      ? '#FF3B30'
                      : '#0071E3',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly weightSharpeScatterOptions = computed<EChartsOption>(() => {
    const allocs = this.allocations().filter((a) => Number.isFinite(a.rollingSharpRatio));
    if (allocs.length === 0) return {};
    // Detect collisions: when two or more strategies share the same
    // (Sharpe, weight) coordinate, jitter their labels via dataIndex so
    // they don't render on top of each other (otherwise a degenerate
    // post-rebalance state with N identical strategies stacks N labels).
    const buckets = new Map<string, number>();
    const data = allocs.map((a, i) => {
      const x = +a.rollingSharpRatio.toFixed(3);
      const y = +(a.weight * 100).toFixed(2);
      const key = `${x}|${y}`;
      const collisionIdx = buckets.get(key) ?? 0;
      buckets.set(key, collisionIdx + 1);
      return {
        name: a.strategyName ?? `#${a.strategyId}`,
        value: [x, y],
        itemStyle: { color: PALETTE[i % PALETTE.length] },
        // Stagger label position to avoid stacking — each successive collider
        // gets pushed further right of the marker.
        _collision: collisionIdx,
      };
    });
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) =>
          `${p.data.name}<br/>Sharpe: ${p.value[0]}<br/>Weight: ${p.value[1]}%`,
      },
      legend: {
        bottom: 0,
        type: 'scroll',
        textStyle: { fontSize: 10, color: '#6E6E73' },
        data: data.map((d) => d.name),
      },
      grid: { top: 20, right: 30, bottom: 60, left: 50 },
      xAxis: {
        type: 'value',
        name: 'Sharpe',
        nameLocation: 'middle',
        nameGap: 28,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'value',
        name: 'Weight %',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      // One series per strategy so the legend can toggle them individually
      // and each marker is independently selectable.
      series: data.map((d) => ({
        name: d.name,
        type: 'scatter',
        data: [d.value],
        symbolSize: 16,
        itemStyle: d.itemStyle,
        // Hide the in-chart label entirely when there's a collision (the
        // legend below covers identification); otherwise show a small label.
        label: {
          show: d._collision === 0,
          position: 'right',
          distance: 8,
          fontSize: 10,
          color: '#6E6E73',
          formatter: () => d.name,
        },
      })),
    };
  });

  readonly perSymbolBreakdown = computed(() => {
    type Row = {
      symbol: string;
      count: number;
      weight: number;
      avgSharpe: number;
      strategyIds: number[];
      _sharpeSum: number;
    };
    const groups: Record<string, Row> = {};
    for (const a of this.allocations()) {
      // Best-effort symbol extraction from "EURUSD MA Crossover H1" naming.
      const name = a.strategyName ?? '';
      const match = name.match(/^([A-Z]{6})/);
      const symbol = match ? match[1] : 'unknown';
      if (!groups[symbol])
        groups[symbol] = {
          symbol,
          count: 0,
          weight: 0,
          avgSharpe: 0,
          strategyIds: [],
          _sharpeSum: 0,
        };
      const g = groups[symbol];
      g.count++;
      g.weight += a.weight;
      g._sharpeSum += Number.isFinite(a.rollingSharpRatio) ? a.rollingSharpRatio : 0;
      g.strategyIds.push(a.strategyId);
    }
    return Object.values(groups)
      .map((g) => ({ ...g, avgSharpe: g._sharpeSum / g.count }))
      .sort((a, b) => b.weight - a.weight);
  });

  // ── History tab — analytics roll-ups ────────────────────────────────
  readonly historyStats = computed(() => {
    const rows = this.historyResource.value() ?? [];
    if (rows.length === 0) {
      return {
        rebalanceCount: 0,
        strategyCount: 0,
        firstDate: '—',
        lastDate: '—',
        avgCadence: '—',
        topStrategyName: '—',
      };
    }
    const dates = new Set<string>();
    const strategies = new Set<number>();
    const weightsByStrategy = new Map<number, { name: string; sumWeight: number }>();
    for (const r of rows) {
      if (r.lastRebalancedAt) dates.add(r.lastRebalancedAt.slice(0, 10));
      strategies.add(r.strategyId);
      const existing = weightsByStrategy.get(r.strategyId);
      if (existing) {
        existing.sumWeight += r.weight;
      } else {
        weightsByStrategy.set(r.strategyId, {
          name: r.strategyName ?? `#${r.strategyId}`,
          sumWeight: r.weight,
        });
      }
    }
    const sortedDates = Array.from(dates).sort();
    let avgCadence = '—';
    if (sortedDates.length >= 2) {
      const first = new Date(sortedDates[0]).getTime();
      const last = new Date(sortedDates[sortedDates.length - 1]).getTime();
      const days = (last - first) / 86400000;
      const intervals = sortedDates.length - 1;
      const avgDays = intervals > 0 ? days / intervals : 0;
      avgCadence = avgDays >= 1 ? `${avgDays.toFixed(1)}d` : `${(avgDays * 24).toFixed(1)}h`;
    }
    let topName = '—';
    let topSum = -Infinity;
    for (const v of weightsByStrategy.values()) {
      if (v.sumWeight > topSum) {
        topSum = v.sumWeight;
        topName = v.name;
      }
    }
    return {
      rebalanceCount: dates.size,
      strategyCount: strategies.size,
      firstDate: sortedDates[0] ?? '—',
      lastDate: sortedDates[sortedDates.length - 1] ?? '—',
      avgCadence,
      topStrategyName: topName,
    };
  });

  readonly perStrategyHistory = computed(() => {
    const rows = this.historyResource.value() ?? [];
    if (rows.length === 0) return [];
    type Row = {
      strategyId: number;
      strategyName: string;
      appearances: number;
      avgWeight: number;
      maxWeight: number;
      latestWeight: number;
      // Δ since previous rebalance — null when only one event exists.
      deltaPct: number | null;
      latestSharpe: number;
      _sumWeight: number;
      _latestTime: number;
      _prevWeight: number | null;
      _prevTime: number;
    };
    const groups: Record<number, Row> = {};
    // Process rows in chronological order so prev/latest weights end up
    // correct regardless of API insertion order.
    const sorted = [...rows].sort((a, b) => {
      const ta = a.lastRebalancedAt ? new Date(a.lastRebalancedAt).getTime() : 0;
      const tb = b.lastRebalancedAt ? new Date(b.lastRebalancedAt).getTime() : 0;
      return ta - tb;
    });
    for (const r of sorted) {
      if (!groups[r.strategyId])
        groups[r.strategyId] = {
          strategyId: r.strategyId,
          strategyName: r.strategyName ?? `#${r.strategyId}`,
          appearances: 0,
          avgWeight: 0,
          maxWeight: 0,
          latestWeight: 0,
          deltaPct: null,
          latestSharpe: 0,
          _sumWeight: 0,
          _latestTime: 0,
          _prevWeight: null,
          _prevTime: 0,
        };
      const g = groups[r.strategyId];
      g.appearances++;
      g._sumWeight += r.weight;
      if (r.weight > g.maxWeight) g.maxWeight = r.weight;
      const t = r.lastRebalancedAt ? new Date(r.lastRebalancedAt).getTime() : 0;
      if (t >= g._latestTime) {
        // Demote the current latest to prev, then take the new latest.
        if (g._latestTime > 0) {
          g._prevWeight = g.latestWeight;
          g._prevTime = g._latestTime;
        }
        g._latestTime = t;
        g.latestWeight = r.weight;
        g.latestSharpe = r.rollingSharpRatio;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        avgWeight: g._sumWeight / g.appearances,
        deltaPct:
          g._prevWeight != null ? +((g.latestWeight - g._prevWeight) * 100).toFixed(2) : null,
      }))
      .sort((a, b) => b.maxWeight - a.maxWeight);
  });

  // Latest rebalance snapshot — for the donut on the history tab.
  readonly latestSnapshotDonutOptions = computed<EChartsOption>(() => {
    const rows = this.historyResource.value() ?? [];
    if (rows.length === 0) return {};
    // Find the latest rebalance day, then aggregate every entry on that day.
    let latestDay = '';
    let latestTime = 0;
    for (const r of rows) {
      if (!r.lastRebalancedAt) continue;
      const t = new Date(r.lastRebalancedAt).getTime();
      if (t > latestTime) {
        latestTime = t;
        latestDay = r.lastRebalancedAt.slice(0, 10);
      }
    }
    if (!latestDay) return {};
    const onLatest = rows.filter(
      (r) => r.lastRebalancedAt && r.lastRebalancedAt.slice(0, 10) === latestDay,
    );
    const data = onLatest
      .sort((a, b) => b.weight - a.weight)
      .map((r, i) => ({
        name: r.strategyName ?? `#${r.strategyId}`,
        value: +(r.weight * 100).toFixed(2),
        itemStyle: { color: PALETTE[i % PALETTE.length] },
      }));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 11 },
          data,
        },
      ],
    };
  });

  readonly avgWeightBarOptions = computed<EChartsOption>(() => {
    const rows = this.perStrategyHistory();
    if (rows.length === 0) return {};
    const sorted = [...rows].sort((a, b) => b.avgWeight - a.avgWeight).slice(0, 12);
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 30, left: 140 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: (v: number) => v + '%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((d) => d.strategyName).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: sorted
            .map((d, i) => ({
              value: +(d.avgWeight * 100).toFixed(2),
              itemStyle: { color: PALETTE[i % PALETTE.length], borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: '{c}%',
          },
        },
      ],
    };
  });

  readonly rebalanceFrequencyOptions = computed<EChartsOption>(() => {
    const rows = this.historyResource.value() ?? [];
    if (rows.length === 0) return {};
    // Group rebalance days by ISO week (YYYY-Www).
    const dayBuckets = new Map<string, number>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.lastRebalancedAt) continue;
      const day = r.lastRebalancedAt.slice(0, 10);
      if (seen.has(day)) continue;
      seen.add(day);
      const week = isoWeekLabel(new Date(r.lastRebalancedAt));
      dayBuckets.set(week, (dayBuckets.get(week) ?? 0) + 1);
    }
    if (dayBuckets.size === 0) return {};
    const entries = Array.from(dayBuckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: entries.map(([w]) => w),
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
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color: '#5AC8FA', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  readonly rebalanceLog = computed(() => {
    const rows = this.historyResource.value() ?? [];
    if (rows.length === 0) return [];
    type LogRow = {
      date: string;
      strategies: number;
      totalWeight: number;
      topWeight: number;
      topStrategy: string;
      strategyIds: number[];
    };
    const buckets = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r.lastRebalancedAt) continue;
      const key = r.lastRebalancedAt.slice(0, 10);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    const out: LogRow[] = [];
    for (const [date, group] of buckets) {
      const sorted = [...group].sort((a, b) => b.weight - a.weight);
      out.push({
        date,
        strategies: group.length,
        totalWeight: group.reduce((s, r) => s + r.weight, 0),
        topWeight: sorted[0].weight,
        topStrategy: sorted[0].strategyName ?? `#${sorted[0].strategyId}`,
        strategyIds: group.map((r) => r.strategyId),
      });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  });

  readonly donutChart = computed<EChartsOption>(() => {
    const data = this.rankedAllocations().map((a, i) => ({
      name: a.strategyName ?? `#${a.strategyId}`,
      value: +(a.weight * 100).toFixed(2),
      itemStyle: { color: PALETTE[i % PALETTE.length] },
    }));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 11 },
          data,
        },
      ],
    };
  });

  private readonly historyResource = createPolledResource(
    () =>
      this.service.list({ currentPage: 1, itemCountPerPage: 500 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as StrategyAllocationDto[])),
      ),
    { intervalMs: 300_000 },
  );

  readonly historyLoading = computed(
    () => this.historyResource.loading() && this.historyResource.value() === null,
  );

  readonly historyChart = computed<EChartsOption | null>(() => {
    const rows = this.historyResource.value() ?? [];
    if (rows.length === 0) return null;

    // Group by lastRebalancedAt (date granularity) → for each date, map strategyId → weight.
    const buckets = new Map<string, Map<number, number>>();
    const strategyNames = new Map<number, string>();
    for (const row of rows) {
      if (!row.lastRebalancedAt) continue;
      const key = row.lastRebalancedAt.slice(0, 10); // YYYY-MM-DD
      if (!buckets.has(key)) buckets.set(key, new Map());
      buckets.get(key)!.set(row.strategyId, row.weight);
      strategyNames.set(row.strategyId, row.strategyName ?? `#${row.strategyId}`);
    }
    if (buckets.size === 0) return null;

    const dates = Array.from(buckets.keys()).sort();
    const strategyIds = Array.from(strategyNames.keys());
    const series = strategyIds.map((id, i) => ({
      name: strategyNames.get(id)!,
      type: 'line' as const,
      stack: 'total',
      areaStyle: { color: PALETTE[i % PALETTE.length], opacity: 0.5 },
      lineStyle: { width: 0 },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      emphasis: { focus: 'series' as const },
      data: dates.map((d) => {
        const w = buckets.get(d)?.get(id) ?? 0;
        return +(w * 100).toFixed(2);
      }),
    }));

    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, type: 'scroll' },
      grid: { left: 60, right: 20, top: 20, bottom: 60 },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'Weight %', max: 100 },
      series,
    };
  });

  colorFor(index: number): string {
    return PALETTE[index % PALETTE.length];
  }

  doRebalance(): void {
    this.rebalancing.set(true);
    this.service.rebalance().subscribe({
      next: (res) => {
        this.rebalancing.set(false);
        this.showRebalance.set(false);
        if (res.status) {
          this.notifications.success('Ensemble rebalanced');
          this.allocationsResource.refresh();
          this.historyResource.refresh();
        } else {
          this.notifications.error(res.message ?? 'Rebalance failed');
        }
      },
      error: () => {
        this.rebalancing.set(false);
        this.showRebalance.set(false);
      },
    });
  }
}

// ISO 8601 week label (`YYYY-Www`) — used to bucket rebalance events on the
// frequency chart. Standalone helper so it stays out of the component class.
function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year per ISO 8601.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
