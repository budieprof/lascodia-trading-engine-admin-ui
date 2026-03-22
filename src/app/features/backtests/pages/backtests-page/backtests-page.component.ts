import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, map } from 'rxjs';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { TabsComponent } from '@shared/components/ui/tabs/tabs.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { BacktestsService } from '@core/services/backtests.service';
import { WalkForwardService } from '@core/services/walk-forward.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ColDef } from 'ag-grid-community';
import { PagedData, PagerRequest, BacktestRunDto, WalkForwardRunDto, ResponseData } from '@core/api/api.types';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';

@Component({
  selector: 'app-backtests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, DataTableComponent, TabsComponent, FormsModule],
  template: `
    <div class="page">
      <app-page-header title="Backtesting" subtitle="Run and review historical strategy simulations">
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
        <app-data-table
          [columnDefs]="backtestColumns"
          [fetchData]="fetchBacktests"
          (rowClick)="onBacktestClick($event)"
        />
      } @else {
        <app-data-table
          [columnDefs]="walkForwardColumns"
          [fetchData]="fetchWalkForward"
          (rowClick)="onWalkForwardClick($event)"
        />
      }
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .btn-primary {
      height: 36px; padding: 0 var(--space-5); background: var(--accent); color: white;
      border: none; border-radius: var(--radius-full); font-size: var(--text-sm);
      font-weight: var(--font-medium); cursor: pointer; font-family: inherit;
      transition: all 0.15s ease;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:active { transform: scale(0.97); }
    .btn-secondary {
      height: 36px; padding: 0 var(--space-5); background: var(--bg-tertiary); color: var(--text-primary);
      border: none; border-radius: var(--radius-full); font-size: var(--text-sm);
      font-weight: var(--font-medium); cursor: pointer; font-family: inherit;
    }

    .form-card {
      background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md);
      padding: var(--card-padding); margin-bottom: var(--space-4);
    }
    .form-title { font-size: var(--text-base); font-weight: var(--font-semibold); margin: 0 0 var(--space-4); color: var(--text-primary); }
    .form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); margin-bottom: var(--space-4); }
    .field { display: flex; flex-direction: column; gap: var(--space-1); }
    .field label { font-size: var(--text-sm); color: var(--text-secondary); font-weight: var(--font-medium); }
    .field input, .field select {
      height: 40px; padding: 0 var(--space-3); border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary);
      font-size: var(--text-base); font-family: inherit; outline: none;
    }
    .field input:focus, .field select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,113,227,0.3); }
    .form-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
  `],
})
export class BacktestsPageComponent {
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

  backtestColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'strategyId', headerName: 'Strategy', width: 100 },
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    { field: 'status', headerName: 'Status', width: 110, cellRenderer: (p: any) => `<span style="font-size:12px;font-weight:600">${p.value}</span>` },
    { field: 'initialBalance', headerName: 'Balance', width: 110, valueFormatter: (p: any) => p.value ? `$${p.value.toLocaleString()}` : '-' },
    { field: 'startedAt', headerName: 'Started', width: 140, valueFormatter: (p: any) => p.value ? new Date(p.value).toLocaleDateString() : '-' },
    { field: 'completedAt', headerName: 'Completed', width: 140, valueFormatter: (p: any) => p.value ? new Date(p.value).toLocaleDateString() : '-' },
  ];

  walkForwardColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'strategyId', headerName: 'Strategy', width: 100 },
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    { field: 'status', headerName: 'Status', width: 110 },
    { field: 'inSampleDays', headerName: 'IS Days', width: 100 },
    { field: 'outOfSampleDays', headerName: 'OOS Days', width: 100 },
    { field: 'averageOutOfSampleScore', headerName: 'OOS Score', width: 110, valueFormatter: (p: any) => p.value ? `${(p.value * 100).toFixed(1)}%` : '-' },
    { field: 'startedAt', headerName: 'Started', width: 140, valueFormatter: (p: any) => p.value ? new Date(p.value).toLocaleDateString() : '-' },
  ];

  fetchBacktests = (params: PagerRequest): Observable<PagedData<BacktestRunDto>> => {
    return this.backtestsService.list(params).pipe(
      map((res: ResponseData<PagedData<BacktestRunDto>>) => res.data ?? { pager: { totalItemCount: 0, currentPage: 1, itemCountPerPage: 25, pageNo: 0, pageSize: 25, filter: null }, data: [] }),
    );
  };

  fetchWalkForward = (params: PagerRequest): Observable<PagedData<WalkForwardRunDto>> => {
    return this.walkForwardService.list(params).pipe(
      map((res: ResponseData<PagedData<WalkForwardRunDto>>) => res.data ?? { pager: { totalItemCount: 0, currentPage: 1, itemCountPerPage: 25, pageNo: 0, pageSize: 25, filter: null }, data: [] }),
    );
  };

  onBacktestClick(row: BacktestRunDto) {
    this.router.navigate(['/backtests', row.id]);
  }

  onWalkForwardClick(row: WalkForwardRunDto) {
    this.router.navigate(['/walk-forward', row.id]);
  }

  queueBacktest() {
    this.backtestsService.create({
      strategyId: this.formData.strategyId,
      symbol: this.formData.symbol,
      timeframe: this.formData.timeframe as any,
      initialBalance: this.formData.initialBalance,
      fromDate: this.formData.fromDate,
      toDate: this.formData.toDate,
    }).subscribe({
      next: () => {
        this.notifications.success('Backtest queued successfully');
        this.showForm.set(false);
      },
      error: () => this.notifications.error('Failed to queue backtest'),
    });
  }
}
