import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategyEnsembleService } from '@core/services/strategy-ensemble.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { PagedData, PagerRequest, StrategyAllocationDto } from '@core/api/api.types';
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
            <div class="layout">
              <app-chart-card
                title="Current Allocation"
                subtitle="Portfolio weight distribution"
                [options]="donutChart()"
                height="360px"
              />
              <section class="list">
                <header class="list-head">
                  <h3>Strategy Weights</h3>
                  <span class="muted">Total: {{ (totalWeight() * 100).toFixed(1) }}%</span>
                </header>
                <table class="table">
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
                        <td class="num mono">{{ row.rollingSharpRatio.toFixed(2) }}</td>
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
              </section>
            </div>
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
            <app-chart-card
              title="Allocation over Time"
              subtitle="Weight per strategy at each rebalance"
              [options]="historyChart()!"
              height="420px"
            />
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
