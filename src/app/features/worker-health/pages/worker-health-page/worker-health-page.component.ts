import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { WorkersService } from '@core/services/workers.service';
import type { WorkerHealthDto, WorkerHealthStatus } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type StatusFilter = 'all' | WorkerHealthStatus;
type SortMode = 'category' | 'p95' | 'errors' | 'backlog';
type ViewMode = 'cards' | 'table';

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
    FormsModule,
    DecimalPipe,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Worker Health"
        subtitle="Real-time snapshot of every background worker"
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (workers().length > 0) {
        <!-- 10-card KPI strip — fleet status + tail-latency + traffic -->
        <div class="kpis">
          <app-metric-card
            label="Total"
            [value]="workers().length"
            format="number"
            dotColor="#0071E3"
          />
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
            [dotColor]="degradedCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Failed"
            [value]="failedCount()"
            format="number"
            [dotColor]="failedCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card label="Idle" [value]="idleCount()" format="number" dotColor="#8E8E93" />
          <app-metric-card
            label="Stale"
            [value]="staleCount()"
            format="number"
            [dotColor]="staleCount() > 0 ? '#AF52DE' : '#34C759'"
          />
          <app-metric-card
            label="Avg P95 (ms)"
            [value]="fleetStats().avgP95"
            format="number"
            [dotColor]="fleetStats().avgP95 > 1000 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Max P99 (ms)"
            [value]="fleetStats().maxP99"
            format="number"
            [dotColor]="fleetStats().maxP99 > 5000 ? '#FF3B30' : '#34C759'"
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
            [dotColor]="fleetStats().totalBacklog > 100 ? '#FF9500' : '#34C759'"
          />
        </div>

        <!-- Charts row: status donut + workers-by-category -->
        <div class="chart-row">
          <app-chart-card
            title="Status distribution"
            subtitle="Healthy · Degraded · Failed · Idle"
            [options]="statusDonutOptions()"
            height="220px"
          />
          <app-chart-card
            title="Workers by category"
            subtitle="Composition of the {{ workers().length }}-worker fleet"
            [options]="workersByCategoryOptions()"
            height="220px"
          />
          <app-chart-card
            title="P95 cycle by category"
            subtitle="Avg tail latency per category — long bars are slow"
            [options]="cycleByCategoryOptions()"
            height="220px"
          />
        </div>

        <!-- Hot spots: top-N slowest, top-N error workers, top-N backlog -->
        <div class="hotspots-row">
          <section class="hotspot">
            <header class="hotspot-head">
              <h3>Slowest workers</h3>
              <span class="muted">By P95 cycle (ms)</span>
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
                        [class.warn]="w.cycleDurationP95Ms > 1000"
                        [class.bad]="w.cycleDurationP95Ms > 5000"
                      >
                        {{ w.cycleDurationP95Ms | number: '1.0-0' }} ms
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

        <div class="toolbar">
          <input
            type="text"
            class="input search"
            placeholder="Filter by name…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <select
            class="input"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="all">All statuses</option>
            <option value="Healthy">Healthy ({{ healthyCount() }})</option>
            <option value="Degraded">Degraded ({{ degradedCount() }})</option>
            <option value="Failed">Failed ({{ failedCount() }})</option>
            <option value="Idle">Idle ({{ idleCount() }})</option>
          </select>
          <select
            class="input"
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
            [ngModel]="sortBy()"
            (ngModelChange)="sortBy.set($event)"
            title="Sort within each category"
          >
            <option value="category">Sort: status (default)</option>
            <option value="p95">Sort: P95 cycle (slowest first)</option>
            <option value="errors">Sort: errors (most first)</option>
            <option value="backlog">Sort: backlog (largest first)</option>
          </select>
          <div class="view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              [class.active]="viewMode() === 'cards'"
              (click)="viewMode.set('cards')"
            >
              Cards
            </button>
            <button
              type="button"
              [class.active]="viewMode() === 'table'"
              (click)="viewMode.set('table')"
            >
              Dense
            </button>
          </div>
          <div class="expand-controls" role="group" aria-label="Expand categories">
            <button type="button" class="link-btn" (click)="expandProblems()">
              Expand problems
            </button>
            <button type="button" class="link-btn" (click)="expandAll()">Expand all</button>
            <button type="button" class="link-btn" (click)="collapseAll()">Collapse all</button>
          </div>
          <span class="muted">
            {{ filtered().length }} of {{ workers().length }} · {{ expanded().size }} of
            {{ groupedByCategory().length }} expanded
          </span>
        </div>

        @for (group of groupedByCategory(); track group.category) {
          <section class="category-section" [class.collapsed]="!isExpanded(group.category)">
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
              <span class="muted">{{ group.workers.length }} workers</span>
              <span class="agg-pill" title="Average P95 cycle duration in this category">
                avg P95 {{ group.avgP95 | number: '1.0-0' }} ms
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
            </header>

            @if (isExpanded(group.category)) {
              <div [id]="'cat-body-' + group.category">
                @if (viewMode() === 'cards') {
                  <div class="grid-scroll">
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
                            <span class="pill" [attr.data-status]="w.status">{{ w.status }}</span>
                          </header>

                          <dl class="metrics-grid">
                            <div>
                              <dt>Cycle (p50/p95)</dt>
                              <dd class="mono">
                                {{ w.cycleDurationP50Ms | number: '1.0-0' }} /
                                {{ w.cycleDurationP95Ms | number: '1.0-0' }} ms
                              </dd>
                            </div>
                            <div>
                              <dt>Last cycle</dt>
                              <dd class="mono">{{ w.lastCycleDurationMs | number: '1.0-0' }} ms</dd>
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
                                <span [class.warn]="w.isStale">
                                  {{ w.lastSuccessAt | relativeTime }}
                                  @if (w.isStale) {
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
                                <span>{{ w.lastErrorAt | relativeTime }}</span>
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
                        </tr>
                      </thead>
                      <tbody>
                        @for (w of group.workers; track w.name) {
                          <tr>
                            <td>
                              <span class="pill" [attr.data-status]="w.status">{{ w.status }}</span>
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
                                [class.warn]="w.cycleDurationP95Ms > 1000"
                                [class.bad]="w.cycleDurationP95Ms > 5000"
                              >
                                {{ w.cycleDurationP95Ms | number: '1.0-0' }}
                              </span>
                            </td>
                            <td class="num mono">
                              {{ w.lastCycleDurationMs | number: '1.0-0' }}
                            </td>
                            <td class="num mono">
                              <span [class.bad]="w.errorsLastHour > 0">{{ w.errorsLastHour }}</span>
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
                            <td class="mono" [class.warn]="w.isStale">
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
                  </div>
                }
              </div>
            }
          </section>
        }
      } @else {
        <app-empty-state
          title="No worker data"
          description="The engine did not return any workers from /health/workers."
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-4);
      }
      @media (max-width: 1200px) {
        .metrics {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 768px) {
        .metrics {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* 10-card KPI strip */
      .kpis {
        display: grid;
        grid-template-columns: repeat(10, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1500px) {
        .kpis {
          grid-template-columns: repeat(5, 1fr);
        }
      }
      @media (max-width: 900px) {
        .kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* 3-col chart row */
      .chart-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      /* Hot spots — 3 small ranked tables */
      .hotspots-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .hotspots-row {
          grid-template-columns: 1fr;
        }
      }
      .hotspot {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .hotspot-head {
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .hotspot-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      table.mini {
        width: 100%;
        border-collapse: collapse;
      }
      table.mini td {
        padding: 6px var(--space-3);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      table.mini tbody tr:last-child td {
        border-bottom: none;
      }
      table.mini td.name {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      table.mini td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      table.mini td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      table.mini td.bad,
      table.mini td .bad {
        color: var(--loss);
      }
      table.mini td.warn,
      table.mini td .warn {
        color: #c93400;
      }
      table.mini .empty {
        display: block;
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      table.mini .empty.good {
        color: var(--profit);
      }
      .hotspot .empty {
        display: block;
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .hotspot .empty.good {
        color: var(--profit);
      }

      /* View toggle (cards / dense table) */
      .view-toggle {
        display: inline-flex;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        border: 1px solid var(--border);
      }
      .view-toggle button {
        height: 36px;
        padding: 0 var(--space-3);
        background: transparent;
        border: none;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .view-toggle button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }

      /* Group header aggregate pills */
      .agg-pill {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .agg-pill.bad-pill {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .agg-pill.warn-pill {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }

      /* Dense table mode — many workers per screen, bounded so categories
         like ML (83 workers) don't push the rest of the page off-screen. */
      .dense-wrap {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: auto;
        max-height: 540px;
      }
      .dense-wrap thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      table.dense {
        width: 100%;
        border-collapse: collapse;
      }
      table.dense th,
      table.dense td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        white-space: nowrap;
      }
      table.dense thead th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      table.dense th.num,
      table.dense td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      table.dense td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      table.dense td.muted {
        color: var(--text-tertiary);
      }
      table.dense td.name {
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      table.dense tbody tr:hover {
        background: var(--bg-tertiary);
      }
      table.dense .bad {
        color: var(--loss);
      }
      table.dense .warn {
        color: #c93400;
      }
      .category-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        transition: border-color 0.15s ease;
      }
      /* Collapsed state — keep header tight; no body height. */
      .category-section.collapsed {
        gap: 0;
      }
      .category-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        flex-wrap: wrap;
        cursor: pointer;
        user-select: none;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        transition: background 0.12s ease;
      }
      .category-head:hover {
        background: var(--bg-secondary);
      }
      .category-head:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .category-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .category-head .chevron {
        font-size: 12px;
        color: var(--text-tertiary);
        width: 12px;
        display: inline-block;
      }

      /* Expand controls — link-style buttons in the toolbar */
      .expand-controls {
        display: inline-flex;
        gap: var(--space-2);
        align-items: center;
      }
      .link-btn {
        background: transparent;
        border: none;
        padding: 0;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }
      .expand-controls .link-btn + .link-btn::before {
        content: '·';
        margin-right: var(--space-2);
        color: var(--text-tertiary);
      }
      .pill-stale {
        background: rgba(175, 82, 222, 0.12);
        color: #8a2be2;
      }
      .toolbar {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .search {
        flex: 1 1 200px;
        min-width: 200px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      /* Bounded scroll container for the per-category card grid — categories
         like ML (83 workers) would otherwise produce ~21 rows of cards and
         push every other category off-screen. The wrapper holds the cap so
         the inner grid keeps its native auto-fill / minmax behaviour. */
      .grid-scroll {
        max-height: 540px;
        overflow-y: auto;
        padding-right: 4px;
        position: relative;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        transition: border-color 0.15s ease;
      }
      .card[data-status='Healthy'] {
        border-left: 3px solid var(--profit);
      }
      .card[data-status='Degraded'] {
        border-left: 3px solid var(--warning);
      }
      .card[data-status='Failed'] {
        border-left: 3px solid var(--loss);
      }
      .card[data-status='Idle'] {
        border-left: 3px solid var(--text-tertiary);
      }
      .card-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-tertiary);
        flex-shrink: 0;
      }
      .status-dot[data-status='Healthy'] {
        background: var(--profit);
      }
      .status-dot[data-status='Degraded'] {
        background: var(--warning);
      }
      .status-dot[data-status='Failed'] {
        background: var(--loss);
      }
      .title {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .title .muted {
        font-size: 11px;
      }
      .pill {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill[data-status='Healthy'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Degraded'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .metrics-grid > div.span-2 {
        grid-column: 1 / -1;
      }
      .metrics-grid dt {
        font-size: 11px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .metrics-grid dt.bad-label {
        color: var(--loss);
      }
      .metrics-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .metrics-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .metrics-grid dd.bad {
        color: var(--loss);
      }
      .metrics-grid dd.warn {
        color: var(--warning);
      }
      .err-rate {
        opacity: 0.7;
      }
      .card-foot {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 11px;
        border-top: 1px solid var(--border);
        padding-top: var(--space-2);
      }
      .foot-line {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
      }
      .card-foot .err {
        color: var(--loss);
      }
      .card-foot .warn {
        color: var(--warning);
      }
      .card-foot .msg {
        color: var(--text-secondary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        word-break: break-word;
      }
    `,
  ],
})
export class WorkerHealthPageComponent {
  private readonly workersService = inject(WorkersService);

  protected readonly resource = createPolledResource(
    () =>
      this.workersService.list().pipe(
        // /health/workers returns a raw array (no ResponseData envelope) — see WorkersService.
        map((rows) => rows ?? []),
        catchError(() => of([] as WorkerHealthDto[])),
      ),
    { intervalMs: 30_000 },
  );

  readonly workers = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

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
      if (st !== 'all' && w.status !== st) return false;
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
  readonly staleCount = computed(() => this.workers().filter((w) => w.isStale).length);

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
            staleCount: workers.filter((w) => w.isStale).length,
            avgP95,
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
      return { avgP95: 0, maxP99: 0, errorsLastHour: 0, totalBacklog: 0 };
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
      avgP95: Math.round(avgP95),
      maxP99: Math.round(maxP99),
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

  readonly workersByCategoryOptions = computed<EChartsOption>(() => {
    const counts = this.categoryCounts();
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
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
        data: entries.map(([cat]) => cat).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, value]) => ({
              value,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
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
    const rows = Object.entries(groups)
      .map(([cat, g]) => ({ cat, avg: g.count > 0 ? g.sum / g.count : 0 }))
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
        data: rows.map((r) => r.cat).reverse(),
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
          barWidth: 12,
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
