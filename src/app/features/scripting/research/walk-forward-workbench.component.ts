import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { formatDate, formatDateTime, formatRatio } from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { RUN_POLL_MS } from './optimization-runs.component';
import { ResearchApiService, type WalkForwardRun } from './research-api.service';
import { ANALYST_PERMISSION } from './research-permissions';
import { isActiveRun, parseHoldout } from './research-runs.model';
import { WalkForwardAnalysisComponent } from './walk-forward-analysis.component';
import { WalkForwardLauncherComponent } from './walk-forward-launcher.component';

/**
 * The strategy page's Walk-forward tab (PE-I4, BT-I5): start a walk-forward (window mode, re-optimise per fold), follow
 * the runs, and open one for its stitched out-of-sample result, fold inputs, efficiency, drift, holdout and Monte Carlo.
 */
@Component({
  selector: 'app-walk-forward-workbench',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WalkForwardLauncherComponent, WalkForwardAnalysisComponent],
  template: `
    <div class="workbench" data-testid="walk-forward-workbench">
      <app-walk-forward-launcher
        [strategy]="strategy()"
        [canRun]="canRun()"
        (launched)="onLaunched($event)"
      />

      <section class="card" aria-labelledby="wfr-title">
        <header class="head">
          <h3 id="wfr-title" class="title">Walk-forward runs</h3>
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
          <p class="muted">{{ loading() ? 'Loading the runs…' : 'No walk-forward yet.' }}</p>
        } @else {
          <div class="table-wrap">
            <table data-testid="walk-forward-runs">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Range</th>
                  <th scope="col">Windows</th>
                  <th scope="col" class="num">Avg OOS score</th>
                  <th scope="col" class="num">Consistency</th>
                  <th scope="col">Holdout</th>
                  <th scope="col">Queued</th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr
                    [class.selected]="r.id === selectedId()"
                    [attr.data-run]="r.id"
                    tabindex="0"
                    (click)="selectedId.set(r.id)"
                    (keydown.enter)="selectedId.set(r.id)"
                  >
                    <td class="mono">#{{ r.id }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.chip-ok]="r.status === 'Completed'"
                        [class.chip-error]="r.status === 'Failed'"
                        [class.chip-accent]="isActive(r.status)"
                        >{{ r.status }}</span
                      >
                    </td>
                    <td class="small">{{ day(r.fromDate) }} → {{ day(r.toDate) }}</td>
                    <td class="small">
                      {{ r.inSampleDays }}d IS / {{ r.outOfSampleDays }}d OOS ·
                      {{ r.windowMode ?? 'Rolling' }}
                      {{ r.reOptimizePerFold ? '· re-optimised' : '· fixed inputs' }}
                    </td>
                    <td class="num">{{ ratio(r.averageOutOfSampleScore) }}</td>
                    <td class="num">{{ ratio(r.scoreConsistency) }}</td>
                    <td class="small">{{ holdoutState(r) }}</td>
                    <td class="small">{{ when(r.queuedAt ?? r.startedAt) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      @if (selectedId(); as id) {
        <app-walk-forward-analysis [runId]="id" />
      }
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
      p {
        margin: 0;
      }
    `,
  ],
})
export class WalkForwardWorkbenchComponent {
  private readonly api = inject(ResearchApiService);
  private readonly auth = inject(AuthService);

  readonly strategy = input.required<StrategyDto>();

  readonly canRun = computed(() => this.auth.hasPermission(ANALYST_PERMISSION));
  /** Only a different strategy re-reads the list (the page refreshes its strategy object on every update). */
  private readonly strategyId = computed(() => this.strategy().id);
  readonly runs = signal<WalkForwardRun[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly polling = signal(false);
  readonly isActive = isActiveRun;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.strategyId();
      untracked(() => {
        this.selectedId.set(null);
        void this.reload();
      });
    });
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  onLaunched(id: number): void {
    this.selectedId.set(id);
    void this.reload();
  }

  async reload(): Promise<void> {
    this.stopPolling();
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.walkForwardRuns(this.strategyId()));
      if (!res?.status) throw res;
      const runs = res.data?.data ?? [];
      this.runs.set(runs);
      this.error.set(null);
      if (this.selectedId() === null) {
        const done = runs.find((r) => r.status === 'Completed');
        if (done) this.selectedId.set(done.id);
      }
      if (runs.some((r) => isActiveRun(r.status))) {
        this.polling.set(true);
        this.timer = setTimeout(() => void this.reload(), RUN_POLL_MS);
      }
    } catch (err) {
      this.error.set(describeFailure(err, 'The walk-forward runs could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  holdoutState(r: WalkForwardRun): string {
    if (r.status !== 'Completed') return '—';
    if (!r.holdoutScoredAt) return 'locked until approval';
    const h = parseHoldout(r.holdoutResultJson);
    if (!h) return 'scored';
    return h.unscorable ? 'too short to score' : `Sharpe ${formatRatio(h.sharpeRatio, 2)}`;
  }

  day(iso: string | null | undefined): string {
    return iso ? formatDate(Date.parse(iso)) : '—';
  }
  when(iso: string | null | undefined): string {
    return iso ? `${formatDateTime(Date.parse(iso))} UTC` : '—';
  }
  ratio(v: number | null | undefined): string {
    return formatRatio(v ?? null, 3);
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.polling.set(false);
  }
}
