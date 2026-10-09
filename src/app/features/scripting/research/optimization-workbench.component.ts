import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { describeFailure } from '../shared/api-error';
import { isScriptStrategy } from '../shared/script-strategy';
import { OptimizationRunDetailComponent } from './optimization-run-detail.component';
import { OptimizationRunsComponent } from './optimization-runs.component';
import { ParameterSpaceEditorComponent } from './parameter-space-editor.component';
import { ResearchApiService, type OptimizationRun } from './research-api.service';
import { ANALYST_PERMISSION } from './research-permissions';
import { TrialLedgerComponent } from './trial-ledger.component';

/**
 * The strategy page's Optimization tab (PE-I4 workbench): shape and start a run (a script strategy's search space,
 * objective and constraints), follow the runs, open one for its candidates, overfitting evidence and parameter-stability
 * heatmap, and see the lineage's trial ledger. It launches research runs only — approval stays an explicit, confirmed
 * operator action and every promotion gate is unchanged.
 */
@Component({
  selector: 'app-optimization-workbench',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ParameterSpaceEditorComponent,
    OptimizationRunsComponent,
    OptimizationRunDetailComponent,
    TrialLedgerComponent,
  ],
  template: `
    <div class="workbench" data-testid="optimization-workbench">
      @if (isScript()) {
        <app-parameter-space-editor
          [strategyId]="strategy().id"
          [canRun]="canRun()"
          (started)="onStarted($event)"
        />
      } @else {
        <section class="card">
          <p class="muted">
            The optimizer searches this strategy's own parameters; a search spec (ranges, locks,
            objective, constraints) applies to Pine script strategies only.
          </p>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="!canRun() || starting()"
              (click)="startPlain()"
            >
              Start optimization run
            </button>
          </div>
          @if (startError(); as e) {
            <p class="error-box" role="alert">{{ e }}</p>
          }
        </section>
      }

      <app-optimization-runs
        [strategyId]="strategy().id"
        [selectedId]="selectedRunId()"
        [canApprove]="canRun()"
        [refreshKey]="refreshKey()"
        (runSelected)="selectedRunId.set($event)"
        (loaded)="onRunsLoaded($event)"
      />

      @if (selectedRunId(); as runId) {
        <app-optimization-run-detail [runId]="runId" />
      }

      <app-trial-ledger
        [strategyId]="strategy().id"
        [refreshKey]="refreshKey()"
        (openRun)="selectedRunId.set($event)"
      />
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .workbench {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class OptimizationWorkbenchComponent {
  private readonly api = inject(ResearchApiService);
  private readonly auth = inject(AuthService);

  readonly strategy = input.required<StrategyDto>();

  readonly isScript = computed(() => isScriptStrategy(this.strategy()));
  readonly canRun = computed(() => this.auth.hasPermission(ANALYST_PERMISSION));
  readonly selectedRunId = signal<number | null>(null);
  readonly refreshKey = signal(0);
  readonly starting = signal(false);
  readonly startError = signal<string | null>(null);

  private readonly strategyId = computed(() => this.strategy().id);

  constructor() {
    // Another strategy (the page reuses this component when only the route id changes): start from its runs.
    effect(() => {
      this.strategyId();
      untracked(() => {
        this.selectedRunId.set(null);
        this.startError.set(null);
      });
    });
  }

  onStarted(runId: number): void {
    this.selectedRunId.set(runId);
    this.refreshKey.update((k) => k + 1);
  }

  /** Opens the newest finished run when nothing is selected yet, so the tab starts on results. */
  onRunsLoaded(runs: OptimizationRun[]): void {
    if (this.selectedRunId() !== null) return;
    const finished = runs.find(
      (r) => r.status === 'Completed' || r.status === 'Approved' || r.status === 'Rejected',
    );
    if (finished) this.selectedRunId.set(finished.id);
  }

  async startPlain(): Promise<void> {
    this.starting.set(true);
    this.startError.set(null);
    try {
      const res = await firstValueFrom(this.api.triggerOptimization(this.strategy().id, null));
      if (!res?.status || typeof res.data !== 'number') throw res;
      this.onStarted(res.data);
    } catch (err) {
      this.startError.set(describeFailure(err, 'The optimization run could not be started.'));
    } finally {
      this.starting.set(false);
    }
  }
}
