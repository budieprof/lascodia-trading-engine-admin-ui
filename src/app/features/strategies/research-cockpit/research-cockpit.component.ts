import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { ConfigHashBadgeComponent } from '../components/config-hash-badge/config-hash-badge.component';
import { ExecutionEvidenceCardComponent } from './execution-evidence-card.component';
import { HoldoutCardComponent } from './holdout-card.component';
import { LabImportCardComponent } from './lab-import-card.component';
import { ValidationPipelineCardComponent } from './validation-pipeline-card.component';
import { WfStitchedCardComponent } from './wf-stitched-card.component';

/**
 * U12 — the strategy's research cockpit (strategy detail → Research): one-click validation pipeline with its gate rows,
 * the lineage holdout, the walk-forward's stitched out-of-sample verdict, the live evidence it rests on (sequential test,
 * execution quality, cost calibration, spec history) and the lab-trial import. Promotion gate rows live on the Promotion
 * tab (same table); run manifests, re-runs and diffs on each backtest's page.
 */
@Component({
  selector: 'app-research-cockpit',
  standalone: true,
  imports: [
    ConfigHashBadgeComponent,
    ValidationPipelineCardComponent,
    HoldoutCardComponent,
    WfStitchedCardComponent,
    ExecutionEvidenceCardComponent,
    LabImportCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cockpit" data-testid="research-cockpit">
      <p class="lead">
        Research verdicts for this strategy, from the engine's own records.
        @if (currentHash()) {
          Current configuration <app-config-hash-badge [hash]="currentHash()" />.
        }
        Run manifests, re-runs and run-to-run diffs are on each backtest's page.
      </p>
      <app-validation-pipeline-card [strategyId]="strategyId()" />
      <div class="grid">
        <app-holdout-card [strategyId]="strategyId()" />
        <app-wf-stitched-card [strategyId]="strategyId()" [currentHash]="currentHash()" />
      </div>
      <app-execution-evidence-card
        [strategyId]="strategyId()"
        [symbol]="symbol()"
        [currentHash]="currentHash()"
      />
      <app-lab-import-card [strategyId]="strategyId()" />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cockpit {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .lead {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr));
        gap: var(--space-4);
        align-items: start;
      }
    `,
  ],
})
export class ResearchCockpitComponent {
  readonly strategyId = input.required<number>();
  readonly symbol = input<string | null>(null);
  /** The strategy's current C1 configuration hash, when the engine sends it on the strategy. */
  readonly currentHash = input<string | null>(null);
}
