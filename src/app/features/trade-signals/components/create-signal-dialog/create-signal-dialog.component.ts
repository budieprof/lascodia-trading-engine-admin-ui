import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  output,
  signal,
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
    <div class="overlay" (click)="onBackdropClick($event)" (keyup.escape)="cancel()" tabindex="0">
      <div
        class="dialog"
        role="dialog"
        aria-labelledby="create-signal-title"
        (click)="$event.stopPropagation()"
      >
        <header class="dialog-head">
          <h3 id="create-signal-title">Create trade signal</h3>
          <button type="button" class="btn-close" (click)="cancel()" aria-label="Close">×</button>
        </header>

        <div class="dialog-body">
          <p class="hint">
            Operator-authored signals enter the queue in <strong>Pending</strong> status and are
            handled by the same approval workflow as engine-generated signals. ML scoring fields are
            intentionally not filled — the engine will treat this as an unscored signal.
          </p>

          <div class="grid">
            <label class="field">
              <span>Strategy</span>
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
              <span>Symbol</span>
              <input
                type="text"
                [(ngModel)]="symbol"
                name="symbol"
                placeholder="EURUSD"
                maxlength="10"
                required
              />
              @if (resolvedStrategy(); as s) {
                <small class="muted">strategy default: {{ s.symbol }}</small>
              }
            </label>

            <label class="field">
              <span>Direction</span>
              <div class="direction-toggle">
                <button
                  type="button"
                  [class.active]="direction() === 'Buy'"
                  [class.buy]="direction() === 'Buy'"
                  (click)="direction.set('Buy')"
                >
                  Buy
                </button>
                <button
                  type="button"
                  [class.active]="direction() === 'Sell'"
                  [class.sell]="direction() === 'Sell'"
                  (click)="direction.set('Sell')"
                >
                  Sell
                </button>
              </div>
            </label>

            <label class="field">
              <span>Confidence <span class="hint">(0–1)</span></span>
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

            <label class="field">
              <span>Entry price</span>
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
              <span>Lot size</span>
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
              <span>Stop loss <span class="hint">(optional)</span></span>
              <input type="number" [(ngModel)]="stopLoss" name="stopLoss" step="0.00001" min="0" />
            </label>

            <label class="field">
              <span>Take profit <span class="hint">(optional)</span></span>
              <input
                type="number"
                [(ngModel)]="takeProfit"
                name="takeProfit"
                step="0.00001"
                min="0"
              />
            </label>

            <label class="field expires">
              <span>Expires at <span class="hint">(UTC)</span></span>
              <input type="datetime-local" [(ngModel)]="expiresAtLocal" name="expiresAt" required />
              <small class="muted">{{ defaultExpiryHint() }}</small>
            </label>
          </div>

          @if (sanityWarning(); as msg) {
            <div class="warn-banner">⚠ {{ msg }}</div>
          }
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
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding-top: 8vh;
        z-index: 1000;
      }
      .dialog {
        background: var(--bg-primary, #fff);
        border-radius: var(--radius-lg, 8px);
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.2));
        width: 640px;
        max-width: 92vw;
        max-height: 84vh;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
      }
      .dialog-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .dialog-head h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .btn-close {
        background: transparent;
        border: none;
        font-size: 24px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-secondary);
      }
      .dialog-body {
        padding: var(--space-5);
        overflow-y: auto;
      }
      .hint {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: 400;
      }
      .dialog-body > .hint {
        font-size: var(--text-sm);
        margin: 0 0 var(--space-4);
        line-height: 1.5;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3) var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field.expires {
        grid-column: 1 / -1;
      }
      .field > span {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input,
      .field select {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
      }
      .field small.muted {
        color: var(--text-tertiary, #999);
        font-size: var(--text-xs);
      }
      .direction-toggle {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2);
      }
      .direction-toggle button {
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .direction-toggle button.active.buy {
        background: rgba(34, 197, 94, 0.15);
        border-color: #15803d;
        color: #15803d;
      }
      .direction-toggle button.active.sell {
        background: rgba(239, 68, 68, 0.15);
        border-color: #b91c1c;
        color: #b91c1c;
      }
      .warn-banner {
        margin-top: var(--space-3);
        padding: var(--space-2) var(--space-3);
        background: rgba(245, 158, 11, 0.1);
        color: #92400e;
        border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
      }
      .dialog-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-5);
        border-top: 1px solid var(--border);
      }
      .btn-primary,
      .btn-secondary {
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        font: inherit;
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid var(--border);
      }
      .btn-secondary {
        background: var(--bg-secondary);
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
    `,
  ],
})
export class CreateSignalDialogComponent {
  private readonly tradeSignals = inject(TradeSignalsService);
  private readonly strategies = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

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

  onBackdropClick(event: Event): void {
    if (event.target === event.currentTarget) this.cancel();
  }

  cancel(): void {
    if (this.submitting()) return;
    this.closed.emit();
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
