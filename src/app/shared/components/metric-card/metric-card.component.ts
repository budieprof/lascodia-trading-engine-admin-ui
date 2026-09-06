import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-metric-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="metric-card">
      <div class="metric-header">
        @if (dotColor()) {
          <span class="dot" [style.background]="dotColor()"></span>
        }
        <span class="metric-label">{{ label() }}</span>
      </div>
      <div class="metric-value" [class.profit]="isPositive()" [class.loss]="isNegative()">
        {{ formattedValue() }}
      </div>
      @if (delta() !== undefined) {
        <div
          class="metric-delta"
          [class.profit]="(delta() ?? 0) >= 0"
          [class.loss]="(delta() ?? 0) < 0"
        >
          {{ (delta() ?? 0) >= 0 ? '↑' : '↓' }} {{ formatDelta() }}
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .metric-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        transition: all 0.2s ease;
        /* Make every card the same height so values line up vertically across
         * a row, even when grid sizing makes some cards taller than others. */
        height: 100%;
        display: flex;
        flex-direction: column;
      }

      .metric-card:hover {
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }

      .metric-header {
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
        margin-bottom: var(--space-3);
        /* Reserve two lines of label height so cards with one-line labels
         * (e.g. "Reject rate") and two-line labels (e.g. "Avg slippage (pips)")
         * push their values down to the same Y position. */
        min-height: 2.6em;
      }

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        /* Keep the dot aligned with the first line of the label rather than
         * the centre of the (now multi-line) header block. */
        margin-top: 0.4em;
      }

      .metric-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        line-height: 1.3;
      }

      .metric-value {
        /* Six tiles across a 1440px page leave ~150px for a value like
           "$2,093,491.05"; at the fixed 2xl size it clipped mid-digit
           ("$2,093,491.("). The size follows the viewport between lg and
           2xl, and a value that still does not fit wraps rather than clips. */
        font-size: clamp(var(--text-lg), 1.55vw, var(--text-2xl));
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        letter-spacing: var(--tracking-tight);
        font-variant-numeric: tabular-nums;
        line-height: 1.2;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .metric-value.profit {
        color: var(--profit);
      }
      .metric-value.loss {
        color: var(--loss);
      }

      .metric-delta {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        margin-top: var(--space-1);
        font-variant-numeric: tabular-nums;
      }

      .metric-delta.profit {
        color: var(--profit);
      }
      .metric-delta.loss {
        color: var(--loss);
      }
    `,
  ],
})
export class MetricCardComponent {
  label = input.required<string>();
  value = input<number | null>(null);
  format = input<'currency' | 'percent' | 'number'>('number');
  delta = input<number | undefined>(undefined);
  dotColor = input<string>();
  colorByValue = input(false);

  /**
   * For metrics where a POSITIVE number is the bad direction — drawdown, loss streaks, error
   * rates. With `colorByValue` alone a 7.62% drawdown painted itself green, which reads as good
   * news on a number that had just moved the account into Reduced recovery.
   */
  invertColor = input(false);

  /**
   * Literal text to show instead of the formatted number: "∞" for a profit
   * factor with no losing trades, "n/a" for a ratio whose denominator is
   * zero, "—" for a value the API never returned. Without it those cards
   * rendered a bare "-" or a sentinel like 9,999 as if it were measured.
   * Colour-by-value still follows `value` so a literal can keep its tone.
   */
  displayValue = input<string | null>(null);

  isPositive = computed(() => {
    if (!this.colorByValue()) return false;
    const v = this.value() ?? 0;
    return this.invertColor() ? v < 0 : v > 0;
  });
  isNegative = computed(() => {
    if (!this.colorByValue()) return false;
    const v = this.value() ?? 0;
    return this.invertColor() ? v > 0 : v < 0;
  });

  formattedValue = computed(() => {
    const literal = this.displayValue();
    if (literal != null) return literal;
    const v = this.value();
    if (v == null) return '—';
    switch (this.format()) {
      case 'currency':
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
      case 'percent':
        return `${v.toFixed(2)}%`;
      default:
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
    }
  });

  formatDelta(): string {
    const d = this.delta();
    if (d == null) return '';
    const abs = Math.abs(d);
    if (this.format() === 'percent') return `${abs.toFixed(2)}%`;
    if (this.format() === 'currency') {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(abs);
    }
    return abs.toFixed(2);
  }
}
