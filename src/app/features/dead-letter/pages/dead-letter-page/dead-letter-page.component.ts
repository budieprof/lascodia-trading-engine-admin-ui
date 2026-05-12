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
import { catchError, map, of } from 'rxjs';

import { DeadLetterService } from '@core/services/dead-letter.service';
import { NotificationService } from '@core/notifications/notification.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { DeadLetterDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Operator-facing dead-letter triage console — same dense layout as
 * /alert-triage, /positions/deltas, and /trade-signals/feedback.
 *
 * The page structure stays visible at zero count (page-empty is the
 * baseline state, not an exception) so the operator can see "queue
 * is quiet" with confidence rather than wondering if the view
 * actually fetched.
 *
 * Engine: POST /dead-letter/list (filter: handlerName, eventType,
 * isResolved, from, to). Replay + resolve actions are inline per row.
 */
interface KvBucket {
  key: string;
  count: number;
  share: number;
  recentAt: string | null;
}

interface TypeRollup {
  eventType: string;
  total: number;
  unresolved: number;
  maxAttempts: number;
  oldest: string | null;
  newest: string | null;
}

interface HourBucket {
  label: string;
  count: number;
}

interface AnomalyFlag {
  kind: 'retry-storm' | 'type-dominance' | 'unresolved-stale' | 'high-attempts';
  detail: string;
}

interface ParsedRow extends DeadLetterDto {
  parsedError: string;
}

@Component({
  selector: 'app-dead-letter-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Dead Letter Queue"
        subtitle="Integration events the engine could not process — inspect, replay, or resolve."
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
          <label for="eventType" class="fb-label">Event type</label>
          <select
            id="eventType"
            class="filter-select"
            [ngModel]="eventTypeFilter()"
            (ngModelChange)="eventTypeFilter.set($event)"
          >
            <option value="">all types</option>
            @for (t of typeOptions(); track t) {
              <option [value]="t">{{ t }}</option>
            }
          </select>
        </div>
        <div class="fb-field">
          <label for="status" class="fb-label">Status</label>
          <select
            id="status"
            class="filter-select"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="unresolved">Unresolved only</option>
            <option value="resolved">Resolved only</option>
            <option value="all">All</option>
          </select>
        </div>
        <div class="fb-field">
          <label for="search" class="fb-label">Search</label>
          <input
            id="search"
            class="filter-input"
            type="search"
            placeholder="error / event type"
            [ngModel]="searchFilter()"
            (ngModelChange)="searchFilter.set($event)"
          />
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load dead letters"
          message="Engine returned an error. The dead-letter list endpoint may be unhealthy — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- KPI strip — always rendered, zero counts visible -->
        <div class="kpi-strip">
          <app-metric-card
            label="Total"
            [value]="totalCount()"
            format="number"
            [dotColor]="totalCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Unresolved"
            [value]="unresolvedCount()"
            format="number"
            [dotColor]="unresolvedCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Resolved"
            [value]="resolvedCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Event types"
            [value]="typeBuckets().length"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Avg attempts"
            [value]="avgAttempts()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Max attempts"
            [value]="maxAttempts()"
            format="number"
            [dotColor]="maxAttempts() >= 5 ? '#FF3B30' : maxAttempts() >= 3 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Oldest unres (min)"
            [value]="oldestUnresolvedMinutes()"
            format="number"
            [dotColor]="
              oldestUnresolvedMinutes() >= 60 * 24
                ? '#FF3B30'
                : oldestUnresolvedMinutes() >= 60
                  ? '#FF9500'
                  : '#34C759'
            "
          />
          <app-metric-card
            label="Newest (min)"
            [value]="newestMinutes()"
            format="number"
            dotColor="#AF52DE"
          />
        </div>

        <!-- Insights row -->
        <section class="insights-section">
          <header class="insights-head">
            <h3>Queue insights</h3>
            <span class="muted">
              {{ filteredRows().length }} matching · last {{ windowHours() }}h
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
              @if (filteredRows().length === 0) {
                <p class="empty-line muted">
                  No dead letters in window. Engine processing all events cleanly.
                </p>
              } @else {
                <div class="histogram">
                  @for (h of hourBuckets(); track h.label) {
                    <div class="hist-col" [title]="h.label + ': ' + h.count + ' events'">
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
                <p class="empty-line muted">No retry storms, type dominance, or stale entries.</p>
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
                <span class="insight-title">By status</span>
                <span class="muted insight-status">{{ statusBuckets().length }} distinct</span>
              </header>
              @if (statusBuckets().length === 0) {
                <p class="empty-line muted">—</p>
              } @else {
                <ul class="breakdown">
                  @for (b of statusBuckets(); track b.key) {
                    <li class="bd-row">
                      <span class="status-pill" [attr.data-status]="b.key">{{ b.key }}</span>
                      <span class="bd-bar">
                        <span
                          class="bd-fill"
                          [class.green]="b.key === 'Resolved'"
                          [style.width.%]="b.share * 100"
                        ></span>
                      </span>
                      <span class="mono num">{{ b.count }}</span>
                      <span class="muted small">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </li>
                  }
                </ul>
              }
            </article>

            <article class="insight-card">
              <header class="insight-head">
                <span class="insight-title">By event type</span>
                <span class="muted insight-status">{{ typeBuckets().length }} distinct</span>
              </header>
              @if (typeBuckets().length === 0) {
                <p class="empty-line muted">—</p>
              } @else {
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
              }
            </article>
          </div>
        </section>

        <!-- By event-type board -->
        <section class="data-table-card">
          <header class="board-head">
            <h3>By event type</h3>
            <span class="muted">{{ typeRollups().length }} touched</span>
          </header>
          <table class="board-table">
            <thead>
              <tr>
                <th>Event type</th>
                <th class="num">Total</th>
                <th class="num">Unresolved</th>
                <th class="num">Max attempts</th>
                <th>Oldest</th>
                <th>Newest</th>
              </tr>
            </thead>
            <tbody>
              @if (typeRollups().length === 0) {
                <tr class="empty-row">
                  <td colspan="6" class="muted small">No events in window.</td>
                </tr>
              } @else {
                @for (r of typeRollups(); track r.eventType) {
                  <tr [class.row-warn]="r.unresolved > 0">
                    <td class="mono small">{{ r.eventType }}</td>
                    <td class="num">{{ r.total }}</td>
                    <td class="num" [class.sev-warn]="r.unresolved > 0">
                      {{ r.unresolved }}
                    </td>
                    <td class="num" [class.sev-warn]="r.maxAttempts >= 5">
                      {{ r.maxAttempts }}
                    </td>
                    <td class="time">
                      @if (r.oldest) {
                        {{ r.oldest | relativeTime }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="time">
                      @if (r.newest) {
                        {{ r.newest | relativeTime }}
                      } @else {
                        —
                      }
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </section>

        <!-- Queue table -->
        <section class="data-table-card">
          <header class="board-head">
            <h3>Queue</h3>
            <span class="muted">{{ filteredRows().length }} shown · click row for payload</span>
          </header>
          <table class="board-table">
            <thead>
              <tr>
                <th class="num">#</th>
                <th>Event type</th>
                <th>Status</th>
                <th class="num">Attempts</th>
                <th>Error</th>
                <th>Created</th>
                <th>Resolved</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              @if (filteredRows().length === 0) {
                <tr class="empty-row">
                  <td colspan="8" class="muted small">
                    Queue is quiet — no dead letters under current filters. The engine is processing
                    every integration event cleanly.
                  </td>
                </tr>
              } @else {
                @for (a of filteredRows(); track a.id) {
                  <tr (click)="select(a)" [class.selected-row]="selected()?.id === a.id">
                    <td class="num mono">{{ a.id }}</td>
                    <td class="small mono">{{ a.eventType ?? '—' }}</td>
                    <td>
                      <span
                        class="status-pill"
                        [attr.data-status]="a.isResolved ? 'Resolved' : 'Unresolved'"
                      >
                        {{ a.isResolved ? 'Resolved' : 'Unresolved' }}
                      </span>
                    </td>
                    <td class="num" [class.sev-warn]="a.attemptCount >= 5">{{ a.attemptCount }}</td>
                    <td class="reason small">{{ a.parsedError }}</td>
                    <td class="time" [title]="a.createdAt">
                      {{ a.createdAt | relativeTime }}
                    </td>
                    <td class="time">
                      @if (a.resolvedAt) {
                        {{ a.resolvedAt | relativeTime }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="actions" (click)="$event.stopPropagation()">
                      @if (!a.isResolved) {
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          [disabled]="busy()"
                          (click)="replay(a)"
                        >
                          Replay
                        </button>
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs"
                          [disabled]="busy()"
                          (click)="resolve(a)"
                        >
                          Resolve
                        </button>
                      } @else {
                        <span class="muted small">—</span>
                      }
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </section>

        <!-- Detail drawer — shown when a row is selected -->
        @if (selected(); as s) {
          <section class="data-table-card detail">
            <header class="board-head">
              <h3>Dead Letter #{{ s.id }}</h3>
              <div class="head-actions">
                @if (!s.isResolved) {
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    [disabled]="busy()"
                    (click)="replay(s)"
                  >
                    Replay
                  </button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-xs"
                    [disabled]="busy()"
                    (click)="resolve(s)"
                  >
                    Mark Resolved
                  </button>
                }
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  (click)="selected.set(null)"
                  [disabled]="busy()"
                >
                  Close
                </button>
              </div>
            </header>
            <div class="detail-body">
              <dl class="detail-meta">
                <div>
                  <dt>Event Type</dt>
                  <dd class="mono">{{ s.eventType ?? '—' }}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{{ s.attemptCount }}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{{ s.createdAt | date: 'MMM d, yyyy HH:mm:ss' }}</dd>
                </div>
                <div>
                  <dt>Resolved</dt>
                  <dd>
                    @if (s.resolvedAt) {
                      {{ s.resolvedAt | date: 'MMM d, yyyy HH:mm:ss' }}
                    } @else {
                      —
                    }
                  </dd>
                </div>
              </dl>
              <div class="detail-blocks">
                <div class="block">
                  <h4>Error message</h4>
                  <pre>{{ s.errorMessage || '(empty)' }}</pre>
                </div>
                <div class="block">
                  <h4>Payload</h4>
                  <pre>{{ formatJson(s.payloadJson || '(empty)') }}</pre>
                </div>
              </div>
            </div>
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
        gap: var(--space-3);
      }

      /* ── Filter bar ── */
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

      /* ── KPI strip ── */
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

      /* ── Insights ── */
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

      /* ── Histogram ── */
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

      /* ── Anomaly list ── */
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
      .anomaly[data-kind='retry-storm'],
      .anomaly[data-kind='high-attempts'] {
        background: rgba(239, 68, 68, 0.08);
      }
      .anomaly[data-kind='unresolved-stale'] {
        background: rgba(255, 149, 0, 0.08);
      }
      .anomaly[data-kind='type-dominance'] {
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

      /* ── Breakdown list ── */
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
      .bd-fill.green {
        background: #22c55e;
      }
      .bd-row .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* ── Board tables ── */
      .data-table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .board-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
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
      .head-actions {
        display: flex;
        gap: 4px;
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
      }
      .board-table td.num,
      .board-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .board-table tbody tr {
        cursor: pointer;
      }
      .board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .selected-row {
        background: rgba(0, 113, 227, 0.08) !important;
      }
      .row-warn {
        background: rgba(239, 68, 68, 0.04);
      }
      .sev-warn {
        color: rgb(220, 38, 38);
        font-weight: var(--font-semibold);
      }
      .empty-row td {
        text-align: center;
        padding: var(--space-3) !important;
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
      .time {
        color: var(--text-tertiary);
        font-size: 11px;
        white-space: nowrap;
      }
      .status-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
      }
      .status-pill[data-status='Unresolved'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .status-pill[data-status='Resolved'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
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
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* ── Detail drawer ── */
      .detail-body {
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .detail-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .detail-meta dt {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-semibold);
        margin: 0;
      }
      .detail-meta dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .detail-meta dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .detail-blocks {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .detail-blocks {
          grid-template-columns: 1fr;
        }
      }
      .block h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .block pre {
        margin: 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
      }
    `,
  ],
})
export class DeadLetterPageComponent {
  private readonly service = inject(DeadLetterService);
  private readonly notifications = inject(NotificationService);

  protected readonly windowPresets = [1, 6, 24, 72, 168];
  protected readonly windowHours = signal(168); // 7d default — dead letters decay slow
  protected readonly eventTypeFilter = signal('');
  protected readonly statusFilter = signal('unresolved');
  protected readonly searchFilter = signal('');

  protected readonly selected = signal<DeadLetterDto | null>(null);
  protected readonly busy = signal(false);

  // Refresh once a minute — the queue churns slowly; faster polling
  // would mostly waste round-trips.
  protected readonly resource = createPolledResource(
    () =>
      this.service.list({ currentPage: 1, itemCountPerPage: 500, filter: {} }).pipe(
        map((res) => res.data?.data ?? []),
        catchError(() => of<DeadLetterDto[]>([])),
      ),
    { intervalMs: 60_000 },
  );

  constructor() {
    effect(() => {
      this.windowHours();
      this.resource.refresh();
    });
  }

  // ── Filtering ──────────────────────────────────────────────────────

  protected readonly windowRows = computed(() => {
    const cutoffMs = Date.now() - this.windowHours() * 60 * 60 * 1000;
    return (this.resource.value() ?? []).filter((a) => new Date(a.createdAt).getTime() >= cutoffMs);
  });

  protected readonly filteredRows = computed<ParsedRow[]>(() => {
    const type = this.eventTypeFilter().toLowerCase();
    const status = this.statusFilter();
    const search = this.searchFilter().trim().toLowerCase();
    return this.windowRows()
      .filter((a) => {
        if (type && !(a.eventType ?? '').toLowerCase().includes(type)) return false;
        if (status === 'unresolved' && a.isResolved) return false;
        if (status === 'resolved' && !a.isResolved) return false;
        if (search) {
          const hay = `${a.eventType ?? ''} ${a.errorMessage ?? ''}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .map((a) => ({ ...a, parsedError: this.parseError(a) }));
  });

  protected readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? []).length === 0,
  );

  // ── KPI metrics ────────────────────────────────────────────────────

  protected readonly totalCount = computed(() => this.windowRows().length);
  protected readonly unresolvedCount = computed(
    () => this.windowRows().filter((a) => !a.isResolved).length,
  );
  protected readonly resolvedCount = computed(
    () => this.windowRows().filter((a) => a.isResolved).length,
  );
  protected readonly avgAttempts = computed(() => {
    const rows = this.windowRows();
    if (rows.length === 0) return 0;
    return Math.round((rows.reduce((s, a) => s + a.attemptCount, 0) / rows.length) * 10) / 10;
  });
  protected readonly maxAttempts = computed(() =>
    this.windowRows().reduce((m, a) => Math.max(m, a.attemptCount), 0),
  );
  protected readonly oldestUnresolvedMinutes = computed(() => {
    const unresolved = this.windowRows().filter((a) => !a.isResolved);
    if (unresolved.length === 0) return 0;
    const oldest = unresolved.reduce(
      (min, a) => (a.createdAt < min ? a.createdAt : min),
      unresolved[0].createdAt,
    );
    return Math.floor((Date.now() - new Date(oldest).getTime()) / 60_000);
  });
  protected readonly newestMinutes = computed(() => {
    const rows = this.windowRows();
    if (rows.length === 0) return 0;
    const latest = rows.reduce(
      (max, a) => (a.createdAt > max ? a.createdAt : max),
      rows[0].createdAt,
    );
    return Math.floor((Date.now() - new Date(latest).getTime()) / 60_000);
  });

  // ── Breakdowns ────────────────────────────────────────────────────

  protected readonly typeOptions = computed(() =>
    Array.from(
      new Set((this.resource.value() ?? []).map((a) => a.eventType ?? '(unknown)')),
    ).sort(),
  );

  protected readonly statusBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.windowRows(), (a) => (a.isResolved ? 'Resolved' : 'Unresolved')),
  );

  protected readonly typeBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.windowRows(), (a) => a.eventType ?? '(unknown)').slice(0, 8),
  );

  protected readonly typeRollups = computed<TypeRollup[]>(() => {
    const map = new Map<string, DeadLetterDto[]>();
    for (const a of this.windowRows()) {
      const k = a.eventType ?? '(unknown)';
      const list = map.get(k) ?? [];
      list.push(a);
      map.set(k, list);
    }
    const out: TypeRollup[] = [];
    for (const [eventType, rows] of map.entries()) {
      const unresolved = rows.filter((a) => !a.isResolved).length;
      const maxAttempts = rows.reduce((m, a) => Math.max(m, a.attemptCount), 0);
      let oldest: string | null = null;
      let newest: string | null = null;
      for (const a of rows) {
        if (oldest === null || a.createdAt < oldest) oldest = a.createdAt;
        if (newest === null || a.createdAt > newest) newest = a.createdAt;
      }
      out.push({ eventType, total: rows.length, unresolved, maxAttempts, oldest, newest });
    }
    return out.sort((a, b) => b.unresolved - a.unresolved || b.total - a.total);
  });

  // ── Histogram ─────────────────────────────────────────────────────

  protected readonly hourBuckets = computed<HourBucket[]>(() => {
    const hours = Math.max(1, Math.min(168, this.windowHours()));
    const nowMs = Date.now();
    const buckets: HourBucket[] = [];
    for (let i = hours - 1; i >= 0; i--) {
      const start = nowMs - (i + 1) * 60 * 60 * 1000;
      const label = new Date(start).toISOString().slice(11, 16);
      buckets.push({ label, count: 0 });
    }
    for (const r of this.windowRows()) {
      const t = new Date(r.createdAt).getTime();
      const ageH = Math.floor((nowMs - t) / (60 * 60 * 1000));
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

  // ── Anomaly detection ─────────────────────────────────────────────

  protected readonly anomalies = computed<AnomalyFlag[]>(() => {
    const flags: AnomalyFlag[] = [];
    const rows = this.windowRows();
    if (rows.length === 0) return flags;

    // High-attempts row — anything ≥ 5 attempts has likely retried past
    // the engine's standard exponential-backoff budget.
    const highAttempts = rows.filter((a) => a.attemptCount >= 5);
    if (highAttempts.length > 0) {
      flags.push({
        kind: 'high-attempts',
        detail: `${highAttempts.length} event${highAttempts.length === 1 ? '' : 's'} retried ≥5× — likely permanent failures.`,
      });
    }

    // Retry storm — burst hour > 3× window average AND ≥ 5 events
    const buckets = this.hourBuckets();
    const avg = this.avgHour();
    if (avg > 0) {
      const burst = buckets.reduce((m, b) => (b.count > m.count ? b : m), buckets[0]);
      if (burst.count >= 5 && burst.count > avg * 3) {
        flags.push({
          kind: 'retry-storm',
          detail: `${burst.count} events in one hour around ${burst.label}Z (~${(burst.count / avg).toFixed(1)}× window avg).`,
        });
      }
    }

    // Stale unresolved — oldest > 24h
    if (this.oldestUnresolvedMinutes() >= 60 * 24) {
      flags.push({
        kind: 'unresolved-stale',
        detail: `Oldest unresolved is ${Math.round(this.oldestUnresolvedMinutes() / 60)}h old — investigate or resolve.`,
      });
    }

    // Type dominance — single type ≥ 60% (only meaningful at scale)
    if (rows.length >= 10) {
      const top = this.typeBuckets()[0];
      if (top && top.share >= 0.6) {
        flags.push({
          kind: 'type-dominance',
          detail: `${top.key} accounts for ${top.count} of ${rows.length} events (${(top.share * 100).toFixed(0)}%).`,
        });
      }
    }

    return flags;
  });

  anomalyLabel(kind: AnomalyFlag['kind']): string {
    switch (kind) {
      case 'retry-storm':
        return 'STORM';
      case 'type-dominance':
        return 'TYPE';
      case 'unresolved-stale':
        return 'STALE';
      case 'high-attempts':
        return 'RETRIES';
    }
  }

  // ── Row actions ───────────────────────────────────────────────────

  select(row: DeadLetterDto): void {
    this.selected.set(row);
  }

  replay(dl: DeadLetterDto): void {
    this.busy.set(true);
    this.service.replay(dl.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(`Dead letter #${dl.id} replayed`);
          this.resource.refresh();
        } else {
          this.notifications.error(res.message ?? 'Replay failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  resolve(dl: DeadLetterDto): void {
    this.busy.set(true);
    this.service.resolve(dl.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(`Dead letter #${dl.id} resolved`);
          // Optimistically update the selected drawer if it's the same row
          // so the operator sees the new state without waiting for the poll.
          if (this.selected()?.id === dl.id) {
            this.selected.set({
              ...dl,
              isResolved: true,
              resolvedAt: new Date().toISOString(),
            });
          }
          this.resource.refresh();
        } else {
          this.notifications.error(res.message ?? 'Resolve failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  formatJson(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private bucketize<T>(rows: T[], getKey: (r: T) => string): KvBucket[] {
    const total = rows.length;
    const recentByRow = (r: T) => (r as unknown as { createdAt?: string }).createdAt ?? null;
    const map = new Map<string, { count: number; recentAt: string | null }>();
    for (const r of rows) {
      const k = getKey(r);
      const recent = recentByRow(r);
      const existing = map.get(k);
      if (existing) {
        existing.count++;
        if (recent && (!existing.recentAt || recent > existing.recentAt))
          existing.recentAt = recent;
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

  // Compact one-line error summary for table rows. The first line of the
  // exception message is usually enough; the full multi-line stack trace
  // lives in the detail drawer.
  private parseError(a: DeadLetterDto): string {
    const msg = (a.errorMessage ?? '').trim();
    if (!msg) return '(no error message)';
    const firstLine = msg.split('\n')[0];
    return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
  }
}
