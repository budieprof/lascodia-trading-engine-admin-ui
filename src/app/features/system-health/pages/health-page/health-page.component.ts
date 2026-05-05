import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, merge, of, throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { HealthService } from '@core/services/health.service';
import { WorkersService } from '@core/services/workers.service';
import { DeadLetterService } from '@core/services/dead-letter.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { DeadLetterDto, EngineStatusDto, WorkerHealthDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    DatePipe,
    RelativeTimePipe,
    RouterLink,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="System Health"
        subtitle="Live engine status and operational metrics"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          @if (loading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (status()) {
            @if (status(); as s) {
              <!-- Hero status banner -->
              <div
                class="health-hero"
                [class.healthy]="s.isRunning"
                [class.unhealthy]="!s.isRunning"
              >
                <div class="health-circle">
                  <span class="health-icon" aria-hidden="true">{{ s.isRunning ? '✓' : '!' }}</span>
                </div>
                <div class="health-text">
                  <span class="health-status">{{
                    s.isRunning ? 'Engine Running' : 'Engine Stopped'
                  }}</span>
                  <span class="health-sub"
                    >Last checked {{ s.checkedAt | date: 'MMM d, HH:mm:ss' }}</span
                  >
                  @if (s.paperMode) {
                    <span class="mode-pill">{{ s.paperMode }} mode</span>
                  }
                </div>
                <div class="hero-meta">
                  <span class="meta-pair">
                    <span class="meta-label">Workers</span>
                    <span class="meta-value">{{ workerSnapshots().length }}</span>
                  </span>
                  <span class="meta-pair">
                    <span class="meta-label">Healthy %</span>
                    <span
                      class="meta-value"
                      [class.good]="healthyPct() >= 95"
                      [class.warn]="healthyPct() < 95 && healthyPct() >= 80"
                      [class.bad]="healthyPct() < 80"
                    >
                      {{ healthyPct().toFixed(0) }}%
                    </span>
                  </span>
                  <span class="meta-pair">
                    <span class="meta-label">Unresolved DLQ</span>
                    <span
                      class="meta-value"
                      [class.bad]="deadLetters().length > 0"
                      [class.good]="deadLetters().length === 0"
                    >
                      {{ deadLetters().length }}
                    </span>
                  </span>
                </div>
              </div>

              <!-- 8-card KPI strip -->
              <div class="hp-kpis">
                <app-metric-card
                  label="Active strategies"
                  [value]="s.activeStrategies"
                  format="number"
                  dotColor="#0071E3"
                />
                <app-metric-card
                  label="Open positions"
                  [value]="s.openPositions"
                  format="number"
                  dotColor="#34C759"
                />
                <app-metric-card
                  label="Pending orders"
                  [value]="s.pendingOrders"
                  format="number"
                  [dotColor]="s.pendingOrders > 0 ? '#FF9500' : '#34C759'"
                />
                <app-metric-card
                  label="Healthy workers"
                  [value]="workerCounts().Healthy"
                  format="number"
                  dotColor="#34C759"
                />
                <app-metric-card
                  label="Degraded workers"
                  [value]="workerCounts().Degraded"
                  format="number"
                  [dotColor]="workerCounts().Degraded > 0 ? '#FF9500' : '#34C759'"
                />
                <app-metric-card
                  label="Failed workers"
                  [value]="workerCounts().Failed"
                  format="number"
                  [dotColor]="workerCounts().Failed > 0 ? '#FF3B30' : '#34C759'"
                />
                <app-metric-card
                  label="Idle workers"
                  [value]="workerCounts().Idle"
                  format="number"
                  dotColor="#0071E3"
                />
                <app-metric-card
                  label="DLQ unresolved"
                  [value]="deadLetters().length"
                  format="number"
                  [dotColor]="deadLetters().length > 0 ? '#FF3B30' : '#34C759'"
                />
              </div>

              <!-- 2-col chart row: worker status donut + DLQ event types -->
              <div class="hp-charts">
                <app-chart-card
                  title="Worker status distribution"
                  subtitle="Healthy · Degraded · Failed · Idle"
                  [options]="workerDonutOptions()"
                  height="240px"
                />
                <app-chart-card
                  title="Unresolved DLQ by event type"
                  subtitle="Top event types in the last 25 unresolved rows"
                  [options]="dlqEventTypeOptions()"
                  height="240px"
                />
              </div>

              <!-- Recent issues table — surfaces the most-pressing things -->
              @if (issuesList().length > 0) {
                <section class="hp-board">
                  <header class="hp-board-head">
                    <h3>Active issues</h3>
                    <span class="muted">
                      {{ issuesList().length }} workers reporting non-healthy status
                    </span>
                  </header>
                  <table class="hp-board-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Worker</th>
                        <th>Message</th>
                        <th>Last reported</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (w of issuesList(); track w.name) {
                        <tr>
                          <td>
                            <span
                              class="hp-pill"
                              [class.warn]="w.status === 'Degraded'"
                              [class.bad]="w.status === 'Failed'"
                              [class.info]="w.status === 'Idle'"
                            >
                              {{ w.status }}
                            </span>
                          </td>
                          <td class="mono">{{ w.name }}</td>
                          <td class="msg">{{ w.lastErrorMessage ?? '—' }}</td>
                          <td class="mono">
                            {{ w.capturedAt ? (w.capturedAt | relativeTime) : '—' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </section>
              }

              <!-- Quick actions / drill-down links -->
              <section class="hp-actions">
                <a routerLink="/engine-overview" class="hp-action">
                  <span class="hp-action-label">Engine Overview</span>
                  <span class="hp-action-desc"> Combined status + worker + DLQ panel </span>
                </a>
                <a routerLink="/worker-health" class="hp-action">
                  <span class="hp-action-label">Worker Health</span>
                  <span class="hp-action-desc">
                    {{ workerSnapshots().length }} workers · cycle duration · error rate
                  </span>
                </a>
                <a routerLink="/dead-letter" class="hp-action">
                  <span class="hp-action-label">Dead-letter queue</span>
                  <span class="hp-action-desc">
                    {{ deadLetters().length }} unresolved · retry posture
                  </span>
                </a>
                <a routerLink="/audit-trail" class="hp-action">
                  <span class="hp-action-label">Audit trail</span>
                  <span class="hp-action-desc">Operator-facing change log</span>
                </a>
              </section>
            }
          } @else {
            <app-empty-state
              title="Unable to reach engine"
              description="The /health/status endpoint is not responding."
            />
          }
        }

        @if (activeTab() === 'infrastructure') {
          <!-- Per-category worker breakdown -->
          @if (workerSnapshots().length > 0) {
            <!-- 8-card infra KPI strip — fleet-wide performance signals -->
            <div class="hp-kpis">
              <app-metric-card
                label="Total workers"
                [value]="workerSnapshots().length"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Categories"
                [value]="perCategoryBreakdown().length"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Avg P95 cycle (ms)"
                [value]="infraStats().avgP95Cycle"
                format="number"
                [dotColor]="infraStats().avgP95Cycle > 1000 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Max P99 cycle (ms)"
                [value]="infraStats().maxP99Cycle"
                format="number"
                [dotColor]="infraStats().maxP99Cycle > 5000 ? '#FF3B30' : '#34C759'"
              />
              <app-metric-card
                label="Errors / hour"
                [value]="infraStats().totalErrorsLastHour"
                format="number"
                [dotColor]="infraStats().totalErrorsLastHour > 0 ? '#FF3B30' : '#34C759'"
              />
              <app-metric-card
                label="Successes / hour"
                [value]="infraStats().totalSuccessesLastHour"
                format="number"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Total backlog"
                [value]="infraStats().totalBacklog"
                format="number"
                [dotColor]="infraStats().totalBacklog > 100 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Retries / hour"
                [value]="infraStats().totalRetriesLastHour"
                format="number"
                [dotColor]="infraStats().totalRetriesLastHour > 0 ? '#FF9500' : '#34C759'"
              />
            </div>

            <div class="hp-charts">
              <app-chart-card
                title="Workers by category"
                subtitle="How the {{ workerSnapshots().length }}-worker fleet is composed"
                [options]="workersByCategoryOptions()"
                height="260px"
              />
              <app-chart-card
                title="Workers by status"
                subtitle="Status distribution across the fleet"
                [options]="workerDonutOptions()"
                height="260px"
              />
            </div>

            <!-- Performance charts row — surfaces tail latency + error spikes -->
            <div class="hp-charts">
              <app-chart-card
                title="P95 cycle duration by category"
                subtitle="Tail-latency view — long bars are the slow categories"
                [options]="cycleDurationByCategoryOptions()"
                height="260px"
              />
              <app-chart-card
                title="Errors per hour by category"
                subtitle="Hot-spots in the worker fleet"
                [options]="errorsByCategoryOptions()"
                height="260px"
              />
            </div>

            <section class="hp-board">
              <header class="hp-board-head">
                <h3>Per-category breakdown</h3>
                <span class="muted">
                  {{ perCategoryBreakdown().length }} categories ·
                  {{ workerSnapshots().length }} workers
                </span>
              </header>
              <div class="hp-board-scroll">
                <table class="hp-board-table sticky">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th class="num">Total</th>
                      <th class="num">Healthy</th>
                      <th class="num">Degraded</th>
                      <th class="num">Failed</th>
                      <th class="num">Idle</th>
                      <th class="num">Healthy %</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of perCategoryBreakdown(); track row.category) {
                      <tr>
                        <td class="mono">{{ row.category }}</td>
                        <td class="num mono">{{ row.total }}</td>
                        <td class="num mono good">{{ row.healthy }}</td>
                        <td class="num mono" [class.warn]="row.degraded > 0">
                          {{ row.degraded }}
                        </td>
                        <td class="num mono" [class.bad]="row.failed > 0">{{ row.failed }}</td>
                        <td class="num mono">{{ row.idle }}</td>
                        <td
                          class="num mono"
                          [class.good]="row.healthyPct >= 95"
                          [class.bad]="row.healthyPct < 80"
                        >
                          {{ row.healthyPct.toFixed(0) }}%
                        </td>
                      </tr>
                    }
                  </tbody>
                  @if (perCategoryBreakdown().length > 0) {
                    <tfoot>
                      <tr class="total-row">
                        <td class="mono">All categories</td>
                        <td class="num mono">{{ workerSnapshots().length }}</td>
                        <td class="num mono good">{{ workerCounts().Healthy }}</td>
                        <td class="num mono" [class.warn]="workerCounts().Degraded > 0">
                          {{ workerCounts().Degraded }}
                        </td>
                        <td class="num mono" [class.bad]="workerCounts().Failed > 0">
                          {{ workerCounts().Failed }}
                        </td>
                        <td class="num mono">{{ workerCounts().Idle }}</td>
                        <td
                          class="num mono"
                          [class.good]="healthyPct() >= 95"
                          [class.bad]="healthyPct() < 80"
                        >
                          {{ healthyPct().toFixed(0) }}%
                        </td>
                      </tr>
                    </tfoot>
                  }
                </table>
              </div>
            </section>

            <!-- DLQ events list -->
            @if (deadLetters().length > 0) {
              <section class="hp-board">
                <header class="hp-board-head">
                  <h3>Unresolved DLQ events</h3>
                  <span class="muted">Last 25 with their retry counts</span>
                </header>
                <table class="hp-board-table">
                  <thead>
                    <tr>
                      <th>Event type</th>
                      <th class="num">Attempts</th>
                      <th>First seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (d of deadLetters(); track d.id) {
                      <tr>
                        <td class="mono">{{ d.eventType ?? 'unknown' }}</td>
                        <td
                          class="num mono"
                          [class.bad]="d.attemptCount >= 3"
                          [class.warn]="d.attemptCount === 2"
                        >
                          ×{{ d.attemptCount }}
                        </td>
                        <td class="mono">{{ d.createdAt | relativeTime }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }
          } @else {
            <app-empty-state
              title="Infrastructure metrics unavailable"
              description="Worker snapshots and DLQ data have not been received yet."
            />
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .health-hero {
        display: flex;
        align-items: center;
        gap: var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-6);
        margin-bottom: var(--space-6);
        box-shadow: var(--shadow-sm);
      }
      .health-circle {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .healthy .health-circle {
        background: rgba(52, 199, 89, 0.15);
      }
      .unhealthy .health-circle {
        background: rgba(255, 59, 48, 0.15);
      }
      .healthy .health-icon {
        color: var(--profit);
      }
      .unhealthy .health-icon {
        color: var(--loss);
      }
      .health-icon {
        font-size: 32px;
        font-weight: bold;
      }
      .health-text {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .health-status {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .healthy .health-status {
        color: var(--profit);
      }
      .unhealthy .health-status {
        color: var(--loss);
      }
      .health-sub {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .mode-pill {
        display: inline-block;
        margin-top: var(--space-1);
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
        width: fit-content;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      @media (max-width: 768px) {
        .metrics {
          grid-template-columns: 1fr;
        }
      }
      .note {
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4) var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .note code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      /* Hero meta block — sits inside the existing hero card */
      .hero-meta {
        display: flex;
        gap: var(--space-5);
        margin-left: auto;
        flex-wrap: wrap;
      }
      .meta-pair {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .meta-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .meta-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .meta-value.good {
        color: var(--profit);
      }
      .meta-value.bad {
        color: var(--loss);
      }
      .meta-value.warn {
        color: #c93400;
      }

      /* 8-card KPI strip */
      .hp-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .hp-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .hp-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* 2-col chart row */
      .hp-charts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .hp-charts {
          grid-template-columns: 1fr;
        }
      }

      /* Board card (active issues + per-category breakdown + DLQ events) */
      .hp-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-3);
      }
      .hp-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .hp-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .hp-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      /* Bounded scroll container so dense breakdowns don't push the page. */
      .hp-board-scroll {
        max-height: 360px;
        overflow-y: auto;
      }
      .hp-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .hp-board-table.sticky thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .hp-board-table tfoot .total-row td {
        position: sticky;
        bottom: 0;
        z-index: 1;
        background: var(--bg-tertiary);
        font-weight: var(--font-semibold);
        border-top: 1px solid var(--border);
      }
      .hp-board-table th,
      .hp-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .hp-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .hp-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .hp-board-table th.num,
      .hp-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .hp-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .hp-board-table .good {
        color: var(--profit);
      }
      .hp-board-table .warn {
        color: #c93400;
      }
      .hp-board-table .bad {
        color: var(--loss);
      }
      .hp-board-table .msg {
        max-width: 480px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .hp-pill {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: rgba(142, 142, 147, 0.14);
        color: #636366;
      }
      .hp-pill.warn {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .hp-pill.bad {
        background: rgba(255, 59, 48, 0.14);
        color: #d70015;
      }
      .hp-pill.info {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }

      /* Quick actions row — links to drill-down pages */
      .hp-actions {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 900px) {
        .hp-actions {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .hp-action {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        text-decoration: none;
        color: var(--text-primary);
        transition: all 0.15s ease;
      }
      .hp-action:hover {
        border-color: var(--accent);
        transform: translateY(-1px);
      }
      .hp-action-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .hp-action-desc {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class HealthPageComponent {
  private readonly healthService = inject(HealthService);
  private readonly workersService = inject(WorkersService);
  private readonly deadLetterSvc = inject(DeadLetterService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);

  constructor() {
    // Risk events are the reason someone is staring at this page — surface
    // them immediately so the "is the engine still okay?" question resolves
    // before the next 15s poll. Throttle 1s to de-dupe duplicate breach
    // notifications on the same VaR cycle but otherwise push hard.
    merge(this.realtime.on('vaRBreach'), this.realtime.on('emergencyFlatten'))
      .pipe(throttleTime(1_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.resource.refresh();
        this.workersResource.refresh();
        this.dlqResource.refresh();
      });
  }

  readonly tabs: TabItem[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Infrastructure', value: 'infrastructure' },
  ];
  readonly activeTab = signal('overview');

  private readonly resource = createPolledResource(
    () =>
      this.healthService.getStatus().pipe(
        map((r) => r.data),
        catchError(() => of(null as EngineStatusDto | null)),
      ),
    { intervalMs: 15_000 },
  );

  // Worker snapshots — same source as Engine Overview / Worker Health pages.
  // /health/workers returns a raw array, not a ResponseData envelope.
  private readonly workersResource = createPolledResource(
    () => this.workersService.list().pipe(catchError(() => of([] as WorkerHealthDto[]))),
    { intervalMs: 15_000 },
  );

  // Last 25 unresolved DLQ rows.
  private readonly dlqResource = createPolledResource(
    () =>
      this.deadLetterSvc
        .list({ currentPage: 1, itemCountPerPage: 25, filter: { isResolved: false } })
        .pipe(
          map((r) => r.data?.data ?? []),
          catchError(() => of([] as DeadLetterDto[])),
        ),
    { intervalMs: 15_000 },
  );

  readonly status = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly workerSnapshots = computed(() => this.workersResource.value() ?? []);
  readonly deadLetters = computed(() => this.dlqResource.value() ?? []);

  readonly workerCounts = computed(() => {
    const buckets = { Healthy: 0, Degraded: 0, Failed: 0, Idle: 0 };
    for (const w of this.workerSnapshots()) {
      if (w.status in buckets) buckets[w.status as keyof typeof buckets]++;
    }
    return buckets;
  });

  readonly healthyPct = computed(() => {
    const total = this.workerSnapshots().length;
    if (total === 0) return 0;
    return (this.workerCounts().Healthy / total) * 100;
  });

  // Non-healthy workers, capped at 12 — the page's actionable issue list.
  readonly issuesList = computed(() => {
    const order: Record<string, number> = { Failed: 0, Degraded: 1, Idle: 2, Healthy: 3 };
    return this.workerSnapshots()
      .filter((w) => w.status !== 'Healthy')
      .sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99))
      .slice(0, 12);
  });

  // Per-category breakdown — uses the DTO's built-in `category` field
  // (server-derived from the worker name's first CamelCase segment, so the
  // grouping matches what other pages show).
  readonly perCategoryBreakdown = computed(() => {
    type Row = {
      category: string;
      total: number;
      healthy: number;
      degraded: number;
      failed: number;
      idle: number;
      healthyPct: number;
    };
    const groups: Record<string, Row> = {};
    for (const w of this.workerSnapshots()) {
      const cat = w.category ?? 'Other';
      if (!groups[cat])
        groups[cat] = {
          category: cat,
          total: 0,
          healthy: 0,
          degraded: 0,
          failed: 0,
          idle: 0,
          healthyPct: 0,
        };
      const g = groups[cat];
      g.total++;
      const s = (w.status ?? '').toLowerCase();
      if (s === 'healthy') g.healthy++;
      else if (s === 'degraded') g.degraded++;
      else if (s === 'failed') g.failed++;
      else if (s === 'idle') g.idle++;
    }
    return Object.values(groups)
      .map((g) => ({ ...g, healthyPct: g.total > 0 ? (g.healthy / g.total) * 100 : 0 }))
      .sort((a, b) => b.total - a.total);
  });

  readonly workerDonutOptions = computed<EChartsOption>(() => {
    const c = this.workerCounts();
    if (this.workerSnapshots().length === 0) return {};
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
            { value: c.Healthy, name: 'Healthy', itemStyle: { color: '#34C759' } },
            { value: c.Degraded, name: 'Degraded', itemStyle: { color: '#FF9500' } },
            { value: c.Failed, name: 'Failed', itemStyle: { color: '#FF3B30' } },
            { value: c.Idle, name: 'Idle', itemStyle: { color: '#0071E3' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  readonly workersByCategoryOptions = computed<EChartsOption>(() => {
    const rows = this.perCategoryBreakdown();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 30, bottom: 30, left: 100 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.total,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly dlqEventTypeOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const d of this.deadLetters()) {
      const k = d.eventType ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    const palette = ['#FF3B30', '#FF9500', '#AF52DE', '#FFCC00', '#5AC8FA', '#0071E3', '#8E8E93'];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: entries.map(([name, value], i) => ({
            name,
            value,
            itemStyle: { color: palette[i % palette.length] },
          })),
        },
      ],
    };
  });

  // Fleet-wide performance aggregates for the Infrastructure-tab KPI strip.
  // Filter NaN/Infinity out of P95 averaging so a single bad sample doesn't
  // poison the headline number.
  readonly infraStats = computed(() => {
    const ws = this.workerSnapshots();
    if (ws.length === 0) {
      return {
        avgP95Cycle: 0,
        maxP99Cycle: 0,
        totalErrorsLastHour: 0,
        totalSuccessesLastHour: 0,
        totalBacklog: 0,
        totalRetriesLastHour: 0,
      };
    }
    const p95s = ws.map((w) => w.cycleDurationP95Ms).filter((v) => Number.isFinite(v));
    const avgP95 = p95s.length > 0 ? p95s.reduce((a, b) => a + b, 0) / p95s.length : 0;
    const maxP99 = ws.reduce(
      (m, w) =>
        Number.isFinite(w.cycleDurationP99Ms) && w.cycleDurationP99Ms > m
          ? w.cycleDurationP99Ms
          : m,
      0,
    );
    return {
      avgP95Cycle: Math.round(avgP95),
      maxP99Cycle: Math.round(maxP99),
      totalErrorsLastHour: ws.reduce((s, w) => s + (w.errorsLastHour ?? 0), 0),
      totalSuccessesLastHour: ws.reduce((s, w) => s + (w.successesLastHour ?? 0), 0),
      totalBacklog: ws.reduce((s, w) => s + (w.backlogDepth ?? 0), 0),
      totalRetriesLastHour: ws.reduce((s, w) => s + (w.retriesLastHour ?? 0), 0),
    };
  });

  // Avg P95 cycle duration grouped by worker category — tail-latency view.
  readonly cycleDurationByCategoryOptions = computed<EChartsOption>(() => {
    const groups: Record<string, { sum: number; count: number }> = {};
    for (const w of this.workerSnapshots()) {
      if (!Number.isFinite(w.cycleDurationP95Ms)) continue;
      const cat = w.category ?? 'Other';
      if (!groups[cat]) groups[cat] = { sum: 0, count: 0 };
      groups[cat].sum += w.cycleDurationP95Ms;
      groups[cat].count++;
    }
    const rows = Object.entries(groups)
      .map(([category, g]) => ({ category, avg: g.count > 0 ? g.sum / g.count : 0 }))
      .sort((a, b) => b.avg - a.avg);
    if (rows.length === 0) return {};
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>Avg P95: ${Math.round(p.value)} ms`;
        },
      },
      grid: { top: 10, right: 60, bottom: 30, left: 100 },
      xAxis: {
        type: 'value',
        name: 'ms',
        nameTextStyle: { fontSize: 10, color: '#6E6E73' },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: Math.round(r.avg),
              itemStyle: {
                color: r.avg > 1000 ? '#FF9500' : r.avg > 500 ? '#FFCC00' : '#34C759',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: '{c} ms',
          },
        },
      ],
    };
  });

  // Errors-per-hour grouped by worker category — surfaces hot-spots.
  readonly errorsByCategoryOptions = computed<EChartsOption>(() => {
    const groups: Record<string, number> = {};
    for (const w of this.workerSnapshots()) {
      const cat = w.category ?? 'Other';
      groups[cat] = (groups[cat] ?? 0) + (w.errorsLastHour ?? 0);
    }
    const rows = Object.entries(groups)
      .map(([category, errors]) => ({ category, errors }))
      .sort((a, b) => b.errors - a.errors);
    if (rows.length === 0 || rows.every((r) => r.errors === 0)) {
      return {
        title: {
          text: 'No errors reported in the last hour',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#34C759', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>Errors / hour: ${p.value}`;
        },
      },
      grid: { top: 10, right: 50, bottom: 30, left: 100 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.errors,
              itemStyle: {
                color: r.errors > 0 ? '#FF3B30' : '#34C759',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });
}
