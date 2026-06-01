import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, finalize, map, of } from 'rxjs';

import { OrdersService } from '@core/services/orders.service';
import type { OrderDto, OrderStatus } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { NotificationService } from '@core/notifications/notification.service';

import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import {
  EATradeChartModalComponent,
  type TradeChartSelection,
} from '../ea-trade-chart-modal/ea-trade-chart-modal.component';

/**
 * Phase-5b admin panel — renders the EA instance's *working* orders
 * (Pending + Submitted + PartialFill, the trio MT5 shows in the Toolbox
 * "Trade" tab below the open positions block).  Polls `/order/list`
 * every 10s with the engine's new Phase-5b `tradingAccountId` filter.
 *
 * The engine's order filter is a single status string at a time, so the
 * component fans out N=3 status fetches client-side and concatenates.
 * Wasteful in theory, but on localhost each fetch resolves in <50ms and
 * the union is rare to be more than 5–10 rows.
 */
@Component({
  selector: 'app-ea-pending-orders-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    ProgressBarComponent,
    EmptyStateComponent,
    EATradeChartModalComponent,
  ],
  template: `
    <section class="panel" aria-label="EA pending orders">
      <header class="panel-head">
        <h3>Pending orders</h3>
        <span class="meta">
          <span class="count">{{ rows().length }}</span>
          <button
            type="button"
            class="btn btn-secondary"
            (click)="resource.refresh()"
            [disabled]="resource.loading()"
          >
            @if (resource.loading()) {
              Refreshing…
            } @else {
              Refresh
            }
          </button>
        </span>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      @if (!resource.value() && resource.loading()) {
        <p class="hint muted">Loading pending orders…</p>
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No pending orders"
          description="No working orders attributed to this trading account. Orders that have been filled appear as positions in the panel above; cancelled/rejected/expired orders are hidden here."
        />
      } @else {
        <div class="scroll-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th class="num">Qty</th>
                <th class="num">Price</th>
                <th class="num">SL</th>
                <th class="num">TP</th>
                <th>Status</th>
                <th>Created</th>
                <th>Broker id</th>
              </tr>
            </thead>
            <tbody>
              @for (o of rows(); track o.id) {
                <tr
                  class="clickable"
                  [attr.data-paper]="o.isPaper ? 'true' : null"
                  (click)="openChart(o)"
                  tabindex="0"
                  role="button"
                  (keydown.enter)="openChart(o)"
                  (keydown.space)="$event.preventDefault(); openChart(o)"
                >
                  <td class="mono">{{ o.symbol }}</td>
                  <td>
                    <span class="side-pill" [attr.data-side]="o.orderType">{{ o.orderType }}</span>
                  </td>
                  <td class="exec mono small">{{ o.executionType }}</td>
                  <td class="num mono">{{ o.quantity | number: '1.2-2' }}</td>
                  <td class="num mono">
                    @if (o.price > 0) {
                      {{ o.price | number: '1.5-5' }}
                    } @else {
                      <span class="muted">market</span>
                    }
                  </td>
                  <td class="num mono">
                    @if (o.stopLoss !== null) {
                      {{ o.stopLoss | number: '1.5-5' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="num mono">
                    @if (o.takeProfit !== null) {
                      {{ o.takeProfit | number: '1.5-5' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td>
                    <span class="status-pill" [attr.data-status]="o.status">{{ o.status }}</span>
                  </td>
                  <td class="mono small">{{ o.createdAt | date: 'yyyy-MM-dd HH:mm' }}</td>
                  <td class="mono small muted">{{ o.brokerOrderId ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <app-ea-trade-chart-modal
      [selection]="chartSelection()"
      [open]="chartOpen()"
      [busy]="actionBusy()"
      (openChange)="chartOpen.set($event)"
      (actionConfirmed)="onCancelOrder()"
    />
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .meta {
        display: inline-flex;
        align-items: center;
        gap: var(--space-3);
      }
      .count {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: 2px 8px;
        border-radius: 999px;
      }
      .btn {
        height: 30px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-secondary {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-primary);
      }
      .btn-secondary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      /*
       * Scroll wrapper bounds the table at ~10 rows worth of vertical
       * space.  Header is sticky inside the wrapper so column labels
       * stay visible while the body scrolls.  Without this an EA holding
       * 20+ working orders pushes the Operator-controls block off-screen.
       */
      .scroll-wrap {
        max-height: 360px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .grid {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .grid th,
      .grid td {
        text-align: left;
        padding: 7px 10px;
        border-bottom: 1px solid var(--border);
      }
      .grid thead {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--bg-secondary);
        box-shadow: 0 1px 0 var(--border);
      }
      .grid th {
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
      }
      .grid tbody tr:hover {
        background: var(--bg-primary);
      }
      tr.clickable {
        cursor: pointer;
      }
      tr.clickable:hover {
        background: var(--bg-tertiary);
      }
      tr.clickable:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .small {
        font-size: 10px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .side-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .side-pill[data-side='Buy'] {
        background: color-mix(in srgb, #34c759 18%, transparent);
        color: #1d8a3e;
      }
      .side-pill[data-side='Sell'] {
        background: color-mix(in srgb, #ff453a 18%, transparent);
        color: #c93631;
      }
      .status-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .status-pill[data-status='Submitted'] {
        background: color-mix(in srgb, #0a84ff 18%, transparent);
      }
      .status-pill[data-status='Pending'] {
        background: color-mix(in srgb, #ff9f0a 22%, transparent);
      }
      .status-pill[data-status='PartialFill'] {
        background: color-mix(in srgb, #5e5ce6 22%, transparent);
      }
      .status-pill[data-status='Cancelling'] {
        background: color-mix(in srgb, #ff453a 22%, transparent);
        color: #c93631;
      }
      tr[data-paper] {
        opacity: 0.85;
      }
      tr[data-paper] td:first-child::after {
        content: ' (paper)';
        color: var(--text-secondary);
        font-style: italic;
        font-size: 10px;
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class EAPendingOrdersPanelComponent {
  readonly tradingAccountId = input<number | null>(null);
  // Phase-14: CSV of the EA instance's owned symbols.  Mirror of the
  // positions panel input — narrows the displayed pending orders to the
  // symbols this specific instance owns.  Empty / null shows everything
  // for the account (backward-compatible).  Without it, an EA detail
  // page for a sibling that owns AUDNZD shows the parent's EURUSD /
  // NZDUSD working orders, which is confusing for operators trying to
  // judge what THIS instance is doing.
  readonly ownedSymbolsCsv = input<string | null>(null);

  private readonly orders = inject(OrdersService);

  protected readonly ownedSymbolSet = computed<Set<string> | null>(() => {
    const csv = (this.ownedSymbolsCsv() ?? '').trim();
    if (!csv) return null;
    return new Set(
      csv
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
  });

  protected readonly resource = createPolledResource(
    () => {
      const accountId = this.tradingAccountId();
      if (!accountId) return of<OrderDto[]>([]);
      // Single fetch with no status filter — engine returns everything,
      // we filter client-side to {Pending, Submitted, PartialFill,
      // Cancelling}.  The engine's filter takes a single status string
      // at a time, so the alternative would be 4 round-trips per poll —
      // wasteful given these endpoints already return small result sets
      // per-account.  Cancelling is the Phase-14 in-flight cancel state:
      // user clicked Cancel, EA command queued, MT5 still has the
      // working order (e.g. retcode=10018 "Market closed" weekend
      // retries).  Including it here means operators see what's
      // actually live on the broker, not just what the engine wishes.
      return this.orders
        .list({
          currentPage: 1,
          itemCountPerPage: 100,
          sortBy: 'CreatedAt',
          sortDirection: 'desc',
          filter: { tradingAccountId: accountId },
        })
        .pipe(
          map((res) => {
            const list = res.data?.data ?? [];
            const workingStatuses = new Set<OrderStatus>([
              'Pending',
              'Submitted',
              'PartialFill',
              'Cancelling',
            ]);
            return list.filter((o) => workingStatuses.has(o.status));
          }),
          catchError(() => of<OrderDto[]>([])),
        );
    },
    { intervalMs: 10_000 },
  );

  protected readonly rows = computed(() => {
    const all = this.resource.value() ?? [];
    const owned = this.ownedSymbolSet();
    if (!owned) return all;
    return all.filter((o) => owned.has((o.symbol ?? '').toUpperCase()));
  });

  // ── Phase-6 click-to-chart ───────────────────────────────────────────────
  // Same shared chart as the positions panel.  For pending orders the
  // reference is the *trigger* price (the limit/stop level) and the
  // reference time is the order's CreatedAt.  No currentPrice — pending
  // orders haven't filled, so there's no live PnL to anchor.
  protected readonly chartSelection = signal<TradeChartSelection | null>(null);
  protected readonly chartOpen = signal(false);

  protected openChart(o: OrderDto): void {
    if (!o.symbol) return;
    // Market orders have Price=0 — fall back to TP/SL midpoint when the
    // price would otherwise be unreadable on the chart.  The reference
    // label still says TRIGGER so operators see *something* anchored at
    // the row's creation time.
    const referencePrice =
      o.price > 0
        ? o.price
        : o.takeProfit !== null && o.stopLoss !== null
          ? (o.takeProfit + o.stopLoss) / 2
          : (o.takeProfit ?? o.stopLoss ?? 0);
    if (referencePrice === 0) return; // nothing meaningful to chart
    this.selectedOrderId = o.id;
    this.chartSelection.set({
      title: `Pending #${o.id} · ${o.symbol} · ${o.orderType} ${o.executionType}`,
      symbol: o.symbol,
      direction: o.orderType,
      referencePrice,
      referenceTime: o.createdAt,
      referenceLabel: o.executionType === 'Market' ? 'PLACED' : 'TRIGGER',
      stopLoss: o.stopLoss,
      takeProfit: o.takeProfit,
      currentPrice: null,
      exitPrice: null,
      exitTime: null,
      action: {
        label: 'Cancel order',
        confirmLabel: 'Confirm cancel',
        busyLabel: 'Cancelling…',
        description:
          `Cancels order #${o.id} (${o.orderType} ${o.executionType} ${o.quantity} ${o.symbol}). ` +
          `The engine transitions the order to Cancelled and queues a CancelOrder EA command if a ` +
          `broker ticket exists.  Orphan-ingested orders without a strategy origin are still cancellable.`,
      },
    });
    this.chartOpen.set(true);
  }

  // ── Phase-7c cancel-order flow ───────────────────────────────────────────
  protected readonly actionBusy = signal(false);
  private selectedOrderId: number | null = null;
  private readonly ordersSvc = inject(OrdersService);
  private readonly notify = inject(NotificationService);

  protected onCancelOrder(): void {
    const id = this.selectedOrderId;
    if (!id) return;
    this.actionBusy.set(true);
    this.ordersSvc
      .cancel(id)
      .pipe(finalize(() => this.actionBusy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Order #${id} cancel queued.`);
            this.chartOpen.set(false);
            this.resource.refresh();
          } else {
            this.notify.error(res.message ?? 'Failed to cancel order.');
          }
        },
        error: () => this.notify.error('Failed to cancel order.'),
      });
  }
}
