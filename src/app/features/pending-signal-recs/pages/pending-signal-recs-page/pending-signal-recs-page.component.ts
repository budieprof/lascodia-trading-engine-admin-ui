import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, finalize, of } from 'rxjs';
import { PendingSignalRecsService } from '@core/services/pending-signal-recs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { PendingSignalRecDto } from '@core/api/api.types';

/**
 * Operator cockpit for the pending-signal-reval mechanic.  Shows the
 * held-rec table with state-aware badges, distance-to-entry / TTL
 * countdowns, attempt counter, and a per-row Cancel action for Parked
 * rows.  Polls every 5 s while the page is visible.
 */
@Component({
  selector: 'app-pending-signal-recs-page',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Pending-signal recs</h1>
          <p class="muted small">
            LLM recommendations held back from materialising as TradeSignals — waiting for price to
            reach the recommended entry, then re-validated via a fresh LLM call.
            <a routerLink="/" class="link">Engine-wide gate</a> toggled on the EA detail page.
          </p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
            {{ loading() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </header>

      <!-- ── Filters ────────────────────────────────────────────────────── -->
      <section class="filters">
        <div class="filter-group">
          <label class="filter-label">State</label>
          <div class="state-chips">
            @for (s of allStates; track s) {
              <label class="chip" [class.on]="selectedStates().has(s)">
                <input
                  type="checkbox"
                  [checked]="selectedStates().has(s)"
                  (change)="toggleState(s, $any($event.target).checked)"
                />
                <span>{{ s }}</span>
              </label>
            }
          </div>
        </div>
        <div class="filter-group symbol-group">
          <label class="filter-label">Symbol</label>
          <input
            type="text"
            placeholder="e.g. EURUSD"
            [value]="symbolFilter()"
            (input)="symbolFilter.set($any($event.target).value)"
            (keydown.enter)="reload()"
            class="symbol-input"
          />
        </div>
      </section>

      <!-- ── Table ──────────────────────────────────────────────────────── -->
      <section class="table-wrap">
        @if (loadError()) {
          <p class="bad">{{ loadError() }}</p>
        }
        @if (rows().length === 0 && !loading()) {
          <p class="muted">
            No rows for the current filter. When the engine-wide gate is on and the LLM produces a
            rec whose entry is far from market, it lands here as a <em>Parked</em> row.
          </p>
        } @else {
          <table class="grid">
            <thead>
              <tr>
                <th>Id</th>
                <th>Symbol</th>
                <th>Dir</th>
                <th class="num">Entry</th>
                <th class="num">SL</th>
                <th class="num">TP</th>
                <th class="num">ATR</th>
                <th class="num">Conf</th>
                <th>State</th>
                <th>Parked</th>
                <th>Park exp.</th>
                <th>Last reval</th>
                <th class="num">Attempts</th>
                <th>Terminal</th>
                <th>Resulting signal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.id) {
                <tr [class.dim]="isTerminal(r.state)">
                  <td class="num">
                    <code>{{ r.id }}</code>
                  </td>
                  <td>{{ r.symbol }}</td>
                  <td
                    class="dir"
                    [class.dir-buy]="r.direction === 'Buy'"
                    [class.dir-sell]="r.direction === 'Sell'"
                  >
                    {{ r.direction }}
                  </td>
                  <td class="num">{{ r.recommendedEntryPrice | number: '1.0-5' }}</td>
                  <td class="num">
                    {{ r.stopLoss === null ? '—' : (r.stopLoss | number: '1.0-5') }}
                  </td>
                  <td class="num">
                    {{ r.takeProfit === null ? '—' : (r.takeProfit | number: '1.0-5') }}
                  </td>
                  <td class="num">{{ r.atrAtGeneration | number: '1.0-5' }}</td>
                  <td class="num">{{ r.confidence | number: '1.2-2' }}</td>
                  <td>
                    <span class="state state-{{ r.state.toLowerCase() }}">{{ r.state }}</span>
                  </td>
                  <td class="ts">{{ r.createdAt | date: 'MMM d HH:mm' }}</td>
                  <td class="ts">{{ r.parkExpiresAt | date: 'MMM d HH:mm' }}</td>
                  <td class="ts">
                    {{
                      r.lastRevalAttemptAt === null
                        ? '—'
                        : (r.lastRevalAttemptAt | date: 'MMM d HH:mm')
                    }}
                  </td>
                  <td class="num">{{ r.revalAttempts }}</td>
                  <td class="terminal" [title]="r.terminalReason ?? ''">
                    {{ r.terminalReason ?? '—' }}
                  </td>
                  <td class="num">
                    @if (r.resultingTradeSignalId !== null) {
                      <a [routerLink]="['/trade-signals', r.resultingTradeSignalId]" class="link">
                        <code>{{ r.resultingTradeSignalId }}</code>
                      </a>
                    } @else {
                      —
                    }
                  </td>
                  <td>
                    @if (r.state === 'Parked') {
                      <button
                        type="button"
                        class="btn btn-mini btn-danger"
                        (click)="cancel(r)"
                        [disabled]="canceling().has(r.id)"
                      >
                        {{ canceling().has(r.id) ? '…' : 'Cancel' }}
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
        @if (loading() && rows().length > 0) {
          <p class="muted small">Refreshing…</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: 1rem 1.25rem;
      }
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.25rem;
        margin: 0 0 0.25rem;
      }
      .muted {
        color: var(--text-muted, #888);
      }
      .small {
        font-size: 0.85rem;
      }
      .bad {
        color: var(--text-bad, #c0392b);
      }
      .link {
        color: var(--link, #4a8cff);
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
      .filters {
        display: flex;
        gap: 1.5rem;
        align-items: flex-end;
        flex-wrap: wrap;
        margin-bottom: 1rem;
        padding: 0.75rem;
        background: var(--surface-2, #1a1d23);
        border-radius: 6px;
      }
      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .filter-label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted, #888);
      }
      .state-chips {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.25rem 0.6rem;
        background: var(--surface-3, #23262e);
        border-radius: 999px;
        cursor: pointer;
        font-size: 0.8rem;
      }
      .chip input {
        accent-color: var(--accent, #4a8cff);
      }
      .chip.on {
        background: var(--accent-soft, #2a3a55);
      }
      .symbol-group .symbol-input {
        width: 12rem;
        padding: 0.35rem 0.5rem;
        background: var(--surface-3, #23262e);
        border: 1px solid var(--border, #333);
        color: inherit;
        border-radius: 4px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table.grid {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      table.grid th,
      table.grid td {
        padding: 0.45rem 0.5rem;
        border-bottom: 1px solid var(--border, #2a2d33);
        text-align: left;
        white-space: nowrap;
      }
      table.grid th {
        font-weight: 600;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-muted, #888);
        background: var(--surface-2, #1a1d23);
        position: sticky;
        top: 0;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .ts {
        font-variant-numeric: tabular-nums;
      }
      tr.dim {
        opacity: 0.6;
      }
      .dir-buy {
        color: var(--good, #4ade80);
        font-weight: 600;
      }
      .dir-sell {
        color: var(--bad, #f87171);
        font-weight: 600;
      }
      .state {
        display: inline-block;
        padding: 0.1rem 0.5rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        background: var(--surface-3, #23262e);
        color: var(--text-muted, #888);
      }
      .state-parked {
        background: #2a3a55;
        color: #8ab4f8;
      }
      .state-revalidating {
        background: #4a3a14;
        color: #f7c365;
      }
      .state-approved {
        background: #1e4d2b;
        color: #4ade80;
      }
      .state-rejected,
      .state-expired,
      .state-canceled {
        background: #4d1e1e;
        color: #f87171;
      }
      .terminal {
        max-width: 14rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .btn {
        padding: 0.4rem 0.85rem;
        font-size: 0.85rem;
        border-radius: 4px;
        border: 1px solid var(--border, #333);
        background: var(--surface-3, #23262e);
        color: inherit;
        cursor: pointer;
      }
      .btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary:hover:not([disabled]) {
        background: var(--surface-4, #2e3138);
      }
      .btn-mini {
        padding: 0.2rem 0.55rem;
        font-size: 0.75rem;
      }
      .btn-danger {
        border-color: #6e2424;
        color: #f87171;
      }
      .btn-danger:hover:not([disabled]) {
        background: #4d1e1e;
      }
      code {
        font-family: var(--font-mono, monospace);
        font-size: 0.85em;
      }
    `,
  ],
})
export class PendingSignalRecsPageComponent implements OnInit, OnDestroy {
  private readonly svc = inject(PendingSignalRecsService);
  private readonly notify = inject(NotificationService);

  protected readonly allStates = [
    'Parked',
    'Revalidating',
    'Approved',
    'Rejected',
    'Expired',
    'Canceled',
  ] as const;

  protected readonly selectedStates = signal<Set<string>>(new Set(['Parked', 'Revalidating']));
  protected readonly symbolFilter = signal('');
  protected readonly rows = signal<PendingSignalRecDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly canceling = signal<Set<number>>(new Set());

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 5_000;

  ngOnInit(): void {
    this.reload();
    this.pollHandle = setInterval(
      () => this.reload(),
      PendingSignalRecsPageComponent.POLL_INTERVAL_MS,
    );
  }

  ngOnDestroy(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  protected toggleState(state: string, on: boolean): void {
    const next = new Set(this.selectedStates());
    if (on) next.add(state);
    else next.delete(state);
    this.selectedStates.set(next);
    this.reload();
  }

  protected isTerminal(state: string): boolean {
    return (
      state === 'Approved' || state === 'Rejected' || state === 'Expired' || state === 'Canceled'
    );
  }

  protected reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const states = Array.from(this.selectedStates());
    const symbol = this.symbolFilter().trim();
    this.svc
      .query({
        pageNumber: 1,
        pageSize: 100,
        states: states.length > 0 ? states : null,
        search: symbol.length > 0 ? symbol : null,
      })
      .pipe(
        finalize(() => this.loading.set(false)),
        catchError((err) => {
          this.loadError.set(err?.error?.message ?? 'Failed to load.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.loadError.set(res.message ?? 'Failed to load.');
          return;
        }
        this.rows.set(res.data?.data ?? []);
      });
  }

  protected cancel(row: PendingSignalRecDto): void {
    if (!confirm(`Cancel parked rec #${row.id} (${row.direction} ${row.symbol})?`)) return;
    const inFlight = new Set(this.canceling());
    inFlight.add(row.id);
    this.canceling.set(inFlight);
    this.svc
      .cancel(row.id)
      .pipe(
        finalize(() => {
          const next = new Set(this.canceling());
          next.delete(row.id);
          this.canceling.set(next);
        }),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Cancel failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.notify.error(res.message ?? 'Cancel failed.');
          return;
        }
        this.notify.success(`Cancelled rec #${row.id}.`);
        this.reload();
      });
  }
}
