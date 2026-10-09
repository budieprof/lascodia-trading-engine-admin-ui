import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom, merge, throttleTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AccountScopeService } from '@core/scope/account-scope.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { ZonedDatePipe } from '../zoned-time';
import { ChartPanelsService } from './chart-panels.service';
import type { AccountStrip } from './chart-panels.types';

const REFRESH_MS = 15_000;

/**
 * The account strip (SP-I9): what is live for the console's account scope and the charted symbol — open positions and
 * their P&L, working orders, live signals and open paper trades, with the rows on this symbol. Positions and orders
 * belong to accounts and follow the scope; signals and paper trades do not (signals fan out to accounts when they
 * execute, paper trades belong to strategies), so those two are engine-wide and labelled so. Refreshed every 15 s and
 * on every order / position / signal event.
 */
@Component({
  selector: 'app-account-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, ZonedDatePipe],
  template: `
    @if (error(); as e) {
      <div class="pane-empty">{{ e }}</div>
    }
    @if (strip(); as s) {
      <div class="as-scope">
        @if (s.accountName) {
          <b>{{ s.accountName }}</b>
          @if (s.isPaperAccount) {
            <span class="as-tag">paper</span>
          }
          @if (s.equity !== null) {
            <span class="muted"
              >· equity {{ s.equity | number: '1.2-2' }} {{ s.accountCurrency }} · balance
              {{ s.balance | number: '1.2-2' }}</span
            >
          }
        } @else {
          <b>{{ scopeLabel() }}</b>
        }
      </div>
      <div class="as-counters">
        <a class="as-counter" routerLink="/positions" title="Open positions in the account scope">
          <span class="as-n">{{ s.openPositions }}</span> positions
          <span class="as-pnl" [class.up]="s.unrealizedPnl > 0" [class.down]="s.unrealizedPnl < 0">{{
            s.unrealizedPnl | number: '1.2-2'
          }}</span>
        </a>
        <a class="as-counter" routerLink="/orders" title="Pending, submitted or partly filled orders in the account scope">
          <span class="as-n">{{ s.workingOrders }}</span> working orders
        </a>
        <a class="as-counter" routerLink="/trade-signals" title="Pending or approved signals not yet expired — every account">
          <span class="as-n">{{ s.liveSignals }}</span> live signals <small class="muted">engine-wide</small>
        </a>
        <span class="as-counter" title="Open simulated paper trades — they belong to strategies, not accounts">
          <span class="as-n">{{ s.openPaperTrades }}</span> paper trades <small class="muted">engine-wide</small>
        </span>
      </div>

      <h5>On {{ s.symbol }}</h5>
      @if (
        !s.positionsOnSymbol.length &&
        !s.ordersOnSymbol.length &&
        !s.signalsOnSymbol.length &&
        !s.paperTradesOnSymbol.length
      ) {
        <p class="muted as-empty">Nothing live on {{ s.symbol }}.</p>
      }
      @for (p of s.positionsOnSymbol; track p.id) {
        <div class="as-row">
          <span class="as-kind">Position</span>
          <span [class.up]="p.direction === 'Long'" [class.down]="p.direction === 'Short'">{{ p.direction }}</span>
          {{ p.lots | number: '1.2-2' }} &#64; {{ p.entryPrice | number: '1.' + digits() + '-' + digits() }}
          <span class="muted">SL {{ p.stopLoss === null ? '—' : (p.stopLoss | number: '1.' + digits() + '-' + digits()) }}</span>
          <span class="as-pnl" [class.up]="p.unrealizedPnl > 0" [class.down]="p.unrealizedPnl < 0">{{
            p.unrealizedPnl | number: '1.2-2'
          }}</span>
        </div>
      }
      @for (o of s.ordersOnSymbol; track o.id) {
        <a class="as-row" [routerLink]="['/orders', o.id]">
          <span class="as-kind">Order</span>
          {{ o.side }} {{ o.executionType }} {{ o.lots | number: '1.2-2' }}
          @if (o.price > 0) {
            &#64; {{ o.price | number: '1.' + digits() + '-' + digits() }}
          }
          <span class="muted">{{ o.status }}</span>
        </a>
      }
      @for (sg of s.signalsOnSymbol; track sg.id) {
        <div class="as-row" [title]="sg.isManual ? 'Manual signal' : 'From ' + (sg.strategyName ?? 'strategy #' + sg.strategyId)">
          <span class="as-kind">Signal</span>
          <span [class.up]="sg.direction === 'Buy'" [class.down]="sg.direction === 'Sell'">{{ sg.direction }}</span>
          &#64; {{ sg.entryPrice | number: '1.' + digits() + '-' + digits() }}
          <span class="muted">{{ sg.status }} · until {{ sg.expiresAt | zonedDate: timeZone() : 'time' }}</span>
          <span class="muted as-src">{{ sg.isManual ? 'manual' : (sg.strategyName ?? '#' + sg.strategyId) }}</span>
        </div>
      }
      @for (pt of s.paperTradesOnSymbol; track pt.id) {
        <div class="as-row">
          <span class="as-kind">Paper</span>
          <span [class.up]="pt.direction === 'Buy'" [class.down]="pt.direction === 'Sell'">{{ pt.direction }}</span>
          {{ pt.lots | number: '1.2-2' }} &#64; {{ pt.fillPrice | number: '1.' + digits() + '-' + digits() }}
          <span class="muted as-src">{{ pt.strategyName ?? '#' + pt.strategyId }}</span>
        </div>
      }
      <div class="as-foot muted">as of {{ s.asOfUtc | zonedDate: timeZone() : 'dateTime' }}</div>
    } @else if (!error()) {
      <div class="pane-empty">Loading…</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }
      .as-scope {
        padding: 0 10px 6px;
      }
      .as-tag {
        margin-left: 4px;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        background: var(--tv-hover, #f0f3fa);
      }
      .as-counters {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        padding: 0 10px 8px;
      }
      .as-counter {
        display: block;
        padding: 6px;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 4px;
        color: inherit;
        text-decoration: none;
      }
      a.as-counter:hover {
        background: var(--tv-hover, #f0f3fa);
      }
      .as-n {
        display: block;
        font-size: 16px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      h5 {
        margin: 4px 10px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--tv-muted, #787b86);
      }
      .as-row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 6px;
        padding: 4px 10px;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
        color: inherit;
        text-decoration: none;
        font-variant-numeric: tabular-nums;
      }
      a.as-row:hover {
        background: var(--tv-hover, #f0f3fa);
      }
      .as-kind {
        min-width: 52px;
        font-size: 10px;
        text-transform: uppercase;
        color: var(--tv-muted, #787b86);
      }
      .as-pnl,
      .as-src {
        margin-left: auto;
      }
      .as-empty {
        margin: 4px 10px;
      }
      .as-foot {
        padding: 6px 10px;
        font-size: 11px;
      }
      .up {
        color: #089981;
      }
      .down {
        color: #f23645;
      }
      .muted {
        color: var(--tv-muted, #787b86);
      }
    `,
  ],
})
export class AccountStripComponent {
  private readonly api = inject(ChartPanelsService);
  private readonly scope = inject(AccountScopeService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly symbol = input.required<string>();
  readonly digits = input<number>(5);
  readonly timeZone = input<string | null>(null);

  readonly strip = signal<AccountStrip | null>(null);
  readonly error = signal<string | null>(null);

  readonly scopeLabel = computed(() => {
    const n = this.scope.accountIds().length;
    if (this.scope.isAggregateReal()) return `All real accounts (${n})`;
    return n === 1 ? 'One account' : `All accounts (${n})`;
  });
  private seq = 0;

  constructor() {
    // The scope fingerprint, not the id array: the array is re-created on every 30 s accounts refresh and would
    // re-fire this read in a loop (the scope service's own advice).
    effect((onCleanup) => {
      const symbol = this.symbol();
      this.scope.accountIdsKey();
      untracked(() => {
        this.strip.set(null);
        void this.read(symbol);
      });
      const timer = setInterval(() => {
        if (!document.hidden) void this.read(symbol);
      }, REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    merge(
      this.realtime.on('orderCreated'),
      this.realtime.on('orderFilled'),
      this.realtime.on('positionOpened'),
      this.realtime.on('positionClosed'),
      this.realtime.on('positionLifecycleEvent'),
      this.realtime.on('tradeSignalCreated'),
    )
      .pipe(throttleTime(1_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.read(this.symbol()));
    this.destroyRef.onDestroy(() => this.seq++);
  }

  private async read(symbol: string): Promise<void> {
    const n = ++this.seq;
    try {
      const s = await firstValueFrom(this.api.accountStrip(symbol, untracked(() => this.scope.accountIds())));
      if (n !== this.seq) return;
      this.strip.set(s);
      this.error.set(null);
    } catch (e) {
      if (n !== this.seq) return;
      this.error.set(e instanceof Error && e.message ? e.message : 'The account strip could not be loaded.');
    }
  }
}
