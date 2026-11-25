import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { PatientTraderService } from '@core/services/patient-trader.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { PatientTraderRStats } from '@features/patient-trader/patient-trader.types';
import {
  MIN_SAMPLE,
  codeWords,
  formatR,
  hasNum,
  linePath,
  outcomeWords,
} from '@features/patient-trader/patient-trader.logic';

/**
 * Measured results over a chosen window: real trades (and the same trades held to their written
 * levels), the break-even measurement, what the refused cards would have done, and whether the
 * views beat a naive baseline. Every figure carries its sample size; small samples say so.
 *
 * Neutral on purpose — the break-even section is measurement for the operator's keep-or-change
 * decision, not a recommendation.
 */
@Component({
  selector: 'app-pt-results-panel',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Results">
      <div class="row">
        <h2>Results</h2>
        <span class="spacer"></span>
        <div class="seg" role="group" aria-label="Window">
          @for (d of dayOptions; track d) {
            <button type="button" [attr.aria-pressed]="days() === d" (click)="setDays(d)">
              {{ d }} days
            </button>
          }
        </div>
        <select
          aria-label="Market"
          [ngModel]="symbol() ?? ''"
          (ngModelChange)="setSymbol($event)"
          name="results-symbol"
        >
          <option value="">All markets</option>
          @for (s of symbols(); track s) {
            <option [value]="s">{{ s }}</option>
          }
        </select>
      </div>

      @if (res.error() && !res.value()) {
        <p class="muted small">Could not load results.</p>
      } @else if (res.value(); as r) {
        <!-- Real trades -->
        <div class="block">
          <h3>Real trades</h3>
          <table class="stats">
            <thead>
              <tr>
                <th></th>
                <th class="n">Trades</th>
                <th class="n">Won / lost / flat</th>
                <th class="n">Mean R</th>
                <th class="n">95% range</th>
                <th class="n">Total R</th>
              </tr>
            </thead>
            <tbody>
              @for (row of tradeRows(); track row.label) {
                <tr>
                  <th scope="row">
                    {{ row.label }}
                    @if (row.hint) {
                      <span class="muted small"> — {{ row.hint }}</span>
                    }
                  </th>
                  <td class="n">{{ row.s.count }}</td>
                  <td class="n">{{ row.s.wins }} / {{ row.s.losses }} / {{ row.s.scratches }}</td>
                  <td
                    class="n"
                    [class.pos]="(row.s.meanR ?? 0) > 0"
                    [class.neg]="(row.s.meanR ?? 0) < 0"
                  >
                    {{ r_(row.s.meanR) }}
                  </td>
                  <td class="n muted">{{ ci(row.s) }}</td>
                  <td class="n">{{ r_(row.s.sumR) }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="muted small">
            {{ sampleNote(r.trades.count) }} "As written" is the same trades held to the stop and
            target they were written with, ignoring any later stop move. Paper fills are plans
            walked over the candles with no real position, shown for comparison only.
          </p>
          @if (curve(); as c) {
            <figure class="curve" aria-label="Cumulative R of real trades">
              <svg [attr.viewBox]="'0 0 ' + chartW + ' ' + chartH" preserveAspectRatio="none">
                <line
                  x1="0"
                  [attr.x2]="chartW"
                  [attr.y1]="c.zeroY"
                  [attr.y2]="c.zeroY"
                  class="zero"
                />
                <path [attr.d]="c.d" class="line" [class.down]="c.last < 0" />
              </svg>
              <figcaption class="muted small">
                Cumulative R, trade by trade ({{ r.equity.length }} trades) — ends at
                {{ r_(c.last) }}, lowest {{ r_(c.min) }}, highest {{ r_(c.max) }}
              </figcaption>
            </figure>
          }
        </div>

        <!-- Break-even -->
        <div class="block">
          <h3>Stopped at break-even</h3>
          @if (r.breakEven.count === 0) {
            <p class="muted small">No trade was stopped at break-even in this window.</p>
          } @else {
            <p class="small">
              {{ r.breakEven.count }} trade{{ r.breakEven.count === 1 ? ' was' : 's were' }} closed
              at break-even after the stop was moved. On average they had reached
              <b>{{ r_(r.breakEven.meanMfeR) }}</b> in their favour first. Together they made
              <b>{{ r_(r.breakEven.realSumR) }}</b
              >.
            </p>
            <p class="small">
              Held to their original levels ({{ r.breakEven.replayed }} of
              {{ r.breakEven.count }} could be replayed): {{ r.breakEven.asWrittenHitTp }} would
              have hit target, {{ r.breakEven.asWrittenHitSl }} would have hit the original stop,
              {{ r.breakEven.asWrittenOther }} neither — <b>{{ r_(r.breakEven.asWrittenSumR) }}</b>
              in total.
            </p>
            <p class="muted small">
              {{ sampleNote(r.breakEven.replayed) }} This is a measurement to inform keeping or
              changing the break-even rule; it is not a recommendation either way.
            </p>
            <details>
              <summary class="small">The {{ r.breakEven.trades.length }} trades</summary>
              <table class="stats">
                <thead>
                  <tr>
                    <th>Closed</th>
                    <th>Card</th>
                    <th class="n">Real R</th>
                    <th class="n">Best R reached</th>
                    <th>Held as written</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of r.breakEven.trades; track t.planId) {
                    <tr>
                      <td class="nowrap">
                        {{ t.settledAtUtc ? (t.settledAtUtc | date: 'dd MMM HH:mm') : '—' }}
                      </td>
                      <td class="nowrap">
                        <span
                          [class.pos]="t.direction === 'Buy'"
                          [class.neg]="t.direction === 'Sell'"
                          >{{ t.direction }}</span
                        >
                        @if (t.recommendationId) {
                          <a
                            class="tag"
                            [routerLink]="['/trade-recommendations', t.recommendationId]"
                            >card #{{ t.recommendationId }}</a
                          >
                        } @else {
                          <span class="muted"> plan {{ t.planId }}</span>
                        }
                      </td>
                      <td class="n">{{ r_(t.realR) }}</td>
                      <td class="n">{{ r_(t.mfeR) }}</td>
                      <td>
                        {{ t.asWrittenOutcome ? words(t.asWrittenOutcome) : 'not replayed' }}
                        @if (hasNum(t.asWrittenR)) {
                          · {{ r_(t.asWrittenR) }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </details>
          }
        </div>

        <!-- Refused cards -->
        <div class="block">
          <h3>Refused cards, replayed</h3>
          @if (r.refused.scored === 0) {
            <p class="muted small">No refused card has been replayed in this window yet.</p>
          } @else {
            <p class="small">
              {{ r.refused.scored }} refused card{{ r.refused.scored === 1 ? '' : 's' }} replayed:
              {{ r.refused.hitTp }} would have hit target, {{ r.refused.hitSl }} would have hit
              stop, {{ r.refused.other }} neither — net <b>{{ r_(r.refused.sumR) }}</b
              >.
              {{ sampleNote(r.refused.scored) }}
            </p>
            @if (r.refused.byCode.length > 0) {
              <table class="stats">
                <thead>
                  <tr>
                    <th>Refused because</th>
                    <th class="n">Replayed</th>
                    <th class="n">Hit target</th>
                    <th class="n">Hit stop</th>
                    <th class="n">Net R</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of r.refused.byCode; track c.code) {
                    <tr>
                      <td [title]="c.code">{{ codeWords(c.code) }}</td>
                      <td class="n">{{ c.scored }}</td>
                      <td class="n">{{ c.hitTp }}</td>
                      <td class="n">{{ c.hitSl }}</td>
                      <td class="n" [class.pos]="c.sumR > 0" [class.neg]="c.sumR < 0">
                        {{ r_(c.sumR) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          }
        </div>

        <!-- Views -->
        <div class="block">
          <h3>Does it read the market?</h3>
          <table class="stats">
            <thead>
              <tr>
                <th></th>
                <th class="n">Scored</th>
                <th class="n">Right</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">All views</th>
                <td class="n">{{ r.views.correct + r.views.wrong }}</td>
                <td class="n">{{ pct(r.views.accuracy) }}</td>
              </tr>
              <tr>
                <th scope="row">Buy views</th>
                <td class="n">{{ r.views.buyScored }}</td>
                <td class="n">{{ pct(r.views.buyAccuracy) }}</td>
              </tr>
              <tr>
                <th scope="row">Sell views</th>
                <td class="n">{{ r.views.sellScored }}</td>
                <td class="n">{{ pct(r.views.sellAccuracy) }}</td>
              </tr>
              <tr>
                <th scope="row">The agent, on views the baseline could be scored on</th>
                <td class="n">{{ r.views.baselineScored }}</td>
                <td class="n">{{ pct(r.views.accuracyOnBaselineViews) }}</td>
              </tr>
              <tr>
                <th scope="row">Baseline: "the last day's move continues", same views</th>
                <td class="n">{{ r.views.baselineScored }}</td>
                <td class="n">{{ pct(r.views.baselineAccuracy) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted small">
            {{ r.views.flat }} ended flat, {{ r.views.abstained }} gave no view,
            {{ r.views.unscorable }} could not be scored. The agent only adds something if it beats
            the baseline on the same views. {{ sampleNote(r.views.baselineScored) }}
          </p>
        </div>
      } @else {
        <p class="muted small">Loading…</p>
      }
    </section>
  `,
  styleUrls: ['../pt-common.css'],
  styles: [
    `
      .block {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
      }
      table.stats {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .stats th,
      .stats td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
        font-weight: normal;
      }
      .stats thead th {
        color: var(--text-tertiary);
        text-transform: uppercase;
        font-size: 10.5px;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .stats .n {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .nowrap {
        white-space: nowrap;
      }
      .curve {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .curve svg {
        width: 100%;
        height: 64px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .curve .zero {
        stroke: var(--border);
        stroke-dasharray: 3 3;
        vector-effect: non-scaling-stroke;
      }
      .curve .line {
        fill: none;
        stroke: var(--profit, #15803d);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      .curve .line.down {
        stroke: var(--loss, #b91c1c);
      }
      details summary {
        cursor: pointer;
        color: var(--accent);
      }
    `,
  ],
})
export class PtResultsPanelComponent {
  private readonly svc = inject(PatientTraderService);

  /** Markets offered in the selector (the followed ones). */
  readonly symbols = input<string[]>([]);

  protected readonly dayOptions = [7, 30, 90] as const;
  protected readonly days = signal<number>(30);
  protected readonly symbol = signal<string | null>(null);

  protected readonly res = createPolledResource(
    () => this.svc.getResults(this.days(), this.symbol()),
    {
      intervalMs: 600_000,
      refreshOn: ['patientTraderChanged'],
      refreshDebounceMs: 2_000,
      key: () => [this.days(), this.symbol()],
    },
  );

  protected readonly chartW = 300;
  protected readonly chartH = 64;

  protected readonly hasNum = hasNum;
  protected readonly codeWords = codeWords;
  protected readonly words = outcomeWords;

  protected setDays(d: number): void {
    if (d === this.days()) return;
    this.days.set(d);
    this.res.refresh();
  }

  protected setSymbol(s: string): void {
    const next = s || null;
    if (next === this.symbol()) return;
    this.symbol.set(next);
    this.res.refresh();
  }

  protected r_(v: number | null | undefined): string {
    return formatR(v);
  }

  protected pct(v: number | null | undefined): string {
    return hasNum(v) ? `${(v * 100).toFixed(0)}%` : '—';
  }

  protected ci(s: PatientTraderRStats): string {
    if (!hasNum(s.ci95Low) || !hasNum(s.ci95High)) return '—';
    return `${formatR(s.ci95Low)} to ${formatR(s.ci95High)}`;
  }

  /** "Too few to judge" under the minimum sample; nothing otherwise. */
  protected sampleNote(n: number): string {
    if (n === 0) return 'Nothing measured yet.';
    return n < MIN_SAMPLE ? `${n} is too few to judge.` : '';
  }

  protected readonly tradeRows = computed(() => {
    const r = this.res.value();
    if (!r) return [];
    return [
      { label: 'All', hint: '', s: r.trades },
      { label: 'Buy', hint: '', s: r.tradesBuy },
      { label: 'Sell', hint: '', s: r.tradesSell },
      { label: 'As written', hint: 'same trades, original levels', s: r.asWritten },
      { label: 'Paper fills', hint: 'no real position', s: r.paperFills },
    ];
  });

  protected readonly curve = computed(() => {
    const eq = this.res.value()?.equity ?? [];
    const values = eq.map((p) => p.cumR);
    const path = linePath([0, ...values], this.chartW, this.chartH);
    if (!path) return null;
    return { ...path, last: values[values.length - 1] ?? 0 };
  });
}
