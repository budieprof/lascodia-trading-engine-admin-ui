import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  inject,
  signal,
  OnInit,
  ViewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { filter, map, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { OrdersService } from '@core/services/orders.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import {
  StrategyDto,
  StrategyPerformanceSnapshotDto,
  OptimizationRunDto,
  PagerRequest,
  UpdateStrategyRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { StrategyFormComponent } from '../../components/strategy-form/strategy-form.component';

@Component({
  selector: 'app-strategy-detail-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    PresenceBadgeComponent,
    DataTableComponent,
    StatusBadgeComponent,
    ConfirmDialogComponent,
    GaugeComponent,
    TabsComponent,
    EnumLabelPipe,
    RelativeTimePipe,
    StrategyFormComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (strategy()) {
        <app-page-header
          [title]="strategy()!.name ?? ''"
          [subtitle]="(strategy()!.symbol ?? '') + ' - ' + (strategy()!.description ?? '')"
        >
          <app-presence-badge [routeKey]="'strategy:' + strategyId" />
          <button class="btn btn-secondary" (click)="openAnalytics()">Open analytics →</button>
          <button class="btn btn-ghost" (click)="goBack()">Back</button>
        </app-page-header>

        @if (latestSnapshot(); as s) {
          <div class="health-strip">
            <div class="health-gauge-col">
              <app-gauge
                [value]="gaugePercent()"
                [min]="0"
                [max]="100"
                label="Health"
                size="120px"
                [thresholds]="healthThresholds"
              />
              @if (weeklyDeltaPct() !== null) {
                <span class="delta-chip" [attr.data-dir]="weeklyDeltaDir()">
                  @if (weeklyDeltaDir() === 'up') {
                    ↑
                  } @else if (weeklyDeltaDir() === 'down') {
                    ↓
                  } @else {
                    →
                  }
                  {{ weeklyDeltaPct()! >= 0 ? '+' : '' }}{{ weeklyDeltaPct() }} pts vs 7d ago
                </span>
              }
            </div>
            <dl class="health-meta">
              <div>
                <dt>Status</dt>
                <dd>{{ s.healthStatus ?? '—' }}</dd>
              </div>
              <div>
                <dt>Win rate</dt>
                <dd>{{ (s.winRate * 100).toFixed(1) }}%</dd>
              </div>
              <div>
                <dt>Profit factor</dt>
                <dd>{{ s.profitFactor.toFixed(2) }}</dd>
              </div>
              <div>
                <dt>Sharpe</dt>
                <dd>{{ s.sharpeRatio.toFixed(2) }}</dd>
              </div>
              <div>
                <dt>Max DD</dt>
                <dd>{{ s.maxDrawdownPct.toFixed(1) }}%</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>{{ s.windowTrades }} trades</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ s.evaluatedAt | relativeTime }}</dd>
              </div>
            </dl>
          </div>
        }

        <ui-tabs [tabs]="detailTabs" [(activeTab)]="activeTab">
          <!-- Config Tab -->
          @if (activeTab() === 'config') {
            <div class="detail-layout">
              <div class="detail-card">
                <h3 class="card-title">Strategy Details</h3>
                <div class="detail-grid">
                  <div class="detail-item">
                    <span class="detail-label">Name</span>
                    <span class="detail-value">{{ strategy()!.name }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Symbol</span>
                    <span class="detail-value">{{ strategy()!.symbol }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Timeframe</span>
                    <span class="detail-value">{{
                      strategy()!.timeframe | enumLabel: 'timeframe'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Type</span>
                    <span class="detail-value">{{ strategy()!.strategyType | enumLabel }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Status</span>
                    <span class="detail-value"
                      ><app-status-badge [status]="strategy()!.status" type="strategy"
                    /></span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Risk Profile</span>
                    <span class="detail-value">{{
                      strategy()!.riskProfileId ? '#' + strategy()!.riskProfileId : 'None'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Created</span>
                    <span class="detail-value">{{ strategy()!.createdAt | relativeTime }}</span>
                  </div>
                </div>
              </div>

              @if (strategy()!.parametersJson) {
                <div class="detail-card">
                  <h3 class="card-title">Parameters</h3>
                  <pre class="code-block">{{ formatJson(strategy()!.parametersJson!) }}</pre>
                </div>
              }

              <div class="action-bar">
                @if (strategy()!.status === 'Paused' || strategy()!.status === 'Stopped') {
                  <button
                    class="btn btn-success"
                    (click)="onActivate()"
                    [disabled]="actionLoading()"
                  >
                    Activate
                  </button>
                }
                @if (strategy()!.status === 'Active') {
                  <button class="btn btn-warning" (click)="onPause()" [disabled]="actionLoading()">
                    Pause
                  </button>
                }
                <button class="btn btn-outline" (click)="showEditForm.set(true)">Edit</button>
                <button class="btn btn-destructive" (click)="showDeleteConfirm.set(true)">
                  Delete
                </button>
              </div>
            </div>
          }

          <!-- Signals Tab -->
          @if (activeTab() === 'signals') {
            <app-data-table [columnDefs]="signalColumns" [fetchData]="fetchSignals" />
          }

          <!-- Orders Tab -->
          @if (activeTab() === 'orders') {
            <app-data-table [columnDefs]="orderColumns" [fetchData]="fetchOrders" />
          }

          <!-- Optimization Tab -->
          @if (activeTab() === 'optimization') {
            <div class="optimization-header">
              <button
                class="btn btn-primary"
                (click)="onTriggerOptimization()"
                [disabled]="optimizationLoading()"
              >
                @if (optimizationLoading()) {
                  <span class="spinner"></span>
                } @else {
                  Trigger Optimization
                }
              </button>
            </div>

            <app-data-table
              #optimizationTable
              [columnDefs]="optimizationColumns"
              [fetchData]="fetchOptimizations"
            />
          }
        </ui-tabs>
      } @else if (loadError()) {
        <div class="error-state">
          <h2>Strategy not found</h2>
          <p>The requested strategy could not be loaded.</p>
          <button class="btn btn-outline" (click)="goBack()">Back to Strategies</button>
        </div>
      } @else {
        <div class="loading-state">
          <div class="loading-shimmer"></div>
          <div class="loading-shimmer short"></div>
        </div>
      }

      <app-confirm-dialog
        [open]="showDeleteConfirm()"
        title="Delete Strategy"
        [message]="
          'Are you sure you want to delete ' +
          (strategy()?.name ?? 'this strategy') +
          '? This action cannot be undone.'
        "
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="deleteLoading()"
        (confirm)="onDelete()"
        (cancelled)="showDeleteConfirm.set(false)"
      />

      <app-strategy-form
        [open]="showEditForm()"
        [strategy]="strategy()"
        (submitted)="onUpdate($event)"
        (cancelled)="showEditForm.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .health-strip {
        display: flex;
        align-items: center;
        gap: var(--space-6);
        padding: var(--space-4) var(--space-5);
        margin: var(--space-3) 0 var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .health-gauge-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-2);
      }
      .delta-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .delta-chip[data-dir='up'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .delta-chip[data-dir='down'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .health-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: var(--space-4) var(--space-5);
        margin: 0;
        flex: 1;
      }
      .health-meta div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .health-meta dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .health-meta dd {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
        font-variant-numeric: tabular-nums;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        min-width: 80px;
      }
      .btn:active:not(:disabled) {
        transform: scale(0.97);
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

      .btn-success {
        background: #34c759;
        color: white;
      }
      .btn-success:hover:not(:disabled) {
        background: #2db84e;
      }

      .btn-warning {
        background: #ff9500;
        color: white;
      }
      .btn-warning:hover:not(:disabled) {
        background: #e68600;
      }

      .btn-destructive {
        background: var(--loss);
        color: white;
      }
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
      }

      .btn-outline {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-outline:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }

      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
      }
      .btn-ghost:hover {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }

      .btn-sm {
        height: 28px;
        padding: 0 var(--space-3);
        font-size: var(--text-xs);
        min-width: auto;
      }

      .detail-layout {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }

      .detail-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }

      .card-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-4);
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: var(--space-4);
      }

      .detail-item {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }

      .detail-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .detail-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }

      .code-block {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-4);
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 12px;
        color: var(--text-primary);
        overflow-x: auto;
        line-height: 1.6;
        margin: 0;
        white-space: pre-wrap;
        word-wrap: break-word;
      }

      .action-bar {
        display: flex;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }

      .optimization-header {
        display: flex;
        justify-content: flex-end;
        margin-bottom: var(--space-4);
      }

      .error-state {
        text-align: center;
        padding: var(--space-16);
      }
      .error-state h2 {
        font-size: var(--text-lg);
        color: var(--text-primary);
        margin: 0 0 var(--space-2);
      }
      .error-state p {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0 0 var(--space-6);
      }

      .loading-state {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-8) 0;
      }

      .loading-shimmer {
        height: 20px;
        width: 60%;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        animation: shimmer 1.5s infinite;
      }
      .loading-shimmer.short {
        width: 30%;
        height: 14px;
      }

      @keyframes shimmer {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
      }

      .spinner {
        width: 16px;
        height: 16px;
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
    `,
  ],
})
export class StrategyDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly strategiesService = inject(StrategiesService);
  private readonly feedbackService = inject(StrategyFeedbackService);
  private readonly signalsService = inject(TradeSignalsService);
  private readonly ordersService = inject(OrdersService);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly enumLabel = new EnumLabelPipe();
  private readonly relativeTime = new RelativeTimePipe();

  /**
   * Latest health snapshot for this strategy. One initial fetch on init,
   * then refreshed in-band when the realtime hub pushes
   * `strategyHealthSnapshotCreated` for this strategy id. The gauge above
   * the tabs reads from this signal.
   */
  readonly latestSnapshot = signal<StrategyPerformanceSnapshotDto | null>(null);

  /**
   * Snapshot from ~7 days ago — the closest historical row at-or-before that
   * point. Powers the delta arrow next to the gauge so operators see whether
   * the strategy is improving or decaying week-on-week. `null` until the
   * strategy has at least 7 days of history.
   */
  readonly weekAgoSnapshot = signal<StrategyPerformanceSnapshotDto | null>(null);

  /** 0..100 mapping of HealthScore for the gauge widget (gauge expects percent). */
  protected gaugePercent(): number {
    const s = this.latestSnapshot();
    return s ? Math.round(s.healthScore * 100) : 0;
  }

  /**
   * Week-over-week health-score delta in percentage points (e.g. +12 means
   * the score went from 0.50 → 0.62). Returns `null` when we lack a 7-day
   * baseline so the template can hide the chip rather than render zero.
   */
  protected weeklyDeltaPct(): number | null {
    const now = this.latestSnapshot();
    const then = this.weekAgoSnapshot();
    if (!now || !then) return null;
    return Math.round((now.healthScore - then.healthScore) * 100);
  }

  /** Direction class for the delta chip — drives colour + arrow glyph. */
  protected weeklyDeltaDir(): 'up' | 'down' | 'flat' {
    const d = this.weeklyDeltaPct();
    if (d === null || d === 0) return 'flat';
    return d > 0 ? 'up' : 'down';
  }

  /**
   * Inverted threshold palette: low score = bad (red), high = good (green).
   * The default Gauge palette assumes "low is good" (e.g. drawdown %), which
   * would colour a healthy strategy red — wrong signal entirely.
   */
  protected readonly healthThresholds = [
    { value: 30, color: '#FF3B30' },
    { value: 60, color: '#FF9500' },
    { value: 100, color: '#34C759' },
  ];

  @ViewChild('optimizationTable') optimizationTable?: DataTableComponent<OptimizationRunDto>;

  strategy = signal<StrategyDto | null>(null);
  loadError = signal(false);
  activeTab = signal('config');
  actionLoading = signal(false);
  showDeleteConfirm = signal(false);
  deleteLoading = signal(false);
  showEditForm = signal(false);
  optimizationLoading = signal(false);

  protected strategyId!: number;

  readonly detailTabs: TabItem[] = [
    { label: 'Config', value: 'config' },
    { label: 'Signals', value: 'signals' },
    { label: 'Orders', value: 'orders' },
    { label: 'Optimization', value: 'optimization' },
  ];

  readonly signalColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'symbol', headerName: 'Symbol', flex: 1 },
    { field: 'direction', headerName: 'Direction', width: 100 },
    {
      field: 'entryPrice',
      headerName: 'Entry Price',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'stopLoss',
      headerName: 'SL',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'takeProfit',
      headerName: 'TP',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'confidence',
      headerName: 'Confidence',
      width: 100,
      valueFormatter: (p: any) => `${(p.value * 100).toFixed(1)}%`,
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (p: any) => {
        const v = this.getSignalStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    {
      field: 'generatedAt',
      headerName: 'Generated',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly orderColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'symbol', headerName: 'Symbol', flex: 1 },
    { field: 'orderType', headerName: 'Side', width: 80 },
    { field: 'executionType', headerName: 'Exec Type', width: 100 },
    { field: 'quantity', headerName: 'Qty', width: 80 },
    {
      field: 'price',
      headerName: 'Price',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'filledPrice',
      headerName: 'Filled',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (p: any) => {
        const v = this.getOrderStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly optimizationColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    {
      field: 'triggerType',
      headerName: 'Trigger',
      flex: 1,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      cellRenderer: (p: any) => {
        const v = this.getOptStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    { field: 'iterations', headerName: 'Iterations', width: 100 },
    {
      field: 'bestHealthScore',
      headerName: 'Best Score',
      width: 110,
      valueFormatter: (p: any) => p.value?.toFixed(4) ?? '-',
    },
    {
      field: 'baselineHealthScore',
      headerName: 'Baseline',
      width: 110,
      valueFormatter: (p: any) => p.value?.toFixed(4) ?? '-',
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
    {
      field: 'completedAt',
      headerName: 'Completed',
      flex: 1,
      valueFormatter: (p: any) => (p.value ? this.relativeTime.transform(p.value) : '-'),
    },
    {
      headerName: 'Actions',
      width: 180,
      sortable: false,
      cellRenderer: (p: any) => {
        const run = p.data as OptimizationRunDto;
        if (run.status === 'Completed') {
          return `<div style="display:flex;gap:6px;padding-top:4px">
            <button class="opt-action-btn approve" data-action="approve" data-id="${run.id}" style="height:24px;padding:0 10px;border:none;border-radius:9999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">Approve</button>
            <button class="opt-action-btn reject" data-action="reject" data-id="${run.id}" style="height:24px;padding:0 10px;border:none;border-radius:9999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Reject</button>
          </div>`;
        }
        return '';
      },
      onCellClicked: (params: any) => {
        const target = params.event?.target as HTMLElement;
        if (target?.dataset?.['action'] === 'approve') {
          this.onApproveOptimization(+target.dataset['id']!);
        } else if (target?.dataset?.['action'] === 'reject') {
          this.onRejectOptimization(+target.dataset['id']!);
        }
      },
    },
  ];

  // Engine `PagerRequestWithFilterType<TFilter,...>` setters reject any
  // bare-string `filter` value with HTTP 400 (System.Text.Json can't bind a
  // string to TFilter). Pass an object that matches the per-controller
  // filter shape — `{ strategyId }` is a first-class field on the trade-
  // signal, optimization, and (post-engine-update) order filters.
  readonly fetchSignals = (params: PagerRequest) =>
    this.signalsService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId } })
      .pipe(map((res) => res.data!));

  readonly fetchOrders = (params: PagerRequest) =>
    this.ordersService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId } })
      .pipe(map((res) => res.data!));

  readonly fetchOptimizations = (params: PagerRequest) =>
    this.feedbackService
      .listOptimizationRuns({
        ...params,
        filter: { ...(params.filter ?? {}), strategyId: this.strategyId },
      })
      .pipe(map((res) => res.data!));

  ngOnInit(): void {
    this.strategyId = +this.route.snapshot.paramMap.get('id')!;
    this.loadStrategy();
    this.loadLatestSnapshot();
    this.loadWeekAgoSnapshot();

    // Push refresh: filter to events for this strategy id, throttle to 5s so
    // a chatty 60s-cadence worker can't pile up if the page sits open. The
    // payload carries the new HealthScore so we don't need a follow-up GET in
    // most cases — but we re-fetch anyway for the trade counts the gauge view
    // doesn't expose, keeping the snapshot source of truth one round-trip away.
    this.realtime
      .on<{ strategyId: number }>('strategyHealthSnapshotCreated')
      .pipe(
        filter((evt) => evt?.strategyId === this.strategyId),
        throttleTime(5_000, undefined, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.loadLatestSnapshot());
  }

  private loadLatestSnapshot(): void {
    this.feedbackService.getPerformance(this.strategyId).subscribe({
      next: (res) => {
        if (res?.status && res.data) this.latestSnapshot.set(res.data);
      },
      error: () => {
        /* No snapshot yet is the common case for fresh strategies — silent. */
      },
    });
  }

  /**
   * Pull the most recent snapshot at-or-before 7 days ago. The query orders
   * desc and we only need one row, so a `to: 7d-ago` filter + page-size-1
   * does the job in a single round-trip — no client-side scan.
   */
  private loadWeekAgoSnapshot(): void {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.feedbackService
      .getSnapshotHistory(this.strategyId, {
        currentPage: 1,
        itemCountPerPage: 1,
        filter: { to: sevenDaysAgo },
      })
      .subscribe({
        next: (res) => {
          const row = res?.data?.data?.[0] ?? null;
          this.weekAgoSnapshot.set(row);
        },
        error: () => {
          /* Insufficient history yet — leave the delta chip hidden. */
        },
      });
  }

  goBack(): void {
    this.router.navigate(['/strategies']);
  }

  openAnalytics(): void {
    this.router.navigate(['/strategies', this.strategyId, 'analytics']);
  }

  formatJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  onActivate(): void {
    this.actionLoading.set(true);
    this.strategiesService.activate(this.strategyId).subscribe({
      next: (res) => {
        if (res.data) this.strategy.set(res.data);
        this.notifications.success('Strategy activated');
        this.actionLoading.set(false);
      },
      error: () => {
        this.notifications.error('Failed to activate strategy');
        this.actionLoading.set(false);
      },
    });
  }

  onPause(): void {
    this.actionLoading.set(true);
    this.strategiesService.pause(this.strategyId).subscribe({
      next: (res) => {
        if (res.data) this.strategy.set(res.data);
        this.notifications.success('Strategy paused');
        this.actionLoading.set(false);
      },
      error: () => {
        this.notifications.error('Failed to pause strategy');
        this.actionLoading.set(false);
      },
    });
  }

  onDelete(): void {
    this.deleteLoading.set(true);
    this.strategiesService.delete(this.strategyId).subscribe({
      next: () => {
        this.notifications.success('Strategy deleted');
        this.deleteLoading.set(false);
        this.showDeleteConfirm.set(false);
        this.router.navigate(['/strategies']);
      },
      error: () => {
        this.notifications.error('Failed to delete strategy');
        this.deleteLoading.set(false);
      },
    });
  }

  onUpdate(data: any): void {
    this.strategiesService.update(this.strategyId, data as UpdateStrategyRequest).subscribe({
      next: (res) => {
        if (res.data) this.strategy.set(res.data);
        this.notifications.success('Strategy updated');
        this.showEditForm.set(false);
      },
      error: () => this.notifications.error('Failed to update strategy'),
    });
  }

  onTriggerOptimization(): void {
    this.optimizationLoading.set(true);
    this.feedbackService.triggerOptimization({ strategyId: this.strategyId }).subscribe({
      next: () => {
        this.notifications.success('Optimization triggered');
        this.optimizationLoading.set(false);
        this.optimizationTable?.loadData();
      },
      error: () => {
        this.notifications.error('Failed to trigger optimization');
        this.optimizationLoading.set(false);
      },
    });
  }

  onApproveOptimization(id: number): void {
    this.feedbackService.approveOptimization(id).subscribe({
      next: () => {
        this.notifications.success('Optimization approved');
        this.optimizationTable?.loadData();
      },
      error: () => this.notifications.error('Failed to approve optimization'),
    });
  }

  onRejectOptimization(id: number): void {
    this.feedbackService.rejectOptimization(id).subscribe({
      next: () => {
        this.notifications.success('Optimization rejected');
        this.optimizationTable?.loadData();
      },
      error: () => this.notifications.error('Failed to reject optimization'),
    });
  }

  private loadStrategy(): void {
    this.strategiesService.getById(this.strategyId).subscribe({
      next: (res) => {
        if (res.data) {
          this.strategy.set(res.data);
        } else {
          this.loadError.set(true);
        }
      },
      error: () => this.loadError.set(true),
    });
  }

  private getSignalStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Approved: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Executed: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }

  private getOrderStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Submitted: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      PartialFill: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Filled: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Cancelled: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }

  private getOptStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Queued: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
      Running: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Completed: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Failed: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Approved: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }
}
