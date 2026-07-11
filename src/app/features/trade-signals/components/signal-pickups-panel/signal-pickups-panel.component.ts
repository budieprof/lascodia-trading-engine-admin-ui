import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
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
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

interface PickupsPage {
  rows: OrderDto[];
  total: number;
}

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
    MetricCardComponent,
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

      @if (mTotal() > 0) {
        <div class="kpi-grid" [class.loading]="metricsLoading()">
          <app-metric-card
            label="Total orders"
            [value]="mTotal()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card label="Filled" [value]="mFilled()" format="number" dotColor="#34C759" />
          <app-metric-card
            label="Partial fills"
            [value]="mPartial()"
            format="number"
            dotColor="#30B0C7"
          />
          <app-metric-card
            label="Pending / in-flight"
            [value]="mPending()"
            format="number"
            [dotColor]="mPending() > 0 ? '#FF9500' : '#8E8E93'"
          />
          <app-metric-card
            label="Rejected / cancelled"
            [value]="mRejectedCancelled()"
            format="number"
            dotColor="#FF3B30"
          />
          <app-metric-card
            label="Fill rate"
            [value]="mFillRate()"
            format="percent"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Total lots (filled)"
            [value]="mTotalLots()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Symbols"
            [value]="mDistinctSymbols()"
            format="number"
            dotColor="#AF52DE"
          />
        </div>
      }

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
          [description]="
            allAccounts()
              ? 'No account has created an order from a signal yet.'
              : 'This account has not picked up any signals in the window.'
          "
        />
      } @else {
        <div class="pickup-scroll">
          <table class="grid">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Trading account</th>
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
                  <td class="acct" [title]="accountLabel(o.tradingAccountId)">
                    {{ accountLabel(o.tradingAccountId) }}
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
        @if (totalItemCount() > 0) {
          <nav class="pager-bar" aria-label="Picked-up signals pagination">
            <div class="pager-info">
              Showing <strong>{{ rangeStart() }}</strong
              >–<strong>{{ rangeEnd() }}</strong> of
              <strong>{{ totalItemCount() }}</strong>
            </div>
            <div class="pager-size">
              <label for="pickupPageSize">Rows</label>
              <select id="pickupPageSize" (change)="setPageSize(+$any($event.target).value)">
                @for (n of pageSizeOptions; track n) {
                  <option [value]="n" [selected]="n === pageSize()">{{ n }}</option>
                }
              </select>
            </div>
            <div class="pager-nav">
              <button
                type="button"
                class="pager-btn"
                (click)="goToPage(1)"
                [disabled]="currentPage() <= 1"
                aria-label="First page"
              >
                «
              </button>
              <button
                type="button"
                class="pager-btn"
                (click)="goToPage(currentPage() - 1)"
                [disabled]="currentPage() <= 1"
                aria-label="Previous page"
              >
                ‹
              </button>
              <span class="pager-page">Page {{ currentPage() }} of {{ totalPages() }}</span>
              <button
                type="button"
                class="pager-btn"
                (click)="goToPage(currentPage() + 1)"
                [disabled]="currentPage() >= totalPages()"
                aria-label="Next page"
              >
                ›
              </button>
              <button
                type="button"
                class="pager-btn"
                (click)="goToPage(totalPages())"
                [disabled]="currentPage() >= totalPages()"
                aria-label="Last page"
              >
                »
              </button>
            </div>
          </nav>
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

      /* Analysis KPI strip — fixed responsive columns so cards fill the width. */
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        gap: var(--space-3, 12px);
      }
      @media (max-width: 1500px) {
        .kpi-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .kpi-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .kpi-grid.loading {
        opacity: 0.55;
      }

      /* Pagination bar */
      .pager-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4, 16px);
        flex-wrap: wrap;
        padding: 8px 2px 0;
        font-size: var(--text-xs, 12px);
        color: var(--text-secondary);
      }
      .pager-info strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .pager-size {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .pager-size select {
        height: 26px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 6px);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs, 12px);
      }
      .pager-nav {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .pager-page {
        min-width: 96px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .pager-btn {
        min-width: 28px;
        height: 26px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 6px);
        background: var(--bg-primary);
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
      }
      .pager-btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
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
      .acct {
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
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
  /** When true, aggregate across ALL accounts (ignore tradingAccountId). */
  readonly allAccounts = input<boolean>(false);
  /** id → display label, so the aggregate view can name each order's account. */
  readonly accountNames = input<Record<number, string>>({});

  accountLabel(id: number | null | undefined): string {
    if (id == null) return '—';
    return this.accountNames()[id] ?? `#${id}`;
  }

  private readonly orders = inject(OrdersService);

  // ── Pagination ─────────────────────────────────────────────────────────
  readonly pageSizeOptions = [25, 50, 100, 200] as const;
  readonly currentPage = signal(1);
  readonly pageSize = signal<number>(25);

  protected readonly resource = createPolledResource<PickupsPage>(
    () => {
      const allMode = this.allAccounts();
      const accountId = this.tradingAccountId();
      if (!allMode && (!accountId || accountId <= 0))
        return of<PickupsPage>({ rows: [], total: 0 });
      return this.orders
        .list({
          currentPage: this.currentPage(),
          itemCountPerPage: this.pageSize(),
          sortBy: 'CreatedAt',
          sortDirection: 'desc',
          filter: allMode ? null : { tradingAccountId: accountId },
        })
        .pipe(
          map((res) => ({
            rows: res.data?.data ?? [],
            total: res.data?.pager?.totalItemCount ?? 0,
          })),
          catchError(() => of<PickupsPage>({ rows: [], total: 0 })),
        );
    },
    { intervalMs: 15_000 },
  );

  readonly rows = computed(() => this.resource.value()?.rows ?? []);
  readonly totalItemCount = computed(() => this.resource.value()?.total ?? 0);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalItemCount() / this.pageSize())),
  );
  readonly rangeStart = computed(() =>
    this.totalItemCount() === 0 ? 0 : (this.currentPage() - 1) * this.pageSize() + 1,
  );
  readonly rangeEnd = computed(() =>
    Math.min(this.currentPage() * this.pageSize(), this.totalItemCount()),
  );
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  goToPage(page: number): void {
    const clamped = Math.min(Math.max(1, page), this.totalPages());
    if (clamped === this.currentPage()) return;
    this.currentPage.set(clamped);
    this.resource.refresh();
  }

  setPageSize(size: number): void {
    if (size === this.pageSize()) return;
    this.pageSize.set(size);
    this.currentPage.set(1);
    this.resource.refresh();
  }

  // ── Analysis metrics ─────────────────────────────────────────────────────
  // Over ALL of the account's orders (wide cap), independent of the table page.
  protected readonly metricsResource = createPolledResource<{ rows: OrderDto[]; total: number }>(
    () => {
      const allMode = this.allAccounts();
      const accountId = this.tradingAccountId();
      if (!allMode && (!accountId || accountId <= 0))
        return of({ rows: [] as OrderDto[], total: 0 });
      return this.orders
        .list({
          currentPage: 1,
          itemCountPerPage: 500,
          sortBy: 'CreatedAt',
          sortDirection: 'desc',
          filter: allMode ? null : { tradingAccountId: accountId },
        })
        .pipe(
          map((res) => ({
            rows: res.data?.data ?? [],
            total: res.data?.pager?.totalItemCount ?? 0,
          })),
          catchError(() => of({ rows: [] as OrderDto[], total: 0 })),
        );
    },
    { intervalMs: 30_000 },
  );
  private readonly metricsRows = computed(() => this.metricsResource.value()?.rows ?? []);
  private countTones(tone: 'good' | 'bad' | 'neutral'): number {
    return this.metricsRows().filter((o) => this.statusTone(o.status) === tone).length;
  }
  readonly metricsLoading = computed(() => this.metricsRows().length === 0);
  readonly mTotal = computed(() => this.metricsResource.value()?.total ?? 0);
  readonly mFilled = computed(() => this.metricsRows().filter((o) => o.status === 'Filled').length);
  readonly mPartial = computed(
    () => this.metricsRows().filter((o) => o.status === 'PartialFill').length,
  );
  readonly mPending = computed(() => this.countTones('neutral'));
  readonly mRejectedCancelled = computed(() => this.countTones('bad'));
  readonly mFillRate = computed(() => {
    const rows = this.metricsRows();
    if (rows.length === 0) return 0;
    return (this.countTones('good') / rows.length) * 100;
  });
  readonly mTotalLots = computed(() =>
    this.metricsRows().reduce((acc, o) => acc + (o.filledQuantity ?? 0), 0),
  );
  readonly mDistinctSymbols = computed(
    () => new Set(this.metricsRows().map((o) => o.symbol ?? '—')).size,
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
