import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { PositionsService } from '@core/services/positions.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { PositionLifecycleEventDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Fleet-wide position-delta feed (PRD-V2 FR-5.8 operator overview).
 *
 * Dense operator-console layout — built to surface the diagnostic
 * patterns operators reach for first:
 *
 *   - 8-tile compact KPI strip across the top (events, types, sources,
 *     positions touched, symbols touched, stale-close rate, in-flight
 *     closes, last-event-age)
 *   - Per-hour activity histogram so bursts (broker outages, EA restart
 *     storms) jump out without needing to read the table
 *   - Notable patterns panel that auto-flags Closing-without-Closed,
 *     StaleClose clusters, and reconcile churn
 *   - Side-by-side By-type + By-source aggregations
 *   - By-position rollup with mini timeline so one row tells the whole
 *     story per position
 *   - Recent events table enriched with symbol / direction / open lots /
 *     unrealised PnL — joined server-side, so 200 rows render without
 *     N+1 lookups
 */
interface TypeBucket {
  eventType: string;
  count: number;
  share: number;
  recentAt: string;
}

interface SourceBucket {
  source: string;
  count: number;
  share: number;
  recentAt: string;
}

interface PositionRollup {
  positionId: number;
  symbol: string | null;
  direction: 'Long' | 'Short' | null;
  status: string | null;
  openLots: number;
  unrealizedPnL: number;
  realizedPnL: number;
  events: PositionLifecycleEventDto[];
  eventTypes: string[];
  lastAt: string;
  hasStaleClose: boolean;
  hasClosingPending: boolean;
}

interface HourBucket {
  label: string;
  count: number;
}

interface AnomalyFlag {
  kind: 'closing-pending' | 'stale-burst' | 'reconcile-churn';
  positionId?: number;
  count: number;
  symbol?: string | null;
  detail: string;
}

@Component({
  selector: 'app-position-deltas-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Position deltas"
        subtitle="Fleet-wide position-lifecycle event stream"
      >
        <a routerLink="/positions" class="btn btn-secondary">← Positions</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      <section class="controls">
        <div class="control-group">
          <label for="window">Window (hours)</label>
          <input
            id="window"
            type="number"
            min="1"
            max="168"
            step="1"
            [ngModel]="windowHours()"
            (ngModelChange)="setWindow($event)"
          />
        </div>
        <div class="control-group">
          <label for="symbol">Symbol</label>
          <input
            id="symbol"
            type="search"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />
        </div>
        <div class="control-group">
          <label for="position">Position #</label>
          <input
            id="position"
            type="search"
            placeholder="id"
            [ngModel]="positionFilter()"
            (ngModelChange)="positionFilter.set($event)"
          />
        </div>
        <div class="control-group">
          <label for="source">Source</label>
          <select id="source" [ngModel]="sourceFilter()" (ngModelChange)="sourceFilter.set($event)">
            <option value="">(all sources)</option>
            <option value="EA">EA (delta)</option>
            <option value="EASnapshot">EASnapshot</option>
            <option value="OrderFilled">OrderFilled</option>
            <option value="OrderFilledEventHandler">OrderFilledEventHandler</option>
            <option value="PositionWorker">PositionWorker (any reason)</option>
            <option value="Manual">Manual</option>
            <option value="ReceivePositionSnapshot">ReceivePositionSnapshot</option>
          </select>
        </div>
        <div class="control-group">
          <label for="eventType">Type</label>
          <select
            id="eventType"
            [ngModel]="eventTypeFilter()"
            (ngModelChange)="eventTypeFilter.set($event)"
          >
            <option value="">(all types)</option>
            <option value="Opened">Opened</option>
            <option value="Closed">Closed</option>
            <option value="Closing">Closing</option>
            <option value="PartialClose">PartialClose</option>
            <option value="Modified">Modified</option>
            <option value="Reconciled">Reconciled</option>
            <option value="StaleClose">StaleClose</option>
          </select>
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load position deltas"
          message="Engine returned an error. The lifecycle audit table may be empty if the writer-side wiring hasn't shipped yet."
          (retry)="resource.refresh()"
        />
      } @else if (filteredRows().length === 0) {
        <app-empty-state
          title="No position deltas in this window"
          message="Either no positions changed in the chosen window, or the active filters exclude everything. Widen the window or clear filters."
        />
      } @else {
        <!-- Compact KPI strip — 8 tight tiles instead of 4 huge cards -->
        <section class="kpi-strip" aria-label="Summary metrics">
          <div class="kpi">
            <span class="kpi-label">Events</span>
            <span class="kpi-value">{{ filteredRows().length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Types</span>
            <span class="kpi-value">{{ typeBuckets().length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Sources</span>
            <span class="kpi-value">{{ sourceBuckets().length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Positions</span>
            <span class="kpi-value">{{ positionRollups().length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Symbols</span>
            <span class="kpi-value">{{ distinctSymbols() }}</span>
          </div>
          <div class="kpi" [class.alert]="staleCloseCount() > 0">
            <span class="kpi-label">StaleCloses</span>
            <span class="kpi-value">{{ staleCloseCount() }}</span>
            @if (filteredRows().length > 0) {
              <span class="kpi-trend">
                {{ (staleCloseCount() / filteredRows().length) * 100 | number: '1.0-0' }}%
              </span>
            }
          </div>
          <div class="kpi" [class.alert]="closingPendingCount() > 0">
            <span class="kpi-label">Closing pending</span>
            <span class="kpi-value">{{ closingPendingCount() }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Last event</span>
            <span class="kpi-value-sm">
              @if (lastEventAt()) {
                {{ lastEventAt()! | relativeTime }}
              } @else {
                —
              }
            </span>
          </div>
        </section>

        <!-- Per-hour activity histogram + Notable patterns side-by-side -->
        <div class="row-2">
          <section class="card activity-card">
            <header class="card-head">
              <h3>Activity</h3>
              <span class="muted small">events / hour, last {{ windowHours() }}h</span>
            </header>
            <div class="histogram" [attr.aria-label]="'Per-hour event histogram'">
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
              <span class="muted small">
                peak {{ peakHour() }} • avg {{ avgHour() | number: '1.1-1' }}/h
              </span>
              <span>now</span>
            </footer>
          </section>

          <section class="card patterns-card">
            <header class="card-head">
              <h3>Notable patterns</h3>
              <span class="muted small">{{ anomalies().length }} flagged</span>
            </header>
            @if (anomalies().length === 0) {
              <p class="muted small empty-line">
                No closing-pending positions, stale-close clusters, or reconcile churn in window.
              </p>
            } @else {
              <ul class="anomaly-list">
                @for (a of anomalies(); track $index) {
                  <li class="anomaly" [attr.data-kind]="a.kind">
                    <span class="anomaly-tag">{{ anomalyLabel(a.kind) }}</span>
                    @if (a.positionId !== undefined) {
                      <a class="link mono" [routerLink]="['/positions', a.positionId]"
                        >#{{ a.positionId }}</a
                      >
                    }
                    @if (a.symbol) {
                      <span class="mono small">{{ a.symbol }}</span>
                    }
                    <span class="small">{{ a.detail }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        </div>

        <!-- By type + By source side-by-side -->
        <div class="row-2">
          <section class="card">
            <header class="card-head">
              <h3>By type</h3>
              <span class="muted small">{{ typeBuckets().length }} distinct</span>
            </header>
            <table class="deltas-table compact">
              <thead>
                <tr>
                  <th>Type</th>
                  <th class="num">N</th>
                  <th class="num">Share</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                @for (b of typeBuckets(); track b.eventType) {
                  <tr>
                    <td>
                      <span class="badge" [attr.data-type]="eventBucket(b.eventType)">
                        {{ b.eventType }}
                      </span>
                    </td>
                    <td class="num">{{ b.count }}</td>
                    <td class="num">
                      <span class="bar-track">
                        <span class="bar-fill" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="small muted">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </td>
                    <td class="time">{{ b.recentAt | relativeTime }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <section class="card">
            <header class="card-head">
              <h3>By source</h3>
              <span class="muted small">{{ sourceBuckets().length }} distinct</span>
            </header>
            <table class="deltas-table compact">
              <thead>
                <tr>
                  <th>Source</th>
                  <th class="num">N</th>
                  <th class="num">Share</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                @for (b of sourceBuckets(); track b.source) {
                  <tr>
                    <td class="small mono">{{ b.source }}</td>
                    <td class="num">{{ b.count }}</td>
                    <td class="num">
                      <span class="bar-track">
                        <span class="bar-fill purple" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="small muted">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </td>
                    <td class="time">{{ b.recentAt | relativeTime }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>

        <!-- By position rollup — one row per position with a mini timeline -->
        <section class="card">
          <header class="card-head">
            <h3>By position</h3>
            <span class="muted small">{{ positionRollups().length }} touched</span>
          </header>
          <table class="deltas-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Symbol</th>
                <th>Dir</th>
                <th>State</th>
                <th class="num">Lots</th>
                <th class="num">U-PnL</th>
                <th class="num">R-PnL</th>
                <th>Sequence</th>
                <th class="num">N</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              @for (r of positionRollups(); track r.positionId) {
                <tr
                  [class.row-warn]="r.hasStaleClose"
                  [class.row-pending]="r.hasClosingPending && !r.hasStaleClose"
                >
                  <td>
                    <a class="link mono" [routerLink]="['/positions', r.positionId]"
                      >#{{ r.positionId }}</a
                    >
                  </td>
                  <td class="mono">{{ r.symbol ?? '—' }}</td>
                  <td>
                    @if (r.direction) {
                      <span class="dir-pill" [attr.data-dir]="r.direction">{{ r.direction }}</span>
                    } @else {
                      <span class="muted small">—</span>
                    }
                  </td>
                  <td>
                    <span class="small muted">{{ r.status ?? '—' }}</span>
                  </td>
                  <td class="num mono">{{ r.openLots | number: '1.2-2' }}</td>
                  <td
                    class="num mono"
                    [class.profit]="r.unrealizedPnL > 0"
                    [class.loss]="r.unrealizedPnL < 0"
                  >
                    {{ r.unrealizedPnL | number: '1.2-2' }}
                  </td>
                  <td
                    class="num mono"
                    [class.profit]="r.realizedPnL > 0"
                    [class.loss]="r.realizedPnL < 0"
                  >
                    {{ r.realizedPnL | number: '1.2-2' }}
                  </td>
                  <td class="sequence">
                    @for (et of r.eventTypes; track $index) {
                      <span class="mini-badge" [attr.data-type]="eventBucket(et)">{{
                        shortType(et)
                      }}</span>
                    }
                  </td>
                  <td class="num">{{ r.events.length }}</td>
                  <td class="time">{{ r.lastAt | relativeTime }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <!-- Recent events table — enriched with joined Position columns -->
        <section class="card">
          <header class="card-head">
            <h3>Recent events</h3>
            <span class="muted small">{{ filteredRows().length }} shown</span>
          </header>
          <table class="deltas-table compact">
            <thead>
              <tr>
                <th>When</th>
                <th>#</th>
                <th>Symbol</th>
                <th>Dir</th>
                <th>Type</th>
                <th>Source</th>
                <th class="num">Lots Δ</th>
                <th class="num">U-PnL</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              @for (s of filteredRows(); track s.id) {
                <tr>
                  <td class="time" [title]="s.occurredAt">
                    {{ s.occurredAt | date: 'HH:mm:ss' }}
                  </td>
                  <td>
                    <a class="link mono" [routerLink]="['/positions', s.positionId]"
                      >#{{ s.positionId }}</a
                    >
                  </td>
                  <td class="mono">{{ s.symbol ?? '—' }}</td>
                  <td>
                    @if (s.direction) {
                      <span class="dir-pill" [attr.data-dir]="s.direction">{{ s.direction }}</span>
                    } @else {
                      <span class="muted small">—</span>
                    }
                  </td>
                  <td>
                    <span class="badge" [attr.data-type]="eventBucket(s.eventType)">
                      {{ s.eventType }}
                    </span>
                  </td>
                  <td class="small mono">{{ s.source }}</td>
                  <td class="num mono">
                    @if (s.previousLots !== null) {
                      {{ s.previousLots | number: '1.2-2' }}
                    } @else {
                      —
                    }
                    <span class="arrow">→</span>
                    @if (s.newLots !== null) {
                      {{ s.newLots | number: '1.2-2' }}
                    } @else {
                      —
                    }
                  </td>
                  <td
                    class="num mono"
                    [class.profit]="s.unrealizedPnL > 0"
                    [class.loss]="s.unrealizedPnL < 0"
                  >
                    {{ s.unrealizedPnL | number: '1.2-2' }}
                  </td>
                  <td class="desc small">{{ s.description }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .controls {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
        padding: var(--space-2) 0;
      }
      .control-group {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .control-group label {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: var(--font-semibold);
      }
      .control-group input,
      .control-group select {
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        min-width: 140px;
        font-size: var(--text-sm);
      }

      /* ── Compact KPI strip ───────────────────────────────────────── */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1280px) {
        .kpi-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 10px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-sm);
      }
      .kpi.alert {
        border-color: #ff9500;
        background: rgba(255, 149, 0, 0.06);
      }
      .kpi-label {
        font-size: 9px;
        font-weight: var(--font-bold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .kpi-value {
        font-size: 18px;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        line-height: 1.2;
      }
      .kpi-value-sm {
        font-size: 12px;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        line-height: 1.4;
      }
      .kpi-trend {
        font-size: 10px;
        color: var(--text-secondary);
      }

      /* ── Two-column rows ───────────────────────────────────── */
      .row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .row-2 {
          grid-template-columns: 1fr;
        }
      }

      /* ── Cards ───────────────────────────────────── */
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-3);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: var(--space-2);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .empty-line {
        margin: 0;
        padding: var(--space-2) 0;
      }

      /* ── Histogram ───────────────────────────────────── */
      .activity-card {
        display: flex;
        flex-direction: column;
      }
      .histogram {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(6px, 1fr));
        gap: 1px;
        height: 60px;
        align-items: end;
        margin: var(--space-2) 0 4px;
      }
      .hist-col {
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        min-width: 0;
      }
      .hist-bar {
        display: block;
        background: linear-gradient(180deg, #4a90e2 0%, #2e5e9e 100%);
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
        align-items: center;
        font-size: 10px;
        color: var(--text-tertiary);
      }

      /* ── Anomaly list ───────────────────────────────────── */
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
        font-size: var(--text-sm);
      }
      .anomaly[data-kind='stale-burst'] {
        background: rgba(239, 68, 68, 0.08);
      }
      .anomaly[data-kind='closing-pending'] {
        background: rgba(255, 149, 0, 0.08);
      }
      .anomaly[data-kind='reconcile-churn'] {
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

      /* ── Tables ───────────────────────────────────── */
      .deltas-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .deltas-table th,
      .deltas-table td {
        padding: 5px 8px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .deltas-table.compact th,
      .deltas-table.compact td {
        padding: 3px 8px;
      }
      .deltas-table tbody tr:last-child td {
        border-bottom: none;
      }
      .deltas-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
      }
      .deltas-table td.num,
      .deltas-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .row-warn {
        background: rgba(239, 68, 68, 0.04);
      }
      .row-pending {
        background: rgba(255, 149, 0, 0.04);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-secondary);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .desc {
        color: var(--text-secondary);
        max-width: 380px;
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
        color: var(--text-secondary);
        font-size: 11px;
        white-space: nowrap;
      }
      .arrow {
        margin: 0 4px;
        color: var(--text-tertiary);
      }

      /* ── Badges ───────────────────────────────────── */
      .badge {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .badge[data-type='open'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
      }
      .badge[data-type='close'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .badge[data-type='modify'] {
        background: rgba(245, 158, 11, 0.15);
        color: rgb(217, 119, 6);
      }
      .badge[data-type='reconcile'] {
        background: rgba(59, 130, 246, 0.15);
        color: rgb(37, 99, 235);
      }
      .dir-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
      }
      .dir-pill[data-dir='Long'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
      }
      .dir-pill[data-dir='Short'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }

      /* ── Mini timeline (sequence chips) ───────────────────────────────────── */
      .sequence {
        display: flex;
        gap: 2px;
        flex-wrap: wrap;
        align-items: center;
      }
      .mini-badge {
        font-size: 9px;
        font-weight: var(--font-bold);
        padding: 1px 4px;
        border-radius: 2px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .mini-badge[data-type='open'] {
        background: rgba(34, 197, 94, 0.18);
        color: rgb(22, 163, 74);
      }
      .mini-badge[data-type='close'] {
        background: rgba(239, 68, 68, 0.18);
        color: rgb(220, 38, 38);
      }
      .mini-badge[data-type='modify'] {
        background: rgba(245, 158, 11, 0.18);
        color: rgb(217, 119, 6);
      }
      .mini-badge[data-type='reconcile'] {
        background: rgba(59, 130, 246, 0.18);
        color: rgb(37, 99, 235);
      }

      .bar-track {
        display: inline-block;
        width: 60px;
        height: 6px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
        vertical-align: middle;
        margin-right: 6px;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: #ff9500;
        border-radius: var(--radius-full);
      }
      .bar-fill.purple {
        background: #9b59b6;
      }
    `,
  ],
})
export class PositionDeltasPageComponent {
  private readonly positions = inject(PositionsService);
  private readonly realtime = inject(RealtimeService);

  protected readonly windowHours = signal(24);
  protected readonly symbolFilter = signal('');
  protected readonly positionFilter = signal('');
  protected readonly sourceFilter = signal('');
  protected readonly eventTypeFilter = signal('');

  // Push events arriving via SignalR — merged with polled rows in `rows()` and
  // deduped by id. Capped so a runaway stream can't grow this unboundedly.
  private readonly livePrepend = signal<PositionLifecycleEventDto[]>([]);
  private static readonly LIVE_PREPEND_MAX = 200;

  protected readonly resource = createPolledResource(
    () => {
      const since = new Date(Date.now() - this.windowHours() * 60 * 60 * 1000).toISOString();
      return this.positions
        .listLifecycleEvents({
          currentPage: 1,
          itemCountPerPage: 200,
          filter: {
            from: since,
            source: this.sourceFilter() || null,
            eventType: this.eventTypeFilter() || null,
          },
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<PositionLifecycleEventDto[]>([])),
        );
    },
    { intervalMs: 30_000 },
  );

  constructor() {
    effect(() => {
      this.windowHours();
      this.sourceFilter();
      this.eventTypeFilter();
      // Engine-side filters changed — discard the live buffer too so the
      // merged view matches the resulting polled refetch.
      this.livePrepend.set([]);
      this.resource.refresh();
    });

    this.realtime
      .on<PositionLifecycleEventDto>('positionLifecycleEvent')
      .pipe(takeUntilDestroyed())
      .subscribe((evt) => {
        if (!this.matchesActiveFilters(evt)) return;
        this.livePrepend.update((buf) =>
          [evt, ...buf].slice(0, PositionDeltasPageComponent.LIVE_PREPEND_MAX),
        );
      });
  }

  protected readonly rawRows = computed(() => {
    const polled = this.resource.value() ?? [];
    const live = this.livePrepend();
    if (live.length === 0) return polled;
    const seen = new Set(polled.map((r) => r.id));
    const merged: PositionLifecycleEventDto[] = [];
    for (const e of live) if (!seen.has(e.id)) merged.push(e);
    return [...merged, ...polled];
  });

  // Client-side filters (symbol + position id) applied on top of the
  // engine-side filters (source / eventType / time window).
  protected readonly filteredRows = computed(() => {
    const sym = this.symbolFilter().trim().toUpperCase();
    const posStr = this.positionFilter().trim();
    const posId = posStr ? Number(posStr) : NaN;
    return this.rawRows().filter((r) => {
      if (sym && !(r.symbol ?? '').toUpperCase().includes(sym)) return false;
      if (!isNaN(posId) && r.positionId !== posId) return false;
      return true;
    });
  });

  protected readonly loading = computed(
    () => this.resource.loading() && this.rawRows().length === 0,
  );

  protected readonly lastEventAt = computed(() => {
    const rows = this.filteredRows();
    if (rows.length === 0) return null;
    return rows.reduce((max, r) => (r.occurredAt > max ? r.occurredAt : max), rows[0].occurredAt);
  });

  protected readonly distinctSymbols = computed(
    () => new Set(this.filteredRows().map((r) => r.symbol ?? '—')).size,
  );

  protected readonly staleCloseCount = computed(
    () => this.filteredRows().filter((r) => r.eventType === 'StaleClose').length,
  );

  protected readonly closingPendingCount = computed(() => {
    // A "Closing" event that isn't paired with a later Closed/StaleClose on
    // the same position is in-flight — broker confirmation pending.
    const rows = this.filteredRows();
    const byPos = new Map<number, PositionLifecycleEventDto[]>();
    for (const r of rows) {
      const list = byPos.get(r.positionId) ?? [];
      list.push(r);
      byPos.set(r.positionId, list);
    }
    let pending = 0;
    for (const events of byPos.values()) {
      events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const last = events[events.length - 1];
      if (last.eventType === 'Closing') pending++;
    }
    return pending;
  });

  protected readonly typeBuckets = computed<TypeBucket[]>(() => {
    const rows = this.filteredRows();
    const total = rows.length;
    const map = new Map<string, { count: number; recentAt: string }>();
    for (const row of rows) {
      const existing = map.get(row.eventType);
      if (existing) {
        existing.count++;
        if (row.occurredAt > existing.recentAt) existing.recentAt = row.occurredAt;
      } else {
        map.set(row.eventType, { count: 1, recentAt: row.occurredAt });
      }
    }
    return Array.from(map.entries())
      .map(([eventType, v]) => ({
        eventType,
        count: v.count,
        share: total > 0 ? v.count / total : 0,
        recentAt: v.recentAt,
      }))
      .sort((a, b) => b.count - a.count);
  });

  protected readonly sourceBuckets = computed<SourceBucket[]>(() => {
    const rows = this.filteredRows();
    const total = rows.length;
    // Strip "PositionWorker:<reason>" colon-suffixes for a cleaner bucket;
    // the worker auto-close variants all roll up under "PositionWorker".
    const normalize = (s: string) => (s.includes(':') ? s.split(':')[0] : s);
    const map = new Map<string, { count: number; recentAt: string }>();
    for (const row of rows) {
      const key = normalize(row.source);
      const existing = map.get(key);
      if (existing) {
        existing.count++;
        if (row.occurredAt > existing.recentAt) existing.recentAt = row.occurredAt;
      } else {
        map.set(key, { count: 1, recentAt: row.occurredAt });
      }
    }
    return Array.from(map.entries())
      .map(([source, v]) => ({
        source,
        count: v.count,
        share: total > 0 ? v.count / total : 0,
        recentAt: v.recentAt,
      }))
      .sort((a, b) => b.count - a.count);
  });

  protected readonly positionRollups = computed<PositionRollup[]>(() => {
    const rows = this.filteredRows();
    const byPos = new Map<number, PositionLifecycleEventDto[]>();
    for (const r of rows) {
      const list = byPos.get(r.positionId) ?? [];
      list.push(r);
      byPos.set(r.positionId, list);
    }
    const rollups: PositionRollup[] = [];
    for (const [positionId, events] of byPos.entries()) {
      events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const last = events[events.length - 1];
      const eventTypes = events.map((e) => e.eventType);
      rollups.push({
        positionId,
        symbol: last.symbol,
        direction: this.normaliseDirection(last.direction),
        status: this.normaliseStatus(last.positionStatus),
        openLots: last.openLots,
        unrealizedPnL: last.unrealizedPnL,
        realizedPnL: last.realizedPnL,
        events,
        eventTypes,
        lastAt: last.occurredAt,
        hasStaleClose: eventTypes.includes('StaleClose'),
        hasClosingPending: last.eventType === 'Closing',
      });
    }
    return rollups.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  });

  protected readonly hourBuckets = computed<HourBucket[]>(() => {
    const rows = this.filteredRows();
    const hours = Math.max(1, Math.min(168, this.windowHours()));
    // Anchor buckets to whole UTC hours starting from `now - windowHours`.
    const nowMs = Date.now();
    const buckets: HourBucket[] = [];
    for (let i = hours - 1; i >= 0; i--) {
      const start = nowMs - (i + 1) * 60 * 60 * 1000;
      const label = new Date(start).toISOString().slice(11, 16);
      buckets.push({ label, count: 0 });
    }
    for (const r of rows) {
      const t = new Date(r.occurredAt).getTime();
      const ageH = Math.floor((nowMs - t) / (60 * 60 * 1000));
      const idx = hours - 1 - ageH;
      if (idx >= 0 && idx < buckets.length) buckets[idx].count++;
    }
    return buckets;
  });

  protected readonly peakHour = computed(() => {
    const buckets = this.hourBuckets();
    if (buckets.length === 0) return 0;
    return buckets.reduce((m, b) => Math.max(m, b.count), 0);
  });

  protected readonly avgHour = computed(() => {
    const buckets = this.hourBuckets();
    if (buckets.length === 0) return 0;
    return buckets.reduce((s, b) => s + b.count, 0) / buckets.length;
  });

  protected hourBarHeight(count: number): number {
    const peak = this.peakHour();
    if (peak === 0) return 0;
    // Min 4% so non-zero hours stay visible even next to a tall peak.
    return Math.max(4, (count / peak) * 100);
  }

  protected readonly anomalies = computed<AnomalyFlag[]>(() => {
    const flags: AnomalyFlag[] = [];
    const rollups = this.positionRollups();

    // 1. Closing-pending: last event on a position is "Closing" (no Closed/
    //    StaleClose follow-up). Broker confirmation never arrived in window.
    for (const r of rollups) {
      if (r.hasClosingPending) {
        flags.push({
          kind: 'closing-pending',
          positionId: r.positionId,
          symbol: r.symbol,
          count: 1,
          detail: `Closing queued ${this.relativeShort(r.lastAt)} — no broker ack.`,
        });
      }
    }

    // 2. Stale-close burst: any position with >= 1 StaleClose. Single events
    //    are usually noise (one missed OnTradeTransaction), but the page
    //    surfaces every one because operators tend to investigate them.
    for (const r of rollups) {
      if (r.hasStaleClose) {
        const staleN = r.events.filter((e) => e.eventType === 'StaleClose').length;
        flags.push({
          kind: 'stale-burst',
          positionId: r.positionId,
          symbol: r.symbol,
          count: staleN,
          detail: `${staleN} StaleClose event${staleN === 1 ? '' : 's'} — broker / EA reconciliation gap.`,
        });
      }
    }

    // 3. Reconcile churn: > 3 Reconciled events on the same position in
    //    window. Suggests the broker-side identity is bouncing.
    for (const r of rollups) {
      const reconciles = r.events.filter((e) => e.eventType === 'Reconciled').length;
      if (reconciles > 3) {
        flags.push({
          kind: 'reconcile-churn',
          positionId: r.positionId,
          symbol: r.symbol,
          count: reconciles,
          detail: `${reconciles} reconciles — broker-side identity churning.`,
        });
      }
    }

    return flags;
  });

  protected setWindow(v: number | string): void {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 168) this.windowHours.set(n);
  }

  // Mirrors the per-position card's bucketer so colour coding is consistent
  // across both surfaces. Unknown EventType strings fall through to the
  // neutral default.
  eventBucket(type: string): 'open' | 'close' | 'modify' | 'reconcile' | 'other' {
    const t = (type ?? '').toLowerCase();
    if (t === 'opened') return 'open';
    if (t.includes('close')) return 'close';
    if (t === 'modified') return 'modify';
    if (t.includes('reconcile')) return 'reconcile';
    return 'other';
  }

  // 2-3 char compact form for the sequence chips in the By-position rollup.
  shortType(t: string): string {
    switch (t) {
      case 'Opened':
        return 'OPN';
      case 'Closed':
        return 'CLS';
      case 'Closing':
        return '→CL';
      case 'PartialClose':
        return 'PC';
      case 'Modified':
        return 'MOD';
      case 'Reconciled':
        return 'REC';
      case 'StaleClose':
        return 'STL';
      default:
        return t.slice(0, 3).toUpperCase();
    }
  }

  anomalyLabel(kind: AnomalyFlag['kind']): string {
    switch (kind) {
      case 'closing-pending':
        return 'IN-FLIGHT';
      case 'stale-burst':
        return 'STALE';
      case 'reconcile-churn':
        return 'CHURN';
    }
  }

  // Client-side mirror of the engine's filter logic so push events arriving
  // in the SignalR stream don't bypass the active selector state. Substring
  // match on source matches the engine's ILIKE semantics
  // (PositionWorker matches "PositionWorker:StopLoss" etc.).
  private matchesActiveFilters(evt: PositionLifecycleEventDto): boolean {
    const src = this.sourceFilter();
    if (src && !evt.source.toLowerCase().includes(src.toLowerCase())) return false;
    const type = this.eventTypeFilter();
    if (type && !evt.eventType.toLowerCase().includes(type.toLowerCase())) return false;
    const cutoff = Date.now() - this.windowHours() * 60 * 60 * 1000;
    if (new Date(evt.occurredAt).getTime() < cutoff) return false;
    return true;
  }

  private normaliseDirection(d: PositionLifecycleEventDto['direction']): 'Long' | 'Short' | null {
    // The engine may serialise the enum as either a string ("Long" / "Short")
    // or its numeric ordinal (0 / 1) depending on JSON converter config; handle both.
    const raw = d as unknown;
    if (raw === 'Long' || raw === 0 || raw === '0') return 'Long';
    if (raw === 'Short' || raw === 1 || raw === '1') return 'Short';
    return null;
  }

  private normaliseStatus(s: PositionLifecycleEventDto['positionStatus']): string | null {
    // The engine serialises enums as strings by default in this codebase;
    // handle the numeric-fallback path too.
    if (typeof s === 'string') return s;
    return null;
  }

  private relativeShort(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }
}
