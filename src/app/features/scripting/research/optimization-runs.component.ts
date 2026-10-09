import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { formatDateTime, formatRatio } from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { ScriptDialogService } from '../shared/script-dialog.service';
import { ResearchApiService, type OptimizationRun } from './research-api.service';
import { hasSpec, isActiveRun, objectiveLabel, runStageText } from './research-runs.model';

/** How often the list re-reads while a run is queued or running. */
export const RUN_POLL_MS = 10_000;

/**
 * The strategy's optimization runs (PE-I4 workbench): status and stage in words, what each ranked by, its best health
 * score against the baseline — re-read every 10 s while one is queued or running. Selecting a run opens its results.
 * A completed run can be approved (its best parameters applied to the strategy) or rejected only by an explicit,
 * confirmed operator action: nothing here approves or promotes on its own.
 */
@Component({
  selector: 'app-optimization-runs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="or-title" data-testid="optimization-runs">
      <header class="head">
        <h3 id="or-title" class="title">Optimization runs</h3>
        @if (polling()) {
          <span class="chip chip-accent">Updating while a run is going</span>
        }
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="reload()">Refresh</button>
      </header>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      }
      @if (runs().length === 0) {
        <p class="muted">{{ loading() ? 'Loading the runs…' : 'No optimization run yet.' }}</p>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Ranked by</th>
                <th scope="col" class="num">Evaluations</th>
                <th scope="col" class="num">Best health</th>
                <th scope="col" class="num">Baseline</th>
                <th scope="col">Started</th>
                <th scope="col">Completed</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of runs(); track r.id) {
                <tr
                  [class.selected]="r.id === selectedId()"
                  [attr.data-run]="r.id"
                  tabindex="0"
                  (click)="runSelected.emit(r.id)"
                  (keydown.enter)="runSelected.emit(r.id)"
                >
                  <td class="mono">
                    #{{ r.id }} <span class="muted small">{{ r.triggerType }}</span>
                  </td>
                  <td>
                    <span
                      class="chip"
                      [class.chip-ok]="r.status === 'Completed' || r.status === 'Approved'"
                      [class.chip-error]="r.status === 'Failed'"
                      [class.chip-accent]="isActive(r.status)"
                      >{{ r.status }}</span
                    >
                    <span class="muted small block">{{ stage(r) }}</span>
                  </td>
                  <td>
                    {{ objective(r) }}
                    @if (spec(r)) {
                      <span class="chip chip-accent" title="Started with an operator search spec"
                        >spec</span
                      >
                    }
                  </td>
                  <td class="num">{{ r.iterations }}</td>
                  <td class="num">{{ ratio(r.bestHealthScore) }}</td>
                  <td class="num">{{ ratio(r.baselineHealthScore) }}</td>
                  <td>{{ when(r.startedAt) }}</td>
                  <td>{{ r.completedAt ? when(r.completedAt) : '—' }}</td>
                  <td class="actions" (click)="$event.stopPropagation()">
                    @if (r.status === 'Completed' && canApprove()) {
                      <button type="button" class="btn btn-sm" (click)="approve(r)">
                        Approve…
                      </button>
                      <button type="button" class="btn btn-sm btn-danger" (click)="reject(r)">
                        Reject…
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
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
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .spacer {
        flex: 1;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
        font-weight: normal;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      tbody tr {
        cursor: pointer;
      }
      tbody tr:hover {
        background: var(--bg-tertiary);
      }
      tr.selected {
        background: rgba(0, 113, 227, 0.08);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .block {
        display: block;
        margin-top: 2px;
      }
      .actions {
        white-space: nowrap;
        display: flex;
        gap: 6px;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class OptimizationRunsComponent {
  private readonly api = inject(ResearchApiService);
  private readonly feedback = inject(StrategyFeedbackService);
  private readonly dialogs = inject(ScriptDialogService);

  readonly strategyId = input.required<number>();
  readonly selectedId = input<number | null>(null);
  /** The caller may approve or reject a completed run (`access.analyst`). */
  readonly canApprove = input(false);
  /** Bump to re-read at once (a run was just started). */
  readonly refreshKey = input(0);

  readonly runSelected = output<number>();
  /** The list changed (loaded, a run finished, approved or rejected): the newest runs. */
  readonly loaded = output<OptimizationRun[]>();

  readonly runs = signal<OptimizationRun[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly polling = signal(false);

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.strategyId();
      this.refreshKey();
      untracked(() => void this.reload());
    });
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  readonly isActive = isActiveRun;
  objective(r: OptimizationRun): string {
    return objectiveLabel(r.searchSpecJson);
  }
  spec(r: OptimizationRun): boolean {
    return hasSpec(r.searchSpecJson);
  }
  stage(r: OptimizationRun): string {
    const text = runStageText(r);
    return text === r.status ? '' : text.replace(`${r.status} — `, '');
  }
  ratio(v: number | null | undefined): string {
    return formatRatio(v ?? null, 4);
  }
  when(iso: string | null | undefined): string {
    return iso ? `${formatDateTime(Date.parse(iso))} UTC` : '—';
  }

  async reload(): Promise<void> {
    this.stopPolling();
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.optimizationRuns(this.strategyId()));
      if (!res?.status) throw res;
      const runs = res.data?.data ?? [];
      this.runs.set(runs);
      this.error.set(null);
      this.loaded.emit(runs);
      if (runs.some((r) => isActiveRun(r.status))) this.schedule();
    } catch (err) {
      this.error.set(describeFailure(err, 'The optimization runs could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  async approve(run: OptimizationRun): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Approve optimization run #${run.id}?`,
      message:
        'Approving applies the run’s best parameters to the strategy. The engine re-checks the run before it applies them.',
      details: run.bestParametersJson ? [`Best parameters: ${run.bestParametersJson}`] : undefined,
      confirmLabel: 'Approve and apply',
    });
    if (!ok) return;
    await this.act(
      () => firstValueFrom(this.feedback.approveOptimization(run.id)),
      'The run could not be approved.',
    );
  }

  async reject(run: OptimizationRun): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Reject optimization run #${run.id}?`,
      message:
        'Rejecting keeps the strategy’s current parameters; the run stays in the list as rejected.',
      confirmLabel: 'Reject',
      tone: 'danger',
    });
    if (!ok) return;
    await this.act(
      () => firstValueFrom(this.feedback.rejectOptimization(run.id)),
      'The run could not be rejected.',
    );
  }

  private async act(
    call: () => Promise<{ status?: boolean } | null | undefined>,
    fallback: string,
  ): Promise<void> {
    try {
      const res = await call();
      if (!res?.status) throw res;
      await this.reload();
    } catch (err) {
      this.error.set(describeFailure(err, fallback));
    }
  }

  private schedule(): void {
    this.polling.set(true);
    this.timer = setTimeout(() => void this.reload(), RUN_POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.polling.set(false);
  }
}
