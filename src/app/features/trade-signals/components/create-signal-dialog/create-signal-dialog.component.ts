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
import { NotificationService } from '@core/notifications/notification.service';
import type { CreateTradeSignalRequest, StrategyDto } from '@core/api/api.types';

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
            <h4 class="section-title">Source</h4>
            <div class="row">
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

              <label class="field">
                <span class="label">Symbol</span>
                <input
                  type="text"
                  [(ngModel)]="symbol"
                  name="symbol"
                  placeholder="EURUSD"
                  maxlength="10"
                  required
                />
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
            <h4 class="section-title">Price levels</h4>
            <div class="row">
              <label class="field">
                <span class="label">Entry price</span>
                <input
                  type="number"
                  [(ngModel)]="entryPrice"
                  name="entryPrice"
                  step="0.00001"
                  min="0"
                  required
                />
              </label>
              <label class="field">
                <span class="label">Stop loss <span class="hint">opt.</span></span>
                <input
                  type="number"
                  [(ngModel)]="stopLoss"
                  name="stopLoss"
                  step="0.00001"
                  min="0"
                />
              </label>
              <label class="field">
                <span class="label">Take profit <span class="hint">opt.</span></span>
                <input
                  type="number"
                  [(ngModel)]="takeProfit"
                  name="takeProfit"
                  step="0.00001"
                  min="0"
                />
              </label>
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

  // Form state.
  readonly strategyId = signal<number | null>(null);
  readonly symbol = signal<string>('');
  readonly direction = signal<'Buy' | 'Sell'>('Buy');
  readonly entryPrice = signal<number | null>(null);
  readonly stopLoss = signal<number | null>(null);
  readonly takeProfit = signal<number | null>(null);
  readonly lotSize = signal<number>(0.01);
  readonly confidence = signal<number>(0.6);
  readonly expiresAtLocal = signal<string>(this.defaultExpiryLocalIso());

  readonly submitting = signal(false);
  readonly strategiesLoading = signal(true);
  readonly strategies_ = signal<StrategyDto[]>([]);

  readonly activeStrategies = computed(() => this.strategies_());

  readonly resolvedStrategy = computed(() => {
    const id = this.strategyId();
    if (id === null) return null;
    return this.activeStrategies().find((s) => s.id === id) ?? null;
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
