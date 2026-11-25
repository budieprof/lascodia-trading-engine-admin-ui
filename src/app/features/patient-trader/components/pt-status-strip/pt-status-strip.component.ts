import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PercentPipe } from '@angular/common';

import type { PatientTraderBoard } from '@features/patient-trader/patient-trader.types';
import { MIN_SAMPLE, codeWords, formatR } from '@features/patient-trader/patient-trader.logic';

/**
 * The counters strip — the numbers that decide whether the module is working, each with the
 * sample behind it.
 *
 * Expectancy is the mean R of REAL trades only (paper walks used to be mixed in and flattered it);
 * "refused" counts what the gates turned down, and the replay of those cards says whether turning
 * them down cost anything.
 */
@Component({
  selector: 'app-pt-status-strip',
  standalone: true,
  imports: [PercentPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (board(); as b) {
      <section class="card status-card" aria-label="How the agent is doing">
        <div class="row">
          <span class="phase-pill" [class.armed]="b.counters.armedPlans > 0">
            {{ b.counters.armedPlans > 0 ? b.counters.armedPlans + ' armed' : 'Nothing armed' }}
          </span>
          <span class="muted small">
            {{ b.counters.activeMarkets }} market{{
              b.counters.activeMarkets === 1 ? '' : 's'
            }}
            followed · counters cover the last {{ b.windowDays || 7 }} days
          </span>
        </div>

        <dl class="counters">
          <div>
            <dt>View accuracy</dt>
            <dd>
              {{
                b.counters.viewAccuracy !== null
                  ? (b.counters.viewAccuracy | percent: '1.0-1')
                  : '—'
              }}
            </dd>
            <span class="sub">n = {{ b.counters.viewsScored }} views</span>
          </div>
          <div>
            <dt>No view given</dt>
            <dd>{{ b.counters.viewsAbstained }}</dd>
          </div>
          <div
            title="Entries reached ÷ (reached + ran out of time + called off before entry). Measures whether the agent's entry levels are ones the market actually visits."
          >
            <dt>Fill rate</dt>
            <dd>
              {{ b.counters.fillRate !== null ? (b.counters.fillRate | percent: '1.0-1') : '—' }}
            </dd>
            <span class="sub"
              >{{ b.counters.entryNotReachedCount }} never reached ·
              {{ b.counters.invalidatedCount }} called off</span
            >
          </div>
          <div title="Mean R of real trades that have closed. Paper walks are not counted.">
            <dt>Expectancy</dt>
            <dd [class.pos]="pos()" [class.neg]="neg()">{{ expectancy() }}</dd>
            <span class="sub">{{ expectancySample() }}</span>
          </div>
          <div>
            <dt>Plans</dt>
            <dd>{{ b.counters.plansLast7Days }}</dd>
            <span class="sub">{{ b.counters.settledLast7Days }} settled</span>
          </div>
          <div
            title="Cards the checks refused, replayed over the candles afterwards to see what they would have done"
          >
            <dt>Refused, replayed</dt>
            <dd>{{ b.counters.refusalsScored }}</dd>
            <span class="sub">{{ b.counters.forgoneWinners }} would have hit target</span>
          </div>
          @if (isClassic()) {
            <div title="Classic engine only: accepted plans whose stop sat right at the minimum">
              <dt>Stops at floor</dt>
              <dd [class.warn-text]="b.counters.nearFloorCount > 0">
                {{ b.counters.nearFloorCount }}
              </dd>
            </div>
          }
        </dl>

        <div class="row small">
          <span class="muted">Turned down:</span>
          <span class="tag">{{ b.counters.declinedLast7Days }} passed on by the agent</span>
          <span
            class="tag"
            title="Cards whose watch fired but the signal was refused at that moment"
            >{{ b.counters.refusedAtFire }} refused when they fired</span
          >
          @for (c of codes(); track c.code) {
            <span class="tag warn" [title]="c.code">{{ c.words }} · {{ c.count }}</span>
          } @empty {
            <span class="muted">no refusals by the checks</span>
          }
        </div>

        <p class="muted small">
          <b>View accuracy</b> asks whether the agent reads the market at all, before any money is
          involved. <b>Fill rate</b> asks whether its entries are ever reached — good-looking plans
          at levels the market never visits are the failure that looks like success.
          <b>Expectancy</b> is real trades only; under {{ minSample }} it is too few to judge.
        </p>
      </section>
    }
  `,
  styleUrls: ['../pt-common.css'],
  styles: [
    `
      .status-card {
        gap: var(--space-4);
      }
      .phase-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 3px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .phase-pill.armed {
        background: color-mix(in srgb, var(--accent) 15%, transparent);
        color: var(--accent);
      }
      .counters {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(128px, 100%), 1fr));
        gap: var(--space-4) var(--space-3);
        margin: 0;
      }
      .counters div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .counters dt {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .counters dd {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .sub {
        font-size: 10.5px;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class PtStatusStripComponent {
  readonly board = input<PatientTraderBoard | null>(null);
  /** The analysis engine in use; the "stops at floor" counter only means something on Classic. */
  readonly engine = input<string | null>(null);

  protected readonly minSample = MIN_SAMPLE;
  protected readonly isClassic = computed(() => this.engine() === 'Classic');

  protected readonly expectancy = computed(() => {
    const c = this.board()?.counters;
    if (!c || !c.tradesSettled) return '—';
    return formatR(c.meanRMultiple);
  });
  protected readonly expectancySample = computed(() => {
    const n = this.board()?.counters.tradesSettled ?? 0;
    const base = `n = ${n} real trade${n === 1 ? '' : 's'}`;
    return n > 0 && n < MIN_SAMPLE ? `${base} · too few to judge` : base;
  });
  protected readonly pos = computed(() => {
    const c = this.board()?.counters;
    return !!c?.tradesSettled && (c.meanRMultiple ?? 0) > 0;
  });
  protected readonly neg = computed(() => {
    const c = this.board()?.counters;
    return !!c?.tradesSettled && (c.meanRMultiple ?? 0) < 0;
  });

  /** Refusals by reason, largest first. */
  protected readonly codes = computed(() =>
    Object.entries(this.board()?.counters.rejectedByCode ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count, words: codeWords(code) })),
  );
}
