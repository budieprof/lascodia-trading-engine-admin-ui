import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import type { OrderDto } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';

import type { ChartHostComponent } from '../chart/chart-host.component';
import type { ChartPosition, LiveQuote } from '../overlays/trade-layer';
import { ManualTradingService } from './manual-trading.service';
import type {
  ManualTradePreview,
  ManualTradeResult,
  OrderEntryMovePreview,
  PositionChangePreview,
} from './manual-trading.types';
import { OrderTicketComponent } from './order-ticket.component';
import {
  actionableLines,
  dragSideProblem,
  livePending,
  movedOrderLevels,
  newCorrelationId,
  pendingLines,
  type PendingChange,
  type PendingKind,
} from './position-lines';
import {
  DEFAULT_TICKET,
  moveTicketLine,
  ticketEntry,
  ticketLines,
  type TicketPrefill,
  type TicketState,
} from './ticket-model';
import { roundPrice, type TradeLine } from './trade-lines';
import { TradeLinesPrimitive, type TradeLineMove } from './trade-lines-primitive';

/** How often a pending change asks whether the EA has answered. */
const PENDING_POLL_MS = 1_500;
/** A change with no EA command (no broker ticket: engine-side only) is done once this old. */
const NO_COMMAND_GRACE_MS = 5_000;

/** What the confirm dialog is about. */
type ChartAction =
  | {
      type: 'move';
      kind: 'stop' | 'target';
      positionId: number;
      from: number;
      to: number;
      preview: PositionChangePreview | null;
    }
  | {
      type: 'orderMove';
      kind: 'orderStop' | 'orderTarget';
      order: OrderDto;
      from: number;
      to: number;
    }
  | {
      type: 'orderEntry';
      order: OrderDto;
      from: number;
      to: number;
      /** Move the stop and target by the same distance (the default: the trade keeps its shape). */
      withBrackets: boolean;
    }
  | { type: 'close'; positionId: number; lots: number; preview: PositionChangePreview | null }
  | { type: 'cancel'; order: OrderDto };

/**
 * Trading from the chart (SP-I3 / SP-I4) in one place, so the page only places it:
 * <ul>
 *   <li>the order ticket and its brackets as draggable lines (SP-I4);</li>
 *   <li>an open position's stop and target dragged, its entry line clicked to close or partly close it, a working
 *   order's stop and target dragged, its price dragged to move the order (with its stop and target by default; EA
 *   ModifyOrderPrice) and clicked to cancel it (SP-I3) — each through a confirm dialog that
 *   shows the account, the new risk in money and R and the distance in pips and ATR from the engine's own
 *   preview, refused when the engine would refuse it (the ATR stop guard, no EA to carry it);</li>
 *   <li>a sent change stays a faded "waiting for the EA" line until the EA acknowledges it; a refusal says why and
 *   the chart snaps back to what the broker holds (the engine restores it).</li>
 * </ul>
 * The page passes the chart host, the symbol, its digits and pip, the live quote, the trade layer's rows and the
 * account scope.
 */
@Component({
  selector: 'app-chart-trading',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OrderTicketComponent, DecimalPipe],
  template: `
    @if (open()) {
      <app-order-ticket
        class="ticket-dock"
        [symbol]="symbol()"
        [precision]="precision()"
        [pipSize]="pipSize()"
        [quote]="quote()"
        [(state)]="ticket"
        (previewChange)="ticketPreview.set($event)"
        (submitted)="onSubmitted($event)"
        (closed)="open.set(false)"
      />
    }

    <dialog
      #actionDialog
      class="trade-action"
      (close)="action.set(null)"
      data-testid="trade-action-dialog"
    >
      @if (action(); as a) {
        <form method="dialog" (submit)="$event.preventDefault()">
          @switch (a.type) {
            @case ('move') {
              <h3>Move the {{ a.kind === 'stop' ? 'stop loss' : 'take profit' }}</h3>
              <p>
                {{ a.from | number: digits() }} →
                <strong>{{ a.to | number: digits() }}</strong>
              </p>
            }
            @case ('orderMove') {
              <h3>
                Move the working order's {{ a.kind === 'orderStop' ? 'stop loss' : 'take profit' }}
              </h3>
              <p>
                {{ a.order.orderType }} {{ a.order.quantity }} {{ a.order.symbol }} at
                {{ a.order.price | number: digits() }}: {{ a.from | number: digits() }} →
                <strong>{{ a.to | number: digits() }}</strong> ({{
                  orderDistancePips(a) | number: '1.1-1'
                }}
                pips from its entry)
              </p>
              <p class="muted">
                The engine checks the stop against the noise guard before it is sent.
              </p>
            }
            @case ('orderEntry') {
              <h3>Move the working order's entry</h3>
              <p>
                {{ a.order.executionType }} {{ a.order.orderType }} {{ a.order.quantity }}
                {{ a.order.symbol }}: {{ a.from | number: digits() }} →
                <strong>{{ a.to | number: digits() }}</strong>
              </p>
              <label class="row">
                <input
                  type="checkbox"
                  [checked]="a.withBrackets"
                  (change)="setWithBrackets($any($event.target).checked)"
                  data-testid="entry-with-brackets"
                />
                Move the stop and target with it
              </label>
              @if (entryLevels(); as lv) {
                <p class="muted">
                  Stop {{ lv.stopLoss === null ? 'none' : (lv.stopLoss | number: digits()) }} ·
                  target {{ lv.takeProfit === null ? 'none' : (lv.takeProfit | number: digits()) }}
                </p>
              }
            }
            @case ('close') {
              <h3>Close the position</h3>
              <label class="row">
                Lots to close
                <input
                  type="number"
                  [step]="lotStep()"
                  min="0"
                  [value]="a.lots"
                  (change)="setCloseLots($any($event.target).value)"
                  data-testid="close-lots"
                />
              </label>
            }
            @case ('cancel') {
              <h3>Cancel the working order</h3>
              <p>
                {{ a.order.executionType }} {{ a.order.orderType }} {{ a.order.quantity }}
                {{ a.order.symbol }} at {{ a.order.price | number: digits() }}.
              </p>
            }
          }

          @if (changePreview(); as p) {
            <p class="account">
              Account {{ p.accountName || p.accountId }} · {{ p.accountId }} · {{ p.accountType }}
              @if (p.accountType === 'Real') {
                <strong class="real">real money</strong>
              }
            </p>
            <dl class="facts">
              @if (p.newStop !== null) {
                <dt>Distance</dt>
                <dd>
                  {{ p.stopDistancePips | number: '1.1-1' }} pips ·
                  {{ p.stopDistanceAtr | number: '1.2-2' }} ATR from the
                  {{ p.isLong ? 'bid' : 'ask' }}
                </dd>
                <dt>If stopped</dt>
                <dd>
                  {{ p.pnlAtNewStop | number: '1.2-2' }} {{ p.currency }}
                  @if (p.rAtNewStop !== null) {
                    ({{ p.rAtNewStop | number: '1.2-2' }}R)
                  }
                </dd>
              }
              @if (p.newTarget !== null) {
                <dt>At the target</dt>
                <dd>
                  {{ p.pnlAtNewTarget | number: '1.2-2' }} {{ p.currency }}
                  @if (p.rAtNewTarget !== null) {
                    ({{ p.rAtNewTarget | number: '1.2-2' }}R)
                  }
                </dd>
              }
              @if (p.closeLots !== null) {
                <dt>Closes</dt>
                <dd>{{ p.closeLots }} of {{ p.openLots }} lots</dd>
                <dt>Result ≈</dt>
                <dd>
                  {{ p.closePnl | number: '1.2-2' }} {{ p.currency }} (the broker's fill decides)
                </dd>
              }
            </dl>
            <ul class="gates">
              @for (g of p.gates; track g.key) {
                <li [class.fail]="!g.passed && g.blocking" [class.info]="!g.passed && !g.blocking">
                  {{ g.passed ? '✓' : g.blocking ? '✕' : '!' }} {{ g.detail }}
                </li>
              }
            </ul>
          } @else if (entryPreview(); as e) {
            <p class="account">
              Account {{ e.accountName || e.accountId }} · {{ e.accountId }} · {{ e.accountType }}
              @if (e.accountType === 'Real') {
                <strong class="real">real money</strong>
              }
            </p>
            <dl class="facts" data-testid="entry-move-facts">
              @if (e.distanceFromMarketPips !== null) {
                <dt>From the market</dt>
                <dd>
                  {{ e.distanceFromMarketPips | number: '1.1-1' }} pips from the
                  {{ e.isBuy ? 'ask' : 'bid' }}
                </dd>
              }
              @if (e.stopDistancePips !== null) {
                <dt>Stop</dt>
                <dd>
                  {{ e.stopDistancePips | number: '1.1-1' }} pips
                  @if (e.stopDistanceAtr !== null) {
                    · {{ e.stopDistanceAtr | number: '1.2-2' }} ATR
                  }
                  from the new entry
                </dd>
              }
              @if (e.riskAtStop !== null) {
                <dt>If stopped</dt>
                <dd>−{{ e.riskAtStop | number: '1.2-2' }} {{ e.currency }}</dd>
              }
              @if (e.rewardAtTarget !== null) {
                <dt>At the target</dt>
                <dd>
                  +{{ e.rewardAtTarget | number: '1.2-2' }} {{ e.currency }}
                  @if (e.targetR !== null) {
                    ({{ e.targetR | number: '1.2-2' }}R)
                  }
                </dd>
              }
            </dl>
            <ul class="gates">
              @for (g of e.gates; track g.key) {
                <li [class.fail]="!g.passed && g.blocking" [class.info]="!g.passed && !g.blocking">
                  {{ g.passed ? '✓' : g.blocking ? '✕' : '!' }} {{ g.detail }}
                </li>
              }
            </ul>
          } @else if (previewLoading()) {
            <p class="muted">Checking with the engine…</p>
          }
          @if (actionError(); as e) {
            <p class="refused" data-testid="trade-action-error">{{ e }}</p>
          }

          <div class="actions">
            <button type="button" (click)="closeAction()">Cancel</button>
            <button
              type="button"
              class="apply"
              [disabled]="!canApply()"
              (click)="apply()"
              data-testid="trade-action-apply"
            >
              {{ applyLabel() }}
            </button>
          </div>
        </form>
      }
    </dialog>
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .ticket-dock {
        position: absolute;
        top: 8px;
        right: 72px;
        bottom: 8px;
        z-index: 20;
        display: flex;
        align-items: flex-start;
        pointer-events: none;
      }
      .ticket-dock > * {
        pointer-events: auto;
      }
      .trade-action {
        max-width: 420px;
        border: 1px solid var(--border-1, #363a45);
        border-radius: 6px;
        background: var(--surface-1, #1e222d);
        color: var(--text-1, #d1d4dc);
        font-size: 13px;
      }
      .trade-action h3 {
        margin: 0 0 6px;
        font-size: 14px;
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 8px;
      }
      .facts dt {
        opacity: 0.7;
      }
      .facts dd {
        margin: 0;
      }
      .gates {
        list-style: none;
        padding: 0;
        margin: 6px 0;
      }
      .gates li.fail,
      .refused {
        color: #ef5350;
      }
      .gates li.info {
        color: #f9a825;
      }
      .real {
        color: #e65100;
        margin-left: 4px;
      }
      .muted {
        opacity: 0.75;
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
      .apply {
        background: #2962ff;
        color: #fff;
        border: 0;
        border-radius: 4px;
        padding: 5px 12px;
      }
      .apply:disabled {
        opacity: 0.45;
      }
    `,
  ],
})
export class ChartTradingComponent {
  private readonly trading = inject(ManualTradingService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  /** The chart the lines hang on (the page's `#host`). */
  readonly host = input<ChartHostComponent | undefined>(undefined);
  readonly symbol = input.required<string>();
  readonly precision = input(5);
  readonly pipSize = input(0.0001);
  readonly quote = input<LiveQuote | null>(null);
  /** The symbol's lot step (partial closes are multiples of it). */
  readonly lotStep = input(0.01);
  /** The trade layer's open positions and working orders, and the account scope they are filtered by. */
  readonly positions = input<readonly ChartPosition[]>([]);
  readonly orders = input<readonly OrderDto[]>([]);
  readonly accountIds = input<ReadonlyArray<number>>([]);
  /** The ticket is open (the toolbar's "Trade" toggles it). */
  readonly open = model(false);
  /** Open the ticket with these values (a position tool's "Stage…", DR-I9); null = nothing to apply. */
  readonly prefill = input<TicketPrefill | null>(null);

  /** A ticket went through (paper opened or live signal created): the page refreshes its trade layers. */
  readonly submitted = output<ManualTradeResult>();
  /** A position or order changed (or a change was refused): the page re-reads its trade layers. */
  readonly changed = output<void>();

  readonly ticket = signal<TicketState>({ ...DEFAULT_TICKET });
  readonly ticketPreview = signal<ManualTradePreview | null>(null);

  readonly action = signal<ChartAction | null>(null);
  readonly changePreview = signal<PositionChangePreview | null>(null);
  /** The engine's check of a working order's entry move (move-preview). */
  readonly entryPreview = signal<OrderEntryMovePreview | null>(null);
  readonly previewLoading = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly sending = signal(false);
  readonly pending = signal<PendingChange[]>([]);

  private readonly actionDialog = viewChild<ElementRef<HTMLDialogElement>>('actionDialog');

  readonly digits = computed(() => `1.${this.precision()}-${this.precision()}`);

  private readonly lines = new TradeLinesPrimitive(
    () => this.precision(),
    (move) => this.onLineMoved(move),
    (line) => this.onLineClicked(line),
  );

  /** The ticket's brackets as chart lines while it is open. */
  private readonly ticketBrackets = computed(() =>
    this.open()
      ? ticketLines(
          this.ticket(),
          ticketEntry(this.ticket(), this.quote()),
          this.pipSize(),
          this.ticketPreview(),
        )
      : [],
  );

  private readonly inScope = computed(() => {
    const ids = this.accountIds();
    return (id: number | null | undefined) => id != null && ids.includes(id);
  });

  /** Every line this layer handles: the ticket's, the actionable positions' and orders', and the pending ghosts. */
  private readonly allLines = computed<TradeLine[]>(() => [
    ...this.ticketBrackets(),
    ...actionableLines(
      this.positions(),
      this.orders(),
      this.symbol(),
      this.inScope(),
      this.pending(),
    ),
    ...pendingLines(this.pending(), this.precision()),
  ]);

  readonly canApply = computed(() => {
    const a = this.action();
    if (!a || this.sending()) return false;
    if (a.type === 'move' || a.type === 'close') return !!this.changePreview()?.canApply;
    if (a.type === 'orderEntry') return !!this.entryPreview()?.canApply;
    return true;
  });

  /** The levels an entry move sends (stop and target shifted with it, or kept). */
  readonly entryLevels = computed(() => {
    const a = this.action();
    return a?.type === 'orderEntry'
      ? movedOrderLevels(a.order, a.to, a.withBrackets, this.precision())
      : null;
  });

  readonly applyLabel = computed(() => {
    const a = this.action();
    if (!a) return '';
    switch (a.type) {
      case 'move':
      case 'orderMove':
        return 'Send the change';
      case 'orderEntry':
        return 'Move the order';
      case 'close':
        return a.lots < (this.changePreview()?.openLots ?? Infinity)
          ? 'Close these lots'
          : 'Close the position';
      case 'cancel':
        return 'Cancel the order';
    }
  });

  constructor() {
    effect((onCleanup) => {
      const host = this.host();
      if (!host) return;
      onCleanup(host.attachPricePrimitive(this.lines));
    });
    effect(() => this.lines.setLines(this.allLines()));

    // A new symbol is a new ticket: brackets priced for EURUSD mean nothing on USDJPY.
    effect(() => {
      this.symbol();
      untracked(() => {
        const s = this.ticket();
        this.ticket.set({ ...DEFAULT_TICKET, accountId: s.accountId, mode: s.mode });
        this.ticketPreview.set(null);
        this.closeAction();
      });
    });

    // "Stage…" (DR-I9): the position tool's side and levels in a PAPER ticket at market — nothing is sent until
    // Submit. Its drawn entry is kept for "At price" (a live pending order).
    effect(() => {
      const pf = this.prefill();
      if (!pf) return;
      untracked(() => {
        const s = this.ticket();
        this.ticket.set({
          ...s,
          direction: pf.direction,
          atMarket: true,
          entry: pf.entry,
          stop: pf.stop,
          target: pf.target,
          mode: 'Paper',
        });
        this.open.set(true);
      });
    });

    const poll = setInterval(() => this.pollPending(), PENDING_POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(poll));
  }

  // ── Lines ─────────────────────────────────────────────────────────────────

  private onLineMoved(move: TradeLineMove): void {
    const { line, price } = move;
    if (line.kind.startsWith('ticket')) {
      this.ticket.update((s) => moveTicketLine(s, line.kind, price));
      return;
    }
    if ((line.kind === 'positionStop' || line.kind === 'positionTarget') && line.refId != null) {
      const p = this.positions().find((x) => x.id === line.refId);
      if (!p) return;
      const long = isLong(p.direction);
      const q = this.quote();
      const trigger = q ? (long ? q.bid : (q.ask ?? q.bid)) : null;
      const problem = dragSideProblem(line.kind, long, price, trigger);
      if (problem) {
        this.notify.warning(problem);
        return;
      }
      const kind = line.kind === 'positionStop' ? 'stop' : 'target';
      this.openAction({
        type: 'move',
        kind,
        positionId: p.id,
        from: line.price,
        to: price,
        preview: null,
      });
      this.loadChangePreview(p.id, kind === 'stop' ? { stopLoss: price } : { takeProfit: price });
      return;
    }
    if (line.kind === 'orderPrice' && line.refId != null) {
      const o = this.orders().find((x) => x.id === line.refId);
      if (!o) return;
      this.openAction({
        type: 'orderEntry',
        order: o,
        from: line.price,
        to: price,
        withBrackets: true,
      });
      this.loadEntryPreview();
      return;
    }
    if ((line.kind === 'orderStop' || line.kind === 'orderTarget') && line.refId != null) {
      const o = this.orders().find((x) => x.id === line.refId);
      if (!o) return;
      const problem = dragSideProblem(line.kind, String(o.orderType) === 'Buy', price, o.price);
      if (problem) {
        this.notify.warning(problem);
        return;
      }
      this.openAction({
        type: 'orderMove',
        kind: line.kind,
        order: o,
        from: line.price,
        to: price,
      });
    }
  }

  private onLineClicked(line: TradeLine): void {
    if (line.kind === 'positionEntry' && line.refId != null) {
      const p = this.positions().find((x) => x.id === line.refId);
      if (!p) return;
      this.openAction({ type: 'close', positionId: p.id, lots: p.openLots, preview: null });
      this.loadChangePreview(p.id, { closeLots: p.openLots });
      return;
    }
    if (line.kind === 'orderPrice' && line.refId != null) {
      const o = this.orders().find((x) => x.id === line.refId);
      if (o) this.openAction({ type: 'cancel', order: o });
    }
  }

  // ── The confirm dialog ────────────────────────────────────────────────────

  private openAction(a: ChartAction): void {
    this.action.set(a);
    this.changePreview.set(null);
    this.entryPreview.set(null);
    this.actionError.set(null);
    const el = this.actionDialog()?.nativeElement;
    if (el && !el.open) el.showModal();
  }

  closeAction(): void {
    this.action.set(null);
    this.changePreview.set(null);
    this.entryPreview.set(null);
    const el = this.actionDialog()?.nativeElement;
    if (el?.open) el.close();
  }

  private previewSeq = 0;
  private loadChangePreview(
    positionId: number,
    change: { stopLoss?: number; takeProfit?: number; closeLots?: number },
  ): void {
    const seq = ++this.previewSeq;
    this.previewLoading.set(true);
    this.trading
      .positionChangePreview(positionId, change)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.previewSeq) return;
          this.previewLoading.set(false);
          if (res?.status && res.data) this.changePreview.set(res.data);
          else this.actionError.set(res?.message || 'The engine could not check the change.');
        },
        error: () => {
          if (seq !== this.previewSeq) return;
          this.previewLoading.set(false);
          this.actionError.set('The engine did not answer the check.');
        },
      });
  }

  /** Asks the engine about the entry move in the dialog (its levels as they stand now). */
  private loadEntryPreview(): void {
    const a = this.action();
    const levels = this.entryLevels();
    if (a?.type !== 'orderEntry' || !levels) return;
    const seq = ++this.previewSeq;
    this.entryPreview.set(null);
    this.actionError.set(null);
    this.previewLoading.set(true);
    this.trading
      .orderEntryMovePreview(a.order.id, levels)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.previewSeq) return;
          this.previewLoading.set(false);
          if (res?.status && res.data) this.entryPreview.set(res.data);
          else this.actionError.set(res?.message || 'The engine could not check the move.');
        },
        error: () => {
          if (seq !== this.previewSeq) return;
          this.previewLoading.set(false);
          this.actionError.set('The engine did not answer the check.');
        },
      });
  }

  setWithBrackets(withBrackets: boolean): void {
    const a = this.action();
    if (a?.type !== 'orderEntry' || a.withBrackets === withBrackets) return;
    this.action.set({ ...a, withBrackets });
    this.loadEntryPreview();
  }

  setCloseLots(raw: string): void {
    const a = this.action();
    if (a?.type !== 'close') return;
    const lots = Number(raw);
    if (!Number.isFinite(lots) || lots <= 0) return;
    this.action.set({ ...a, lots });
    this.loadChangePreview(a.positionId, { closeLots: lots });
  }

  orderDistancePips(a: Extract<ChartAction, { type: 'orderMove' }>): number {
    return this.pipSize() > 0 ? Math.abs(a.to - a.order.price) / this.pipSize() : 0;
  }

  apply(): void {
    const a = this.action();
    if (!a || !this.canApply()) return;
    const cid = newCorrelationId();
    this.sending.set(true);
    switch (a.type) {
      case 'move':
        this.send(
          this.trading.modifyPosition(
            a.positionId,
            a.kind === 'stop' ? a.to : null,
            a.kind === 'target' ? a.to : null,
            cid,
          ),
          {
            correlationId: cid,
            kind: a.kind,
            refId: a.positionId,
            price: a.to,
            label: a.kind === 'stop' ? 'SL' : 'TP',
          },
        );
        return;
      case 'orderMove':
        this.send(
          this.trading.modifyOrder(
            a.order.id,
            a.kind === 'orderStop' ? a.to : null,
            a.kind === 'orderTarget' ? a.to : null,
            cid,
          ),
          {
            correlationId: cid,
            kind: a.kind,
            refId: a.order.id,
            price: a.to,
            label: a.kind === 'orderStop' ? 'O·SL' : 'O·TP',
          },
        );
        return;
      case 'orderEntry': {
        const levels = movedOrderLevels(a.order, a.to, a.withBrackets, this.precision());
        this.send(this.trading.moveOrderEntry(a.order.id, levels, cid), {
          correlationId: cid,
          kind: 'orderEntry',
          refId: a.order.id,
          price: levels.price,
          label: 'Entry',
        });
        return;
      }
      case 'close': {
        const p = this.changePreview();
        if (!p || p.triggerPrice === null) return;
        this.send(
          this.trading.closePosition(a.positionId, p.triggerPrice, roundPrice(a.lots, 2), cid),
          {
            correlationId: cid,
            kind: 'close',
            refId: a.positionId,
            price: p.entry,
            label: `Closing ${a.lots}`,
          },
        );
        return;
      }
      case 'cancel':
        this.send(this.trading.cancelOrder(a.order.id, cid), {
          correlationId: cid,
          kind: 'cancel',
          refId: a.order.id,
          price: a.order.price,
          label: 'Cancelling',
        });
    }
  }

  /** Sends one change; a sent one stays pending (faded line) until the EA answers. A refusal sends nothing. */
  private send(
    request: ReturnType<ManualTradingService['modifyPosition']>,
    change: {
      correlationId: string;
      kind: PendingKind;
      refId: number;
      price: number;
      label: string;
    },
  ): void {
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.sending.set(false);
        if (!res?.status) {
          // Refused before anything was sent (the stop guard, no EA, a closed market): the line stays where it was.
          this.actionError.set(res?.message || 'The engine refused the change.');
          this.changed.emit();
          return;
        }
        this.closeAction();
        if (res.responseCode === '01') {
          // Engine-side only (no broker ticket yet): nothing to wait for.
          this.notify.warning(res.message || 'Changed in the engine only.');
          this.changed.emit();
          return;
        }
        this.pending.update((list) => [...list, { ...change, startedAt: Date.now() }]);
        this.changed.emit();
      },
      error: () => {
        this.sending.set(false);
        this.actionError.set('The change was not sent — the engine did not answer.');
      },
    });
  }

  // ── Pending until the EA answers ──────────────────────────────────────────

  private polling = false;
  private pollPending(): void {
    const now = Date.now();
    const all = this.pending();
    if (all.length === 0 || this.polling) return;
    const live = livePending(all, now);
    if (live.length !== all.length) {
      this.pending.set(live);
      this.notify.warning(
        'No answer from the EA within two minutes: the change is still queued for it. Check the position before changing it again.',
      );
      this.changed.emit();
    }
    this.polling = live.length > 0;
    let remaining = live.length;
    for (const p of live) {
      this.trading
        .commandStatus(p.correlationId)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            if (res?.status && res.data?.acknowledged) {
              this.settle(p, res.data.succeeded === true, res.data.result);
            } else if (
              res &&
              !res.status &&
              res.responseCode === '-14' &&
              Date.now() - p.startedAt > NO_COMMAND_GRACE_MS
            ) {
              // No EA command carries it: the change was engine-side only (no broker ticket).
              this.settle(p, true, null);
            }
            if (--remaining === 0) this.polling = false;
          },
          error: () => {
            if (--remaining === 0) this.polling = false;
          },
        });
    }
  }

  private settle(p: PendingChange, applied: boolean, result: string | null): void {
    this.pending.update((list) => list.filter((x) => x.correlationId !== p.correlationId));
    if (applied)
      this.notify.success(
        `${p.label} ${p.kind === 'close' || p.kind === 'cancel' ? 'done' : `at ${p.price}`}: confirmed by the EA.`,
      );
    else
      this.notify.error(
        `The broker refused it${result ? `: ${result}` : ''}. The chart shows what the broker still holds.`,
      );
    this.changed.emit();
  }

  onSubmitted(result: ManualTradeResult): void {
    this.submitted.emit(result);
    // The ticket keeps its account and mode; its levels belonged to the trade just sent.
    this.ticket.update((s) => ({
      ...DEFAULT_TICKET,
      accountId: s.accountId,
      mode: s.mode,
      direction: s.direction,
    }));
    this.ticketPreview.set(null);
  }
}

function isLong(direction: unknown): boolean {
  const d = String(direction).toLowerCase();
  return d.includes('buy') || d === 'long';
}
