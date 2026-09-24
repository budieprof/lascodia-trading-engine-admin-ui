import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { monthlyReturnsByYear, type ReportMonthlyReturn } from './strategy-report.model';
import { heatCellColors, withAlpha, type ReportPalette } from './report-charts';
import { MONTH_LABELS, formatMoney, formatPercent } from './report-format';

interface HeatCell {
  text: string;
  label: string;
  background: string | null;
  color: string | null;
}

interface HeatRow {
  year: number;
  cells: HeatCell[];
  total: HeatCell;
}

/**
 * Monthly returns as a heatmap table: one row per year, one cell per calendar month (UTC) and the
 * year's compounded total. The cell colour is a diverging scale (loss ↔ neutral ↔ gain) and every
 * cell also prints its signed value, so the table reads without colour.
 */
@Component({
  selector: 'app-report-monthly-heatmap',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length === 0) {
      <p class="empty" role="status">No complete month of equity to report yet.</p>
    } @else {
      <div class="wrap" role="region" aria-label="Monthly returns" tabindex="0">
        <table>
          <caption class="sr-only">
            Monthly returns: percentage change of equity per calendar month (UTC), with each year's
            total
          </caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              @for (m of months; track m) {
                <th scope="col" class="num">{{ m }}</th>
              }
              <th scope="col" class="num total-col">Year</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.year) {
              <tr>
                <th scope="row">{{ r.year }}</th>
                @for (c of r.cells; track $index) {
                  <td
                    class="num cell"
                    [style.background]="c.background"
                    [style.color]="c.color"
                    [attr.title]="c.label"
                    [attr.aria-label]="c.label"
                  >
                    {{ c.text }}
                  </td>
                }
                <td
                  class="num cell total-col"
                  [style.background]="r.total.background"
                  [style.color]="r.total.color"
                  [attr.title]="r.total.label"
                  [attr.aria-label]="r.total.label"
                >
                  {{ r.total.text }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="legend" aria-hidden="true">
        <span>Loss</span>
        <span class="ramp" [style.background]="legendRamp()"></span>
        <span>Gain</span>
        <span class="scale">colour saturates at ±{{ scaleText() }}</span>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .wrap {
        overflow-x: auto;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .wrap:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      table {
        width: 100%;
        min-width: 820px;
        border-collapse: separate;
        border-spacing: 2px;
        font-size: var(--text-xs);
      }
      th,
      td {
        padding: var(--space-2);
        text-align: left;
        white-space: nowrap;
      }
      thead th {
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      tbody th {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .cell {
        border-radius: 4px;
        color: var(--text-primary);
        min-width: 56px;
      }
      .total-col {
        font-weight: var(--font-semibold);
      }
      .legend {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .ramp {
        width: 160px;
        height: 8px;
        border-radius: 4px;
      }
      .scale {
        margin-left: var(--space-2);
        color: var(--text-tertiary);
      }
      .empty {
        margin: 0;
        padding: var(--space-5);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class ReportMonthlyHeatmapComponent {
  readonly monthlyReturns = input.required<readonly ReportMonthlyReturn[]>();
  readonly palette = input.required<ReportPalette>();
  readonly currency = input('');

  readonly months = MONTH_LABELS;

  private readonly years = computed(() => monthlyReturnsByYear(this.monthlyReturns()));

  /** Colour scale: the largest absolute month, never below 1% so flat years stay pale. */
  private readonly scale = computed(() => {
    let max = 0;
    for (const m of this.monthlyReturns()) {
      if (m.returnPercent !== null) max = Math.max(max, Math.abs(m.returnPercent));
    }
    return Math.max(1, max);
  });

  private readonly yearScale = computed(() => {
    let max = 0;
    for (const y of this.years()) {
      if (y.yearReturnPercent !== null) max = Math.max(max, Math.abs(y.yearReturnPercent));
    }
    return Math.max(1, max);
  });

  readonly scaleText = computed(() => formatPercent(this.scale(), { decimals: 1 }));

  readonly legendRamp = computed(() => {
    const p = this.palette();
    return `linear-gradient(90deg, ${withAlpha(p.lossPole, 0.85)}, ${withAlpha(p.lossPole, 0.12)}, transparent, ${withAlpha(p.gainPole, 0.12)}, ${withAlpha(p.gainPole, 0.85)})`;
  });

  readonly rows = computed<HeatRow[]>(() => {
    const palette = this.palette();
    const scale = this.scale();
    const yearScale = this.yearScale();
    const currency = this.currency();
    return this.years().map((y) => ({
      year: y.year,
      cells: y.months.map((m, i) => {
        const name = `${MONTH_LABELS[i]} ${y.year}`;
        if (!m || m.returnPercent === null) {
          return { text: '', label: `${name}: no data`, background: null, color: null };
        }
        const colors = heatCellColors(m.returnPercent, scale, palette);
        const text = formatPercent(m.returnPercent, { signed: true });
        return {
          text,
          label: `${name}: ${text} (${formatMoney(m.startEquity, currency)} → ${formatMoney(m.endEquity, currency)})`,
          background: colors?.background ?? null,
          color: colors?.color === 'inherit' ? null : (colors?.color ?? null),
        };
      }),
      total: (() => {
        const v = y.yearReturnPercent;
        if (v === null)
          return { text: '', label: `${y.year}: no data`, background: null, color: null };
        const colors = heatCellColors(v, yearScale, palette);
        const text = formatPercent(v, { signed: true });
        return {
          text,
          label: `${y.year} total: ${text}`,
          background: colors?.background ?? null,
          color: colors?.color === 'inherit' ? null : (colors?.color ?? null),
        };
      })(),
    }));
  });
}
