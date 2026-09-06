import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { AlertsService } from '@core/services/alerts.service';
import { NotificationService } from '@core/notifications/notification.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { AlertDto, AlertSeverity } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Operator-facing alert triage console. Same dense layout as the
 * /positions/deltas + /trade-signals/feedback pages — KPI strip on
 * top, insights-grid for histograms / breakdowns / notable patterns,
 * board-pattern tables for the by-symbol rollup and the actionable
 * work queue.
 *
 * Pulls the engine's full `/alert/list` paged feed (engine has thousands
 * of alerts over time, hundreds active at any moment — earlier feature-
 * flag gate that suppressed the fetch was stale dead code). Severity
 * filter defaults to Critical+High to keep the queue actionable; the
 * KPI strip still summarises every severity so operators see Medium /
 * Info counts without scrolling.
 */
interface KvBucket {
  key: string;
  count: number;
  share: number;
  recentAt: string | null;
}

interface SymbolRollup {
  symbol: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  info: number;
  topType: string;
  recentAt: string | null;
}

interface HourBucket {
  label: string;
  count: number;
}

interface AnomalyFlag {
  kind: 'critical-spike' | 'type-dominance' | 'symbol-concentration' | 'storm';
  detail: string;
}

interface ParsedAlert extends AlertDto {
  parsedReason: string;
  age: string;
}

/**
 * One operator-actionable "incident": a bucket of alerts that share a
 * (severity, alertType). The triage queue is overwhelmingly recurring
 * noise (one worker crash → 20 alerts; one MU drift → 30 alerts across
 * symbols). Grouping by `${severity}::${alertType}` collapses the wall
 * into ~10 distinct things to triage, each with bulk snooze/ack.
 */
interface IncidentGroup {
  key: string;
  severity: AlertSeverity;
  alertType: string;
  count: number;
  alerts: ParsedAlert[];
  /** Alerts folded by subject — see IncidentRow. */
  rows: IncidentRow[];
  topSymbols: string[];
  symbolOverflow: number;
  latestAt: string;
  snoozedCount: number;
}

/**
 * One subject inside an incident. The engine creates a fresh alert per
 * firing, so a single crashed worker shows up as four WorkerCrash alerts
 * that differ only by ElapsedSeconds. Rows fold alerts whose symbol and
 * reason (digits stripped) match, keep the newest, and act on all of them.
 */
interface IncidentRow {
  key: string;
  symbol: string | null;
  reason: string;
  alerts: ParsedAlert[];
  count: number;
  latestAt: string | null;
  cooldownSeconds: number;
  snoozedCount: number;
}

const SYSTEM_WIDE = 'system-wide';

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Info: 3,
};

@Component({
  selector: 'app-alert-triage-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Alert Triage"
        subtitle="Work queue for active alerts across the engine. Snooze locally; escalate in the Ops runbook."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      <section class="filter-bar">
        <div class="fb-field">
          <label class="fb-label">Window</label>
          <div class="window-presets">
            @for (p of windowPresets; track p) {
              <button
                type="button"
                class="preset"
                [class.active]="windowHours() === p"
                (click)="windowHours.set(p)"
              >
                {{ p < 24 ? p + 'h' : p / 24 + 'd' }}
              </button>
            }
          </div>
        </div>
        <div class="fb-field">
          <label for="severity" class="fb-label">Severity</label>
          <select
            id="severity"
            class="filter-select"
            [ngModel]="severityFilter()"
            (ngModelChange)="severityFilter.set($event)"
          >
            <option value="">all severities</option>
            <option value="actionable">Critical + High</option>
            <option value="Critical">Critical only</option>
            <option value="High">High only</option>
            <option value="Medium">Medium only</option>
            <option value="Info">Info only</option>
          </select>
        </div>
        <div class="fb-field">
          <label for="alertType" class="fb-label">Type</label>
          <select
            id="alertType"
            class="filter-select"
            [ngModel]="typeFilter()"
            (ngModelChange)="typeFilter.set($event)"
          >
            <option value="">all types</option>
            @for (t of typeOptions(); track t) {
              <option [value]="t">{{ t }}</option>
            }
          </select>
        </div>
        <div class="fb-field">
          <label for="symbol" class="fb-label">Symbol</label>
          <input
            id="symbol"
            class="filter-input"
            type="search"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />
        </div>
        <div class="fb-field">
          <label for="status" class="fb-label">Status</label>
          <select
            id="status"
            class="filter-select"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="actionable">Actionable (active, unsnoozed)</option>
            <option value="active">All active</option>
            <option value="snoozed">Snoozed</option>
            <option value="resolved">Auto-resolved</option>
            <option value="all">All (incl. inactive)</option>
          </select>
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load alerts"
          message="Engine returned an error. The alert-list endpoint may be unhealthy — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- KPI strip — always rendered. Colour only where it means
             something: severity dots light up when the count is above zero
             and are neutral at zero. -->
        <div class="kpi-strip">
          <app-metric-card
            label="Active total"
            [value]="activeCount()"
            format="number"
            [dotColor]="activeCount() > 0 ? '#FF9500' : '#8E8E93'"
          />
          <app-metric-card
            label="Critical"
            [value]="severityCount('Critical')"
            format="number"
            [dotColor]="severityCount('Critical') > 0 ? '#FF3B30' : '#8E8E93'"
          />
          <app-metric-card
            label="High"
            [value]="severityCount('High')"
            format="number"
            [dotColor]="severityCount('High') > 0 ? '#FF9500' : '#8E8E93'"
          />
          <app-metric-card
            label="Medium"
            [value]="severityCount('Medium')"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Symbols"
            [value]="distinctSymbols()"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Types"
            [value]="typeBuckets().length"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Snoozed"
            [value]="snoozedCount()"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Newest (min ago)"
            [value]="newestMinutes()"
            format="number"
            dotColor="#8E8E93"
          />
        </div>

        @if (allFilteredRows().length === 0) {
          <app-empty-state
            title="Nothing to triage"
            description="No alerts match the active filters. Widen severity, type, or status to see more."
          />
        } @else {
          <!-- Insights row -->
          <section class="insights-section">
            <header class="insights-head">
              <h3>Alert insights</h3>
              <span class="muted">
                {{ allFilteredRows().length }} matching alert{{
                  allFilteredRows().length === 1 ? '' : 's'
                }}
                · last {{ windowHours() }}h
              </span>
            </header>
            <div class="insights-grid">
              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">Activity</span>
                  @if (triggerTimesRecorded() > 0) {
                    <span class="muted insight-status">
                      peak {{ peakHour() }} · avg {{ avgHour() | number: '1.1-1' }}/h
                    </span>
                  }
                </header>
                @if (triggerTimesRecorded() === 0) {
                  <!-- Every matching alert has a null lastTriggeredAt, so an
                       hour-by-hour chart would just be an empty box with
                       "peak 0" — say what is actually missing instead. -->
                  <p class="empty-line muted">
                    No trigger times recorded — the engine returned no
                    <code>lastTriggeredAt</code> for any of these alerts, so activity over time
                    cannot be shown.
                  </p>
                } @else {
                  @if (triggerTimesRecorded() < allFilteredRows().length) {
                    <p class="empty-line muted">
                      {{ allFilteredRows().length - triggerTimesRecorded() }} of
                      {{ allFilteredRows().length }} alerts have no trigger time and are not
                      plotted.
                    </p>
                  }
                  <div class="histogram">
                    @for (h of hourBuckets(); track h.label) {
                      <div class="hist-col" [title]="h.label + ': ' + h.count + ' alerts'">
                        <span
                          class="hist-bar"
                          [style.height.%]="hourBarHeight(h.count)"
                          [class.zero]="h.count === 0"
                        ></span>
                      </div>
                    }
                  </div>
                  <footer class="hist-axis">
                    <span>{{ hourBuckets()[0]?.label ?? '' }}</span>
                    <span>now</span>
                  </footer>
                }
              </article>

              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">Notable patterns</span>
                  <span class="muted insight-status">{{ anomalies().length }} flagged</span>
                </header>
                @if (anomalies().length === 0) {
                  <p class="empty-line muted">
                    No critical spikes, type dominance, or storms in window.
                  </p>
                } @else {
                  <ul class="anomaly-list">
                    @for (a of anomalies(); track $index) {
                      <li class="anomaly" [attr.data-kind]="a.kind">
                        <span class="anomaly-tag">{{ anomalyLabel(a.kind) }}</span>
                        <span class="small">{{ a.detail }}</span>
                      </li>
                    }
                  </ul>
                }
              </article>

              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">By severity</span>
                  <span class="muted insight-status">{{ severityBuckets().length }} distinct</span>
                </header>
                <ul class="breakdown">
                  @for (b of severityBuckets(); track b.key) {
                    <li class="bd-row">
                      <span class="sev-pill" [attr.data-sev]="b.key">{{ b.key }}</span>
                      <span class="bd-bar">
                        <span class="bd-fill" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="mono num">{{ b.count }}</span>
                      <span class="muted small">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </li>
                  }
                </ul>
              </article>

              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">By type</span>
                  <span class="muted insight-status">{{ typeBuckets().length }} distinct</span>
                </header>
                <ul class="breakdown">
                  @for (b of typeBuckets(); track b.key) {
                    <li class="bd-row">
                      <span class="small mono">{{ b.key }}</span>
                      <span class="bd-bar">
                        <span class="bd-fill amber" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="mono num">{{ b.count }}</span>
                      <span class="muted small">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </li>
                  }
                </ul>
              </article>
            </div>
          </section>

          <!-- By symbol breakdown. No height cap: the old 320px scroll box
               hid the eleventh row behind an invisible overlay scrollbar, so
               "11 touched" showed ten rows whose totals did not add up. -->
          <section class="data-table-card">
            <header class="board-head">
              <h3>By symbol</h3>
              <span class="muted">
                {{ distinctSymbols() }} symbol{{ distinctSymbols() === 1 ? '' : 's' }}
                @if (hasSystemWideRollup()) {
                  + system-wide
                }
              </span>
            </header>
            <div class="table-scroll">
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="num">Total</th>
                    <th class="num">Critical</th>
                    <th class="num">High</th>
                    <th class="num">Medium</th>
                    <th class="num">Info</th>
                    <th>Top type</th>
                    <th>Latest</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of symbolRollups(); track r.symbol) {
                    <tr
                      [class.row-warn]="r.critical > 0"
                      class="symbol-clickable"
                      (click)="filterBySymbol(r.symbol)"
                      [title]="'Filter queue to ' + r.symbol"
                    >
                      <td class="mono" [class.muted]="r.symbol === systemWide">{{ r.symbol }}</td>
                      <td class="num">{{ r.total }}</td>
                      <td class="num" [class.sev-cell-crit]="r.critical > 0">
                        {{ r.critical }}
                      </td>
                      <td class="num" [class.sev-cell-high]="r.high > 0">{{ r.high }}</td>
                      <td class="num">{{ r.medium }}</td>
                      <td class="num">{{ r.info }}</td>
                      <td class="reason small">{{ r.topType }}</td>
                      <td class="time">
                        @if (r.recentAt) {
                          {{ r.recentAt | relativeTime }}
                        } @else {
                          not recorded
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <!-- Triage queue -->
          <section class="data-table-card">
            <header class="board-head">
              <h3>Triage queue</h3>
              <span class="muted">
                {{ triageQueue().length }} alert{{ triageQueue().length === 1 ? '' : 's' }}
                @if (viewMode() === 'grouped') {
                  · {{ incidentGroups().length }} incident{{
                    incidentGroups().length === 1 ? '' : 's'
                  }}
                }
              </span>
              <div class="queue-tools">
                @if (viewMode() === 'grouped' && incidentGroups().length > 0) {
                  <div class="link-group">
                    <button type="button" class="link-btn" (click)="expandAllGroups()">
                      Expand all
                    </button>
                    <button type="button" class="link-btn" (click)="collapseAllGroups()">
                      Collapse all
                    </button>
                  </div>
                }
                <div class="view-toggle" role="tablist" aria-label="Queue view mode">
                  <button
                    type="button"
                    role="tab"
                    class="vt-btn"
                    [class.active]="viewMode() === 'grouped'"
                    [attr.aria-selected]="viewMode() === 'grouped'"
                    (click)="viewMode.set('grouped')"
                    title="Group by alert type — collapses repeated noise"
                  >
                    Grouped
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class="vt-btn"
                    [class.active]="viewMode() === 'flat'"
                    [attr.aria-selected]="viewMode() === 'flat'"
                    (click)="viewMode.set('flat')"
                    title="One row per alert — for raw inspection"
                  >
                    Flat
                  </button>
                </div>
              </div>
            </header>
            @if (viewMode() === 'grouped') {
              @if (incidentGroups().length === 0) {
                <p class="empty-line muted" style="padding: var(--space-3) var(--space-4)">
                  No actionable alerts under current filters.
                </p>
              } @else {
                <div class="table-scroll">
                  <div class="incident-list">
                    @for (g of incidentGroups(); track g.key) {
                      <article class="incident" [attr.data-sev]="g.severity">
                        <header
                          class="incident-head"
                          (click)="toggleGroup(g.key)"
                          [attr.aria-expanded]="isGroupOpen(g.key)"
                        >
                          <span class="incident-chev" [class.open]="isGroupOpen(g.key)"
                            >&#9654;</span
                          >
                          <span class="sev-pill" [attr.data-sev]="g.severity">{{
                            g.severity
                          }}</span>
                          <span class="incident-type">{{ g.alertType }}</span>
                          <span class="incident-count">×&nbsp;{{ g.count }}</span>
                          @if (g.snoozedCount > 0) {
                            <span class="incident-snoozed-tag" title="Snoozed alerts in this group">
                              {{ g.snoozedCount }} snoozed
                            </span>
                          }
                          <span class="incident-symbols">
                            @for (s of g.topSymbols; track s) {
                              @if (s === systemWide) {
                                <span class="sym-chip sym-chip--static">{{ s }}</span>
                              } @else {
                                <button
                                  type="button"
                                  class="sym-chip"
                                  (click)="filterBySymbol(s); $event.stopPropagation()"
                                  [title]="'Filter by ' + s"
                                >
                                  {{ s }}
                                </button>
                              }
                            }
                            @if (g.symbolOverflow > 0) {
                              <span class="sym-overflow muted">+{{ g.symbolOverflow }}</span>
                            }
                          </span>
                          <span class="incident-time muted">
                            @if (g.latestAt) {
                              latest {{ g.latestAt | relativeTime }}
                            } @else {
                              trigger time not recorded
                            }
                          </span>
                          <div
                            class="incident-actions"
                            (click)="$event.stopPropagation()"
                            role="group"
                            aria-label="Group actions"
                          >
                            <button
                              type="button"
                              class="btn btn-ghost btn-xs"
                              (click)="snoozeGroup(g, 15)"
                              [disabled]="g.snoozedCount === g.count"
                            >
                              Snooze 15m
                            </button>
                            <button
                              type="button"
                              class="btn btn-ghost btn-xs"
                              (click)="snoozeGroup(g, 60)"
                              [disabled]="g.snoozedCount === g.count"
                            >
                              Snooze 1h
                            </button>
                            <button
                              type="button"
                              class="btn btn-accent btn-xs"
                              (click)="ackGroup(g)"
                              [disabled]="g.snoozedCount === g.count"
                            >
                              Ack all
                            </button>
                          </div>
                        </header>
                        @if (isGroupOpen(g.key)) {
                          <table class="board-table inner-table">
                            <thead>
                              <tr>
                                <th>Symbol</th>
                                <th>Reason</th>
                                <th>Triggered</th>
                                <th class="num">Cooldown</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (row of g.rows; track row.key) {
                                <tr [class.snoozed]="row.snoozedCount === row.count">
                                  <td class="mono" [class.muted]="!row.symbol">
                                    {{ row.symbol ?? systemWide }}
                                  </td>
                                  <td class="reason small">
                                    {{ row.reason }}
                                    @if (row.count > 1) {
                                      <span
                                        class="fold-count"
                                        [title]="
                                          row.count +
                                          ' alerts for the same subject, differing only by their timing figures — latest shown'
                                        "
                                        >×{{ row.count }}</span
                                      >
                                    }
                                  </td>
                                  <td class="time" [title]="row.latestAt ?? ''">
                                    @if (row.latestAt) {
                                      {{ row.latestAt | relativeTime }}
                                    } @else {
                                      not recorded
                                    }
                                  </td>
                                  <td class="num small mono">
                                    {{ fmtDuration(row.cooldownSeconds) }}
                                  </td>
                                  <td class="actions">
                                    @if (row.snoozedCount === row.count) {
                                      <span class="snooze-tag small muted">
                                        snoozed → {{ rowSnoozedUntil(row) | date: 'HH:mm' }}
                                      </span>
                                    } @else {
                                      <button
                                        class="btn btn-ghost btn-xs"
                                        (click)="snoozeRow(row, 15)"
                                      >
                                        15m
                                      </button>
                                      <button
                                        class="btn btn-ghost btn-xs"
                                        (click)="snoozeRow(row, 60)"
                                      >
                                        1h
                                      </button>
                                      <button class="btn btn-accent btn-xs" (click)="ackRow(row)">
                                        Ack
                                      </button>
                                    }
                                    @if (row.symbol) {
                                      <a
                                        class="link small"
                                        [routerLink]="['/market-data']"
                                        [queryParams]="{ symbol: row.symbol }"
                                        >chart</a
                                      >
                                    }
                                  </td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        }
                      </article>
                    }
                  </div>
                </div>
              }
            } @else {
              <!-- Flat view is paginated instead of scrolled inside a fixed
                   box: 166 rows in 560px ended on a half-visible row with
                   nothing to say more existed. -->
              <div class="table-scroll">
                <table class="board-table">
                  <thead>
                    <tr>
                      <th>Sev</th>
                      <th>Type</th>
                      <th>Symbol</th>
                      <th>Reason</th>
                      <th>Triggered</th>
                      <th class="num">Cooldown</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @if (triageQueue().length === 0) {
                      <tr class="empty-row">
                        <td colspan="7" class="muted small">
                          No actionable alerts under current filters.
                        </td>
                      </tr>
                    } @else {
                      @for (a of flatPageRows(); track a.id) {
                        <tr [class.snoozed]="isSnoozed(a.id) !== null">
                          <td>
                            <span class="sev-pill" [attr.data-sev]="a.severity">{{
                              a.severity
                            }}</span>
                          </td>
                          <td class="small mono">{{ a.alertType }}</td>
                          <td class="mono" [class.muted]="!a.symbol">
                            {{ a.symbol ?? systemWide }}
                          </td>
                          <td class="reason small">{{ a.parsedReason }}</td>
                          <td class="time" [title]="a.lastTriggeredAt">
                            @if (a.lastTriggeredAt) {
                              {{ a.lastTriggeredAt | relativeTime }}
                            } @else {
                              not recorded
                            }
                          </td>
                          <td class="num small mono">{{ fmtDuration(a.cooldownSeconds) }}</td>
                          <td class="actions">
                            @if (isSnoozed(a.id); as until) {
                              <span class="snooze-tag small muted">
                                snoozed → {{ until | date: 'HH:mm' }}
                              </span>
                            } @else {
                              <button class="btn btn-ghost btn-xs" (click)="snooze(a.id, 15)">
                                15m
                              </button>
                              <button class="btn btn-ghost btn-xs" (click)="snooze(a.id, 60)">
                                1h
                              </button>
                              <button class="btn btn-accent btn-xs" (click)="acknowledge(a)">
                                Ack
                              </button>
                            }
                            @if (a.symbol) {
                              <a
                                class="link small"
                                [routerLink]="['/market-data']"
                                [queryParams]="{ symbol: a.symbol }"
                                >chart</a
                              >
                            }
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
              </div>
              @if (triageQueue().length > flatPageSize) {
                <footer class="pager">
                  <span class="muted small">
                    Showing {{ flatPageStart() | number }}–{{ flatPageEnd() | number }} of
                    {{ triageQueue().length | number }}
                  </span>
                  <div class="pager-controls">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs"
                      [disabled]="flatPage() <= 1"
                      (click)="flatPage.set(flatPage() - 1)"
                    >
                      Previous
                    </button>
                    <span class="small muted">Page {{ flatPage() }} of {{ flatPageCount() }}</span>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs"
                      [disabled]="flatPage() >= flatPageCount()"
                      (click)="flatPage.set(flatPage() + 1)"
                    >
                      Next
                    </button>
                  </div>
                </footer>
              }
            }
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

      /* Not sticky. Pinned at top:8px it slid over the KPI tiles the moment
         the page scrolled, hiding their values; no other filter bar in the
         app is sticky either. */
      .filter-bar {
        display: flex;
        align-items: flex-end;
        gap: var(--space-3);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .fb-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .fb-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .filter-input,
      .filter-select {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 160px;
      }
      .window-presets {
        display: flex;
        height: 32px;
      }
      .preset {
        padding: 0 12px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        cursor: pointer;
        font-variant-numeric: tabular-nums;
      }
      .preset:hover {
        background: var(--bg-tertiary);
      }
      .preset.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      .preset:first-child {
        border-radius: var(--radius-sm) 0 0 var(--radius-sm);
      }
      .preset:last-child {
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      }
      .preset + .preset {
        border-left: none;
      }

      /* Eight tiles as two rows of four — eight across wrapped "Newest (min
         ago)" onto two lines and made the tiles narrower than any other
         page's. */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-2);
        align-items: start;
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      .insights-section {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .insights-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .insights-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .insights-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .insights-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 1px;
        background: var(--border);
      }
      @media (max-width: 1100px) {
        .insights-grid {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 720px) {
        .insights-grid {
          grid-template-columns: 1fr;
        }
      }
      .insight-card {
        background: var(--bg-secondary);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-height: 160px;
      }
      .insight-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-2);
      }
      .insight-title {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .insight-status {
        font-size: 10.5px;
      }
      .empty-line {
        margin: 0;
        font-size: var(--text-xs);
      }

      .histogram {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(4px, 1fr));
        gap: 1px;
        height: 60px;
        align-items: end;
        flex: 1;
      }
      .hist-col {
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
      }
      .hist-bar {
        display: block;
        background: linear-gradient(180deg, #ff9500 0%, #c93400 100%);
        border-radius: 1px 1px 0 0;
        min-height: 1px;
        width: 100%;
      }
      .hist-bar.zero {
        background: var(--border);
        min-height: 1px;
      }
      .hist-axis {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
      }

      .anomaly-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .anomaly {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 4px 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .anomaly[data-kind='critical-spike'] {
        background: rgba(239, 68, 68, 0.08);
      }
      .anomaly[data-kind='storm'] {
        background: rgba(239, 68, 68, 0.08);
      }
      .anomaly[data-kind='type-dominance'] {
        background: rgba(255, 149, 0, 0.08);
      }
      .anomaly[data-kind='symbol-concentration'] {
        background: rgba(59, 130, 246, 0.08);
      }
      .anomaly-tag {
        font-size: 9px;
        font-weight: var(--font-bold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--bg-secondary);
        color: var(--text-secondary);
        white-space: nowrap;
      }

      .breakdown {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .bd-row {
        display: grid;
        grid-template-columns: 1fr 60px 32px 32px;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .bd-bar {
        display: inline-block;
        height: 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .bd-fill {
        display: block;
        height: 100%;
        background: #ef4444;
      }
      .bd-fill.amber {
        background: #ff9500;
      }
      .bd-row .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      .data-table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .board-table th,
      .board-table td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        vertical-align: middle;
      }
      .board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .board-table td.num,
      .board-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      /* Horizontal overflow only. Vertical growth is bounded by pagination
         (flat view) and by grouping (incident view), not by a scroll box that
         hid rows behind an invisible overlay scrollbar. */
      .table-scroll {
        overflow-x: auto;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        border-top: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .pager-controls {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }
      .fold-count {
        display: inline-block;
        margin-left: 4px;
        padding: 0 6px;
        border-radius: var(--radius-full);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: 10px;
        font-weight: var(--font-bold);
        font-variant-numeric: tabular-nums;
        cursor: help;
      }
      .board-table td.muted {
        color: var(--text-tertiary);
      }
      code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.95em;
      }
      .row-warn {
        background: rgba(239, 68, 68, 0.05);
      }
      .snoozed {
        opacity: 0.55;
      }
      .sev-cell-crit {
        color: rgb(220, 38, 38);
        font-weight: var(--font-semibold);
      }
      .sev-cell-high {
        color: rgb(217, 119, 6);
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-secondary);
      }
      .reason {
        color: var(--text-secondary);
        max-width: 420px;
        word-break: break-word;
      }
      .link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-semibold);
      }
      .link:hover {
        text-decoration: underline;
      }
      .time {
        color: var(--text-tertiary);
        font-size: 11px;
        white-space: nowrap;
      }
      .empty-row td {
        text-align: center;
        padding: var(--space-3) !important;
      }

      .sev-pill {
        font-size: 10px;
        font-weight: var(--font-bold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sev-pill[data-sev='Critical'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .sev-pill[data-sev='High'] {
        background: rgba(255, 149, 0, 0.15);
        color: rgb(217, 119, 6);
      }
      .sev-pill[data-sev='Medium'] {
        background: rgba(59, 130, 246, 0.15);
        color: rgb(37, 99, 235);
      }
      .sev-pill[data-sev='Info'] {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      .actions {
        display: flex;
        gap: 4px;
        align-items: center;
        white-space: nowrap;
      }
      .btn {
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-xs {
        padding: 3px 8px;
        font-size: 10.5px;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      /* Page-level action (Refresh): the same outline secondary button every
         page uses. The solid accent style is reserved for Ack. */
      .btn-secondary {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        background: transparent;
        color: var(--text-primary);
        border-color: var(--border);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-accent {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      .snooze-tag {
        white-space: nowrap;
      }

      /* ── Queue header tools (view toggle, expand/collapse) ─────── */
      .queue-tools {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: var(--space-3);
      }
      .link-group {
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
        font-family: inherit;
      }
      .link-btn:hover {
        text-decoration: underline;
      }
      .link-group .link-btn + .link-btn::before {
        content: '·';
        margin-right: var(--space-2);
        color: var(--text-tertiary);
      }
      .view-toggle {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .vt-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 3px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
        transition:
          background 0.12s ease,
          color 0.12s ease;
      }
      .vt-btn:hover {
        color: var(--text-primary);
      }
      .vt-btn.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: 0 0 0 1px var(--border);
      }

      /* ── Incident cards (grouped queue) ────────────────────────── */
      .incident-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: var(--border);
      }
      .incident {
        background: var(--bg-secondary);
      }
      .incident-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 8px var(--space-4);
        cursor: pointer;
        user-select: none;
        flex-wrap: wrap;
        border-left: 3px solid transparent;
        transition: background 0.1s ease;
      }
      .incident-head:hover {
        background: var(--bg-tertiary);
      }
      .incident[data-sev='Critical'] .incident-head {
        border-left-color: rgb(220, 38, 38);
      }
      .incident[data-sev='High'] .incident-head {
        border-left-color: rgb(217, 119, 6);
      }
      .incident[data-sev='Medium'] .incident-head {
        border-left-color: rgb(37, 99, 235);
      }
      .incident[data-sev='Info'] .incident-head {
        border-left-color: var(--border);
      }
      .incident-chev {
        font-size: 9px;
        color: var(--text-tertiary);
        transition: transform 0.15s ease;
        flex-shrink: 0;
      }
      .incident-chev.open {
        transform: rotate(90deg);
      }
      .incident-type {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .incident-count {
        font-size: 11px;
        font-weight: var(--font-bold);
        color: var(--text-primary);
        background: var(--bg-tertiary);
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-variant-numeric: tabular-nums;
      }
      .incident-snoozed-tag {
        font-size: 10px;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-style: italic;
      }
      .incident-symbols {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
        max-width: 360px;
      }
      .sym-chip {
        appearance: none;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition:
          background 0.1s ease,
          color 0.1s ease;
      }
      .sym-chip:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .sym-chip--static {
        cursor: default;
        color: var(--text-tertiary);
        font-style: italic;
      }
      .sym-chip--static:hover {
        background: var(--bg-primary);
        color: var(--text-tertiary);
      }
      .sym-overflow {
        font-size: 10.5px;
      }
      .incident-time {
        margin-left: auto;
        font-size: 11px;
        white-space: nowrap;
      }
      .incident-actions {
        display: inline-flex;
        gap: 4px;
        align-items: center;
        flex-shrink: 0;
      }
      .inner-table {
        background: var(--bg-tertiary);
        border-top: 1px solid var(--border);
      }
      .inner-table th {
        background: var(--bg-secondary);
      }

      /* ── Make By-symbol rollup rows clickable as a quick filter ─ */
      .symbol-clickable {
        cursor: pointer;
      }
      .symbol-clickable:hover {
        background: var(--bg-tertiary);
      }
    `,
  ],
})
export class AlertTriagePageComponent {
  private readonly service = inject(AlertsService);
  private readonly notify = inject(NotificationService);

  protected readonly windowPresets = [1, 6, 24, 72, 168];
  protected readonly windowHours = signal(168); // 7d default — alerts decay slow
  protected readonly severityFilter = signal<string>('actionable');
  protected readonly typeFilter = signal<string>('');
  protected readonly symbolFilter = signal<string>('');
  protected readonly statusFilter = signal<string>('actionable');

  /**
   * Queue display mode. `grouped` (default) bucket alerts by
   * `severity × alertType` so 25 `WorkerFault` rows collapse to one
   * incident card with bulk Snooze / Ack. `flat` shows every alert on
   * its own row for raw inspection.
   */
  protected readonly viewMode = signal<'grouped' | 'flat'>('grouped');
  /** Set of incident keys the operator has expanded. */
  protected readonly openGroups = signal<Set<string>>(new Set());

  protected readonly systemWide = SYSTEM_WIDE;

  // Flat-view pagination (client-side over the sorted queue).
  protected readonly flatPageSize = 50;
  protected readonly flatPage = signal(1);

  // Snooze map kept in sessionStorage so an operator's triage state survives
  // tab refreshes within a session but doesn't leak across days.
  protected readonly snoozedUntil = signal<Record<number, number>>(this.readSnoozes());

  // Refresh once a minute by default — alerts churn slower than positions or
  // signals; faster cadence would be wasted round-trips.
  protected readonly resource = createPolledResource(
    () =>
      this.service
        .list({
          currentPage: 1,
          itemCountPerPage: 500,
          // We want both active AND auto-resolved within the window so the
          // "Auto-resolved" status option works and the activity histogram
          // shows a meaningful curve, not just the current snapshot.
          filter: {},
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<AlertDto[]>([])),
        ),
    { intervalMs: 60_000 },
  );

  constructor() {
    effect(() => {
      this.windowHours();
      this.resource.refresh();
    });
    // Any filter change restarts the flat view on page 1 — otherwise a
    // narrower result set can leave the operator on a page past the end.
    effect(() => {
      this.severityFilter();
      this.typeFilter();
      this.symbolFilter();
      this.statusFilter();
      this.windowHours();
      this.flatPage.set(1);
    });
  }

  // ── Base + filtered rows ────────────────────────────────────────────

  /**
   * Alerts within the active window. Window applies to lastTriggeredAt OR
   * (for never-triggered alerts) autoResolvedAt — and falls back to "include
   * regardless" when both are null so seed alerts don't vanish silently.
   */
  protected readonly windowRows = computed(() => {
    const cutoffMs = Date.now() - this.windowHours() * 60 * 60 * 1000;
    return (
      this.resource.value()?.filter((a) => {
        const t = a.lastTriggeredAt ?? a.autoResolvedAt;
        if (!t) return true;
        return new Date(t).getTime() >= cutoffMs;
      }) ?? []
    );
  });

  /** All filters applied except status — used by the breakdown panels. */
  protected readonly allFilteredRows = computed(() => {
    const sev = this.severityFilter();
    const type = this.typeFilter().toLowerCase();
    const sym = this.symbolFilter().trim().toUpperCase();
    return this.windowRows().filter((a) => {
      if (sev === 'actionable') {
        if (a.severity !== 'Critical' && a.severity !== 'High') return false;
      } else if (sev && a.severity !== sev) return false;
      if (type && !a.alertType.toLowerCase().includes(type)) return false;
      if (sym && !(a.symbol ?? '').toUpperCase().includes(sym)) return false;
      return true;
    });
  });

  /** Status applied — drives the actionable queue. */
  protected readonly statusFilteredRows = computed<ParsedAlert[]>(() => {
    const status = this.statusFilter();
    const now = Date.now();
    const snoozed = this.snoozedUntil();
    return this.allFilteredRows()
      .filter((a) => {
        const isSnoozedNow = (snoozed[a.id] ?? 0) > now;
        switch (status) {
          case 'actionable':
            return a.isActive && !isSnoozedNow;
          case 'active':
            return a.isActive;
          case 'snoozed':
            return isSnoozedNow;
          case 'resolved':
            return !!a.autoResolvedAt;
          case 'all':
            return true;
          default:
            return a.isActive && !isSnoozedNow;
        }
      })
      .map((a) => ({
        ...a,
        parsedReason: this.parseReason(a),
        age: a.lastTriggeredAt ?? a.autoResolvedAt ?? '',
      }));
  });

  protected readonly triageQueue = computed<ParsedAlert[]>(() =>
    [...this.statusFilteredRows()].sort((a, b) => {
      const sevA = SEVERITY_ORDER[a.severity];
      const sevB = SEVERITY_ORDER[b.severity];
      if (sevA !== sevB) return sevA - sevB;
      const tA = (a.lastTriggeredAt ?? '').localeCompare(b.lastTriggeredAt ?? '');
      return -tA;
    }),
  );

  protected readonly flatPageCount = computed(() =>
    Math.max(1, Math.ceil(this.triageQueue().length / this.flatPageSize)),
  );
  protected readonly flatPageRows = computed<ParsedAlert[]>(() => {
    const page = Math.min(this.flatPage(), this.flatPageCount());
    const start = (page - 1) * this.flatPageSize;
    return this.triageQueue().slice(start, start + this.flatPageSize);
  });
  protected readonly flatPageStart = computed(() =>
    this.triageQueue().length === 0 ? 0 : (this.flatPage() - 1) * this.flatPageSize + 1,
  );
  protected readonly flatPageEnd = computed(() =>
    Math.min(this.flatPage() * this.flatPageSize, this.triageQueue().length),
  );

  /**
   * Triage queue bucketed by `severity × alertType`. Drives the grouped
   * view. Sort: severity first, then count desc, then most-recent
   * trigger — so the loudest fresh problems sit at the top.
   */
  protected readonly incidentGroups = computed<IncidentGroup[]>(() => {
    const buckets = new Map<string, ParsedAlert[]>();
    for (const a of this.triageQueue()) {
      const key = `${a.severity}::${a.alertType}`;
      const list = buckets.get(key) ?? [];
      list.push(a);
      buckets.set(key, list);
    }
    const now = Date.now();
    const snoozed = this.snoozedUntil();
    const out: IncidentGroup[] = [];
    for (const [key, alerts] of buckets.entries()) {
      const [severity, alertType] = key.split('::') as [AlertSeverity, string];
      const symbols: string[] = [];
      let latestAt = '';
      let snoozedCount = 0;
      for (const a of alerts) {
        const s = a.symbol ?? SYSTEM_WIDE;
        if (!symbols.includes(s)) symbols.push(s);
        const t = a.lastTriggeredAt ?? '';
        if (t > latestAt) latestAt = t;
        if ((snoozed[a.id] ?? 0) > now) snoozedCount++;
      }
      out.push({
        key,
        severity,
        alertType,
        count: alerts.length,
        alerts,
        rows: this.foldRows(alerts, snoozed, now),
        topSymbols: symbols.slice(0, 5),
        symbolOverflow: Math.max(0, symbols.length - 5),
        latestAt,
        snoozedCount,
      });
    }
    return out.sort((a, b) => {
      const sevA = SEVERITY_ORDER[a.severity];
      const sevB = SEVERITY_ORDER[b.severity];
      if (sevA !== sevB) return sevA - sevB;
      if (a.count !== b.count) return b.count - a.count;
      return (b.latestAt ?? '').localeCompare(a.latestAt ?? '');
    });
  });

  /**
   * Fold a group's alerts into subject rows. Identity is symbol + reason with
   * measured quantities (a number carrying a unit: "11038.3s", "42%", "3 skips")
   * blanked, so "StrategyPromotionWorker (11038.3s stale)" and "(11045.2s stale)"
   * are one row while "model #12" and "model #13" stay apart. The newest alert
   * is the face of the row; the row's actions apply to every alert behind it.
   */
  private foldRows(
    alerts: ParsedAlert[],
    snoozed: Record<number, number>,
    now: number,
  ): IncidentRow[] {
    const map = new Map<string, IncidentRow>();
    for (const a of alerts) {
      const subject = a.parsedReason.replace(/\d+(\.\d+)?\s*(ms|s|m|h|%|skips?)\b/g, '#');
      const key = `${a.symbol ?? ''}::${subject}`;
      const existing = map.get(key);
      const t = a.lastTriggeredAt ?? null;
      const isSnoozed = (snoozed[a.id] ?? 0) > now;
      if (existing) {
        existing.alerts.push(a);
        existing.count++;
        if (isSnoozed) existing.snoozedCount++;
        if (t && (!existing.latestAt || t > existing.latestAt)) {
          existing.latestAt = t;
          existing.reason = a.parsedReason;
          existing.cooldownSeconds = a.cooldownSeconds;
        }
      } else {
        map.set(key, {
          key,
          symbol: a.symbol,
          reason: a.parsedReason,
          alerts: [a],
          count: 1,
          latestAt: t,
          cooldownSeconds: a.cooldownSeconds,
          snoozedCount: isSnoozed ? 1 : 0,
        });
      }
    }
    return Array.from(map.values()).sort((x, y) =>
      (y.latestAt ?? '').localeCompare(x.latestAt ?? ''),
    );
  }

  protected readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? []).length === 0,
  );

  // ── KPI metrics ────────────────────────────────────────────────────

  protected readonly activeCount = computed(
    () => this.allFilteredRows().filter((a) => a.isActive).length,
  );
  protected severityCount(sev: AlertSeverity): number {
    return this.allFilteredRows().filter((a) => a.severity === sev).length;
  }
  /** Real instruments only — system-wide (null-symbol) alerts are not a symbol. */
  protected readonly distinctSymbols = computed(
    () =>
      new Set(
        this.allFilteredRows()
          .map((a) => a.symbol)
          .filter((s): s is string => !!s),
      ).size,
  );
  protected readonly hasSystemWideRollup = computed(() =>
    this.allFilteredRows().some((a) => !a.symbol),
  );
  protected readonly snoozedCount = computed(() => {
    const now = Date.now();
    const snoozed = this.snoozedUntil();
    return this.allFilteredRows().filter((a) => (snoozed[a.id] ?? 0) > now).length;
  });
  /** Matching alerts that carry a lastTriggeredAt at all. */
  protected readonly triggerTimesRecorded = computed(
    () => this.allFilteredRows().filter((a) => !!a.lastTriggeredAt).length,
  );
  /** Minutes since the newest trigger, or null when no alert has a trigger time (shows "-"). */
  protected readonly newestMinutes = computed<number | null>(() => {
    const rows = this.allFilteredRows();
    if (rows.length === 0) return null;
    const latest = rows.reduce((max, r) => {
      const t = r.lastTriggeredAt ?? r.autoResolvedAt ?? '';
      return t > max ? t : max;
    }, '');
    if (!latest) return null;
    return Math.floor((Date.now() - new Date(latest).getTime()) / 60_000);
  });

  /** "90s" / "5m" / "6h" / "24h" / "2d" — cooldowns read as durations, not raw seconds. */
  protected fmtDuration(seconds: number | null | undefined): string {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86_400) {
      const h = Math.floor(s / 3600);
      const m = Math.round((s % 3600) / 60);
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    const d = Math.floor(s / 86_400);
    const h = Math.round((s % 86_400) / 3600);
    return h === 0 ? `${d}d` : `${d}d ${h}h`;
  }

  // ── Breakdowns ────────────────────────────────────────────────────

  protected readonly severityBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.allFilteredRows(), (a) => a.severity).sort(
      (a, b) =>
        (SEVERITY_ORDER[a.key as AlertSeverity] ?? 4) -
        (SEVERITY_ORDER[b.key as AlertSeverity] ?? 4),
    ),
  );

  protected readonly typeBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.allFilteredRows(), (a) => a.alertType).slice(0, 8),
  );

  protected readonly typeOptions = computed<string[]>(() =>
    Array.from(new Set((this.resource.value() ?? []).map((a) => a.alertType))).sort(),
  );

  protected readonly symbolRollups = computed<SymbolRollup[]>(() => {
    const rows = this.allFilteredRows();
    const map = new Map<string, AlertDto[]>();
    for (const a of rows) {
      const key = a.symbol ?? SYSTEM_WIDE;
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    const out: SymbolRollup[] = [];
    for (const [symbol, alerts] of map.entries()) {
      const typeCounts = new Map<string, number>();
      let recent = '';
      for (const a of alerts) {
        typeCounts.set(a.alertType, (typeCounts.get(a.alertType) ?? 0) + 1);
        const t = a.lastTriggeredAt ?? a.autoResolvedAt ?? '';
        if (t > recent) recent = t;
      }
      const topType = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      out.push({
        symbol,
        total: alerts.length,
        critical: alerts.filter((a) => a.severity === 'Critical').length,
        high: alerts.filter((a) => a.severity === 'High').length,
        medium: alerts.filter((a) => a.severity === 'Medium').length,
        info: alerts.filter((a) => a.severity === 'Info').length,
        topType,
        recentAt: recent || null,
      });
    }
    return out.sort((a, b) => b.critical - a.critical || b.total - a.total);
  });

  // ── Hourly histogram ────────────────────────────────────────────────

  protected readonly hourBuckets = computed<HourBucket[]>(() => {
    const hours = Math.max(1, Math.min(168, this.windowHours()));
    const nowMs = Date.now();
    const buckets: HourBucket[] = [];
    for (let i = hours - 1; i >= 0; i--) {
      const start = nowMs - (i + 1) * 60 * 60 * 1000;
      const label = new Date(start).toISOString().slice(11, 16);
      buckets.push({ label, count: 0 });
    }
    for (const r of this.allFilteredRows()) {
      const t = r.lastTriggeredAt ?? r.autoResolvedAt;
      if (!t) continue;
      const ageH = Math.floor((nowMs - new Date(t).getTime()) / (60 * 60 * 1000));
      const idx = hours - 1 - ageH;
      if (idx >= 0 && idx < buckets.length) buckets[idx].count++;
    }
    return buckets;
  });

  protected readonly peakHour = computed(() =>
    this.hourBuckets().reduce((m, b) => Math.max(m, b.count), 0),
  );
  protected readonly avgHour = computed(() => {
    const b = this.hourBuckets();
    return b.length === 0 ? 0 : b.reduce((s, x) => s + x.count, 0) / b.length;
  });

  protected hourBarHeight(count: number): number {
    const peak = this.peakHour();
    if (peak === 0) return 0;
    return Math.max(4, (count / peak) * 100);
  }

  // ── Anomaly detection ────────────────────────────────────────────────

  protected readonly anomalies = computed<AnomalyFlag[]>(() => {
    const flags: AnomalyFlag[] = [];
    const rows = this.allFilteredRows();
    if (rows.length === 0) return flags;

    // 1. Critical spike — > 10 active criticals
    const crit = rows.filter((a) => a.isActive && a.severity === 'Critical').length;
    if (crit >= 10) {
      flags.push({
        kind: 'critical-spike',
        detail: `${crit} active Critical alerts — investigate before they cascade.`,
      });
    }

    // 2. Alert storm — burst hour > 3× average
    const buckets = this.hourBuckets();
    const avg = this.avgHour();
    if (avg > 0) {
      const burst = buckets.reduce((m, b) => (b.count > m.count ? b : m), buckets[0]);
      if (burst.count >= 10 && burst.count > avg * 3) {
        flags.push({
          kind: 'storm',
          detail: `${burst.count} alerts in one hour around ${burst.label}Z (~${(burst.count / avg).toFixed(1)}× window avg).`,
        });
      }
    }

    // 3. Type dominance — single type ≥ 60% of alerts (only meaningful at scale)
    if (rows.length >= 10) {
      const top = this.typeBuckets()[0];
      if (top && top.share >= 0.6) {
        flags.push({
          kind: 'type-dominance',
          detail: `${top.key} accounts for ${top.count} of ${rows.length} alerts (${(top.share * 100).toFixed(0)}%).`,
        });
      }
    }

    // 4. Symbol concentration — single symbol ≥ 50% of alerts (lower bar than
    //    type-dominance because per-symbol issues are usually upstream and
    //    operator-actionable in isolation).
    if (rows.length >= 10) {
      const rollups = this.symbolRollups();
      const top = rollups[0];
      if (top && top.symbol !== SYSTEM_WIDE && top.total / rows.length >= 0.5) {
        flags.push({
          kind: 'symbol-concentration',
          detail: `${top.symbol} accounts for ${top.total} of ${rows.length} alerts (${((top.total / rows.length) * 100).toFixed(0)}%).`,
        });
      }
    }

    return flags;
  });

  anomalyLabel(kind: AnomalyFlag['kind']): string {
    switch (kind) {
      case 'critical-spike':
        return 'CRIT';
      case 'storm':
        return 'STORM';
      case 'type-dominance':
        return 'TYPE';
      case 'symbol-concentration':
        return 'SYMBOL';
    }
  }

  // ── Snooze / acknowledge ────────────────────────────────────────────

  isSnoozed(id: number): number | null {
    const until = this.snoozedUntil()[id];
    if (!until) return null;
    return until > Date.now() ? until : null;
  }

  snooze(id: number, minutes: number): void {
    const until = Date.now() + minutes * 60 * 1000;
    const next = { ...this.snoozedUntil(), [id]: until };
    this.snoozedUntil.set(next);
    this.writeSnoozes(next);
    this.notify.success(`Snoozed for ${minutes} min`);
  }

  acknowledge(alert: AlertDto): void {
    // The Alert entity doesn't have an explicit `AcknowledgedAt` column yet,
    // so "acknowledge" is implemented as a 24h local snooze. When the engine
    // ships server-side ack (a column + a PUT endpoint), this becomes a
    // proper call and the local snooze becomes a redundant safety net.
    this.snooze(alert.id, 60 * 24);
    this.notify.info('Acknowledged locally (snoozed 24h). Engine-side ack pending.');
  }

  // ── Group-level actions (grouped view) ──────────────────────────────

  private bulkSnooze(alerts: ParsedAlert[], minutes: number): void {
    const until = Date.now() + minutes * 60 * 1000;
    const next = { ...this.snoozedUntil() };
    for (const a of alerts) next[a.id] = until;
    this.snoozedUntil.set(next);
    this.writeSnoozes(next);
  }

  snoozeGroup(g: IncidentGroup, minutes: number): void {
    this.bulkSnooze(g.alerts, minutes);
    this.notify.success(`Snoozed ${g.count} ${g.alertType} alerts for ${minutes} min`);
  }

  ackGroup(g: IncidentGroup): void {
    this.bulkSnooze(g.alerts, 60 * 24);
    this.notify.info(`Acknowledged ${g.count} ${g.alertType} alerts (snoozed 24h)`);
  }

  /** Row-level actions cover every alert folded into the row, not just the newest. */
  snoozeRow(row: IncidentRow, minutes: number): void {
    this.bulkSnooze(row.alerts, minutes);
    this.notify.success(
      row.count === 1
        ? `Snoozed for ${minutes} min`
        : `Snoozed ${row.count} alerts for ${minutes} min`,
    );
  }

  ackRow(row: IncidentRow): void {
    this.bulkSnooze(row.alerts, 60 * 24);
    this.notify.info(
      row.count === 1
        ? 'Acknowledged locally (snoozed 24h). Engine-side ack pending.'
        : `Acknowledged ${row.count} alerts (snoozed 24h). Engine-side ack pending.`,
    );
  }

  /** Latest snooze expiry across a row's alerts, for the "snoozed → HH:mm" tag. */
  rowSnoozedUntil(row: IncidentRow): number {
    const map = this.snoozedUntil();
    return row.alerts.reduce((max, a) => Math.max(max, map[a.id] ?? 0), 0);
  }

  toggleGroup(key: string): void {
    const next = new Set(this.openGroups());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.openGroups.set(next);
  }

  isGroupOpen(key: string): boolean {
    return this.openGroups().has(key);
  }

  expandAllGroups(): void {
    this.openGroups.set(new Set(this.incidentGroups().map((g) => g.key)));
  }

  collapseAllGroups(): void {
    this.openGroups.set(new Set());
  }

  /**
   * Quick filter: clicking a symbol chip (in incident headers or the
   * By-symbol rollup) drops the symbol into the page's symbol filter so
   * the queue narrows to just that pair.
   */
  filterBySymbol(symbol: string): void {
    this.symbolFilter.set(symbol === SYSTEM_WIDE ? '' : symbol);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private bucketize<T>(rows: T[], getKey: (r: T) => string): KvBucket[] {
    const total = rows.length;
    const recentByRow = (r: T) =>
      (r as unknown as { lastTriggeredAt?: string; autoResolvedAt?: string }).lastTriggeredAt ??
      (r as unknown as { autoResolvedAt?: string }).autoResolvedAt ??
      null;
    const map = new Map<string, { count: number; recentAt: string | null }>();
    for (const r of rows) {
      const k = getKey(r);
      const recent = recentByRow(r);
      const existing = map.get(k);
      if (existing) {
        existing.count++;
        if (recent && (!existing.recentAt || recent > existing.recentAt)) {
          existing.recentAt = recent;
        }
      } else {
        map.set(k, { count: 1, recentAt: recent });
      }
    }
    return Array.from(map.entries())
      .map(([key, v]) => ({
        key,
        count: v.count,
        share: total > 0 ? v.count / total : 0,
        recentAt: v.recentAt,
      }))
      .sort((a, b) => b.count - a.count);
  }

  // Extract a one-line operator-readable summary from the JSON condition.
  // Most alert types pack the actionable bits into a small object; we
  // surface the 2-3 most-useful keys and fall back to the raw JSON if the
  // shape is unfamiliar.
  private parseReason(a: AlertDto): string {
    try {
      const c = JSON.parse(a.conditionJson) as Record<string, unknown>;
      if (typeof c['reason'] === 'string') {
        const parts: string[] = [c['reason'] as string];
        if (typeof c['modelId'] === 'number') parts.push(`model #${c['modelId']}`);
        if (typeof c['timeframe'] === 'string') parts.push(c['timeframe'] as string);
        if (typeof c['consecutiveSkips'] === 'number') parts.push(`${c['consecutiveSkips']} skips`);
        return parts.join(' · ');
      }
      if (typeof c['WorkerName'] === 'string') {
        const elapsed = c['ElapsedSeconds'];
        const elapsedStr = typeof elapsed === 'number' ? ` (${elapsed}s stale)` : '';
        return `${c['WorkerName']}${elapsedStr}`;
      }
      if (typeof c['Source'] === 'string') return c['Source'] as string;
      // Truncate raw JSON for unknown shapes so the table doesn't sprawl.
      return a.conditionJson.length > 80 ? a.conditionJson.slice(0, 80) + '…' : a.conditionJson;
    } catch {
      return '(unparseable)';
    }
  }

  private readSnoozes(): Record<number, number> {
    try {
      const raw = sessionStorage.getItem('lascodia.alert-snoozes');
      return raw ? (JSON.parse(raw) as Record<number, number>) : {};
    } catch {
      return {};
    }
  }

  private writeSnoozes(map: Record<number, number>): void {
    try {
      sessionStorage.setItem('lascodia.alert-snoozes', JSON.stringify(map));
    } catch {
      /* best-effort */
    }
  }
}
