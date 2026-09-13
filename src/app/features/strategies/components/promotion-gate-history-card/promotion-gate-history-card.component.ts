import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import type { CpcvDistributionDto, PromotionGateEvaluationDto } from '@core/api/api.types';
import { DecimalPipe } from '@angular/common';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * What the promotion gate actually decided, attempt by attempt.
 *
 * The readiness card above re-evaluates live, which is the right tool for "would this pass if I
 * activated it now". It cannot answer "what has the engine been doing", because two of the
 * outcomes the auto-promote phase produces are invisible to a live re-evaluation: a budget timeout
 * (no verdict was reached) and an evidence-unchanged skip (the gate deliberately did not run).
 *
 * Those were also, until now, invisible everywhere. The worker computed the verdict, logged it at
 * Debug, and discarded it — so strategy 653 sat Paused for a day while the single gate blocking it
 * was recomputed and thrown away twice an hour.
 */
@Component({
  selector: 'app-promotion-gate-history-card',
  standalone: true,
  imports: [RelativeTimePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-label="Promotion gate history">
      <header class="card-header">
        <div class="title">
          <h3>Gate attempt history</h3>
          <p class="subtitle">
            What the auto-promote phase recorded, newest first — including the outcomes a live
            re-evaluation cannot show.
          </p>
        </div>
        <button class="btn-refresh" (click)="reload()" [disabled]="loading()" type="button">
          ↻ Refresh
        </button>
      </header>

      @if (loading()) {
        <div class="skeleton">Loading attempts…</div>
      } @else if (errorMessage()) {
        <div class="banner error">{{ errorMessage() }}</div>
      } @else if (attempts().length === 0) {
        <div class="banner info">
          No gate attempts recorded yet. The auto-promote phase records one row per attempt —
          including rejections, timeouts and deliberate skips — so an empty list means the phase has
          not reached this strategy since recording was introduced.
        </div>
      } @else {
        <!-- The standing explanation comes first: on a page opened to ask "why is this stuck",
             the newest attempt IS the answer, and making the reader infer it from a list is the
             same failure as logging it at Debug. -->
        @if (latest(); as l) {
          <div [class]="'verdict ' + tone(l)">
            <div class="verdict-icon">{{ icon(l) }}</div>
            <div class="verdict-text">
              <strong>{{ headline(l) }}</strong>
              <span class="when">{{ l.evaluatedAtUtc | relativeTime }}</span>
              @if (!l.isVerdict) {
                <p class="caveat">
                  This attempt produced no verdict — the strategy has not been judged. That is not
                  the same as being rejected on merit.
                </p>
              }
            </div>
          </div>
        }

        <ol class="attempts">
          @for (a of attempts(); track a.id) {
            <li [class]="'attempt ' + tone(a)">
              <div class="attempt-head">
                <span [class]="'badge ' + tone(a)">{{ label(a) }}</span>
                <span class="ts" [title]="a.evaluatedAtUtc">
                  {{ a.evaluatedAtUtc | relativeTime }}
                </span>
                <span class="meta">
                  {{ a.durationMs }} ms
                  @if (a.budgetMs > 0) {
                    <span class="dim">of {{ a.budgetMs }} ms budget</span>
                  }
                  @if (a.backtestRunId !== null) {
                    <span class="dim">· backtest #{{ a.backtestRunId }}</span>
                  }
                  @if (a.timeoutCountAtAttempt > 0) {
                    <span class="dim">· {{ a.timeoutCountAtAttempt }} prior timeout(s)</span>
                  }
                  @if (a.trigger) {
                    <span class="dim">· {{ a.trigger }}</span>
                  }
                </span>
              </div>

              @if (a.failures.length > 0) {
                <ul class="failures">
                  @for (f of a.failures; track f) {
                    <li>{{ f }}</li>
                  }
                </ul>
              } @else if (a.failureSummary) {
                <p class="summary">{{ a.failureSummary }}</p>
              }

              <!-- CPCV in full. The gate reduced 66 train/test folds to five numbers in a
                   string, which cannot distinguish a tight cluster hugging zero from a wide
                   spread with the same quartile — and those call for opposite decisions. -->
              @if (a.cpcv; as c) {
                @if (c.sharpeDistribution.length > 0) {
                  <div class="cpcv">
                    <div class="cpcv-head">
                      <span class="cpcv-title">
                        CPCV · {{ c.nGroups }} groups, {{ c.kTestGroups }} held out ·
                        {{ c.sharpeDistribution.length }} folds
                      </span>
                      <span
                        [class]="'method ' + (c.method === 'BacktestReplay' ? 'gated' : 'diag')"
                      >
                        {{ methodLabel(c.method) }}
                      </span>
                    </div>

                    <!-- Each fold, sorted, as a bar. Bars below zero are the folds on which the
                         strategy lost money out of sample; their count and depth is the thing a
                         percentile hides. -->
                    <div class="hist" [attr.aria-label]="'Per-fold Sharpe distribution'">
                      @for (bar of bars(c); track $index) {
                        <span
                          class="bar"
                          [class.neg]="bar.negative"
                          [style.height.%]="bar.height"
                          [title]="bar.label"
                        ></span>
                      }
                    </div>

                    <dl class="cpcv-stats">
                      <div>
                        <dt>median</dt>
                        <dd>{{ c.medianSharpe | number: '1.3-3' }}</dd>
                      </div>
                      <div>
                        <dt>P25</dt>
                        <dd>{{ c.p25Sharpe | number: '1.3-3' }}</dd>
                      </div>
                      <div>
                        <dt>P75</dt>
                        <dd>{{ c.p75Sharpe | number: '1.3-3' }}</dd>
                      </div>
                      <div>
                        <dt>DSR</dt>
                        <dd>{{ c.deflatedSharpe | number: '1.3-3' }}</dd>
                      </div>
                      <div>
                        <dt>PBO</dt>
                        <dd>{{ c.probabilityOfOverfitting | number: '1.3-3' }}</dd>
                      </div>
                      <div>
                        <dt>folds &lt; 0</dt>
                        <dd>{{ negativeCount(c) }} / {{ c.sharpeDistribution.length }}</dd>
                      </div>
                    </dl>

                    @if (c.mlRetrainMedianSharpe !== null) {
                      <p class="cpcv-note">
                        Model-discrimination diagnostic (per-sample, not thresholded): median
                        {{ c.mlRetrainMedianSharpe | number: '1.3-3' }} over
                        {{ c.mlRetrainFolds }} fold(s). Not comparable with the gated per-trade
                        figure above.
                      </p>
                    }
                  </div>
                }
              }

              <!-- Every gate that ran, not only the ones that failed. A pass with no numbers
                   behind it is an assertion; with them it is evidence. -->
              @if (a.diagnostics.length > 0) {
                <details>
                  <summary>{{ a.diagnostics.length }} gate measurement(s)</summary>
                  <ul class="diagnostics">
                    @for (d of a.diagnostics; track d) {
                      <li>{{ d }}</li>
                    }
                  </ul>
                </details>
              }
            </li>
          }
        </ol>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        background: var(--surface, #fff);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 10px;
        padding: 16px;
      }
      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 14px;
      }
      h3 {
        margin: 0;
        font-size: 15px;
        font-weight: 650;
      }
      .subtitle {
        margin: 4px 0 0;
        font-size: 12px;
        color: var(--text-secondary, #6b7280);
        max-width: 70ch;
      }
      .btn-refresh {
        background: var(--surface-2, #f3f4f6);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 6px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
        color: inherit;
      }
      .btn-refresh:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .skeleton,
      .banner {
        padding: 12px;
        border-radius: 8px;
        font-size: 13px;
        background: var(--surface-2, #f3f4f6);
      }
      .banner.error {
        background: rgba(192, 57, 43, 0.1);
        color: var(--loss, #c0392b);
      }
      .banner.info {
        color: var(--text-secondary, #6b7280);
        max-width: 80ch;
      }

      .verdict {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 12px 14px;
        border-radius: 8px;
        margin-bottom: 14px;
        border-left: 3px solid var(--text-tertiary, #9ca3af);
        background: var(--surface-2, #f3f4f6);
      }
      .verdict.pass {
        border-left-color: var(--profit, #1f8a4c);
      }
      .verdict.fail {
        border-left-color: var(--loss, #c0392b);
      }
      .verdict.stall {
        border-left-color: #b45309;
      }
      .verdict-icon {
        font-size: 18px;
        line-height: 1.2;
      }
      .verdict-text strong {
        display: block;
        font-size: 13.5px;
      }
      .when {
        font-size: 12px;
        color: var(--text-secondary, #6b7280);
      }
      .caveat {
        margin: 6px 0 0;
        font-size: 12px;
        color: var(--text-secondary, #6b7280);
        max-width: 75ch;
      }

      ol.attempts {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .attempt {
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .attempt-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 8px;
      }
      .badge {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 650;
        background: var(--surface-2, #f3f4f6);
        color: var(--text-secondary, #6b7280);
      }
      .badge.pass {
        background: rgba(31, 138, 76, 0.14);
        color: var(--profit, #1f8a4c);
      }
      .badge.fail {
        background: rgba(192, 57, 43, 0.12);
        color: var(--loss, #c0392b);
      }
      .badge.stall {
        background: rgba(245, 158, 11, 0.16);
        color: #b45309;
      }
      .ts {
        font-size: 12px;
        color: var(--text-secondary, #6b7280);
      }
      .meta {
        font-size: 11.5px;
        color: var(--text-secondary, #6b7280);
        font-variant-numeric: tabular-nums;
      }
      .dim {
        color: var(--text-tertiary, #9ca3af);
      }

      .cpcv {
        margin-top: 10px;
        padding: 10px;
        border-radius: 8px;
        background: var(--surface-2, #f3f4f6);
      }
      .cpcv-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .cpcv-title {
        font-size: 12px;
        font-weight: 600;
      }
      .method {
        font-size: 10.5px;
        font-weight: 650;
        padding: 1px 7px;
        border-radius: 9999px;
      }
      .method.gated {
        background: rgba(59, 130, 246, 0.16);
        color: #1d4ed8;
      }
      .method.diag {
        background: rgba(120, 120, 128, 0.18);
        color: var(--text-secondary, #6b7280);
      }
      /* Bars grow from a shared baseline; negative folds hang below it in the loss colour. */
      .hist {
        display: flex;
        align-items: flex-end;
        gap: 1px;
        height: 56px;
        margin: 10px 0 8px;
        padding-bottom: 1px;
        border-bottom: 1px solid var(--border, #e5e7eb);
        overflow-x: auto;
      }
      .bar {
        flex: 1 0 3px;
        min-width: 3px;
        background: var(--profit, #1f8a4c);
        border-radius: 1px 1px 0 0;
        opacity: 0.85;
      }
      .bar.neg {
        background: var(--loss, #c0392b);
      }
      .cpcv-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 0;
      }
      .cpcv-stats > div {
        display: flex;
        gap: 5px;
        align-items: baseline;
      }
      .cpcv-stats dt {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-tertiary, #9ca3af);
      }
      .cpcv-stats dd {
        margin: 0;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .cpcv-note {
        margin: 8px 0 0;
        font-size: 11.5px;
        color: var(--text-secondary, #6b7280);
        max-width: 80ch;
      }

      ul.failures,
      ul.diagnostics {
        margin: 8px 0 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      ul.failures li {
        font-size: 12.5px;
        color: var(--loss, #c0392b);
      }
      ul.diagnostics li {
        font-size: 12px;
        color: var(--text-secondary, #6b7280);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        overflow-wrap: anywhere;
      }
      .summary {
        margin: 8px 0 0;
        font-size: 12.5px;
        color: var(--text-secondary, #6b7280);
        max-width: 80ch;
      }
      details {
        margin-top: 8px;
      }
      summary {
        font-size: 12px;
        cursor: pointer;
        color: var(--text-secondary, #6b7280);
      }
    `,
  ],
})
export class PromotionGateHistoryCardComponent {
  readonly strategyId = input.required<number>();

  private readonly strategies = inject(StrategiesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly attempts = signal<PromotionGateEvaluationDto[]>([]);

  readonly latest = computed(() => this.attempts()[0] ?? null);

  constructor() {
    effect(() => {
      const id = this.strategyId();
      if (id != null) this.load(id);
    });
  }

  reload(): void {
    const id = this.strategyId();
    if (id != null) this.load(id);
  }

  private load(id: number): void {
    this.loading.set(true);
    this.errorMessage.set(null);

    this.strategies
      .getPromotionGateHistory(id, 25)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (!res?.data) {
          this.errorMessage.set('Could not load the gate attempt history.');
          return;
        }
        this.attempts.set(res.data);
      });
  }

  /**
   * Three tones, not two. `stall` covers every outcome that produced no verdict — a timeout, a
   * deliberate skip, an error — because painting those red would assert a judgement the engine
   * never made.
   */
  tone(a: PromotionGateEvaluationDto): 'pass' | 'fail' | 'stall' {
    if (a.outcome === 'Passed') return 'pass';
    if (a.outcome === 'Rejected') return 'fail';
    return 'stall';
  }

  icon(a: PromotionGateEvaluationDto): string {
    const t = this.tone(a);
    return t === 'pass' ? '✓' : t === 'fail' ? '✗' : '⏱';
  }

  label(a: PromotionGateEvaluationDto): string {
    switch (a.outcome) {
      case 'Passed':
        return 'Passed';
      case 'Rejected':
        return 'Rejected';
      case 'TimedOut':
        return 'Timed out';
      case 'SkippedEvidenceUnchanged':
        return 'Skipped — evidence unchanged';
      case 'Errored':
        return 'Errored';
      default:
        return a.outcome;
    }
  }

  methodLabel(method: string): string {
    return method === 'BacktestReplay'
      ? 'per-trade · gated'
      : method === 'MlRetrainPerFold'
        ? 'per-sample · diagnostic'
        : method;
  }

  negativeCount(c: CpcvDistributionDto): number {
    return c.sharpeDistribution.filter((v) => v < 0).length;
  }

  /**
   * One bar per fold, sorted ascending, scaled to the largest absolute Sharpe so the shape of the
   * distribution is visible rather than its absolute level. A floor of 2% keeps a near-zero fold
   * from rendering as nothing at all — "this fold scored ~0" and "this fold is missing" must not
   * look the same.
   */
  bars(c: CpcvDistributionDto): Array<{ height: number; negative: boolean; label: string }> {
    const values = [...c.sharpeDistribution].sort((a, b) => a - b);
    const peak = Math.max(...values.map((v) => Math.abs(v)), 1e-9);
    return values.map((v, i) => ({
      height: Math.max(2, (Math.abs(v) / peak) * 100),
      negative: v < 0,
      label: `fold ${i + 1}: Sharpe ${v.toFixed(3)}`,
    }));
  }

  headline(a: PromotionGateEvaluationDto): string {
    switch (a.outcome) {
      case 'Passed':
        return 'All gates passed — promoted to Approved';
      case 'Rejected':
        return `Rejected by ${a.failures.length || 1} gate(s)`;
      case 'TimedOut':
        return 'Gate evaluation ran out of budget — never judged';
      case 'SkippedEvidenceUnchanged':
        return 'Not re-evaluated — evidence unchanged since the last rejection';
      case 'Errored':
        return 'Gate evaluation threw — never judged';
      default:
        return a.outcome;
    }
  }
}
