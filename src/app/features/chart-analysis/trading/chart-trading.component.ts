import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { ChartHostComponent } from '../chart/chart-host.component';
import type { LiveQuote } from '../overlays/trade-layer';
import type { ManualTradePreview, ManualTradeResult } from './manual-trading.types';
import { OrderTicketComponent } from './order-ticket.component';
import {
  DEFAULT_TICKET,
  moveTicketLine,
  ticketEntry,
  ticketLines,
  type TicketPrefill,
  type TicketState,
} from './ticket-model';
import { TradeLinesPrimitive, type TradeLineMove } from './trade-lines-primitive';

/**
 * Trading from the chart (SP-I3 / SP-I4) in one place, so the page only places it: the order ticket and its brackets
 * as draggable lines on the price pane. The page passes the chart host, the symbol, its digits and pip, and the live
 * quote; it opens the ticket (toolbar "Trade", a position tool's "Stage…") through {@link open} / {@link prefill}.
 */
@Component({
  selector: 'app-chart-trading',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OrderTicketComponent],
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
    `,
  ],
})
export class ChartTradingComponent {
  /** The chart the lines hang on (the page's `#host`). */
  readonly host = input<ChartHostComponent | undefined>(undefined);
  readonly symbol = input.required<string>();
  readonly precision = input(5);
  readonly pipSize = input(0.0001);
  readonly quote = input<LiveQuote | null>(null);
  /** The ticket is open (the toolbar's "Trade" toggles it). */
  readonly open = model(false);
  /** Open the ticket with these values (a position tool's "Stage…", DR-I9); null = nothing to apply. */
  readonly prefill = input<TicketPrefill | null>(null);

  /** A ticket went through (paper opened or live signal created): the page refreshes its trade layers. */
  readonly submitted = output<ManualTradeResult>();

  readonly ticket = signal<TicketState>({ ...DEFAULT_TICKET });
  readonly ticketPreview = signal<ManualTradePreview | null>(null);

  private readonly lines = new TradeLinesPrimitive(
    () => this.precision(),
    (move) => this.onLineMoved(move),
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

  constructor() {
    effect((onCleanup) => {
      const host = this.host();
      if (!host) return;
      onCleanup(host.attachPricePrimitive(this.lines));
    });
    effect(() => this.lines.setLines(this.ticketBrackets()));

    // A new symbol is a new ticket: brackets priced for EURUSD mean nothing on USDJPY.
    effect(() => {
      this.symbol();
      untracked(() => {
        const s = this.ticket();
        this.ticket.set({ ...DEFAULT_TICKET, accountId: s.accountId, mode: s.mode });
        this.ticketPreview.set(null);
      });
    });

    // "Stage…" (DR-I9): the position tool's side and levels, at a price, in paper — nothing is sent until Submit.
    effect(() => {
      const pf = this.prefill();
      if (!pf) return;
      untracked(() => {
        const s = this.ticket();
        this.ticket.set({
          ...s,
          direction: pf.direction,
          atMarket: pf.entry === null,
          entry: pf.entry,
          stop: pf.stop,
          target: pf.target,
          mode: 'Paper',
        });
        this.open.set(true);
      });
    });
  }

  private onLineMoved(move: TradeLineMove): void {
    if (move.line.kind.startsWith('ticket'))
      this.ticket.update((s) => moveTicketLine(s, move.line.kind, move.price));
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
