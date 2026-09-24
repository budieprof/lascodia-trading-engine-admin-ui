import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategyReport } from './strategy-report.model';
import {
  formatMetricPercent,
  formatMetricValue,
  metricToneClass,
  type ReportMetricGroup,
} from './report-sections';

interface RowVm {
  label: string;
  hint: string | null;
  text: string;
  pct: string;
  tone: '' | 'gain' | 'loss';
}

/**
 * Single-value metrics in titled cards (Risk & returns, Capital efficiency). Each card is a
 * two-column table so screen readers pair every value with its label.
 */
@Component({
  selector: 'app-report-metric-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="groups">
      @for (g of vm(); track g.title) {
        <section class="group" [attr.aria-label]="g.title">
          <h4 class="group-title">{{ g.title }}</h4>
          <table>
            <caption class="sr-only">
              {{
                g.title
              }}
            </caption>
            <tbody>
              @for (row of g.rows; track row.label) {
                <tr>
                  <th scope="row">
                    <span class="label">{{ row.label }}</span>
                    @if (row.hint) {
                      <span class="hint">{{ row.hint }}</span>
                    }
                  </th>
                  <td class="num">
                    <span
                      class="value"
                      [class.gain]="row.tone === 'gain'"
                      [class.loss]="row.tone === 'loss'"
                      >{{ row.text }}</span
                    >
                    @if (row.pct) {
                      <span class="pct">{{ row.pct }}</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .groups {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
        gap: var(--space-4);
        align-items: start;
      }
      .group {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .group-title {
        margin: 0;
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      tr:last-child th,
      tr:last-child td {
        border-bottom: none;
      }
      th {
        font-weight: var(--font-regular);
        color: var(--text-primary);
      }
      .label {
        display: block;
      }
      .hint {
        display: block;
        margin-top: 2px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .num {
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .value {
        display: block;
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .pct {
        display: block;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .gain {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
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
export class ReportMetricListComponent {
  readonly groups = input.required<readonly ReportMetricGroup[]>();
  readonly report = input.required<StrategyReport>();
  readonly currency = input('');

  readonly vm = computed(() => {
    const r = this.report();
    const currency = this.currency();
    return this.groups().map((g) => ({
      title: g.title,
      rows: g.rows.map((row): RowVm => {
        const v = row.value(r);
        return {
          label: row.label,
          hint: row.hint ?? null,
          text: formatMetricValue(row, v, currency),
          pct: row.percent ? formatMetricPercent(row, row.percent(r)) : '',
          tone: metricToneClass(row, v),
        };
      }),
    }));
  });
}
