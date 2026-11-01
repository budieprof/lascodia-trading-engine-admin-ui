import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, merge, of, throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { HealthService } from '@core/services/health.service';
import { WorkersService } from '@core/services/workers.service';
import { DeadLetterService } from '@core/services/dead-letter.service';
import { ConfigService } from '@core/services/config.service';
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

import { formatMs, humanizeEventType, idleReasonOf, type IdleReason } from './health-page.helpers';

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
        subtitle="Is the engine up, are its background workers healthy, and is anything stuck in the dead-letter queue?"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          @if (loading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (status()) {
            @if (status(); as s) {
              <!-- Hero: engine state first, then exactly what needs attention (each chip links to
                   the page where it is dealt with). -->
              <div
                class="health-hero"
                [class.healthy]="s.isRunning"
                [class.unhealthy]="!s.isRunning"
              >
                <div class="health-circle">
                  <span class="health-icon" aria-hidden="true">{{ s.isRunning ? '✓' : '!' }}</span>
                </div>
                <div class="health-text">
                  <div class="health-title">
                    <span class="health-status">{{
                      s.isRunning ? 'Engine Running' : 'Engine Stopped'
                    }}</span>
                    @if (modeLabel(); as mode) {
                      <span
                        class="mode-pill"
                        [class.live]="!isPaperMode()"
                        [title]="
                          isPaperMode()
                            ? 'Orders are simulated, not sent to brokers'
                            : 'Orders go to real broker accounts'
                        "
                        >{{ mode }}</span
                      >
                    }
                  </div>
                  <div class="attention" aria-label="What needs attention">
                    @for (a of attention(); track a.text) {
                      @if (a.link) {
                        <a class="chip" [class]="a.tone" [routerLink]="a.link">{{ a.text }}</a>
                      } @else {
                        <span class="chip" [class]="a.tone">{{ a.text }}</span>
                      }
                    }
                  </div>
                  <span class="health-sub" title="Your local time · the page re-reads every 15 s">
                    Last checked {{ s.checkedAt | date: 'MMM d, HH:mm:ss' }} · refreshes every 15 s
                  </span>
                </div>
                <div class="hero-meta">
                  <span class="meta-pair">
                    <span class="meta-label">Workers</span>
                    <span class="meta-value">{{ workerSnapshots().length }}</span>
                  </span>
                  <span class="meta-pair">
                    <span class="meta-label">Healthy %</span>
                    <!-- Uncoloured "—" until workers report: a failed read is unknown, not 0%. -->
                    <span
                      class="meta-value"
                      [class.good]="workerSnapshots().length > 0 && healthyPct() >= 95"
                      [class.warn]="
                        workerSnapshots().length > 0 && healthyPct() < 95 && healthyPct() >= 80
                      "
                      [class.bad]="workerSnapshots().length > 0 && healthyPct() < 80"
                      [title]="
                        workersResource.error() && workerSnapshots().length === 0
                          ? 'Worker snapshots could not be loaded'
                          : 'Healthy workers / all workers. Idle workers (no completed cycle yet) count as not healthy.'
                      "
                    >
                      {{ workerSnapshots().length > 0 ? healthyPct().toFixed(0) + '%' : '—' }}
                    </span>
                  </span>
                  <span class="meta-pair">
                    <span class="meta-label">Unresolved DLQ</span>
                    <span
                      class="meta-value"
                      [class.bad]="dlqTotal() !== null && dlqTotal()! > 0"
                      [class.good]="dlqTotal() === 0"
                    >
                      {{ dlqTotal() ?? '—' }}
                    </span>
                  </span>
                </div>
              </div>

              <!-- KPI strip: a tone stripe only where the number says something is wrong (or,
                   for healthy workers, right) — eight green stripes read as noise. -->
              <div class="hp-kpis">
                <app-metric-card
                  label="Active strategies"
                  [value]="s.activeStrategies"
                  format="number"
                />
                <app-metric-card label="Open positions" [value]="s.openPositions" format="number" />
                <app-metric-card
                  label="Pending orders"
                  [value]="s.pendingOrders"
                  format="number"
                  [dotColor]="s.pendingOrders > 0 ? 'var(--warning)' : ''"
                  [caption]="s.pendingOrders > 0 ? 'Waiting to be filled or cancelled' : null"
                />
                <app-metric-card
                  label="Healthy workers"
                  [value]="workerCounts().Healthy"
                  format="number"
                  dotColor="var(--profit)"
                  [caption]="'of ' + workerSnapshots().length + ' workers'"
                />
                <app-metric-card
                  label="Degraded workers"
                  [value]="workerCounts().Degraded"
                  format="number"
                  [dotColor]="workerCounts().Degraded > 0 ? 'var(--warning)' : ''"
                />
                <app-metric-card
                  label="Failed workers"
                  [value]="workerCounts().Failed"
                  format="number"
                  [dotColor]="workerCounts().Failed > 0 ? 'var(--loss)' : ''"
                />
                <app-metric-card
                  label="Idle workers"
                  [value]="workerCounts().Idle"
                  format="number"
                  [caption]="workerCounts().Idle > 0 ? 'Running, no completed cycle yet' : null"
                />
                <app-metric-card
                  label="DLQ unresolved"
                  [value]="dlqTotal()"
                  format="number"
                  [dotColor]="(dlqTotal() ?? 0) > 0 ? 'var(--loss)' : ''"
                  [caption]="(dlqTotal() ?? 0) > 0 ? 'Events never delivered to a consumer' : null"
                />
              </div>

              <!-- Non-healthy workers first: this is the list the operator came for. Idle is
                   listed but not called an issue: an idle worker is running and simply has not
                   completed a cycle yet (nothing to do, long cadence). -->
              @if (issuesList().length > 0) {
                <section class="hp-board">
                  <header class="hp-board-head">
                    <h3>
                      {{ problemCount() > 0 ? 'Active issues' : 'Workers not reporting healthy' }}
                    </h3>
                    <span class="muted">
                      {{ problemCount() }} failed or degraded · {{ workerCounts().Idle }} idle (no
                      completed cycle yet)
                    </span>
                    <a routerLink="/worker-health" class="head-link">Worker Health →</a>
                  </header>
                  <table class="hp-board-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Worker</th>
                        <th>Why</th>
                        <th class="num">Last success</th>
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
                          <td class="mono nowrap">{{ w.name }}</td>
                          @if (w.lastErrorMessage) {
                            <td class="msg" [title]="w.lastErrorMessage">
                              <span class="msg-error">{{ w.lastErrorMessage }}</span>
                            </td>
                          } @else {
                            @let r = idleReasonFor(w.name);
                            <td class="msg" [title]="idleReason(w.name)">
                              @switch (r.kind) {
                                @case ('off') {
                                  <span class="strong">Switched off</span> —
                                  <code>{{ r.key }}</code> = false{{
                                    r.since ? ' since ' + r.since : ''
                                  }}
                                }
                                @case ('on') {
                                  Switched on; no completed cycle yet (nothing to do, or a long
                                  interval)
                                }
                                @default {
                                  <span class="muted">—</span>
                                }
                              }
                            </td>
                          }
                          <!-- capturedAt is when the snapshot was taken (always "just now"); the
                               worker's own last good cycle is what says how long it has been out. -->
                          <td
                            class="num"
                            [class.muted]="!w.lastSuccessAt"
                            [title]="
                              w.lastSuccessAt ? (w.lastSuccessAt | date: 'yyyy-MM-dd HH:mm:ss') : ''
                            "
                          >
                            {{ w.lastSuccessAt ? (w.lastSuccessAt | relativeTime) : 'never' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </section>
              }

              <!-- Fleet + dead letters side by side. The fleet is a proportional bar, not a donut:
                   at 94 of 98 healthy a donut is one green ring (the donut is on Infrastructure). -->
              <div class="hp-charts">
                <section class="hp-board">
                  <header class="hp-board-head">
                    <h3>Worker fleet</h3>
                    <span class="muted">{{ workerSnapshots().length }} background workers</span>
                  </header>
                  @if (workerSnapshots().length === 0) {
                    <p class="hp-board-empty">
                      <strong>No worker snapshots yet</strong>
                      {{
                        workersResource.error()
                          ? 'The /health/workers read failed; retrying every 15 s.'
                          : 'Waiting for the first read.'
                      }}
                    </p>
                  } @else {
                    <div class="hp-board-body">
                      <div class="fleet-bar" role="img" [attr.aria-label]="fleetAria()">
                        @for (seg of fleetSegments(); track seg.key) {
                          @if (seg.count > 0) {
                            <span
                              [class]="'seg-' + seg.key"
                              [style.width.%]="seg.pct"
                              [title]="seg.label + ': ' + seg.count"
                            ></span>
                          }
                        }
                      </div>
                      <ul class="fleet-legend">
                        @for (seg of fleetSegments(); track seg.key) {
                          <li [class.zero]="seg.count === 0">
                            <span class="sw" [class]="'sw seg-' + seg.key"></span>
                            <span class="lbl">{{ seg.label }}</span>
                            <span class="n">{{ seg.count }}</span>
                            <span class="pct">{{ seg.pct.toFixed(0) }}%</span>
                          </li>
                        }
                      </ul>
                      <p class="fleet-note">
                        Idle = running but no completed cycle yet; it lowers Healthy % without
                        anything being wrong.
                      </p>
                    </div>
                  }
                </section>

                <!-- A donut with one or two slices says nothing a number can't;
                     below three event types the breakdown renders as a list. -->
                @if (dlqEventTypeRows().length >= 3) {
                  <app-chart-card
                    title="Unresolved DLQ by event type"
                    subtitle="Event types in the last 25 unresolved rows"
                    [options]="dlqEventTypeOptions()"
                    height="240px"
                  />
                } @else {
                  <section class="hp-board">
                    <header class="hp-board-head">
                      <h3>Unresolved DLQ by event type</h3>
                      <span class="muted">Event types in the last 25 unresolved rows</span>
                      <a routerLink="/dead-letter" class="head-link">Dead-letter queue →</a>
                    </header>
                    @if (dlqEventTypeRows().length === 0) {
                      <p class="hp-board-empty good">
                        <strong>No unresolved dead-letter events.</strong>
                        Every integration event has reached its consumers.
                      </p>
                    } @else {
                      <div class="hp-board-body">
                        <ul class="hp-type-list">
                          @for (row of dlqEventTypeRows(); track row.name) {
                            <li>
                              <span [title]="row.name">
                                <span class="ev-name">{{ row.label }}</span>
                                <span class="ev-raw">{{ row.name }}</span>
                              </span>
                              <span class="type-bar">
                                <span class="type-fill" [style.width.%]="row.share"></span>
                              </span>
                              <span class="type-count">
                                {{ row.value }} · {{ row.share.toFixed(0) }}%
                              </span>
                            </li>
                          }
                        </ul>
                      </div>
                    }
                  </section>
                }
              </div>

              <!-- Quick actions / drill-down links -->
              <h4 class="hp-section-label">Go deeper</h4>
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
                    {{ dlqTotal() ?? '—' }} unresolved · retry posture
                  </span>
                </a>
                <a routerLink="/audit-trail" class="hp-action">
                  <span class="hp-action-label">Audit trail</span>
                  <span class="hp-action-desc">Operator-facing change log</span>
                </a>
                <a routerLink="/system-health/worker-override-knobs" class="hp-action">
                  <span class="hp-action-label">Worker override knobs</span>
                  <span class="hp-action-desc">Config keys each worker reads</span>
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
            <!-- 8-card infra KPI strip — fleet-wide performance signals. Durations are shown
                 in a readable unit (393,015 ms → 6.6 min); the exact ms stays in the title. -->
            <div class="hp-kpis">
              <app-metric-card
                label="Total workers"
                [value]="workerSnapshots().length"
                format="number"
              />
              <app-metric-card
                label="Categories"
                [value]="perCategoryBreakdown().length"
                format="number"
                caption="Grouped by the worker name's first word"
              />
              <!-- Median, not mean: one hourly 13-minute retention sweep dragged the mean P95 to
                   17 s while the typical worker cycles in under 100 ms. -->
              <app-metric-card
                label="Median P95 cycle"
                [value]="infraStats().medianP95Cycle"
                [displayValue]="formatMs(infraStats().medianP95Cycle)"
                format="number"
                [dotColor]="infraStats().medianP95Cycle > 1000 ? 'var(--warning)' : ''"
                [caption]="'Mean of all P95s: ' + formatMs(infraStats().avgP95Cycle)"
                [attr.title]="'Mean of all P95s: ' + infraStats().avgP95Cycle + ' ms'"
              />
              <app-metric-card
                label="Max P99 cycle"
                [value]="infraStats().maxP99Cycle"
                [displayValue]="formatMs(infraStats().maxP99Cycle)"
                format="number"
                [dotColor]="infraStats().maxP99Cycle > 5000 ? 'var(--loss)' : ''"
                [caption]="infraStats().maxP99Worker"
                [attr.title]="
                  (infraStats().maxP99Worker
                    ? 'Slowest: ' + infraStats().maxP99Worker + ' · '
                    : '') +
                  infraStats().maxP99Cycle.toLocaleString() +
                  ' ms'
                "
              />
              <app-metric-card
                label="Errors / hour"
                [value]="infraStats().totalErrorsLastHour"
                format="number"
                [dotColor]="infraStats().totalErrorsLastHour > 0 ? 'var(--loss)' : ''"
              />
              <app-metric-card
                label="Successes / hour"
                [value]="infraStats().totalSuccessesLastHour"
                format="number"
                caption="Completed worker cycles"
              />
              <app-metric-card
                label="Total backlog"
                [value]="infraStats().totalBacklog"
                format="number"
                [dotColor]="infraStats().totalBacklog > 100 ? 'var(--warning)' : ''"
                caption="Items waiting across all workers"
                [attr.title]="'Sum of the backlog depth every worker reports: items waiting, not items processed. On an engine older than 2026-10-19, SpreadProfileWorker also adds the ticks it processed (millions), which then dominate the total.'"
              />
              <app-metric-card
                label="Retries / hour"
                [value]="infraStats().totalRetriesLastHour"
                format="number"
                [dotColor]="infraStats().totalRetriesLastHour > 0 ? 'var(--warning)' : ''"
              />
            </div>

            <!-- Performance first (tail latency + error hot-spots), composition after. -->
            <div class="hp-charts">
              <app-chart-card
                title="P95 cycle duration by category"
                [subtitle]="
                  'Average P95 per category, slowest ' +
                  topCategoryLimit +
                  ' shown · log scale · amber over 1 s — hover a bar for the value'
                "
                [options]="cycleDurationByCategoryOptions()"
                height="300px"
              />
              @if (infraStats().totalErrorsLastHour > 0) {
                <app-chart-card
                  title="Errors per hour by category"
                  subtitle="Hot-spots in the worker fleet"
                  [options]="errorsByCategoryOptions()"
                  height="300px"
                />
              } @else {
                <section class="hp-board">
                  <header class="hp-board-head">
                    <h3>Errors per hour by category</h3>
                    <span class="muted">Hot-spots in the worker fleet</span>
                  </header>
                  <p class="hp-board-empty good">
                    <strong>No errors reported in the last hour</strong>
                    {{ infraStats().totalSuccessesLastHour.toLocaleString() }} completed cycles
                    across {{ workerSnapshots().length }} workers.
                  </p>
                </section>
              }
            </div>

            <div class="hp-charts">
              <app-chart-card
                title="Workers by category"
                [subtitle]="categoryChartSubtitle()"
                [options]="workersByCategoryOptions()"
                height="300px"
              />
              <app-chart-card
                title="Workers by status"
                subtitle="Status distribution across the fleet"
                [options]="workerDonutOptions()"
                height="300px"
              />
            </div>

            <section class="hp-board">
              <header class="hp-board-head">
                <h3>Per-category breakdown</h3>
                <span class="muted">
                  All {{ perCategoryBreakdown().length }} categories ·
                  {{ workerSnapshots().length }} workers
                  @if (perCategoryBreakdown().length > 9) {
                    · scroll the table for the rest
                  }
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
                        <td class="strong">{{ row.category }}</td>
                        <td class="num">{{ row.total }}</td>
                        <td class="num">{{ row.healthy }}</td>
                        <td
                          class="num"
                          [class.warn]="row.degraded > 0"
                          [class.zero]="row.degraded === 0"
                        >
                          {{ row.degraded }}
                        </td>
                        <td
                          class="num"
                          [class.bad]="row.failed > 0"
                          [class.zero]="row.failed === 0"
                        >
                          {{ row.failed }}
                        </td>
                        <td class="num" [class.zero]="row.idle === 0">{{ row.idle }}</td>
                        <!-- Coloured by failures, not by the share: idle workers lower the % without
                             anything being wrong (Feature read a red 33% for two idle workers). -->
                        <td
                          class="num"
                          [class.good]="row.failed + row.degraded === 0 && row.idle === 0"
                          [class.warn]="row.degraded > 0 && row.failed === 0"
                          [class.bad]="row.failed > 0"
                        >
                          {{ row.healthyPct.toFixed(0) }}%
                        </td>
                      </tr>
                    }
                  </tbody>
                  @if (perCategoryBreakdown().length > 0) {
                    <tfoot>
                      <tr class="total-row">
                        <td>All categories</td>
                        <td class="num">{{ workerSnapshots().length }}</td>
                        <td class="num">{{ workerCounts().Healthy }}</td>
                        <td class="num" [class.warn]="workerCounts().Degraded > 0">
                          {{ workerCounts().Degraded }}
                        </td>
                        <td class="num" [class.bad]="workerCounts().Failed > 0">
                          {{ workerCounts().Failed }}
                        </td>
                        <td class="num">{{ workerCounts().Idle }}</td>
                        <td
                          class="num"
                          [class.good]="problemCount() === 0"
                          [class.warn]="workerCounts().Degraded > 0 && workerCounts().Failed === 0"
                          [class.bad]="workerCounts().Failed > 0"
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
                  <span class="muted">
                    @if ((dlqTotal() ?? 0) > deadLetters().length) {
                      Newest {{ deadLetters().length }} of {{ dlqTotal() }} with their delivery
                      attempts
                    } @else {
                      All {{ deadLetters().length }} with their delivery attempts
                    }
                  </span>
                  <a routerLink="/dead-letter" class="head-link">Dead-letter queue →</a>
                </header>
                <table class="hp-board-table">
                  <thead>
                    <tr>
                      <th>Event type</th>
                      <th class="num">Attempts</th>
                      <th class="num">Dead-lettered</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (d of deadLetters(); track d.id) {
                      <tr>
                        <td [title]="d.eventType ?? 'unknown'">
                          <span class="ev-name">{{ eventLabel(d.eventType) }}</span>
                          <span class="ev-raw">{{ d.eventType ?? 'unknown' }}</span>
                        </td>
                        <td
                          class="num"
                          [class.bad]="d.attemptCount >= 3"
                          [class.warn]="d.attemptCount === 2"
                        >
                          {{ d.attemptCount > 0 ? d.attemptCount : '—' }}
                        </td>
                        <td class="num">
                          @if (d.createdAt) {
                            {{ d.createdAt | relativeTime }}
                            <span class="muted"
                              >· {{ d.createdAt | date: 'yyyy-MM-dd HH:mm' }}</span
                            >
                          } @else {
                            —
                          }
                        </td>
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
  styleUrl: './health-page.component.scss',
})
export class HealthPageComponent {
  private readonly healthService = inject(HealthService);
  private readonly workersService = inject(WorkersService);
  private readonly deadLetterSvc = inject(DeadLetterService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);

  /** `Workers:{name}:Enabled` rows of the idle workers — why each one is idle. null = no row. */
  private readonly idleSwitches = signal<Record<string, { value: string; at: string } | null>>({});
  private idleKey = '';

  constructor() {
    // An idle worker with no error is usually switched off on purpose: read its switch so the
    // table says so (and since when) instead of "—". Only re-read when the idle set changes.
    effect(() => {
      const names = this.issuesList()
        .filter((w) => w.status === 'Idle' && !w.lastErrorMessage)
        .map((w) => w.name)
        .sort();
      const key = names.join('|');
      if (key === this.idleKey || names.length === 0) return;
      this.idleKey = key;
      untracked(() =>
        forkJoin(
          names.map((n) =>
            this.config.getByKey(`Workers:${n}:Enabled`, { silent: true }).pipe(
              map((r) =>
                r.status && r.data
                  ? { value: (r.data.value ?? '').trim(), at: r.data.lastUpdatedAt }
                  : null,
              ),
              catchError(() => of(null)),
            ),
          ),
        ).subscribe((rows) => {
          const rec: Record<string, { value: string; at: string } | null> = {};
          names.forEach((n, i) => (rec[n] = rows[i]));
          this.idleSwitches.set(rec);
        }),
      );
    });

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
  // No catchError: a failed read used to become [] and paint "0%" healthy in red; the resource
  // keeps the last good list and records the failure in error().
  protected readonly workersResource = createPolledResource(() => this.workersService.list(), {
    intervalMs: 15_000,
  });

  // Newest 25 unresolved DLQ rows plus the queue's real total (the page used to show the
  // capped row count as "Unresolved DLQ").
  private readonly dlqResource = createPolledResource(
    () =>
      this.deadLetterSvc
        .list({
          currentPage: 1,
          itemCountPerPage: 25,
          filter: { isResolved: false },
          sortBy: 'deadLetteredAt',
          sortDirection: 'desc',
        })
        .pipe(
          map((r) => ({
            rows: r.data?.data ?? [],
            total: r.data?.pager?.totalItemCount ?? r.data?.data?.length ?? 0,
          })),
        ),
    { intervalMs: 15_000 },
  );

  readonly status = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly workerSnapshots = computed(() => this.workersResource.value() ?? []);
  readonly deadLetters = computed<DeadLetterDto[]>(() => this.dlqResource.value()?.rows ?? []);
  /** Unresolved rows in the whole queue; null until the first read lands (rendered "—"). */
  readonly dlqTotal = computed<number | null>(() => this.dlqResource.value()?.total ?? null);

  /** Bars per category chart. Beyond this the axis labels overlap and ECharts
   *  starts hiding every other one, which reads as bars being mislabelled. */
  readonly topCategoryLimit = 12;

  // `paperMode` is the raw EngineConfig string ("true"/"false"), not a mode
  // name — rendering it verbatim produced a "false mode" pill.
  readonly isPaperMode = computed(() => {
    const raw = this.status()?.paperMode;
    if (typeof raw !== 'string') return false;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === 'paper' || v === 'on' || v === '1';
  });
  readonly modeLabel = computed<string | null>(() => {
    const raw = this.status()?.paperMode;
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    return this.isPaperMode() ? 'Paper mode' : 'Live mode';
  });

  /**
   * Worker category, merged case-insensitively. The service already folds
   * acronyms, but a mixed-case pair from an older engine build would still
   * split one subsystem into two rows here, so the page keys on lower-case
   * and displays whichever spelling it saw first.
   */
  private readonly categoryLabels = computed(() => {
    const labels = new Map<string, string>();
    for (const w of this.workerSnapshots()) {
      const raw = (w.category ?? 'Other').trim() || 'Other';
      const key = raw.toLowerCase();
      if (!labels.has(key)) labels.set(key, raw.length <= 3 ? raw.toUpperCase() : raw);
    }
    return labels;
  });
  private categoryOf(w: WorkerHealthDto): string {
    const raw = (w.category ?? 'Other').trim() || 'Other';
    return this.categoryLabels().get(raw.toLowerCase()) ?? raw;
  }

  /** Keep the N largest rows and fold the remainder into one "Other" bucket. */
  private topWithOther<T extends { category: string }>(
    rows: T[],
    valueOf: (r: T) => number,
    make: (label: string, value: number, count: number) => T,
  ): T[] {
    if (rows.length <= this.topCategoryLimit) return rows;
    const head = rows.slice(0, this.topCategoryLimit - 1);
    const tail = rows.slice(this.topCategoryLimit - 1);
    const total = tail.reduce((s, r) => s + valueOf(r), 0);
    return [...head, make(`Other (${tail.length} more)`, total, tail.length)];
  }

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

  /** Failed + degraded — the workers that are actually wrong (idle ones are not). */
  readonly problemCount = computed(() => this.workerCounts().Failed + this.workerCounts().Degraded);

  // Non-healthy workers, capped at 12 — the page's actionable issue list.
  readonly issuesList = computed(() => {
    const order: Record<string, number> = { Failed: 0, Degraded: 1, Idle: 2, Healthy: 3 };
    return this.workerSnapshots()
      .filter((w) => w.status !== 'Healthy')
      .sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99))
      .slice(0, 12);
  });

  /** Structured version of {@link idleReason} for the table cell (key rendered as code). */
  idleReasonFor(name: string): IdleReason {
    return idleReasonOf(name, this.idleSwitches()[name]);
  }

  /** Plain label for an integration-event class name; the raw name is shown beside it. */
  eventLabel(raw: string | null | undefined): string {
    return humanizeEventType(raw);
  }

  /** Duration in a readable unit (393,015 ms → "6.6 min"). */
  formatMs(ms: number): string {
    return formatMs(ms);
  }

  /** One chip per thing that needs attention, worst first; a single "all clear" when none. */
  readonly attention = computed(() => {
    type Chip = { text: string; tone: 'ok' | 'warn' | 'bad'; link: string | null };
    const out: Chip[] = [];
    const s = this.status();
    if (s && !s.isRunning) out.push({ text: 'Engine is not running', tone: 'bad', link: null });
    const c = this.workerCounts();
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    if (c.Failed > 0)
      out.push({
        text: plural(c.Failed, 'failed worker', 'failed workers'),
        tone: 'bad',
        link: '/worker-health',
      });
    if (c.Degraded > 0)
      out.push({
        text: plural(c.Degraded, 'degraded worker', 'degraded workers'),
        tone: 'warn',
        link: '/worker-health',
      });
    const dlq = this.dlqTotal();
    if (dlq !== null && dlq > 0)
      out.push({
        text: plural(dlq, 'unresolved dead letter', 'unresolved dead letters'),
        tone: 'bad',
        link: '/dead-letter',
      });
    if (this.workersResource.error() && this.workerSnapshots().length === 0)
      out.push({ text: 'Worker snapshots could not be loaded', tone: 'warn', link: null });
    if (out.length === 0) out.push({ text: 'Nothing needs attention', tone: 'ok', link: null });
    return out;
  });

  /** Fleet status bar segments (same counts as the donut on Infrastructure). */
  readonly fleetSegments = computed(() => {
    const c = this.workerCounts();
    const total = this.workerSnapshots().length;
    const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
    return [
      { key: 'healthy', label: 'Healthy', count: c.Healthy, pct: pct(c.Healthy) },
      { key: 'degraded', label: 'Degraded', count: c.Degraded, pct: pct(c.Degraded) },
      { key: 'failed', label: 'Failed', count: c.Failed, pct: pct(c.Failed) },
      { key: 'idle', label: 'Idle', count: c.Idle, pct: pct(c.Idle) },
    ];
  });
  readonly fleetAria = computed(() =>
    this.fleetSegments()
      .map((s) => `${s.label} ${s.count}`)
      .join(', '),
  );

  /** Plain reason for an idle worker without an error, from its switch row. */
  idleReason(name: string): string {
    const sw = this.idleSwitches()[name];
    if (sw === undefined) return '—';
    if (sw && sw.value.toLowerCase() === 'false')
      return `Switched off — Workers:${name}:Enabled = false since ${(sw.at ?? '').slice(0, 10)}`;
    return 'Switched on; no completed cycle yet (nothing to do, or a long interval)';
  }

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
      const cat = this.categoryOf(w);
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
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#8E8E93' } },
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

  // Chart rows: the largest categories, with everything past the limit folded
  // into "Other". With 41 categories on a 260 px axis ECharts hid two of every
  // three labels, and the surviving ones no longer sat beside their own bar.
  private readonly workersByCategoryRows = computed(() => {
    const rows = this.perCategoryBreakdown().map((r) => ({ category: r.category, total: r.total }));
    return this.topWithOther(
      rows,
      (r) => r.total,
      (category, total) => ({ category, total }),
    );
  });

  readonly categoryChartSubtitle = computed(() => {
    const all = this.perCategoryBreakdown().length;
    const shown = this.workersByCategoryRows().length;
    const n = this.workerSnapshots().length;
    if (all <= shown) return `How the ${n}-worker fleet is composed · ${all} categories`;
    return `Largest ${shown - 1} of ${all} categories · remainder grouped as Other · ${n} workers`;
  });

  readonly workersByCategoryOptions = computed<EChartsOption>(() => {
    const rows = this.workersByCategoryRows();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 36, bottom: 30, left: 130 },
      xAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#8E8E93' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        // Every row must keep its label; the whole point of capping the row
        // count is that nothing has to be hidden.
        axisLabel: {
          fontSize: 11,
          color: '#8E8E93',
          interval: 0,
          width: 120,
          overflow: 'truncate',
        },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.total,
              itemStyle: {
                color: r.category.startsWith('Other (') ? '#8E8E93' : '#0071E3',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#8E8E93' },
        },
      ],
    };
  });

  readonly dlqEventTypeRows = computed(() => {
    const counts: Record<string, number> = {};
    for (const d of this.deadLetters()) {
      const k = d.eventType ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const total = this.deadLetters().length;
    return Object.entries(counts)
      .map(([name, value]) => ({
        name,
        label: humanizeEventType(name),
        value,
        share: total > 0 ? (value / total) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value);
  });

  readonly dlqEventTypeOptions = computed<EChartsOption>(() => {
    const entries = this.dlqEventTypeRows();
    if (entries.length === 0) return {};
    const palette = ['#FF3B30', '#FF9500', '#AF52DE', '#FFCC00', '#5AC8FA', '#0071E3', '#8E8E93'];
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) => {
          const raw = entries[p.dataIndex]?.name ?? '';
          return `${p.name}: ${p.value} (${p.percent}%)<br/><span style="opacity:.7">${escapeHtml(raw)}</span>`;
        },
      },
      legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 10, color: '#8E8E93' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: entries.map(({ label, value }, i) => ({
            name: label,
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
        medianP95Cycle: 0,
        maxP99Cycle: 0,
        maxP99Worker: null as string | null,
        totalErrorsLastHour: 0,
        totalSuccessesLastHour: 0,
        totalBacklog: 0,
        totalRetriesLastHour: 0,
      };
    }
    const p95s = ws.map((w) => w.cycleDurationP95Ms).filter((v) => Number.isFinite(v));
    const avgP95 = p95s.length > 0 ? p95s.reduce((a, b) => a + b, 0) / p95s.length : 0;
    let maxP99 = 0;
    let maxP99Worker: string | null = null;
    for (const w of ws) {
      if (Number.isFinite(w.cycleDurationP99Ms) && w.cycleDurationP99Ms > maxP99) {
        maxP99 = w.cycleDurationP99Ms;
        maxP99Worker = w.name;
      }
    }
    return {
      avgP95Cycle: Math.round(avgP95),
      medianP95Cycle: Math.round(median(p95s)),
      maxP99Cycle: Math.round(maxP99),
      maxP99Worker,
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
      const cat = this.categoryOf(w);
      if (!groups[cat]) groups[cat] = { sum: 0, count: 0 };
      groups[cat].sum += w.cycleDurationP95Ms;
      groups[cat].count++;
    }
    // Slowest categories only — the tail (dozens of sub-100 ms categories)
    // is what piled 40 value labels into a 40 px strip. The value now lives
    // in the tooltip; the bar length and colour band carry the reading.
    // A log axis cannot place 0 (or anything under 1 ms), so those categories are left out.
    const rows = Object.entries(groups)
      .map(([category, g]) => ({ category, avg: g.count > 0 ? g.sum / g.count : 0 }))
      .filter((r) => r.avg >= 1)
      .sort((a, b) => b.avg - a.avg)
      .slice(0, this.topCategoryLimit);
    if (rows.length === 0) return {};
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>Avg P95: ${Math.round(p.value).toLocaleString()} ms`;
        },
      },
      // Log scale: one 13-minute retention sweep made every other bar a hairline on a linear
      // axis. right: 40 keeps the "ms" axis name from being clipped at the card edge.
      grid: { top: 10, right: 40, bottom: 30, left: 130 },
      xAxis: {
        type: 'log',
        logBase: 10,
        min: 1,
        name: 'ms',
        nameTextStyle: { fontSize: 10, color: '#8E8E93' },
        // Compact decades ("1k", "1M"): the full "1,000,000" labels ran into each other in the
        // narrow card ("1 10 10(10(10…").
        axisLabel: {
          fontSize: 10,
          color: '#8E8E93',
          hideOverlap: true,
          formatter: (v: number) =>
            v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : String(v),
        },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        axisLabel: {
          fontSize: 11,
          color: '#8E8E93',
          interval: 0,
          width: 120,
          overflow: 'truncate',
        },
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
          barWidth: 12,
          label: { show: false },
        },
      ],
    };
  });

  // Errors-per-hour grouped by worker category — surfaces hot-spots.
  readonly errorsByCategoryOptions = computed<EChartsOption>(() => {
    const groups: Record<string, number> = {};
    for (const w of this.workerSnapshots()) {
      const cat = this.categoryOf(w);
      groups[cat] = (groups[cat] ?? 0) + (w.errorsLastHour ?? 0);
    }
    // Only categories that actually errored — a bar of zero is not a hot-spot.
    const rows = this.topWithOther(
      Object.entries(groups)
        .map(([category, errors]) => ({ category, errors }))
        .filter((r) => r.errors > 0)
        .sort((a, b) => b.errors - a.errors),
      (r) => r.errors,
      (category, errors) => ({ category, errors }),
    );
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
      grid: { top: 10, right: 50, bottom: 30, left: 130 },
      xAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#8E8E93' },
        splitLine: { lineStyle: { color: 'rgba(142,142,147,0.15)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        axisLabel: {
          fontSize: 11,
          color: '#8E8E93',
          interval: 0,
          width: 120,
          overflow: 'truncate',
        },
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
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#8E8E93' },
        },
      ],
    };
  });
}

/** Middle value (mean of the middle two for an even count); 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
