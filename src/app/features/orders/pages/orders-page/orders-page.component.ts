import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { map } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { OrdersService } from '@core/services/orders.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  OrderDto,
  PagedData,
  PagerRequest,
  CreateOrderRequest,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';

@Component({
  selector: 'app-orders-page',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Orders" subtitle="Manage and monitor trading orders">
        <button class="btn btn-primary" (click)="toggleCreateForm()">
          @if (showCreateForm()) {
            Close Form
          } @else {
            + Create Order
          }
        </button>
      </app-page-header>

      <!-- Create Order Slide-Down Panel -->
      @if (showCreateForm()) {
        <div class="create-panel" @slideDown>
          <div class="create-card">
            <div class="create-card-header">
              <h3 class="create-card-title">Create New Order</h3>
              <button class="close-btn" (click)="showCreateForm.set(false)">&times;</button>
            </div>
            <form [formGroup]="createForm" (ngSubmit)="onCreateSubmit()" class="create-card-body">
              <div class="form-grid-3">
                <div class="form-field">
                  <label class="form-label">Symbol *</label>
                  <input class="form-input" formControlName="symbol" placeholder="e.g. EURUSD" />
                  @if (createForm.get('symbol')?.touched && createForm.get('symbol')?.errors?.['required']) {
                    <span class="form-error">Symbol is required</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Strategy ID *</label>
                  <input class="form-input" type="number" formControlName="strategyId" placeholder="Strategy ID" />
                  @if (createForm.get('strategyId')?.touched && createForm.get('strategyId')?.errors?.['required']) {
                    <span class="form-error">Strategy ID is required</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Trading Account ID *</label>
                  <input class="form-input" type="number" formControlName="tradingAccountId" placeholder="Account ID" />
                  @if (createForm.get('tradingAccountId')?.touched && createForm.get('tradingAccountId')?.errors?.['required']) {
                    <span class="form-error">Trading Account ID is required</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Order Type *</label>
                  <select class="form-select" formControlName="orderType">
                    <option value="" disabled>Select side</option>
                    <option value="Buy">Buy</option>
                    <option value="Sell">Sell</option>
                  </select>
                  @if (createForm.get('orderType')?.touched && createForm.get('orderType')?.errors?.['required']) {
                    <span class="form-error">Order type is required</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Execution Type *</label>
                  <select class="form-select" formControlName="executionType">
                    <option value="" disabled>Select execution</option>
                    <option value="Market">Market</option>
                    <option value="Limit">Limit</option>
                    <option value="Stop">Stop</option>
                    <option value="StopLimit">Stop Limit</option>
                  </select>
                  @if (createForm.get('executionType')?.touched && createForm.get('executionType')?.errors?.['required']) {
                    <span class="form-error">Execution type is required</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Quantity *</label>
                  <input class="form-input" type="number" formControlName="quantity" placeholder="0.00" step="0.01" />
                  @if (createForm.get('quantity')?.touched && createForm.get('quantity')?.errors?.['required']) {
                    <span class="form-error">Quantity is required</span>
                  }
                  @if (createForm.get('quantity')?.errors?.['min']) {
                    <span class="form-error">Must be greater than 0</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Price *</label>
                  <input class="form-input" type="number" formControlName="price" placeholder="0.00000" step="0.00001" />
                  @if (createForm.get('price')?.touched && createForm.get('price')?.errors?.['required']) {
                    <span class="form-error">Price is required</span>
                  }
                  @if (createForm.get('price')?.errors?.['min']) {
                    <span class="form-error">Must be greater than 0</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Stop Loss</label>
                  <input class="form-input" type="number" formControlName="stopLoss" placeholder="Optional" step="0.00001" />
                </div>
                <div class="form-field">
                  <label class="form-label">Take Profit</label>
                  <input class="form-input" type="number" formControlName="takeProfit" placeholder="Optional" step="0.00001" />
                </div>
                <div class="form-field form-field-full">
                  <label class="form-checkbox-label">
                    <input type="checkbox" formControlName="isPaper" />
                    <span>Paper Trading</span>
                  </label>
                </div>
                <div class="form-field form-field-full">
                  <label class="form-label">Notes</label>
                  <textarea class="form-textarea" formControlName="notes" rows="2" placeholder="Optional notes..."></textarea>
                </div>
              </div>
              <div class="create-actions">
                <button type="button" class="btn btn-secondary" (click)="showCreateForm.set(false)" [disabled]="creating()">
                  Cancel
                </button>
                <button type="submit" class="btn btn-primary" [disabled]="createForm.invalid || creating()">
                  @if (creating()) {
                    <span class="spinner"></span>
                  } @else {
                    Create Order
                  }
                </button>
              </div>
            </form>
          </div>
        </div>
      }

      <!-- Tabs -->
      <ui-tabs [tabs]="tabItems" [(activeTab)]="activeTab">
        @switch (activeTab()) {
          @case ('all') {
            <!-- Summary Metrics -->
            <div class="metrics-strip">
              <app-metric-card
                label="Total Orders"
                [value]="totalOrders()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Filled Orders"
                [value]="filledOrders()"
                format="number"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Pending Orders"
                [value]="pendingOrders()"
                format="number"
                dotColor="#FF9500"
              />
              <app-metric-card
                label="Fill Rate"
                [value]="fillRate()"
                format="percent"
                dotColor="#5856D6"
              />
            </div>

            <!-- Filter Bar -->
            <div class="filter-bar">
              <div class="filter-group">
                <label class="filter-label">Status</label>
                <select class="filter-select" [ngModel]="filterStatus()" (ngModelChange)="onFilterStatusChange($event)">
                  <option value="">All Statuses</option>
                  <option value="Pending">Pending</option>
                  <option value="Submitted">Submitted</option>
                  <option value="Filled">Filled</option>
                  <option value="Cancelled">Cancelled</option>
                  <option value="Rejected">Rejected</option>
                  <option value="Expired">Expired</option>
                </select>
              </div>
              <div class="filter-group">
                <label class="filter-label">Side</label>
                <select class="filter-select" [ngModel]="filterSide()" (ngModelChange)="onFilterSideChange($event)">
                  <option value="">All Sides</option>
                  <option value="Buy">Buy</option>
                  <option value="Sell">Sell</option>
                </select>
              </div>
              <div class="filter-group">
                <label class="filter-label">Mode</label>
                <div class="toggle-group">
                  <button
                    class="toggle-btn"
                    [class.active]="filterPaper() === null"
                    (click)="onFilterPaperChange(null)"
                  >All</button>
                  <button
                    class="toggle-btn"
                    [class.active]="filterPaper() === false"
                    (click)="onFilterPaperChange(false)"
                  >Live</button>
                  <button
                    class="toggle-btn"
                    [class.active]="filterPaper() === true"
                    (click)="onFilterPaperChange(true)"
                  >Paper</button>
                </div>
              </div>
              @if (hasActiveFilters()) {
                <button class="btn-clear-filters" (click)="clearFilters()">Clear Filters</button>
              }
            </div>

            <!-- Data Table -->
            <app-data-table
              #ordersTable
              [columnDefs]="columns"
              [fetchData]="fetchData"
              [searchable]="true"
              (rowClick)="onRowClick($event)"
            />
          }

          @case ('analytics') {
            <div class="charts-grid">
              <app-chart-card
                title="Orders by Status"
                subtitle="Distribution of order statuses"
                [options]="ordersByStatusChart()"
                height="320px"
              />
              <app-chart-card
                title="Orders Over Time"
                subtitle="Orders placed in the last 30 days"
                [options]="ordersOverTimeChart()"
                height="320px"
              />
              <app-chart-card
                title="Buy vs Sell Distribution"
                subtitle="Order side breakdown"
                [options]="buySellChart()"
                height="320px"
              />
              <app-chart-card
                title="Fill Rate Trend"
                subtitle="Fill rate percentage over last 30 days"
                [options]="fillRateTrendChart()"
                height="320px"
              />
            </div>
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }

    /* Buttons */
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
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }

    .btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
    .btn-secondary:hover:not(:disabled) { opacity: 0.8; }

    /* Metrics Strip */
    .metrics-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-5);
    }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      align-items: flex-end;
      gap: var(--space-4);
      padding: var(--space-4);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-4);
      flex-wrap: wrap;
    }

    .filter-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .filter-label {
      font-size: var(--text-xs);
      font-weight: var(--font-medium);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .filter-select {
      height: 34px;
      padding: 0 var(--space-3);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: var(--text-sm);
      font-family: inherit;
      cursor: pointer;
      min-width: 140px;
    }
    .filter-select:focus { border-color: var(--accent); outline: none; }

    .toggle-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .toggle-btn {
      height: 32px;
      padding: 0 var(--space-3);
      border: none;
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: var(--text-sm);
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      border-right: 1px solid var(--border);
    }
    .toggle-btn:last-child { border-right: none; }
    .toggle-btn.active {
      background: var(--accent);
      color: white;
    }
    .toggle-btn:hover:not(.active) {
      background: var(--bg-tertiary);
    }

    .btn-clear-filters {
      height: 34px;
      padding: 0 var(--space-3);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-secondary);
      font-size: var(--text-sm);
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-clear-filters:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    /* Create Panel */
    .create-panel {
      margin-bottom: var(--space-5);
      animation: slideDown 0.25s ease-out;
    }

    .create-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    .create-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--border);
    }

    .create-card-title {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0;
    }

    .close-btn {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: var(--radius-full);
      background: transparent;
      color: var(--text-secondary);
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    .close-btn:hover { background: var(--bg-tertiary); }

    .create-card-body {
      padding: var(--space-5);
    }

    .form-grid-3 {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-4);
    }

    .form-field { display: flex; flex-direction: column; }
    .form-field-full { grid-column: 1 / -1; }

    .form-label {
      display: block;
      font-size: var(--text-xs);
      font-weight: var(--font-medium);
      color: var(--text-secondary);
      margin-bottom: var(--space-1);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .form-input, .form-select, .form-textarea {
      width: 100%;
      height: 36px;
      padding: 0 var(--space-3);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: var(--text-sm);
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s ease;
      box-sizing: border-box;
    }

    .form-textarea {
      height: auto;
      padding: var(--space-2) var(--space-3);
      resize: vertical;
    }

    .form-input:focus, .form-select:focus, .form-textarea:focus {
      border-color: var(--accent);
    }

    .form-error {
      display: block;
      font-size: var(--text-xs);
      color: var(--loss);
      margin-top: 2px;
    }

    .form-checkbox-label {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-sm);
      color: var(--text-primary);
      cursor: pointer;
    }
    .form-checkbox-label input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
      cursor: pointer;
    }

    .create-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-3);
      padding-top: var(--space-4);
      border-top: 1px solid var(--border);
      margin-top: var(--space-4);
    }

    /* Charts Grid */
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
    }

    /* Spinner */
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-12px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `],
})
export class OrdersPageComponent {
  private readonly ordersService = inject(OrdersService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  private readonly dataTable = viewChild<DataTableComponent<OrderDto>>('ordersTable');

  // Tab state
  tabItems: TabItem[] = [
    { label: 'All Orders', value: 'all' },
    { label: 'Order Analytics', value: 'analytics' },
  ];
  activeTab = signal('all');

  // Create form state
  showCreateForm = signal(false);
  creating = signal(false);

  // Filter state
  filterStatus = signal('');
  filterSide = signal('');
  filterPaper = signal<boolean | null>(null);

  hasActiveFilters = computed(
    () => this.filterStatus() !== '' || this.filterSide() !== '' || this.filterPaper() !== null,
  );

  // Computed metrics from loaded data
  private ordersList = signal<OrderDto[]>([]);
  totalOrders = computed(() => this.ordersList().length);
  filledOrders = computed(() => this.ordersList().filter((o) => o.status === 'Filled').length);
  pendingOrders = computed(() => this.ordersList().filter((o) => o.status === 'Pending').length);
  fillRate = computed(() => {
    const total = this.totalOrders();
    if (total === 0) return 0;
    return (this.filledOrders() / total) * 100;
  });

  // Create form
  createForm = this.fb.nonNullable.group({
    symbol: ['', Validators.required],
    strategyId: [null as number | null, Validators.required],
    tradingAccountId: [null as number | null, Validators.required],
    orderType: ['', Validators.required],
    executionType: ['', Validators.required],
    quantity: [null as number | null, [Validators.required, Validators.min(0.001)]],
    price: [null as number | null, [Validators.required, Validators.min(0)]],
    stopLoss: [null as number | null],
    takeProfit: [null as number | null],
    isPaper: [false],
    notes: [''],
  });

  // AG Grid columns
  columns: ColDef<OrderDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    { headerName: 'Symbol', field: 'symbol', width: 100 },
    {
      headerName: 'Side',
      field: 'orderType',
      width: 90,
      cellRenderer: (params: { value: number | string }) => {
        const v = params.value;
        const isBuy = v === 0 || v === 'Buy';
        const label = isBuy ? 'BUY' : 'SELL';
        const color = isBuy ? '#248A3D' : '#D70015';
        const bg = isBuy ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)';
        return `<span style="color:${color};background:${bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Type',
      field: 'executionType',
      width: 100,
      cellRenderer: (params: { value: number | string }) => {
        const execMap: Record<number, string> = { 0: 'Market', 1: 'Limit', 2: 'Stop', 3: 'StopLimit' };
        const v = params.value;
        const label = typeof v === 'number' ? (execMap[v] ?? String(v)) : v;
        return `<span style="font-size:12px;font-weight:500">${label}</span>`;
      },
    },
    {
      headerName: 'Quantity',
      field: 'quantity',
      width: 100,
      valueFormatter: (params) => params.value != null ? Number(params.value).toFixed(2) : '-',
    },
    {
      headerName: 'Price',
      field: 'price',
      width: 110,
      valueFormatter: (params) => params.value != null ? Number(params.value).toFixed(5) : '-',
    },
    {
      headerName: 'SL',
      field: 'stopLoss',
      width: 100,
      valueFormatter: (params) => params.value != null ? Number(params.value).toFixed(5) : '-',
    },
    {
      headerName: 'TP',
      field: 'takeProfit',
      width: 100,
      valueFormatter: (params) => params.value != null ? Number(params.value).toFixed(5) : '-',
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 120,
      cellRenderer: (params: { value: number | string }) => {
        const statusNumMap: Record<number, string> = {
          0: 'Pending', 1: 'Submitted', 2: 'PartialFill', 3: 'Filled',
          4: 'Cancelled', 5: 'Rejected', 6: 'Expired',
        };
        const statusStyleMap: Record<string, { bg: string; color: string }> = {
          Pending: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          Submitted: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          PartialFill: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Filled: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Cancelled: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Expired: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
        };
        const v = params.value;
        const label = typeof v === 'number' ? (statusNumMap[v] ?? String(v)) : v;
        const s = statusStyleMap[label] ?? statusStyleMap['Expired'];
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Filled Price',
      field: 'filledPrice',
      width: 110,
      valueFormatter: (params) => params.value != null ? Number(params.value).toFixed(5) : '-',
    },
    {
      headerName: 'Paper',
      field: 'isPaper',
      width: 80,
      cellRenderer: (params: { value: boolean }) => {
        const label = params.value ? 'Paper' : 'Live';
        const bg = params.value ? 'rgba(0,113,227,0.12)' : 'rgba(52,199,89,0.12)';
        const color = params.value ? '#0040DD' : '#248A3D';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Created',
      field: 'createdAt',
      width: 160,
      valueFormatter: (params) => {
        if (!params.value) return '-';
        try {
          return new Date(params.value).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
        } catch {
          return params.value;
        }
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    const filter: Record<string, string> = {};
    if (this.filterStatus()) filter['status'] = this.filterStatus();
    if (this.filterSide()) filter['orderType'] = this.filterSide();

    const requestParams: PagerRequest = {
      ...params,
      filter: Object.keys(filter).length > 0 ? filter : (params.filter || null),
    };

    return this.ordersService.list(requestParams).pipe(
      map((response) => {
        if (response.data) {
          this.ordersList.set(response.data.data);
          return response.data;
        }
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
        } as PagedData<OrderDto>;
      }),
    );
  };

  // ----- Chart Options -----

  ordersByStatusChart = computed<EChartsOption>(() => ({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#8E8E93', fontSize: 12 } },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
        data: [
          { value: 45, name: 'Filled', itemStyle: { color: '#34C759' } },
          { value: 12, name: 'Pending', itemStyle: { color: '#FF9500' } },
          { value: 8, name: 'Cancelled', itemStyle: { color: '#8E8E93' } },
          { value: 3, name: 'Rejected', itemStyle: { color: '#FF3B30' } },
          { value: 5, name: 'Submitted', itemStyle: { color: '#0071E3' } },
          { value: 2, name: 'Expired', itemStyle: { color: '#636366' } },
        ],
      },
    ],
  }));

  ordersOverTimeChart = computed<EChartsOption>(() => {
    const days: string[] = [];
    const values: number[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      values.push(Math.floor(Math.random() * 8) + 1);
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 16, top: 16, bottom: 32 },
      xAxis: {
        type: 'category',
        data: days,
        axisLabel: { fontSize: 10, color: '#8E8E93', rotate: 45, interval: 4 },
        axisLine: { lineStyle: { color: '#3A3A3C' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#8E8E93' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      series: [
        {
          type: 'bar',
          data: values,
          itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          barWidth: '60%',
        },
      ],
    };
  });

  buySellChart = computed<EChartsOption>(() => ({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#8E8E93', fontSize: 12 } },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
        data: [
          { value: 38, name: 'Buy', itemStyle: { color: '#34C759' } },
          { value: 37, name: 'Sell', itemStyle: { color: '#FF3B30' } },
        ],
      },
    ],
  }));

  fillRateTrendChart = computed<EChartsOption>(() => {
    const days: string[] = [];
    const values: number[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      values.push(Math.round(55 + Math.random() * 40));
    }
    return {
      tooltip: { trigger: 'axis', formatter: '{b}<br/>Fill Rate: {c}%' },
      grid: { left: 40, right: 16, top: 16, bottom: 32 },
      xAxis: {
        type: 'category',
        data: days,
        axisLabel: { fontSize: 10, color: '#8E8E93', rotate: 45, interval: 4 },
        axisLine: { lineStyle: { color: '#3A3A3C' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { fontSize: 10, color: '#8E8E93', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { color: '#5856D6', width: 2 },
          itemStyle: { color: '#5856D6' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(88,86,214,0.3)' },
                { offset: 1, color: 'rgba(88,86,214,0.02)' },
              ],
            } as any,
          },
        },
      ],
    };
  });

  // ----- Actions -----

  toggleCreateForm(): void {
    this.showCreateForm.update((v) => !v);
    if (this.showCreateForm()) {
      this.createForm.reset({
        symbol: '',
        strategyId: null,
        tradingAccountId: null,
        orderType: '',
        executionType: '',
        quantity: null,
        price: null,
        stopLoss: null,
        takeProfit: null,
        isPaper: false,
        notes: '',
      });
    }
  }

  onCreateSubmit(): void {
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }
    this.creating.set(true);
    const v = this.createForm.getRawValue();
    const request: CreateOrderRequest = {
      symbol: v.symbol,
      orderType: v.orderType,
      executionType: v.executionType,
      quantity: v.quantity!,
      price: v.price!,
      stopLoss: v.stopLoss || null,
      takeProfit: v.takeProfit || null,
      strategyId: v.strategyId!,
      tradingAccountId: v.tradingAccountId!,
      notes: v.notes || null,
      isPaper: v.isPaper,
    };
    this.ordersService.create(request).subscribe({
      next: (response) => {
        this.creating.set(false);
        if (response.status) {
          this.showCreateForm.set(false);
          this.notifications.success('Order created successfully');
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(response.message ?? 'Failed to create order');
        }
      },
      error: () => {
        this.creating.set(false);
        this.notifications.error('Failed to create order');
      },
    });
  }

  onFilterStatusChange(value: string): void {
    this.filterStatus.set(value);
    this.reloadTable();
  }

  onFilterSideChange(value: string): void {
    this.filterSide.set(value);
    this.reloadTable();
  }

  onFilterPaperChange(value: boolean | null): void {
    this.filterPaper.set(value);
    this.reloadTable();
  }

  clearFilters(): void {
    this.filterStatus.set('');
    this.filterSide.set('');
    this.filterPaper.set(null);
    this.reloadTable();
  }

  onRowClick(order: OrderDto): void {
    this.router.navigate(['/orders', order.id]);
  }

  private reloadTable(): void {
    this.dataTable()?.loadData();
  }
}
