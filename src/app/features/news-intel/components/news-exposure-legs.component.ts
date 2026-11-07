import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { fmt, pct, signed } from '../news-intel.logic';
import { NewsFocusResult } from '../news-intel.types';

/**
 * The exposure legs of a focused symbol (ADR-0035): weight, basis, tracked or not, score and
 * contribution, plus symbolBias and coverage exactly as the engine computed them. An untracked leg
 * has no score — it is shown as "not tracked", never as 0 — and a null symbolBias is explained, not
 * replaced by a number.
 */
@Component({
  selector: 'app-news-exposure-legs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (legs().length) {
      <div class="xl">
        <div class="xl-head">
          <span class="t">Exposure legs</span>
          <span class="muted"
            >coverage <strong>{{ pct(ctx()?.coverage) }}</strong> · symbol bias
            <strong
              [class.pos]="(ctx()?.symbolBias ?? 0) > 0.02"
              [class.neg]="(ctx()?.symbolBias ?? 0) < -0.02"
              >{{
                ctx()?.symbolBias === null || ctx()?.symbolBias === undefined
                  ? 'n/a'
                  : signed(ctx()?.symbolBias)
              }}</strong
            >
            @if (focus()?.exposure; as e) {
              · resolved from {{ e.source }}
            }
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th class="n">Weight</th>
              <th>Basis</th>
              <th class="n">Score</th>
              <th class="n">Contribution</th>
              <th class="n">In play</th>
              <th class="n">Stories</th>
            </tr>
          </thead>
          <tbody>
            @for (l of legs(); track l.key) {
              <tr [class.untracked]="!l.covered">
                <td class="mono">{{ l.key }}</td>
                <td class="n mono">{{ signed(l.weight, 2) }}</td>
                <td>{{ l.basis }}</td>
                @if (l.covered) {
                  <td
                    class="n mono"
                    [class.pos]="(l.score ?? 0) > 0.02"
                    [class.neg]="(l.score ?? 0) < -0.02"
                  >
                    {{ signed(l.score) }}
                  </td>
                  <td class="n mono">{{ signed(l.contribution) }}</td>
                  <td class="n mono">{{ fmt(l.absolutePressure) }}</td>
                  <td class="n mono">{{ l.storyCount ?? '—' }}</td>
                } @else {
                  <td colspan="4" class="muted">
                    not tracked — no score (<a routerLink="/news-intel/exposures">track it</a>)
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
        @if (ctx()?.symbolBias === null || ctx()?.symbolBias === undefined) {
          <p class="muted note">
            Symbol bias is null on purpose: a main leg (weight ±1) is untracked or nothing is
            covered, and a number would claim coverage that does not exist.
          </p>
        }
        @if (focus()?.exposure?.calendarKeys?.length) {
          <p class="muted note">
            Calendar keys: {{ focus()!.exposure!.calendarKeys.join(', ') }} —
            <a routerLink="/news-intel/coverage">blackout per symbol</a>
          </p>
        }
      </div>
    }
  `,
  styles: [
    `
      .xl {
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow-x: auto;
      }
      .xl-head {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: baseline;
        font-size: var(--text-sm);
      }
      .t {
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-secondary);
      }
      table {
        border-collapse: collapse;
        font-size: var(--text-xs);
        width: 100%;
      }
      th,
      td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
      }
      th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .n {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      tr.untracked td:first-child {
        color: var(--text-secondary);
        text-decoration: underline dashed;
      }
      .pos {
        color: var(--profit);
      }
      .neg {
        color: var(--loss);
      }
      .note {
        font-size: var(--text-xs);
        margin: 0;
      }
    `,
  ],
})
export class NewsExposureLegsComponent {
  readonly focus = input<NewsFocusResult | null>(null);
  readonly ctx = computed(() => this.focus()?.context ?? null);
  readonly legs = computed(() => this.ctx()?.legs ?? []);

  protected readonly fmt = fmt;
  protected readonly pct = pct;
  protected readonly signed = signed;
}
