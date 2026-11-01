import { distanceUnitOf } from '@core/instruments/instrument-math';
import {
  Component,
  ChangeDetectionStrategy,
  effect,
  inject,
  signal,
  computed,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { map } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { OrdersService } from '@core/services/orders.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, merge, of, throttleTime } from 'rxjs';
import { DatePipe, DecimalPipe } from '@angular/common';
import type { OrderDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { SavedViewsService, SavedView } from '@core/views/saved-views.service';
import { CreateSignalDialogComponent } from '@features/trade-signals/components/create-signal-dialog/create-signal-dialog.component';

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
    DatePipe,
    DecimalPipe,
    RouterLink,
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    ConfirmDialogComponent,
    CreateSignalDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Orders" subtitle="Manage and monitor trading orders">
        <button
          type="button"
          class="btn btn-primary"
          (click)="manualSignalOpen.set(true)"
          data-testid="new-manual-signal"
          title="Trade by hand: a manual signal goes through the same risk checks, and the EA places it"
        >
          + New manual signal
        </button>
      </app-page-header>

      <!-- SP-12: orders are created by the EA from approved trade signals; an order typed in here was never placed. -->
      <p class="manual-note">
        Orders reach the broker only through trade signals: the EA places an approved signal and
        creates its order. To trade by hand, create a manual signal — it passes the same risk
        checks.
      </p>
      @if (manualSignalOpen()) {
        <app-create-signal-dialog
          (closed)="manualSignalOpen.set(false)"
          (created)="onManualSignalCreated($event)"
        />
      }

      <!-- Tabs -->
      <ui-tabs [tabs]="tabItems" [(activeTab)]="activeTab">
        @switch (activeTab()) {
          @case ('all') {
            <!-- Summary Metrics — 8 dense tiles (two even rows of four), recent-orders-scoped
                 (last 500). Zero counts stay neutral grey so colour only marks something to look at. -->
            <div class="metrics-strip">
              <app-metric-card
                label="Orders (recent window)"
                [value]="totalOrders()"
                format="number"
                dotColor="#0071E3"
                caption="Newest orders sampled for these tiles"
              />
              <app-metric-card
                label="Pending"
                [value]="pendingOrders()"
                format="number"
                [dotColor]="pendingOrders() > 0 ? '#FF9500' : '#8E8E93'"
                [caption]="pendingOrders() > 0 ? 'Waiting on the broker' : 'Nothing waiting'"
              />
              <app-metric-card
                label="Fill Rate"
                [value]="fillRate()"
                format="percent"
                dotColor="#5856D6"
                [caption]="
                  (filledOrders() | number) + ' of ' + (totalOrders() | number) + ' filled'
                "
              />
              <app-metric-card
                label="Today filled"
                [value]="filledToday()"
                format="number"
                [dotColor]="filledToday() > 0 ? '#34C759' : '#8E8E93'"
                caption="Since local midnight"
              />
              <app-metric-card
                label="Today rejected"
                [value]="rejectedToday()"
                format="number"
                [dotColor]="rejectedToday() > 0 ? '#FF3B30' : '#8E8E93'"
                caption="Since local midnight"
              />
              <app-metric-card
                label="Today volume (lots)"
                [value]="volumeToday()"
                format="number"
                [dotColor]="volumeToday() > 0 ? '#0071E3' : '#8E8E93'"
                caption="Lots filled today"
              />
              <app-metric-card
                label="Avg fill latency (min)"
                [value]="avgFillLatencyMin()"
                format="number"
                dotColor="#AF52DE"
                caption="Created → filled, recent window"
              />
              <app-metric-card
                label="Symbols traded"
                [value]="symbolsTraded()"
                format="number"
                [dotColor]="symbolsTraded() > 0 ? '#5AC8FA' : '#8E8E93'"
                caption="Distinct symbols, recent window"
              />
            </div>

            <!-- Filter toolbar — one card: status (with live engine totals) on the
                 first row; side, mode and saved views on the second. -->
            <div class="toolbar">
              <div class="tb-row">
                <div class="seg" role="tablist" aria-label="Filter by status">
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
                      @if (statusCount(s) !== null) {
                        <span class="chip-count">{{ statusCount(s) | number }}</span>
                      }
                    </button>
                  }
                </div>
                @if (hasActiveFilters()) {
                  <button type="button" class="chip-clear" (click)="clearFilters()">
                    Clear filters
                  </button>
                }
              </div>
              <div class="tb-row">
                <div class="seg" role="tablist" aria-label="Filter by side">
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
                <!--
                  The mode filter was never sent to the engine, so Live / Paper
                  highlighted and changed nothing. It is sent as filter.isPaper,
                  which OrderQueryFilter honours since 2026-10-19; the chip totals
                  above follow it (baseFilter).
                -->
                <div class="seg" role="tablist" aria-label="Filter by mode">
                  <button
                    type="button"
                    role="tab"
                    class="chip"
                    [class.active]="filterPaper() === null"
                    [attr.aria-selected]="filterPaper() === null"
                    (click)="onFilterPaperChange(null)"
                  >
                    All modes
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class="chip"
                    [class.active]="filterPaper() === false"
                    [attr.aria-selected]="filterPaper() === false"
                    (click)="onFilterPaperChange(false)"
                  >
                    Live
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class="chip"
                    [class.active]="filterPaper() === true"
                    [attr.aria-selected]="filterPaper() === true"
                    (click)="onFilterPaperChange(true)"
                  >
                    Paper
                  </button>
                </div>
                <!-- Saved views live with the filters they restore, at the end of
                     the same toolbar, instead of floating above the tab strip. -->
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
                  <button type="button" class="view-save" (click)="saveCurrentView()">
                    + Save view
                  </button>
                </div>
              </div>
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
            <!-- Analytics-specific KPI strip. Fill latency is createdAt → filledAt,
                 which for limit orders is minutes to hours — so the unit is minutes
                 and it is in the label. -->
            <div class="metrics-strip">
              <app-metric-card
                label="Fill latency p50 (min)"
                [value]="latencyP50Min()"
                format="number"
                dotColor="#5856D6"
              />
              <app-metric-card
                label="Fill latency p95 (min)"
                [value]="latencyP95Min()"
                format="number"
                dotColor="#AF52DE"
              />
              <!-- Negative slippage = filled better than the order price = good,
                   so the colour is inverted to match the per-symbol table. -->
              <app-metric-card
                label="Avg slippage (pips)"
                [value]="avgSlippagePips()"
                format="number"
                [colorByValue]="true"
                [invertColor]="true"
              />
              <app-metric-card
                label="Reject rate"
                [value]="rejectRate()"
                format="percent"
                [colorByValue]="true"
                [invertColor]="true"
                [dotColor]="rejectRate() > 5 ? '#FF3B30' : '#8E8E93'"
              />
              <app-metric-card
                label="Paper share"
                [value]="paperShare()"
                format="percent"
                dotColor="#0071E3"
              />
              <app-metric-card
                [label]="topSymbolLabel()"
                [value]="topSymbolCount()"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                [label]="topRejectionLabel()"
                [value]="topRejectionCount()"
                format="number"
                [dotColor]="topRejectionCount() > 0 ? '#FF3B30' : '#8E8E93'"
              />
              <app-metric-card
                label="Orders in window"
                [value]="totalOrders()"
                format="number"
                dotColor="#8E8E93"
              />
            </div>

            <!-- Four-column grid: donuts take one column, anything with an
                 x-axis takes two so its tick labels have room to breathe. -->
            <div class="analytics-grid">
              <app-chart-card
                title="Orders by Status"
                [subtitle]="totalOrders() + ' orders in window'"
                [options]="ordersByStatusChart()"
                height="240px"
              />
              <app-chart-card
                class="span-2"
                title="Activity (hour of day, UTC)"
                subtitle="When the engine places orders"
                [options]="hourlyActivityChart()"
                height="240px"
              />
              <app-chart-card
                title="Buy vs Sell"
                subtitle="Side mix, recent window"
                [options]="buySellChart()"
                height="240px"
              />
              <app-chart-card
                class="span-2"
                title="Top Symbols"
                subtitle="By order count, stacked Buy/Sell"
                [options]="topSymbolsChart()"
                height="240px"
              />
              <app-chart-card
                class="span-2"
                title="Fill Latency"
                [subtitle]="latencySubtitle()"
                [options]="latencyHistogramChart()"
                height="240px"
              />
              <app-chart-card
                class="span-2"
                title="Slippage Distribution"
                [subtitle]="slippageSubtitle()"
                [options]="slippageHistogramChart()"
                height="240px"
              />
              <app-chart-card
                class="span-2"
                title="Top Rejection Reasons"
                subtitle="Most common reject causes — hover for the full text"
                [options]="rejectionReasonsChart()"
                height="240px"
              />
              <app-chart-card
                class="span-4"
                title="Daily Volume + Fill %"
                [subtitle]="dailyVolumeSubtitle()"
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
                      <th class="num">Avg fill latency</th>
                      <th class="num">Avg slippage (pips)</th>
                      <th class="num">Volume (lots)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of perSymbolStats(); track s.symbol) {
                      <tr>
                        <td class="mono">{{ s.symbol }}</td>
                        <td class="num mono">{{ s.total | number }}</td>
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
                          [class.profit]="s.avgSlippagePips !== null && s.avgSlippagePips < 0"
                          [class.loss]="s.avgSlippagePips !== null && s.avgSlippagePips > 0"
                        >
                          {{
                            s.avgSlippagePips !== null
                              ? (s.avgSlippagePips > 0 ? '+' : '') + s.avgSlippagePips.toFixed(2)
                              : '—'
                          }}
                        </td>
                        <td class="num mono">{{ s.volume | number: '1.2-2' }}</td>
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
                    [class.profit]="orderSlippage(o) !== null && orderSlippage(o)! < 0"
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

      /* Saved views — trailing group of the filter row */
      .saved-views {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin-left: auto;
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

      /* Metrics Strip — two rows of four keep every label on one line;
         eight across forced two- and three-line labels. */
      .metrics-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-4);
        align-items: stretch;
      }
      @media (max-width: 720px) {
        .metrics-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* Filter toolbar — venue-page family: a quiet card, segmented pills. */
      .toolbar {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        margin-bottom: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
      }
      .tb-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
      }
      /* The eight status chips carry engine totals ("Cancelled 2,894"); on a
         narrow column the track wraps inside the card instead of pushing the
         page sideways. */
      .seg {
        display: inline-flex;
        flex-wrap: wrap;
        max-width: 100%;
        gap: 2px;
        padding: 3px;
        background: var(--bg-tertiary);
        border-radius: 17px;
      }
      .chip {
        height: 26px;
        padding: 0 11px;
        white-space: nowrap;
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
        background: var(--bg-primary);
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
        color: var(--text-tertiary);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .chip.active .chip-count {
        color: var(--text-secondary);
      }
      .chip-clear {
        height: 28px;
        padding: 0 12px;
        border: none;
        border-radius: var(--radius-full);
        background: rgba(255, 59, 48, 0.08);
        color: #d70015;
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
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

      .manual-note {
        margin: 0 0 var(--space-4);
        font-size: var(--text-sm);
        color: var(--text-secondary);
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
        align-items: start;
      }
      .analytics-grid > .span-2 {
        grid-column: span 2;
      }
      .analytics-grid > .span-4 {
        grid-column: span 4;
      }
      @media (max-width: 1400px) {
        .analytics-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .analytics-grid > .span-4 {
          grid-column: span 2;
        }
      }
      @media (max-width: 720px) {
        .analytics-grid {
          grid-template-columns: 1fr;
        }
        .analytics-grid > .span-2,
        .analytics-grid > .span-4 {
          grid-column: span 1;
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
    `,
  ],
})
export class OrdersPageComponent {
  private readonly ordersService = inject(OrdersService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly savedViewsService = inject(SavedViewsService);
  protected readonly accountScope = inject(AccountScopeService);

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

    // Re-fetch whenever the operator changes the global account scope
    // from the header dropdown.  Effect runs in injection context so
    // teardown is handled automatically.
    //
    // Depend on the KEY, never on accountIds(): that array is rebuilt by the
    // scope service's own 30 s refresh, so a reference-equality signal reports
    // a "change" every tick even when the account set is identical — turning
    // this into a refetch loop (measured: 4 extra /order/list calls every 30 s
    // on top of the page's own polling).
    //
    // The body must be untracked as well: reloadTable() and loadRecent() read
    // accountIds() themselves, and a read inside the effect is a dependency no
    // matter what we touched at the top — swapping the top line alone changed
    // nothing. Same shape as the dashboard's scope effect.
    effect(() => {
      // Touch the signal to register the dependency, then reload.
      this.accountScope.accountIdsKey();
      untracked(() => {
        this.reloadTable();
        this.loadRecent();
      });
    });
    // (An effect always runs once on creation, so the initial load is the
    // effect's — a second explicit loadRecent() here fetched the 500-order
    // window twice on every page open.)
  }

  // Tab state
  tabItems: TabItem[] = [
    { label: 'All Orders', value: 'all' },
    { label: 'Order Analytics', value: 'analytics' },
  ];
  activeTab = signal('all');

  /** "+ New manual signal" — the create-signal dialog (SP-12 replaced the order form nothing ever placed). */
  readonly manualSignalOpen = signal(false);

  // Filter state
  filterStatus = signal('');
  filterSide = signal('');
  filterPaper = signal<boolean | null>(null);

  hasActiveFilters = computed(
    () => this.filterStatus() !== '' || this.filterSide() !== '' || this.filterPaper() !== null,
  );

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

  // Mean createdAt → filledAt for orders filled in the recent window, in
  // minutes (limit orders sit for minutes to hours, so ms is unreadable).
  // Null when nothing has a fill timestamp — the tile shows "-" rather
  // than a zero-latency broker.
  readonly avgFillLatencyMin = computed(() => {
    const filled = this.recentOrders().filter((o) => o.status === 'Filled' && o.filledAt !== null);
    if (filled.length === 0) return null;
    const sum = filled.reduce((acc, o) => {
      const ms = new Date(o.filledAt!).getTime() - new Date(o.createdAt).getTime();
      return acc + Math.max(0, ms);
    }, 0);
    return +(sum / filled.length / 60_000).toFixed(1);
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

  /**
   * Engine totals per status chip under the table's other filters (side,
   * mode, account scope) — exactly what clicking the chip would list. The
   * chips used to count the 500-order KPI window ("All 500") above a table
   * reading "Showing 1–25 of 5,717". Null until the counts arrive (or when
   * one failed), and the chip then shows no number rather than a wrong one.
   */
  private readonly statusTotals = signal<Record<string, number | null>>({});

  statusCount(s: string): number | null {
    return this.statusTotals()[s] ?? null;
  }

  /** The table's filter minus status: side, mode and the global account scope. */
  private baseFilter(): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (this.filterSide()) filter['orderType'] = this.filterSide();
    if (this.filterPaper() !== null) filter['isPaper'] = this.filterPaper();
    // Global account scope — drops a tradingAccountIds list onto the
    // filter so engine-side OrderQueryFilter narrows the result set
    // to the operator's selected scope (or aggregate of live real
    // accounts).  Same selector flips Positions, Drawdown, and the
    // dashboard tiles in lockstep — see AccountScopeService.
    const scopedIds = this.accountScope.accountIds();
    if (scopedIds.length > 0) filter['tradingAccountIds'] = Array.from(scopedIds);
    return filter;
  }

  /** One count-only query (a single row + the pager total) per status chip. */
  private loadStatusTotals(): void {
    const base = this.baseFilter();
    const calls = Object.fromEntries(
      this.statusChips.map((s) => [
        s,
        this.ordersService
          .list({
            currentPage: 1,
            itemCountPerPage: 1,
            filter: s ? { ...base, status: s } : base,
          })
          .pipe(
            map((r) => (r?.status === false ? null : (r.data?.pager?.totalItemCount ?? null))),
            catchError(() => of(null)),
          ),
      ]),
    );
    forkJoin(calls).subscribe((totals) => this.statusTotals.set(totals));
  }

  private loadRecent(): void {
    // Recent-orders sample (powers the Order Analytics tab + KPIs at
    // the top of the page).  Scoped through the global selector so
    // the Fill Rate / Avg fill latency / Symbols traded tiles reflect
    // ONLY the operator's selected accounts — not fleet-wide.
    const scopedIds = this.accountScope.accountIds();
    const filter = scopedIds.length > 0 ? { tradingAccountIds: Array.from(scopedIds) } : null;
    this.ordersService
      .list({ currentPage: 1, itemCountPerPage: 500, filter })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        const rows = res?.data?.data ?? [];
        this.recentOrders.set(rows);
      });
    // Same triggers (scope change, order/position push) move the chip totals.
    this.loadStatusTotals();
  }

  // AG Grid columns
  //
  // Sixteen columns at the shared 88px minimum overflowed the card at 1440px
  // (everything after "Filled Qty" was cut off and the Cancelling pill was
  // clipped). Secondary values now ride in a second line of their primary
  // cell — signal under ID, mode under symbol, filled qty / fill price under
  // qty / price, TP under SL, time under date — so the minimums sum to well
  // under the content column and sizeColumnsToFit never has to scroll. Each
  // combined column keeps its primary `field`, so server-side sort is
  // unchanged. Cell renderers return HTML that AG Grid renders outside this
  // component's style scope, so they style inline and escape data text.
  columns: ColDef<OrderDto>[] = [
    {
      headerName: 'ID',
      headerTooltip: 'Order ID, with the trade signal it came from underneath',
      field: 'id',
      width: 80,
      minWidth: 80,
      sortable: true,
      cellRenderer: (p: { data?: OrderDto }) => {
        const o = p.data;
        if (!o) return '';
        const sig = o.tradeSignalId != null ? `sig #${o.tradeSignalId}` : 'no signal';
        return stackCell(`<span style="font-weight:600">${o.id}</span>`, esc(sig));
      },
    },
    {
      headerName: 'Symbol',
      headerTooltip: 'Symbol, with Live / Paper underneath',
      field: 'symbol',
      width: 96,
      minWidth: 96,
      cellRenderer: (p: { data?: OrderDto }) => {
        const o = p.data;
        if (!o) return '';
        const mode = o.isPaper ? `<span style="color:#0040DD">Paper</span>` : `<span>Live</span>`;
        return stackCell(`<span style="font-weight:600">${esc(o.symbol ?? '—')}</span>`, mode);
      },
    },
    {
      headerName: 'Side',
      field: 'orderType',
      width: 68,
      minWidth: 68,
      cellRenderer: (params: { value: number | string }) => {
        const v = params.value;
        const isBuy = v === 0 || v === 'Buy';
        const label = isBuy ? 'BUY' : 'SELL';
        const color = isBuy ? '#248A3D' : '#D70015';
        const bg = isBuy ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)';
        return `<span style="color:${color};background:${bg};padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.03em;line-height:20px">${label}</span>`;
      },
    },
    {
      headerName: 'Type',
      field: 'executionType',
      width: 76,
      minWidth: 76,
      cellStyle: { color: 'var(--text-secondary)' },
      cellRenderer: (params: { value: number | string }) => {
        const execMap: Record<number, string> = {
          0: 'Market',
          1: 'Limit',
          2: 'Stop',
          3: 'StopLimit',
        };
        const v = params.value;
        const label = typeof v === 'number' ? (execMap[v] ?? String(v)) : v;
        return `<span style="font-size:12px;font-weight:500">${esc(String(label ?? '—'))}</span>`;
      },
    },
    {
      // "Quantity" wrapped mid-word ("QUANTI / TY") in a 100px uppercase header.
      headerName: 'Qty',
      headerTooltip: 'Quantity (lots), with the filled quantity underneath',
      field: 'quantity',
      width: 80,
      minWidth: 80,
      type: 'rightAligned',
      cellRenderer: (p: { data?: OrderDto }) => {
        const o = p.data;
        if (!o) return '';
        const qty = o.quantity != null ? Number(o.quantity).toFixed(2) : '-';
        const filled =
          o.filledQuantity != null ? `filled ${Number(o.filledQuantity).toFixed(2)}` : '—';
        return stackCell(qty, filled, true);
      },
    },
    {
      headerName: 'Price',
      headerTooltip: 'Order price, with the fill price underneath',
      field: 'price',
      width: 112,
      minWidth: 112,
      type: 'rightAligned',
      // A market order carries no requested price — the engine stores 0, which
      // printed as a price of 0.00000.
      cellRenderer: (p: { data?: OrderDto }) => {
        const o = p.data;
        if (!o) return '';
        let price: string;
        if (o.price == null) price = '-';
        else {
          const v = Number(o.price);
          const exec = o.executionType as unknown;
          price = v === 0 && (exec === 'Market' || exec === 0) ? 'Market' : v.toFixed(5);
        }
        const fill = o.filledPrice != null ? `fill ${Number(o.filledPrice).toFixed(5)}` : '—';
        return stackCell(price, fill, true);
      },
    },
    {
      headerName: 'SL / TP',
      headerTooltip: 'Stop loss, with take profit underneath',
      field: 'stopLoss',
      width: 112,
      minWidth: 112,
      type: 'rightAligned',
      cellRenderer: (p: { data?: OrderDto }) => {
        const o = p.data;
        if (!o) return '';
        const sl = o.stopLoss != null ? Number(o.stopLoss).toFixed(5) : '-';
        const tp = o.takeProfit != null ? `TP ${Number(o.takeProfit).toFixed(5)}` : 'TP -';
        return stackCell(sl, tp, true);
      },
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 112,
      minWidth: 112,
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
        const statusColor: Record<string, string> = {
          Pending: '#C93400',
          Cancelling: '#C93400',
          Submitted: '#0040DD',
          PartialFill: '#0040DD',
          Filled: '#248A3D',
          Cancelled: '#636366',
          Rejected: '#D70015',
          Expired: '#636366',
        };
        const v = params.value;
        const label = typeof v === 'number' ? (statusNumMap[v] ?? String(v)) : String(v ?? '—');
        const c = statusColor[label] ?? '#636366';
        // Hover-tooltip the rejection reason on the pill so the operator can scan
        // a row of failures without opening each detail drawer.
        const reason =
          label === 'Rejected' && params.data.rejectionReason
            ? ` title="${escapeAttribute(params.data.rejectionReason)}"`
            : '';
        return (
          `<span${reason} style="display:inline-flex;align-items:center;gap:6px;padding:0 9px;border-radius:999px;` +
          `background:${c}1a;color:${c};font-size:11.5px;font-weight:600;line-height:20px;white-space:nowrap">` +
          `<span style="width:6px;height:6px;border-radius:50%;background:${c}"></span>${esc(label)}</span>`
        );
      },
    },
    {
      headerName: 'Latency',
      headerTooltip: 'Fill latency: created → filled',
      colId: 'fillLatency',
      width: 96,
      minWidth: 96,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueGetter: (p) => fillLatencyMs(p.data as OrderDto),
      valueFormatter: (p) => formatLatencyMs(p.value as number | null),
    },
    {
      headerName: 'Broker ID',
      headerTooltip: 'Broker order ID',
      field: 'brokerOrderId',
      flex: 1,
      width: 110,
      minWidth: 96,
      tooltipField: 'brokerOrderId',
      cellStyle: {
        fontFamily: "'SF Mono','Fira Code',monospace",
        fontSize: '12px',
        color: 'var(--text-secondary)',
      },
      valueFormatter: (p) => {
        const v = p.value as string | null;
        if (!v) return '—';
        return v.length > 14 ? v.slice(0, 12) + '…' : v;
      },
    },
    {
      headerName: 'Created',
      field: 'createdAt',
      width: 96,
      minWidth: 96,
      cellRenderer: (p: { value: string | null }) => {
        if (!p.value) return '-';
        try {
          const d = new Date(p.value);
          const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const time = d.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          return stackCell(esc(day), esc(time));
        } catch {
          return esc(String(p.value));
        }
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    const filter = this.baseFilter();
    if (this.filterStatus()) filter['status'] = this.filterStatus();

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

  // ── Analytics-tab KPIs + charts ─────────────────────────────────────

  /** Precomputed list of fill latencies (ms) over the recent window. */
  private readonly fillLatencies = computed<number[]>(() => {
    const out: number[] = [];
    for (const o of this.recentOrders()) {
      const lat = fillLatencyMs(o);
      if (lat !== null) out.push(lat);
    }
    return out;
  });

  /**
   * Signed slippage in pips per FILLED order (positive = paid more than the
   * order price). Only filled orders carry a fill price worth comparing; and
   * anything beyond ±SLIPPAGE_OUTLIER_PIPS is a data artefact — a limit order
   * cannot fill 186 pips through its price — so it is counted and reported,
   * not averaged in.
   */
  private readonly slippageSamples = computed(() => {
    const values: { symbol: string; pips: number }[] = [];
    let excluded = 0;
    for (const o of this.recentOrders()) {
      const pips = slippagePips(o);
      if (pips === null) continue;
      if (Math.abs(pips) > SLIPPAGE_OUTLIER_PIPS) {
        excluded++;
        continue;
      }
      values.push({ symbol: o.symbol ?? '', pips });
    }
    return { values, excluded };
  });

  // Percentiles in minutes (one decimal). Null when there are no measurable
  // fills (e.g. paper-trading runs without filledAt timestamps) so the metric
  // card renders "-" rather than implying a zero-latency broker.
  private readonly latencyP50Ms = computed(() => {
    const xs = this.fillLatencies();
    return xs.length === 0 ? null : Math.round(percentile(xs, 0.5));
  });
  private readonly latencyP95Ms = computed(() => {
    const xs = this.fillLatencies();
    return xs.length === 0 ? null : Math.round(percentile(xs, 0.95));
  });
  private readonly latencyP99Ms = computed(() => {
    const xs = this.fillLatencies();
    return xs.length === 0 ? null : Math.round(percentile(xs, 0.99));
  });
  readonly latencyP50Min = computed(() => msToMinutes(this.latencyP50Ms()));
  readonly latencyP95Min = computed(() => msToMinutes(this.latencyP95Ms()));
  readonly latencySubtitle = computed(() => {
    const p50 = this.latencyP50Ms();
    const p95 = this.latencyP95Ms();
    const p99 = this.latencyP99Ms();
    if (p50 === null) return 'No fills with timestamps yet';
    return `createdAt → filledAt · p50 ${formatLatencyMs(p50)} · p95 ${formatLatencyMs(p95)} · p99 ${formatLatencyMs(p99)}`;
  });

  readonly avgSlippagePips = computed(() => {
    const { values } = this.slippageSamples();
    if (values.length === 0) return null;
    const mean = values.reduce((s, x) => s + x.pips, 0) / values.length;
    return +mean.toFixed(2);
  });

  readonly slippageSubtitle = computed(() => {
    const { values, excluded } = this.slippageSamples();
    const base = `Adverse slippage in pips (buys filled − order, sells order − filled) · negative = filled better · ${values.length} fills`;
    return excluded > 0
      ? `${base} · ${excluded} beyond ±${SLIPPAGE_OUTLIER_PIPS} pips excluded as bad data`
      : base;
  });

  readonly topSymbolLabel = computed(() => {
    const top = this.perSymbolStats()[0];
    return top ? `Top symbol · ${top.symbol}` : 'Top symbol';
  });

  readonly topRejectionLabel = computed(() => {
    const top = this.rejectionReasonBuckets()[0];
    if (!top) return 'Top reject reason';
    const reason = top.reason.length > 34 ? top.reason.slice(0, 32).trimEnd() + '…' : top.reason;
    return `Top reject · ${reason}`;
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
      // Same sample rule as the tile and histogram, so the three agree.
      const pips = slippagePips(o);
      if (pips !== null && Math.abs(pips) <= SLIPPAGE_OUTLIER_PIPS) s.slippagesPips.push(pips);
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
    // createdAt → filledAt spans sub-second market fills to hours for resting
    // limit orders, so the buckets are log-spaced and every label carries its
    // own unit — the old ms-only buckets put p50 (~2 min) in a lone ">30s" bar.
    const MIN = 60_000;
    const edges = [0, 1000, 10_000, MIN, 5 * MIN, 15 * MIN, 60 * MIN, 240 * MIN, Infinity];
    const labels = [
      '<1 s',
      '1–10 s',
      '10–60 s',
      '1–5 min',
      '5–15 min',
      '15–60 min',
      '1–4 h',
      '>4 h',
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
      grid: { top: 12, right: 12, bottom: 28, left: 36 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 10, color: '#8E8E93', interval: 0 },
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
    const slips = this.slippageSamples().values.map((s) => s.pips);
    if (slips.length === 0) return emptyChartTitle('No filled orders yet');
    // Symmetric pip buckets around an EXACT-fill bucket; the two tail buckets
    // absorb the rest of the (already outlier-trimmed) range. A fill at the
    // requested price used to land in "0…0.5" and be painted red as adverse —
    // ~300 of ~330 fills, i.e. the whole chart read "worse than expected".
    const ZERO_PIPS = 0.05; // below a tenth of a pip is a fill at the price
    const edges = [-Infinity, -5, -2, -1, -0.5, -ZERO_PIPS, ZERO_PIPS, 0.5, 1, 2, 5, Infinity];
    const labels = [
      '<−5',
      '−5…−2',
      '−2…−1',
      '−1…−½',
      '−½…0',
      '0',
      '0…½',
      '½…1',
      '1…2',
      '2…5',
      '>5',
    ];
    const ZERO_BUCKET = 5;
    const counts = new Array(labels.length).fill(0) as number[];
    for (const slip of slips) {
      for (let i = 0; i < edges.length - 1; i++) {
        if (slip >= edges[i] && slip < edges[i + 1]) {
          counts[i] = (counts[i] ?? 0) + 1;
          break;
        }
      }
    }
    // Green = better than requested (paid less), red = worse, grey = at the price.
    const data = counts.map((value, i) => {
      const color = i < ZERO_BUCKET ? '#34C759' : i === ZERO_BUCKET ? '#8E8E93' : '#FF3B30';
      return {
        value,
        itemStyle: {
          color,
          borderRadius: [3, 3, 0, 0] as [number, number, number, number],
          opacity: value === 0 ? 0.25 : 1,
        },
      };
    });
    return {
      tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name} pips: ${p[0].value}` },
      grid: { top: 12, right: 12, bottom: 28, left: 36 },
      xAxis: {
        type: 'category',
        name: 'pips',
        nameLocation: 'end',
        nameGap: 4,
        nameTextStyle: { fontSize: 9, color: '#8E8E93' },
        data: labels,
        // Eleven labels in a half-width card: 9px and no overlap-hiding, so
        // every bucket keeps its label (one used to vanish beside the bars).
        axisLabel: { fontSize: 9, color: '#8E8E93', interval: 0, hideOverlap: false },
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
    const maxCount = Math.max(1, ...buckets.map((b) => b.count));
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        // Full reason text lives in the tooltip; the axis only has room for a prefix.
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          const full = buckets[buckets.length - 1 - p.dataIndex]?.reason ?? p.name;
          return `${full}<br/><strong>${p.value}</strong> rejected`;
        },
      },
      grid: { top: 8, right: 16, bottom: 24, left: 8, containLabel: true },
      xAxis: {
        type: 'value',
        // Integer counts on a fixed range — no fractional ticks, no dashed
        // gridline wandering through the bars.
        min: 0,
        max: maxCount,
        minInterval: 1,
        splitNumber: Math.min(4, maxCount),
        splitLine: { show: false },
        axisLabel: {
          fontSize: 9,
          color: '#8E8E93',
          formatter: (v: number) => (Number.isInteger(v) ? String(v) : ''),
        },
      },
      yAxis: {
        type: 'category',
        data: buckets.map((b) => b.reason).reverse(),
        axisLabel: {
          fontSize: 9,
          color: '#8E8E93',
          width: 190,
          overflow: 'truncate',
          ellipsis: '…',
        },
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

  /**
   * The chart reads the 500-order window, which can start well inside the
   * 30 days it draws; the days before the window's oldest order then show no
   * bars because they were never fetched, not because nothing traded.
   */
  readonly dailyVolumeSubtitle = computed(() => {
    const base = 'Last 30 days (UTC), order count and fill rate';
    const rows = this.recentOrders();
    if (rows.length < 500) return base;
    const oldest = rows.reduce((m, o) => (o.createdAt < m ? o.createdAt : m), rows[0].createdAt);
    const days = lastUtcDays(30);
    if (oldest.slice(0, 10) <= days[0]) return base;
    return `${base} · window of the latest 500 orders starts ${oldest.slice(5, 10)}`;
  });

  dailyVolumeWithFillChart = computed<EChartsOption>(() => {
    // Combo: bars = order count, line = fill rate %. Lets the operator spot
    // days where fill rate dropped despite high volume (broker stress).
    //
    // UTC days on both sides: orders are keyed by createdAt's UTC date, and
    // the axis used LOCAL midnight → toISOString(), which east of UTC is the
    // previous UTC date — the axis ran a day behind and today's orders fell
    // off its right edge.
    const days = lastUtcDays(30);
    const created = new Map<string, number>(days.map((d) => [d, 0]));
    const filled = new Map<string, number>(days.map((d) => [d, 0]));
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
        // Every fifth day, upright: thirty rotated labels collided into a smear.
        axisLabel: { fontSize: 9, color: '#8E8E93', interval: 4, hideOverlap: true },
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
          // Straight segments: the spline overshot the 0–100 % axis between
          // sparse days and drew fill rates no day had.
          smooth: false,
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

  /**
   * A manual signal was created (the dialog says so). It passes the risk checks like any signal; its order appears in
   * this list when the EA places it.
   */
  onManualSignalCreated(_id: number): void {
    this.manualSignalOpen.set(false);
  }

  onFilterStatusChange(value: string): void {
    this.filterStatus.set(value);
    this.reloadTable();
  }

  onFilterSideChange(value: string): void {
    this.filterSide.set(value);
    this.reloadTable();
    this.loadStatusTotals();
  }

  onFilterPaperChange(value: boolean | null): void {
    this.filterPaper.set(value);
    this.reloadTable();
    this.loadStatusTotals();
  }

  clearFilters(): void {
    this.filterStatus.set('');
    this.filterSide.set('');
    this.filterPaper.set(null);
    this.reloadTable();
    this.loadStatusTotals();
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
    this.loadStatusTotals();
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
  /** Signed slippage in pips for the drawer; null when the order never filled. */
  orderSlippage(o: OrderDto): number | null {
    return slippagePips(o);
  }

  slippageLabel(o: OrderDto): string {
    const slip = this.orderSlippage(o);
    if (slip === null) return '—';
    const sign = slip > 0 ? '+' : '';
    return `${sign}${slip.toFixed(2)} pips`;
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

/** Always carries a unit — "67m" read as metres or months, never as minutes. */
function formatLatencyMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function msToMinutes(ms: number | null): number | null {
  return ms === null ? null : +(ms / 60_000).toFixed(1);
}

/**
 * Beyond this a "slippage" reading is a data artefact (a stale order price,
 * a re-quoted entry), not execution quality — a limit order cannot legally
 * fill 186 pips through its price. Such rows are counted and reported, never
 * averaged into the tile.
 */
const SLIPPAGE_OUTLIER_PIPS = 50;

/**
 * Pip size by instrument class. The old rule (JPY = 0.01, everything else
 * 0.0001) turned a $2 move on gold into 20,000 "pips" and made index and
 * crypto slippage meaningless.
 */
/**
 * One display unit of the symbol, in price — core/instruments (the pip for FX; the engine's point for an index or a
 * metal, where this page used to guess 1 / 0.1). FX values are unchanged (golden spec `instrument-golden.spec.ts`).
 */
function pipSizeFor(symbol: string | null): number {
  return distanceUnitOf(symbol);
}

/** Signed fill slippage in pips; positive = filled worse than the order price. */
/**
 * ADVERSE slippage in pips: positive = filled worse than requested, negative =
 * price improvement — for both sides. It was filled − order regardless of
 * side, so a sell filled ABOVE its price (better) counted as adverse and a
 * sell filled below it as improvement; two thirds of the window are sells.
 */
function slippagePips(o: OrderDto): number | null {
  if (o.status !== 'Filled' || o.filledPrice === null || !o.price) return null;
  const raw = (o.filledPrice - o.price) / pipSizeFor(o.symbol);
  const side = o.orderType as unknown;
  const isBuy = side === 'Buy' || side === 0;
  return isBuy ? raw : -raw;
}

/** The last `n` UTC calendar days as YYYY-MM-DD keys, oldest first, ending today (UTC). */
function lastUtcDays(n: number): string[] {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(today - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

/** Cell-renderer strings go straight into innerHTML; payload-derived text must be escaped. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** The theme makes .ag-cell a flex row, so text-align alone never moves a number right. */
const NUM_CELL = { fontVariantNumeric: 'tabular-nums', justifyContent: 'flex-end' };

/**
 * Two-line grid cell: primary value on top, quiet secondary value underneath.
 * Both arguments are HTML — callers escape data-derived text.
 */
function stackCell(top: string, bottom: string, right = false): string {
  return (
    `<div style="display:flex;flex-direction:column;justify-content:center;` +
    `align-items:${right ? 'flex-end' : 'flex-start'};height:100%;width:100%;min-width:0;` +
    `line-height:1.3;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden">` +
    `<span>${top}</span>` +
    `<span style="font-size:11px;color:var(--text-tertiary)">${bottom}</span></div>`
  );
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
