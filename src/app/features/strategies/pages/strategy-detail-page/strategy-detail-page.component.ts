import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  OnInit,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { OrdersService } from '@core/services/orders.service';
import { NotificationService } from '@core/notifications/notification.service';
import {
  StrategyDto,
  OptimizationRunDto,
  PagerRequest,
  UpdateStrategyRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
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
          <button class="btn btn-ghost" (click)="goBack()">Back</button>
        </app-page-header>

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
  private readonly enumLabel = new EnumLabelPipe();
  private readonly relativeTime = new RelativeTimePipe();

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

  readonly fetchSignals = (params: PagerRequest) =>
    this.signalsService
      .list({ ...params, filter: `strategyId:${this.strategyId}` })
      .pipe(map((res) => res.data!));

  readonly fetchOrders = (params: PagerRequest) =>
    this.ordersService
      .list({ ...params, filter: `strategyId:${this.strategyId}` })
      .pipe(map((res) => res.data!));

  readonly fetchOptimizations = (params: PagerRequest) =>
    this.feedbackService
      .listOptimizationRuns({ ...params, filter: `strategyId:${this.strategyId}` })
      .pipe(map((res) => res.data!));

  ngOnInit(): void {
    this.strategyId = +this.route.snapshot.paramMap.get('id')!;
    this.loadStrategy();
  }

  goBack(): void {
    this.router.navigate(['/strategies']);
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
