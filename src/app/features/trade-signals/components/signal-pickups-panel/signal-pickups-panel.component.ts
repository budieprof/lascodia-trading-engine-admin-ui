import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { OrdersService } from '@core/services/orders.service';
import type { OrderDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Per-account "Signals Picked Up" panel — the exact inverse of the
 * account-scoped rejection log. Every order the account created is a
 * signal it picked up, so this lists `/order/list` filtered by
 * `tradingAccountId` (the engine's Phase-5b per-account filter) and
 * renders one row per order with a link back to the originating signal.
 *
 * Mirrors `EARejectionsPanelComponent`'s account-scoped presentation:
 * polled resource (15s), card-skeleton loading state, error-state on
 * failure, empty-state when the account picked up nothing in the window.
 */
@Component({
  selector: 'app-signal-pickups-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    DatePipe,
    DecimalPipe,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="Signals this account picked up">
      <header class="panel-head">
        <div class="panel-title">
          <h3>Picked-up signals</h3>
          <span class="muted small">
            @if (rows().length > 0) {
              {{ rows().length }} order{{ rows().length === 1 ? '' : 's' }}
            } @else {
              no orders
            }
          </span>
        </div>
        <button
          type="button"
          class="btn btn-ghost"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
          title="Refresh now"
        >
          @if (resource.loading()) {
            Refreshing…
          } @else {
            Refresh
          }
        </button>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load picked-up signals"
          message="Engine returned an error fetching orders for this account."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No picked-up signals"
          description="This account hasn't picked up any signals in the window."
        />
      } @else {
        <div class="pickup-scroll">
          <table class="grid">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Symbol</th>
                <th>Type</th>
                <th>Status</th>
                <th class="num">Qty</th>
                <th class="num">Filled</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              @for (o of rows(); track o.id) {
                <tr>
                  <td class="mono">
                    @if (o.tradeSignalId !== null && o.tradeSignalId !== undefined) {
                      <a
                        class="signal"
                        [routerLink]="['/trade-signals', o.tradeSignalId]"
                        title="Open signal detail"
                        >#{{ o.tradeSignalId }}</a
                      >
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="mono">{{ o.symbol ?? '—' }}</td>
                  <td>
                    <span class="type-pill" [attr.data-side]="o.orderType">{{ o.orderType }}</span>
                  </td>
                  <td>
                    <span class="status-pill" [attr.data-tone]="statusTone(o.status)">{{
                      o.status
                    }}</span>
                  </td>
                  <td class="num mono">
                    {{ o.quantity | number: '1.2-2' }}
                    @if (
                      o.filledQuantity !== null &&
                      o.filledQuantity > 0 &&
                      o.filledQuantity < o.quantity
                    ) {
                      <span class="muted small">
                        · {{ o.filledQuantity | number: '1.2-2' }} fl</span
                      >
                    }
                  </td>
                  <td class="num mono">
                    @if (o.filledPrice !== null) {
                      {{ o.filledPrice | number: '1.5-5' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="mono small" [title]="o.createdAt | date: 'medium'">
                    {{ o.createdAt | relativeTime }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding, var(--space-4));
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
      .panel-title {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .btn {
        height: 28px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
        font-family: inherit;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .pickup-scroll {
        max-height: 480px;
        overflow: auto;
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
      .grid tbody tr:last-child td {
        border-bottom: 0;
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
        background: var(--bg-secondary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .signal {
        color: var(--text-secondary);
        text-decoration: none;
      }
      .signal:hover {
        color: var(--accent, #0071e3);
        text-decoration: underline;
      }

      .type-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .type-pill[data-side='Buy'] {
        background: color-mix(in srgb, #34c759 18%, transparent);
        color: #1d8a3e;
      }
      .type-pill[data-side='Sell'] {
        background: color-mix(in srgb, #ff453a 18%, transparent);
        color: #c93631;
      }

      /* Status badge — green-ish for filled/open, red-ish for
         cancelled/rejected, neutral for pending/submitted. */
      .status-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status-pill[data-tone='good'] {
        background: rgba(52, 199, 89, 0.16);
        color: #1d8a3e;
      }
      .status-pill[data-tone='bad'] {
        background: rgba(255, 59, 48, 0.16);
        color: #c93631;
      }
      .status-pill[data-tone='neutral'] {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class SignalPickupsPanelComponent {
  /** Trading account whose picked-up signals (created orders) to list. */
  readonly tradingAccountId = input<number | null>(null);

  private readonly orders = inject(OrdersService);

  protected readonly resource = createPolledResource(
    () => {
      const accountId = this.tradingAccountId();
      if (!accountId || accountId <= 0) return of<OrderDto[]>([]);
      return this.orders
        .list({
          currentPage: 1,
          itemCountPerPage: 100,
          sortBy: 'CreatedAt',
          sortDirection: 'desc',
          filter: { tradingAccountId: accountId },
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<OrderDto[]>([])),
        );
    },
    { intervalMs: 15_000 },
  );

  readonly rows = computed(() => this.resource.value() ?? []);
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  /**
   * Colour tone for the order-status badge:
   *   good    — Filled / Open (a picked-up signal that took / holds)
   *   bad     — Cancelled / Rejected / Expired
   *   neutral — Pending / Submitted / everything else in flight
   */
  statusTone(status: string): 'good' | 'bad' | 'neutral' {
    switch (status) {
      case 'Filled':
      case 'PartialFill':
      case 'Open':
        return 'good';
      case 'Cancelled':
      case 'Cancelling':
      case 'Rejected':
      case 'Expired':
        return 'bad';
      default:
        return 'neutral';
    }
  }
}
