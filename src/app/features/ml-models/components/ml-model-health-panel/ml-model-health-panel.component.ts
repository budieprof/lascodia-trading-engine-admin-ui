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
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type { MLModelDto, MLModelLifecycleLogEntryDto } from '@core/api/api.types';

interface QualityWarning {
  level: 'warn' | 'critical';
  title: string;
  detail: string;
}

@Component({
  selector: 'app-ml-model-health-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  template: `
    <section class="card" aria-label="Model health">
      <header class="card-header">
        <div>
          <h3>Model health</h3>
          <p class="subtitle">
            Quality breakdown, walk-forward stability, and the engine's lifecycle reasoning.
          </p>
        </div>
        @if (warnings().length > 0) {
          <span class="warning-pill"
            >{{ warnings().length }} warning{{ warnings().length === 1 ? '' : 's' }}</span
          >
        }
      </header>

      @if (warnings().length > 0) {
        <div class="warnings">
          @for (w of warnings(); track w.title) {
            <div [class]="'warning ' + w.level">
              <strong>{{ w.title }}</strong>
              <span class="muted">{{ w.detail }}</span>
            </div>
          }
        </div>
      }

      <div class="grid">
        <!-- Quality metrics column -->
        <div class="block">
          <h4>Validation metrics</h4>
          <dl class="kv">
            <dt>Direction accuracy</dt>
            <dd
              class="num"
              [class.good]="hi(model().directionAccuracy, 0.55)"
              [class.bad]="lo(model().directionAccuracy, 0.5)"
            >
              {{ pct(model().directionAccuracy) }}
            </dd>

            <dt>F1 score</dt>
            <dd
              class="num"
              [class.bad]="lo(model().f1Score, 0.1)"
              [class.warn]="
                model().f1Score !== null && model().f1Score! < 0.3 && model().f1Score! >= 0.1
              "
            >
              {{ num(model().f1Score, 4) }}
            </dd>

            <dt>Brier score <span class="hint">(lower is better)</span></dt>
            <dd class="num" [class.bad]="hi(model().brierScore, 0.25)">
              {{ num(model().brierScore, 4) }}
            </dd>

            <dt>Sharpe ratio</dt>
            <dd
              class="num"
              [class.good]="hi(model().sharpeRatio, 0.5)"
              [class.bad]="lo(model().sharpeRatio, 0)"
            >
              {{ num(model().sharpeRatio, 3) }}
            </dd>

            <dt>Expected value</dt>
            <dd
              class="num"
              [class.good]="hi(model().expectedValue, 0)"
              [class.bad]="lo(model().expectedValue, 0)"
            >
              {{ num(model().expectedValue, 4) }}
            </dd>

            @if (model().fragilityScore !== null) {
              <dt>Fragility <span class="hint">(0=robust, 1=fragile)</span></dt>
              <dd
                class="num"
                [class.bad]="hi(model().fragilityScore, 0.5)"
                [class.warn]="
                  model().fragilityScore !== null &&
                  model().fragilityScore! >= 0.3 &&
                  model().fragilityScore! < 0.5
                "
              >
                {{ num(model().fragilityScore, 3) }}
              </dd>
            }
          </dl>
        </div>

        <!-- Walk-forward column -->
        <div class="block">
          <h4>Walk-forward CV</h4>
          @if (model().walkForwardFolds === null || model().walkForwardFolds === 0) {
            <p class="muted">No walk-forward folds were evaluated for this model.</p>
          } @else {
            <dl class="kv">
              <dt>Folds</dt>
              <dd class="num">{{ model().walkForwardFolds }}</dd>

              <dt>Mean OOS accuracy</dt>
              <dd
                class="num"
                [class.good]="hi(model().walkForwardAvgAccuracy, 0.55)"
                [class.bad]="lo(model().walkForwardAvgAccuracy, 0.5)"
              >
                {{ pct(model().walkForwardAvgAccuracy) }}
              </dd>

              <dt>Std dev across folds</dt>
              <dd class="num">{{ num(model().walkForwardStdDev, 4) }}</dd>

              <dt>OOS drop from validation</dt>
              <dd class="num" [class.bad]="oosDropPp() !== null && oosDropPp()! > 8">
                {{
                  oosDropPp() === null
                    ? '—'
                    : (oosDropPp()! >= 0 ? '−' : '+') + (oosDropPp() | number: '1.1-1') + ' pp'
                }}
              </dd>
            </dl>
          }
        </div>

        <!-- Lifecycle timeline column -->
        <div class="block lifecycle">
          <h4>
            Lifecycle
            @if (lifecycleLoading()) {
              <span class="muted">· loading…</span>
            }
          </h4>
          @if (lifecycleError()) {
            <p class="muted">{{ lifecycleError() }}</p>
          } @else if (lifecycle().length === 0 && !lifecycleLoading()) {
            <p class="muted">No lifecycle events recorded yet.</p>
          } @else {
            <ol class="timeline">
              @for (e of lifecycle(); track e.id) {
                <li [class]="'evt evt-' + classifyEvent(e.eventType)">
                  <div class="evt-head">
                    <span class="badge">{{ e.eventType }}</span>
                    <time class="muted">{{ e.occurredAt | date: 'yyyy-MM-dd HH:mm' }}</time>
                  </div>
                  @if (e.previousStatus || e.newStatus) {
                    <div class="transition mono">
                      {{ e.previousStatus || '—' }} → {{ e.newStatus || '—' }}
                    </div>
                  }
                  @if (e.reason) {
                    <p class="reason">{{ e.reason }}</p>
                  }
                  @if (
                    e.directionAccuracyAtTransition !== null ||
                    e.liveAccuracyAtTransition !== null ||
                    e.brierScoreAtTransition !== null
                  ) {
                    <div class="kvi">
                      @if (e.directionAccuracyAtTransition !== null) {
                        <span class="kvi-pair">
                          <span class="k">acc@</span>
                          <span class="v">{{ pct(e.directionAccuracyAtTransition) }}</span>
                        </span>
                      }
                      @if (e.liveAccuracyAtTransition !== null) {
                        <span class="kvi-pair">
                          <span class="k">live</span>
                          <span class="v">{{ pct(e.liveAccuracyAtTransition) }}</span>
                        </span>
                      }
                      @if (e.brierScoreAtTransition !== null) {
                        <span class="kvi-pair">
                          <span class="k">brier</span>
                          <span class="v">{{ num(e.brierScoreAtTransition, 4) }}</span>
                        </span>
                      }
                    </div>
                  }
                </li>
              }
            </ol>
          }
        </div>
      </div>

      @if (model().isSuppressed || model().isFallbackChampion) {
        <div class="flags">
          @if (model().isSuppressed) {
            <span class="flag flag-warn">Suppressed</span>
          }
          @if (model().isFallbackChampion) {
            <span class="flag flag-info">Fallback champion</span>
          }
        </div>
      }
    </section>
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
        padding: var(--card-padding, var(--space-5));
        box-shadow: var(--shadow-sm);
      }
      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
        margin-bottom: var(--space-4);
      }
      h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .subtitle {
        margin: var(--space-1) 0 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .warning-pill {
        background: rgba(245, 158, 11, 0.15);
        color: #b45309;
        padding: 2px var(--space-2);
        border-radius: 9999px;
        font-size: var(--text-xs);
        font-weight: 600;
      }
      .warnings {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        margin-bottom: var(--space-4);
      }
      .warning {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        border: 1px solid;
        font-size: var(--text-sm);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .warning.warn {
        background: rgba(245, 158, 11, 0.08);
        border-color: rgba(245, 158, 11, 0.3);
        color: #92400e;
      }
      .warning.critical {
        background: rgba(239, 68, 68, 0.08);
        border-color: rgba(239, 68, 68, 0.3);
        color: #b91c1c;
      }
      .warning strong {
        font-weight: 600;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1.4fr;
        gap: var(--space-5);
      }
      @media (max-width: 900px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .block {
        min-width: 0;
      }
      dl.kv {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--space-2) var(--space-4);
        margin: 0;
      }
      dl.kv dt {
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      dl.kv dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-medium);
        color: var(--text-primary);
        text-align: right;
      }
      .hint {
        color: var(--text-tertiary, #999);
        font-size: 0.85em;
      }
      .num.good {
        color: var(--profit, #15803d);
      }
      .num.bad {
        color: var(--loss, #b91c1c);
      }
      .num.warn {
        color: #b45309;
      }
      ol.timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .evt {
        border-left: 3px solid var(--border);
        padding-left: var(--space-3);
      }
      .evt-activation,
      .evt-promotion {
        border-left-color: #22c55e;
      }
      .evt-supersession,
      .evt-suppression {
        border-left-color: #f59e0b;
      }
      .evt-degradationretirement,
      .evt-rollback {
        border-left-color: #ef4444;
      }
      .evt-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
      }
      .badge {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 9999px;
        font-size: var(--text-xs);
        font-weight: 600;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .transition {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-top: 2px;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, Menlo, monospace);
      }
      .reason {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        line-height: 1.45;
        color: var(--text-primary);
      }
      .kvi {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }
      .kvi-pair {
        display: inline-flex;
        gap: 4px;
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 3px;
        font-size: var(--text-xs);
      }
      .kvi-pair .k {
        color: var(--text-secondary);
      }
      .kvi-pair .v {
        font-weight: var(--font-medium);
      }
      .flags {
        margin-top: var(--space-4);
        display: flex;
        gap: var(--space-2);
      }
      .flag {
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: var(--text-xs);
        font-weight: 600;
      }
      .flag-warn {
        background: rgba(245, 158, 11, 0.15);
        color: #b45309;
      }
      .flag-info {
        background: rgba(59, 130, 246, 0.15);
        color: #1d4ed8;
      }
    `,
  ],
})
export class MLModelHealthPanelComponent {
  private readonly mlModels = inject(MLModelsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly model = input.required<MLModelDto>();

  readonly lifecycle = signal<MLModelLifecycleLogEntryDto[]>([]);
  readonly lifecycleLoading = signal(false);
  readonly lifecycleError = signal<string | null>(null);

  /** Validation accuracy − walk-forward mean accuracy, in percentage points. */
  readonly oosDropPp = computed(() => {
    const m = this.model();
    if (m.directionAccuracy === null || m.walkForwardAvgAccuracy === null) return null;
    return (m.directionAccuracy - m.walkForwardAvgAccuracy) * 100;
  });

  /**
   * Static interpretation rules for the metric panel — surface the gotchas an
   * operator would otherwise need to derive themselves (F1 vs accuracy, OOS
   * drop, fragility, calibration). Each rule produces at most one warning.
   */
  readonly warnings = computed<QualityWarning[]>(() => {
    const m = this.model();
    const out: QualityWarning[] = [];

    // F1 vs accuracy mismatch — class imbalance signature.
    if (
      m.f1Score !== null &&
      m.directionAccuracy !== null &&
      m.f1Score < 0.1 &&
      m.directionAccuracy > 0.55
    ) {
      out.push({
        level: 'critical',
        title: 'F1 / accuracy mismatch — likely class imbalance',
        detail: `F1 ${m.f1Score.toFixed(3)} alongside accuracy ${(m.directionAccuracy * 100).toFixed(1)}% suggests the model is predicting one class almost always. The accuracy reflects the majority share, not real predictive skill.`,
      });
    }

    // Walk-forward drop from validation accuracy.
    const drop = this.oosDropPp();
    if (drop !== null && drop > 8) {
      out.push({
        level: drop > 15 ? 'critical' : 'warn',
        title: 'Walk-forward accuracy collapses out-of-sample',
        detail: `Mean fold accuracy is ${drop.toFixed(1)} pp below the validation accuracy — edge may be concentrated in lucky windows.`,
      });
    }

    // Brier (calibration) — high values mean predicted probabilities are unreliable.
    if (m.brierScore !== null && m.brierScore > 0.25) {
      out.push({
        level: m.brierScore > 0.3 ? 'critical' : 'warn',
        title: 'Poor probability calibration',
        detail: `Brier ${m.brierScore.toFixed(4)} > 0.25 — predicted probabilities are unreliable for downstream Kelly sizing.`,
      });
    }

    // Negative Sharpe.
    if (m.sharpeRatio !== null && m.sharpeRatio < 0) {
      out.push({
        level: 'critical',
        title: 'Negative Sharpe on validation',
        detail: `Sharpe ${m.sharpeRatio.toFixed(3)} — risk-adjusted return is below zero.`,
      });
    }

    // Fragility flag.
    if (m.fragilityScore !== null && m.fragilityScore > 0.5) {
      out.push({
        level: 'warn',
        title: 'High adversarial fragility',
        detail: `Fragility ${m.fragilityScore.toFixed(2)} — performance degrades sharply under slippage / news-shock perturbations.`,
      });
    }

    return out;
  });

  constructor() {
    effect(() => {
      const id = this.model().id;
      if (!id) return;
      this.loadLifecycle(id);
    });
  }

  classifyEvent(eventType: string): string {
    return eventType.toLowerCase();
  }

  pct(v: number | null): string {
    return v === null || v === undefined ? '—' : (v * 100).toFixed(2) + '%';
  }

  num(v: number | null | undefined, places: number): string {
    return v === null || v === undefined ? '—' : v.toFixed(places);
  }

  hi(v: number | null, threshold: number): boolean {
    return v !== null && v > threshold;
  }

  lo(v: number | null, threshold: number): boolean {
    return v !== null && v < threshold;
  }

  private loadLifecycle(id: number): void {
    this.lifecycleLoading.set(true);
    this.lifecycleError.set(null);
    this.mlModels
      .getLifecycleLog(id)
      .pipe(
        catchError((err) => {
          this.lifecycleError.set(
            `Failed to load lifecycle: ${(err?.error?.message as string | undefined) ?? err?.message ?? err}`,
          );
          this.lifecycleLoading.set(false);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.lifecycleLoading.set(false);
        if (res?.status && res.data) {
          this.lifecycle.set(res.data);
        }
      });
  }
}
