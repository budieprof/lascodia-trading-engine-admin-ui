import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';

import type { LiveQuote } from '../overlays/trade-layer';
import { ManualTradingService } from './manual-trading.service';
import type {
  ManualTradePreview,
  ManualTradeResult,
  TicketDirection,
  TicketMode,
} from './manual-trading.types';
import {
  defaultBrackets,
  firstRefusal,
  flipBrackets,
  stopGuardProblem,
  ticketEntry,
  ticketRequest,
  type TicketState,
} from './ticket-model';
import { roundPrice } from './trade-lines';

/** How long after the last change the ticket asks the engine for a new preview. */
const PREVIEW_DEBOUNCE_MS = 350;
/** While open and idle, the preview is re-read this often (the market moves; so do lots, spread and gates). */
const PREVIEW_REFRESH_MS = 10_000;

/**
 * The chart's order ticket (SP-I4): Buy / Sell on the chart symbol for ONE account, at market or at a price, with a
 * stop and a target the operator can also drag on the chart. Every change asks the engine for a dry run
 * (`trade-signal/preview`): lots from the account's risk profile, risk and reward in money, spread, swap, the exposure
 * after the trade, and every check the live path runs, each with its reason. Paper is the default; Live needs a second,
 * explicit click naming the account and the size. Submitting sends a manual SIGNAL — the engine judges it again, and a
 * live one then goes through Tier 1 and Tier 2 like any signal.
 */
@Component({
  selector: 'app-order-ticket',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <section
      class="ticket"
      role="dialog"
      aria-modal="false"
      aria-label="Order ticket"
      data-testid="order-ticket"
    >
      <header class="ticket-head">
        <strong>{{ symbol() }}</strong>
        <span class="ticket-sub">manual order</span>
        <button
          type="button"
          class="ticket-x"
          (click)="closed.emit()"
          aria-label="Close the ticket"
        >
          ×
        </button>
      </header>

      <label class="ticket-row">
        <span>Account</span>
        <select
          [value]="state().accountId ?? ''"
          (change)="setAccount($any($event.target).value)"
          data-testid="ticket-account"
        >
          @if (state().accountId === null) {
            <option value="">Choose an account</option>
          }
          @for (a of accounts(); track a.id) {
            <option [value]="a.id">
              {{ a.accountName || a.accountId }} · {{ a.accountId }} · {{ a.accountType }}
            </option>
          }
        </select>
      </label>

      <div class="ticket-sides" role="group" aria-label="Direction">
        <button
          type="button"
          class="side buy"
          [class.on]="state().direction === 'Buy'"
          (click)="setDirection('Buy')"
          data-testid="ticket-buy"
        >
          Buy {{ quote()?.ask ?? quote()?.bid | number: digitsFormat() }}
        </button>
        <button
          type="button"
          class="side sell"
          [class.on]="state().direction === 'Sell'"
          (click)="setDirection('Sell')"
          data-testid="ticket-sell"
        >
          Sell {{ quote()?.bid | number: digitsFormat() }}
        </button>
      </div>

      <div class="ticket-row">
        <span>Entry</span>
        <label class="inline"
          ><input
            type="radio"
            name="entry-kind"
            [checked]="state().atMarket"
            (change)="setAtMarket(true)"
          />
          Market</label
        >
        <label class="inline"
          ><input
            type="radio"
            name="entry-kind"
            [checked]="!state().atMarket"
            (change)="setAtMarket(false)"
          />
          At price</label
        >
        @if (!state().atMarket) {
          <input
            class="price"
            type="number"
            [step]="step()"
            [value]="state().entry ?? ''"
            (change)="setPrice('entry', $any($event.target).value)"
            aria-label="Entry price"
          />
        }
      </div>
      <label class="ticket-row">
        <span>Stop loss</span>
        <input
          class="price"
          type="number"
          [step]="step()"
          [value]="state().stop ?? ''"
          (change)="setPrice('stop', $any($event.target).value)"
          data-testid="ticket-stop"
        />
        @if ((preview()?.stopPips ?? null) !== null) {
          <small
            >{{ preview()!.stopPips | number: '1.1-1' }} pips ·
            {{ preview()!.atr?.stopInAtr | number: '1.2-2' }} ATR</small
          >
        }
      </label>
      <label class="ticket-row">
        <span>Take profit</span>
        <input
          class="price"
          type="number"
          [step]="step()"
          [value]="state().target ?? ''"
          (change)="setPrice('target', $any($event.target).value)"
          data-testid="ticket-target"
        />
        @if ((preview()?.targetPips ?? null) !== null) {
          <small>{{ preview()!.targetPips | number: '1.1-1' }} pips</small>
        }
      </label>
      @if (guardProblem(); as problem) {
        <p class="ticket-warn" data-testid="ticket-guard">{{ problem }}</p>
      }

      <div class="ticket-row" role="group" aria-label="Mode">
        <span>Mode</span>
        <label class="inline"
          ><input
            type="radio"
            name="mode"
            [checked]="state().mode === 'Paper'"
            (change)="setMode('Paper')"
          />
          Paper</label
        >
        <label class="inline"
          ><input
            type="radio"
            name="mode"
            [checked]="state().mode === 'Live'"
            (change)="setMode('Live')"
            data-testid="ticket-live"
          />
          Live</label
        >
      </div>

      @if (preview(); as p) {
        <dl class="ticket-facts" data-testid="ticket-facts">
          <dt>Size</dt>
          <dd>
            @if (p.lotsAfterRiskCheck !== null) {
              {{ p.lotsAfterRiskCheck }} lots
            } @else if (p.lots !== null) {
              {{ p.lots }} lots (before the account risk check)
            } @else {
              —
            }
            @if (p.account.riskProfileName) {
              <small>{{ p.account.riskProfileName }}</small>
            }
          </dd>
          <dt>Risk</dt>
          <dd>
            @if (p.riskMoney !== null) {
              {{ p.riskMoney | number: '1.2-2' }} {{ p.account.currency }} ({{
                p.riskPctOfEquity | number: '1.2-2'
              }}% of equity)
            } @else {
              —
            }
          </dd>
          @if (p.rewardMoney !== null) {
            <dt>Reward</dt>
            <dd>
              {{ p.rewardMoney | number: '1.2-2' }} {{ p.account.currency }}
              @if (p.rewardRisk !== null) {
                · {{ p.rewardRisk | number: '1.2-2' }}R
              }
            </dd>
          }
          @if (p.quote) {
            <dt>Spread</dt>
            <dd>{{ p.quote.spreadPips | number: '1.1-1' }} pips</dd>
          }
          @if ((p.swap?.perNight ?? null) !== null) {
            <dt>Swap / night</dt>
            <dd>{{ p.swap!.perNight | number: '1.2-2' }} {{ p.account.currency }}</dd>
          }
          @if (p.exposure) {
            <dt>{{ p.symbol }} after</dt>
            <dd>{{ p.exposure.symbolNetLots }} → {{ p.exposure.symbolNetLotsAfter }} lots net</dd>
          }
        </dl>
        <ul class="ticket-gates" data-testid="ticket-gates">
          @for (g of p.gates; track g.key) {
            <li
              [class.fail]="!g.passed && g.blocking"
              [class.info]="!g.passed && !g.blocking"
              [title]="g.detail"
            >
              <span class="mark">{{ g.passed ? '✓' : g.blocking ? '✕' : '!' }}</span>
              <span class="gate-name">{{ g.name }}</span>
              @if (!g.passed) {
                <span class="gate-detail">{{ g.detail }}</span>
              }
            </li>
          }
        </ul>
        @for (n of p.notes; track n) {
          <p class="ticket-note">{{ n }}</p>
        }
      } @else if (loading()) {
        <p class="ticket-note">Checking the ticket…</p>
      }
      @if (previewError(); as e) {
        <p class="ticket-warn">{{ e }}</p>
      }

      <footer class="ticket-foot">
        @if (confirmLive(); as c) {
          <p class="ticket-live-warn" data-testid="ticket-live-confirm">
            Live {{ c.direction }} {{ c.lots }} lots {{ symbol() }} on {{ c.accountType }} account
            {{ c.account }}. {{ c.accountType === 'Real' ? 'Real money.' : '' }} The engine checks
            it again, then Tier 1 and the account risk check.
          </p>
          <button type="button" (click)="confirmLive.set(null)">Back</button>
          <button
            type="button"
            class="submit live"
            [disabled]="submitting()"
            (click)="submit()"
            data-testid="ticket-confirm"
          >
            Send live order
          </button>
        } @else {
          <button
            type="button"
            class="submit"
            [class.buy]="state().direction === 'Buy'"
            [class.sell]="state().direction === 'Sell'"
            [disabled]="!canSubmit()"
            [title]="submitBlockedReason() ?? ''"
            (click)="askSubmit()"
            data-testid="ticket-submit"
          >
            {{ state().mode === 'Paper' ? 'Paper' : 'Live' }} {{ state().direction }}
            @if ((preview()?.lotsAfterRiskCheck ?? null) !== null) {
              {{ preview()!.lotsAfterRiskCheck }}
            }
          </button>
          @if (submitBlockedReason(); as why) {
            <p class="ticket-why" data-testid="ticket-why">{{ why }}</p>
          }
        }
      </footer>
    </section>
  `,
  styles: [
    `
      /* The dock around the ticket lets clicks fall through to the chart (pointer-events: none) and the ticket
         takes them back HERE: the dock's ".ticket-dock > *" rule is scoped to chart-trading's view and never
         matched this component's section, so every control on the ticket was unclickable. */
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
      .inline {
        display: inline-flex;
        gap: 3px;
        align-items: center;
      }
      .price {
        width: 96px;
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
      .ticket-gates {
        list-style: none;
        padding: 0;
        margin: 4px 0;
      }
      .ticket-gates li {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
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
      .gate-detail {
        flex-basis: 100%;
        padding-left: 16px;
        opacity: 0.9;
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
      .ticket-live-warn {
        color: #f9a825;
        margin: 4px 0;
      }
      .ticket-foot {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .submit {
        flex: 1;
        padding: 7px;
        border-radius: 4px;
        border: 0;
        color: #fff;
        background: #546e7a;
        cursor: pointer;
      }
      .submit.buy {
        background: #26a69a;
      }
      .submit.sell {
        background: #ef5350;
      }
      .submit.live {
        background: #e65100;
      }
      .submit:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    `,
  ],
})
export class OrderTicketComponent {
  private readonly trading = inject(ManualTradingService);
  private readonly scope = inject(AccountScopeService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly symbol = input.required<string>();
  readonly precision = input(5);
  readonly pipSize = input(0.0001);
  readonly quote = input<LiveQuote | null>(null);
  /** The ticket's own state, two-way: the page moves its brackets when they are dragged on the chart. */
  readonly state = model.required<TicketState>();

  readonly closed = output<void>();
  readonly submitted = output<ManualTradeResult>();
  /** The latest dry run (the page labels the chart brackets with it). */
  readonly previewChange = output<ManualTradePreview | null>();

  readonly preview = signal<ManualTradePreview | null>(null);
  readonly previewError = signal<string | null>(null);
  readonly loading = signal(false);
  readonly submitting = signal(false);
  readonly confirmLive = signal<{
    direction: TicketDirection;
    lots: number;
    account: string;
    accountType: string;
  } | null>(null);

  /** Accounts a ticket can be for: those with a live EA (paper tickets too — they are priced on that account). */
  readonly accounts = computed(() => {
    const live = this.scope.liveAccounts();
    return live.length > 0 ? live : this.scope.accounts();
  });

  readonly digitsFormat = computed(() => `1.${this.precision()}-${this.precision()}`);
  readonly step = computed(() => 10 ** -Math.max(0, this.precision()));
  private readonly entry = computed(() => ticketEntry(this.state(), this.quote()));

  /** The guard, as the chart applies it before asking (the engine applies it again). */
  readonly guardProblem = computed(() => {
    const p = this.preview();
    const s = this.state();
    return stopGuardProblem(
      s.direction,
      this.entry(),
      s.stop,
      p?.atr?.value ?? null,
      p?.atr?.minStopMultiple ?? 1,
      this.precision(),
    );
  });

  readonly submitBlockedReason = computed(() => {
    if (this.state().accountId === null) return 'Choose the account the ticket is for.';
    if (this.guardProblem()) return this.guardProblem();
    const p = this.preview();
    if (!p) return this.loading() ? null : 'Waiting for the engine to check the ticket.';
    return firstRefusal(p.gates)?.detail ?? p.refusedReason;
  });

  readonly canSubmit = computed(
    () =>
      !this.submitting() &&
      !this.loading() &&
      !!this.preview()?.canSubmit &&
      !this.submitBlockedReason(),
  );

  constructor() {
    // Default account: the scope's single account, else the only live one.
    effect(() => {
      const s = this.state();
      if (s.accountId !== null) return;
      const id =
        this.scope.effectiveSelectedId() ??
        (this.accounts().length === 1 ? this.accounts()[0].id : null);
      if (id !== null) untracked(() => this.state.set({ ...s, accountId: id }));
    });

    // Every change: a fresh dry run, debounced; a reply for an older ticket is dropped.
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect((onCleanup) => {
      const request = ticketRequest(this.state(), this.symbol());
      this.confirmLive.set(null);
      if (!request) return;
      timer = setTimeout(() => this.runPreview(), PREVIEW_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });
    const refresh = setInterval(() => {
      if (!this.submitting() && !this.confirmLive()) this.runPreview();
    }, PREVIEW_REFRESH_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(refresh);
      clearTimeout(timer);
      this.previewChange.emit(null);
    });
  }

  private seq = 0;
  private runPreview(): void {
    const request = ticketRequest(this.state(), this.symbol());
    if (!request) return;
    const seq = ++this.seq;
    this.loading.set(true);
    this.trading
      .preview(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.seq) return;
          this.loading.set(false);
          if (!res?.status || !res.data) {
            this.preview.set(null);
            this.previewError.set(res?.message || 'The engine could not check the ticket.');
            this.previewChange.emit(null);
            return;
          }
          this.previewError.set(null);
          this.preview.set(res.data);
          this.previewChange.emit(res.data);
          this.applyDefaultBrackets(res.data);
        },
        error: () => {
          if (seq !== this.seq) return;
          this.loading.set(false);
          this.previewError.set('The engine did not answer the ticket check.');
        },
      });
  }

  /** The first answer with an ATR places a stop the guard accepts (1.5 ATR) and a 2R target, if none is set. */
  private applyDefaultBrackets(p: ManualTradePreview): void {
    const s = this.state();
    if (s.stop !== null || s.target !== null || !p.atr || !(p.entry > 0)) return;
    const b = defaultBrackets(s.direction, p.entry, p.atr.value, this.precision());
    if (b) this.state.set({ ...s, stop: b.stop, target: b.target });
  }

  setAccount(raw: string): void {
    const id = Number(raw);
    this.state.update((s) => ({ ...s, accountId: Number.isFinite(id) && id > 0 ? id : null }));
  }

  setDirection(direction: TicketDirection): void {
    const s = this.state();
    if (s.direction === direction) return;
    const entry = this.entry();
    const flipped =
      entry !== null
        ? flipBrackets(entry, s.stop, s.target, this.precision())
        : { stop: null, target: null };
    this.state.set({ ...s, direction, ...flipped });
  }

  setAtMarket(atMarket: boolean): void {
    this.state.update((s) => ({
      ...s,
      atMarket,
      entry: atMarket ? s.entry : (s.entry ?? this.entry()),
    }));
  }

  setMode(mode: TicketMode): void {
    this.state.update((s) => ({ ...s, mode }));
  }

  setPrice(field: 'entry' | 'stop' | 'target', raw: string): void {
    const v = Number(raw);
    const price =
      raw === '' || !Number.isFinite(v) || v <= 0 ? null : roundPrice(v, this.precision());
    this.state.update((s) => ({ ...s, [field]: price }));
  }

  /** Paper submits at once; Live asks once more, naming the account and the size. */
  askSubmit(): void {
    const p = this.preview();
    if (!this.canSubmit() || !p) return;
    if (this.state().mode === 'Live') {
      this.confirmLive.set({
        direction: p.direction,
        lots: p.lotsAfterRiskCheck ?? p.lots ?? 0,
        account: p.account.accountId,
        accountType: p.account.accountType,
      });
      return;
    }
    this.submit();
  }

  submit(): void {
    const request = ticketRequest(this.state(), this.symbol());
    if (!request || this.submitting()) return;
    this.submitting.set(true);
    this.trading
      .submit(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.confirmLive.set(null);
          if (res?.status && res.data) {
            this.notify.success(res.data.message || res.message || 'Ticket sent.');
            this.submitted.emit(res.data);
            return;
          }
          // Refused: show the engine's judgement (it re-ran every check) and keep the ticket.
          if (res?.data?.preview) {
            this.preview.set(res.data.preview);
            this.previewChange.emit(res.data.preview);
          }
          this.notify.error(res?.message || 'The ticket was refused.');
        },
        error: () => {
          this.submitting.set(false);
          this.notify.error('The ticket was not sent — the engine did not answer.');
        },
      });
  }
}
