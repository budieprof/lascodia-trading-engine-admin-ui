import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { map } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { WorkersService } from '@core/services/workers.service';
import type { WorkerHealthDto, WorkerHealthStatus } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

import {
  attentionRank,
  formatMs,
  latencyTone,
  needsAttention,
  workerReasons,
  type WorkerReason,
} from './worker-health.util';

/** 'attention' = failed, degraded or stale — the operator's usual question. */
type StatusFilter = 'all' | 'attention' | WorkerHealthStatus;
type SortMode = 'category' | 'p95' | 'errors' | 'backlog';
type ViewMode = 'cards' | 'table';

/** Rows per category chart; past this the axis labels collide. */
const TOP_CATEGORIES = 12;
/** Card grids larger than this scroll inside a capped box. */
const CARD_GRID_CAP = 12;

@Component({
  selector: 'app-worker-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    FormsModule,
    DecimalPipe,
    RelativeTimePipe,
    RefreshButtonComponent,
    NgTemplateOutlet,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Worker Health"
        subtitle="Real-time snapshot of every background worker"
      >
        <app-refresh-button [refreshing]="resource.refreshing()" (refresh)="refresh()" />
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error() && workers().length === 0) {
        <app-error-state
          title="Could not load worker health"
          message="The engine's /health/workers endpoint did not respond."
          (retry)="refresh()"
        />
      } @else if (workers().length > 0) {
        <!-- Verdict first: the operator comes here to learn whether any worker is unhealthy. -->
        <section
          class="verdict"
          [class.warn]="verdictTone() === 'warn'"
          [class.bad]="verdictTone() === 'bad'"
        >
          <span class="v-dot" aria-hidden="true"></span>
          <div class="v-text">
            <h2>{{ verdictHeadline() }}</h2>
            <p>
              {{ verdictDetail() }}
              @if (capturedAt()) {
                · snapshot {{ capturedAt() | relativeTime }} · refreshes every 30 s
              }
            </p>
          </div>
        </section>

        <!-- Needs attention: every failed / degraded / stale worker with the reason, worst first. -->
        <section class="panel" aria-labelledby="wh-attention">
          <header class="panel-head">
            <h3 id="wh-attention">Needs attention</h3>
            <span
              class="count"
              [class.bad]="failedCount() > 0"
              [class.warn]="failedCount() === 0 && attention().length > 0"
              >{{ attention().length }}</span
            >
            <span class="hint"
              >Failed, degraded and stale workers, worst first, with the reason</span
            >
          </header>
          @if (attention().length > 0) {
            <ng-container
              [ngTemplateOutlet]="attTable"
              [ngTemplateOutletContext]="{ $implicit: attention() }"
            />
          } @else {
            <p class="att-empty">
              <strong>Nothing needs attention.</strong> No worker is failed, degraded or stale.
            </p>
          }
          @if (idleWorkers().length > 0) {
            <details class="idle">
              <summary>
                {{ idleWorkers().length }} idle worker{{ idleWorkers().length === 1 ? '' : 's' }}
                <span class="hint">not doing work right now — usually by design; why for each</span>
              </summary>
              <ng-container
                [ngTemplateOutlet]="attTable"
                [ngTemplateOutletContext]="{ $implicit: idleWorkers() }"
              />
            </details>
          }
        </section>

        <ng-template #attTable let-rows>
          <table class="att">
            <thead>
              <tr>
                <th>Status</th>
                <th>Worker</th>
                <th>Why</th>
                <th>Last error</th>
                <th>Last success</th>
              </tr>
            </thead>
            <tbody>
              @for (w of asWorkers(rows); track w.name) {
                <tr>
                  <td>
                    @if (w.isStale && !w.isCompleted) {
                      <span class="pill pill-stale">{{ w.status }} · stale</span>
                    } @else {
                      <span class="pill" [attr.data-status]="w.status">{{ w.status }}</span>
                    }
                  </td>
                  <td class="w-name">
                    {{ w.name }}
                    <span class="sub">
                      {{ w.category }} ·
                      @if (w.isCompleted) {
                        one-shot
                      } @else {
                        every {{ formatInterval(w.configuredIntervalSeconds) }}
                      }
                    </span>
                  </td>
                  <td>
                    <ul class="reasons">
                      @for (r of reasonsOf(w); track r.text) {
                        <li [class]="r.tone">{{ r.text }}</li>
                      } @empty {
                        <li>{{ w.status }}</li>
                      }
                    </ul>
                  </td>
                  <td class="err-msg">
                    @if (w.lastErrorMessage) {
                      {{ w.lastErrorMessage }}
                    } @else {
                      <span class="none">—</span>
                    }
                    @if (w.lastErrorAt) {
                      <span class="sub" [title]="w.lastErrorAt">{{
                        w.lastErrorAt | relativeTime
                      }}</span>
                    }
                  </td>
                  <td class="when" [title]="w.lastSuccessAt ?? ''">
                    @if (w.lastSuccessAt) {
                      {{ w.lastSuccessAt | relativeTime }}
                    } @else {
                      never
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </ng-template>

        <!-- 10-card KPI strip — fleet status + tail-latency + traffic -->
        <div class="kpis">
          <app-metric-card label="Total" [value]="workers().length" format="number" />
          <app-metric-card
            label="Healthy"
            [value]="healthyCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Degraded"
            [value]="degradedCount()"
            format="number"
            [dotColor]="degradedCount() > 0 ? '#FF9500' : ''"
            caption="errors > 5 % or stale"
          />
          <app-metric-card
            label="Failed"
            [value]="failedCount()"
            format="number"
            [dotColor]="failedCount() > 0 ? '#FF3B30' : ''"
            caption="failing cycles in a row"
          />
          <app-metric-card
            label="Idle"
            [value]="idleCount()"
            format="number"
            caption="stopped, or no work yet"
          />
          <app-metric-card
            label="Stale"
            [value]="staleCount()"
            format="number"
            [dotColor]="staleCount() > 0 ? '#AF52DE' : ''"
            caption="no success in 3× interval"
          />
          <!-- Median, not mean: one hourly 13-minute sweep dragged the mean P95 to ~17 s while
               the typical worker cycles in under 100 ms. -->
          <app-metric-card
            label="Median P95 cycle"
            [value]="fleetStats().medianP95"
            [displayValue]="fmtMs(fleetStats().medianP95)"
            format="number"
            [caption]="'mean of all P95s ' + fmtMs(fleetStats().avgP95)"
          />
          <!-- Neutral: the slowest P99 is a long-cadence sweep by design; overrunning workers are
               flagged against their own interval in the lists below. -->
          <app-metric-card
            label="Max P99 cycle"
            [value]="fleetStats().maxP99"
            [displayValue]="fmtMs(fleetStats().maxP99)"
            format="number"
            [caption]="fleetStats().maxP99Worker"
          />
          <app-metric-card
            label="Errors / hr"
            [value]="fleetStats().errorsLastHour"
            format="number"
            [dotColor]="fleetStats().errorsLastHour > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Backlog"
            [value]="fleetStats().totalBacklog"
            format="number"
            [dotColor]="fleetStats().totalBacklog > 100 ? '#FF9500' : ''"
            caption="items waiting, all queues"
            [attr.title]="'Sum of the backlog depth every worker reports: items waiting, not items processed. On an engine older than 2026-10-19, SpreadProfileWorker also adds the ticks it processed (millions), which then dominate the total.'"
          />
        </div>

        <!-- Hot spots: top-N slowest, top-N error workers, top-N backlog -->
        <div class="hotspots-row">
          <section class="hotspot">
            <header class="hotspot-head">
              <h3>Slowest workers</h3>
              <span class="muted">P95 cycle, against each worker's interval</span>
            </header>
            @if (topSlowest().length > 0) {
              <table class="mini">
                <tbody>
                  @for (w of topSlowest(); track w.name) {
                    <tr>
                      <td class="mono name" [title]="w.name">{{ w.name }}</td>
                      <td>
                        <span class="pill" [attr.data-status]="w.status">{{ w.status }}</span>
                      </td>
                      <td
                        class="num mono"
                        [class.warn]="toneOf(w) === 'warn'"
                        [class.bad]="toneOf(w) === 'bad'"
                        [title]="
                          (w.cycleDurationP95Ms | number: '1.0-0') +
                          ' ms' +
                          (toneOf(w) === 'bad'
                            ? ' — longer than its interval'
                            : toneOf(w) === 'warn'
                              ? ' — over half its interval'
                              : '')
                        "
                      >
                        {{ fmtMs(w.cycleDurationP95Ms) }}
                      </td>
                      <td class="num muted sub">
                        @if (w.isCompleted) {
                          one-shot
                        } @else {
                          / {{ formatInterval(w.configuredIntervalSeconds) }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <span class="empty">No P95 samples yet</span>
            }
          </section>

          <section class="hotspot">
            <header class="hotspot-head">
              <h3>Most error-prone</h3>
              <span class="muted">Errors in the last hour</span>
            </header>
            @if (topErrorWorkers().length > 0) {
              <table class="mini">
                <tbody>
                  @for (w of topErrorWorkers(); track w.name) {
                    <tr>
                      <td class="mono name" [title]="w.name">{{ w.name }}</td>
                      <td class="num mono bad">{{ w.errorsLastHour }}</td>
                      <td class="num mono muted">{{ w.errorRate * 100 | number: '1.0-1' }}%</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <span class="empty good">No errors reported</span>
            }
          </section>

          <section class="hotspot">
            <header class="hotspot-head">
              <h3>Largest backlog</h3>
              <span class="muted">Queue depth right now</span>
            </header>
            @if (topBacklog().length > 0) {
              <table class="mini">
                <tbody>
                  @for (w of topBacklog(); track w.name) {
                    <tr>
                      <td class="mono name" [title]="w.name">{{ w.name }}</td>
                      <td
                        class="num mono"
                        [class.warn]="w.backlogDepth > 100"
                        [class.bad]="w.backlogDepth > 1000"
                      >
                        {{ w.backlogDepth | number }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <span class="empty good">All queues empty</span>
            }
          </section>
        </div>

        <h2 class="section-title">All workers by category</h2>
        <div class="toolbar-wrap">
          <div class="toolbar">
            <input
              type="text"
              class="input search"
              placeholder="Filter by name…"
              aria-label="Filter workers by name"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
            />
            <div class="seg" role="group" aria-label="Status filter">
              @for (s of statusOptions(); track s.value) {
                <button
                  type="button"
                  [class.on]="statusFilter() === s.value"
                  [attr.aria-pressed]="statusFilter() === s.value"
                  [title]="s.title"
                  (click)="statusFilter.set(s.value)"
                >
                  {{ s.label
                  }}<span
                    class="n"
                    [class.bad]="s.tone === 'bad'"
                    [class.warn]="s.tone === 'warn'"
                    >{{ s.count }}</span
                  >
                </button>
              }
            </div>
            <select
              class="input"
              aria-label="Category"
              [ngModel]="categoryFilter()"
              (ngModelChange)="categoryFilter.set($event)"
            >
              <option value="all">All categories</option>
              @for (c of categories(); track c) {
                <option [value]="c">{{ c }} ({{ categoryCounts()[c] }})</option>
              }
            </select>
            <select
              class="input"
              aria-label="Sort"
              [ngModel]="sortBy()"
              (ngModelChange)="sortBy.set($event)"
              title="Sort within each category"
            >
              <option value="category">Sort: status (default)</option>
              <option value="p95">Sort: P95 cycle (slowest first)</option>
              <option value="errors">Sort: errors (most first)</option>
              <option value="backlog">Sort: backlog (largest first)</option>
            </select>
          </div>
          <div class="subbar">
            <div class="seg" role="group" aria-label="View mode">
              <button
                type="button"
                [class.on]="viewMode() === 'cards'"
                [attr.aria-pressed]="viewMode() === 'cards'"
                (click)="viewMode.set('cards')"
              >
                Cards
              </button>
              <button
                type="button"
                [class.on]="viewMode() === 'table'"
                [attr.aria-pressed]="viewMode() === 'table'"
                (click)="viewMode.set('table')"
              >
                Dense
              </button>
            </div>
            <div class="expand-controls" role="group" aria-label="Expand categories">
              <!-- Disabled with a reason when nothing is failed, degraded or stale — it used to be
                   a live link that silently did nothing on a healthy fleet. -->
              <button
                type="button"
                class="link-btn"
                [disabled]="problemGroupCount() === 0"
                [title]="
                  problemGroupCount() === 0
                    ? 'No category has a failed, degraded or stale worker'
                    : 'Expand the ' + problemGroupCount() + ' categories with problems'
                "
                (click)="expandProblems()"
              >
                Expand problems{{ problemGroupCount() > 0 ? ' (' + problemGroupCount() + ')' : '' }}
              </button>
              <button type="button" class="link-btn" (click)="expandAll()">Expand all</button>
              <button type="button" class="link-btn" (click)="collapseAll()">Collapse all</button>
            </div>
            <span class="spacer"></span>
            <span class="muted">
              {{ filtered().length }} of {{ workers().length }} workers · {{ expanded().size }} of
              {{ groupedByCategory().length }} categories expanded
            </span>
          </div>
        </div>

        @if (groupedByCategory().length === 0) {
          <p class="att-empty">No worker matches these filters.</p>
        }

        <!-- Collapsed categories pack two per row; an expanded one takes the
             full width. 38 single-line headers each on their own 60 px row
             was 60 % empty screen. -->
        <div class="categories">
          @for (group of groupedByCategory(); track group.category) {
            <section
              class="category-section"
              [class.collapsed]="!isExpanded(group.category)"
              [class.expanded]="isExpanded(group.category)"
            >
              <header
                class="category-head"
                role="button"
                tabindex="0"
                [attr.aria-expanded]="isExpanded(group.category)"
                [attr.aria-controls]="'cat-body-' + group.category"
                (click)="toggleCategory(group.category)"
                (keydown.enter)="toggleCategory(group.category)"
                (keydown.space)="toggleCategory(group.category); $event.preventDefault()"
              >
                <span class="chevron" aria-hidden="true">
                  {{ isExpanded(group.category) ? '▾' : '▸' }}
                </span>
                <h3>{{ group.category }}</h3>
                <span class="muted">
                  {{ group.workers.length }} worker{{ group.workers.length === 1 ? '' : 's' }}
                </span>
                @if (group.failedCount > 0) {
                  <span class="pill" data-status="Failed">{{ group.failedCount }} failed</span>
                }
                @if (group.degradedCount > 0) {
                  <span class="pill" data-status="Degraded">
                    {{ group.degradedCount }} degraded
                  </span>
                }
                @if (group.staleCount > 0) {
                  <span class="pill pill-stale">{{ group.staleCount }} stale</span>
                }
                <span
                  class="agg-pill"
                  [class.warn-pill]="group.latencyTone === 'warn'"
                  [class.bad-pill]="group.latencyTone === 'bad'"
                  [title]="
                    'Average P95 cycle duration in this category' +
                    (group.latencyTone === 'bad'
                      ? ' — a worker here runs longer than its own interval'
                      : group.latencyTone === 'warn'
                        ? ' — a worker here uses over half its interval'
                        : '')
                  "
                >
                  avg P95 {{ fmtMs(group.avgP95) }}
                </span>
                <span
                  class="agg-pill"
                  [class.bad-pill]="group.errorsLastHour > 0"
                  [title]="
                    group.errorsLastHour +
                    ' errors / ' +
                    group.successesLastHour +
                    ' successes in the last hour'
                  "
                >
                  {{ group.errorsLastHour }} err · {{ group.successesLastHour }} ok
                </span>
                @if (group.totalBacklog > 0) {
                  <span class="agg-pill" [class.warn-pill]="group.totalBacklog > 100">
                    backlog {{ group.totalBacklog | number }}
                  </span>
                }
              </header>

              @if (isExpanded(group.category)) {
                <div [id]="'cat-body-' + group.category">
                  @if (viewMode() === 'cards') {
                    @if (group.workers.length > cardGridCap) {
                      <p class="grid-cap-note muted">
                        All {{ group.workers.length }} workers — this group scrolls.
                      </p>
                    }
                    <div class="grid-scroll" [class.capped]="group.workers.length > cardGridCap">
                      <div class="grid">
                        @for (w of group.workers; track w.name) {
                          <article class="card" [attr.data-status]="w.status">
                            <header class="card-head">
                              <span class="status-dot" [attr.data-status]="w.status"></span>
                              <div class="title">
                                <h4 [title]="w.name">{{ w.name }}</h4>
                                <span class="muted">
                                  @if (w.isCompleted) {
                                    one-shot · completed
                                  } @else {
                                    every {{ formatInterval(w.configuredIntervalSeconds) }}
                                  }
                                </span>
                              </div>
                              <!-- A Healthy pill next to "(stale)" in the footer
                                 contradicted itself; the stale flag is part of
                                 the status line now. A finished one-shot is stale
                                 by construction, so it is exempt. -->
                              @if (w.isStale && !w.isCompleted) {
                                <span
                                  class="pill pill-stale"
                                  title="Status as last reported, but no successful cycle recently"
                                >
                                  {{ w.status }} · stale
                                </span>
                              } @else {
                                <span class="pill" [attr.data-status]="w.status">{{
                                  w.status
                                }}</span>
                              }
                            </header>

                            @if (reasonsOf(w).length > 0) {
                              <ul class="reasons card-why">
                                @for (r of reasonsOf(w); track r.text) {
                                  <li [class]="r.tone">{{ r.text }}</li>
                                }
                              </ul>
                            }

                            <dl class="metrics-grid">
                              <div>
                                <dt>Cycle (p50/p95)</dt>
                                <dd class="mono">
                                  {{ w.cycleDurationP50Ms | number: '1.0-0' }} /
                                  <span
                                    [class.warn]="toneOf(w) === 'warn'"
                                    [class.bad]="toneOf(w) === 'bad'"
                                    [title]="
                                      toneOf(w) === 'bad'
                                        ? 'P95 longer than the worker interval'
                                        : toneOf(w) === 'warn'
                                          ? 'P95 over half the worker interval'
                                          : ''
                                    "
                                  >
                                    {{ w.cycleDurationP95Ms | number: '1.0-0' }}
                                  </span>
                                  ms
                                </dd>
                              </div>
                              <div>
                                <dt>Last cycle</dt>
                                <dd class="mono">
                                  {{ w.lastCycleDurationMs | number: '1.0-0' }} ms
                                </dd>
                              </div>
                              <div>
                                <dt>Errors / Successes (1h)</dt>
                                <dd
                                  class="mono"
                                  [class.bad]="w.errorRate > 0.05"
                                  [class.warn]="w.errorRate > 0 && w.errorRate <= 0.05"
                                >
                                  {{ w.errorsLastHour }} / {{ w.successesLastHour }}
                                  @if (w.errorRate > 0) {
                                    <span class="err-rate">
                                      ({{ w.errorRate * 100 | number: '1.0-1' }}%)
                                    </span>
                                  }
                                </dd>
                              </div>
                              <div>
                                <dt>Backlog</dt>
                                <dd class="mono" [class.bad]="w.backlogDepth > 100">
                                  {{ w.backlogDepth | number }}
                                </dd>
                              </div>
                              @if (w.consecutiveFailures > 0) {
                                <div class="span-2">
                                  <dt class="bad-label">Consecutive failures</dt>
                                  <dd class="mono bad">{{ w.consecutiveFailures }}</dd>
                                </div>
                              }
                            </dl>

                            <footer class="card-foot">
                              @if (w.lastSuccessAt) {
                                <span class="foot-line">
                                  <span class="muted">Last success</span>
                                  <span
                                    [class.warn]="w.isStale && !w.isCompleted"
                                    [title]="w.lastSuccessAt"
                                  >
                                    {{ w.lastSuccessAt | relativeTime }}
                                    @if (w.isStale && !w.isCompleted) {
                                      (stale)
                                    }
                                  </span>
                                </span>
                              } @else {
                                <span class="foot-line muted">No successful cycle yet</span>
                              }
                              @if (w.lastErrorAt) {
                                <span class="foot-line err">
                                  <span class="muted">Last error</span>
                                  <span [title]="w.lastErrorAt">{{
                                    w.lastErrorAt | relativeTime
                                  }}</span>
                                </span>
                              }
                              @if (w.lastErrorMessage) {
                                <span class="foot-line msg" [title]="w.lastErrorMessage">
                                  {{ w.lastErrorMessage }}
                                </span>
                              }
                            </footer>
                          </article>
                        }
                      </div>
                    </div>
                  } @else {
                    <!-- Dense table mode: ~15× more workers per screen -->
                    <div class="dense-wrap">
                      <table class="dense">
                        <thead>
                          <tr>
                            <th>Status</th>
                            <th>Worker</th>
                            <th>Schedule</th>
                            <th class="num">P50 / P95</th>
                            <th class="num">Last cycle</th>
                            <th class="num">Err / Ok (1h)</th>
                            <th class="num">Err rate</th>
                            <th class="num">Backlog</th>
                            <th class="num">Cons. fail</th>
                            <th>Last success</th>
                            <th>Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (w of group.workers; track w.name) {
                            <tr>
                              <td>
                                @if (w.isStale && !w.isCompleted) {
                                  <span class="pill pill-stale">{{ w.status }} · stale</span>
                                } @else {
                                  <span class="pill" [attr.data-status]="w.status">
                                    {{ w.status }}
                                  </span>
                                }
                              </td>
                              <td class="mono name" [title]="w.name">{{ w.name }}</td>
                              <td class="mono muted">
                                @if (w.isCompleted) {
                                  one-shot
                                } @else {
                                  every {{ formatInterval(w.configuredIntervalSeconds) }}
                                }
                              </td>
                              <td class="num mono">
                                {{ w.cycleDurationP50Ms | number: '1.0-0' }} /
                                <span
                                  [class.warn]="toneOf(w) === 'warn'"
                                  [class.bad]="toneOf(w) === 'bad'"
                                >
                                  {{ w.cycleDurationP95Ms | number: '1.0-0' }}
                                </span>
                              </td>
                              <td class="num mono">
                                {{ w.lastCycleDurationMs | number: '1.0-0' }}
                              </td>
                              <td class="num mono">
                                <span [class.bad]="w.errorsLastHour > 0">{{
                                  w.errorsLastHour
                                }}</span>
                                / {{ w.successesLastHour }}
                              </td>
                              <td
                                class="num mono"
                                [class.bad]="w.errorRate > 0.05"
                                [class.warn]="w.errorRate > 0 && w.errorRate <= 0.05"
                              >
                                @if (w.errorsLastHour + w.successesLastHour > 0) {
                                  {{ w.errorRate * 100 | number: '1.0-1' }}%
                                } @else {
                                  —
                                }
                              </td>
                              <td
                                class="num mono"
                                [class.warn]="w.backlogDepth > 100"
                                [class.bad]="w.backlogDepth > 1000"
                              >
                                {{ w.backlogDepth | number }}
                              </td>
                              <td class="num mono" [class.bad]="w.consecutiveFailures > 0">
                                {{ w.consecutiveFailures }}
                              </td>
                              <td
                                class="mono"
                                [class.warn]="w.isStale && !w.isCompleted"
                                [title]="w.lastSuccessAt ?? ''"
                              >
                                @if (w.lastSuccessAt) {
                                  {{ w.lastSuccessAt | relativeTime }}
                                } @else {
                                  never
                                }
                              </td>
                              <td class="why" [title]="reasonText(w)">
                                {{ reasonText(w) || '—' }}
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }
                </div>
              }
            </section>
          }
        </div>

        <!-- Composition charts: context, not the answer — kept below the worker list. -->
        <h2 class="section-title">Fleet composition</h2>
        <div class="chart-row">
          <app-chart-card
            title="Status distribution"
            subtitle="Healthy · Degraded · Failed · Idle"
            [options]="statusDonutOptions()"
            height="260px"
          />
          <app-chart-card
            title="Workers by category"
            [subtitle]="categoryChartSubtitle()"
            [options]="workersByCategoryOptions()"
            height="260px"
          />
          <app-chart-card
            title="P95 cycle by category"
            [subtitle]="
              'Average P95 per category, slowest ' +
              topCategoryLimit +
              ' shown · log scale — hover a bar for the value'
            "
            [options]="cycleByCategoryOptions()"
            height="260px"
          />
        </div>
      } @else {
        <app-empty-state
          title="No worker data"
          description="The engine did not return any workers from /health/workers."
        />
      }
    </div>
  `,
  styleUrl: './worker-health-page.scss',
})
export class WorkerHealthPageComponent {
  private readonly workersService = inject(WorkersService);

  // No catchError: the polled resource records failures in `.error()` and
  // keeps polling. Swallowing them rendered an outage as "No worker data".
  protected readonly resource = createPolledResource(
    () =>
      this.workersService.list().pipe(
        // /health/workers returns a raw array (no ResponseData envelope) — see WorkersService.
        map((rows) => rows ?? []),
      ),
    { intervalMs: 30_000 },
  );

  readonly workers = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly topCategoryLimit = TOP_CATEGORIES;
  readonly cardGridCap = CARD_GRID_CAP;

  readonly search = signal('');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly categoryFilter = signal<string>('all');
  readonly sortBy = signal<SortMode>('category');
  readonly viewMode = signal<ViewMode>('cards');

  // Per-category expansion state. Default is "auto" — categories with problems
  // (failed / degraded / stale) auto-expand, the rest stay collapsed so the
  // page is short on a healthy fleet. Once the user clicks anything, we lock
  // the state to their explicit selection (`userToggled`).
  readonly expanded = signal<Set<string>>(new Set());
  private readonly userToggled = signal(false);

  constructor() {
    // Seed default-expanded categories from the first non-empty group set.
    // After the user interacts, this stops applying.
    effect(() => {
      if (this.userToggled()) return;
      const groups = this.groupedByCategory();
      if (groups.length === 0) return;
      const init = new Set(
        groups
          .filter((g) => g.failedCount + g.degradedCount + g.staleCount > 0)
          .map((g) => g.category),
      );
      this.expanded.set(init);
    });
  }

  isExpanded(category: string): boolean {
    return this.expanded().has(category);
  }

  toggleCategory(category: string): void {
    const next = new Set(this.expanded());
    if (next.has(category)) next.delete(category);
    else next.add(category);
    this.expanded.set(next);
    this.userToggled.set(true);
  }

  expandAll(): void {
    this.expanded.set(new Set(this.groupedByCategory().map((g) => g.category)));
    this.userToggled.set(true);
  }

  collapseAll(): void {
    this.expanded.set(new Set());
    this.userToggled.set(true);
  }

  /** Categories holding a failed, degraded or stale worker — what "Expand problems" opens. */
  readonly problemGroupCount = computed(
    () =>
      this.groupedByCategory().filter((g) => g.failedCount + g.degradedCount + g.staleCount > 0)
        .length,
  );

  expandProblems(): void {
    const init = new Set(
      this.groupedByCategory()
        .filter((g) => g.failedCount + g.degradedCount + g.staleCount > 0)
        .map((g) => g.category),
    );
    this.expanded.set(init);
    this.userToggled.set(true);
  }

  readonly categories = computed(() => {
    const set = new Set<string>();
    for (const w of this.workers()) {
      if (w.category) set.add(w.category);
    }
    return Array.from(set).sort();
  });

  readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim();
    const st = this.statusFilter();
    const cat = this.categoryFilter();
    return this.workers().filter((w) => {
      if (st === 'attention') {
        if (!needsAttention(w)) return false;
      } else if (st !== 'all' && w.status !== st) return false;
      if (cat !== 'all' && w.category !== cat) return false;
      if (q && !w.name.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  readonly healthyCount = computed(
    () => this.workers().filter((w) => w.status === 'Healthy').length,
  );
  readonly degradedCount = computed(
    () => this.workers().filter((w) => w.status === 'Degraded').length,
  );
  readonly failedCount = computed(() => this.workers().filter((w) => w.status === 'Failed').length);
  readonly idleCount = computed(() => this.workers().filter((w) => w.status === 'Idle').length);
  // Completed one-shots are excluded: they have no next cycle to be late for.
  readonly staleCount = computed(
    () => this.workers().filter((w) => w.isStale && !w.isCompleted).length,
  );

  readonly categoryCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const w of this.workers()) {
      counts[w.category] = (counts[w.category] ?? 0) + 1;
    }
    return counts;
  });

  /**
   * The 160-card flat grid is unreadable at this density. Group by category
   * (ML, Strategy, Risk, …) so the operator can scan one subsystem at a time;
   * within each group, sort Failed → Degraded → Idle → Healthy so problems
   * float to the top regardless of alphabetical position. The per-group sort
   * is overridable via `sortBy` so operators can re-rank by P95, errors, or
   * backlog within each category.
   */
  readonly groupedByCategory = computed(() => {
    const buckets = new Map<string, WorkerHealthDto[]>();
    for (const w of this.filtered()) {
      const list = buckets.get(w.category) ?? [];
      list.push(w);
      buckets.set(w.category, list);
    }
    const statusRank: Record<WorkerHealthStatus, number> = {
      Failed: 0,
      Degraded: 1,
      Idle: 2,
      Healthy: 3,
    };
    const sort = this.sortBy();
    const cmp = (a: WorkerHealthDto, b: WorkerHealthDto): number => {
      switch (sort) {
        case 'p95':
          return (b.cycleDurationP95Ms ?? 0) - (a.cycleDurationP95Ms ?? 0);
        case 'errors':
          return (b.errorsLastHour ?? 0) - (a.errorsLastHour ?? 0);
        case 'backlog':
          return (b.backlogDepth ?? 0) - (a.backlogDepth ?? 0);
        case 'category':
        default: {
          const r = statusRank[a.status] - statusRank[b.status];
          return r !== 0 ? r : a.name.localeCompare(b.name);
        }
      }
    };
    return (
      Array.from(buckets.entries())
        .map(([category, workers]) => {
          const p95s = workers.map((w) => w.cycleDurationP95Ms).filter((v) => Number.isFinite(v));
          const avgP95 = p95s.length > 0 ? p95s.reduce((a, b) => a + b, 0) / p95s.length : 0;
          return {
            category,
            workers: [...workers].sort(cmp),
            failedCount: workers.filter((w) => w.status === 'Failed').length,
            degradedCount: workers.filter((w) => w.status === 'Degraded').length,
            staleCount: workers.filter((w) => w.isStale && !w.isCompleted).length,
            avgP95,
            latencyTone: worstLatencyTone(workers),
            errorsLastHour: workers.reduce((s, w) => s + (w.errorsLastHour ?? 0), 0),
            successesLastHour: workers.reduce((s, w) => s + (w.successesLastHour ?? 0), 0),
            totalBacklog: workers.reduce((s, w) => s + (w.backlogDepth ?? 0), 0),
          };
        })
        // Categories with the most problems first, then alphabetical.
        .sort((a, b) => {
          const aProb = a.failedCount * 100 + a.degradedCount * 10 + a.staleCount;
          const bProb = b.failedCount * 100 + b.degradedCount * 10 + b.staleCount;
          if (aProb !== bProb) return bProb - aProb;
          return a.category.localeCompare(b.category);
        })
    );
  });

  // Fleet-wide tail-latency + traffic aggregates for the KPI strip.
  readonly fleetStats = computed(() => {
    const ws = this.workers();
    if (ws.length === 0) {
      return {
        avgP95: 0,
        medianP95: 0,
        maxP99: 0,
        maxP99Worker: '',
        errorsLastHour: 0,
        totalBacklog: 0,
      };
    }
    const p95s = ws.map((w) => w.cycleDurationP95Ms).filter((v) => Number.isFinite(v));
    const avgP95 = p95s.length > 0 ? p95s.reduce((a, b) => a + b, 0) / p95s.length : 0;
    const sorted = [...p95s].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianP95 =
      sorted.length === 0
        ? 0
        : sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
    let maxP99 = 0;
    let maxP99Worker = '';
    for (const w of ws) {
      if (Number.isFinite(w.cycleDurationP99Ms) && w.cycleDurationP99Ms > maxP99) {
        maxP99 = w.cycleDurationP99Ms;
        maxP99Worker = w.name;
      }
    }
    return {
      avgP95: Math.round(avgP95),
      medianP95: Math.round(medianP95),
      maxP99: Math.round(maxP99),
      maxP99Worker,
      errorsLastHour: ws.reduce((s, w) => s + (w.errorsLastHour ?? 0), 0),
      totalBacklog: ws.reduce((s, w) => s + (w.backlogDepth ?? 0), 0),
    };
  });

  // Top-5 slowest workers across the fleet by P95 cycle time.
  readonly topSlowest = computed(() =>
    [...this.workers()]
      .filter((w) => Number.isFinite(w.cycleDurationP95Ms) && w.cycleDurationP95Ms > 0)
      .sort((a, b) => b.cycleDurationP95Ms - a.cycleDurationP95Ms)
      .slice(0, 5),
  );

  // Top-5 workers by errors in the last hour.
  readonly topErrorWorkers = computed(() =>
    [...this.workers()]
      .filter((w) => (w.errorsLastHour ?? 0) > 0)
      .sort((a, b) => (b.errorsLastHour ?? 0) - (a.errorsLastHour ?? 0))
      .slice(0, 5),
  );

  // Top-5 workers by current backlog depth.
  readonly topBacklog = computed(() =>
    [...this.workers()]
      .filter((w) => (w.backlogDepth ?? 0) > 0)
      .sort((a, b) => (b.backlogDepth ?? 0) - (a.backlogDepth ?? 0))
      .slice(0, 5),
  );

  readonly statusDonutOptions = computed<EChartsOption>(() => {
    const total = this.workers().length;
    if (total === 0) return {};
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
            { value: this.healthyCount(), name: 'Healthy', itemStyle: { color: '#34C759' } },
            { value: this.degradedCount(), name: 'Degraded', itemStyle: { color: '#FF9500' } },
            { value: this.failedCount(), name: 'Failed', itemStyle: { color: '#FF3B30' } },
            { value: this.idleCount(), name: 'Idle', itemStyle: { color: '#0071E3' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  // Largest categories, the rest folded into one "Other" row. With 40+
  // categories on one axis ECharts dropped two of every three labels and the
  // survivors no longer sat beside their own bars.
  private readonly workersByCategoryRows = computed(() => {
    const entries = Object.entries(this.categoryCounts())
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
    if (entries.length <= TOP_CATEGORIES) return entries;
    const head = entries.slice(0, TOP_CATEGORIES - 1);
    const tail = entries.slice(TOP_CATEGORIES - 1);
    return [
      ...head,
      {
        category: `Other (${tail.length} more)`,
        total: tail.reduce((s, r) => s + r.total, 0),
      },
    ];
  });

  readonly categoryChartSubtitle = computed(() => {
    const all = this.categories().length;
    const shown = this.workersByCategoryRows().length;
    const n = this.workers().length;
    if (all <= shown) return `Composition of the ${n}-worker fleet · ${all} categories`;
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
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.category).reverse(),
        // Every row keeps its label — that is the point of capping the rows.
        axisLabel: {
          fontSize: 11,
          color: '#6E6E73',
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
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // Avg P95 cycle duration grouped by worker category — tail-latency view.
  readonly cycleByCategoryOptions = computed<EChartsOption>(() => {
    const groups: Record<string, { sum: number; count: number }> = {};
    for (const w of this.workers()) {
      if (!Number.isFinite(w.cycleDurationP95Ms)) continue;
      const cat = w.category ?? 'Other';
      if (!groups[cat]) groups[cat] = { sum: 0, count: 0 };
      groups[cat].sum += w.cycleDurationP95Ms;
      groups[cat].count++;
    }
    // Slowest categories only; the long tail of sub-100 ms categories is what
    // piled forty "NN ms" labels into a 40 px strip. The value is on hover;
    // bar length and colour band carry the reading.
    // A log axis cannot place 0 (or anything under 1 ms), so those categories are left out.
    const rows = Object.entries(groups)
      .map(([cat, g]) => ({ cat, avg: g.count > 0 ? g.sum / g.count : 0 }))
      .filter((r) => r.avg >= 1)
      .sort((a, b) => b.avg - a.avg)
      .slice(0, TOP_CATEGORIES);
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
      // Log scale: on a linear axis one 13-minute sweep turned every other bar into a hairline.
      // right: 40 keeps the "ms" axis name inside the card.
      grid: { top: 10, right: 40, bottom: 30, left: 130 },
      xAxis: {
        type: 'log',
        logBase: 10,
        min: 1,
        name: 'ms',
        nameTextStyle: { fontSize: 10, color: '#6E6E73' },
        // Compact decades ("1k", "1M"): the full "1,000,000" labels ran into each other in the
        // narrow card ("1 10 10(10(10…").
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          hideOverlap: true,
          formatter: (v: number) =>
            v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : String(v),
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.cat).reverse(),
        axisLabel: {
          fontSize: 11,
          color: '#6E6E73',
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
                // One neutral hue: a long average is often a long-cadence sweep doing its job.
                // Whether a worker overruns its own schedule is flagged per worker above.
                color: '#0A84FF',
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

  // ---------- Attention ----------

  /** Failed, degraded and stale workers, worst first. */
  readonly attention = computed(() =>
    this.workers()
      .filter(needsAttention)
      .sort((a, b) => attentionRank(a) - attentionRank(b) || a.name.localeCompare(b.name)),
  );

  /** Idle workers that are not already in the attention list. */
  readonly idleWorkers = computed(() =>
    this.workers()
      .filter((w) => w.status === 'Idle' && !needsAttention(w))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** Newest snapshot time across the rows. */
  readonly capturedAt = computed(() => {
    let best: string | null = null;
    let bestMs = -Infinity;
    for (const w of this.workers()) {
      const t = w.capturedAt ? new Date(w.capturedAt).getTime() : NaN;
      if (Number.isFinite(t) && t > bestMs) {
        bestMs = t;
        best = w.capturedAt;
      }
    }
    return best;
  });

  readonly verdictTone = computed<'ok' | 'warn' | 'bad'>(() =>
    this.failedCount() > 0 ? 'bad' : this.attention().length > 0 ? 'warn' : 'ok',
  );

  readonly verdictHeadline = computed(() => {
    const n = this.attention().length;
    if (n === 0) {
      const active = this.workers().length - this.idleCount();
      return `All ${active} active worker${active === 1 ? ' is' : 's are'} healthy`;
    }
    const parts: string[] = [];
    if (this.failedCount() > 0) parts.push(`${this.failedCount()} failed`);
    if (this.degradedCount() > 0) parts.push(`${this.degradedCount()} degraded`);
    const staleOnly = this.attention().filter(
      (w) => w.status !== 'Failed' && w.status !== 'Degraded',
    ).length;
    if (staleOnly > 0) parts.push(`${staleOnly} stale`);
    return `${n} worker${n === 1 ? ' needs' : 's need'} attention — ${parts.join(', ')}`;
  });

  readonly verdictDetail = computed(() => {
    const idle = this.idleCount();
    const errs = this.fleetStats().errorsLastHour;
    return [
      `${this.workers().length} workers`,
      `${idle} idle`,
      `${errs} error${errs === 1 ? '' : 's'} in the last hour`,
    ].join(' · ');
  });

  readonly statusOptions = computed(() => {
    const opts: {
      value: StatusFilter;
      label: string;
      count: number;
      tone: '' | 'warn' | 'bad';
      title: string;
    }[] = [
      { value: 'all', label: 'All', count: this.workers().length, tone: '', title: 'Every worker' },
      {
        value: 'attention',
        label: 'Needs attention',
        count: this.attention().length,
        tone: this.failedCount() > 0 ? 'bad' : this.attention().length > 0 ? 'warn' : '',
        title: 'Failed, degraded or stale',
      },
      {
        value: 'Failed',
        label: 'Failed',
        count: this.failedCount(),
        tone: this.failedCount() > 0 ? 'bad' : '',
        title: 'At least one failed cycle in a row',
      },
      {
        value: 'Degraded',
        label: 'Degraded',
        count: this.degradedCount(),
        tone: this.degradedCount() > 0 ? 'warn' : '',
        title: 'Error rate above 5 % in the last hour, or stale',
      },
      {
        value: 'Idle',
        label: 'Idle',
        count: this.idleCount(),
        tone: '',
        title: 'Stopped, or running with no successful cycle yet',
      },
      {
        value: 'Healthy',
        label: 'Healthy',
        count: this.healthyCount(),
        tone: '',
        title: 'Cycling normally (finished one-shots count here)',
      },
    ];
    return opts;
  });

  // Reasons are pure per row; memoised by object identity so the template can call them freely.
  private reasonCache = new WeakMap<WorkerHealthDto, WorkerReason[]>();

  reasonsOf(w: WorkerHealthDto): WorkerReason[] {
    let r = this.reasonCache.get(w);
    if (!r) {
      r = workerReasons(w);
      this.reasonCache.set(w, r);
    }
    return r;
  }

  reasonText(w: WorkerHealthDto): string {
    return this.reasonsOf(w)
      .map((r) => r.text)
      .join(' · ');
  }

  /** Narrows the ng-template context (typed as any) back to worker rows. */
  asWorkers(rows: unknown): WorkerHealthDto[] {
    return Array.isArray(rows) ? (rows as WorkerHealthDto[]) : [];
  }

  toneOf(w: WorkerHealthDto): '' | 'warn' | 'bad' {
    return latencyTone(w);
  }

  fmtMs(ms: number): string {
    return formatMs(ms);
  }

  formatInterval(seconds: number): string {
    if (!seconds || seconds <= 0) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
    return `${Math.round(seconds / 86_400)}d`;
  }

  refresh(): void {
    this.resource.refresh();
  }
}

/** Worst schedule-relative latency tone among a category's workers. */
function worstLatencyTone(workers: WorkerHealthDto[]): '' | 'warn' | 'bad' {
  let worst: '' | 'warn' | 'bad' = '';
  for (const w of workers) {
    const t = latencyTone(w);
    if (t === 'bad') return 'bad';
    if (t === 'warn') worst = 'warn';
  }
  return worst;
}
