import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, filter, map, of, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { BacktestsService } from '@core/services/backtests.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  BacktestRunDto,
  OptimizationRunDto,
  PagedData,
  PagerRequest,
  StrategyDto,
  StrategyPerformanceSnapshotDto,
  StrategyRejectionDistributionDto,
  StrategyVariantDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, type TabItem } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { StrategyActivityContextComponent } from '../../components/strategy-activity-context/strategy-activity-context.component';
import { StrategyCapacityCardComponent } from '../../components/strategy-capacity-card/strategy-capacity-card.component';

/**
 * Strategy analytics deep-dive — the seven-tab page sketched in the dashboard
 * plan. Three tabs ship fully wired (Performance, Backtests, Optimizations);
 * the rest render a "coming soon" placeholder so the IA reads complete and
 * the URL/tab params are stable for future fills.
 */
/** True for a backtest row that closed no trade — its ratios were never measured. */
function noTradeRun(row: { totalTrades: number | null } | undefined): boolean {
  return row?.totalTrades === 0;
}

@Component({
  selector: 'app-strategy-analytics-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    TabsComponent,
    ChartCardComponent,
    DataTableComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    RelativeTimePipe,
    StrategyActivityContextComponent,
    StrategyCapacityCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Analytics — ' + (strategyName() ?? '#' + strategyId)"
        subtitle="Performance, backtests, optimizations & more"
      >
        <button class="btn-ghost" (click)="goBack()">← Detail</button>
      </app-page-header>

      <!-- A strategy with no live history: what it would do and why it has not, above every tab. -->
      @if (!perfLoading() && !perfChartOptions() && strategy(); as s) {
        <app-strategy-activity-context
          [strategy]="s"
          lead="No live performance history — its evidence and why it is quiet"
        />
      }

      <ui-tabs [tabs]="tabs" [activeTab]="activeTab()" (activeTabChange)="onTabChange($event)">
        @if (activeTab() === 'performance') {
          @if (perfLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (perfChartOptions()) {
            <app-chart-card
              title="Health & risk over time"
              subtitle="60s snapshots, oldest left"
              [options]="perfChartOptions()!"
              height="380px"
            />
          } @else {
            <app-empty-state title="No performance history yet" [description]="perfEmptyText()" />
          }
        }

        @if (activeTab() === 'backtests') {
          <app-data-table
            #backtestsTable
            [columnDefs]="backtestColumns"
            [fetchData]="fetchBacktests"
            stateKey="strategy-backtests"
            emptyTitle="No backtest of this strategy"
            emptyDescription="Queue one from the strategy's Backtests tab — promotion needs a completed run on its own symbol and timeframe at current costs."
          />
        }

        @if (activeTab() === 'optimizations') {
          <app-data-table
            #optimizationsTable
            [columnDefs]="optimizationColumns"
            [fetchData]="fetchOptimizations"
            stateKey="strategy-optimizations"
            emptyTitle="No optimization run for this strategy"
            emptyDescription="The optimizer queues a run when an Active strategy's health turns Critical; you can also start a parameter search from the strategy's Optimization tab."
          />
        }

        @if (activeTab() === 'capacity') {
          <!-- Same card as the detail page's Capacity tab: chart when profiled, the sweep's real
               switch state when not. -->
          <app-strategy-capacity-card [strategyId]="strategyId" />
        }

        @if (activeTab() === 'variants') {
          @if (variantsLoading()) {
            <app-card-skeleton [lines]="4" />
          } @else if (variants().length > 0) {
            <div class="table-scroll">
              <table class="variants-table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th class="num">Shadow signals</th>
                    <th class="num">Win rate (Δ)</th>
                    <th class="num">EV (Δ)</th>
                    <th class="num">Sharpe</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (v of variants(); track v.id) {
                    <tr>
                      <td>{{ v.name }}</td>
                      <td class="num">{{ v.shadowSignalCount }}/{{ v.requiredSignals }}</td>
                      <td class="num" [attr.data-delta]="winRateDelta(v) >= 0 ? 'up' : 'down'">
                        {{ (v.shadowWinRate * 100).toFixed(1) }}% ({{
                          winRateDelta(v) >= 0 ? '+' : ''
                        }}{{ winRateDelta(v).toFixed(1) }}pp)
                      </td>
                      <td class="num" [attr.data-delta]="evDelta(v) >= 0 ? 'up' : 'down'">
                        {{ v.shadowExpectedValue.toFixed(2) }}
                        ({{ evDelta(v) >= 0 ? '+' : '' }}{{ evDelta(v).toFixed(2) }})
                      </td>
                      <td class="num">{{ v.shadowSharpeRatio.toFixed(2) }}</td>
                      <td>
                        @if (v.isPromoted) {
                          <span class="pill promoted">Promoted</span>
                        } @else if (v.isActive) {
                          <span class="pill running">Running</span>
                        } @else {
                          <span class="pill ended">Ended</span>
                        }
                      </td>
                      <td>{{ v.startedAt | relativeTime }}</td>
                      <td>
                        @if (!v.isPromoted) {
                          <button
                            type="button"
                            class="promote-btn"
                            [disabled]="promotingVariantId() !== null"
                            (click)="promoteVariant(v.id)"
                          >
                            {{ promotingVariantId() === v.id ? 'Promoting…' : 'Promote' }}
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <app-empty-state
              title="No variants for this strategy"
              description="Create A/B shadow variants from the Variants tab on the strategy detail page; they will appear here with their shadow results."
            />
          }
        }

        @if (activeTab() === 'regime') {
          @if (regimeChartOptions(); as opts) {
            <app-chart-card
              title="Snapshots by market regime"
              subtitle="How many of the last {{
                regimeSampleSize()
              }} snapshots landed in each regime, with mean health"
              [options]="opts"
              height="360px"
            />
          } @else {
            <app-empty-state
              title="No regime breakdown available"
              [description]="regimeEmptyText()"
            />
          }
        }

        @if (activeTab() === 'rejections') {
          @if (rejectionsLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (rejections(); as r) {
            @if (r.totalRejections > 0) {
              <div class="rejections-meta">
                <div>
                  <span class="meta-label">Total rejections</span>
                  <span class="meta-value">{{ r.totalRejections }}</span>
                </div>
                <div>
                  <span class="meta-label">Stages hit</span>
                  <span class="meta-value">{{ r.stages.length }}</span>
                </div>
                <div>
                  <span class="meta-label">Worst stage</span>
                  <span class="meta-value">{{ r.stages[0]?.stage ?? '—' }}</span>
                </div>
              </div>
              @if (rejectionChartOptions(); as opts) {
                <app-chart-card
                  title="Rejections by pipeline stage"
                  subtitle="Stages ordered by total count desc; reasons drilled in below"
                  [options]="opts"
                  height="320px"
                />
              }
              <div class="table-scroll">
                <table class="rejections-table">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Reason</th>
                      <th class="num">Count</th>
                      <th>First seen</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (stage of r.stages; track stage.stage) {
                      @for (reason of stage.reasons; track reason.reason) {
                        <tr>
                          <td>{{ stage.stage }}</td>
                          <td class="reason">{{ reason.reason }}</td>
                          <td class="num">{{ reason.count }}</td>
                          <td>{{ reason.firstSeen | relativeTime }}</td>
                          <td>{{ reason.lastSeen | relativeTime }}</td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <app-empty-state
                title="No rejections recorded"
                [description]="
                  strategy()?.lastSignalAt
                    ? 'This strategy has no pipeline rejections in the audit window — every signal cleared every gate.'
                    : 'Nothing was rejected because it has never produced a signal to reject.'
                "
              />
            }
          } @else {
            <app-empty-state
              title="Rejection distribution unavailable"
              description="The audit query returned no data."
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
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .btn-ghost {
        height: 32px;
        padding: 0 var(--space-3);
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        border-radius: var(--radius-full);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .btn-ghost:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .meta-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .meta-value {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .table-scroll {
        width: 100%;
        overflow-x: auto;
      }
      .variants-table {
        width: 100%;
        min-width: 720px;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .variants-table th,
      .variants-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .variants-table th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        background: var(--bg-secondary);
      }
      .variants-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .variants-table td[data-delta='up'] {
        color: #248a3d;
      }
      .variants-table td[data-delta='down'] {
        color: #d70015;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .pill.running {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .pill.promoted {
        background: rgba(175, 82, 222, 0.12);
        color: #8944ab;
      }
      .pill.ended {
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .promote-btn {
        height: 28px;
        padding: 0 12px;
        border: 1px solid var(--accent);
        background: transparent;
        color: var(--accent);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        cursor: pointer;
      }
      .promote-btn:hover:not(:disabled) {
        background: var(--accent);
        color: white;
      }
      .promote-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .rejections-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-4);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-4);
      }
      .rejections-meta div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .rejections-table {
        width: 100%;
        min-width: 560px;
        border-collapse: collapse;
        font-size: var(--text-sm);
        margin-top: var(--space-4);
      }
      .rejections-table th,
      .rejections-table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .rejections-table th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        background: var(--bg-secondary);
      }
      .rejections-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .rejections-table td.reason {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class StrategyAnalyticsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly strategiesService = inject(StrategiesService);
  private readonly feedbackService = inject(StrategyFeedbackService);
  private readonly backtestsService = inject(BacktestsService);
  private readonly realtime = inject(RealtimeService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly relativeTime = new RelativeTimePipe();
  protected readonly promotingVariantId = signal<number | null>(null);

  protected readonly strategyId = +this.route.snapshot.paramMap.get('id')!;
  private readonly optimizationsTable =
    viewChild<DataTableComponent<OptimizationRunDto>>('optimizationsTable');

  protected readonly tabs: TabItem[] = [
    { label: 'Performance', value: 'performance' },
    { label: 'Backtests', value: 'backtests' },
    { label: 'Optimizations', value: 'optimizations' },
    { label: 'Capacity', value: 'capacity' },
    { label: 'Variants', value: 'variants' },
    { label: 'Regime', value: 'regime' },
    { label: 'Rejections', value: 'rejections' },
  ];

  readonly activeTab = signal('performance');
  readonly strategyName = signal<string | null>(null);
  readonly strategy = signal<StrategyDto | null>(null);

  protected readonly regimeEmptyText = computed(() =>
    this.regimeSampleSize() === 0
      ? "The breakdown groups this strategy's health snapshots by the market regime they were taken in. It has no snapshots yet (see above for why)."
      : `None of its ${this.regimeSampleSize()} snapshots carries a regime tag yet; the next health cycle adds one.`,
  );

  protected readonly perfEmptyText = computed(() => {
    const s = this.strategy();
    if (!s)
      return 'Health snapshots are written every 60 s for Active strategies that have closed trades.';
    if (s.status !== 'Active')
      return `Health snapshots are written every 60 s for Active strategies with closed trades — this one is ${s.status} (${s.lifecycleStage}).`;
    return 'It is Active but has no closed trade to score yet; the first snapshot follows its first closed position.';
  });

  // ── Performance tab ─────────────────────────────────────────────────────
  readonly perfLoading = signal(true);
  private readonly perfSnapshots = signal<StrategyPerformanceSnapshotDto[]>([]);

  // ── Variants tab ────────────────────────────────────────────────────────
  readonly variantsLoading = signal(false);
  readonly variants = signal<StrategyVariantDto[]>([]);

  protected winRateDelta(v: StrategyVariantDto): number {
    return (v.shadowWinRate - v.baseWinRate) * 100;
  }
  protected evDelta(v: StrategyVariantDto): number {
    return v.shadowExpectedValue - v.baseExpectedValue;
  }

  // ── Pipeline rejections tab ─────────────────────────────────────────────
  readonly rejectionsLoading = signal(false);
  readonly rejections = signal<StrategyRejectionDistributionDto | null>(null);

  readonly rejectionChartOptions = computed<EChartsOption | null>(() => {
    const r = this.rejections();
    if (!r || r.stages.length === 0) return null;
    return {
      grid: { left: 80, right: 24, top: 24, bottom: 40 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', name: 'Rejections' },
      yAxis: {
        type: 'category',
        data: r.stages.map((s) => s.stage).reverse(),
        axisLabel: { width: 80, overflow: 'truncate' },
      },
      series: [
        {
          name: 'Count',
          type: 'bar',
          data: r.stages.map((s) => s.count).reverse(),
          color: '#FF9500',
          itemStyle: { borderRadius: [0, 6, 6, 0] },
        },
      ],
    };
  });

  // ── Regime tab ──────────────────────────────────────────────────────────
  readonly regimeSampleSize = computed(() => this.perfSnapshots().length);

  readonly regimeChartOptions = computed<EChartsOption | null>(() => {
    const rows = this.perfSnapshots();
    if (rows.length === 0) return null;
    const tagged = rows.filter((s) => !!s.marketRegime);
    if (tagged.length === 0) return null;

    const buckets = new Map<string, { count: number; healthSum: number }>();
    for (const s of tagged) {
      const key = s.marketRegime ?? 'Unknown';
      const b = buckets.get(key) ?? { count: 0, healthSum: 0 };
      b.count++;
      b.healthSum += s.healthScore;
      buckets.set(key, b);
    }

    const labels = [...buckets.keys()];
    const counts = labels.map((k) => buckets.get(k)!.count);
    const meanHealth = labels.map(
      (k) => +(buckets.get(k)!.healthSum / buckets.get(k)!.count).toFixed(3),
    );

    return {
      grid: { left: 64, right: 56, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Snapshots', 'Mean health'] },
      xAxis: { type: 'category', data: labels },
      yAxis: [
        { type: 'value', name: 'Snapshots' },
        { type: 'value', name: 'Mean health', min: 0, max: 1, position: 'right' },
      ],
      series: [
        { name: 'Snapshots', type: 'bar', data: counts, color: '#0071E3' },
        {
          name: 'Mean health',
          type: 'line',
          yAxisIndex: 1,
          data: meanHealth,
          smooth: true,
          color: '#34C759',
        },
      ],
    };
  });

  readonly perfChartOptions = computed<EChartsOption | null>(() => {
    const rows = this.perfSnapshots();
    if (rows.length === 0) return null;

    // Server returns desc; chart expects ascending time.
    const ordered = rows.slice().reverse();
    const xs = ordered.map((s) => s.evaluatedAt);

    return {
      grid: { left: 56, right: 24, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Health (×100)', 'Win rate (%)', 'Sharpe', 'Max DD %'] },
      xAxis: { type: 'time', data: xs },
      yAxis: [
        { type: 'value', name: 'Score / %', min: 0, max: 100 },
        { type: 'value', name: 'Sharpe', position: 'right' },
      ],
      series: [
        {
          name: 'Health (×100)',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: ordered.map((s) => [s.evaluatedAt, +(s.healthScore * 100).toFixed(2)]),
          color: '#34C759',
        },
        {
          name: 'Win rate (%)',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: ordered.map((s) => [s.evaluatedAt, +(s.winRate * 100).toFixed(2)]),
          color: '#0071E3',
        },
        {
          name: 'Max DD %',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: ordered.map((s) => [s.evaluatedAt, s.maxDrawdownPct]),
          color: '#FF3B30',
        },
        {
          name: 'Sharpe',
          type: 'line',
          smooth: true,
          showSymbol: false,
          yAxisIndex: 1,
          data: ordered.map((s) => [s.evaluatedAt, s.sharpeRatio]),
          color: '#AF52DE',
        },
      ],
    };
  });

  // ── Backtests tab ───────────────────────────────────────────────────────
  readonly backtestColumns: ColDef<BacktestRunDto>[] = [
    { field: 'id', headerName: 'ID', width: 80 },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Run status' },
    },
    { field: 'symbol', headerName: 'Symbol', width: 90 },
    {
      field: 'totalTrades',
      headerName: 'Trades',
      width: 80,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? `${p.value}` : '—'),
    },
    // One pipe per metric, matching the backtest detail page: percentages
    // carry their sign, ratios two decimals, the engine's 9999 "undefined
    // ratio" sentinel reads as ∞ instead of a number. A run that closed no
    // trade has no win rate, Sharpe or PF (the engine stores 0.0): "—".
    {
      field: 'winRate',
      headerName: 'Win rate',
      width: 90,
      valueFormatter: (p: { value: number | null; data?: BacktestRunDto }) =>
        p.value != null && !noTradeRun(p.data) ? `${(p.value * 100).toFixed(2)}%` : '—',
    },
    {
      field: 'sharpeRatio',
      headerName: 'Sharpe',
      width: 80,
      valueFormatter: (p: { value: number | null; data?: BacktestRunDto }) =>
        p.value != null && !noTradeRun(p.data) ? p.value.toFixed(2) : '—',
    },
    {
      field: 'profitFactor',
      headerName: 'PF',
      width: 70,
      valueFormatter: (p: { value: number | null; data?: BacktestRunDto }) =>
        p.value == null || noTradeRun(p.data) ? '—' : p.value >= 9999 ? '∞' : p.value.toFixed(2),
    },
    {
      field: 'maxDrawdownPct',
      headerName: 'Max DD',
      width: 100,
      valueFormatter: (p: { value: number | null }) =>
        p.value != null ? `${p.value.toFixed(2)}%` : '—',
    },
    {
      field: 'totalReturn',
      headerName: 'Return',
      width: 100,
      valueFormatter: (p: { value: number | null }) =>
        p.value != null ? `${p.value > 0 ? '+' : ''}${p.value.toFixed(2)}%` : '—',
    },
    {
      field: 'completedAt',
      headerName: 'Completed',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p: { value: string | null }) =>
        p.value ? this.relativeTime.transform(p.value) : '—',
    },
  ];

  readonly fetchBacktests = (params: PagerRequest) =>
    this.backtestsService
      .list({ ...params, filter: { strategyId: this.strategyId } as unknown as string })
      .pipe(
        map((res) => res?.data ?? this.emptyPage<BacktestRunDto>()),
        catchError(() => of(this.emptyPage<BacktestRunDto>())),
      );

  // ── Optimizations tab ───────────────────────────────────────────────────
  readonly optimizationColumns: ColDef<OptimizationRunDto>[] = [
    { field: 'id', headerName: 'ID', width: 80 },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Optimization status' },
    },
    { field: 'triggerType', headerName: 'Trigger', width: 140 },
    { field: 'iterations', headerName: 'Iter', width: 80 },
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p: { value: string | null }) => this.relativeTime.transform(p.value),
    },
    {
      field: 'baselineHealthScore',
      headerName: 'Baseline',
      width: 100,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? p.value.toFixed(2) : '—'),
    },
    {
      field: 'bestHealthScore',
      headerName: 'Best',
      width: 100,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? p.value.toFixed(2) : '—'),
    },
    {
      field: 'approvedAt',
      headerName: 'Approved',
      width: 130,
      valueFormatter: (p: { value: string | null }) =>
        p.value ? this.relativeTime.transform(p.value) : '—',
    },
  ];

  readonly fetchOptimizations = (params: PagerRequest) =>
    this.feedbackService
      .listOptimizationRuns({
        ...params,
        filter: { strategyId: this.strategyId } as unknown as string,
      })
      .pipe(
        map((res) => res?.data ?? this.emptyPage<OptimizationRunDto>()),
        catchError(() => of(this.emptyPage<OptimizationRunDto>())),
      );

  constructor() {
    // Deep links (e.g. the activity context's "Pipeline rejections" tile) open a tab with ?tab=.
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (tab && this.tabs.some((t) => t.value === tab)) this.onTabChange(tab);
    this.loadStrategyName();
    this.loadPerformance();

    // Push refresh: re-pull the snapshot history when the worker writes a
    // new row for this strategy. Throttled so a long stay doesn't pile up
    // requests on the 60s cadence.
    this.realtime
      .on<{ strategyId: number }>('strategyHealthSnapshotCreated')
      .pipe(
        filter((evt) => evt?.strategyId === this.strategyId),
        throttleTime(10_000, undefined, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.loadPerformance());

    // Optimization approvals reach analysts via this push — refresh the
    // Optimizations tab in place so the just-approved row's status pill
    // flips without the user reloading.
    this.realtime
      .on<{ strategyId: number }>('optimizationApproved')
      .pipe(
        filter((evt) => evt?.strategyId === this.strategyId),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.optimizationsTable()?.loadData());

    // Variant promotion may originate from another tab/user — refresh the
    // variants list when a promotion event lands for THIS strategy. Variants
    // tab also reloads its own data after a local promotion completes.
    this.realtime
      .on<{ baseStrategyId: number }>('strategyVariantPromoted')
      .pipe(
        filter((evt) => evt?.baseStrategyId === this.strategyId),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        if (this.variants().length > 0) this.loadVariants();
      });
  }

  protected promoteVariant(variantId: number): void {
    if (this.promotingVariantId() !== null) return;
    this.promotingVariantId.set(variantId);
    this.strategiesService.promoteVariant(variantId).subscribe({
      next: (res) => {
        this.promotingVariantId.set(null);
        if (res?.status) {
          this.notify.success(`Variant #${variantId} promoted`);
          this.loadVariants();
        } else {
          this.notify.error(res?.message ?? 'Promote failed');
        }
      },
      error: () => {
        this.promotingVariantId.set(null);
        this.notify.error('Promote failed');
      },
    });
  }

  /**
   * Tab-change handler — fetches lazy panels on demand the first time their
   * tab is opened. The @if blocks in the template would otherwise mount the
   * panel without ever requesting the data.
   */
  protected onTabChange(value: string): void {
    this.activeTab.set(value);
    if (value === 'variants' && this.variants().length === 0 && !this.variantsLoading()) {
      this.loadVariants();
    }
    if (value === 'rejections' && this.rejections() === null && !this.rejectionsLoading()) {
      this.loadRejections();
    }
  }

  private loadVariants(): void {
    this.variantsLoading.set(true);
    this.strategiesService.getVariants(this.strategyId).subscribe({
      next: (res) => {
        this.variants.set(res?.data ?? []);
        this.variantsLoading.set(false);
      },
      error: () => {
        this.variants.set([]);
        this.variantsLoading.set(false);
      },
    });
  }

  private loadRejections(): void {
    this.rejectionsLoading.set(true);
    this.strategiesService.getRejectionDistribution(this.strategyId).subscribe({
      next: (res) => {
        this.rejections.set(res?.data ?? null);
        this.rejectionsLoading.set(false);
      },
      error: () => {
        this.rejections.set(null);
        this.rejectionsLoading.set(false);
      },
    });
  }

  goBack(): void {
    this.router.navigate(['/strategies', this.strategyId]);
  }

  private loadStrategyName(): void {
    this.strategiesService.getById(this.strategyId).subscribe({
      next: (res) => {
        const s = res?.data as StrategyDto | undefined;
        if (s?.name) this.strategyName.set(s.name);
        if (s) this.strategy.set(s);
      },
      error: () => {
        /* Title falls back to "#<id>" — survivable. */
      },
    });
  }

  private loadPerformance(): void {
    this.perfLoading.set(true);
    // 200 snapshots ≈ 200 minutes of 60s cadence — enough for a useful chart
    // without paying for a deep history scan.
    this.feedbackService
      .getSnapshotHistory(this.strategyId, { currentPage: 1, itemCountPerPage: 200 })
      .subscribe({
        next: (res) => {
          this.perfSnapshots.set(res?.data?.data ?? []);
          this.perfLoading.set(false);
        },
        error: () => {
          this.perfSnapshots.set([]);
          this.perfLoading.set(false);
        },
      });
  }

  private emptyPage<T>(): PagedData<T> {
    return {
      data: [],
      pager: {
        totalItemCount: 0,
        filter: null,
        currentPage: 1,
        itemCountPerPage: 25,
        pageNo: 0,
        pageSize: 25,
      },
    } as PagedData<T>;
  }
}
