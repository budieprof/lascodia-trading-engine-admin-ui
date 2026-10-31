import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-metric-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="metric-card"
      [class.toned]="!!dotColor()"
      [style.--tone]="dotColor() || null"
      [attr.title]="caption() ? label() + ' — ' + caption() : label()"
    >
      <span class="metric-label">{{ label() }}</span>
      <div class="metric-body">
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
        @if (caption()) {
          <div class="metric-caption">{{ caption() }}</div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      /* Compact tile shared by every KPI strip: small uppercase label on top, the figure (and its
         delta / caption) pinned to the bottom so values line up across a row whatever the label
         length. The page's dot colour now paints a stripe down the left edge instead of a dot. */
      .metric-card {
        --tone: var(--text-tertiary);
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 2px);
        box-shadow: var(--shadow-sm);
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        overflow: hidden;
        min-width: 0;
      }
      .metric-card::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--tone);
        opacity: 0.3;
      }
      .metric-card.toned::before {
        opacity: 0.9;
      }

      .metric-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .metric-body {
        margin-top: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .metric-value {
        /* Six tiles across a 1440px page leave ~150px for a value like "$2,093,491.05"; the size
           follows the viewport and a value that still does not fit wraps rather than clips. */
        font-size: clamp(var(--text-lg), 1.5vw, 24px);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        letter-spacing: -0.01em;
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
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        font-variant-numeric: tabular-nums;
      }
      .metric-delta.profit {
        color: var(--profit);
      }
      .metric-delta.loss {
        color: var(--loss);
      }

      .metric-caption {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
  /** Optional one-line context under the figure ("of 30 total", "latest 3 days ago"). */
  caption = input<string | null>(null);
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
