import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import { PositionsService } from '@core/services/positions.service';
import type { PositionDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { NotificationService } from '@core/notifications/notification.service';

import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import {
  EATradeChartModalComponent,
  type TradeChartSelection,
} from '../ea-trade-chart-modal/ea-trade-chart-modal.component';

/**
 * Phase-5b admin panel — renders the EA instance's currently-open
 * positions exactly as the MT5 Toolbox `Trade` tab does, but server-side
 * via the engine.  Polls `/position/list` every 10s scoped by the EA's
 * trading account and instance id, sorted newest-first.
 *
 * Trips the engine's "EA-mode" code path on `GetPagedPositionsQuery`
 * (tradingAccountId/instanceId present in the body) — sortBy defaults
 * to OpenedAt DESC, status defaults to Open, and pageSize is enlarged
 * so an account with 20+ historical Closed positions doesn't push the
 * current Open positions off page 1.  See ADR-0007 (EA reconciliation)
 * for why this matters.
 */
@Component({
  selector: 'app-ea-positions-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    ProgressBarComponent,
    EmptyStateComponent,
    EATradeChartModalComponent,
  ],
  template: `
    <section class="panel" aria-label="EA open positions">
      <header class="panel-head">
        <h3>Open positions</h3>
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
        <p class="hint muted">Loading positions…</p>
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No open positions"
          description="This trading account currently has no open positions. Pending orders are shown in the panel below."
        />
      } @else {
        <div class="scroll-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th class="num">Lots</th>
                <th class="num">Entry</th>
                <th class="num">Now</th>
                <th class="num">SL</th>
                <th class="num">TP</th>
                <th class="num">PnL</th>
                <th>Opened</th>
                <th title="Time since the originating signal was generated">Signal age</th>
                <th>Broker id</th>
              </tr>
            </thead>
            <tbody>
              @for (p of rows(); track p.id) {
                <tr
                  class="clickable"
                  [attr.data-paper]="p.isPaper ? 'true' : null"
                  (click)="openChart(p)"
                  tabindex="0"
                  role="button"
                  (keydown.enter)="openChart(p)"
                  (keydown.space)="$event.preventDefault(); openChart(p)"
                >
                  <td class="mono">{{ p.symbol }}</td>
                  <td>
                    <span class="side-pill" [attr.data-side]="p.direction">{{ p.direction }}</span>
                  </td>
                  <td class="num mono">{{ p.openLots | number: '1.2-2' }}</td>
                  <td class="num mono">{{ p.averageEntryPrice | number: '1.5-5' }}</td>
                  <td class="num mono">
                    @if (p.currentPrice !== null) {
                      {{ p.currentPrice | number: '1.5-5' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="num mono">
                    @if (p.stopLoss !== null) {
                      {{ p.stopLoss | number: '1.5-5' }}
                      @if (p.bumpedAt !== null && p.originalStopLoss !== null) {
                        <span class="bumped-tag" [title]="bumpTooltip(p)">bumped</span>
                      }
                      <a
                        class="sl-history-link"
                        [routerLink]="['/spread-reactive']"
                        [queryParams]="{ positionId: p.id }"
                        fragment="sl-audit"
                        title="View SL change history for this position"
                        (click)="$event.stopPropagation()"
                        >history</a
                      >
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="num mono">
                    @if (p.takeProfit !== null) {
                      {{ p.takeProfit | number: '1.5-5' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td
                    class="num mono"
                    [class.pnl-pos]="p.unrealizedPnL > 0"
                    [class.pnl-neg]="p.unrealizedPnL < 0"
                  >
                    {{ p.unrealizedPnL | number: '1.2-2' }}
                  </td>
                  <td class="mono small">{{ p.openedAt | date: 'yyyy-MM-dd HH:mm' }}</td>
                  <td class="mono small" [class.muted]="!p.signalGeneratedAt">
                    {{ signalAge(p.signalGeneratedAt) }}
                  </td>
                  <td class="mono small muted">{{ p.brokerPositionId ?? '—' }}</td>
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
      (actionConfirmed)="onClosePosition()"
      (slTpModified)="onSlTpModified()"
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
       * stay visible while the body scrolls.  Matches the pending-orders
       * panel sibling.
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
      .pnl-pos {
        color: #1d8a3e;
      }
      .pnl-neg {
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
      .bumped-tag {
        display: inline-block;
        margin-left: 4px;
        padding: 1px 6px;
        border-radius: 8px;
        background: color-mix(in srgb, #ff9f0a 22%, transparent);
        color: #c97700;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        cursor: help;
      }
      .sl-history-link {
        display: inline-block;
        margin-left: 6px;
        font-size: 10px;
        color: var(--text-secondary, #888);
        text-decoration: none;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        opacity: 0.7;
      }
      .sl-history-link:hover {
        opacity: 1;
        text-decoration: underline;
      }
    `,
  ],
})
export class EAPositionsPanelComponent {
  readonly tradingAccountId = input<number | null>(null);
  readonly instanceId = input<string>('');
  // Phase-14: CSV of the EA instance's owned symbols.  When provided,
  // the panel narrows to rows whose symbol is in this set so a sibling
  // EA detail page doesn't surface the parent's positions (or vice
  // versa).  Empty / null = show everything for the account (backward-
  // compatible with callers that haven't been updated).
  readonly ownedSymbolsCsv = input<string | null>(null);

  private readonly positions = inject(PositionsService);

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
      const instance = this.instanceId();
      if (!accountId) return of<PositionDto[]>([]);
      // Engine's "EA-mode" body: tradingAccountId + instanceId at top level
      // triggers reconciliation-friendly defaults (Status=Open, page size
      // enlarged, sort DESC by OpenedAt).  We don't need to set pager
      // params explicitly.
      const body = {
        tradingAccountId: accountId,
        instanceId: instance || undefined,
      } as Record<string, unknown>;
      return this.positions.list(body as unknown as Record<string, never>).pipe(
        map((res) => res.data?.data ?? []),
        catchError(() => of<PositionDto[]>([])),
      );
    },
    { intervalMs: 10_000 },
  );

  protected readonly rows = computed(() => {
    const all = this.resource.value() ?? [];
    const owned = this.ownedSymbolSet();
    if (!owned) return all;
    return all.filter((p) => owned.has((p.symbol ?? '').toUpperCase()));
  });

  // ── Phase-6 click-to-chart ───────────────────────────────────────────────
  // The row click opens a shared trade-chart modal showing candles centred on
  // the position's OpenedAt with horizontal markers for entry / SL / TP /
  // current price.  Chart selection is held in a signal so re-clicks
  // (different row, same panel) re-trigger ngOnChanges in the modal.
  protected readonly chartSelection = signal<TradeChartSelection | null>(null);
  protected readonly chartOpen = signal(false);

  protected openChart(p: PositionDto): void {
    if (!p.symbol) return;
    this.selectedPositionId = p.id;
    this.chartSelection.set({
      title: `Position #${p.id} · ${p.symbol} · ${p.direction}`,
      symbol: p.symbol,
      direction: p.direction === 'Long' ? 'Buy' : p.direction === 'Short' ? 'Sell' : 'Buy',
      referencePrice: p.averageEntryPrice,
      referenceTime: p.openedAt,
      referenceLabel: 'ENTRY',
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      currentPrice: p.currentPrice,
      // Filled in by the account-aware live-price fetch below — null on
      // initial render so the modal opens immediately without blocking.
      currentAsk: null,
      // Closed positions are filtered out at the resource level so exitPrice
      // never applies here; left null for forward-compat if we widen the
      // panel later to include "recently closed".
      exitPrice: null,
      exitTime: null,
      action: {
        label: 'Close position',
        confirmLabel: 'Confirm close',
        busyLabel: 'Closing…',
        description:
          `Closes ${p.openLots} lot${p.openLots === 1 ? '' : 's'} of ${p.symbol} at the current market price. ` +
          `The engine queues a ClosePosition EA command and transitions Open → Closing; the EA acknowledges ` +
          `when MT5 confirms the broker-side close.`,
      },
      editable: { kind: 'position', id: p.id },
    });
    this.chartOpen.set(true);

    // Account-aware live bid/ask — used to draw both the BID and ASK
    // horizontal lines on the chart with the spread this specific broker is
    // currently quoting (not whichever broker last fed the symbol cache).
    this.marketData
      .getAccountLivePrice(p.tradingAccountId, p.symbol)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        if (this.selectedPositionId !== p.id) return;
        const cur = this.chartSelection();
        if (!cur) return;
        const bid = res.data.bid ?? cur.currentPrice;
        // Derive Ask from whichever Bid we have + the per-account spread.
        // Falls back to res.data.ask (already computed engine-side when the
        // symbol cache had a tick) so we still draw an Ask line even when
        // the spread cascade landed on "SymbolFallback".
        const ask =
          bid !== null && res.data.perAccountSpread !== null
            ? bid + res.data.perAccountSpread
            : res.data.ask;
        this.chartSelection.set({
          ...cur,
          currentPrice: bid,
          currentAsk: ask,
        });
      });

    // Fetch signal → order-placement timing and patch the selection when it
    // lands (new object → the modal's OnChanges picks it up and shows the delta).
    this.positionsSvc.getTiming(p.id).subscribe({
      next: (res) => {
        if (!res?.status || !res.data) return;
        if (this.selectedPositionId !== p.id) return; // operator moved on
        const cur = this.chartSelection();
        if (!cur) return;
        this.chartSelection.set({
          ...cur,
          // Use GeneratedAt (when the signal row fired) — not TriggeredAt, which
          // is the analysed bar's market timestamp and can predate the signal by
          // days, making the latency meaningless.
          signalAt: res.data.signalGeneratedAt ?? res.data.signalTriggeredAt,
          orderPlacedAt: res.data.orderPlacedAt,
        });
      },
      error: () => {
        /* timing is non-critical — leave the delta hidden on failure */
      },
    });
  }

  // ── Phase-7b close-position flow ─────────────────────────────────────────
  // The modal's two-stage confirm fires `(actionConfirmed)` only after the
  // operator has armed the destructive button.  We need a price to send to
  // the engine's ClosePositionCommand (validator requires > 0); fall back
  // to averageEntryPrice if currentPrice isn't set yet (positions just
  // opened can momentarily have currentPrice=null until the next tick
  // snapshot lands).
  protected readonly actionBusy = signal(false);
  private selectedPositionId: number | null = null;
  private readonly positionsSvc = inject(PositionsService);
  private readonly marketData = inject(MarketDataService);
  private readonly notify = inject(NotificationService);

  protected onClosePosition(): void {
    const id = this.selectedPositionId;
    const sel = this.chartSelection();
    if (!id || !sel) return;
    const closePrice =
      sel.currentPrice && sel.currentPrice > 0 ? sel.currentPrice : sel.referencePrice;
    this.actionBusy.set(true);
    this.positionsSvc
      .close(id, closePrice)
      .pipe(finalize(() => this.actionBusy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Position #${id} close queued.`);
            this.chartOpen.set(false);
            this.resource.refresh();
          } else {
            this.notify.error(res.message ?? 'Failed to queue position close.');
          }
        },
        error: () => this.notify.error('Failed to queue position close.'),
      });
  }

  /**
   * After a chart-driven SL/TP drag is accepted by the engine, refresh
   * the position list so the row picks up the authoritative new level.
   * The modal also re-renders its grips off the new selection.
   */
  protected onSlTpModified(): void {
    this.resource.refresh();
  }

  /**
   * Human-readable "minutes since the originating signal was generated".
   * Reads `position.signalGeneratedAt` (joined engine-side via
   * Position→Order→TradeSignal). Renders as "X min" under 60 minutes,
   * "Hh Mm" above. The 10s poll cadence is the refresh granularity —
   * between polls a row's age stays frozen at its last-computed value.
   */
  protected signalAge(iso: string | null): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diffMs = Date.now() - t;
    if (diffMs < 0) return '0 min';
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }

  /**
   * Tooltip text for the "bumped" pill on a row whose SL was widened by
   * the spread-reactive subsystem. Surfaces the pre-bump original SL,
   * the reason tag, and when the bump fired.
   */
  protected bumpTooltip(p: {
    originalStopLoss: number | null;
    bumpedAt: string | null;
    bumpedSpread: number | null;
    bumpReason: string | null;
  }): string {
    const origin =
      p.originalStopLoss !== null ? `original SL ${p.originalStopLoss}` : 'no original SL recorded';
    const reason = p.bumpReason ?? 'SPREAD';
    const when = p.bumpedAt ? new Date(p.bumpedAt).toISOString() : '—';
    const spread = p.bumpedSpread !== null ? ` · spread at bump ${p.bumpedSpread}` : '';
    return `${reason} bump — ${origin}${spread} · since ${when}`;
  }
}
