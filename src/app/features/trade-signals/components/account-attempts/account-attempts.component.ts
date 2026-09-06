import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import { OrdersService } from '@core/services/orders.service';
import type { OrderDto, SignalRejectionEventDto, TradeSignalDto } from '@core/api/api.types';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * v8.47.172/.173 — per-signal "Account attempts" panel.  Answers the
 * inverse question to the per-instance Rejection log:
 *
 *   per-instance:  "what's EA-X been rejecting today?"
 *   per-signal:    "which accounts tried signal Y, and what happened?"
 *
 * Two sources feed the list:
 *
 *   1. Rejection events (`/trade-signal/{id}/rejections`) — one row per
 *      (account, instance) emission.  Multiple rows per same pair are
 *      possible when a transient gate fires repeatedly; every emission
 *      is surfaced so operators can spot intermittent vs persistent.
 *   2. The order lineage (`TradeSignalDto.orderId` → `/order/{id}`) —
 *      the engine has no per-signal order list, so the one linked order
 *      is fetched by id and rendered as the "accepted" outcome row.
 *      Without it a signal that filled cleanly showed "No rejection
 *      events" and nothing else, which read as "nobody touched it".
 *
 * Single fetch per signal (no polling) — events are append-only and the
 * signal-detail view is short-lived; the retry button covers refresh.
 */
@Component({
  selector: 'app-account-attempts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="Per-signal account-attempts log">
      <header class="panel-head">
        <div class="panel-title">
          <h3>Account attempts</h3>
          @if (summary(); as s) {
            <span class="count">{{ s }}</span>
          }
        </div>
        <button
          type="button"
          class="btn btn-ghost"
          (click)="reload()"
          [disabled]="loading()"
          title="Reload attempts"
        >
          {{ loading() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="4" />
      } @else if (error()) {
        <app-error-state
          title="Could not load account attempts"
          message="Engine returned an error fetching rejection events for this signal."
          (retry)="reload()"
        />
      } @else if (rows().length === 0 && !order()) {
        <app-empty-state title="No account attempts recorded" [description]="emptyDescription()" />
      } @else {
        @if (order(); as o) {
          <div class="outcome" [attr.data-status]="o.status">
            <div class="outcome-head">
              <span class="stage" data-stage="Broker">Order</span>
              <a class="order-link" [routerLink]="['/orders', o.id]">Order #{{ o.id }}</a>
              <span class="status-pill" [attr.data-status]="o.status">{{ statusLabel(o) }}</span>
              @if (o.tradingAccountId !== undefined) {
                <span class="acct">acct&nbsp;{{ o.tradingAccountId }}</span>
              }
              <span class="time" [title]="o.filledAt ?? o.createdAt | date: 'medium'">
                {{ o.filledAt ?? o.createdAt | relativeTime }}
              </span>
            </div>
            <div class="outcome-detail">
              {{ o.orderType }} {{ o.quantity | number: '1.2-2' }} lots
              @if (o.filledPrice !== null) {
                · filled &#64; {{ o.filledPrice | number: '1.2-5' }}
              } @else {
                · requested &#64; {{ o.price | number: '1.2-5' }}
              }
              @if (o.brokerOrderId) {
                · broker #{{ o.brokerOrderId }}
              }
              @if (o.rejectionReason) {
                · {{ o.rejectionReason }}
              }
            </div>
          </div>
        }

        @if (rows().length > 0) {
          <ul class="attempt-list" role="list">
            @for (row of rows(); track row.id) {
              <li class="attempt-row" (click)="toggle(row.id)" role="button">
                <div class="head">
                  <span class="acct">acct&nbsp;{{ row.tradingAccountId }}</span>
                  <span class="instance" [title]="row.eaInstanceId">
                    {{ shortInstance(row.eaInstanceId) }}
                  </span>
                  <span class="stage" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                  <span class="substage" [title]="row.subStage">{{ row.subStage }}</span>
                  <span class="time" [title]="row.createdAt | date: 'medium'">
                    {{ row.createdAt | relativeTime }}
                  </span>
                </div>
                <div class="reason">{{ row.reason }}</div>
                @if (expanded() === row.id && row.metadataJson) {
                  <pre class="metadata">{{ formatMetadata(row.metadataJson) }}</pre>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="muted no-rejections">
            No rejection events — every EA that polled this signal accepted it.
          </p>
        }
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .panel-title {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        min-width: 0;
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .count,
      .muted {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .no-rejections {
        margin: var(--space-2) 0 0;
      }
      .btn {
        height: 28px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-family: inherit;
        cursor: pointer;
      }
      .btn:hover:not(:disabled) {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      /* Order-lineage row: the accepted outcome, visually distinct from the
         rejection emissions below it. */
      .outcome {
        border: 1px solid var(--border);
        border-left: 3px solid var(--profit);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        margin-bottom: var(--space-3);
        background: var(--bg-primary);
      }
      .outcome[data-status='Rejected'],
      .outcome[data-status='Cancelled'],
      .outcome[data-status='Expired'] {
        border-left-color: var(--loss);
      }
      .outcome[data-status='Pending'],
      .outcome[data-status='Submitted'],
      .outcome[data-status='PartialFill'],
      .outcome[data-status='Cancelling'] {
        border-left-color: var(--warning);
      }
      .outcome-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
        font-size: var(--text-sm);
      }
      .outcome-head .time {
        margin-left: auto;
      }
      .outcome-detail {
        margin-top: 4px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .order-link {
        color: var(--accent);
        font-weight: var(--font-medium);
        text-decoration: none;
      }
      .order-link:hover {
        text-decoration: underline;
      }
      .status-pill {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status-pill[data-status='Filled'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .status-pill[data-status='Rejected'],
      .status-pill[data-status='Cancelled'],
      .status-pill[data-status='Expired'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .status-pill[data-status='Pending'],
      .status-pill[data-status='Submitted'],
      .status-pill[data-status='PartialFill'],
      .status-pill[data-status='Cancelling'] {
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
      }
      .attempt-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .attempt-row {
        border-bottom: 1px solid var(--border);
        padding: var(--space-2) var(--space-1);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }
      .attempt-row:hover {
        background: var(--bg-tertiary);
      }
      .attempt-row:last-child {
        border-bottom: 0;
      }
      .head {
        display: grid;
        grid-template-columns: 76px minmax(0, 1fr) 72px minmax(0, 160px) 84px;
        gap: var(--space-2);
        align-items: center;
        font-size: var(--text-sm);
        margin-bottom: 4px;
      }
      .acct {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-weight: var(--font-semibold);
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .instance {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .stage {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        text-transform: uppercase;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-align: center;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .stage[data-stage='Local'] {
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
      }
      .stage[data-stage='Engine'] {
        background: rgba(0, 113, 227, 0.15);
        color: var(--accent);
      }
      .stage[data-stage='Broker'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .outcome .stage[data-stage='Broker'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .substage {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .time {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .reason {
        font-size: var(--text-sm);
        color: var(--text-primary);
        padding-left: var(--space-2);
        overflow-wrap: anywhere;
      }
      .metadata {
        background: var(--bg-tertiary);
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        font-size: 11px;
        margin: var(--space-2) 0 0;
        overflow-x: auto;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class AccountAttemptsComponent {
  readonly signalId = input<number | null>(null);
  /**
   * Optional: the signal itself.  Supplies `orderId` (so the accepted
   * outcome can be shown) and `accountsPickedUpCount` (so the empty state
   * can say "N accounts picked it up" instead of implying nobody tried).
   */
  readonly signal = input<TradeSignalDto | null>(null);

  private readonly rejectionsService = inject(SignalRejectionsService);
  private readonly ordersService = inject(OrdersService);

  readonly rows = signal<SignalRejectionEventDto[]>([]);
  readonly order = signal<OrderDto | null>(null);
  readonly loading = signal<boolean>(false);
  readonly error = signal<unknown | null>(null);
  readonly expanded = signal<number | null>(null);

  readonly summary = computed(() => {
    const parts: string[] = [];
    const n = this.rows().length;
    if (n > 0) parts.push(`${n} rejection${n === 1 ? '' : 's'}`);
    const picked = this.signal()?.accountsPickedUpCount ?? 0;
    if (picked > 0) parts.push(`${picked} account${picked === 1 ? '' : 's'} picked up`);
    return parts.join(' · ');
  });

  readonly emptyDescription = computed(() => {
    const picked = this.signal()?.accountsPickedUpCount ?? 0;
    if (picked > 0) {
      return `${picked} account${picked === 1 ? '' : 's'} created an order from this signal and no EA rejected it, but the engine did not link an order id back to the signal.`;
    }
    return 'No EA rejected this signal and no account created an order from it — it was never polled, or expired before any account was eligible.';
  });

  private lastOrderId: number | null = null;

  constructor() {
    // Fetch on signalId change.  Using effect() rather than the polling
    // resource because per-signal views are short-lived — operator opens
    // the page, scans the attempts, moves on; the Refresh button covers
    // the refresh case.
    effect(() => {
      const id = this.signalId();
      if (!id || id <= 0) {
        this.rows.set([]);
        return;
      }
      this.fetchFor(id);
    });
    effect(() => {
      const orderId = this.signal()?.orderId ?? null;
      if (orderId === this.lastOrderId) return;
      this.lastOrderId = orderId;
      this.fetchOrder(orderId);
    });
  }

  reload(): void {
    const id = this.signalId();
    if (id && id > 0) this.fetchFor(id);
    this.fetchOrder(this.signal()?.orderId ?? null);
  }

  toggle(id: number): void {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  shortInstance(s: string): string {
    // LASC-MULTI-11-4680-134247161590944680-A107699364  →  MULTI-11 / 4680 / A1076…
    const parts = s.split('-');
    if (parts.length < 6) return s;
    return `${parts[1]}-${parts[2]} / ${parts[3]} / ${parts[5].slice(0, 5)}…`;
  }

  statusLabel(o: OrderDto): string {
    switch (o.status) {
      case 'PartialFill':
        return 'Partial fill';
      case 'Cancelling':
        return 'Cancelling';
      default:
        return o.status;
    }
  }

  formatMetadata(json: string | null): string {
    if (!json) return '';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  private fetchFor(id: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.rejectionsService
      .forSignal(id, 200)
      .pipe(
        map((res) => res.data?.data ?? []),
        catchError((err) => {
          this.error.set(err);
          return of<SignalRejectionEventDto[]>([]);
        }),
      )
      .subscribe((rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      });
  }

  /**
   * The linked order is best-effort: a failed lookup leaves the rejection
   * list intact rather than replacing it with an error state.
   */
  private fetchOrder(orderId: number | null): void {
    if (orderId == null || orderId <= 0) {
      this.order.set(null);
      return;
    }
    this.ordersService
      .getById(orderId)
      .pipe(
        map((res) => (res.status ? (res.data ?? null) : null)),
        catchError(() => of<OrderDto | null>(null)),
      )
      .subscribe((o) => this.order.set(o));
  }
}
