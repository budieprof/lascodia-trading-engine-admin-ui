import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import type { AgentChangeSetDto, AlgoEngineerAuditRowDto } from '@core/api/api.types';

import { AlgoEngineerService } from '@core/services/algo-engineer.service';
import type { AlgoEngineerScorecardRowDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/** Change scorecard (ADR-0020 §F) — the algo-engineer agent's shipped changes, predicted vs realised. */
@Component({
  selector: 'app-algo-engineer-scorecard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    RefreshButtonComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Algo-Engineer — Change Scorecard"
        subtitle="Each change the agent proposed/shipped, graded against its own forecast (ADR-0020)"
      >
        <!-- Bound to refreshing(), not loading(): loading() is true only until the first paint,
             and an unchanged scorecard is a structural no-op, so the old button never moved. -->
        <app-refresh-button [refreshing]="resource.refreshing()" (refresh)="resource.refresh()" />
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load the change scorecard"
          message="The engine returned an error. Verify it is reachable and the algo-engineer endpoints are deployed."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- Colour carries meaning only: Diverged goes red when > 0 (the bad
             case) and is neutral at zero; Accruing is an in-progress state,
             not a warning, so it takes the accent rather than amber. -->
        <section class="kpis">
          <app-metric-card
            label="Tracked changes"
            [value]="rows().length"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Confirmed"
            [value]="confirmedCount()"
            format="number"
            [dotColor]="confirmedCount() > 0 ? '#34C759' : '#8E8E93'"
          />
          <app-metric-card
            label="Diverged"
            [value]="divergedCount()"
            format="number"
            [dotColor]="divergedCount() > 0 ? '#FF3B30' : '#8E8E93'"
          />
          <app-metric-card
            label="Accruing"
            [value]="accruingCount()"
            format="number"
            [dotColor]="accruingCount() > 0 ? '#0071E3' : '#8E8E93'"
          />
          <app-metric-card
            label="Changes recorded, not yet deployed"
            [value]="changeSets.value() ? undeployed().length : null"
            format="number"
            [dotColor]="undeployed().length > 0 ? '#FF9500' : '#8E8E93'"
          />
          <app-metric-card
            label="Agent runs (last 90 days)"
            [value]="audit.value() ? runsStarted() : null"
            format="number"
            dotColor="#0071E3"
          />
        </section>

        @if (rows().length === 0) {
          <section class="card explain">
            <h3>Why nothing is scored yet</h3>
            <p>
              A change is graded only after it is deployed: the agent's forecast (predicted Δ) is
              then compared with what really happened over the change's horizon, against a
              counterfactual.
              @if (changeSets.value(); as cs) {
                @if (cs.length === 0) {
                  The agent has not recorded any change yet.
                } @else {
                  The agent has recorded {{ cs.length }} change{{ cs.length === 1 ? '' : 's' }};
                  {{ undeployed().length }} {{ undeployed().length === 1 ? 'is' : 'are' }} still
                  {{ statusList() }} and none has been deployed, so there is nothing to grade.
                }
              }
            </p>
            <a routerLink="/algo-engineer/operations"
              >Open Operations (approvals, runs, change sets) →</a
            >
          </section>
        }

        @if (changeSets.value()?.length) {
          <section class="card">
            <header class="card-head">
              <h3>Changes the agent recorded</h3>
              <span class="sub"
                >Newest first · a change enters the scorecard when it is deployed</span
              >
            </header>
            <table class="scorecard-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Area</th>
                  <th>Summary</th>
                  <th>Status</th>
                  <th>Recorded</th>
                  <th>Deployed</th>
                  <th>Session</th>
                </tr>
              </thead>
              <tbody>
                @for (c of changeSets.value(); track c.id) {
                  <tr>
                    <td>{{ c.id }}</td>
                    <td>{{ c.area }}</td>
                    <td class="summary wide" [title]="c.summary">{{ c.summary }}</td>
                    <td>{{ c.status }}</td>
                    <td [title]="c.createdAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC'">
                      {{ c.createdAtUtc | relativeTime }}
                    </td>
                    <td>{{ c.deployedAtUtc ? (c.deployedAtUtc | relativeTime) : '—' }}</td>
                    <td>
                      <a
                        routerLink="/conversations"
                        [queryParams]="{ conversation: c.conversationLlmInvocationId }"
                        >#{{ c.conversationLlmInvocationId }}</a
                      >
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        @if (audit.value()?.length) {
          <section class="card">
            <header class="card-head">
              <h3>Agent timeline, last 90 days</h3>
              <span class="sub">
                {{ runsStarted() }} runs started · {{ runsEnded() }} finished ·
                {{ configChanges() }} config writes (by the agent or an operator) ·
                {{ modelEvents() }} model lifecycle events
                @if (lastActivity(); as last) {
                  · latest {{ last | relativeTime }}
                }
              </span>
            </header>
            <table class="scorecard-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>By</th>
                  <th>Summary</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                @for (a of recentAudit(); track $index) {
                  <tr>
                    <td [title]="a.atUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC'">
                      {{ a.atUtc | relativeTime }}
                    </td>
                    <td>{{ kindLabel(a.kind) }}</td>
                    <td>{{ a.actor }}</td>
                    <td class="summary wide" [title]="a.summary">{{ a.summary }}</td>
                    <td>{{ a.outcome ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        @if (rows().length > 0) {
          <section class="card">
            <table class="scorecard-table">
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Summary</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th class="num">Predicted Δ</th>
                  <th class="num">Realised Δ</th>
                  <th class="num">Counterfactual Δ</th>
                  <th class="num">Forecast err</th>
                  <th class="num">Sample</th>
                  <th>Horizon</th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.changeSetId) {
                  <tr>
                    <td>
                      <code>{{ row.sha.slice(0, 8) }}</code>
                    </td>
                    <td class="summary">{{ row.summary }}</td>
                    <td>{{ row.changeSetStatus }}</td>
                    <td>
                      <span class="dot" [style.background]="statusColor(row.outcomeStatus)"></span>
                      {{ row.outcomeStatus }}
                    </td>
                    <td class="num">{{ row.predictedDelta | number: '1.2-3' }}</td>
                    <td class="num">
                      {{ row.realizedDelta === null ? '—' : (row.realizedDelta | number: '1.2-3') }}
                    </td>
                    <td class="num">
                      {{
                        row.counterfactualDelta === null
                          ? '—'
                          : (row.counterfactualDelta | number: '1.2-3')
                      }}
                    </td>
                    <td class="num">
                      {{ row.forecastError === null ? '—' : (row.forecastError | number: '1.2-3') }}
                    </td>
                    <td class="num">{{ row.realizedSampleAccrued }}</td>
                    <td>{{ row.horizonExpiresAtUtc | relativeTime }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      /* Fixed six-column strip: the tiles keep the same width as every other
         page's KPI row instead of stretching three tiles across the viewport. */
      .kpis {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .kpis {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow-x: auto;
      }
      .scorecard-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .scorecard-table th,
      .scorecard-table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .scorecard-table th {
        font-weight: var(--font-bold);
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .scorecard-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .scorecard-table .summary {
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .scorecard-table .summary.wide {
        max-width: 520px;
      }
      .card-head,
      .explain {
        padding: var(--space-3) var(--space-4);
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        align-items: baseline;
      }
      .card-head h3,
      .explain h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .card-head .sub {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .explain p {
        margin: var(--space-2) 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        max-width: 90ch;
      }
      .card a {
        color: var(--accent);
        text-decoration: none;
        font-size: var(--text-sm);
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 4px;
        vertical-align: middle;
      }
    `,
  ],
})
export class AlgoEngineerScorecardPageComponent {
  private readonly algoEngineer = inject(AlgoEngineerService);

  // Errors propagate so the error state is reachable (they used to become [] = "nothing tracked").
  protected readonly resource = createPolledResource(
    () =>
      this.algoEngineer
        .getScorecard(false, 100)
        .pipe(map((res) => (res.data ?? []) as AlgoEngineerScorecardRowDto[])),
    { intervalMs: 60_000 },
  );

  /** Every change the agent recorded — the scorecard's input before deployment. */
  protected readonly changeSets = createPolledResource(
    () =>
      this.algoEngineer.getChangeSets(null, 50).pipe(
        map((res) => (res.data ?? []) as AgentChangeSetDto[]),
        catchError(() => of(null)),
      ),
    { intervalMs: 120_000 },
  );

  /** The agent's timeline over 90 days (silent endpoint; an older engine answers 404 → hidden). */
  protected readonly audit = createPolledResource(
    () => {
      const to = new Date();
      const from = new Date(to.getTime() - 90 * 86_400_000);
      return this.algoEngineer.getAudit(from.toISOString(), to.toISOString(), 200).pipe(
        map((res) => (res.data ?? []) as AlgoEngineerAuditRowDto[]),
        catchError(() => of(null)),
      );
    },
    { intervalMs: 300_000 },
  );

  protected readonly undeployed = computed(() =>
    (this.changeSets.value() ?? []).filter((c) => !c.deployedAtUtc),
  );
  protected readonly statusList = computed(() => {
    const counts = new Map<string, number>();
    for (const c of this.undeployed()) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
    return [...counts].map(([s, n]) => `${s.toLowerCase()} (${n})`).join(', ');
  });
  private kindCount(kind: string): number {
    return (this.audit.value() ?? []).filter((a) => a.kind === kind).length;
  }
  protected readonly runsStarted = computed(() => this.kindCount('run_started'));
  protected readonly runsEnded = computed(() => this.kindCount('run_ended'));
  protected readonly configChanges = computed(() => this.kindCount('config_change'));
  protected readonly modelEvents = computed(() => this.kindCount('model_lifecycle'));
  protected readonly recentAudit = computed(() =>
    [...(this.audit.value() ?? [])].sort((a, b) => b.atUtc.localeCompare(a.atUtc)).slice(0, 15),
  );
  protected readonly lastActivity = computed(() => this.recentAudit()[0]?.atUtc ?? null);

  protected kindLabel(kind: string): string {
    return (
      (
        {
          run_started: 'Run started',
          run_ended: 'Run finished',
          config_change: 'Config write',
          model_lifecycle: 'Model lifecycle',
          approval: 'Approval',
          change_set: 'Change recorded',
          monitor: 'Monitor',
        } as Record<string, string>
      )[kind] ?? kind.replace(/_/g, ' ')
    );
  }

  protected readonly rows = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.rows().length === 0);
  protected readonly confirmedCount = computed(
    () => this.rows().filter((r) => r.outcomeStatus === 'Confirmed').length,
  );
  protected readonly divergedCount = computed(
    () => this.rows().filter((r) => r.outcomeStatus === 'Diverged').length,
  );
  protected readonly accruingCount = computed(
    () => this.rows().filter((r) => r.outcomeStatus === 'Accruing').length,
  );

  protected statusColor(status: string): string {
    switch (status) {
      case 'Confirmed':
        return '#34C759';
      case 'Diverged':
        return '#FF3B30';
      case 'Accruing':
        return '#0071E3';
      default:
        return '#8E8E93';
    }
  }
}
