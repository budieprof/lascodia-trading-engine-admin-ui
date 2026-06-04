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
  topSymbols: string[];
  symbolOverflow: number;
  latestAt: string;
  snoozedCount: number;
}

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
        <!-- KPI strip — always rendered. -->
        <div class="kpi-strip">
          <app-metric-card
            label="Active total"
            [value]="activeCount()"
            format="number"
            [dotColor]="activeCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Critical"
            [value]="severityCount('Critical')"
            format="number"
            [dotColor]="severityCount('Critical') > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="High"
            [value]="severityCount('High')"
            format="number"
            [dotColor]="severityCount('High') > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Medium"
            [value]="severityCount('Medium')"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Symbols"
            [value]="distinctSymbols()"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Types"
            [value]="typeBuckets().length"
            format="number"
            dotColor="#AF52DE"
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
            dotColor="#AF52DE"
          />
        </div>

        @if (allFilteredRows().length === 0) {
          <app-empty-state
            title="Nothing to triage"
            message="No alerts match the active filters. Widen severity, type, or status to see more."
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
                  <span class="muted insight-status">
                    peak {{ peakHour() }} · avg {{ avgHour() | number: '1.1-1' }}/h
                  </span>
                </header>
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

          <!-- By symbol breakdown -->
          <section class="data-table-card">
            <header class="board-head">
              <h3>By symbol</h3>
              <span class="muted">{{ symbolRollups().length }} touched</span>
            </header>
            <div class="table-scroll table-scroll--rollup">
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
                      <td class="mono">{{ r.symbol }}</td>
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
                          —
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
                <div class="table-scroll table-scroll--events">
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
                              <button
                                type="button"
                                class="sym-chip"
                                (click)="filterBySymbol(s); $event.stopPropagation()"
                                [title]="'Filter by ' + s"
                              >
                                {{ s }}
                              </button>
                            }
                            @if (g.symbolOverflow > 0) {
                              <span class="sym-overflow muted">+{{ g.symbolOverflow }}</span>
                            }
                          </span>
                          <span class="incident-time muted">
                            latest
                            @if (g.latestAt) {
                              {{ g.latestAt | relativeTime }}
                            } @else {
                              —
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
                              1h
                            </button>
                            <button
                              type="button"
                              class="btn btn-secondary btn-xs"
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
                              @for (a of g.alerts; track a.id) {
                                <tr [class.snoozed]="isSnoozed(a.id) !== null">
                                  <td class="mono">{{ a.symbol ?? '—' }}</td>
                                  <td class="reason small">{{ a.parsedReason }}</td>
                                  <td class="time" [title]="a.lastTriggeredAt">
                                    @if (a.lastTriggeredAt) {
                                      {{ a.lastTriggeredAt | relativeTime }}
                                    } @else {
                                      —
                                    }
                                  </td>
                                  <td class="num small mono">{{ a.cooldownSeconds }}s</td>
                                  <td class="actions">
                                    @if (isSnoozed(a.id); as until) {
                                      <span class="snooze-tag small muted">
                                        snoozed → {{ until | date: 'HH:mm' }}
                                      </span>
                                    } @else {
                                      <button
                                        class="btn btn-ghost btn-xs"
                                        (click)="snooze(a.id, 15)"
                                      >
                                        15m
                                      </button>
                                      <button
                                        class="btn btn-ghost btn-xs"
                                        (click)="snooze(a.id, 60)"
                                      >
                                        1h
                                      </button>
                                      <button
                                        class="btn btn-secondary btn-xs"
                                        (click)="acknowledge(a)"
                                      >
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
                            </tbody>
                          </table>
                        }
                      </article>
                    }
                  </div>
                </div>
              }
            } @else {
              <div class="table-scroll table-scroll--events">
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
                      @for (a of triageQueue(); track a.id) {
                        <tr [class.snoozed]="isSnoozed(a.id) !== null">
                          <td>
                            <span class="sev-pill" [attr.data-sev]="a.severity">{{
                              a.severity
                            }}</span>
                          </td>
                          <td class="small mono">{{ a.alertType }}</td>
                          <td class="mono">{{ a.symbol ?? '—' }}</td>
                          <td class="reason small">{{ a.parsedReason }}</td>
                          <td class="time" [title]="a.lastTriggeredAt">
                            @if (a.lastTriggeredAt) {
                              {{ a.lastTriggeredAt | relativeTime }}
                            } @else {
                              —
                            }
                          </td>
                          <td class="num small mono">{{ a.cooldownSeconds }}s</td>
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
                              <button class="btn btn-secondary btn-xs" (click)="acknowledge(a)">
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

      .filter-bar {
        display: flex;
        align-items: flex-end;
        gap: var(--space-3);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        position: sticky;
        top: var(--space-2);
        z-index: 5;
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

      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .kpi-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
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
      /* Bound each table — operator pages must not grow unbounded as the
         alert backlog grows; rollup + queue become scroll surfaces with
         sticky headers so they stay below the fold. */
      .table-scroll {
        overflow: auto;
      }
      .table-scroll--rollup {
        max-height: 320px;
      }
      .table-scroll--events {
        max-height: 560px;
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
      .btn-xs {
        padding: 3px 8px;
        font-size: 10.5px;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary {
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
        const s = a.symbol ?? '—';
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
  protected readonly distinctSymbols = computed(
    () => new Set(this.allFilteredRows().map((a) => a.symbol ?? '—')).size,
  );
  protected readonly snoozedCount = computed(() => {
    const now = Date.now();
    const snoozed = this.snoozedUntil();
    return this.allFilteredRows().filter((a) => (snoozed[a.id] ?? 0) > now).length;
  });
  protected readonly newestMinutes = computed(() => {
    const rows = this.allFilteredRows();
    if (rows.length === 0) return 0;
    const latest = rows.reduce((max, r) => {
      const t = r.lastTriggeredAt ?? r.autoResolvedAt ?? '';
      return t > max ? t : max;
    }, '');
    if (!latest) return 0;
    return Math.floor((Date.now() - new Date(latest).getTime()) / 60_000);
  });

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
      const key = a.symbol ?? '—';
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
      if (top && top.symbol !== '—' && top.total / rows.length >= 0.5) {
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
    this.symbolFilter.set(symbol === '—' ? '' : symbol);
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
