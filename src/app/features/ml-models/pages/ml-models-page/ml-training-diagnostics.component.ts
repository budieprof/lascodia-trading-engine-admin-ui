import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import type { MLTrainingRunDiagnosticsDto } from '@core/api/api.types';

/** Pretty-prints a JSON payload; anything that does not parse is shown as it came. */
export function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** The training techniques a run applied, as short labels. */
export function trainingFlagBadges(d: MLTrainingRunDiagnosticsDto): string[] {
  const flags: Array<[boolean, string]> = [
    [d.smoteApplied, 'SMOTE'],
    [d.adversarialAugmentApplied, 'Adversarial'],
    [d.mixupApplied, 'Mixup'],
    [d.curriculumApplied, 'Curriculum'],
    [d.nceLossUsed, 'NCE loss'],
    [d.rareEventWeightingApplied, 'Rare-event weighting'],
    [d.isPretrainingRun, 'Pre-training'],
    [d.isDistillationRun, 'Distillation'],
    [d.isEmergencyRetrain, 'Emergency'],
    [d.isMamlRun, 'MAML'],
  ];
  return flags.filter(([on]) => on).map(([, label]) => label);
}

/** A training run's diagnostics: evaluation metrics, budget, drift trigger, reproducibility, raw configs. */
@Component({
  selector: 'app-ml-training-diagnostics',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  styleUrl: './ml-training-diagnostics.component.scss',
  template: `
    @let d = diagnostics();
    <section class="diagnostics mt-6">
      <h4>Diagnostics</h4>

      <div class="diag-grid">
        <div class="diag-card">
          <h5>Evaluation metrics</h5>
          <dl>
            <div>
              <dt>F1 score</dt>
              <dd>
                {{ d.f1Score !== null ? (d.f1Score | number: '1.4-4') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Brier score</dt>
              <dd>
                {{ d.brierScore !== null ? (d.brierScore | number: '1.4-4') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Sharpe ratio</dt>
              <dd>
                {{ d.sharpeRatio !== null ? (d.sharpeRatio | number: '1.3-3') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Expected value</dt>
              <dd>
                {{ d.expectedValue !== null ? (d.expectedValue | number: '1.4-4') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Abstention rate</dt>
              <dd>
                {{
                  d.abstentionRate !== null ? (d.abstentionRate * 100 | number: '1.1-1') + '%' : '—'
                }}
              </dd>
            </div>
            <div>
              <dt>Abstention precision</dt>
              <dd>
                {{
                  d.abstentionPrecision !== null
                    ? (d.abstentionPrecision * 100 | number: '1.1-1') + '%'
                    : '—'
                }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="diag-card">
          <h5>Architecture &amp; budget</h5>
          <dl>
            <div>
              <dt>Architecture</dt>
              <dd>{{ d.learnerArchitecture }}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{{ d.priority }}</dd>
            </div>
            <div>
              <dt>Training time</dt>
              <dd>
                {{ d.trainingDurationMs !== null ? (d.trainingDurationMs | number) + ' ms' : '—' }}
              </dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>{{ d.attemptCount }}</dd>
            </div>
            <div>
              <dt>Picked up</dt>
              <dd>
                {{ d.pickedUpAt ? (d.pickedUpAt | date: 'MMM d, HH:mm:ss') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Label imbalance</dt>
              <dd>
                {{
                  d.labelImbalanceRatio !== null
                    ? (d.labelImbalanceRatio * 100 | number: '1.1-1') + '%'
                    : '—'
                }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="diag-card">
          <h5>Drift trigger</h5>
          @if (d.driftTriggerType) {
            <dl>
              <div>
                <dt>Trigger</dt>
                <dd>{{ d.driftTriggerType }}</dd>
              </div>
            </dl>
            @if (d.driftMetadataJson) {
              <pre class="json">{{ formatJson(d.driftMetadataJson) }}</pre>
            }
          } @else {
            <p class="muted small">Run was scheduled or manual — no drift trigger.</p>
          }
        </div>

        <div class="diag-card">
          <h5>Reproducibility</h5>
          <dl>
            <div>
              <dt>Dataset hash</dt>
              <dd class="mono">{{ d.datasetHash || '—' }}</dd>
            </div>
            <div>
              <dt>Candle range</dt>
              <dd>
                {{
                  d.candleIdRangeStart !== null
                    ? d.candleIdRangeStart + ' → ' + d.candleIdRangeEnd
                    : '—'
                }}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      @if (trainingFlagBadges(d).length > 0) {
        <div class="flag-row">
          <span class="flag-label">Training techniques applied:</span>
          @for (flag of trainingFlagBadges(d); track flag) {
            <span class="flag-pill">{{ flag }}</span>
          }
        </div>
      }

      <details class="diag-details">
        <summary>Hyperparameter config</summary>
        <pre class="json">{{
          d.hyperparamConfigJson ? formatJson(d.hyperparamConfigJson) : '— not provided —'
        }}</pre>
      </details>
      <details class="diag-details">
        <summary>Training-dataset stats</summary>
        <pre class="json">{{
          d.trainingDatasetStatsJson ? formatJson(d.trainingDatasetStatsJson) : '— not provided —'
        }}</pre>
      </details>
      <details class="diag-details">
        <summary>Cross-validation fold scores</summary>
        <pre class="json">{{
          d.cvFoldScoresJson ? formatJson(d.cvFoldScoresJson) : '— not provided —'
        }}</pre>
      </details>
    </section>
  `,
})
export class MlTrainingDiagnosticsComponent {
  readonly diagnostics = input.required<MLTrainingRunDiagnosticsDto>();
  protected readonly formatJson = formatJson;
  protected readonly trainingFlagBadges = trainingFlagBadges;
}
