import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
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
import {
  confirmLines,
  defaultExecutionAccount,
  defaultTradingAccount,
  fourEyesNotice,
  sendBlockedReason,
  sendOutcome,
  sendRequestOf,
  signalLink,
  switchesOff,
  venueAccountsOf,
  venueTradingAccountIds,
  type SendOutcome,
} from './venue-ticket-send';

const PREVIEW_DEBOUNCE_MS = 350;

/**
 * The exchange-traded order ticket (multi-asset WS7 7.5): futures, crypto (spot and derivatives) and equities. The
 * quantity is in the instrument's own unit (contracts / shares / coins) on its step, prices sit on its tick grid, the
 * bracket is set in ticks, and the controls follow the instrument: TIF, post-only, reduce-only (derivatives), leverage
 * and margin mode (crypto derivatives). Every change asks the engine for a dry run
 * (`execution-console/ticket/preview`): notional, margin and liquidation from the risk models, risk and reward at the
 * bracket, the fee estimate from the fee schedule, and each check with its reason.
 *
 * Send (ticket-send; engine `POST trade-signal/venue-ticket`, `access.trader`) goes through a confirm step that shows the
 * order as it will be sent plus the four-eyes notice, and is disabled — with the engine's own reason — while
 * `Execution:Router/Entries` or `Risk:MultiAsset` is off, no Active venue account of the chosen trading account is
 * picked, or the dry run fails. The engine creates a manual signal with the venue terms: Tier 1, then the venue entry
 * path (Tier 2 + Risk:MultiAsset) places it; this ticket never talks to a venue itself. FX / CFD symbols never open this
 * ticket (they keep `app-order-ticket`, unchanged).
 */
@Component({
  selector: 'app-venue-order-ticket',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ModalA11yDirective, RouterLink],
  template: `
    <section
      class="ticket"
      role="dialog"
      aria-modal="false"
      aria-label="Exchange order ticket"
      data-testid="venue-order-ticket"
      appModalA11y
      [appModalA11yTrap]="false"
      (dismiss)="close()"
    >
      <header class="ticket-head">
        <strong>{{ instrument().symbol }}</strong>
        <span class="ticket-sub">{{ kindLabel() }} · {{ instrument().exchange || '' }}</span>
        <button
          type="button"
          class="ticket-x"
          (click)="close()"
          aria-label="Close the ticket"
          data-autofocus
        >
          ×
        </button>
      </header>

      <div class="ticket-row">
        <span>Trading acct</span>
        <select
          [value]="tradingAccountId() ?? ''"
          (change)="setTradingAccount($any($event.target).value)"
          aria-label="Trading account"
          data-testid="venue-ticket-trading-account"
        >
          <option value="">
            {{ tradingAccounts().length ? '— choose —' : '— no venue accounts —' }}
          </option>
          @for (t of tradingAccounts(); track t.id) {
            <option [value]="t.id" [selected]="t.id === tradingAccountId()">{{ t.label }}</option>
          }
        </select>
      </div>
      <div class="ticket-row">
        <span>Venue acct</span>
        <select
          [value]="state().executionAccountId ?? ''"
          (change)="setAccount($any($event.target).value)"
          aria-label="Execution account"
          data-testid="venue-ticket-account"
        >
          <option value="">— none (no account figures) —</option>
          @for (a of venueAccounts(); track a.id) {
            <option [value]="a.id" [selected]="a.id === state().executionAccountId">
              {{ a.name }} · {{ a.adapterKind }} ({{ a.mode }}, {{ a.status }})
            </option>
          }
        </select>
      </div>

      <div class="ticket-sides">
        <button
          type="button"
          class="side buy"
          [class.on]="state().side === 'Buy'"
          (click)="patch({ side: 'Buy' })"
        >
          Buy
        </button>
        <button
          type="button"
          class="side sell"
          [class.on]="state().side === 'Sell'"
          (click)="patch({ side: 'Sell' })"
        >
          Sell
        </button>
      </div>

      <div class="ticket-row">
        <span>Type</span>
        <select
          [value]="state().orderType"
          (change)="patch({ orderType: $any($event.target).value })"
          aria-label="Order type"
        >
          @for (t of orderTypes; track t) {
            <option [value]="t" [selected]="t === state().orderType">
              {{ t === 'StopLimit' ? 'Stop limit' : t }}
            </option>
          }
        </select>
        <select
          [value]="state().tif"
          (change)="patch({ tif: $any($event.target).value })"
          aria-label="Time in force"
        >
          @for (t of tifs(); track t) {
            <option [value]="t" [selected]="t === state().tif">{{ t.toUpperCase() }}</option>
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
        }}{{ instrument().maxQuantity ? ', max ' + instrument().maxQuantity : '' }} · tick
        {{ instrument().tickSize }} = {{ instrument().tickValue }}
        {{ instrument().quoteCurrency }} per {{ unitOne() }}
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
            <input
              type="checkbox"
              [checked]="state().postOnly"
              (change)="patch({ postOnly: $any($event.target).checked })"
            />
            Post-only
          </label>
        }
        @if (derivative()) {
          <label class="inline">
            <input
              type="checkbox"
              [checked]="state().reduceOnly"
              (change)="patch({ reduceOnly: $any($event.target).checked })"
            />
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
          <select
            [value]="state().marginMode ?? ''"
            (change)="setMarginMode($any($event.target).value)"
            aria-label="Margin mode"
          >
            <option value="">{{ preview()?.accountMarginMode ?? 'Account' }} (account)</option>
            <option value="Isolated" [selected]="state().marginMode === 'Isolated'">
              Isolated
            </option>
            <option value="Cross" [selected]="state().marginMode === 'Cross'">Cross</option>
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
        <span class="muted">{{
          brackets().stopLoss === null ? '' : (brackets().stopLoss | number: fmt())
        }}</span>
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
        <span class="muted">{{
          brackets().takeProfit === null ? '' : (brackets().takeProfit | number: fmt())
        }}</span>
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
          <dd>
            {{ pv.referencePrice === null ? '—' : (pv.referencePrice | number: fmt()) }}
            <span class="muted">({{ pv.referencePriceSource }})</span>
          </dd>
          <dt>Notional</dt>
          <dd>
            {{ pv.notionalQuote === null ? '—' : (pv.notionalQuote | number: '1.0-2') }}
            {{ pv.quoteCurrency }}
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
                {{ m.initialMargin | number: '1.0-2' }} initial ·
                {{ m.maintenanceMargin | number: '1.0-2' }} maint. {{ pv.accountCurrency
                }}{{ m.leverage ? ' · ' + (m.leverage | number: '1.0-2') + '×' : '' }}
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
              }}{{
                pv.riskPctOfEquity !== null
                  ? ' (' + (pv.riskPctOfEquity | number: '1.0-2') + ' % of equity)'
                  : ''
              }}
            </dd>
          }
          @if (pv.rewardMoney !== null) {
            <dt>Reward</dt>
            <dd>{{ pv.rewardMoney | number: '1.2-2' }} {{ pv.accountCurrency }}</dd>
          }
          <dt>Fees</dt>
          <dd>
            {{ pv.feeEstimate === null ? '—' : (pv.feeEstimate | number: '1.2-4')
            }}<span class="muted">{{ pv.feeBasis ? ' · ' + pv.feeBasis : '' }}</span>
          </dd>
          <dt>Session</dt>
          <dd>
            {{ pv.sessionOpen ? 'open' : 'closed'
            }}{{ pv.sessionKind ? ' (' + pv.sessionKind + ')' : '' }}
          </dd>
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
        @if (confirm(); as c) {
          <div class="ticket-confirm" data-testid="venue-ticket-confirm-step" #confirmStep>
            <strong>Send this order?</strong>
            <dl class="ticket-facts">
              @for (l of c.lines; track l.label) {
                <dt>{{ l.label }}</dt>
                <dd>{{ l.value }}</dd>
              }
            </dl>
            @if (c.live) {
              <p class="ticket-warn">LIVE venue account: a real order at {{ c.venue }}.</p>
            }
            <p class="ticket-note" data-testid="venue-ticket-four-eyes">{{ c.fourEyes }}</p>
            <p class="ticket-note">
              The engine checks the ticket again, then Tier 1 and the venue entry path (account risk
              check incl. Risk:MultiAsset) place it. Tier 2 may reduce the quantity.
            </p>
            <div class="confirm-actions">
              <button
                type="button"
                class="btn-back"
                (click)="confirming.set(false)"
                [disabled]="submitting()"
                data-autofocus
              >
                Back
              </button>
              <button
                type="button"
                class="btn-submit go"
                [class.buy]="state().side === 'Buy'"
                [class.sell]="state().side === 'Sell'"
                [disabled]="submitting()"
                (click)="send()"
                data-testid="venue-ticket-confirm"
              >
                {{
                  submitting()
                    ? 'Sending…'
                    : 'Send ' + state().side + ' ' + state().quantity + ' ' + unit()
                }}
              </button>
            </div>
          </div>
        } @else {
          <button
            type="button"
            class="btn-submit"
            [class.ready]="!blockedReason()"
            [class.buy]="state().side === 'Buy'"
            [class.sell]="state().side === 'Sell'"
            [disabled]="!!blockedReason()"
            [title]="blockedReason() ?? ''"
            (click)="askSend()"
            data-testid="venue-ticket-submit"
          >
            {{ state().side }} {{ state().quantity }} {{ unit() }}
          </button>
          @if (blockedReason(); as why) {
            <p class="ticket-why" data-testid="venue-ticket-why">{{ why }}</p>
          }
        }
        @if (result(); as r) {
          <p
            class="ticket-result"
            [class.bad]="r.kind === 'refused'"
            data-testid="venue-ticket-result"
            role="status"
          >
            {{ r.message }}
            @if (r.kind === 'placed' && r.tradeSignalId !== null) {
              <a [routerLink]="signalRoute(r.tradeSignalId)">Open signal {{ r.tradeSignalId }}</a>
            }
          </p>
        }
        <p class="ticket-note">
          Send creates a manual signal: Tier 1, then the venue entry path (Tier 2 + Risk:MultiAsset)
          places it at the venue. Leverage and margin mode here are preview-only — the account's
          configured values apply.
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
      .ticket-foot .btn-submit.ready,
      .ticket-foot .btn-submit.go {
        opacity: 1;
        cursor: pointer;
        color: #fff;
      }
      .ticket-foot .btn-submit.ready.buy,
      .ticket-foot .btn-submit.go.buy {
        background: #26a69a;
      }
      .ticket-foot .btn-submit.ready.sell,
      .ticket-foot .btn-submit.go.sell {
        background: #ef5350;
      }
      .ticket-foot .btn-submit:disabled {
        cursor: not-allowed;
      }
      .ticket-confirm {
        border: 1px solid var(--border-1, #363a45);
        border-radius: 4px;
        padding: 6px;
      }
      .confirm-actions {
        display: flex;
        gap: 6px;
      }
      .confirm-actions .btn-back {
        flex: 0 0 auto;
        padding: 6px 10px;
        border-radius: 4px;
        border: 1px solid var(--border-1, #363a45);
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .ticket-result {
        margin: 6px 0 2px;
      }
      .ticket-result a {
        color: var(--accent, #2962ff);
        margin-left: 4px;
      }
    `,
  ],
})
export class VenueOrderTicketComponent {
  private readonly api = inject(VenuesApiService);
  private readonly auth = inject(AuthService);
  private readonly scope = inject(AccountScopeService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly instrument = input.required<InstrumentDto>();
  readonly quote = input<LiveQuote | null>(null);
  /** A ladder click / chart prefill (side, type, price); applied when it changes. */
  readonly prefill = input<{
    side: VenueSide;
    orderType: VenueOrderType;
    price: number | null;
    seq: number;
  } | null>(null);
  readonly closed = output<void>();
  private readonly confirmStep = viewChild<ElementRef<HTMLElement>>('confirmStep');

  protected readonly orderTypes: VenueOrderType[] = ['Market', 'Limit', 'Stop', 'StopLimit'];

  readonly state = signal<VenueTicketState>(
    defaultVenueTicket({
      symbol: '',
      assetClass: 'Future',
      exchange: null,
      description: null,
      quoteCurrency: null,
      tickSize: 1,
      tickValue: 1,
      multiplier: 1,
      quantityUnit: 'Contracts',
      quantityStep: 1,
      minQuantity: 1,
      maxQuantity: 0,
      priceDecimals: 2,
      displayDistance: 'Ticks',
      tradingCalendarCode: null,
      status: null,
    }),
  );
  readonly accounts = signal<ExecutionAccount[]>([]);
  readonly preview = signal<VenueTicketPreview | null>(null);
  readonly previewError = signal<string | null>(null);
  readonly loading = signal(false);
  /** The trading account whose venue execution accounts the picker offers. */
  readonly tradingAccountId = signal<number | null>(null);
  /** `execution-console/health` switches (null = not read: the engine alone says whether they are on). */
  readonly switches = signal<Record<string, string> | null>(null);
  readonly confirming = signal(false);
  readonly submitting = signal(false);
  readonly result = signal<SendOutcome | null>(null);
  private readonly canSend = computed(() => this.auth.hasPermission(Permission.AccessTrader));

  readonly tradingAccounts = computed(() => {
    const names = new Map(this.scope.accounts().map((a) => [a.id, a]));
    return venueTradingAccountIds(this.accounts()).map((id) => {
      const t = names.get(id);
      return {
        id,
        label: t
          ? `${t.accountName || t.accountId || id} · ${id} · ${t.accountType}`
          : `Trading account ${id}`,
      };
    });
  });
  readonly venueAccounts = computed(() =>
    venueAccountsOf(this.accounts(), this.tradingAccountId()),
  );
  readonly selectedAccount = computed(
    () => this.venueAccounts().find((a) => a.id === this.state().executionAccountId) ?? null,
  );
  /** The ticket as the engine would receive it; a preview counts only for the key it was computed for. */
  private readonly ticketKey = computed(() =>
    JSON.stringify(previewRequestOf(this.instrument().symbol, this.state())),
  );
  private readonly previewKey = signal<string | null>(null);
  /** The dry run of THIS ticket (never a stale one of an earlier edit, shown while the new one loads). */
  private readonly currentPreview = computed(() =>
    this.previewKey() === this.ticketKey() ? this.preview() : null,
  );
  readonly blockedReason = computed(() =>
    sendBlockedReason({
      canSend: this.canSend(),
      off: switchesOff(this.switches(), this.preview()?.multiAssetRiskEnabled ?? null),
      account: this.selectedAccount(),
      problems: this.problems(),
      preview: this.currentPreview(),
      loading:
        this.loading() || (this.previewKey() !== this.ticketKey() && this.previewError() === null),
      submitting: this.submitting(),
    }),
  );
  readonly confirm = computed(() => {
    const pv = this.currentPreview();
    const acct = this.selectedAccount();
    if (!this.confirming() || !pv || !acct) return null;
    return {
      lines: confirmLines(this.instrument().symbol, this.unit(), this.state(), pv, acct),
      fourEyes: fourEyesNotice(pv),
      live: acct.mode === 'Live',
      venue: acct.venue,
    };
  });

  readonly kind = computed(() => venueKindOf(this.instrument()));
  readonly derivative = computed(
    () => this.kind() === 'future' || this.kind() === 'crypto-derivative',
  );
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
  readonly step = computed(() =>
    this.instrument().quantityStep > 0 ? this.instrument().quantityStep : 1,
  );
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
    return bracketPrices(
      entry,
      s.side,
      this.instrument().tickSize,
      s.stopLossTicks,
      s.takeProfitTicks,
      this.instrument().priceDecimals,
    );
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastKey: string | null = null;

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
    // A re-commit of the same values (an input's change event on blur, as the Send button is pressed) is not a change.
    effect(() => {
      const s = this.state();
      const inst = this.instrument();
      const bad = this.problems().length > 0;
      const key = this.ticketKey();
      untracked(() => {
        if (key === this.lastKey) return;
        this.lastKey = key;
        // A changed ticket is a different order: the confirm step (if open) belonged to the previous one.
        this.confirming.set(false);
        this.schedulePreview(inst.symbol, s, bad);
      });
    });
    // The picker starts on the scope's trading account (or the only one with venue accounts) and its only Active one.
    effect(() => {
      const accounts = this.accounts();
      const scoped = this.scope.effectiveSelectedId();
      untracked(() => {
        if (this.tradingAccountId() === null)
          this.tradingAccountId.set(defaultTradingAccount(accounts, scoped));
        if (this.state().executionAccountId === null) {
          const id = defaultExecutionAccount(accounts, this.tradingAccountId());
          if (id !== null) this.patch({ executionAccountId: id });
        }
      });
    });
    if (this.auth.hasPermission(Permission.AccountsRead)) {
      this.api
        .accounts()
        .subscribe({ next: (a) => this.accounts.set(a), error: () => this.accounts.set([]) });
      this.api.health().subscribe({
        next: (h) => this.switches.set(h?.switches ?? {}),
        error: () => this.switches.set(null),
      });
    }
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

  setTradingAccount(v: string): void {
    const id = v ? Number(v) : null;
    this.tradingAccountId.set(id);
    this.patch({ executionAccountId: defaultExecutionAccount(this.accounts(), id) });
  }

  /** × or Escape — never mid-send: the engine's answer must reach the operator. */
  close(): void {
    if (!this.submitting()) this.closed.emit();
  }

  /** The first press opens the confirm step; nothing is sent from one click. */
  askSend(): void {
    if (this.blockedReason()) return;
    this.result.set(null);
    this.confirming.set(true);
    // The ticket scrolls; bring the confirm step (and its Send button) into view once it is rendered.
    setTimeout(() => this.confirmStep()?.nativeElement.scrollIntoView?.({ block: 'nearest' }));
  }

  send(): void {
    const body = sendRequestOf(this.instrument().symbol, this.state());
    if (!body || this.submitting() || !this.confirming()) return;
    this.submitting.set(true);
    this.api
      .sendTicket(body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.confirming.set(false);
          const out = sendOutcome(res);
          this.result.set(out);
          if (out.kind === 'placed') {
            this.notify.success(
              out.message,
              out.tradeSignalId !== null
                ? {
                    label: `Open signal ${out.tradeSignalId}`,
                    route: signalLink(out.tradeSignalId),
                  }
                : undefined,
            );
            // The levels belonged to the order just sent; the account choice stays.
            const keep = this.state().executionAccountId;
            this.state.set({
              ...defaultVenueTicket(this.instrument(), this.state().side),
              executionAccountId: keep,
            });
          } else if (out.kind === 'refused') {
            if (out.preview) {
              this.preview.set(out.preview);
              this.previewKey.set(this.ticketKey());
            }
            this.notify.error(out.message);
          }
          // 'approval': the approval interceptor already announced it (one toast, not two).
        },
        error: (e) => {
          this.submitting.set(false);
          this.confirming.set(false);
          const message = errorText(e, 'The ticket was not sent — the engine did not answer.');
          this.result.set({ kind: 'refused', message, code: null, preview: null });
          this.notify.error(message);
        },
      });
  }

  signalRoute(id: number): string {
    return signalLink(id);
  }

  setQuantity(v: string): void {
    const inst = this.instrument();
    this.patch({
      quantity: snapQuantity(Number(v), this.step(), inst.minQuantity, inst.maxQuantity),
    });
  }

  setPrice(field: 'price' | 'stopPrice', v: string): void {
    const n = Number(v);
    this.patch({
      [field]:
        v === '' || !(n > 0)
          ? null
          : snapPrice(n, this.instrument().tickSize, this.instrument().priceDecimals),
    });
  }

  fromQuote(field: 'price' | 'stopPrice'): void {
    const q = this.quote();
    if (!q) return;
    const p = this.state().side === 'Buy' ? (q.ask ?? q.bid) : q.bid;
    this.patch({
      [field]: snapPrice(p, this.instrument().tickSize, this.instrument().priceDecimals),
    });
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
      const request = previewRequestOf(symbol, s);
      const key = JSON.stringify(request);
      this.api.previewTicket(request).subscribe({
        next: (pv) => {
          if (mine !== this.generation) return;
          this.preview.set(pv);
          this.previewKey.set(key);
          this.previewError.set(null);
          this.loading.set(false);
        },
        error: (e) => {
          if (mine !== this.generation) return;
          this.preview.set(null);
          this.previewKey.set(null);
          this.previewError.set(errorText(e, 'The engine could not preview this ticket.'));
          this.loading.set(false);
        },
      });
    }, PREVIEW_DEBOUNCE_MS);
  }
}
