import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { PromotionGateRowDto } from '@core/api/api.types';
import { gateOutcomeCounts, gateRowViews } from '../../util/gate-rows';

/**
 * The engine's structured promotion-gate rows (contract C2): one line per gate with its outcome
 * chip (Pass / Fail / Skipped / Not measurable / Bypassed / Observe), the measured value against the
 * threshold it is held to, and the engine's sentence. Used by the readiness card, the gate-attempt
 * history and Submit for approval — callers fall back to their text rendering when rows are absent.
 */
@Component({
  selector: 'app-gate-rows-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (views().length > 0) {
      @if (showCounts()) {
        <p class="counts" data-testid="gate-counts">{{ counts() }}</p>
      }
      <table class="gate-rows" [attr.aria-label]="ariaLabel()">
        <thead>
          <tr>
            <th scope="col" class="g">Gate</th>
            <th scope="col" class="o">Outcome</th>
            <th scope="col" class="m">Measured</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          @for (v of views(); track v.key) {
            <tr [class]="'tone-' + v.tone" [attr.data-outcome]="v.outcome">
              <td class="g">{{ v.label }}</td>
              <td class="o">
                <span [class]="'chip chip-' + v.tone" [attr.title]="v.hint">{{
                  v.outcomeLabel
                }}</span>
              </td>
              <td class="m mono">{{ v.measure }}</td>
              <td class="d">{{ v.detail || '—' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .counts {
        margin: 0 0 6px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      table.gate-rows {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
      }
      th {
        text-align: left;
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
      }
      td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
        color: var(--text-primary);
      }
      td.g {
        font-weight: 600;
        white-space: nowrap;
      }
      td.o {
        white-space: nowrap;
      }
      td.m {
        white-space: nowrap;
      }
      td.d {
        color: var(--text-secondary);
        word-break: break-word;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-variant-numeric: tabular-nums;
      }
      tr.tone-fail td {
        background: rgba(255, 59, 48, 0.05);
      }
      .chip {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        line-height: 18px;
      }
      .chip-pass {
        background: rgba(52, 199, 89, 0.14);
        color: var(--profit, #1f8a3b);
      }
      .chip-fail {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss, #c0392b);
      }
      .chip-skip,
      .chip-info {
        background: rgba(142, 142, 147, 0.16);
        color: var(--text-secondary);
      }
      .chip-bypass {
        background: rgba(175, 82, 222, 0.14);
        color: #8e44ad;
      }
      .chip-warn {
        background: rgba(255, 149, 0, 0.16);
        color: #b26a00;
      }
    `,
  ],
})
export class GateRowsTableComponent {
  readonly rows = input<readonly PromotionGateRowDto[] | null | undefined>(null);
  readonly showCounts = input(true);
  readonly ariaLabel = input('Promotion gates');

  readonly views = computed(() => gateRowViews(this.rows()));
  readonly counts = computed(() => gateOutcomeCounts(this.views()));
}
