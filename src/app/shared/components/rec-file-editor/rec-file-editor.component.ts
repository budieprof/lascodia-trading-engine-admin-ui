import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * The edits an operator applied to a model recommendation on its way to becoming
 * a signal. Every field is optional and only CHANGED fields are populated — the
 * engine treats null as "keep the model's value", so an untouched field must not
 * be echoed back as an override.
 */
export interface RecFileOverrides {
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  direction?: 'Buy' | 'Sell' | null;
  confidence?: number | null;
  expiryMinutes?: number | null;
  note?: string | null;
}

/** The model's proposal, as the editor receives it. */
export interface RecFileSeed {
  symbol: string;
  action: 'Buy' | 'Sell';
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** 0.0–1.0, or null when the rec carried no confidence. */
  confidence: number | null;
}

/** Engine-side clamp on the operator-settable TTL — mirror it in the input. */
const MIN_EXPIRY_MINUTES = 30;
const MAX_EXPIRY_MINUTES = 24 * 60;

/**
 * Inline editor shown between "file this recommendation" and the signal actually
 * being created.
 *
 * <p>The model's levels are a proposal written at analysis time. By the time an
 * operator reads them the tape has moved, and the choice used to be binary: file
 * the stale geometry or throw the whole thesis away. This lets the thesis be kept
 * and the numbers adjusted — the filed signal still carries the conversation's
 * provenance, and the engine records both what was filed and what the model
 * originally said.</p>
 *
 * <p>Purely presentational: it validates and emits, and the host owns the HTTP
 * call, the busy flag and the error text. Symbol is deliberately not editable —
 * retargeting a thesis at another pair is a new analysis, not an edit.</p>
 */
@Component({
  selector: 'app-rec-file-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <form class="rfe" (ngSubmit)="submit()">
      <div class="rfe-head">
        <span class="rfe-title">File {{ seed().symbol }} as a signal</span>
        @if (dirty()) {
          <button type="button" class="rfe-reset" (click)="reset()">reset to model</button>
        }
      </div>

      <div class="rfe-grid">
        <label class="rfe-field">
          <span class="rfe-label">Direction</span>
          <select
            class="rfe-input"
            [value]="direction()"
            (change)="onDirection($event)"
            [disabled]="busy()"
          >
            <option value="Buy">Buy</option>
            <option value="Sell">Sell</option>
          </select>
        </label>

        <label class="rfe-field">
          <span class="rfe-label">Entry</span>
          <input
            class="rfe-input mono"
            type="number"
            step="any"
            inputmode="decimal"
            [value]="entry() ?? ''"
            (input)="entry.set(num($event))"
            [disabled]="busy()"
          />
        </label>

        <label class="rfe-field">
          <span class="rfe-label">
            Stop loss
            @if (slPips(); as p) {
              <span class="rfe-pips">{{ p }}p</span>
            }
          </span>
          <input
            class="rfe-input mono"
            type="number"
            step="any"
            inputmode="decimal"
            [value]="stopLoss() ?? ''"
            (input)="stopLoss.set(num($event))"
            [disabled]="busy()"
          />
        </label>

        <label class="rfe-field">
          <span class="rfe-label">
            Take profit
            @if (tpPips(); as p) {
              <span class="rfe-pips">{{ p }}p</span>
            }
          </span>
          <input
            class="rfe-input mono"
            type="number"
            step="any"
            inputmode="decimal"
            [value]="takeProfit() ?? ''"
            (input)="takeProfit.set(num($event))"
            [disabled]="busy()"
          />
        </label>

        <label class="rfe-field">
          <span class="rfe-label">Confidence %</span>
          <input
            class="rfe-input mono"
            type="number"
            min="0"
            max="100"
            step="1"
            inputmode="numeric"
            [value]="confidencePct() ?? ''"
            (input)="confidencePct.set(num($event))"
            [disabled]="busy()"
          />
        </label>

        <label class="rfe-field">
          <span class="rfe-label">Expires in (min)</span>
          <input
            class="rfe-input mono"
            type="number"
            [min]="MIN_EXPIRY"
            [max]="MAX_EXPIRY"
            step="5"
            inputmode="numeric"
            [placeholder]="'auto'"
            [value]="expiryMinutes() ?? ''"
            (input)="expiryMinutes.set(num($event))"
            [disabled]="busy()"
          />
        </label>
      </div>

      @if (dirty()) {
        <label class="rfe-field rfe-note">
          <span class="rfe-label">Why the change (optional)</span>
          <input
            class="rfe-input"
            type="text"
            maxlength="512"
            placeholder="e.g. tightened the stop under the 15:00 swing low"
            [value]="note()"
            (input)="note.set(str($event))"
            [disabled]="busy()"
          />
        </label>
      }

      <div class="rfe-summary">
        <span class="rfe-rr" [class.thin]="rr() !== null && rr()! < 1">
          R:R {{ rr() === null ? '—' : rr() }}
        </span>
        @if (dirty()) {
          <span class="rfe-modified">modified — the model proposed {{ modelSummary() }}</span>
        } @else {
          <span class="rfe-hint">the model's values, unchanged</span>
        }
      </div>

      @if (validationError(); as ve) {
        <p class="rfe-error" role="alert">{{ ve }}</p>
      }
      @if (error(); as e) {
        <p class="rfe-error" role="alert">{{ e }}</p>
      }

      <div class="rfe-actions">
        <button type="submit" class="rfe-file" [disabled]="busy() || validationError() !== null">
          {{ busy() ? 'Filing…' : dirty() ? '⚡ File edited signal' : '⚡ File as signal' }}
        </button>
        <button type="button" class="rfe-cancel" [disabled]="busy()" (click)="cancelled.emit()">
          Cancel
        </button>
        <span class="rfe-gate">passes through the risk gates</span>
      </div>
    </form>
  `,
  styles: [
    `
      .rfe {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        padding: 0.7rem;
        border: 1px solid var(--border, #d5d8de);
        border-radius: 8px;
        background: var(--surface-2, #f7f8fa);
      }
      .rfe-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .rfe-title {
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .rfe-reset {
        border: 0;
        background: none;
        padding: 0;
        font-size: 0.7rem;
        color: var(--text-muted, #6b7280);
        text-decoration: underline;
        cursor: pointer;
      }
      .rfe-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
        gap: 0.5rem;
      }
      .rfe-field {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        min-width: 0;
      }
      .rfe-note {
        grid-column: 1 / -1;
      }
      .rfe-label {
        font-size: 0.66rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted, #6b7280);
        display: flex;
        gap: 0.3rem;
        align-items: baseline;
      }
      .rfe-pips {
        text-transform: none;
        letter-spacing: 0;
        opacity: 0.8;
      }
      .rfe-input {
        width: 100%;
        box-sizing: border-box;
        padding: 0.3rem 0.4rem;
        font-size: 0.8rem;
        border: 1px solid var(--border, #d5d8de);
        border-radius: 5px;
        background: var(--surface, #fff);
        color: inherit;
      }
      .rfe-input:disabled {
        opacity: 0.6;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .rfe-summary {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.5rem;
        font-size: 0.7rem;
        color: var(--text-muted, #6b7280);
      }
      .rfe-rr {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 600;
        color: inherit;
      }
      .rfe-rr.thin {
        color: var(--warn, #b45309);
      }
      .rfe-modified {
        color: var(--warn, #b45309);
      }
      .rfe-error {
        margin: 0;
        font-size: 0.72rem;
        color: var(--danger, #b91c1c);
      }
      .rfe-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.45rem;
      }
      .rfe-file,
      .rfe-cancel {
        padding: 0.32rem 0.65rem;
        font-size: 0.76rem;
        font-weight: 600;
        border-radius: 5px;
        cursor: pointer;
        border: 1px solid var(--border, #d5d8de);
      }
      .rfe-file {
        background: var(--accent, #1d4ed8);
        border-color: var(--accent, #1d4ed8);
        color: #fff;
      }
      .rfe-file:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .rfe-cancel {
        background: transparent;
      }
      .rfe-gate {
        font-size: 0.68rem;
        color: var(--text-muted, #6b7280);
      }
    `,
  ],
})
export class RecFileEditorComponent {
  /** The model's proposal. Re-seeding resets every field the operator touched. */
  readonly seed = input.required<RecFileSeed>();
  /** Host-owned in-flight flag — disables the form and relabels the submit button. */
  readonly busy = input(false);
  /** Host-owned server error text, rendered under the form. */
  readonly error = input<string | null>(null);

  /** Emits the CHANGED fields only. Unchanged fields are omitted entirely. */
  readonly filed = output<RecFileOverrides>();
  readonly cancelled = output<void>();

  protected readonly MIN_EXPIRY = MIN_EXPIRY_MINUTES;
  protected readonly MAX_EXPIRY = MAX_EXPIRY_MINUTES;

  protected readonly direction = signal<'Buy' | 'Sell'>('Buy');
  protected readonly entry = signal<number | null>(null);
  protected readonly stopLoss = signal<number | null>(null);
  protected readonly takeProfit = signal<number | null>(null);
  /** Held as whole percent — operators think in "58%", the wire wants 0.58. */
  protected readonly confidencePct = signal<number | null>(null);
  /** Null means "let the engine derive the TTL from the timeframe". */
  protected readonly expiryMinutes = signal<number | null>(null);
  protected readonly note = signal('');

  constructor() {
    // Seed (and re-seed) from the model's proposal. Written as an effect rather
    // than a one-shot so a host that swaps the rec — a new turn arriving on the
    // thread, a different recommendation index — can't leave the previous rec's
    // numbers sitting in the form under the new rec's heading.
    effect(() => {
      const s = this.seed();
      this.direction.set(s.action);
      this.entry.set(s.entryPrice);
      this.stopLoss.set(s.stopLoss);
      this.takeProfit.set(s.takeProfit);
      this.confidencePct.set(s.confidence === null ? null : Math.round(s.confidence * 100));
      this.expiryMinutes.set(null);
      this.note.set('');
    });
  }

  /** Pip size for the seeded symbol — JPY pairs are 0.01, others 0.0001. */
  private pipSize(): number {
    return this.seed().symbol.toUpperCase().includes('JPY') ? 0.01 : 0.0001;
  }

  private pipsBetween(a: number | null, b: number | null): string | null {
    if (a === null || b === null) return null;
    const pips = Math.abs(a - b) / this.pipSize();
    if (!Number.isFinite(pips)) return null;
    return pips.toFixed(1);
  }

  protected readonly slPips = computed(() => this.pipsBetween(this.entry(), this.stopLoss()));
  protected readonly tpPips = computed(() => this.pipsBetween(this.entry(), this.takeProfit()));

  /** Reward-to-risk of the CURRENT form values, 2dp. Null when incomputable. */
  protected readonly rr = computed(() => {
    const e = this.entry();
    const s = this.stopLoss();
    const t = this.takeProfit();
    if (e === null || s === null || t === null) return null;
    const risk = Math.abs(e - s);
    if (risk === 0) return null;
    return Math.round((Math.abs(t - e) / risk) * 100) / 100;
  });

  /** True once any field differs from the model's proposal. */
  protected readonly dirty = computed(() => {
    const s = this.seed();
    const seedPct = s.confidence === null ? null : Math.round(s.confidence * 100);
    return (
      this.direction() !== s.action ||
      this.entry() !== s.entryPrice ||
      this.stopLoss() !== s.stopLoss ||
      this.takeProfit() !== s.takeProfit ||
      this.confidencePct() !== seedPct ||
      this.expiryMinutes() !== null
    );
  });

  protected readonly modelSummary = computed(() => {
    const s = this.seed();
    const fmt = (n: number | null) => (n === null ? '—' : String(n));
    return `${s.action} @ ${fmt(s.entryPrice)}, SL ${fmt(s.stopLoss)}, TP ${fmt(s.takeProfit)}`;
  });

  /**
   * The same geometry rules the engine enforces, checked as the operator types
   * so a wrong-sided stop is caught in the form rather than by a round-trip.
   * Null means the form is fileable.
   */
  protected readonly validationError = computed<string | null>(() => {
    const dir = this.direction();
    const e = this.entry();
    const s = this.stopLoss();
    const t = this.takeProfit();

    if (e === null || !(e > 0)) return 'Entry price is required and must be greater than zero.';
    // Analyser-sourced signals are rejected downstream without a stop, so the
    // form requires one rather than letting the operator file a doomed signal.
    if (s === null || !(s > 0)) return 'A stop loss is required.';
    if (t !== null && !(t > 0)) return 'Take profit must be greater than zero.';

    const isBuy = dir === 'Buy';
    if (s === e) return 'Stop loss cannot equal the entry price.';
    if (isBuy && s > e) return "A Buy's stop loss must sit below its entry.";
    if (!isBuy && s < e) return "A Sell's stop loss must sit above its entry.";

    if (t !== null) {
      if (t === e) return 'Take profit cannot equal the entry price.';
      if (isBuy && t < e) return "A Buy's take profit must sit above its entry.";
      if (!isBuy && t > e) return "A Sell's take profit must sit below its entry.";
    }

    const pct = this.confidencePct();
    if (pct !== null && (pct < 0 || pct > 100)) return 'Confidence must be between 0 and 100%.';

    const mins = this.expiryMinutes();
    if (mins !== null && (mins < MIN_EXPIRY_MINUTES || mins > MAX_EXPIRY_MINUTES))
      return `Expiry must be between ${MIN_EXPIRY_MINUTES} and ${MAX_EXPIRY_MINUTES} minutes.`;

    return null;
  });

  protected onDirection(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    this.direction.set(v === 'Sell' ? 'Sell' : 'Buy');
  }

  /** Parse a numeric input, treating a cleared field as null rather than 0. */
  protected num(ev: Event): number | null {
    const raw = (ev.target as HTMLInputElement).value.trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  protected str(ev: Event): string {
    return (ev.target as HTMLInputElement).value;
  }

  protected reset(): void {
    const s = this.seed();
    this.direction.set(s.action);
    this.entry.set(s.entryPrice);
    this.stopLoss.set(s.stopLoss);
    this.takeProfit.set(s.takeProfit);
    this.confidencePct.set(s.confidence === null ? null : Math.round(s.confidence * 100));
    this.expiryMinutes.set(null);
    this.note.set('');
  }

  protected submit(): void {
    if (this.busy() || this.validationError() !== null) return;

    const s = this.seed();
    const seedPct = s.confidence === null ? null : Math.round(s.confidence * 100);
    const out: RecFileOverrides = {};

    // Only changed fields go on the wire: the engine reads null as "keep the
    // model's value", so echoing an untouched field back would record an
    // operator edit that never happened.
    if (this.direction() !== s.action) out.direction = this.direction();
    if (this.entry() !== s.entryPrice) out.entryPrice = this.entry();
    if (this.stopLoss() !== s.stopLoss) out.stopLoss = this.stopLoss();
    if (this.takeProfit() !== s.takeProfit) out.takeProfit = this.takeProfit();
    if (this.confidencePct() !== seedPct && this.confidencePct() !== null)
      out.confidence = this.confidencePct()! / 100;
    if (this.expiryMinutes() !== null) out.expiryMinutes = this.expiryMinutes();
    const n = this.note().trim();
    if (n) out.note = n;

    this.filed.emit(out);
  }
}
