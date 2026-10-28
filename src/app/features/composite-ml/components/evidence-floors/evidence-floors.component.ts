import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { ColdStartFloorRowDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

/**
 * The cold-start evidence floors of one part of the pipeline (global scope), from
 * `GET composite-ml/cold-start-report`: how much evidence each gate has against what it needs
 * before that part can produce anything. Shown on tabs whose output does not exist yet, so the
 * operator sees exactly how far each gate is from warm. Renders nothing when no floor matches.
 */
@Component({
  selector: 'app-composite-ml-evidence-floors',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink],
  template: `
    @if (rows().length) {
      <section class="card" [attr.aria-label]="title()">
        <header class="head">
          <h3>{{ title() }}</h3>
          <span class="sub"
            >{{ warmCount() }} of {{ rows().length }} warm · global scope ·
            <a routerLink="/composite-ml/cold-start">per pair on Cold-Start</a></span
          >
        </header>
        <table>
          <thead>
            <tr>
              <th>Gate</th>
              <th>What it waits for</th>
              <th class="num">Evidence</th>
              <th class="bar-col"></th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            @for (f of rows(); track f.layerKey) {
              <tr>
                <td class="mono">{{ f.layerKey }}</td>
                <td class="desc">{{ f.description }}</td>
                <td class="num">
                  {{ f.observed | number: '1.0-0' }} / {{ f.threshold | number: '1.0-0' }}
                </td>
                <td class="bar-col">
                  <span class="track"
                    ><span class="fill" [class.warm]="f.isWarm" [style.width.%]="pct(f)"></span
                  ></span>
                </td>
                <td>
                  <span class="pill" [class.warm]="f.isWarm">{{
                    f.isWarm ? 'warm' : f.observationsNeeded + ' more needed'
                  }}</span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4) var(--space-5);
        overflow-x: auto;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-1) var(--space-3);
        margin-bottom: var(--space-3);
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .sub a {
        color: var(--accent);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        text-align: left;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
      }
      th {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: 0.9em;
        white-space: nowrap;
      }
      .desc {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        min-width: 14rem;
      }
      .bar-col {
        width: 120px;
      }
      .track {
        display: block;
        height: 6px;
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        overflow: hidden;
      }
      .fill {
        display: block;
        height: 100%;
        background: var(--warning);
      }
      .fill.warm {
        background: var(--profit);
      }
      .pill {
        font-size: var(--text-xs);
        white-space: nowrap;
        color: var(--warning);
      }
      .pill.warm {
        color: var(--profit);
      }
    `,
  ],
})
export class CompositeMlEvidenceFloorsComponent {
  private readonly compositeMl = inject(CompositeMLService);

  /** Catalogue key prefixes to show, e.g. `['LayerSkillEvaluator.']`. */
  readonly prefixes = input.required<readonly string[]>();
  readonly title = input('Evidence this part needs');

  private readonly report = createPolledResource(
    () =>
      this.compositeMl.getColdStartReport().pipe(
        map((r) => r.data?.floors ?? []),
        catchError(() => of([] as ColdStartFloorRowDto[])),
      ),
    { intervalMs: 600_000 },
  );

  protected readonly rows = computed(() =>
    (this.report.value() ?? []).filter((f) =>
      this.prefixes().some((p) => f.layerKey.startsWith(p)),
    ),
  );
  protected readonly warmCount = computed(() => this.rows().filter((f) => f.isWarm).length);

  protected pct(f: ColdStartFloorRowDto): number {
    if (f.threshold <= 0) return f.isWarm ? 100 : 0;
    return Math.min(100, (f.observed / f.threshold) * 100);
  }
}
