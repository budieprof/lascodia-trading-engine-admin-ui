import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { StrategiesService } from '@core/services/strategies.service';
import { MarketDataService } from '@core/services/market-data.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CreateTradeSignalRequest,
  CurrencyPairDto,
  LivePriceDto,
  StrategyDto,
} from '@core/api/api.types';
import {
  ATR_CANDLES,
  ATR_PERIOD,
  ATR_STOP_MULTIPLE,
  REWARD_MULTIPLE,
  atrFromCandles,
  atrLevels,
  atrTimeframe,
  orderStrategies,
  pipSizeFor,
  roundTo,
} from './signal-defaults';

/** Values to open the dialog with (e.g. from a hand-entered order the operator is replacing with a signal). */
export interface SignalPrefill {
  symbol?: string | null;
  direction?: 'Buy' | 'Sell' | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  lotSize?: number | null;
  strategyId?: number | null;
}

/**
 * Operator-facing form to hand-author a trade signal. Mirrors the subset of
 * `CreateTradeSignalCommand` an operator would actually fill in (the engine
 * leaves the ML scoring fields null for manual signals; the resulting signal
 * still flows through Pending → Approved/Rejected/Expired exactly like an
 * auto-generated one — the same risk checks, and the EA places it).
 *
 * SP-13 (2026-10-09): the operator picks the strategy the signal is credited to — there is no "auto-pick" that fell
 * back to the first active strategy and credited manual trades to an unrelated one — and the default stop is
 * 1.5 × ATR(14) of real closed candles (the strategy's timeframe, else H1) with the target at 2R, not a fixed 30 pips.
 */
@Component({
  selector: 'app-create-signal-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <!--
      Native <dialog> with showModal() renders in the browser top layer above
      every other DOM element regardless of parent transforms / stacking
      contexts / overflow:hidden chains. Replaces the previous CSS-only overlay
      that broke whenever a parent created a new containing block.
    -->
    <dialog
      #nativeDialog
      class="dialog"
      aria-labelledby="create-signal-title"
      (close)="onNativeDialogClose()"
      (click)="onBackdropClick($event)"
    >
      <div class="dialog-inner" role="document" (click)="$event.stopPropagation()">
        <header class="dialog-head">
          <div>
            <h3 id="create-signal-title">Create trade signal</h3>
            <p class="lede">
              Hand-author a signal — enters the queue as Pending and flows through the standard
              approval workflow.
            </p>
          </div>
          <button type="button" class="btn-close" (click)="cancel()" aria-label="Close">×</button>
        </header>

        <div class="dialog-body">
          <!-- Section 1: which strategy + which instrument ─────────────── -->
          <section class="form-section">
            <h4 class="section-title">Source</h4>
            <div class="row">
              <label class="field span-2">
                <span class="label">Strategy <span class="hint">credited with this trade</span></span>
                <select
                  [ngModel]="strategyId()"
                  (ngModelChange)="strategyId.set($event)"
                  name="strategyId"
                  required
                  data-testid="signal-strategy"
                >
                  <option [ngValue]="null" disabled>— choose the strategy this trade belongs to —</option>
                  @for (s of orderedStrategies(); track s.id) {
                    <option [ngValue]="s.id">
                      #{{ s.id }} · {{ s.symbol }} {{ s.timeframe }} · {{ s.name }}
                    </option>
                  }
                </select>
                @if (strategiesLoading()) {
                  <small class="muted">loading strategies…</small>
                } @else if (activeStrategies().length === 0) {
                  <small class="muted">No strategies available — create one first.</small>
                } @else if (strategyMismatch(); as m) {
                  <small class="warn-text">{{ m }}</small>
                }
              </label>

              <label class="field">
                <span class="label">Symbol</span>
                <input
                  type="text"
                  [(ngModel)]="symbol"
                  name="symbol"
                  placeholder="EURUSD"
                  maxlength="10"
                  list="signal-symbol-options"
                  autocomplete="off"
                  required
                />
                <datalist id="signal-symbol-options">
                  @for (p of symbolOptions(); track p) {
                    <option [value]="p"></option>
                  }
                </datalist>
              </label>
            </div>
          </section>

          <!-- Section 2: trade intent (direction + confidence + lot) ────── -->
          <section class="form-section">
            <h4 class="section-title">Intent</h4>
            <div class="row">
              <div class="field">
                <span class="label">Direction</span>
                <div class="direction-toggle" role="radiogroup" aria-label="Direction">
                  <button
                    type="button"
                    role="radio"
                    [attr.aria-checked]="direction() === 'Buy'"
                    [class.active]="direction() === 'Buy'"
                    [class.buy]="direction() === 'Buy'"
                    (click)="direction.set('Buy')"
                  >
                    ▲ Buy
                  </button>
                  <button
                    type="button"
                    role="radio"
                    [attr.aria-checked]="direction() === 'Sell'"
                    [class.active]="direction() === 'Sell'"
                    [class.sell]="direction() === 'Sell'"
                    (click)="direction.set('Sell')"
                  >
                    ▼ Sell
                  </button>
                </div>
              </div>

              <label class="field">
                <span class="label">Lot size</span>
                <input
                  type="number"
                  [(ngModel)]="lotSize"
                  name="lotSize"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>

              <label class="field">
                <span class="label">Confidence <span class="hint">0–1</span></span>
                <input
                  type="number"
                  [(ngModel)]="confidence"
                  name="confidence"
                  step="0.05"
                  min="0"
                  max="1"
                  required
                />
              </label>
            </div>
          </section>

          <!-- Section 3: price levels (entry + SL + TP) ──────────────────── -->
          <section class="form-section">
            <div class="section-head">
              <h4 class="section-title">Price levels</h4>
              @if (livePrice(); as p) {
                <span class="live-price-tag"> live · bid {{ p.bid }} · ask {{ p.ask }} </span>
              } @else if (priceFallback(); as f) {
                <span
                  class="live-price-tag"
                  title="No live tick stream — using last closed H1 candle close."
                >
                  fallback · last H1 close {{ f }}
                </span>
              } @else if (priceLoading()) {
                <span class="live-price-tag muted">fetching price…</span>
              } @else if (symbol().trim().length >= 6) {
                <span class="live-price-tag muted">no price data — enter manually</span>
              }
            </div>
            <div class="row">
              <label class="field">
                <span class="label">
                  Entry price
                  @if (!entryDirty() && entryPrice() !== null) {
                    <span class="hint">auto · {{ entrySource() }}</span>
                  }
                </span>
                <input
                  type="number"
                  [(ngModel)]="entryPrice"
                  name="entryPrice"
                  step="0.00001"
                  min="0"
                  required
                  (input)="entryDirty.set(true)"
                />
              </label>
              <label class="field">
                <span class="label">
                  Stop loss
                  @if (!slDirty() && stopLoss() !== null && atrHint(); as h) {
                    <span class="hint" [title]="h.title">auto · {{ h.text }}</span>
                  } @else {
                    <span class="hint">opt.</span>
                  }
                </span>
                <input
                  type="number"
                  [(ngModel)]="stopLoss"
                  name="stopLoss"
                  step="0.00001"
                  min="0"
                  (input)="slDirty.set(true)"
                />
              </label>
              <label class="field">
                <span class="label">
                  Take profit
                  @if (!tpDirty() && takeProfit() !== null && atrHint()) {
                    <span class="hint">auto · {{ rewardMultiple }}R</span>
                  } @else {
                    <span class="hint">opt.</span>
                  }
                </span>
                <input
                  type="number"
                  [(ngModel)]="takeProfit"
                  name="takeProfit"
                  step="0.00001"
                  min="0"
                  (input)="tpDirty.set(true)"
                />
              </label>
            </div>
            <div class="auto-actions">
              @switch (atrState().status) {
                @case ('loading') {
                  <small class="muted">reading {{ atrState().timeframe }} candles for the ATR…</small>
                }
                @case ('none') {
                  <small class="muted"
                    >No closed {{ atrState().timeframe }} candles for {{ symbol().toUpperCase() }} to size the stop
                    — enter it.</small
                  >
                }
              }
              <button type="button" class="btn-link" (click)="resetAutoCalc()">
                ↻ Reset to auto
              </button>
            </div>
            @if (sanityWarning(); as msg) {
              <div class="warn-banner">⚠ {{ msg }}</div>
            }
          </section>

          <!-- Section 4: expiry ────────────────────────────────────────── -->
          <section class="form-section">
            <h4 class="section-title">Expiry</h4>
            <label class="field">
              <span class="label">Expires at <span class="hint">local time, sent UTC</span></span>
              <input type="datetime-local" [(ngModel)]="expiresAtLocal" name="expiresAt" required />
              <small class="muted">{{ defaultExpiryHint() }}</small>
            </label>
          </section>
        </div>

        <footer class="dialog-foot">
          <button type="button" class="btn-secondary" (click)="cancel()" [disabled]="submitting()">
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            (click)="submit()"
            [disabled]="!canSubmit() || submitting()"
          >
            {{ submitting() ? 'Creating…' : 'Create signal' }}
          </button>
        </footer>
      </div>
    </dialog>
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      /* Native <dialog> opened with showModal() renders in the browser's top
       * layer above every stacking context. UA centers via margin:auto, but
       * Angular's ViewEncapsulation.Emulated can perturb the cascade order,
       * so we set the centering geometry explicitly via the :modal selector. */
      dialog.dialog {
        padding: 0;
        background: var(--bg-primary, #fff);
        border-radius: var(--radius-lg, 8px);
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.2));
        width: min(680px, 92vw);
        max-height: 86vh;
        border: 1px solid var(--border);
        color: var(--text-primary);
      }
      dialog.dialog:modal {
        position: fixed;
        inset: 0;
        margin: auto;
      }
      dialog.dialog::backdrop {
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(2px);
      }
      .dialog-inner {
        display: flex;
        flex-direction: column;
        max-height: inherit;
      }

      /* ── Header ──────────────────────────────────────────────────────── */
      .dialog-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .dialog-head h3 {
        margin: 0;
        font-size: var(--text-lg, 1.05rem);
        font-weight: var(--font-semibold, 600);
      }
      .lede {
        margin: 4px 0 0;
        color: var(--text-secondary);
        font-size: var(--text-xs, 0.78rem);
        line-height: 1.4;
      }
      .btn-close {
        background: transparent;
        border: none;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-secondary);
        padding: 0 4px;
      }
      .btn-close:hover {
        color: var(--text-primary);
      }

      /* ── Body / sections ─────────────────────────────────────────────── */
      .dialog-body {
        padding: var(--space-4) var(--space-5);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .form-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .section-title {
        margin: 0 0 2px;
        font-size: var(--text-xs, 0.72rem);
        font-weight: var(--font-semibold, 600);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
      }
      .warn-text {
        color: #92400e;
      }
      .live-price-tag {
        font-family: var(--font-mono, ui-monospace, Menlo, monospace);
        font-size: var(--text-xs, 0.72rem);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: 2px 6px;
        border-radius: 4px;
      }
      .auto-actions {
        margin-top: 4px;
        display: flex;
        justify-content: flex-end;
      }
      .btn-link {
        background: transparent;
        border: none;
        color: var(--accent, #0071e3);
        font-size: var(--text-xs, 0.78rem);
        cursor: pointer;
        padding: 0;
      }
      .btn-link:hover {
        text-decoration: underline;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .field.span-2 {
        grid-column: span 2;
      }
      .label {
        font-size: var(--text-xs, 0.78rem);
        color: var(--text-secondary);
        font-weight: var(--font-medium, 500);
      }
      .hint {
        color: var(--text-tertiary, #999);
        font-weight: 400;
        font-size: 0.92em;
      }
      .field input,
      .field select {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        min-width: 0;
      }
      .field input:focus,
      .field select:focus {
        outline: 2px solid var(--accent, #0071e3);
        outline-offset: -1px;
        border-color: transparent;
      }
      .field small.muted {
        color: var(--text-tertiary, #999);
        font-size: var(--text-xs, 0.72rem);
      }

      /* ── Direction toggle ─────────────────────────────────────────── */
      .direction-toggle {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-1, 4px);
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
      }
      .direction-toggle button {
        padding: 6px 8px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium, 500);
        font-size: var(--text-sm);
      }
      .direction-toggle button.active.buy {
        background: rgba(34, 197, 94, 0.18);
        color: #15803d;
      }
      .direction-toggle button.active.sell {
        background: rgba(239, 68, 68, 0.18);
        color: #b91c1c;
      }

      /* ── Warning banner ─────────────────────────────────────────── */
      .warn-banner {
        padding: var(--space-2) var(--space-3);
        background: rgba(245, 158, 11, 0.1);
        color: #92400e;
        border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs, 0.78rem);
      }

      /* ── Footer ──────────────────────────────────────────────────── */
      .dialog-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-5);
        border-top: 1px solid var(--border);
        background: var(--bg-secondary);
        border-radius: 0 0 var(--radius-lg, 8px) var(--radius-lg, 8px);
      }
      .btn-primary,
      .btn-secondary {
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        font: inherit;
        font-weight: var(--font-medium, 500);
        cursor: pointer;
        border: 1px solid var(--border);
      }
      .btn-secondary {
        background: var(--bg-primary, #fff);
        color: var(--text-primary);
      }
      .btn-primary {
        background: var(--accent, #0071e3);
        color: var(--accent-fg, #fff);
        border-color: var(--accent, #0071e3);
      }
      .btn-primary[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Mobile / narrow viewport: collapse 3-col rows to 1-col */
      @media (max-width: 560px) {
        .row {
          grid-template-columns: 1fr;
        }
        .field.span-2 {
          grid-column: span 1;
        }
      }
    `,
  ],
})
export class CreateSignalDialogComponent implements AfterViewInit, OnDestroy {
  private readonly tradeSignals = inject(TradeSignalsService);
  private readonly strategies = inject(StrategiesService);
  private readonly marketData = inject(MarketDataService);
  private readonly currencyPairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  // Reference to the native <dialog> element — used to call showModal() on
  // mount so the form renders in the browser's top layer (above every parent
  // stacking context). The previous CSS-only overlay broke whenever a parent
  // had `transform`, `filter`, or `contain`, which made `position: fixed`
  // behave like `position: absolute` relative to the parent instead of the
  // viewport.
  private readonly nativeDialog = viewChild.required<ElementRef<HTMLDialogElement>>('nativeDialog');

  // Outputs — parent decides whether to keep the dialog open or refresh the list.
  readonly closed = output<void>();
  readonly created = output<number>();
  /** Optional starting values (symbol, side, levels, lots, strategy). */
  readonly prefill = input<SignalPrefill | null>(null);

  readonly rewardMultiple = REWARD_MULTIPLE;

  // ── Form state ────────────────────────────────────────────────────────
  readonly strategyId = signal<number | null>(null);
  readonly symbol = signal<string>('');
  readonly direction = signal<'Buy' | 'Sell'>('Buy');
  readonly entryPrice = signal<number | null>(null);
  readonly stopLoss = signal<number | null>(null);
  readonly takeProfit = signal<number | null>(null);
  readonly lotSize = signal<number>(0.01);
  readonly confidence = signal<number>(0.6);
  readonly expiresAtLocal = signal<string>(this.defaultExpiryLocalIso());

  // ── User-mutated flags ───────────────────────────────────────────────
  // Set when the user types into the field — guards the auto-calc effects
  // so they don't clobber a value the operator has explicitly entered.
  readonly entryDirty = signal(false);
  readonly slDirty = signal(false);
  readonly tpDirty = signal(false);

  /** The ATR the default stop is sized from: reading, found, or no candles to size it. */
  readonly atrState = signal<{ status: 'idle' | 'loading' | 'ok' | 'none'; atr?: number; timeframe?: string }>({
    status: 'idle',
  });

  // ── Live-price state ─────────────────────────────────────────────────
  readonly livePrice = signal<LivePriceDto | null>(null);
  readonly livePriceLoading = signal(false);

  // Last closed H1 candle close — used as a fallback when no EA is streaming
  // ticks (markets closed / dev). Populated only when livePrice is null.
  readonly fallbackCandleClose = signal<number | null>(null);
  readonly fallbackLoading = signal(false);

  /** Convenience: did either source produce a usable price? */
  readonly priceLoading = computed(() => this.livePriceLoading() || this.fallbackLoading());
  readonly priceFallback = computed(() => (this.livePrice() ? null : this.fallbackCandleClose()));

  /** Human label for what the entry-price auto-default came from. */
  readonly entrySource = computed(() => (this.livePrice() ? 'live mid' : 'last H1 close'));

  // ── Async loading state ──────────────────────────────────────────────
  readonly submitting = signal(false);
  readonly strategiesLoading = signal(true);
  readonly strategies_ = signal<StrategyDto[]>([]);
  readonly currencyPairs = signal<CurrencyPairDto[]>([]);

  /** Active currency-pair symbols feeding the symbol input's datalist. */
  readonly symbolOptions = computed<string[]>(() => {
    const fromPairs = this.currencyPairs()
      .filter((p) => p.isActive && !!p.symbol)
      .map((p) => (p.symbol as string).toUpperCase());
    if (fromPairs.length > 0) return fromPairs;
    // Fallback: derive symbols from active strategies if currency-pair list
    // didn't load (e.g. legacy backend without /currency-pair endpoint).
    return Array.from(
      new Set(
        this.activeStrategies()
          .map((s) => (s.symbol ?? '').toUpperCase())
          .filter((s) => s.length > 0),
      ),
    );
  });

  readonly activeStrategies = computed(() => this.strategies_());

  /** The symbol's strategies first, then the rest — the operator chooses; nothing is picked for them. */
  readonly orderedStrategies = computed(() => orderStrategies(this.activeStrategies(), this.symbol()));

  readonly resolvedStrategy = computed(() => {
    const id = this.strategyId();
    return id === null ? null : (this.activeStrategies().find((s) => s.id === id) ?? null);
  });

  /** A strategy that trades another symbol can be credited, but the operator is told. */
  readonly strategyMismatch = computed<string | null>(() => {
    const s = this.resolvedStrategy();
    const sym = this.symbol().trim().toUpperCase();
    if (!s?.symbol || !sym || s.symbol.toUpperCase() === sym) return null;
    return `Strategy #${s.id} trades ${s.symbol.toUpperCase()}; this ${sym} signal will be credited to it.`;
  });

  /** The pair's decimal places (prices are rounded to them), 5 until the pair is known. */
  readonly digits = computed(() => {
    const sym = this.symbol().trim().toUpperCase();
    const pair = this.currencyPairs().find((p) => (p.symbol ?? '').toUpperCase() === sym);
    return pair && pair.decimalPlaces > 0 ? pair.decimalPlaces : 5;
  });

  /** The stop's auto label: `1.5 × ATR(14, H1) = 23.4 pips`. */
  readonly atrHint = computed<{ text: string; title: string } | null>(() => {
    const st = this.atrState();
    if (st.status !== 'ok' || st.atr === undefined) return null;
    const pips = Math.round(((st.atr * ATR_STOP_MULTIPLE) / pipSizeFor(this.digits())) * 10) / 10;
    return {
      text: `${ATR_STOP_MULTIPLE} × ATR(${ATR_PERIOD}, ${st.timeframe}) = ${pips} pips`,
      title: `ATR(${ATR_PERIOD}) of the last closed ${st.timeframe} candles: ${roundTo(st.atr, this.digits() + 1)}`,
    };
  });

  readonly defaultExpiryHint = computed(() => {
    const local = this.expiresAtLocal();
    if (!local) return '';
    const utc = new Date(local).toISOString();
    return `→ sent as ${utc}`;
  });

  readonly canSubmit = computed(() => {
    return (
      this.strategyId() !== null &&
      !!this.symbol().trim() &&
      this.entryPrice() !== null &&
      (this.entryPrice() ?? 0) > 0 &&
      this.lotSize() > 0 &&
      this.confidence() >= 0 &&
      this.confidence() <= 1 &&
      !!this.expiresAtLocal()
    );
  });

  /** Soft warnings that don't block submission but call out unusual inputs. */
  readonly sanityWarning = computed<string | null>(() => {
    const dir = this.direction();
    const e = this.entryPrice();
    const sl = this.stopLoss();
    const tp = this.takeProfit();

    if (e === null) return null;

    if (sl !== null) {
      if (dir === 'Buy' && sl >= e) return 'Buy stop loss should be below entry price.';
      if (dir === 'Sell' && sl <= e) return 'Sell stop loss should be above entry price.';
    }
    if (tp !== null) {
      if (dir === 'Buy' && tp <= e) return 'Buy take profit should be above entry price.';
      if (dir === 'Sell' && tp >= e) return 'Sell take profit should be below entry price.';
    }
    return null;
  });

  constructor() {
    // Starting values, applied once when given; entered levels are kept as the operator's own.
    effect(() => {
      const p = this.prefill();
      if (!p) return;
      untracked(() => {
        if (p.symbol) this.symbol.set(p.symbol.toUpperCase());
        if (p.direction) this.direction.set(p.direction);
        if (p.lotSize && p.lotSize > 0) this.lotSize.set(p.lotSize);
        if (p.strategyId) this.strategyId.set(p.strategyId);
        if (p.entryPrice && p.entryPrice > 0) {
          this.entryPrice.set(p.entryPrice);
          this.entryDirty.set(true);
        }
        if (p.stopLoss && p.stopLoss > 0) {
          this.stopLoss.set(p.stopLoss);
          this.slDirty.set(true);
        }
        if (p.takeProfit && p.takeProfit > 0) {
          this.takeProfit.set(p.takeProfit);
          this.tpDirty.set(true);
        }
      });
    });

    // Load active strategies once on mount; the picker needs them.
    this.strategies
      .list({ currentPage: 1, itemCountPerPage: 500, filter: { status: 'Active' } })
      .pipe(
        catchError(() => {
          // Fall back to all strategies if the status filter isn't honoured.
          return this.strategies.list({ currentPage: 1, itemCountPerPage: 500 });
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.strategiesLoading.set(false);
        if (res?.data?.data) this.strategies_.set(res.data.data);
      });

    // When the operator picks a strategy, prefill the symbol so they don't
    // have to retype it. They can still override.
    effect(() => {
      const s = this.resolvedStrategy();
      if (s?.symbol && !this.symbol()) {
        this.symbol.set(s.symbol);
      }
    });

    // ── Load currency pairs once for the symbol datalist ─────────────────
    this.currencyPairsService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (res?.data?.data) this.currencyPairs.set(res.data.data);
      });

    // ── Live-price fetch on symbol change, with candle fallback ─────────
    // Symbol must be at least 6 chars (e.g. EURUSD) before we hit the API.
    // If the live-price cache has nothing for the symbol (status -14, no EA
    // streaming) we fall back to the last closed H1 candle's close so the
    // entry/SL/TP auto-fill still works during dev / market closures.
    effect(() => {
      const sym = this.symbol().trim().toUpperCase();
      if (sym.length < 6) {
        this.livePrice.set(null);
        this.fallbackCandleClose.set(null);
        return;
      }
      this.livePrice.set(null);
      this.fallbackCandleClose.set(null);
      this.livePriceLoading.set(true);
      this.marketData
        .getLivePrice(sym)
        .pipe(
          catchError(() => of(null)),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe((res) => {
          this.livePriceLoading.set(false);
          if (res?.data) {
            this.livePrice.set(res.data);
            return;
          }
          // No live tick — try last closed H1 candle close.
          this.fallbackLoading.set(true);
          this.marketData
            .getLatestCandle(sym, 'H1')
            .pipe(
              catchError(() => of(null)),
              takeUntilDestroyed(this.destroyRef),
            )
            .subscribe((cres) => {
              this.fallbackLoading.set(false);
              if (cres?.data?.close != null) {
                this.fallbackCandleClose.set(Number(cres.data.close));
              }
            });
        });
    });

    // ── Default entry price from whichever source has data ──────────────
    // Prefers live mid; falls back to last H1 candle close. Skipped once
    // the operator types into the entry field (entryDirty).
    effect(() => {
      if (this.entryDirty()) return;
      const lp = this.livePrice();
      const digits = this.digits();
      if (lp) {
        this.entryPrice.set(roundTo((lp.bid + lp.ask) / 2, digits));
        return;
      }
      const fb = this.fallbackCandleClose();
      if (fb != null) {
        this.entryPrice.set(roundTo(fb, digits));
      }
    });

    // ── ATR of real closed candles: the strategy's timeframe, else H1 ────
    effect((onCleanup) => {
      const sym = this.symbol().trim().toUpperCase();
      const tf = atrTimeframe(this.resolvedStrategy());
      if (sym.length < 6) {
        this.atrState.set({ status: 'idle' });
        return;
      }
      untracked(() => this.atrState.set({ status: 'loading', timeframe: tf }));
      const sub = this.marketData
        .listCandles(
          { currentPage: 1, itemCountPerPage: ATR_CANDLES, filter: { symbol: sym, timeframe: tf } },
          { silent: true },
        )
        .pipe(catchError(() => of(null)))
        .subscribe((res) => {
          const value = atrFromCandles(res?.data?.data ?? []);
          this.atrState.set(value === null ? { status: 'none', timeframe: tf } : { status: 'ok', atr: value, timeframe: tf });
        });
      onCleanup(() => sub.unsubscribe());
    });

    // ── Auto SL/TP: 1.5 × ATR beyond the entry, target 2R ────────────────
    // Re-runs when the entry, the side or the ATR changes; skipped per field
    // once the operator types. No ATR → no default (never a made-up distance).
    effect(() => {
      const e = this.entryPrice();
      const dir = this.direction();
      const st = this.atrState();
      const digits = this.digits();
      if (e === null || e <= 0 || st.status !== 'ok' || st.atr === undefined) return;
      const levels = atrLevels(e, dir, st.atr, digits);
      if (!untracked(() => this.slDirty())) this.stopLoss.set(levels.stopLoss);
      if (!untracked(() => this.tpDirty())) this.takeProfit.set(levels.takeProfit);
    });
  }

  ngAfterViewInit(): void {
    // Open the native dialog as a true modal — top layer, blocks page input.
    const el = this.nativeDialog().nativeElement;
    if (typeof el.showModal === 'function' && !el.open) {
      el.showModal();
    }
  }

  ngOnDestroy(): void {
    // Defensive close in case the parent removes us without an explicit cancel.
    const el = this.nativeDialog?.()?.nativeElement;
    if (el?.open) el.close();
  }

  /**
   * Backdrop click: native <dialog>'s backdrop click event lands on the
   * dialog element itself (not on a child). Treat that as cancel.
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.nativeDialog().nativeElement) {
      this.cancel();
    }
  }

  /**
   * Fired by the dialog's native `close` event — escape key, programmatic
   * close, etc. Surfaces the cancel back to the parent.
   */
  onNativeDialogClose(): void {
    this.closed.emit();
  }

  cancel(): void {
    if (this.submitting()) return;
    const el = this.nativeDialog().nativeElement;
    if (el.open)
      el.close(); // triggers (close) → onNativeDialogClose
    else this.closed.emit();
  }

  /**
   * Wipe the entry/SL/TP fields and clear the dirty flags so the auto-calc
   * effects re-run from the latest live price.
   */
  resetAutoCalc(): void {
    this.entryDirty.set(false);
    this.slDirty.set(false);
    this.tpDirty.set(false);
    this.entryPrice.set(null);
    this.stopLoss.set(null);
    this.takeProfit.set(null);
  }

  submit(): void {
    if (!this.canSubmit() || this.submitting()) return;

    const expiresAtUtc = new Date(this.expiresAtLocal()).toISOString();
    const body: CreateTradeSignalRequest = {
      strategyId: this.strategyId()!,
      symbol: this.symbol().trim().toUpperCase(),
      direction: this.direction(),
      entryPrice: this.entryPrice()!,
      stopLoss: this.stopLoss(),
      takeProfit: this.takeProfit(),
      suggestedLotSize: this.lotSize(),
      confidence: this.confidence(),
      expiresAt: expiresAtUtc,
    };

    this.submitting.set(true);
    this.tradeSignals
      .create(body)
      .pipe(
        catchError((err) => {
          const msg = (err?.error?.message as string | undefined) ?? err?.message ?? String(err);
          this.notifications.error(`Create signal failed: ${msg}`);
          this.submitting.set(false);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.submitting.set(false);
        if (res?.status && typeof res.data === 'number') {
          this.notifications.success(`Trade signal #${res.data} created.`);
          this.created.emit(res.data);
        } else if (res) {
          this.notifications.error(res.message ?? 'Create refused.');
        }
      });
  }

  /** Default expiry = now + 30 minutes, local datetime-local string. */
  private defaultExpiryLocalIso(): string {
    const d = new Date(Date.now() + 30 * 60_000);
    // datetime-local input wants 'YYYY-MM-DDTHH:mm' in *local* time.
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
