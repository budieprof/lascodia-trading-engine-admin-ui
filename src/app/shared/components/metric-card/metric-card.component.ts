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
      .metric-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        transition: all 0.2s ease;
      }

      .metric-card:hover {
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }

      .metric-header {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .metric-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }

      .metric-value {
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        letter-spacing: var(--tracking-tight);
        font-variant-numeric: tabular-nums;
        line-height: 1.2;
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

  isPositive = computed(() => this.colorByValue() && (this.value() ?? 0) > 0);
  isNegative = computed(() => this.colorByValue() && (this.value() ?? 0) < 0);

  formattedValue = computed(() => {
    const v = this.value();
    if (v == null) return '-';
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
