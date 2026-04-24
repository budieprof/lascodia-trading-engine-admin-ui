import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
// DatePipe + DecimalPipe instantiated directly in the class for column valueFormatters; no template pipes used.
import { Observable, map } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { WalkForwardService } from '@core/services/walk-forward.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CreateWalkForwardRequest,
  PagedData,
  PagerRequest,
  StrategyDto,
  Timeframe,
  WalkForwardRunDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';

@Component({
  selector: 'app-walk-forward-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
  ],
  template: `
    <div class="page">
      <app-page-header title="Walk-Forward" subtitle="Out-of-sample validation runs">
        <button type="button" class="btn btn-primary" (click)="togglePanel()">
          {{ showCreatePanel() ? 'Close' : 'Queue Run' }}
        </button>
      </app-page-header>

      @if (showCreatePanel()) {
        <form class="panel" [formGroup]="form" (ngSubmit)="submit()">
          <div class="panel-head">
            <h3>Queue Walk-Forward Run</h3>
            <button type="button" class="close" (click)="togglePanel()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field label="Strategy" [required]="true" [control]="form.controls.strategyId">
              <select appFormFieldControl formControlName="strategyId">
                <option [ngValue]="null">Select a strategy…</option>
                @for (s of strategies(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }} ({{ s.symbol }} {{ s.timeframe }})</option>
                }
              </select>
            </app-form-field>
            <app-form-field label="Symbol" [required]="true" [control]="form.controls.symbol">
              <input appFormFieldControl formControlName="symbol" placeholder="EURUSD" />
            </app-form-field>
            <app-form-field label="Timeframe" [required]="true" [control]="form.controls.timeframe">
              <select appFormFieldControl formControlName="timeframe">
                <option value="M1">M1</option>
                <option value="M5">M5</option>
                <option value="M15">M15</option>
                <option value="H1">H1</option>
                <option value="H4">H4</option>
                <option value="D1">D1</option>
              </select>
            </app-form-field>
            <app-form-field label="From" [required]="true" [control]="form.controls.fromDate">
              <input appFormFieldControl formControlName="fromDate" type="date" />
            </app-form-field>
            <app-form-field label="To" [required]="true" [control]="form.controls.toDate">
              <input appFormFieldControl formControlName="toDate" type="date" />
            </app-form-field>
            <app-form-field
              label="In-Sample Days"
              [required]="true"
              [control]="form.controls.inSampleDays"
            >
              <input appFormFieldControl formControlName="inSampleDays" type="number" min="1" />
            </app-form-field>
            <app-form-field
              label="OOS Days"
              [required]="true"
              [control]="form.controls.outOfSampleDays"
            >
              <input appFormFieldControl formControlName="outOfSampleDays" type="number" min="1" />
            </app-form-field>
            <app-form-field
              label="Initial Balance"
              [required]="true"
              [control]="form.controls.initialBalance"
            >
              <input
                appFormFieldControl
                formControlName="initialBalance"
                type="number"
                min="1"
                step="100"
              />
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="togglePanel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy() || form.invalid">
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Queue
                }
              </button>
            </div>
          </div>
        </form>
      }

      <app-data-table
        [columnDefs]="columnDefs"
        [fetchData]="fetch"
        [searchable]="true"
        (rowClick)="goToDetail($event)"
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
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
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
        min-width: 180px;
        flex: 1 1 180px;
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
export class WalkForwardPageComponent {
  private readonly service = inject(WalkForwardService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly decimalPipe = new DecimalPipe('en-US');
  private readonly datePipe = new DatePipe('en-US');

  readonly busy = signal(false);
  readonly showCreatePanel = signal(false);
  readonly strategies = signal<StrategyDto[]>([]);

  readonly form = this.fb.nonNullable.group({
    strategyId: [null as number | null, Validators.required],
    symbol: ['EURUSD', Validators.required],
    timeframe: ['H1' as Timeframe, Validators.required],
    fromDate: ['', Validators.required],
    toDate: ['', Validators.required],
    inSampleDays: [90, [Validators.required, Validators.min(1)]],
    outOfSampleDays: [30, [Validators.required, Validators.min(1)]],
    initialBalance: [10000, [Validators.required, Validators.min(1)]],
  });

  readonly columnDefs: ColDef<WalkForwardRunDto>[] = [
    { field: 'id', headerName: 'Run', width: 90 },
    { field: 'strategyId', headerName: 'Strategy', width: 100 },
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    {
      field: 'fromDate',
      headerName: 'From',
      width: 120,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, yyyy') ?? '-',
    },
    {
      field: 'toDate',
      headerName: 'To',
      width: 120,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, yyyy') ?? '-',
    },
    {
      field: 'averageOutOfSampleScore',
      headerName: 'Avg OOS',
      width: 110,
      valueFormatter: (p) => this.decimalPipe.transform(p.value as number, '1.2-2') ?? '-',
    },
    {
      field: 'scoreConsistency',
      headerName: 'Consistency',
      width: 120,
      valueFormatter: (p) => this.decimalPipe.transform(p.value as number, '1.2-2') ?? '-',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Walk-forward status' },
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      width: 150,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm') ?? '-',
    },
  ];

  readonly fetch = (params: PagerRequest): Observable<PagedData<WalkForwardRunDto>> =>
    this.service.list(params).pipe(map((res) => res.data ?? { pager: emptyPager(), data: [] }));

  constructor() {
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe((res) => {
      this.strategies.set(res.data?.data ?? []);
    });
  }

  togglePanel(): void {
    this.showCreatePanel.update((v) => !v);
  }

  submit(): void {
    const v = this.form.getRawValue();
    if (v.strategyId == null) return;
    const request: CreateWalkForwardRequest = {
      strategyId: v.strategyId,
      symbol: v.symbol,
      timeframe: v.timeframe,
      fromDate: v.fromDate,
      toDate: v.toDate,
      inSampleDays: v.inSampleDays,
      outOfSampleDays: v.outOfSampleDays,
      initialBalance: v.initialBalance,
    };
    this.busy.set(true);
    this.service.create(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status && res.data) {
          this.notifications.success(`Walk-forward run #${res.data.id} queued`);
          this.showCreatePanel.set(false);
          this.router.navigate(['/walk-forward', res.data.id]);
        } else {
          this.notifications.error(res.message ?? 'Failed to queue walk-forward run');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  goToDetail(row: WalkForwardRunDto): void {
    if (row?.id != null) this.router.navigate(['/walk-forward', row.id]);
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
