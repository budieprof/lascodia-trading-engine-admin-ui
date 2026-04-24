import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { PerformanceService } from '@core/services/performance.service';
import type { StrategyPerformanceSnapshotDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

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
            <div class="metrics-row">
              <app-metric-card
                label="Total P&amp;L"
                [value]="totalPnl()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Avg Win Rate"
                [value]="avgWinRate() * 100"
                format="percent"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Avg Profit Factor"
                [value]="avgProfitFactor()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Avg Sharpe"
                [value]="avgSharpe()"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Max Drawdown"
                [value]="maxDrawdown()"
                format="percent"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Total Trades"
                [value]="totalTrades()"
                format="number"
                dotColor="#8E8E93"
              />
            </div>

            <div class="charts-grid">
              <app-chart-card
                title="P&amp;L by Strategy"
                subtitle="Total P&amp;L per active strategy"
                [options]="pnlByStrategyChart()"
                height="360px"
              />
              <app-chart-card
                title="Sharpe Ratio Leaderboard"
                subtitle="Risk-adjusted return by strategy"
                [options]="sharpeChart()"
                height="360px"
              />
            </div>

            <section class="table-card">
              <header class="card-head"><h3>Strategy Leaderboard</h3></header>
              <table class="table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th class="num">Trades</th>
                    <th class="num">Win Rate</th>
                    <th class="num">Profit Factor</th>
                    <th class="num">Sharpe</th>
                    <th class="num">Max DD</th>
                    <th class="num">Total P&amp;L</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of snapshots(); track s.strategyId) {
                    <tr>
                      <td>#{{ s.strategyId }}</td>
                      <td class="num">{{ s.windowTrades }}</td>
                      <td class="num">{{ (s.winRate * 100).toFixed(1) }}%</td>
                      <td class="num">{{ s.profitFactor.toFixed(2) }}</td>
                      <td class="num">{{ s.sharpeRatio.toFixed(2) }}</td>
                      <td class="num">{{ s.maxDrawdownPct.toFixed(1) }}%</td>
                      <td class="num" [class.profit]="s.totalPnL > 0" [class.loss]="s.totalPnL < 0">
                        {{ s.totalPnL >= 0 ? '+' : '' }}{{ s.totalPnL.toFixed(2) }}
                      </td>
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
            </section>
          } @else {
            <app-empty-state
              title="No performance snapshots available"
              description="The engine has not yet evaluated any active strategies, or none are running."
            />
          }
        }

        @if (activeTab() === 'attribution') {
          <app-empty-state
            title="Attribution requires per-strategy detail"
            description="Use /performance/{strategyId} for ML alpha / timing alpha / info ratio breakdown. Currently surfaced in the strategy detail page; a consolidated view lands in Phase 4 (Analytics Depth)."
          />
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .metrics-row {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
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

  readonly snapshots = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  readonly totalPnl = computed(() => this.snapshots().reduce((s, x) => s + x.totalPnL, 0));
  readonly totalTrades = computed(() => this.snapshots().reduce((s, x) => s + x.windowTrades, 0));
  readonly maxDrawdown = computed(() =>
    this.snapshots().reduce((m, x) => Math.max(m, x.maxDrawdownPct), 0),
  );
  readonly avgWinRate = computed(() => {
    const s = this.snapshots();
    if (s.length === 0) return 0;
    return s.reduce((acc, x) => acc + x.winRate, 0) / s.length;
  });
  readonly avgProfitFactor = computed(() => {
    const s = this.snapshots();
    if (s.length === 0) return 0;
    return s.reduce((acc, x) => acc + x.profitFactor, 0) / s.length;
  });
  readonly avgSharpe = computed(() => {
    const s = this.snapshots();
    if (s.length === 0) return 0;
    return s.reduce((acc, x) => acc + x.sharpeRatio, 0) / s.length;
  });

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
