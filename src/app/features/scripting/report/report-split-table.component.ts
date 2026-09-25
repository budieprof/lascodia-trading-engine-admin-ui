import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ReportSplits } from './strategy-report.model';
import {
  formatMetricPercent,
  formatMetricValue,
  metricToneClass,
  type SplitMetricGroup,
} from './report-sections';

const SIDES = ['all', 'long', 'short'] as const;

interface CellVm {
  text: string;
  pct: string;
  tone: '' | 'gain' | 'loss';
}

interface RowVm {
  label: string;
  hint: string | null;
  cells: CellVm[];
}

interface GroupVm {
  title: string;
  rows: RowVm[];
}

/**
 * An All / Long / Short metrics table (the Strategy Tester's Performance and Trades analysis
 * layout). Groups become row groups with their own header row; a metric's percentage prints
 * under its value.
 */
@Component({
  selector: 'app-report-split-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" role="region" [attr.aria-label]="caption()" tabindex="0">
      <table>
        <caption class="sr-only">
          {{
            caption()
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col" class="metric-col">Metric</th>
            <th scope="col" class="num">All</th>
            <th scope="col" class="num">Long</th>
            <th scope="col" class="num">Short</th>
          </tr>
        </thead>
        @for (g of vm(); track g.title) {
          <tbody>
            <tr class="group">
              <th scope="colgroup" colspan="4">{{ g.title }}</th>
            </tr>
            @for (row of g.rows; track row.label) {
              <tr>
                <th scope="row" class="metric">
                  <span class="label">{{ row.label }}</span>
                  @if (row.hint) {
                    <span class="hint">{{ row.hint }}</span>
                  }
                </th>
                @for (cell of row.cells; track $index) {
                  <td class="num">
                    <span
                      class="value"
                      [class.gain]="cell.tone === 'gain'"
                      [class.loss]="cell.tone === 'loss'"
                      >{{ cell.text }}</span
                    >
                    @if (cell.pct) {
                      <span class="pct">{{ cell.pct }}</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        }
      </table>
    </div>
  `,
  styles: [
    `
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
        min-width: 560px;
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
      thead th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .metric-col {
        width: 40%;
      }
      tr.group th {
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-top: var(--space-3);
      }
      .metric {
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
        font-weight: var(--font-regular);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .value {
        display: block;
        color: var(--text-primary);
        font-weight: var(--font-medium);
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
export class ReportSplitTableComponent {
  readonly groups = input.required<readonly SplitMetricGroup[]>();
  readonly splits = input.required<ReportSplits>();
  readonly currency = input('');
  readonly caption = input('Strategy metrics for all, long and short trades');

  readonly vm = computed<GroupVm[]>(() => {
    const splits = this.splits();
    const currency = this.currency();
    return this.groups().map((g) => ({
      title: g.title,
      rows: g.rows.map((row) => ({
        label: row.label,
        hint: row.hint ?? null,
        cells: SIDES.map((side) => {
          const s = splits[side];
          const v = row.value(s);
          return {
            text: formatMetricValue(row, v, currency),
            pct: row.percent ? formatMetricPercent(row, row.percent(s)) : '',
            tone: metricToneClass(row, v),
          };
        }),
      })),
    }));
  });
}
