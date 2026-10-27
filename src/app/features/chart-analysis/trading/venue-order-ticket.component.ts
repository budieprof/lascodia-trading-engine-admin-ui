import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { VenuesApiService } from '@features/venues/venues-api.service';
import { unitWord } from '@features/venues/venues.logic';
import type {
  ExecutionAccount,
  MarginMode,
  VenueOrderType,
  VenueTicketPreview,
  VenueTif,
} from '@features/venues/venues.types';

import type { LiveQuote } from '../overlays/trade-layer';
import {
  bracketPrices,
  defaultVenueTicket,
  patchVenueTicket,
  prefillPatch,
  previewRequestOf,
  snapPrice,
  snapQuantity,
  stepDecimals,
  ticketEntry,
  tifChoices,
  venueKindOf,
  venueTicketProblems,
  type VenueSide,
  type VenueTicketState,
} from './venue-ticket-model';

const PREVIEW_DEBOUNCE_MS = 350;

/**
 * The exchange-traded order ticket (multi-asset WS7 7.5): futures, crypto (spot and derivatives) and equities. The
 * quantity is in the instrument's own unit (contracts / shares / coins) on its step, prices sit on its tick grid, the
 * bracket is set in ticks, and the controls follow the instrument: TIF, post-only, reduce-only (derivatives), leverage
 * and margin mode (crypto derivatives). Every change asks the engine for a dry run
 * (`execution-console/ticket/preview`): notional, margin and liquidation from the risk models, risk and reward at the
 * bracket, the fee estimate from the fee schedule, and each check with its reason.
 *
 * It never sends an order: venue entries reach a venue only through the engine's signal → Tier 2 → instruction path
 * (exec-core, `Execution:Entries:Enabled`), which this ticket does not bypass — the foot says so. FX / CFD symbols never
 * open this ticket (they keep `app-order-ticket`, unchanged).
 */
@Component({
  selector: 'app-venue-order-ticket',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ModalA11yDirective],
  template: `
    <section
      class="ticket"
      role="dialog"
      aria-modal="false"
      aria-label="Exchange order ticket"
      data-testid="venue-order-ticket"
      appModalA11y
      [appModalA11yTrap]="false"
      (dismiss)="closed.emit()"
    >
      <header class="ticket-head">
        <strong>{{ instrument().symbol }}</strong>
        <span class="ticket-sub">{{ kindLabel() }} · {{ instrument().exchange || '' }}</span>
        <button type="button" class="ticket-x" (click)="closed.emit()" aria-label="Close the ticket" data-autofocus>
          ×
        </button>
      </header>

      <div class="ticket-row">
        <span>Account</span>
        <select
          [value]="state().executionAccountId ?? ''"
          (change)="setAccount($any($event.target).value)"
          aria-label="Execution account"
          data-testid="venue-ticket-account"
        >
          <option value="">— any (no account figures) —</option>
          @for (a of accounts(); track a.id) {
            <option [value]="a.id">{{ a.name }} · {{ a.adapterKind }} ({{ a.mode }}, {{ a.status }})</option>
          }
        </select>
      </div>

      <div class="ticket-sides">
        <button type="button" class="side buy" [class.on]="state().side === 'Buy'" (click)="patch({ side: 'Buy' })">
          Buy
        </button>
        <button type="button" class="side sell" [class.on]="state().side === 'Sell'" (click)="patch({ side: 'Sell' })">
          Sell
        </button>
      </div>

      <div class="ticket-row">
        <span>Type</span>
        <select [value]="state().orderType" (change)="patch({ orderType: $any($event.target).value })" aria-label="Order type">
          @for (t of orderTypes; track t) {
            <option [value]="t">{{ t === 'StopLimit' ? 'Stop limit' : t }}</option>
          }
        </select>
        <select [value]="state().tif" (change)="patch({ tif: $any($event.target).value })" aria-label="Time in force">
          @for (t of tifs(); track t) {
            <option [value]="t">{{ t.toUpperCase() }}</option>
          }
        </select>
      </div>

      <div class="ticket-row">
        <span>Quantity</span>
        <input
          class="qty"
          type="number"
          [step]="step()"
          [min]="instrument().minQuantity || step()"
          [value]="state().quantity"
          (change)="setQuantity($any($event.target).value)"
          aria-label="Quantity"
          data-testid="venue-ticket-qty"
        />
        <span class="unit">{{ unit() }}</span>
      </div>
      <p class="ticket-note">
        Step {{ step() }}{{ instrument().minQuantity ? ', min ' + instrument().minQuantity : ''
        }}{{ instrument().maxQuantity ? ', max ' + instrument().maxQuantity : '' }} · tick {{ instrument().tickSize }} =
        {{ instrument().tickValue }} {{ instrument().quoteCurrency }} per {{ unitOne() }}
      </p>

      @if (state().orderType === 'Limit' || state().orderType === 'StopLimit') {
        <div class="ticket-row">
          <span>Limit</span>
          <input
            class="price"
            type="number"
            [step]="instrument().tickSize"
            [value]="state().price ?? ''"
            (change)="setPrice('price', $any($event.target).value)"
            aria-label="Limit price"
          />
          <button type="button" class="mini" (click)="fromQuote('price')">quote</button>
        </div>
      }
      @if (state().orderType === 'Stop' || state().orderType === 'StopLimit') {
        <div class="ticket-row">
          <span>Trigger</span>
          <input
            class="price"
            type="number"
            [step]="instrument().tickSize"
            [value]="state().stopPrice ?? ''"
            (change)="setPrice('stopPrice', $any($event.target).value)"
            aria-label="Trigger price"
          />
          <button type="button" class="mini" (click)="fromQuote('stopPrice')">quote</button>
        </div>
      }

      <div class="ticket-row">
        @if (state().orderType === 'Limit') {
          <label class="inline">
            <input type="checkbox" [checked]="state().postOnly" (change)="patch({ postOnly: $any($event.target).checked })" />
            Post-only
          </label>
        }
        @if (derivative()) {
          <label class="inline">
            <input type="checkbox" [checked]="state().reduceOnly" (change)="patch({ reduceOnly: $any($event.target).checked })" />
            Reduce-only
          </label>
        }
      </div>

      @if (kind() === 'crypto-derivative') {
        <div class="ticket-row">
          <span>Leverage</span>
          <input
            class="lev"
            type="number"
            min="1"
            max="500"
            step="1"
            [value]="state().leverage ?? ''"
            [placeholder]="preview()?.accountLeverage ?? 'account'"
            (change)="setLeverage($any($event.target).value)"
            aria-label="Leverage"
          />
          <select [value]="state().marginMode ?? ''" (change)="setMarginMode($any($event.target).value)" aria-label="Margin mode">
            <option value="">{{ preview()?.accountMarginMode ?? 'Account' }} (account)</option>
            <option value="Isolated">Isolated</option>
            <option value="Cross">Cross</option>
          </select>
        </div>
      }

      <div class="ticket-row">
        <span>Stop (ticks)</span>
        <input
          class="ticks"
          type="number"
          min="1"
          step="1"
          [value]="state().stopLossTicks ?? ''"
          (change)="setTicks('stopLossTicks', $any($event.target).value)"
          aria-label="Stop loss in ticks"
        />
        <span class="muted">{{ brackets().stopLoss === null ? '' : (brackets().stopLoss | number: fmt()) }}</span>
      </div>
      <div class="ticket-row">
        <span>Target (ticks)</span>
        <input
          class="ticks"
          type="number"
          min="1"
          step="1"
          [value]="state().takeProfitTicks ?? ''"
          (change)="setTicks('takeProfitTicks', $any($event.target).value)"
          aria-label="Take profit in ticks"
        />
        <span class="muted">{{ brackets().takeProfit === null ? '' : (brackets().takeProfit | number: fmt()) }}</span>
      </div>

      @for (p of problems(); track p) {
        <p class="ticket-warn">{{ p }}</p>
      }

      @if (previewError(); as e) {
        <p class="ticket-why" role="alert">{{ e }}</p>
      }
      @if (preview(); as pv) {
        <dl class="ticket-facts" data-testid="venue-ticket-preview">
          <dt>Price</dt>
          <dd>{{ pv.referencePrice === null ? '—' : (pv.referencePrice | number: fmt()) }} <span class="muted">({{ pv.referencePriceSource }})</span></dd>
          <dt>Notional</dt>
          <dd>
            {{ pv.notionalQuote === null ? '—' : (pv.notionalQuote | number: '1.0-2') }} {{ pv.quoteCurrency }}
            @if (pv.notionalAccount !== null && pv.accountCurrency !== pv.quoteCurrency) {
              ({{ pv.notionalAccount | number: '1.0-2' }} {{ pv.accountCurrency }})
            }
          </dd>
          @if (pv.margin; as m) {
            <dt>Margin</dt>
            <dd>
              @if (m.refusal) {
                <span class="bad">refused: {{ m.refusal }}</span>
              } @else {
                {{ m.initialMargin | number: '1.0-2' }} initial · {{ m.maintenanceMargin | number: '1.0-2' }} maint.
                {{ pv.accountCurrency }}{{ m.leverage ? ' · ' + (m.leverage | number: '1.0-2') + '×' : '' }}
              }
            </dd>
            @if (m.liquidationPrice !== null) {
              <dt>Liquidation</dt>
              <dd>{{ m.liquidationPrice | number: fmt() }}</dd>
            }
          }
          @if (pv.riskMoney !== null) {
            <dt>Risk at stop</dt>
            <dd>
              {{ pv.riskMoney | number: '1.2-2' }} {{ pv.accountCurrency
              }}{{ pv.riskPctOfEquity !== null ? ' (' + (pv.riskPctOfEquity | number: '1.0-2') + ' % of equity)' : '' }}
            </dd>
          }
          @if (pv.rewardMoney !== null) {
            <dt>Reward</dt>
            <dd>{{ pv.rewardMoney | number: '1.2-2' }} {{ pv.accountCurrency }}</dd>
          }
          <dt>Fees</dt>
          <dd>{{ pv.feeEstimate === null ? '—' : (pv.feeEstimate | number: '1.2-4') }}<span class="muted">{{ pv.feeBasis ? ' · ' + pv.feeBasis : '' }}</span></dd>
          <dt>Session</dt>
          <dd>{{ pv.sessionOpen ? 'open' : 'closed' }}{{ pv.sessionKind ? ' (' + pv.sessionKind + ')' : '' }}</dd>
        </dl>
        <ul class="ticket-gates">
          @for (c of pv.checks; track c.name) {
            <li [class.fail]="!c.ok && c.blocking" [class.info]="!c.ok && !c.blocking">
              <span class="mark">{{ c.ok ? '✓' : c.blocking ? '✗' : '!' }}</span>
              <span class="gate-detail">{{ c.message }}</span>
            </li>
          }
        </ul>
        @for (n of pv.notes; track n) {
          <p class="ticket-note">{{ n }}</p>
        }
      } @else if (loading()) {
        <p class="ticket-note">Asking the engine…</p>
      }

      <footer class="ticket-foot">
        <button type="button" class="btn-submit" disabled title="Not wired in this build" data-testid="venue-ticket-submit">
          {{ state().side }} {{ state().quantity }} {{ unit() }}
        </button>
        <p class="ticket-note">
          Preview only. Venue orders are entered by the engine's signal path (Tier 2 risk, then the venue adapter) once
          venue entries are switched on; this ticket checks size, prices, margin and fees but sends nothing.
        </p>
      </footer>
    </section>
  `,
  styles: [
    `
      .ticket {
        pointer-events: auto;
        width: 300px;
        max-height: calc(100% - 16px);
        overflow-y: auto;
        background: var(--surface-1, #1e222d);
        color: var(--text-1, #d1d4dc);
        border: 1px solid var(--border-1, #363a45);
        border-radius: 6px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
        padding: 8px 10px;
        font-size: 12px;
      }
      .ticket-head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 6px;
      }
      .ticket-sub {
        opacity: 0.7;
        flex: 1;
      }
      .ticket-x {
        background: none;
        border: 0;
        color: inherit;
        font-size: 16px;
        cursor: pointer;
      }
      .ticket-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin: 4px 0;
      }
      .ticket-row > span:first-child {
        width: 72px;
        opacity: 0.8;
      }
      .ticket-row select {
        flex: 1;
        min-width: 0;
      }
      .qty,
      .price {
        width: 96px;
      }
      .ticks,
      .lev {
        width: 64px;
      }
      .unit,
      .muted {
        opacity: 0.7;
      }
      .mini {
        font-size: 11px;
        padding: 1px 6px;
        background: transparent;
        color: inherit;
        border: 1px solid var(--border-1, #363a45);
        border-radius: 3px;
        cursor: pointer;
      }
      .inline {
        display: inline-flex;
        gap: 3px;
        align-items: center;
      }
      .ticket-sides {
        display: flex;
        gap: 6px;
        margin: 6px 0;
      }
      .side {
        flex: 1;
        padding: 6px;
        border-radius: 4px;
        border: 1px solid var(--border-1, #363a45);
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .side.buy.on {
        background: #26a69a;
        color: #fff;
      }
      .side.sell.on {
        background: #ef5350;
        color: #fff;
      }
      .ticket-facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 8px;
        margin: 6px 0;
      }
      .ticket-facts dt {
        opacity: 0.7;
      }
      .ticket-facts dd {
        margin: 0;
      }
      .bad {
        color: #ef5350;
      }
      .ticket-gates {
        list-style: none;
        padding: 0;
        margin: 4px 0;
      }
      .ticket-gates li {
        display: flex;
        gap: 4px;
        padding: 1px 0;
      }
      .ticket-gates .mark {
        width: 12px;
        color: #26a69a;
      }
      .ticket-gates li.fail .mark,
      .ticket-gates li.fail .gate-detail {
        color: #ef5350;
      }
      .ticket-gates li.info .mark,
      .ticket-gates li.info .gate-detail {
        color: #f9a825;
      }
      .ticket-warn,
      .ticket-why {
        color: #ef5350;
        margin: 4px 0;
      }
      .ticket-note {
        opacity: 0.8;
        margin: 4px 0;
      }
      .ticket-foot .btn-submit {
        width: 100%;
        padding: 6px;
        border-radius: 4px;
        border: 1px solid var(--border-1, #363a45);
        background: transparent;
        color: inherit;
        opacity: 0.6;
      }
    `,
  ],
})
export class VenueOrderTicketComponent {
  private readonly api = inject(VenuesApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly instrument = input.required<InstrumentDto>();
  readonly quote = input<LiveQuote | null>(null);
  /** A ladder click / chart prefill (side, type, price); applied when it changes. */
  readonly prefill = input<{ side: VenueSide; orderType: VenueOrderType; price: number | null; seq: number } | null>(null);
  readonly closed = output<void>();

  protected readonly orderTypes: VenueOrderType[] = ['Market', 'Limit', 'Stop', 'StopLimit'];

  readonly state = signal<VenueTicketState>(defaultVenueTicket({
    symbol: '', assetClass: 'Future', exchange: null, description: null, quoteCurrency: null, tickSize: 1, tickValue: 1,
    multiplier: 1, quantityUnit: 'Contracts', quantityStep: 1, minQuantity: 1, maxQuantity: 0, priceDecimals: 2,
    displayDistance: 'Ticks', tradingCalendarCode: null, status: null,
  }));
  readonly accounts = signal<ExecutionAccount[]>([]);
  readonly preview = signal<VenueTicketPreview | null>(null);
  readonly previewError = signal<string | null>(null);
  readonly loading = signal(false);

  readonly kind = computed(() => venueKindOf(this.instrument()));
  readonly derivative = computed(() => this.kind() === 'future' || this.kind() === 'crypto-derivative');
  readonly kindLabel = computed(() => {
    switch (this.kind()) {
      case 'future':
        return 'futures';
      case 'crypto-spot':
        return 'crypto spot';
      case 'crypto-derivative':
        return 'crypto perpetual';
      default:
        return this.instrument().assetClass === 'Etf' ? 'ETF' : 'equity';
    }
  });
  readonly step = computed(() => (this.instrument().quantityStep > 0 ? this.instrument().quantityStep : 1));
  readonly unit = computed(() => unitWord(this.instrument().quantityUnit, this.state().quantity));
  readonly unitOne = computed(() => unitWord(this.instrument().quantityUnit, 1));
  readonly tifs = computed<VenueTif[]>(() => tifChoices(this.state().orderType));
  readonly fmt = computed(() => {
    const d = Math.max(this.instrument().priceDecimals, stepDecimals(this.instrument().tickSize));
    return `1.${d}-${d}`;
  });
  readonly problems = computed(() => venueTicketProblems(this.state(), this.instrument()));
  readonly brackets = computed(() => {
    const s = this.state();
    const q = this.quote();
    const entry = ticketEntry(s, q ? { bid: q.bid, ask: q.ask } : null);
    if (entry === null) return { stopLoss: null, takeProfit: null };
    return bracketPrices(entry, s.side, this.instrument().tickSize, s.stopLossTicks, s.takeProfitTicks, this.instrument().priceDecimals);
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor() {
    // A new instrument is a new ticket.
    effect(() => {
      const inst = this.instrument();
      untracked(() => {
        const keep = this.state().executionAccountId;
        this.state.set({ ...defaultVenueTicket(inst), executionAccountId: keep });
        this.preview.set(null);
      });
    });
    effect(() => {
      const pf = this.prefill();
      if (!pf) return;
      untracked(() => this.patch(prefillPatch(this.instrument(), pf)));
    });
    // Every change of the ticket asks for a new dry run (debounced); a ticket with shape problems is not sent.
    effect(() => {
      const s = this.state();
      const inst = this.instrument();
      const bad = this.problems().length > 0;
      untracked(() => this.schedulePreview(inst.symbol, s, bad));
    });
    if (this.auth.hasPermission(Permission.AccountsRead))
      this.api.accounts().subscribe({ next: (a) => this.accounts.set(a), error: () => this.accounts.set([]) });
    this.destroyRef.onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  patch(p: Partial<VenueTicketState>): void {
    this.state.update((s) => patchVenueTicket(s, p));
  }

  setAccount(v: string): void {
    this.patch({ executionAccountId: v ? Number(v) : null });
  }

  setQuantity(v: string): void {
    const inst = this.instrument();
    this.patch({ quantity: snapQuantity(Number(v), this.step(), inst.minQuantity, inst.maxQuantity) });
  }

  setPrice(field: 'price' | 'stopPrice', v: string): void {
    const n = Number(v);
    this.patch({ [field]: v === '' || !(n > 0) ? null : snapPrice(n, this.instrument().tickSize, this.instrument().priceDecimals) });
  }

  fromQuote(field: 'price' | 'stopPrice'): void {
    const q = this.quote();
    if (!q) return;
    const p = this.state().side === 'Buy' ? (q.ask ?? q.bid) : q.bid;
    this.patch({ [field]: snapPrice(p, this.instrument().tickSize, this.instrument().priceDecimals) });
  }

  setTicks(field: 'stopLossTicks' | 'takeProfitTicks', v: string): void {
    const n = Math.round(Number(v));
    this.patch({ [field]: v === '' || !(n > 0) ? null : n });
  }

  setLeverage(v: string): void {
    const n = Number(v);
    this.patch({ leverage: v === '' || !(n >= 1) ? null : Math.min(500, n) });
  }

  setMarginMode(v: string): void {
    this.patch({ marginMode: v === 'Isolated' || v === 'Cross' ? (v as MarginMode) : null });
  }

  private schedulePreview(symbol: string, s: VenueTicketState, bad: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    const mine = ++this.generation;
    if (bad || !this.auth.hasPermission(Permission.OrdersCreate)) {
      this.loading.set(false);
      if (!bad) this.previewError.set('The dry run needs the orders.create permission.');
      return;
    }
    this.timer = setTimeout(() => {
      this.loading.set(true);
      this.api.previewTicket(previewRequestOf(symbol, s)).subscribe({
        next: (pv) => {
          if (mine !== this.generation) return;
          this.preview.set(pv);
          this.previewError.set(null);
          this.loading.set(false);
        },
        error: (e) => {
          if (mine !== this.generation) return;
          this.preview.set(null);
          this.previewError.set(errorText(e, 'The engine could not preview this ticket.'));
          this.loading.set(false);
        },
      });
    }, PREVIEW_DEBOUNCE_MS);
  }
}
