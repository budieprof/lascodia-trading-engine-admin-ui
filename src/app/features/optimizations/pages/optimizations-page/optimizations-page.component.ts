import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, of, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  OptimizationDryRunDto,
  OptimizationRunDto,
  PagedData,
  PagerRequest,
  StrategyDto,
  TriggerOptimizationRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';

@Component({
  selector: 'app-optimizations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    ConfirmDialogComponent,
    CardSkeletonComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
    DatePipe,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Optimizations"
        subtitle="Bayesian strategy-parameter search (TPE / GP-UCB / EHVI + Hyperband)"
      >
        <button type="button" class="btn btn-primary" (click)="openCreate()">
          + Trigger Optimization
        </button>
      </app-page-header>

      @if (showCreate()) {
        <form class="panel" [formGroup]="triggerForm" (ngSubmit)="submitTrigger()">
          <div class="panel-head">
            <h3>Trigger Optimization</h3>
            <button type="button" class="close" (click)="cancelCreate()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field
              label="Strategy"
              [required]="true"
              [control]="triggerForm.controls.strategyId"
            >
              <select appFormFieldControl formControlName="strategyId" (change)="loadDryRun()">
                <option [ngValue]="null">Select a strategy…</option>
                @for (s of strategies(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }} ({{ s.symbol }} {{ s.timeframe }})</option>
                }
              </select>
            </app-form-field>
            <app-form-field
              label="Trigger Type"
              [required]="true"
              [control]="triggerForm.controls.triggerType"
            >
              <select appFormFieldControl formControlName="triggerType">
                <option value="Manual">Manual</option>
                <option value="Scheduled">Scheduled</option>
                <option value="AutoDegrading">AutoDegrading</option>
              </select>
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancelCreate()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || triggerForm.invalid"
              >
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Queue
                }
              </button>
            </div>
          </div>

          @if (dryRunLoading()) {
            <app-card-skeleton [lines]="4" [showHeader]="false" />
          } @else if (dryRun()) {
            @if (dryRun(); as d) {
              <div class="dry-run">
                <h4>Dry Run Estimate</h4>
                <dl>
                  <div>
                    <dt>Grid Size</dt>
                    <dd class="mono">{{ d.estimatedGridSize }}</dd>
                  </div>
                  <div>
                    <dt>Candle Count</dt>
                    <dd class="mono">{{ d.candleCount | number }}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd class="mono">~{{ d.estimatedDurationMinutes }} min</dd>
                  </div>
                  <div>
                    <dt>CPU Cores</dt>
                    <dd class="mono">{{ d.estimatedCpuCores }}</dd>
                  </div>
                </dl>
                @if (d.notes) {
                  <p class="notes">{{ d.notes }}</p>
                }
              </div>
            }
          }
        </form>
      }

      <app-data-table
        #table
        [columnDefs]="columns"
        [fetchData]="fetchData"
        [searchable]="true"
        (rowClick)="select($event)"
      />

      @if (selected()) {
        @if (selected(); as r) {
          <section class="detail">
            <header class="detail-head">
              <div class="title">
                <h3>Run #{{ r.id }} — Strategy {{ r.strategyId }}</h3>
                <span class="pill" [attr.data-status]="r.status">{{ r.status }}</span>
              </div>
              <div class="actions">
                @if (r.status === 'Completed') {
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="showApprove.set(true)"
                    [disabled]="detailBusy()"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    class="btn btn-destructive"
                    (click)="showReject.set(true)"
                    [disabled]="detailBusy()"
                  >
                    Reject
                  </button>
                }
                <button type="button" class="btn btn-secondary" (click)="selected.set(null)">
                  Close
                </button>
              </div>
            </header>

            <dl class="stats">
              <div>
                <dt>Trigger</dt>
                <dd>{{ r.triggerType }}</dd>
              </div>
              <div>
                <dt>Iterations</dt>
                <dd class="mono">{{ r.iterations }}</dd>
              </div>
              <div>
                <dt>Baseline Score</dt>
                <dd class="mono">
                  {{ r.baselineHealthScore !== null ? r.baselineHealthScore.toFixed(2) : '—' }}
                </dd>
              </div>
              <div>
                <dt>Best Score</dt>
                <dd class="mono">
                  {{ r.bestHealthScore !== null ? r.bestHealthScore.toFixed(2) : '—' }}
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{{ r.startedAt | date: 'MMM d, HH:mm' }}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{{ r.completedAt ? (r.completedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd>{{ r.approvedAt ? (r.approvedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
              </div>
            </dl>

            @if (r.bestParametersJson) {
              <div class="block">
                <h4>Best Parameters</h4>
                <pre>{{ formatJson(r.bestParametersJson) }}</pre>
              </div>
            }
            @if (r.baselineParametersJson) {
              <div class="block">
                <h4>Baseline Parameters</h4>
                <pre>{{ formatJson(r.baselineParametersJson) }}</pre>
              </div>
            }
            @if (r.errorMessage) {
              <div class="block error">
                <h4>Error</h4>
                <pre>{{ r.errorMessage }}</pre>
              </div>
            }
          </section>
        }
      }

      <app-confirm-dialog
        [open]="showApprove()"
        title="Approve Optimization"
        message="Apply the best parameters to the strategy. A 25/50/75/100% gradual rollout will be scheduled."
        confirmLabel="Approve"
        confirmVariant="primary"
        [loading]="detailBusy()"
        (confirm)="approve()"
        (cancelled)="showApprove.set(false)"
      />
      <app-confirm-dialog
        [open]="showReject()"
        title="Reject Optimization"
        message="Discard the best parameters. The strategy keeps its current configuration."
        confirmLabel="Reject"
        confirmVariant="destructive"
        [loading]="detailBusy()"
        (confirm)="reject()"
        (cancelled)="showReject.set(false)"
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
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-destructive {
        background: var(--loss);
        color: white;
      }
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
      }
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .close {
        background: transparent;
        border: none;
        font-size: 20px;
        color: var(--text-secondary);
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
      }
      .close:hover {
        background: var(--bg-tertiary);
      }
      .panel-body {
        display: flex;
        gap: var(--space-4);
        flex-wrap: wrap;
        padding: var(--space-5);
        align-items: flex-end;
      }
      .field {
        display: flex;
        flex-direction: column;
        min-width: 240px;
        flex: 1 1 240px;
      }
      .field label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .actions {
        display: flex;
        gap: var(--space-2);
        margin-left: auto;
      }
      .dry-run {
        background: var(--bg-primary);
        border-top: 1px solid var(--border);
        padding: var(--space-4) var(--space-5);
      }
      .dry-run h4 {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .dry-run dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-4);
        margin: 0;
      }
      .dry-run dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .dry-run dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .dry-run dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .dry-run .notes {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }

      .detail {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .detail-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .title {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .title h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .pill {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill[data-status='Running'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .pill[data-status='Completed'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Approved'] {
        background: rgba(175, 82, 222, 0.12);
        color: #8944ab;
      }
      .pill[data-status='Rejected'] {
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-4);
        margin: 0;
      }
      .stats dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .stats dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .stats dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .block h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .block pre {
        margin: 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
      }
      .block.error pre {
        border-color: rgba(255, 59, 48, 0.3);
        color: var(--loss);
      }
      .spin {
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
export class OptimizationsPageComponent {
  private readonly service = inject(StrategyFeedbackService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('table') table?: DataTableComponent<OptimizationRunDto>;

  readonly strategies = signal<StrategyDto[]>([]);
  readonly showCreate = signal(false);
  readonly busy = signal(false);
  readonly selected = signal<OptimizationRunDto | null>(null);
  readonly detailBusy = signal(false);
  readonly showApprove = signal(false);
  readonly showReject = signal(false);
  readonly dryRun = signal<OptimizationDryRunDto | null>(null);
  readonly dryRunLoading = signal(false);

  readonly triggerForm = this.fb.nonNullable.group({
    strategyId: [null as number | null, Validators.required],
    triggerType: ['Manual', Validators.required],
  });

  readonly columns: ColDef<OptimizationRunDto>[] = [
    { headerName: 'ID', field: 'id', width: 90 },
    { headerName: 'Strategy', field: 'strategyId', width: 110 },
    { headerName: 'Trigger', field: 'triggerType', width: 130 },
    { headerName: 'Iterations', field: 'iterations', width: 120 },
    {
      headerName: 'Baseline',
      field: 'baselineHealthScore',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Best',
      field: 'bestHealthScore',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 140,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Optimization status' },
    },
    {
      headerName: 'Started',
      field: 'startedAt',
      width: 170,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm') ?? '-',
    },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<OptimizationRunDto>> =>
    this.service
      .listOptimizationRuns(params)
      .pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  constructor() {
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe((res) => {
      this.strategies.set(res.data?.data ?? []);
    });
  }

  openCreate(): void {
    this.triggerForm.reset({ strategyId: null, triggerType: 'Manual' });
    this.dryRun.set(null);
    this.showCreate.set(true);
  }

  cancelCreate(): void {
    this.showCreate.set(false);
    this.dryRun.set(null);
  }

  loadDryRun(): void {
    const id = this.triggerForm.getRawValue().strategyId;
    if (id == null) {
      this.dryRun.set(null);
      return;
    }
    this.dryRunLoading.set(true);
    this.service
      .getOptimizationDryRun(id)
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as OptimizationDryRunDto | null)),
      )
      .subscribe((data) => {
        this.dryRun.set(data);
        this.dryRunLoading.set(false);
      });
  }

  submitTrigger(): void {
    const v = this.triggerForm.getRawValue();
    if (v.strategyId == null) return;
    this.busy.set(true);
    const request: TriggerOptimizationRequest = {
      strategyId: v.strategyId,
      triggerType: v.triggerType,
    };
    this.service.triggerOptimization(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success('Optimization run queued');
          this.cancelCreate();
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to queue optimization');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  select(row: OptimizationRunDto): void {
    this.selected.set(row);
  }

  approve(): void {
    const run = this.selected();
    if (!run) return;
    this.detailBusy.set(true);
    this.service.approveOptimization(run.id).subscribe({
      next: (res) => {
        this.detailBusy.set(false);
        this.showApprove.set(false);
        if (res.status) {
          this.notifications.success(`Run #${run.id} approved — gradual rollout scheduled`);
          if (res.data) this.selected.set(res.data);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Approve failed');
        }
      },
      error: () => {
        this.detailBusy.set(false);
        this.showApprove.set(false);
      },
    });
  }

  reject(): void {
    const run = this.selected();
    if (!run) return;
    this.detailBusy.set(true);
    this.service.rejectOptimization(run.id).subscribe({
      next: (res) => {
        this.detailBusy.set(false);
        this.showReject.set(false);
        if (res.status) {
          this.notifications.success(`Run #${run.id} rejected`);
          if (res.data) this.selected.set(res.data);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Reject failed');
        }
      },
      error: () => {
        this.detailBusy.set(false);
        this.showReject.set(false);
      },
    });
  }

  formatJson(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
}

function emptyPager() {
  return {
    totalItemCount: 0,
    filter: null,
    currentPage: 1,
    itemCountPerPage: 25,
    pageNo: 1,
    pageSize: 25,
  };
}
