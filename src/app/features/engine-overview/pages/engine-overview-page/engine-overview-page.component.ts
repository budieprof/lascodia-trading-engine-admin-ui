import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, forkJoin, interval, of, startWith, type Observable } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { HealthService } from '@core/services/health.service';
import { WorkersService } from '@core/services/workers.service';
import { DeadLetterService } from '@core/services/dead-letter.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  DeadLetterDto,
  EngineStatusDto,
  ResponseData,
  WorkerHealthDto,
} from '@core/api/api.types';

import type { EChartsOption } from 'echarts';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { RouterLink } from '@angular/router';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { SecurityApiService } from '@features/security/security-api.service';
import type { RoleBuildSkew } from '@features/security/security.types';
import { ago } from '@features/iam/shared/admin-context.logic';
import type { EAInstanceDto } from '@core/api/api.types';
import { attentionItems, eventTypeLabel } from './engine-overview.logic';

/**
 * One-screen engine health summary. Two presentation modes:
 *
 *   * **Compact** (default) — fits inside the standard layout chrome, used
 *     for desk monitoring while doing other work.
 *   * **Wall** (`?wall=1` or the toggle button) — densifies + scales for
 *     readability across a NOC. Requests browser fullscreen, hides the
 *     subtitle, scales numbers ~3×, and pushes the worker + DLQ panels into
 *     a 12-column grid that fills the viewport.
 *
 * Polls every 10s — cheaper than per-event push because all three sources
 * change continuously and a slightly-stale view is fine for a quick glance.
 * The deeper per-area pages stay where they were for drill-down.
 */
@Component({
  selector: 'app-engine-overview-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ChartCardComponent,
    ConfirmDialogComponent,
    RelativeTimePipe,
    RouterLink,
  ],
  template: `
    <div class="page" [class.wall]="wallMode()">
      @if (!wallMode()) {
        <app-page-header
          title="Engine Overview"
          subtitle="Live status, worker health, and unresolved dead-letters at a glance"
        >
          <button type="button" class="btn-secondary" (click)="enterWallMode()">
            Wall display →
          </button>
        </app-page-header>
      } @else {
        <header class="wall-bar">
          <h1>Engine Overview</h1>
          <div class="wall-meta">
            @if (lastRefreshAt(); as t) {
              <span class="refresh">⟳ {{ t | relativeTime }}</span>
            }
            <button type="button" class="btn-ghost" (click)="exitWallMode()">Exit</button>
          </div>
        </header>
      }

      @if (loading() && !status()) {
        <app-card-skeleton [lines]="6" />
      } @else {
        <!-- Headline: is the engine up, and does anything need a look? Worst first. -->
        <section
          class="status-card"
          [attr.data-running]="status()?.isRunning ? '1' : '0'"
          aria-label="Engine status"
        >
          <div class="status-id">
            <div class="status-dot"></div>
            <div class="status-text">
              <span class="status-label">Engine</span>
              <span class="status-value">
                {{ status()?.isRunning ? 'Running' : 'Stopped' }}
              </span>
              @if (status()?.checkedAt) {
                <span class="status-meta">checked {{ status()!.checkedAt | relativeTime }}</span>
              }
            </div>
          </div>
          <div class="attention">
            @if (attention().length === 0) {
              <span class="all-clear">Nothing needs attention.</span>
            } @else {
              <span class="att-label">Needs a look</span>
              @for (a of attention(); track a.text) {
                @if (a.target === null) {
                  <span class="att" [attr.data-tone]="a.tone">{{ a.text }}</span>
                } @else {
                  <button
                    type="button"
                    class="att"
                    [attr.data-tone]="a.tone"
                    [title]="
                      a.target === 'dlq' ? 'Open the dead-letter queue' : 'Open worker health'
                    "
                    (click)="a.target === 'dlq' ? goDeadLetters() : goWorkers()"
                  >
                    {{ a.text }}
                  </button>
                }
              }
            }
          </div>
        </section>

        <section class="kpi-row">
          <div class="kpi">
            <span class="label">Active strategies</span>
            <span class="value">{{ status()?.activeStrategies ?? '—' }}</span>
          </div>
          <div class="kpi">
            <span class="label">Open positions</span>
            <span class="value">{{ status()?.openPositions ?? '—' }}</span>
          </div>
          <div class="kpi">
            <span class="label">Pending orders</span>
            <span class="value">{{ status()?.pendingOrders ?? '—' }}</span>
          </div>
          <div class="kpi" [class.warn]="paperMode() === true">
            <span class="label">Paper mode</span>
            <span class="value" [title]="paperMode() === null ? '' : paperModeHint()">
              {{ paperModeLabel() }}
            </span>
            @if (paperMode() !== null) {
              <span class="hint">{{
                paperMode() ? 'orders are simulated' : 'orders go to brokers'
              }}</span>
            }
          </div>
          <div class="kpi">
            <span class="label">Total workers</span>
            <span class="value">{{ workerSnapshots().length }}</span>
            @if (workerSnapshots().length > 0) {
              <span class="hint">{{ workerCounts().Healthy }} healthy</span>
            }
          </div>
          <!-- Uncoloured until the fleet has reported: 0 workers is unknown, not 0% healthy. -->
          <div
            class="kpi"
            [class.pos]="workerSnapshots().length > 0 && healthyPct() >= 95"
            [class.warn]="workerSnapshots().length > 0 && healthyPct() < 95 && healthyPct() >= 80"
            [class.neg]="workerSnapshots().length > 0 && healthyPct() < 80"
          >
            <span class="label">Healthy %</span>
            <span
              class="value"
              [class.good]="workerSnapshots().length > 0 && healthyPct() >= 95"
              [class.warn]="workerSnapshots().length > 0 && healthyPct() < 95 && healthyPct() >= 80"
              [class.bad]="workerSnapshots().length > 0 && healthyPct() < 80"
            >
              {{ workerSnapshots().length > 0 ? healthyPct().toFixed(0) + '%' : '—' }}
            </span>
            @if (workerSnapshots().length > 0) {
              <span class="hint">{{
                workerCounts().Failed + workerCounts().Degraded === 0
                  ? '0 failed / degraded'
                  : workerCounts().Failed + workerCounts().Degraded + ' failed / degraded'
              }}</span>
            }
          </div>
          @if (canSeeDeadLetters()) {
            <div class="kpi" [class.warn]="dlqTotal() > 0">
              <span class="label">Unresolved DLQ</span>
              <!-- The queue's total, not the 25 rows the panel below lists. -->
              <span class="value" [class.bad]="dlqTotal() > 0">{{ dlqTotal() }}</span>
              <span class="hint">{{ dlqTotal() > 0 ? 'to retry or discard' : 'queue clean' }}</span>
            </div>
          }
        </section>

        <!-- 3-col chart row. Below three categories a donut is a single ring and a histogram a
             lone bar — neither says more than the number, so those cases render as a compact
             stat list in the same slot. -->
        @if (!wallMode()) {
          <section class="row charts-row">
            @if (workerStatusEntries().length >= 3) {
              <app-chart-card
                title="Worker status"
                [subtitle]="workerSnapshots().length + ' workers'"
                [options]="workerDonutOptions()"
                height="240px"
              />
            } @else {
              <div class="panel compact-stat">
                <header class="panel-head">
                  <h3>Worker status</h3>
                  <span class="head-hint">{{ workerSnapshots().length }} workers</span>
                </header>
                @if (workerStatusEntries().length === 0) {
                  <p class="muted small">No worker snapshots reported yet.</p>
                } @else {
                  <ul class="stat-list">
                    @for (e of workerStatusEntries(); track e.name) {
                      <li>
                        <span class="stat-swatch" [style.background]="e.color"></span>
                        <span class="stat-name">{{ e.name }}</span>
                        <span class="stat-value">{{ e.value }}</span>
                        <span class="stat-share muted">{{ e.share.toFixed(0) }}%</span>
                      </li>
                    }
                  </ul>
                }
              </div>
            }

            @if (canSeeDeadLetters()) {
              @if (dlqTypeEntries().length >= 3) {
                <app-chart-card
                  title="Dead letters by type"
                  subtitle="Unresolved"
                  [options]="dlqEventTypeOptions()"
                  height="240px"
                />
              } @else {
                <div class="panel compact-stat">
                  <header class="panel-head">
                    <h3>Dead letters by type</h3>
                    <span class="head-hint">unresolved</span>
                  </header>
                  @if (dlqTypeEntries().length === 0) {
                    <p class="muted small">No unresolved dead-letters.</p>
                  } @else {
                    <ul class="stat-list">
                      @for (e of dlqTypeEntries(); track e.raw) {
                        <li>
                          <span class="stat-swatch" [style.background]="e.color"></span>
                          <span class="stat-name" [title]="e.raw">{{ e.name }}</span>
                          <span class="stat-value">{{ e.value }}</span>
                          <span class="stat-share muted">{{ e.share.toFixed(0) }}%</span>
                        </li>
                      }
                    </ul>
                  }
                </div>
              }

              @if (dlqAttemptEntries().length >= 3) {
                <app-chart-card
                  title="Retry attempts"
                  subtitle="Unresolved rows"
                  [options]="dlqAttemptHistogram()"
                  height="240px"
                />
              } @else {
                <div class="panel compact-stat">
                  <header class="panel-head">
                    <h3>Retry attempts</h3>
                    <span class="head-hint">unresolved rows</span>
                  </header>
                  @if (dlqAttemptEntries().length === 0) {
                    <p class="muted small">No unresolved dead-letters.</p>
                  } @else {
                    <ul class="stat-list no-swatch">
                      @for (e of dlqAttemptEntries(); track e.name) {
                        <li>
                          <span class="stat-name">
                            {{ e.name }} {{ e.name === '1' ? 'attempt' : 'attempts' }}
                          </span>
                          <span class="stat-value">{{ e.value }}</span>
                          <span class="stat-share muted">{{ e.value === 1 ? 'row' : 'rows' }}</span>
                        </li>
                      }
                    </ul>
                  }
                </div>
              }
            }
          </section>
        }

        <!-- Worker health row -->
        <section class="row">
          <div class="panel">
            <header class="panel-head">
              <h3>Workers</h3>
              <button type="button" class="link" (click)="goWorkers()">View all →</button>
            </header>
            <!-- A zero is neutral: "0 failed" painted red reads as a failure. -->
            <div class="worker-totals">
              <div class="bucket" data-bucket="healthy" [class.zero]="workerCounts().Healthy === 0">
                <span class="bucket-count">{{ workerCounts().Healthy }}</span>
                <span class="bucket-label">Healthy</span>
              </div>
              <div
                class="bucket"
                data-bucket="degraded"
                [class.zero]="workerCounts().Degraded === 0"
              >
                <span class="bucket-count">{{ workerCounts().Degraded }}</span>
                <span class="bucket-label">Degraded</span>
              </div>
              <div class="bucket" data-bucket="failed" [class.zero]="workerCounts().Failed === 0">
                <span class="bucket-count">{{ workerCounts().Failed }}</span>
                <span class="bucket-label">Failed</span>
              </div>
              <div class="bucket" data-bucket="idle" [class.zero]="workerCounts().Idle === 0">
                <span class="bucket-count">{{ workerCounts().Idle }}</span>
                <span class="bucket-label">Idle</span>
              </div>
            </div>
            @if (worstWorkers().length > 0) {
              <p class="list-caption">
                Showing {{ worstWorkers().length }} of {{ nonHealthyCount() }} non-healthy
                {{ nonHealthyCount() === 1 ? 'worker' : 'workers' }} — failed first, then degraded,
                then idle.
              </p>
              <ul class="worker-list">
                @for (w of worstWorkers(); track w.name) {
                  <li class="worker-item" [attr.data-status]="w.status.toLowerCase()">
                    <span class="status-pill">{{ w.status }}</span>
                    <span class="worker-name" [title]="w.name">{{ w.name }}</span>
                    @if (w.lastErrorMessage) {
                      <span class="worker-msg" [title]="w.lastErrorMessage">
                        {{ w.lastErrorMessage }}
                      </span>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="muted small">All workers reporting healthy.</p>
            }
          </div>

          <!-- The queue is platform machinery (platform.infrastructure.manage, catalog v2): without
               the key the engine refuses the list, so the DLQ figures are left out, not shown as 0. -->
          @if (canSeeDeadLetters()) {
            <!-- Dead-letter row -->
            <div class="panel">
              <header class="panel-head">
                <h3>Dead-letter queue</h3>
                <button type="button" class="link" (click)="goDeadLetters()">View all →</button>
              </header>
              @if (deadLetters().length === 0) {
                <app-empty-state
                  title="Queue clean"
                  description="No unresolved dead-letter rows in the last 25 events."
                />
              } @else {
                <p class="list-caption">
                  {{ dlqTotal() }} unresolved {{ dlqTotal() === 1 ? 'row' : 'rows'
                  }}{{
                    dlqTotal() > deadLetters().length
                      ? ' — newest ' + deadLetters().length + ' shown'
                      : ''
                  }}. Retry re-publishes the event; Discard marks it resolved without replaying.
                  Both ask first.
                </p>
                <ul class="dlq-list">
                  @for (d of deadLetters(); track d.id) {
                    <li class="dlq-item" [class.busy]="dlqBusy().has(d.id)">
                      <div class="dlq-main">
                        <div class="dlq-title">
                          <span class="dlq-type">{{ eventLabel(d.eventType) }}</span>
                          <span class="dlq-raw" [title]="d.eventType ?? ''"
                            >#{{ d.id }} · {{ d.eventType ?? 'unknown' }}</span
                          >
                        </div>
                        <span class="dlq-meta">
                          <span class="dlq-attempts" [class.hot]="d.attemptCount >= 3">
                            {{ d.attemptCount }}
                            {{ d.attemptCount === 1 ? 'attempt' : 'attempts' }}
                          </span>
                          · {{ d.createdAt | relativeTime }}
                        </span>
                        @if (d.errorMessage) {
                          <span class="dlq-err" [title]="d.errorMessage">{{ d.errorMessage }}</span>
                        }
                      </div>
                      <div class="dlq-actions">
                        <button
                          type="button"
                          class="btn-mini"
                          [disabled]="dlqBusy().has(d.id)"
                          (click)="askDlqAction(d, 'retry')"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          class="btn-mini danger"
                          [disabled]="dlqBusy().has(d.id)"
                          (click)="askDlqAction(d, 'discard')"
                        >
                          Discard
                        </button>
                      </div>
                    </li>
                  }
                </ul>
              }
            </div>
          }
        </section>
      }

      @if (!wallMode()) {
        <div class="row">
          <section class="panel">
            <header class="panel-head">
              <h3>Engine processes</h3>
              <a class="link" routerLink="/releases">Builds →</a>
            </header>
            @if (builds(); as b) {
              <ul class="ctx-list">
                @for (r of b.roles; track r.role) {
                  <li>
                    <span class="ctx-dot" [class.stale]="r.hoursBehind > 0"></span>
                    <strong>{{ roleLabel(r.role) }}</strong>
                    <span class="ctx-muted"
                      >started {{ ago(r.startedAtUtc) }} · last seen {{ ago(r.lastSeenAtUtc) }} ·
                      build <span class="mono">{{ r.buildId.slice(0, 8) }}</span></span
                    >
                  </li>
                }
              </ul>
              <p class="ctx-note" [class.skew]="b.hasSkew">
                {{
                  b.hasSkew
                    ? b.distinctBuilds +
                      ' different builds are running — one process was recreated without the others.'
                    : 'All processes run one build.'
                }}
              </p>
            } @else {
              <p class="ctx-note">The process list needs operator access, or is loading.</p>
            }
          </section>
          <section class="panel">
            <header class="panel-head">
              <h3>Connected terminals</h3>
              <a class="link" routerLink="/ea-instances">EA instances →</a>
            </header>
            @if (terminals().length) {
              <ul class="ctx-list">
                @for (t of terminals(); track t.id) {
                  <li>
                    <span class="ctx-dot" [class.stale]="t.status !== 'Active'"></span>
                    <strong>{{ t.chartSymbol || t.instanceId }}</strong>
                    <span class="ctx-muted"
                      >account #{{ t.tradingAccountId }} · EA {{ t.eaVersion || '?' }} · heartbeat
                      {{ ago(t.lastHeartbeat) }}{{ t.isCoordinator ? ' · coordinator' : '' }}</span
                    >
                  </li>
                }
              </ul>
            } @else {
              <p class="ctx-note">
                No terminal is connected. The engine trades MT5 accounts only through connected EAs.
              </p>
            }
          </section>
        </div>
      }

      <!-- Both actions change an operational record: Retry re-publishes the event to every
           handler, Discard closes it for good. Neither fires from one click. -->
      <app-confirm-dialog
        [open]="pendingDlq() !== null"
        [title]="dlqConfirmTitle()"
        [message]="dlqConfirmMessage()"
        [confirmLabel]="pendingDlq()?.action === 'discard' ? 'Discard' : 'Retry'"
        [confirmVariant]="pendingDlq()?.action === 'discard' ? 'destructive' : 'primary'"
        [loading]="dlqConfirmLoading()"
        (confirm)="confirmDlqAction()"
        (cancelled)="pendingDlq.set(null)"
      />
    </div>
  `,
  styleUrl: './engine-overview-page.component.scss',
})
export class EngineOverviewPageComponent {
  private readonly auth = inject(AuthService);
  private readonly health = inject(HealthService);
  private readonly workers = inject(WorkersService);
  private readonly deadLetterSvc = inject(DeadLetterService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notify = inject(NotificationService);

  readonly loading = signal(true);
  readonly status = signal<EngineStatusDto | null>(null);
  readonly workerSnapshots = signal<WorkerHealthDto[]>([]);
  /** `POST dead-letter/list` needs `platform.infrastructure.manage` (catalog v2). */
  readonly canSeeDeadLetters = computed(() =>
    this.auth.hasPermission(Permission.PlatformInfrastructureManage),
  );
  readonly deadLetters = signal<DeadLetterDto[]>([]);
  /** Unresolved rows in the whole queue (pager total) — `deadLetters` holds only the newest 25. */
  readonly dlqTotal = signal(0);
  readonly lastRefreshAt = signal<string | null>(null);

  /** Toggled via `?wall=1` query param or the in-page button. */
  readonly wallMode = signal(this.route.snapshot.queryParamMap.get('wall') === '1');

  readonly workerCounts = computed(() => {
    const buckets = { Healthy: 0, Degraded: 0, Failed: 0, Idle: 0 };
    for (const w of this.workerSnapshots()) {
      if (w.status in buckets) buckets[w.status as keyof typeof buckets]++;
    }
    return buckets;
  });

  // Healthy % across the worker fleet — feeds the new KPI tile and lets
  // the operator spot a drift before opening the workers page.
  readonly healthyPct = computed(() => {
    const total = this.workerSnapshots().length;
    if (total === 0) return 0;
    return (this.workerCounts().Healthy / total) * 100;
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

  readonly dlqEventTypeOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const d of this.deadLetters()) {
      const k = eventTypeLabel(d.eventType);
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

  readonly dlqAttemptHistogram = computed<EChartsOption>(() => {
    const buckets: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 };
    for (const d of this.deadLetters()) {
      const a = d.attemptCount ?? 0;
      if (a <= 1) buckets['1']++;
      else if (a === 2) buckets['2']++;
      else if (a === 3) buckets['3']++;
      else if (a === 4) buckets['4']++;
      else buckets['5+']++;
    }
    if (this.deadLetters().length === 0) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 36, left: 40 },
      xAxis: {
        type: 'category',
        data: Object.keys(buckets),
        name: 'attempts',
        nameLocation: 'middle',
        nameGap: 24,
        nameTextStyle: { fontSize: 11, color: '#8E8E93' },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        // Row counts are integers; a 0.2 / 0.4 tick ladder on a one-row queue is nonsense.
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: Object.entries(buckets).map(([k, v]) => ({
            value: v,
            // Color escalates with retry count so a tall "5+" bar stands out.
            itemStyle: {
              color: k === '1' || k === '2' ? '#FF9500' : k === '3' ? '#FF6B30' : '#FF3B30',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  // ── Compact fallbacks for the chart row ────────────────────────────
  // Same numbers the charts use, as ranked lists, for the below-three-categories case.
  readonly workerStatusEntries = computed(() => {
    const c = this.workerCounts();
    const total = this.workerSnapshots().length;
    const palette = { Healthy: '#34C759', Degraded: '#FF9500', Failed: '#FF3B30', Idle: '#0071E3' };
    return (Object.keys(c) as (keyof typeof c)[])
      .filter((k) => c[k] > 0)
      .map((k) => ({
        name: k,
        value: c[k],
        color: palette[k],
        share: total > 0 ? (c[k] / total) * 100 : 0,
      }));
  });

  readonly dlqTypeEntries = computed(() => {
    const counts: Record<string, number> = {};
    for (const d of this.deadLetters()) {
      const k = d.eventType ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const total = this.deadLetters().length;
    const palette = ['#FF3B30', '#FF9500', '#AF52DE', '#FFCC00', '#5AC8FA', '#0071E3', '#8E8E93'];
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([raw, value], i) => ({
        raw,
        name: eventTypeLabel(raw),
        value,
        color: palette[i % palette.length],
        share: total > 0 ? (value / total) * 100 : 0,
      }));
  });

  readonly dlqAttemptEntries = computed(() => {
    const buckets: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 };
    for (const d of this.deadLetters()) {
      const a = d.attemptCount ?? 0;
      const k = a <= 1 ? '1' : a >= 5 ? '5+' : String(a);
      buckets[k]++;
    }
    return Object.entries(buckets)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value }));
  });

  // ── Paper mode ─────────────────────────────────────────────────────
  // The engine reports paper mode as a string ("true" / "false"); the raw token is not copy.
  readonly paperMode = computed<boolean | null>(() => {
    const raw = this.status()?.paperMode;
    if (raw === null || raw === undefined || raw === '') return null;
    const v = String(raw).trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
    return null;
  });
  readonly paperModeLabel = computed(() => {
    const on = this.paperMode();
    return on === null ? '—' : on ? 'On' : 'Off';
  });
  readonly paperModeHint = computed(() =>
    this.paperMode() ? 'Paper mode: orders are simulated' : 'Live trading: orders go to brokers',
  );

  /** The headline chips: what needs a look, worst first (idle listed but neutral). */
  readonly attention = computed(() => {
    const c = this.workerCounts();
    const s = this.status();
    return attentionItems({
      running: s ? s.isRunning : null,
      failed: c.Failed,
      degraded: c.Degraded,
      idle: c.Idle,
      dlqTotal: this.canSeeDeadLetters() ? this.dlqTotal() : null,
    });
  });

  protected readonly eventLabel = eventTypeLabel;

  readonly nonHealthyCount = computed(
    () => this.workerSnapshots().filter((w) => w.status !== 'Healthy').length,
  );

  readonly worstWorkers = computed(() => {
    const order: Record<string, number> = { Failed: 0, Degraded: 1, Idle: 2, Healthy: 3 };
    // Wall mode shows more rows because the screen is bigger and a NOC
    // operator scanning from across the room benefits from seeing every
    // unhealthy worker, not just the top 6.
    const cap = this.wallMode() ? 12 : 6;
    return this.workerSnapshots()
      .filter((w) => w.status !== 'Healthy')
      .sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99))
      .slice(0, cap);
  });

  private readonly securityApi = inject(SecurityApiService);
  private readonly eaApi = inject(EAInstancesService);
  protected readonly ago = (utc: string | null) => ago(utc);
  readonly builds = signal<RoleBuildSkew | null>(null);
  readonly terminals = signal<EAInstanceDto[]>([]);

  roleLabel(role: string): string {
    const labels: Record<string, string> = {
      'money-path': 'Trading',
      research: 'Research and backtesting',
      llm: 'AI analysis',
    };
    return labels[role] ?? role;
  }

  private loadContext(): void {
    if (!this.auth.hasPermission(Permission.AccessOperator)) return;
    this.securityApi
      .engineBuilds()
      .subscribe({ next: (b) => this.builds.set(b), error: () => undefined });
    this.eaApi.list().subscribe({
      next: (r) => this.terminals.set((r?.data ?? []).filter((t) => t.status === 'Active')),
      error: () => undefined,
    });
  }

  constructor() {
    interval(10_000)
      .pipe(startWith(0), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
    interval(60_000)
      .pipe(startWith(0), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.loadContext());
  }

  protected goWorkers(): void {
    this.router.navigate(['/worker-health']);
  }

  protected goDeadLetters(): void {
    this.router.navigate(['/dead-letter']);
  }

  // ── Dead-letter actions ────────────────────────────────────────────
  // The card used to show only an unlabeled "×N" per row; an operator scanning the wall had no
  // way to act without leaving the page. Both actions refresh so the row disappears on success.
  // Both go through a confirmation: the 2026-10-19 review caught Discard closing an operational
  // record (PUT dead-letter/{id}/resolve) straight from one click.
  readonly dlqBusy = signal<ReadonlySet<number>>(new Set());
  readonly pendingDlq = signal<{ row: DeadLetterDto; action: 'retry' | 'discard' } | null>(null);
  protected readonly dlqConfirmLoading = computed(() => {
    const p = this.pendingDlq();
    return p !== null && this.dlqBusy().has(p.row.id);
  });
  protected readonly dlqConfirmTitle = computed(() =>
    this.pendingDlq()?.action === 'discard'
      ? `Discard dead letter #${this.pendingDlq()!.row.id}?`
      : `Retry dead letter #${this.pendingDlq()?.row.id ?? ''}?`,
  );
  protected readonly dlqConfirmMessage = computed(() => {
    const p = this.pendingDlq();
    if (!p) return '';
    const type = p.row.eventType ?? 'this event';
    return p.action === 'discard'
      ? `${type} will be marked resolved and never replayed. Whatever its handlers should have done stays undone.`
      : `${type} is re-published to every handler now. Handlers that already applied part of it will see it again.`;
  });

  protected askDlqAction(d: DeadLetterDto, action: 'retry' | 'discard'): void {
    this.pendingDlq.set({ row: d, action });
  }

  protected confirmDlqAction(): void {
    const p = this.pendingDlq();
    if (!p || this.dlqBusy().has(p.row.id)) return;
    const call =
      p.action === 'discard'
        ? this.deadLetterSvc.resolve(p.row.id)
        : this.deadLetterSvc.replay(p.row.id);
    this.runDlqAction(p.row, p.action, call);
  }

  private runDlqAction(
    row: DeadLetterDto,
    action: 'retry' | 'discard',
    call: Observable<ResponseData<unknown>>,
  ): void {
    const id = row.id;
    this.dlqBusy.update((s) => new Set(s).add(id));
    // HTTP failures are toasted by the error interceptor; a refused envelope (status false,
    // e.g. "already resolved") arrives as a 200 and used to vanish without a word.
    call.pipe(catchError(() => of(null))).subscribe((res) => {
      this.dlqBusy.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      this.pendingDlq.set(null);
      if (res?.status) {
        this.notify.success(
          action === 'discard' ? `Dead letter #${id} discarded` : `Dead letter #${id} replayed`,
        );
      } else if (res) {
        this.notify.error(res.message ?? `Could not ${action} dead letter #${id}`);
      }
      this.refresh();
    });
  }

  /**
   * Enter wall mode: flip the signal, push `?wall=1` so reloads stick, and
   * request browser fullscreen so the chrome/sidebar disappear. Fullscreen
   * may be denied (cross-origin iframe, missing user gesture) — fail soft,
   * the CSS densification still applies.
   */
  protected enterWallMode(): void {
    this.wallMode.set(true);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { wall: 1 },
      queryParamsHandling: 'merge',
    });
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        /* User gesture missing or denied — wall mode still works without it. */
      });
    }
  }

  protected exitWallMode(): void {
    this.wallMode.set(false);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { wall: null },
      queryParamsHandling: 'merge',
    });
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
  }

  private refresh(): void {
    forkJoin({
      status: this.health.getStatus().pipe(catchError(() => of(null))),
      workers: this.workers.list().pipe(catchError(() => of(null))),
      deadLetters: this.canSeeDeadLetters()
        ? this.deadLetterSvc
            .list({
              currentPage: 1,
              itemCountPerPage: 25,
              filter: { isResolved: false },
              sortBy: 'deadLetteredAt',
              sortDirection: 'desc',
            })
            .pipe(catchError(() => of(null)))
        : of(null),
    }).subscribe(({ status, workers, deadLetters }) => {
      if (status?.data) this.status.set(status.data);
      // /health/workers returns a raw array, not a ResponseData envelope.
      if (workers) this.workerSnapshots.set(workers);
      if (deadLetters?.data) {
        const rows = deadLetters.data.data ?? [];
        this.deadLetters.set(rows);
        this.dlqTotal.set(deadLetters.data.pager?.totalItemCount ?? rows.length);
      }
      this.lastRefreshAt.set(new Date().toISOString());
      this.loading.set(false);
    });
  }
}
