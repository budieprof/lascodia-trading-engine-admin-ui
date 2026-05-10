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
  output,
  signal,
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

/**
 * Operator-facing form to hand-author a trade signal. Mirrors the subset of
 * `CreateTradeSignalCommand` an operator would actually fill in (the engine
 * leaves the ML scoring fields null for manual signals; the resulting signal
 * still flows through Pending → Approved/Rejected/Expired exactly like an
 * auto-generated one).
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
            <div class="section-head">
              <h4 class="section-title">Source</h4>
              <label class="auto-toggle">
                <input
                  type="checkbox"
                  [checked]="useAutoStrategy()"
                  (change)="onToggleAutoStrategy($event)"
                />
                <span>Auto-pick strategy</span>
              </label>
            </div>
            <div class="row">
              @if (useAutoStrategy()) {
                <div class="field span-2 auto-pick">
                  <span class="label">Strategy</span>
                  @if (autoPickedStrategy(); as s) {
                    <div class="auto-pick-result">
                      <strong>#{{ s.id }}</strong> · {{ s.symbol }} {{ s.timeframe }} ·
                      {{ s.name }}
                      <span class="hint">{{ autoPickHint() }}</span>
                    </div>
                  } @else {
                    <div class="auto-pick-result empty">
                      <em
                        >No active strategy matches the symbol — uncheck "Auto-pick" to choose
                        manually.</em
                      >
                    </div>
                  }
                </div>
              } @else {
                <label class="field span-2">
                  <span class="label">Strategy</span>
                  <select [(ngModel)]="strategyId" name="strategyId" required>
                    <option [ngValue]="null" disabled>— pick a strategy —</option>
                    @for (s of activeStrategies(); track s.id) {
                      <option [ngValue]="s.id">
                        #{{ s.id }} · {{ s.symbol }} {{ s.timeframe }} · {{ s.name }}
                      </option>
                    }
                  </select>
                  @if (strategiesLoading()) {
                    <small class="muted">loading strategies…</small>
                  } @else if (activeStrategies().length === 0) {
                    <small class="muted">No strategies available — create one first.</small>
                  }
                </label>
              }

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
                  @if (!slDirty() && stopLoss() !== null) {
                    <span class="hint">auto · {{ pipsHint() }}p</span>
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
                  @if (!tpDirty() && takeProfit() !== null) {
                    <span class="hint">auto · {{ pipsHint() * 2 }}p</span>
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
      .auto-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs, 0.78rem);
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
      }
      .auto-pick-result {
        padding: 8px 10px;
        background: var(--bg-tertiary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-primary);
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 6px;
      }
      .auto-pick-result.empty {
        color: var(--text-secondary);
      }
      .auto-pick-result strong {
        font-weight: var(--font-semibold, 600);
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

  // ── Auto-pick strategy mode ──────────────────────────────────────────
  readonly useAutoStrategy = signal(true);

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

  /**
   * Auto-picked strategy when `useAutoStrategy` is true. Picks the first
   * active strategy whose Symbol matches the entered symbol; falls back to
   * the first active strategy overall when the symbol matches nothing.
   * Returns null only when there are zero strategies in the system.
   */
  readonly autoPickedStrategy = computed<StrategyDto | null>(() => {
    const list = this.activeStrategies();
    if (list.length === 0) return null;
    const sym = this.symbol().trim().toUpperCase();
    if (sym) {
      const symMatch = list.find((s) => (s.symbol ?? '').toUpperCase() === sym);
      if (symMatch) return symMatch;
    }
    return list[0];
  });

  /** Strategy that actually gets sent on submit — auto-pick or operator-pick. */
  readonly effectiveStrategyId = computed<number | null>(() => {
    return this.useAutoStrategy() ? (this.autoPickedStrategy()?.id ?? null) : this.strategyId();
  });

  /** Honest hint copy — distinguishes a real symbol match from the list[0] fallback. */
  readonly autoPickHint = computed(() => {
    const s = this.autoPickedStrategy();
    if (!s) return '';
    const sym = this.symbol().trim().toUpperCase();
    const matchesSymbol = sym && (s.symbol ?? '').toUpperCase() === sym;
    return matchesSymbol
      ? 'auto-picked from active strategies on this symbol'
      : 'no symbol match yet — showing the first active strategy';
  });

  readonly resolvedStrategy = computed(() => {
    const id = this.useAutoStrategy() ? (this.autoPickedStrategy()?.id ?? null) : this.strategyId();
    if (id === null) return null;
    return this.activeStrategies().find((s) => s.id === id) ?? null;
  });

  // ── SL/TP auto-calc helpers ──────────────────────────────────────────
  /** Pip size for the current symbol — JPY pairs are 0.01, others 0.0001. */
  private pipSize(): number {
    return this.symbol().toUpperCase().includes('JPY') ? 0.01 : 0.0001;
  }

  /** SL distance in pips for the auto-default. 1:2 R:R with TP. */
  readonly pipsHint = computed(() => 30);

  readonly defaultExpiryHint = computed(() => {
    const local = this.expiresAtLocal();
    if (!local) return '';
    const utc = new Date(local).toISOString();
    return `→ sent as ${utc}`;
  });

  readonly canSubmit = computed(() => {
    return (
      this.effectiveStrategyId() !== null &&
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
      if (lp) {
        const mid = (lp.bid + lp.ask) / 2;
        this.entryPrice.set(Math.round(mid * 1e5) / 1e5);
        return;
      }
      const fb = this.fallbackCandleClose();
      if (fb != null) {
        this.entryPrice.set(Math.round(fb * 1e5) / 1e5);
      }
    });

    // ── Auto-calc SL/TP relative to entry + direction ────────────────────
    // 30 pips SL, 60 pips TP (1:2 R:R). Re-runs when entry, direction, or
    // symbol (pip size) changes; skipped per-field once the operator types.
    effect(() => {
      const e = this.entryPrice();
      const dir = this.direction();
      // Re-read symbol so pip size recomputes when it flips JPY/non-JPY.
      const _sym = this.symbol();
      void _sym;
      if (e === null || e <= 0) return;
      const pip = this.pipSize();
      const slPips = 30;
      const tpPips = 60;
      const round = (n: number) => Math.round(n * 1e5) / 1e5;
      if (!this.slDirty()) {
        this.stopLoss.set(round(dir === 'Buy' ? e - slPips * pip : e + slPips * pip));
      }
      if (!this.tpDirty()) {
        this.takeProfit.set(round(dir === 'Buy' ? e + tpPips * pip : e - tpPips * pip));
      }
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

  onToggleAutoStrategy(ev: Event): void {
    this.useAutoStrategy.set((ev.target as HTMLInputElement).checked);
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
      strategyId: this.effectiveStrategyId()!,
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
