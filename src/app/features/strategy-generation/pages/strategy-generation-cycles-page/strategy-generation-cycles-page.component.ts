import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { throttleTime } from 'rxjs';

import { StrategyGenerationService } from '@core/services/strategy-generation.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { StrategyGenerationCycleRunDto } from '@core/api/api.types';

import type { EChartsOption } from 'echarts';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { DatePipe } from '@angular/common';

/**
 * Strategy-generation timeline. Renders the last N cycle runs as a vertical
 * timeline, colour-coded by status. Operators can also force a manual cycle
 * from this page (Operator policy required server-side).
 */
@Component({
  selector: 'app-strategy-generation-cycles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    ChartCardComponent,
    RelativeTimePipe,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Generation"
        subtitle="Recent cycle runs from StrategyGenerationWorker"
      >
        <button
          type="button"
          class="btn btn-primary"
          (click)="triggerCycle()"
          [disabled]="triggering()"
        >
          {{ triggering() ? 'Triggering…' : 'Trigger cycle' }}
        </button>
      </app-page-header>

      <section class="filter-bar">
        @for (s of statusFilters; track s) {
          <button
            type="button"
            class="chip"
            [class.active]="statusFilter() === s"
            (click)="setStatusFilter(s)"
          >
            {{ s ?? 'All' }}
          </button>
        }
      </section>

      @if (loading() && cycles().length === 0) {
        <app-card-skeleton [lines]="6" />
      } @else if (loadFailed()) {
        <app-error-state
          title="Could not load generation cycles"
          message="The strategy-generation cycles endpoint returned an error."
          (retry)="load()"
        />
      } @else if (cycles().length === 0) {
        <app-empty-state
          title="No cycles yet"
          description="StrategyGenerationWorker hasn't run a cycle (or none match the current filter)."
        />
      } @else {
        @if (idleState(); as idle) {
          <div class="idle-banner" [attr.data-level]="idle.level">
            <strong>Generation idle since {{ idle.since | date: 'MMM d, yyyy HH:mm' }} UTC</strong>
            — the last cycle started {{ idle.label }}. Trigger a cycle or check that
            StrategyGenerationWorker is enabled and scheduled.
          </div>
        }
        <!-- KPI strip — fleet-wide cycle posture -->
        <div class="gen-kpis">
          <div class="gen-kpi">
            <span class="kpi-label">Cycles shown</span>
            <span class="kpi-value">{{ cycles().length }}</span>
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Completed</span>
            <span class="kpi-value good">{{ statusCounts().completed }}</span>
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Failed</span>
            <span
              class="kpi-value"
              [class.bad]="statusCounts().failed > 0"
              [class.good]="statusCounts().failed === 0"
            >
              {{ statusCounts().failed }}
            </span>
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Success rate</span>
            <!-- "Completed" only means the cycle did not throw. A cycle that
                 produced nothing is not a success worth painting green. -->
            <span
              class="kpi-value"
              [class.good]="successRate() >= 95 && totalCandidates() > 0"
              [class.bad]="successRate() < 80"
              [title]="
                totalCandidates() === 0
                  ? 'Cycles completed without errors but created no candidates'
                  : ''
              "
            >
              {{ successRate().toFixed(0) }}%
            </span>
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Candidates created</span>
            <span class="kpi-value" [class.warn]="totalCandidates() === 0">{{
              totalCandidates()
            }}</span>
            @if (totalCandidates() === 0) {
              <span class="kpi-note">0 in {{ cycles().length }} cycles</span>
            }
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Symbols processed</span>
            <span class="kpi-value">{{ totalSymbols() }}</span>
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Avg duration</span>
            <span class="kpi-value">{{ avgDurationLabel() }}</span>
          </div>
          <div class="gen-kpi">
            <span class="kpi-label">Last cycle</span>
            <span
              class="kpi-value sm"
              [class.warn]="idleState()?.level === 'warn'"
              [class.bad]="idleState()?.level === 'bad'"
            >
              {{ lastCycleLabel() }}
            </span>
          </div>
        </div>

        <!-- 2-col chart row: stage funnel + cycles per hour -->
        <div class="gen-charts">
          <app-chart-card
            title="Pipeline funnel"
            subtitle="Created → Reserve → Screened → Symbols → Pruned · summed across visible cycles"
            [options]="funnelOptions()"
            height="240px"
          />
          @if (activityOptions(); as opts) {
            <app-chart-card
              title="Cycle activity (last 24h)"
              subtitle="Cycles per hour — gaps reveal idle periods"
              [options]="opts"
              height="240px"
            />
          } @else {
            <div class="gen-board stat-card">
              <header class="gen-board-head">
                <h3>Cycle activity (last 24h)</h3>
              </header>
              <p class="stat-line muted">
                No cycles in the last 24h — last run {{ lastCycleLabel() }}.
              </p>
            </div>
          }
        </div>

        <!-- 2-col chart row: durations over time + outcome breakdown -->
        <div class="gen-charts">
          <app-chart-card
            title="Duration over time"
            subtitle="Newest cycle on the right — spikes indicate slow runs"
            [options]="durationOptions()"
            height="220px"
          />
          @if (statusDonutOptions(); as opts) {
            <app-chart-card
              title="Outcome distribution"
              subtitle="Status breakdown across the visible cycles"
              [options]="opts"
              height="220px"
            />
          } @else {
            <div class="gen-board stat-card">
              <header class="gen-board-head">
                <h3>Outcome distribution</h3>
              </header>
              <p class="stat-line">
                <span class="stat-value">{{ cycles().length }}</span>
                cycle{{ cycles().length === 1 ? '' : 's' }}, all
                <b>{{ singleStatusLabel() }}</b>
              </p>
            </div>
          }
        </div>

        <!-- Failures-only summary (renders only when there are any) -->
        @if (failedCycles().length > 0) {
          <section class="gen-board">
            <header class="gen-board-head">
              <h3>Recent failures</h3>
              <span class="muted">
                {{ failedCycles().length }} of {{ cycles().length }} cycles failed
              </span>
            </header>
            <table class="gen-board-table">
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Stage</th>
                  <th>Message</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                @for (c of failedCycles(); track c.id) {
                  <tr>
                    <td class="mono">
                      <span class="hash-chip" [title]="c.cycleId">{{ cycleHash(c.cycleId) }}</span>
                    </td>
                    <td class="mono bad">{{ c.failureStage ?? '—' }}</td>
                    <td class="failure-msg" [title]="c.failureMessage ?? ''">
                      {{ c.failureMessage ?? '—' }}
                    </td>
                    <td class="mono nowrap" [title]="c.startedAtUtc | date: 'medium'">
                      {{ c.startedAtUtc | relativeTime }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        <section class="gen-board">
          <header class="gen-board-head">
            <h3>Cycle timeline</h3>
            <span class="muted">
              {{ cycles().length }} cycles · newest first · scroll within for older runs
            </span>
          </header>
          <div class="timeline-scroll">
            <ol class="timeline">
              @for (c of cycles(); track c.id) {
                <li class="timeline-item" [attr.data-status]="c.status.toLowerCase()">
                  <div class="dot"></div>
                  <div class="card">
                    <header class="card-head">
                      <div class="card-id">
                        <span class="cycle-date">{{
                          c.startedAtUtc | date: 'MMM d, yyyy HH:mm'
                        }}</span>
                        <span class="hash-chip" [title]="c.cycleId">{{
                          cycleHash(c.cycleId)
                        }}</span>
                        <span class="status">{{ c.status }}</span>
                      </div>
                      <span class="muted" [title]="c.startedAtUtc | date: 'medium'">{{
                        c.startedAtUtc | relativeTime
                      }}</span>
                    </header>
                    <div class="metrics">
                      @for (m of cycleMetrics(c); track m.label) {
                        <span [class.zero]="m.value === 0"
                          ><strong>{{ m.value }}</strong> {{ m.label }}</span
                        >
                      }
                      @if (c.durationMs !== null) {
                        <span
                          ><strong>{{ formatDuration(c.durationMs) }}</strong> elapsed</span
                        >
                      }
                    </div>
                    @if (c.failureMessage) {
                      <div class="failure">
                        <span class="failure-stage">{{ c.failureStage ?? 'unknown stage' }}:</span>
                        {{ c.failureMessage }}
                      </div>
                    }
                  </div>
                </li>
              }
            </ol>
          </div>
        </section>
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

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .filter-bar {
        display: flex;
        gap: var(--space-2);
      }
      .chip {
        padding: 6px 14px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .chip:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
      .chip.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }

      .totals {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-4);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .totals div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .value {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }

      /* Cap the timeline at a fixed visual height — without this, 30+ tall
         cycle cards push the analytics charts above completely off-screen.
         Internal scroll keeps everything reachable while preserving the
         "comparison panel above + drill-in below" layout pattern. */
      .timeline-scroll {
        max-height: 540px;
        overflow-y: auto;
        padding: var(--space-3) var(--space-4);
      }
      .timeline {
        list-style: none;
        margin: 0;
        padding: 0 0 0 var(--space-4);
        position: relative;
      }
      .timeline::before {
        content: '';
        position: absolute;
        left: 4px;
        top: 8px;
        bottom: 8px;
        width: 2px;
        background: var(--border);
      }
      .timeline-item {
        position: relative;
        /* Tighter vertical rhythm so more cycles fit in the same window. */
        padding: 0 0 var(--space-3) var(--space-5);
      }
      .timeline-item:last-child {
        padding-bottom: 0;
      }
      .dot {
        position: absolute;
        left: -4px;
        top: 6px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #636366;
        border: 2px solid var(--bg-primary);
      }
      .timeline-item[data-status='running'] .dot {
        background: #0071e3;
        animation: pulse 1.6s ease-in-out infinite;
      }
      .timeline-item[data-status='completed'] .dot {
        background: #34c759;
      }
      .timeline-item[data-status='failed'] .dot {
        background: #ff3b30;
      }
      @keyframes pulse {
        0%,
        100% {
          box-shadow: 0 0 0 0 rgba(0, 113, 227, 0.4);
        }
        50% {
          box-shadow: 0 0 0 6px rgba(0, 113, 227, 0);
        }
      }

      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .cycle-id {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-right: var(--space-2);
      }
      .status {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .timeline-item[data-status='completed'] .status {
        color: #248a3d;
      }
      .timeline-item[data-status='failed'] .status {
        color: #d70015;
      }
      .timeline-item[data-status='running'] .status {
        color: #0040dd;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .metrics {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-4);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .metrics strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .failure {
        padding: var(--space-2) var(--space-3);
        background: rgba(255, 59, 48, 0.08);
        border-left: 3px solid #ff3b30;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .failure-stage {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: #d70015;
        margin-right: 4px;
      }

      /* Generation density additions */
      .gen-kpis {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-2);
        align-items: start;
      }
      .idle-banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        border: 1px solid rgba(255, 149, 0, 0.4);
        border-left: 4px solid var(--warning);
        background: rgba(255, 149, 0, 0.08);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .idle-banner[data-level='bad'] {
        border-color: rgba(255, 59, 48, 0.4);
        border-left-color: var(--loss);
        background: rgba(255, 59, 48, 0.08);
      }
      .kpi-note {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .gen-kpi .kpi-value.warn {
        color: var(--warning);
      }
      .stat-card {
        display: flex;
        flex-direction: column;
        min-height: 220px;
      }
      .stat-line {
        margin: 0;
        padding: var(--space-4);
        font-size: var(--text-sm);
        color: var(--text-primary);
        flex: 1;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .stat-value {
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .card-id {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .cycle-date {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .hash-chip {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        padding: 1px 7px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        cursor: help;
      }
      .nowrap {
        white-space: nowrap;
      }
      .metrics .zero {
        color: var(--text-tertiary);
      }
      .metrics .zero strong {
        color: var(--text-tertiary);
        font-weight: var(--font-regular);
      }
      @media (max-width: 720px) {
        .gen-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .gen-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 4px;
        min-height: 72px;
      }
      .gen-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .gen-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .gen-kpi .kpi-value.good {
        color: var(--profit);
      }
      .gen-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .gen-kpi .kpi-value.sm {
        font-size: var(--text-base);
      }

      .gen-charts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .gen-charts {
          grid-template-columns: 1fr;
        }
      }

      .gen-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .gen-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .gen-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .gen-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .gen-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .gen-board-table th,
      .gen-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .gen-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .gen-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .gen-board-table .mono {
        font-family: var(--font-mono);
      }
      .gen-board-table .bad {
        color: var(--loss);
      }
      .gen-board-table .failure-msg {
        color: var(--text-secondary);
        max-width: 480px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class StrategyGenerationCyclesPageComponent {
  private readonly service = inject(StrategyGenerationService);
  private readonly notify = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly cycles = signal<StrategyGenerationCycleRunDto[]>([]);
  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly triggering = signal(false);
  readonly statusFilter = signal<string | null>(null);

  readonly statusFilters: (string | null)[] = [null, 'Running', 'Completed', 'Failed'];

  readonly totalCandidates = computed(() =>
    this.cycles().reduce((acc, c) => acc + c.candidatesCreated, 0),
  );
  readonly totalSymbols = computed(() =>
    this.cycles().reduce((acc, c) => acc + c.symbolsProcessed, 0),
  );
  readonly totalPruned = computed(() =>
    this.cycles().reduce((acc, c) => acc + c.strategiesPruned, 0),
  );

  // ── Aggregate stats for the KPI strip ──────────────────────────────
  readonly statusCounts = computed(() => {
    let completed = 0;
    let failed = 0;
    let running = 0;
    let other = 0;
    for (const c of this.cycles()) {
      const s = (c.status ?? '').toLowerCase();
      if (s === 'completed') completed++;
      else if (s === 'failed') failed++;
      else if (s === 'running') running++;
      else other++;
    }
    return { completed, failed, running, other };
  });

  readonly successRate = computed(() => {
    const c = this.statusCounts();
    const total = c.completed + c.failed;
    return total === 0 ? 0 : (c.completed / total) * 100;
  });

  readonly avgDurationLabel = computed(() => {
    const durations = this.cycles()
      .map((c) => c.durationMs)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (durations.length === 0) return '—';
    const avg = durations.reduce((s, v) => s + v, 0) / durations.length;
    return this.formatDuration(avg);
  });

  private readonly newestCycleStart = computed(() => {
    const newest = this.cycles()
      .map((c) => new Date(c.startedAtUtc).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    return newest ?? null;
  });

  readonly lastCycleLabel = computed(() => {
    const newest = this.newestCycleStart();
    if (!newest) return '—';
    const ageSec = Math.floor((Date.now() - newest) / 1000);
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86400)}d ago`;
  });

  /**
   * The worker's cadence is a server-side setting the page cannot read, so
   * idleness is judged against the observed cadence: the median gap between
   * the visible cycles (floored at one hour). Three cadences missed is amber,
   * a week or more with no cycle is red.
   */
  readonly idleState = computed<{ level: 'warn' | 'bad'; since: string; label: string } | null>(
    () => {
      const newest = this.newestCycleStart();
      if (!newest) return null;
      const starts = this.cycles()
        .map((c) => new Date(c.startedAtUtc).getTime())
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
      const gaps = starts
        .slice(1)
        .map((t, i) => t - starts[i])
        .filter((g) => g > 0);
      const cadence =
        gaps.length > 0 ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 3600_000;
      const age = Date.now() - newest;
      const threshold = Math.max(cadence * 3, 3600_000);
      if (age < threshold) return null;
      return {
        level: age >= 7 * 86400_000 ? 'bad' : 'warn',
        since: new Date(newest).toISOString(),
        label: this.lastCycleLabel(),
      };
    },
  );

  /** Label for the outcome stat line when every visible cycle shares one status. */
  readonly singleStatusLabel = computed(() => {
    const c = this.statusCounts();
    if (c.completed > 0) return 'completed';
    if (c.failed > 0) return 'failed';
    if (c.running > 0) return 'running';
    return 'in an unknown state';
  });

  /** Timeline counters — kept in one place so zero stages can be de-emphasised. */
  cycleMetrics(c: StrategyGenerationCycleRunDto): { label: string; value: number }[] {
    return [
      { label: 'created', value: c.candidatesCreated },
      { label: 'reserve', value: c.reserveCandidatesCreated },
      { label: 'screened', value: c.candidatesScreened },
      { label: 'symbols', value: c.symbolsProcessed },
      { label: 'skipped', value: c.symbolsSkipped },
      { label: 'pruned', value: c.strategiesPruned },
      { label: 'filtered out', value: c.portfolioFilterRemoved },
    ];
  }

  readonly failedCycles = computed(() =>
    this.cycles().filter((c) => (c.status ?? '').toLowerCase() === 'failed'),
  );

  // ── Charts ─────────────────────────────────────────────────────────
  readonly funnelOptions = computed<EChartsOption>(() => {
    const cycles = this.cycles();
    if (cycles.length === 0) return {};
    const stages = [
      {
        name: 'Created',
        value: cycles.reduce((s, c) => s + c.candidatesCreated, 0),
        color: '#0071E3',
      },
      {
        name: 'Reserve',
        value: cycles.reduce((s, c) => s + c.reserveCandidatesCreated, 0),
        color: '#5AC8FA',
      },
      {
        name: 'Screened',
        value: cycles.reduce((s, c) => s + c.candidatesScreened, 0),
        color: '#34C759',
      },
      {
        name: 'Symbols',
        value: cycles.reduce((s, c) => s + c.symbolsProcessed, 0),
        color: '#FF9500',
      },
      {
        name: 'Pruned',
        value: cycles.reduce((s, c) => s + c.strategiesPruned, 0),
        color: '#FF3B30',
      },
      {
        name: 'Filtered out',
        value: cycles.reduce((s, c) => s + c.portfolioFilterRemoved, 0),
        color: '#AF52DE',
      },
    ].filter((st) => st.value > 0);
    // Empty tracks for zero stages say nothing; list only the stages that
    // carried volume, and say so when none did.
    if (stages.length === 0) {
      return {
        title: {
          text: 'No candidates moved through any stage',
          left: 'center',
          top: 'center',
          textStyle: { fontSize: 12, color: '#8E8E93' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 40, bottom: 30, left: 100 },
      xAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: stages.map((s) => s.name).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: stages
            .map((s) => ({
              value: s.value,
              itemStyle: { color: s.color, borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 11, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly activityOptions = computed<EChartsOption | null>(() => {
    // Bucket the last 24 hours into 1-hour bins.
    const buckets = new Map<string, number>();
    const now = new Date();
    now.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(d.getHours() - i);
      const key = `${String(d.getHours()).padStart(2, '0')}:00`;
      buckets.set(key, 0);
    }
    const cutoff = Date.now() - 24 * 3600_000;
    for (const c of this.cycles()) {
      const t = new Date(c.startedAtUtc).getTime();
      if (!Number.isFinite(t) || t < cutoff) continue;
      const d = new Date(t);
      const key = `${String(d.getHours()).padStart(2, '0')}:00`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const entries = Array.from(buckets.entries());
    if (entries.every(([, v]) => v === 0)) return null;
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: entries.map(([k]) => k),
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color: '#5AC8FA', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  readonly durationOptions = computed<EChartsOption>(() => {
    const cycles = [...this.cycles()].reverse(); // oldest → newest
    if (cycles.length === 0) return {};
    const fmt = (ms: number) => this.formatDuration(ms);
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          const c = cycles[p.dataIndex];
          const started = new Date(c.startedAtUtc).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          return `${started}<br/>${c.status} · ${fmt(p.value)}`;
        },
      },
      grid: { top: 28, right: 20, bottom: 30, left: 60 },
      xAxis: {
        type: 'category',
        // Dated labels — the cycle-id prefix is a timestamp with the
        // separators stripped, unreadable as an axis.
        data: cycles.map((c) =>
          new Date(c.startedAtUtc).toLocaleDateString('en-CA', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }),
        ),
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: 'duration',
        nameGap: 12,
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: (v: number) => fmt(v) },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: cycles.map((c) => ({
            value: c.durationMs ?? 0,
            itemStyle: {
              color:
                (c.status ?? '').toLowerCase() === 'failed'
                  ? '#FF3B30'
                  : (c.durationMs ?? 0) > 10_000
                    ? '#FF9500'
                    : '#34C759',
              borderRadius: [3, 3, 0, 0],
            },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  readonly statusDonutOptions = computed<EChartsOption | null>(() => {
    const c = this.statusCounts();
    const populated = [c.completed, c.failed, c.running, c.other].filter((v) => v > 0).length;
    // One status = one full ring = no information; the stat line covers it.
    if (populated < 2) return null;
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: [
            { value: c.completed, name: 'Completed', itemStyle: { color: '#34C759' } },
            { value: c.failed, name: 'Failed', itemStyle: { color: '#FF3B30' } },
            { value: c.running, name: 'Running', itemStyle: { color: '#0071E3' } },
            { value: c.other, name: 'Other', itemStyle: { color: '#8E8E93' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  constructor() {
    this.load();

    // Re-pull when a strategy is activated — most likely the runner just
    // finished a cycle. Cheaper than polling and matches the actual signal
    // operators care about. Throttled so a burst doesn't pile up requests.
    this.realtime
      .on('strategyActivated')
      .pipe(
        throttleTime(3_000, undefined, { leading: false, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.load());
  }

  protected setStatusFilter(s: string | null): void {
    this.statusFilter.set(s);
    this.load();
  }

  protected triggerCycle(): void {
    this.triggering.set(true);
    this.service.triggerCycle().subscribe({
      next: (res) => {
        this.triggering.set(false);
        if (res?.status) {
          this.notify.success('Cycle triggered');
          this.load();
        } else {
          this.notify.error(res?.message ?? 'Trigger failed');
        }
      },
      error: () => {
        this.triggering.set(false);
        this.notify.error('Trigger failed');
      },
    });
  }

  /**
   * Cycle ids are `<yyyyMMddHHmmss><guid-ish>`; the timestamp is already
   * shown as a date beside the chip, so the chip carries only the hash tail.
   */
  protected cycleHash(id: string): string {
    if (!id) return '—';
    const tail = id.replace(/^\d{14}/, '').replace(/^[-_]/, '');
    return tail.length > 8 ? tail.slice(-8) : tail || id.slice(-8);
  }

  protected formatDuration(ms: number): string {
    if (ms < 1_000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  }

  protected load(): void {
    this.loading.set(true);
    this.loadFailed.set(false);
    this.service
      .listCycles({
        currentPage: 1,
        itemCountPerPage: 30,
        filter: this.statusFilter() ? { status: this.statusFilter() } : null,
      })
      .subscribe({
        next: (res) => {
          this.loadFailed.set(!res?.status);
          this.cycles.set(res?.data?.data ?? []);
          this.loading.set(false);
        },
        error: () => {
          this.loadFailed.set(true);
          this.cycles.set([]);
          this.loading.set(false);
        },
      });
  }
}
