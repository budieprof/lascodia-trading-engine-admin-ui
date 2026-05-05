import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { map } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { OrdersService } from '@core/services/orders.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, merge, of, throttleTime } from 'rxjs';
import { DatePipe, DecimalPipe } from '@angular/common';
import type { OrderDto, PagedData, PagerRequest, CreateOrderRequest } from '@core/api/api.types';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { SavedViewsService, SavedView } from '@core/views/saved-views.service';

interface OrdersViewState {
  status: string;
  orderType: string;
  symbol: string;
}

@Component({
  selector: 'app-orders-page',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    DatePipe,
    DecimalPipe,
    RouterLink,
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    ConfirmDialogComponent,
    RelativeTimePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Orders" subtitle="Manage and monitor trading orders">
        <button
          type="button"
          class="btn btn-primary"
          (click)="toggleCreateForm()"
          [attr.aria-expanded]="showCreateForm()"
        >
          @if (showCreateForm()) {
            Close Form
          } @else {
            + Create Order
          }
        </button>
      </app-page-header>

      <!-- Create Order Slide-Down Panel -->
      @if (showCreateForm()) {
        <div class="create-panel">
          <div class="create-card">
            <div class="create-card-header">
              <h3 class="create-card-title">Create New Order</h3>
              <button
                type="button"
                class="close-btn"
                aria-label="Close create-order form"
                (click)="showCreateForm.set(false)"
              >
                &times;
              </button>
            </div>
            <form [formGroup]="createForm" (ngSubmit)="onCreateSubmit()" class="create-card-body">
              <div class="form-grid-3">
                <div class="form-field">
                  <label for="order-symbol" class="form-label"
                    >Symbol <abbr title="required" aria-label="required">*</abbr></label
                  >
                  <input
                    id="order-symbol"
                    class="form-input"
                    formControlName="symbol"
                    placeholder="e.g. EURUSD"
                    required
                    autocomplete="off"
                    aria-describedby="order-symbol-error"
                    [attr.aria-invalid]="hasError('symbol')"
                  />
                  @if (
                    createForm.get('symbol')?.touched &&
                    createForm.get('symbol')?.errors?.['required']
                  ) {
                    <span id="order-symbol-error" class="form-error" role="alert"
                      >Symbol is required</span
                    >
                  }
                </div>
                <div class="form-field">
                  <label for="order-strategy" class="form-label"
                    >Strategy ID <abbr title="required" aria-label="required">*</abbr></label
                  >
                  <input
                    id="order-strategy"
                    class="form-input"
                    type="number"
                    formControlName="strategyId"
                    placeholder="Strategy ID"
                    required
                    aria-describedby="order-strategy-error"
                    [attr.aria-invalid]="hasError('strategyId')"
                  />
                  @if (
                    createForm.get('strategyId')?.touched &&
                    createForm.get('strategyId')?.errors?.['required']
                  ) {
                    <span id="order-strategy-error" class="form-error" role="alert"
                      >Strategy ID is required</span
                    >
                  }
                </div>
                <div class="form-field">
                  <label for="order-account" class="form-label"
                    >Trading Account ID <abbr title="required" aria-label="required">*</abbr></label
                  >
                  <input
                    id="order-account"
                    class="form-input"
                    type="number"
                    formControlName="tradingAccountId"
                    placeholder="Account ID"
                    required
                    aria-describedby="order-account-error"
                    [attr.aria-invalid]="hasError('tradingAccountId')"
                  />
                  @if (
                    createForm.get('tradingAccountId')?.touched &&
                    createForm.get('tradingAccountId')?.errors?.['required']
                  ) {
                    <span id="order-account-error" class="form-error" role="alert"
                      >Trading Account ID is required</span
                    >
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Order Type *</label>
                  <select class="form-select" formControlName="orderType">
                    <option value="" disabled>Select side</option>
                    <option value="Buy">Buy</option>
                    <option value="Sell">Sell</option>
                  </select>
                  @if (
                    createForm.get('orderType')?.touched &&
                    createForm.get('orderType')?.errors?.['required']
                  ) {
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
                  @if (
                    createForm.get('executionType')?.touched &&
                    createForm.get('executionType')?.errors?.['required']
                  ) {
                    <span class="form-error">Execution type is required</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Quantity *</label>
                  <input
                    class="form-input"
                    type="number"
                    formControlName="quantity"
                    placeholder="0.00"
                    step="0.01"
                  />
                  @if (
                    createForm.get('quantity')?.touched &&
                    createForm.get('quantity')?.errors?.['required']
                  ) {
                    <span class="form-error">Quantity is required</span>
                  }
                  @if (createForm.get('quantity')?.errors?.['min']) {
                    <span class="form-error">Must be greater than 0</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Price *</label>
                  <input
                    class="form-input"
                    type="number"
                    formControlName="price"
                    placeholder="0.00000"
                    step="0.00001"
                  />
                  @if (
                    createForm.get('price')?.touched &&
                    createForm.get('price')?.errors?.['required']
                  ) {
                    <span class="form-error">Price is required</span>
                  }
                  @if (createForm.get('price')?.errors?.['min']) {
                    <span class="form-error">Must be greater than 0</span>
                  }
                </div>
                <div class="form-field">
                  <label class="form-label">Stop Loss</label>
                  <input
                    class="form-input"
                    type="number"
                    formControlName="stopLoss"
                    placeholder="Optional"
                    step="0.00001"
                  />
                </div>
                <div class="form-field">
                  <label class="form-label">Take Profit</label>
                  <input
                    class="form-input"
                    type="number"
                    formControlName="takeProfit"
                    placeholder="Optional"
                    step="0.00001"
                  />
                </div>
                <div class="form-field form-field-full">
                  <label class="form-checkbox-label">
                    <input type="checkbox" formControlName="isPaper" />
                    <span>Paper Trading</span>
                  </label>
                </div>
                <div class="form-field form-field-full">
                  <label class="form-label">Notes</label>
                  <textarea
                    class="form-textarea"
                    formControlName="notes"
                    rows="2"
                    placeholder="Optional notes..."
                  ></textarea>
                </div>
              </div>
              <div class="create-actions">
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="showCreateForm.set(false)"
                  [disabled]="creating()"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="createForm.invalid || creating()"
                >
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

      <!-- Saved views -->
      <div class="saved-views">
        @for (v of pinnedSavedViews(); track v.id) {
          <button
            type="button"
            class="view-pill"
            (click)="applySavedView(v)"
            [attr.aria-label]="'Restore saved view ' + v.label"
          >
            <span class="view-label">{{ v.label }}</span>
            <span
              class="view-remove"
              role="button"
              tabindex="0"
              aria-label="Remove saved view"
              (click)="removeSavedView(v.id, $event)"
              (keydown.enter)="removeSavedView(v.id, $event)"
              >×</span
            >
          </button>
        }
        <button type="button" class="view-save" (click)="saveCurrentView()">+ Save view</button>
      </div>

      <!-- Tabs -->
      <ui-tabs [tabs]="tabItems" [(activeTab)]="activeTab">
        @switch (activeTab()) {
          @case ('all') {
            <!-- Summary Metrics — 8 dense tiles, recent-orders-scoped (last 500) -->
            <div class="metrics-strip">
              <app-metric-card
                label="Total (recent)"
                [value]="totalOrders()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Pending"
                [value]="pendingOrders()"
                format="number"
                [dotColor]="pendingOrders() > 0 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Fill Rate"
                [value]="fillRate()"
                format="percent"
                dotColor="#5856D6"
              />
              <app-metric-card
                label="Today filled"
                [value]="filledToday()"
                format="number"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Today rejected"
                [value]="rejectedToday()"
                format="number"
                [dotColor]="rejectedToday() > 0 ? '#FF3B30' : '#8E8E93'"
              />
              <app-metric-card
                label="Today volume (lots)"
                [value]="volumeToday()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Avg fill latency"
                [value]="avgFillLatencyMs()"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Symbols traded"
                [value]="symbolsTraded()"
                format="number"
                dotColor="#5AC8FA"
              />
            </div>

            <!-- Filter chips — denser than the dropdowns, with live counts -->
            <div class="filter-row">
              <div class="chip-group" role="tablist" aria-label="Filter by status">
                @for (s of statusChips; track s) {
                  <button
                    type="button"
                    role="tab"
                    class="chip"
                    [attr.data-status]="s || null"
                    [class.active]="filterStatus() === s"
                    (click)="onFilterStatusChange(s)"
                    [attr.aria-selected]="filterStatus() === s"
                  >
                    {{ s === '' ? 'All' : s }}
                    <span class="chip-count">{{ statusCount(s) }}</span>
                  </button>
                }
              </div>
              <div class="chip-group" role="tablist" aria-label="Filter by side">
                @for (d of sideChips; track d) {
                  <button
                    type="button"
                    role="tab"
                    class="chip"
                    [class.active]="filterSide() === d"
                    [class.buy]="d === 'Buy'"
                    [class.sell]="d === 'Sell'"
                    (click)="onFilterSideChange(d)"
                    [attr.aria-selected]="filterSide() === d"
                  >
                    {{ d === '' ? 'All sides' : d }}
                  </button>
                }
              </div>
              <div class="chip-group" role="tablist" aria-label="Filter by mode">
                <button
                  type="button"
                  role="tab"
                  class="chip"
                  [class.active]="filterPaper() === null"
                  (click)="onFilterPaperChange(null)"
                >
                  All modes
                </button>
                <button
                  type="button"
                  role="tab"
                  class="chip"
                  [class.active]="filterPaper() === false"
                  (click)="onFilterPaperChange(false)"
                >
                  Live
                </button>
                <button
                  type="button"
                  role="tab"
                  class="chip"
                  [class.active]="filterPaper() === true"
                  (click)="onFilterPaperChange(true)"
                >
                  Paper
                </button>
              </div>
              @if (hasActiveFilters()) {
                <button class="chip chip-clear" (click)="clearFilters()">Clear filters</button>
              }
            </div>

            <!-- Data Table -->
            <app-data-table
              #ordersTable
              [columnDefs]="columns"
              [fetchData]="fetchData"
              [searchable]="true"
              [selectable]="true"
              (rowClick)="onRowClick($event)"
            >
              <ng-template #bulkActions let-rows let-clear="clear">
                <button
                  type="button"
                  class="btn btn-danger btn-sm"
                  [disabled]="batchCancelPending()"
                  (click)="openBatchCancel(rows, clear)"
                >
                  {{ batchCancelPending() ? 'Cancelling…' : 'Cancel ' + rows.length + ' selected' }}
                </button>
              </ng-template>
            </app-data-table>
          }

          @case ('analytics') {
            <!-- Analytics-specific KPI strip -->
            <div class="metrics-strip">
              <app-metric-card
                label="Latency p50"
                [value]="latencyP50Ms()"
                format="number"
                dotColor="#5856D6"
              />
              <app-metric-card
                label="Latency p95"
                [value]="latencyP95Ms()"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Avg slippage (pips)"
                [value]="avgSlippagePips()"
                format="number"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Reject rate"
                [value]="rejectRate()"
                format="percent"
                [dotColor]="rejectRate() > 5 ? '#FF3B30' : '#34C759'"
              />
              <app-metric-card
                label="Paper share"
                [value]="paperShare()"
                format="percent"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Top symbol"
                [value]="topSymbolCount()"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Top reject reason"
                [value]="topRejectionCount()"
                format="number"
                [dotColor]="topRejectionCount() > 0 ? '#FF3B30' : '#8E8E93'"
              />
              <app-metric-card
                label="Window size"
                [value]="totalOrders()"
                format="number"
                dotColor="#8E8E93"
              />
            </div>

            <!-- 4-column chart grid — 8 charts, 2 rows on standard widths -->
            <div class="analytics-grid">
              <app-chart-card
                title="Orders by Status"
                [subtitle]="totalOrders() + ' orders in window'"
                [options]="ordersByStatusChart()"
                height="240px"
              />
              <app-chart-card
                title="Activity (hour of day)"
                subtitle="When the engine places orders"
                [options]="hourlyActivityChart()"
                height="240px"
              />
              <app-chart-card
                title="Top Symbols"
                subtitle="By order count, stacked Buy/Sell"
                [options]="topSymbolsChart()"
                height="240px"
              />
              <app-chart-card
                title="Buy vs Sell"
                subtitle="Side mix, recent window"
                [options]="buySellChart()"
                height="240px"
              />
              <app-chart-card
                title="Fill Latency"
                [subtitle]="latencySubtitle()"
                [options]="latencyHistogramChart()"
                height="240px"
              />
              <app-chart-card
                title="Slippage Distribution"
                subtitle="Filled price vs order price (pips)"
                [options]="slippageHistogramChart()"
                height="240px"
              />
              <app-chart-card
                title="Top Rejection Reasons"
                subtitle="Most common reject causes"
                [options]="rejectionReasonsChart()"
                height="240px"
              />
              <app-chart-card
                title="Daily Volume + Fill %"
                subtitle="Last 30 days, count & fill rate"
                [options]="dailyVolumeWithFillChart()"
                height="240px"
              />
            </div>

            <!-- Per-symbol stats table — sortable column-by-column would need
                 ag-grid; this is read-only operational density. -->
            <section class="symbol-stats">
              <header class="symbol-stats-head">
                <h3>Per-Symbol Breakdown</h3>
                <span class="muted">Recent window · top 12 by count</span>
              </header>
              @if (perSymbolStats().length > 0) {
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="num">Orders</th>
                      <th class="num">Buy / Sell</th>
                      <th class="num">Filled</th>
                      <th class="num">Rejected</th>
                      <th class="num">Fill %</th>
                      <th class="num">Avg latency</th>
                      <th class="num">Avg slippage</th>
                      <th class="num">Volume (lots)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of perSymbolStats(); track s.symbol) {
                      <tr>
                        <td class="mono">{{ s.symbol }}</td>
                        <td class="num mono">{{ s.total }}</td>
                        <td class="num">
                          <span class="profit">{{ s.buys }}</span>
                          <span class="muted"> / </span>
                          <span class="loss">{{ s.sells }}</span>
                        </td>
                        <td class="num mono">{{ s.filled }}</td>
                        <td class="num mono" [class.loss]="s.rejected > 0">
                          {{ s.rejected }}
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.fillPct >= 80"
                          [class.loss]="s.fillPct < 50"
                        >
                          {{ s.fillPct.toFixed(0) }}%
                        </td>
                        <td class="num mono">{{ formatLatencyValue(s.avgLatencyMs) }}</td>
                        <td
                          class="num mono"
                          [class.profit]="s.avgSlippagePips !== null && s.avgSlippagePips <= 0"
                          [class.loss]="s.avgSlippagePips !== null && s.avgSlippagePips > 0"
                        >
                          {{
                            s.avgSlippagePips !== null
                              ? (s.avgSlippagePips >= 0 ? '+' : '') +
                                s.avgSlippagePips.toFixed(2) +
                                'p'
                              : '—'
                          }}
                        </td>
                        <td class="num mono">{{ s.volume.toFixed(2) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <div class="empty-stats">No orders in the recent window.</div>
              }
            </section>
          }
        }
      </ui-tabs>

      @if (selectedDetail(); as o) {
        <div class="drawer-backdrop" (click)="selectedDetail.set(null)">
          <aside class="drawer" (click)="$event.stopPropagation()" aria-label="Order details">
            <header class="drawer-head">
              <div>
                <h3>Order #{{ o.id }}</h3>
                <span class="muted">
                  {{ o.symbol }} · {{ o.orderType }} · {{ o.executionType }} · {{ o.status }}
                  @if (o.isPaper) {
                    · paper
                  }
                </span>
              </div>
              <button class="btn-close" (click)="selectedDetail.set(null)" aria-label="Close">
                ×
              </button>
            </header>

            <section class="drawer-section">
              <h4>Pricing</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Quantity</dt>
                  <dd class="mono">{{ o.quantity | number: '1.2-2' }}</dd>
                </div>
                <div>
                  <dt>Order price</dt>
                  <dd class="mono">{{ o.price | number: '1.5-5' }}</dd>
                </div>
                <div>
                  <dt>Stop loss</dt>
                  <dd class="mono">
                    {{ o.stopLoss !== null ? (o.stopLoss | number: '1.5-5') : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Take profit</dt>
                  <dd class="mono">
                    {{ o.takeProfit !== null ? (o.takeProfit | number: '1.5-5') : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Filled price</dt>
                  <dd class="mono">
                    {{ o.filledPrice !== null ? (o.filledPrice | number: '1.5-5') : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Filled qty</dt>
                  <dd class="mono">
                    {{ o.filledQuantity !== null ? (o.filledQuantity | number: '1.2-2') : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Slippage</dt>
                  <dd
                    class="mono"
                    [class.profit]="orderSlippage(o) !== null && orderSlippage(o)! <= 0"
                    [class.loss]="orderSlippage(o) !== null && orderSlippage(o)! > 0"
                  >
                    {{ orderSlippage(o) !== null ? slippageLabel(o) : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Fill latency</dt>
                  <dd class="mono">{{ fillLatencyLabel(o) }}</dd>
                </div>
              </dl>
            </section>

            <section class="drawer-section">
              <h4>Routing</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Trade signal</dt>
                  <dd class="mono">
                    @if (o.tradeSignalId !== null) {
                      <a [routerLink]="['/trade-signals']">#{{ o.tradeSignalId }} ↗</a>
                    } @else {
                      manual
                    }
                  </dd>
                </div>
                <div>
                  <dt>Broker order id</dt>
                  <dd class="mono trunc" [title]="o.brokerOrderId ?? ''">
                    {{ o.brokerOrderId ?? '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{{ o.isPaper ? 'Paper' : 'Live' }}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{{ o.createdAt | date: 'MMM d, HH:mm:ss' }}</dd>
                </div>
                <div>
                  <dt>Filled at</dt>
                  <dd>{{ o.filledAt ? (o.filledAt | date: 'MMM d, HH:mm:ss') : '—' }}</dd>
                </div>
              </dl>
            </section>

            @if (o.rejectionReason) {
              <section class="drawer-section">
                <h4>Rejection reason</h4>
                <pre class="reason mono">{{ o.rejectionReason }}</pre>
              </section>
            }

            @if (o.notes) {
              <section class="drawer-section">
                <h4>Notes</h4>
                <p class="notes">{{ o.notes }}</p>
              </section>
            }

            <footer class="drawer-actions">
              <a class="btn btn-secondary" [routerLink]="['/orders', o.id]">Open detail page →</a>
            </footer>
          </aside>
        </div>
      }

      <app-confirm-dialog
        [open]="batchCancelOpen()"
        title="Cancel selected orders"
        [message]="batchCancelMessage()"
        confirmLabel="Cancel orders"
        confirmVariant="destructive"
        [loading]="batchCancelPending()"
        (confirm)="confirmBatchCancel()"
        (cancelled)="cancelBatchCancelDialog()"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      /* Saved views */
      .saved-views {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: var(--space-4);
      }
      .view-pill {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        height: 28px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .view-pill:hover {
        background: var(--bg-secondary);
      }
      .view-remove {
        color: var(--text-tertiary);
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
        cursor: pointer;
      }
      .view-remove:hover {
        color: var(--text-primary);
      }
      .view-save {
        height: 28px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-full);
        border: 1px dashed var(--border);
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .view-save:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

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

      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        opacity: 0.8;
      }

      /* Metrics Strip — 8 tiles fit 4×2 on standard widths, 2×4 on tablets */
      .metrics-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1400px) {
        .metrics-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .metrics-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* Filter chips — replaces the old filter-bar dropdowns */
      .filter-row {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: var(--space-3);
      }
      .chip-group {
        display: inline-flex;
        gap: 2px;
        padding: 3px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .chip {
        height: 28px;
        padding: 0 12px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        font-family: inherit;
        border-radius: var(--radius-full);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .chip:hover:not(.active) {
        color: var(--text-primary);
      }
      .chip.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .chip[data-status='Pending'].active {
        color: #c93400;
      }
      .chip[data-status='Filled'].active {
        color: #248a3d;
      }
      .chip[data-status='Rejected'].active {
        color: #d70015;
      }
      .chip.buy.active {
        color: #248a3d;
      }
      .chip.sell.active {
        color: #d70015;
      }
      .chip-count {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        padding: 1px 7px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      .chip.active .chip-count {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .chip-clear {
        background: rgba(255, 59, 48, 0.08);
        color: #d70015;
      }
      .chip-clear:hover {
        background: rgba(255, 59, 48, 0.15);
      }

      /* Detail drawer (right slide-in) */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 100;
        display: flex;
        justify-content: flex-end;
      }
      .drawer {
        width: 100%;
        max-width: 460px;
        background: var(--bg-secondary);
        border-left: 1px solid var(--border);
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        overflow-y: auto;
      }
      .drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .drawer-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .drawer-head .muted {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .btn-close {
        background: transparent;
        border: none;
        font-size: 22px;
        cursor: pointer;
        color: var(--text-tertiary);
      }
      .drawer-section {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .drawer-section h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .drawer-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .drawer-grid dt {
        font-size: 10.5px;
        color: var(--text-tertiary);
        margin: 0;
      }
      .drawer-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .drawer-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .drawer-grid dd.trunc {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .drawer-grid dd.profit {
        color: var(--profit);
      }
      .drawer-grid dd.loss {
        color: var(--loss);
      }
      .drawer-grid dd a {
        color: var(--accent);
      }
      .reason {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        background: rgba(255, 59, 48, 0.06);
        border: 1px solid rgba(255, 59, 48, 0.2);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: var(--text-xs);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .notes {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .drawer-actions {
        padding: var(--space-4) var(--space-5);
        display: flex;
        gap: var(--space-2);
      }
      .drawer-actions .btn {
        flex: 1;
        height: 36px;
        text-decoration: none;
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
      .filter-select:focus {
        border-color: var(--accent);
        outline: none;
      }

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
      .toggle-btn:last-child {
        border-right: none;
      }
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
      .close-btn:hover {
        background: var(--bg-tertiary);
      }

      .create-card-body {
        padding: var(--space-5);
      }

      .form-grid-3 {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
      }

      .form-field {
        display: flex;
        flex-direction: column;
      }
      .form-field-full {
        grid-column: 1 / -1;
      }

      .form-label {
        display: block;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .form-input,
      .form-select,
      .form-textarea {
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

      .form-input:focus,
      .form-select:focus,
      .form-textarea:focus {
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
      .form-checkbox-label input[type='checkbox'] {
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

      .analytics-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1400px) {
        .analytics-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 720px) {
        .analytics-grid {
          grid-template-columns: 1fr;
        }
      }

      .symbol-stats {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .symbol-stats-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .symbol-stats-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .symbol-stats-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .stats-table {
        width: 100%;
        border-collapse: collapse;
      }
      .stats-table th,
      .stats-table td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .stats-table tbody tr:last-child td {
        border-bottom: none;
      }
      .stats-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .stats-table th.num,
      .stats-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .stats-table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .stats-table .profit {
        color: var(--profit);
      }
      .stats-table .loss {
        color: var(--loss);
      }
      .empty-stats {
        padding: var(--space-6) var(--space-5);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
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

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes slideDown {
        from {
          opacity: 0;
          transform: translateY(-12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ],
})
export class OrdersPageComponent {
  private readonly ordersService = inject(OrdersService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);
  private readonly realtime = inject(RealtimeService);
  private readonly savedViewsService = inject(SavedViewsService);

  readonly savedViews = this.savedViewsService.forRoute<OrdersViewState>('/orders');
  readonly pinnedSavedViews = computed(() => this.savedViews().filter((v) => v.pinned));

  private readonly dataTable = viewChild<DataTableComponent<OrderDto>>('ordersTable');

  constructor() {
    // Refresh the orders table whenever the engine pushes an order- or
    // position-level event. Throttled so a burst of fills doesn't hammer
    // the fetch endpoint — 2s is faster than the old 15s polling interval
    // and still human-scale enough to batch together rapid-fire updates.
    merge(
      this.realtime.on('orderCreated'),
      this.realtime.on('orderFilled'),
      this.realtime.on('positionOpened'),
      this.realtime.on('positionClosed'),
    )
      .pipe(throttleTime(2_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.reloadTable();
        this.loadRecent();
      });

    this.loadRecent();
  }

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

  /** True when a given form control is invalid AND has been touched or dirtied.
   *  Used to toggle `aria-invalid` on inputs. */
  hasError(fieldName: string): boolean {
    const c = this.createForm.get(fieldName);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  // ── Recent orders snapshot ──────────────────────────────────────────
  // The data-table only loads the current page (≤25 rows by default), so
  // computing KPIs / charts off the table view caps "Total Orders" at 25.
  // recentOrders pulls a wider window (500) decoupled from pagination so
  // the metrics + analytics tab always reflect the engine's recent reality.
  // Refreshed on every realtime push (orderCreated/Filled, position events).
  private readonly recentOrders = signal<OrderDto[]>([]);

  // Kept for backwards compatibility — column-renderers refer to the latest
  // table page. Charts/KPIs now read from recentOrders.
  private readonly ordersList = signal<OrderDto[]>([]);

  readonly totalOrders = computed(() => this.recentOrders().length);
  readonly filledOrders = computed(
    () => this.recentOrders().filter((o) => o.status === 'Filled').length,
  );
  readonly pendingOrders = computed(
    () => this.recentOrders().filter((o) => o.status === 'Pending').length,
  );
  readonly fillRate = computed(() => {
    const total = this.totalOrders();
    if (total === 0) return 0;
    return (this.filledOrders() / total) * 100;
  });

  // ── Today-scoped KPIs ──────────────────────────────────────────────
  private startOfTodayMs = (): number => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  readonly filledToday = computed(
    () =>
      this.recentOrders().filter(
        (o) => o.status === 'Filled' && new Date(o.createdAt).getTime() >= this.startOfTodayMs(),
      ).length,
  );
  readonly rejectedToday = computed(
    () =>
      this.recentOrders().filter(
        (o) => o.status === 'Rejected' && new Date(o.createdAt).getTime() >= this.startOfTodayMs(),
      ).length,
  );
  readonly volumeToday = computed(() => {
    const start = this.startOfTodayMs();
    return this.recentOrders()
      .filter((o) => o.status === 'Filled' && new Date(o.createdAt).getTime() >= start)
      .reduce((s, o) => s + (o.filledQuantity ?? o.quantity ?? 0), 0);
  });

  // Mean ms between createdAt → filledAt for orders filled in the recent
  // window. Tells the operator at a glance whether the broker round-trip is
  // healthy without opening the analytics tab.
  readonly avgFillLatencyMs = computed(() => {
    const filled = this.recentOrders().filter((o) => o.status === 'Filled' && o.filledAt !== null);
    if (filled.length === 0) return 0;
    const sum = filled.reduce((acc, o) => {
      const ms = new Date(o.filledAt!).getTime() - new Date(o.createdAt).getTime();
      return acc + Math.max(0, ms);
    }, 0);
    return Math.round(sum / filled.length);
  });

  readonly symbolsTraded = computed(() => {
    const set = new Set<string>();
    for (const o of this.recentOrders()) {
      if (o.symbol) set.add(o.symbol);
    }
    return set.size;
  });

  // ── Filter helpers (chip-driven) ──────────────────────────────────
  readonly statusChips: string[] = [
    '',
    'Pending',
    'Submitted',
    'Filled',
    'PartialFill',
    'Cancelled',
    'Rejected',
    'Expired',
  ];
  readonly sideChips: string[] = ['', 'Buy', 'Sell'];

  statusCount(s: string): number {
    if (s === '') return this.recentOrders().length;
    return this.recentOrders().filter((o) => o.status === s).length;
  }

  private loadRecent(): void {
    this.ordersService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const rows = res?.data?.data ?? [];
        this.recentOrders.set(rows);
      });
  }

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
    {
      headerName: 'Signal',
      field: 'tradeSignalId',
      width: 80,
      cellClass: 'mono',
      valueFormatter: (p) => (p.value != null ? `#${p.value}` : '—'),
    },
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
        const execMap: Record<number, string> = {
          0: 'Market',
          1: 'Limit',
          2: 'Stop',
          3: 'StopLimit',
        };
        const v = params.value;
        const label = typeof v === 'number' ? (execMap[v] ?? String(v)) : v;
        return `<span style="font-size:12px;font-weight:500">${label}</span>`;
      },
    },
    {
      headerName: 'Quantity',
      field: 'quantity',
      width: 100,
      valueFormatter: (params) => (params.value != null ? Number(params.value).toFixed(2) : '-'),
    },
    {
      headerName: 'Price',
      field: 'price',
      width: 110,
      valueFormatter: (params) => (params.value != null ? Number(params.value).toFixed(5) : '-'),
    },
    {
      headerName: 'SL',
      field: 'stopLoss',
      width: 100,
      valueFormatter: (params) => (params.value != null ? Number(params.value).toFixed(5) : '-'),
    },
    {
      headerName: 'TP',
      field: 'takeProfit',
      width: 100,
      valueFormatter: (params) => (params.value != null ? Number(params.value).toFixed(5) : '-'),
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 120,
      cellRenderer: (params: { value: number | string; data: OrderDto }) => {
        const statusNumMap: Record<number, string> = {
          0: 'Pending',
          1: 'Submitted',
          2: 'PartialFill',
          3: 'Filled',
          4: 'Cancelled',
          5: 'Rejected',
          6: 'Expired',
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
        // Hover-tooltip the rejection reason on the pill so the operator can scan
        // a row of failures without opening each detail drawer.
        const reason =
          label === 'Rejected' && params.data.rejectionReason
            ? ` title="${escapeAttribute(params.data.rejectionReason)}"`
            : '';
        return `<span${reason} style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Filled Price',
      field: 'filledPrice',
      width: 110,
      valueFormatter: (params) => (params.value != null ? Number(params.value).toFixed(5) : '-'),
    },
    {
      headerName: 'Filled Qty',
      field: 'filledQuantity',
      width: 100,
      valueFormatter: (p) => (p.value != null ? Number(p.value).toFixed(2) : '—'),
    },
    {
      headerName: 'Fill Latency',
      colId: 'fillLatency',
      width: 110,
      cellClass: 'mono',
      valueGetter: (p) => fillLatencyMs(p.data as OrderDto),
      valueFormatter: (p) => formatLatencyMs(p.value as number | null),
    },
    {
      headerName: 'Broker',
      field: 'brokerOrderId',
      width: 130,
      tooltipField: 'brokerOrderId',
      cellClass: 'mono',
      valueFormatter: (p) => {
        const v = p.value as string | null;
        if (!v) return '—';
        return v.length > 14 ? v.slice(0, 12) + '…' : v;
      },
    },
    {
      headerName: 'Mode',
      field: 'isPaper',
      width: 80,
      cellRenderer: (params: { value: boolean }) => {
        const label = params.value ? 'Paper' : 'Live';
        const bg = params.value ? 'rgba(0,113,227,0.12)' : 'rgba(52,199,89,0.12)';
        const color = params.value ? '#0040DD' : '#248A3D';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600">${label}</span>`;
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
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
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
      filter: Object.keys(filter).length > 0 ? filter : params.filter || null,
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

  // ── Charts ─────────────────────────────────────────────────────────
  // All four charts read from `recentOrders` (last 500 orders). Earlier
  // versions of these computeds used hardcoded values + Math.random() — a
  // visual placeholder that lied to the operator. The recent-orders signal
  // is refreshed on every realtime push so the charts stay live.
  ordersByStatusChart = computed<EChartsOption>(() => {
    const counts = new Map<string, number>();
    for (const o of this.recentOrders()) {
      counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
    }
    const palette: Record<string, string> = {
      Filled: '#34C759',
      Pending: '#FF9500',
      Submitted: '#0071E3',
      PartialFill: '#5AC8FA',
      Cancelled: '#8E8E93',
      Rejected: '#FF3B30',
      Expired: '#636366',
    };
    const data = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value,
        itemStyle: { color: palette[name] ?? '#8E8E93' },
      }));
    if (data.length === 0) {
      return emptyChartTitle('No orders in window');
    }
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { color: '#8E8E93', fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
          data,
        },
      ],
    };
  });

  ordersOverTimeChart = computed<EChartsOption>(() => {
    // Day buckets for the last 30 days. Pre-fill so the x-axis is regular
    // even on dates with zero activity.
    const days: string[] = [];
    const buckets = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      days.push(key);
      buckets.set(key, 0);
    }
    for (const o of this.recentOrders()) {
      const key = o.createdAt.slice(0, 10);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 16, top: 16, bottom: 36 },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.slice(5)),
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
          data: days.map((d) => buckets.get(d) ?? 0),
          itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          barWidth: '60%',
        },
      ],
    };
  });

  buySellChart = computed<EChartsOption>(() => {
    let buy = 0,
      sell = 0;
    for (const o of this.recentOrders()) {
      if (o.orderType === 'Buy') buy++;
      else if (o.orderType === 'Sell') sell++;
    }
    if (buy === 0 && sell === 0) return emptyChartTitle('No orders in window');
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { color: '#8E8E93', fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
          data: [
            { value: buy, name: 'Buy', itemStyle: { color: '#34C759' } },
            { value: sell, name: 'Sell', itemStyle: { color: '#FF3B30' } },
          ],
        },
      ],
    };
  });

  fillRateTrendChart = computed<EChartsOption>(() => {
    // Day-by-day fill rate (filled / created). Days without orders surface
    // as nulls so the line breaks rather than implying a 0% fill rate.
    const days: string[] = [];
    const created = new Map<string, number>();
    const filled = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      days.push(key);
      created.set(key, 0);
      filled.set(key, 0);
    }
    for (const o of this.recentOrders()) {
      const key = o.createdAt.slice(0, 10);
      if (created.has(key)) {
        created.set(key, (created.get(key) ?? 0) + 1);
        if (o.status === 'Filled') {
          filled.set(key, (filled.get(key) ?? 0) + 1);
        }
      }
    }
    const values = days.map((d) => {
      const c = created.get(d) ?? 0;
      if (c === 0) return null;
      return Math.round(((filled.get(d) ?? 0) / c) * 100);
    });
    return {
      tooltip: { trigger: 'axis', formatter: '{b}<br/>Fill rate: {c}%' },
      grid: { left: 40, right: 16, top: 16, bottom: 36 },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.slice(5)),
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
          connectNulls: false,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { color: '#5856D6', width: 2 },
          itemStyle: { color: '#5856D6' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
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

  // ── Analytics-tab KPIs + charts ─────────────────────────────────────

  // Pip size for the few major symbols we deal with — JPY pairs use 0.01,
  // everything else 0.0001. Used to convert raw price deltas (slippage) to
  // pips so the operator's eye can compare across symbols.
  private pipSizeFor(symbol: string | null): number {
    if (!symbol) return 0.0001;
    return symbol.toUpperCase().includes('JPY') ? 0.01 : 0.0001;
  }

  /** Precomputed list of fill latencies (ms) over the recent window. */
  private readonly fillLatencies = computed<number[]>(() => {
    const out: number[] = [];
    for (const o of this.recentOrders()) {
      const lat = fillLatencyMs(o);
      if (lat !== null) out.push(lat);
    }
    return out;
  });

  /** Precomputed slippage in pips per filled order, signed (positive = paid more). */
  private readonly slippagesPips = computed<number[]>(() => {
    const out: number[] = [];
    for (const o of this.recentOrders()) {
      if (o.filledPrice === null || o.price === 0) continue;
      const pip = this.pipSizeFor(o.symbol);
      out.push((o.filledPrice - o.price) / pip);
    }
    return out;
  });

  // When there are no measurable fills (e.g. paper-trading runs without
  // filledAt timestamps), return null so the metric card renders `-` rather
  // than implying a zero-latency broker. Same for slippage on market orders
  // that have no order-price reference.
  readonly latencyP50Ms = computed(() => {
    const xs = this.fillLatencies();
    return xs.length === 0 ? null : Math.round(percentile(xs, 0.5));
  });
  readonly latencyP95Ms = computed(() => {
    const xs = this.fillLatencies();
    return xs.length === 0 ? null : Math.round(percentile(xs, 0.95));
  });
  readonly latencyP99Ms = computed(() => {
    const xs = this.fillLatencies();
    return xs.length === 0 ? null : Math.round(percentile(xs, 0.99));
  });
  readonly latencySubtitle = computed(() => {
    const p50 = this.latencyP50Ms();
    const p95 = this.latencyP95Ms();
    const p99 = this.latencyP99Ms();
    if (p50 === null) return 'No fills with timestamps yet';
    return `p50 ${formatLatencyMs(p50)} · p95 ${formatLatencyMs(p95)} · p99 ${formatLatencyMs(p99)}`;
  });

  readonly avgSlippagePips = computed(() => {
    const slips = this.slippagesPips();
    if (slips.length === 0) return null;
    const mean = slips.reduce((s, x) => s + x, 0) / slips.length;
    return +mean.toFixed(2);
  });

  readonly rejectRate = computed(() => {
    const total = this.totalOrders();
    if (total === 0) return 0;
    const rejected = this.recentOrders().filter((o) => o.status === 'Rejected').length;
    return (rejected / total) * 100;
  });

  readonly paperShare = computed(() => {
    const total = this.totalOrders();
    if (total === 0) return 0;
    const paper = this.recentOrders().filter((o) => o.isPaper).length;
    return (paper / total) * 100;
  });

  readonly topSymbolCount = computed(() => {
    const stats = this.perSymbolStats();
    return stats[0]?.total ?? null;
  });

  readonly topRejectionCount = computed(() => {
    const reasons = this.rejectionReasonBuckets();
    return reasons[0]?.count ?? null;
  });

  // ── Per-symbol breakdown ───────────────────────────────────────────
  readonly perSymbolStats = computed(() => {
    const map = new Map<
      string,
      {
        symbol: string;
        total: number;
        buys: number;
        sells: number;
        filled: number;
        rejected: number;
        latencies: number[];
        slippagesPips: number[];
        volume: number;
      }
    >();
    for (const o of this.recentOrders()) {
      if (!o.symbol) continue;
      let s = map.get(o.symbol);
      if (!s) {
        s = {
          symbol: o.symbol,
          total: 0,
          buys: 0,
          sells: 0,
          filled: 0,
          rejected: 0,
          latencies: [],
          slippagesPips: [],
          volume: 0,
        };
        map.set(o.symbol, s);
      }
      s.total++;
      if (o.orderType === 'Buy') s.buys++;
      else if (o.orderType === 'Sell') s.sells++;
      if (o.status === 'Filled') {
        s.filled++;
        s.volume += o.filledQuantity ?? o.quantity ?? 0;
      }
      if (o.status === 'Rejected') s.rejected++;
      const lat = fillLatencyMs(o);
      if (lat !== null) s.latencies.push(lat);
      if (o.filledPrice !== null && o.price !== 0) {
        const pip = this.pipSizeFor(o.symbol);
        s.slippagesPips.push((o.filledPrice - o.price) / pip);
      }
    }
    return Array.from(map.values())
      .map((s) => ({
        symbol: s.symbol,
        total: s.total,
        buys: s.buys,
        sells: s.sells,
        filled: s.filled,
        rejected: s.rejected,
        fillPct: s.total > 0 ? (s.filled / s.total) * 100 : 0,
        avgLatencyMs:
          s.latencies.length > 0
            ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
            : null,
        avgSlippagePips:
          s.slippagesPips.length > 0
            ? +(s.slippagesPips.reduce((a, b) => a + b, 0) / s.slippagesPips.length).toFixed(2)
            : null,
        volume: s.volume,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);
  });

  // ── Rejection reason buckets ───────────────────────────────────────
  // Some reasons are highly variable (timestamps, symbol names) — group by
  // the first ~80 chars to consolidate templated messages.
  private readonly rejectionReasonBuckets = computed(() => {
    const map = new Map<string, number>();
    for (const o of this.recentOrders()) {
      if (o.status !== 'Rejected') continue;
      const key = (o.rejectionReason ?? 'Unknown').slice(0, 80);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  });

  // ── Analytics charts ────────────────────────────────────────────────

  hourlyActivityChart = computed<EChartsOption>(() => {
    const buckets = new Array(24).fill(0) as number[];
    for (const o of this.recentOrders()) {
      const h = new Date(o.createdAt).getUTCHours();
      buckets[h] = (buckets[h] ?? 0) + 1;
    }
    const total = buckets.reduce((a, b) => a + b, 0);
    if (total === 0) return emptyChartTitle('No orders in window');
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 12, right: 12, bottom: 28, left: 36 },
      xAxis: {
        type: 'category',
        data: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`),
        axisLabel: { fontSize: 9, color: '#8E8E93', interval: 2 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 9, color: '#8E8E93' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      series: [
        {
          type: 'bar',
          data: buckets,
          itemStyle: { color: '#5AC8FA', borderRadius: [3, 3, 0, 0] },
          barWidth: '70%',
        },
      ],
    };
  });

  topSymbolsChart = computed<EChartsOption>(() => {
    const stats = this.perSymbolStats();
    if (stats.length === 0) return emptyChartTitle('No symbols traded');
    const top = stats.slice(0, 10);
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      grid: { top: 8, right: 12, bottom: 28, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      yAxis: {
        type: 'category',
        data: top.map((s) => s.symbol).reverse(),
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          name: 'Buy',
          type: 'bar',
          stack: 'side',
          itemStyle: { color: '#34C759' },
          data: top.map((s) => s.buys).reverse(),
        },
        {
          name: 'Sell',
          type: 'bar',
          stack: 'side',
          itemStyle: { color: '#FF3B30' },
          data: top.map((s) => s.sells).reverse(),
        },
      ],
    };
  });

  latencyHistogramChart = computed<EChartsOption>(() => {
    const lats = this.fillLatencies();
    if (lats.length === 0) return emptyChartTitle('No filled orders yet');
    // Log-ish buckets; we care about p50 vs p95 vs p99 contour, not exact ms.
    const edges = [0, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, Infinity];
    const labels = [
      '<50ms',
      '50–100',
      '100–200',
      '200–500',
      '500ms–1s',
      '1–2s',
      '2–5s',
      '5–10s',
      '10–30s',
      '>30s',
    ];
    const counts = new Array(labels.length).fill(0) as number[];
    for (const lat of lats) {
      for (let i = 0; i < edges.length - 1; i++) {
        if (lat >= edges[i] && lat < edges[i + 1]) {
          counts[i] = (counts[i] ?? 0) + 1;
          break;
        }
      }
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 12, right: 12, bottom: 36, left: 36 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#8E8E93', rotate: 30 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 9, color: '#8E8E93' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts,
          itemStyle: { color: '#5856D6', borderRadius: [3, 3, 0, 0] },
          barWidth: '70%',
        },
      ],
    };
  });

  slippageHistogramChart = computed<EChartsOption>(() => {
    const slips = this.slippagesPips();
    if (slips.length === 0) return emptyChartTitle('No filled orders yet');
    // Symmetric pip buckets centred on 0; tail-clip at ±5 pips so a couple
    // of outliers don't flatten the centre of the distribution.
    const edges = [-Infinity, -5, -2, -1, -0.5, 0, 0.5, 1, 2, 5, Infinity];
    const labels = [
      '<-5p',
      '-5..-2',
      '-2..-1',
      '-1..-0.5',
      '-0.5..0',
      '0..0.5',
      '0.5..1',
      '1..2',
      '2..5',
      '>5p',
    ];
    const counts = new Array(labels.length).fill(0) as number[];
    for (const slip of slips) {
      for (let i = 0; i < edges.length - 1; i++) {
        if (slip >= edges[i] && slip < edges[i + 1]) {
          counts[i] = (counts[i] ?? 0) + 1;
          break;
        }
      }
    }
    // Colour the bars so green = better than expected (paid less), red = worse.
    const data = counts.map((value, i) => {
      const isFavourable = i < 5; // first 5 buckets are negative slippage
      return {
        value,
        itemStyle: {
          color: isFavourable ? '#34C759' : '#FF3B30',
          borderRadius: [3, 3, 0, 0] as [number, number, number, number],
          opacity: value === 0 ? 0.25 : 1,
        },
      };
    });
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 12, right: 12, bottom: 36, left: 36 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#8E8E93', rotate: 30 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 9, color: '#8E8E93' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      series: [
        {
          type: 'bar',
          data,
          barWidth: '70%',
        },
      ],
    };
  });

  rejectionReasonsChart = computed<EChartsOption>(() => {
    const buckets = this.rejectionReasonBuckets();
    if (buckets.length === 0) return emptyChartTitle('No rejected orders');
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 8, right: 16, bottom: 24, left: 140 },
      xAxis: {
        type: 'value',
        // Counts are integers — without minInterval ECharts auto-scales to
        // fractional ticks like 0.51, 1.02 when the max bar is small.
        minInterval: 1,
        axisLabel: {
          fontSize: 9,
          color: '#8E8E93',
          formatter: (v: number) => (Number.isInteger(v) ? String(v) : ''),
        },
      },
      yAxis: {
        type: 'category',
        data: buckets
          .map((b) => (b.reason.length > 24 ? b.reason.slice(0, 22) + '…' : b.reason))
          .reverse(),
        axisLabel: { fontSize: 9, color: '#8E8E93' },
      },
      series: [
        {
          type: 'bar',
          data: buckets.map((b) => b.count).reverse(),
          itemStyle: { color: '#FF3B30', borderRadius: [0, 3, 3, 0] },
          // Cap bar height so a single-row dataset doesn't render a 200px-tall
          // bar that makes the chart look broken.
          barMaxWidth: 22,
        },
      ],
    };
  });

  dailyVolumeWithFillChart = computed<EChartsOption>(() => {
    // Combo: bars = order count, line = fill rate %. Lets the operator spot
    // days where fill rate dropped despite high volume (broker stress).
    const days: string[] = [];
    const created = new Map<string, number>();
    const filled = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      days.push(key);
      created.set(key, 0);
      filled.set(key, 0);
    }
    for (const o of this.recentOrders()) {
      const key = o.createdAt.slice(0, 10);
      if (!created.has(key)) continue;
      created.set(key, (created.get(key) ?? 0) + 1);
      if (o.status === 'Filled') filled.set(key, (filled.get(key) ?? 0) + 1);
    }
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      // Wider left/right margins so the dual-axis names don't crash into the bars.
      grid: { top: 28, right: 56, bottom: 40, left: 44 },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.slice(5)),
        axisLabel: { fontSize: 9, color: '#8E8E93', rotate: 45, interval: 4 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Count',
          nameTextStyle: { fontSize: 9, color: '#8E8E93' },
          nameGap: 8,
          axisLabel: { fontSize: 9, color: '#8E8E93' },
          minInterval: 1,
        },
        {
          type: 'value',
          name: 'Fill %',
          nameTextStyle: { fontSize: 9, color: '#8E8E93' },
          nameGap: 8,
          min: 0,
          max: 100,
          axisLabel: { fontSize: 9, color: '#8E8E93', formatter: '{value}%' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Orders',
          type: 'bar',
          data: days.map((d) => created.get(d) ?? 0),
          itemStyle: { color: '#0071E3', borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 18,
        },
        {
          name: 'Fill %',
          type: 'line',
          yAxisIndex: 1,
          data: days.map((d) => {
            const c = created.get(d) ?? 0;
            return c === 0 ? null : Math.round(((filled.get(d) ?? 0) / c) * 100);
          }),
          connectNulls: false,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { color: '#34C759', width: 2 },
          itemStyle: { color: '#34C759' },
        },
      ],
    };
  });

  // Template helper — keeps the per-symbol table cell short.
  formatLatencyValue(ms: number | null): string {
    return formatLatencyMs(ms);
  }

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

  // ── Saved views ─────────────────────────────────────────────────────
  // Minimal UX — a label prompt, pinned by default so it shows immediately
  // in the pill row. Rename / re-pin live in the service for later if we
  // add a management drawer.
  saveCurrentView(): void {
    const label = (typeof window !== 'undefined' ? window.prompt('Name this view') : '')?.trim();
    if (!label) return;
    // The service signature keeps `id` nominally required even though
    // it's really optional at runtime — mint a fresh uuid up-front so the
    // types line up without forcing a service change.
    this.savedViewsService.save<OrdersViewState>({
      id: crypto.randomUUID(),
      label,
      pinned: true,
      route: '/orders',
      state: {
        status: this.filterStatus(),
        orderType: this.filterSide(),
        symbol: '',
      },
    });
  }

  applySavedView(view: SavedView<OrdersViewState>): void {
    this.filterStatus.set(view.state.status ?? '');
    this.filterSide.set(view.state.orderType ?? '');
    this.reloadTable();
  }

  removeSavedView(id: string, event: Event): void {
    event.stopPropagation();
    this.savedViewsService.remove(id);
  }

  onRowClick(order: OrderDto): void {
    // Open the side drawer rather than navigating away — preserves table
    // state, selection, and pagination. The drawer footer carries an
    // "Open detail page →" link for callers who want the full route.
    this.selectedDetail.set(order);
  }

  readonly selectedDetail = signal<OrderDto | null>(null);

  // ── Helpers consumed by template + columns ──────────────────────────
  orderSlippage(o: OrderDto): number | null {
    if (o.filledPrice === null || o.price === 0) return null;
    return o.filledPrice - o.price;
  }

  slippageLabel(o: OrderDto): string {
    const slip = this.orderSlippage(o);
    if (slip === null) return '—';
    const sign = slip >= 0 ? '+' : '';
    return `${sign}${slip.toFixed(5)}`;
  }

  fillLatencyLabel(o: OrderDto): string {
    return formatLatencyMs(fillLatencyMs(o));
  }

  // ── Bulk cancel ─────────────────────────────────────────────────────
  //
  // Cap mirrors the server's FluentValidation rule (`BatchCancelOrdersCommandValidator.MaxBatch`).
  // We could collect every selected row and let the server reject, but it's nicer to tell the
  // operator up-front — the selection is already bounded by the current page size anyway.
  readonly BATCH_CANCEL_MAX = 50;
  readonly batchCancelPending = signal(false);
  readonly batchCancelOpen = signal(false);
  readonly batchCancelMessage = signal('');
  private pendingBatchCancel: { ids: number[]; clear: () => void } | null = null;

  openBatchCancel(rows: OrderDto[], clear: () => void): void {
    if (rows.length === 0) return;
    if (rows.length > this.BATCH_CANCEL_MAX) {
      this.notifications.error(`Select at most ${this.BATCH_CANCEL_MAX} orders to cancel at once.`);
      return;
    }

    // Only cancellable statuses count — the server enforces this too, but skipping here
    // keeps the confirm copy accurate and avoids pointless Failed rows in the result.
    const cancellable = rows.filter(
      (r) => r.status === 'Pending' || r.status === 'Submitted' || r.status === 'PartialFill',
    );
    if (cancellable.length === 0) {
      this.notifications.error('Selected orders are not cancellable in their current status.');
      return;
    }

    const skipped = rows.length - cancellable.length;
    const msg =
      skipped === 0
        ? `Cancel ${cancellable.length} selected order${cancellable.length === 1 ? '' : 's'}?`
        : `Cancel ${cancellable.length} of ${rows.length} selected? ${skipped} will be skipped (not in a cancellable state).`;

    this.batchCancelMessage.set(msg);
    this.pendingBatchCancel = { ids: cancellable.map((o) => o.id), clear };
    this.batchCancelOpen.set(true);
  }

  cancelBatchCancelDialog(): void {
    this.batchCancelOpen.set(false);
    this.pendingBatchCancel = null;
  }

  confirmBatchCancel(): void {
    const pending = this.pendingBatchCancel;
    if (!pending) return;
    this.batchCancelOpen.set(false);
    this.batchCancelPending.set(true);
    this.ordersService
      .cancelBatch({
        orderIds: pending.ids,
        reason: 'Ops: bulk cancel via admin UI',
      })
      .subscribe({
        next: (res) => {
          this.batchCancelPending.set(false);
          const r = res?.data;
          if (res?.status && r) {
            if (r.failed === 0) {
              this.notifications.success(
                `Cancelled ${r.cancelled} order${r.cancelled === 1 ? '' : 's'}.`,
              );
            } else {
              this.notifications.warning(
                `Cancelled ${r.cancelled}, ${r.failed} failed. See order list for details.`,
              );
            }
            pending.clear();
            this.pendingBatchCancel = null;
            this.reloadTable();
          } else {
            this.notifications.error(res?.message ?? 'Batch cancel failed');
            this.pendingBatchCancel = null;
          }
        },
        error: () => {
          this.batchCancelPending.set(false);
          this.pendingBatchCancel = null;
          this.notifications.error('Batch cancel failed');
        },
      });
  }

  private reloadTable(): void {
    this.dataTable()?.loadData();
  }
}

// ── Module-level helpers ────────────────────────────────────────────
// Pulled out of the class so they can be invoked from `valueGetter` /
// `valueFormatter` callbacks without binding `this`.

function fillLatencyMs(o: OrderDto | null | undefined): number | null {
  if (!o || !o.filledAt) return null;
  const ms = new Date(o.filledAt).getTime() - new Date(o.createdAt).getTime();
  return ms < 0 ? null : ms;
}

function formatLatencyMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function escapeAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function emptyChartTitle(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'center',
      textStyle: { color: '#8E8E93', fontSize: 12, fontWeight: 'normal' as const },
    },
  };
}

/**
 * Linear-interpolation percentile (NIST type 7 — same as Excel/numpy).
 * Returns 0 on empty input so callers don't have to guard.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const w = idx - lo;
  return (sorted[lo] ?? 0) * (1 - w) + (sorted[hi] ?? 0) * w;
}
