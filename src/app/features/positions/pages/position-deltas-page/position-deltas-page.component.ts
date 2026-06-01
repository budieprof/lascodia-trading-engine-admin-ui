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
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Fleet-wide position-delta feed (PRD-V2 FR-5.8 operator overview).
 *
 * Follows the market-data page's design language:
 *   - <app-metric-card> tiles in a .kpi-strip for the top metrics row
 *   - .insights-section + .insights-grid + .insight-card panels for the
 *     multi-panel analytics block (histogram, notable patterns, type/source
 *     breakdowns)
 *   - .data-table-card + .board-head + .board-table for the per-position
 *     rollup and recent-events tables
 *   - Page-level filter row stays flat across the top, like the market-data
 *     trading-sessions toolbar
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
    MetricCardComponent,
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

      <section class="filter-bar">
        <div class="fb-field">
          <label for="window" class="fb-label">Window</label>
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
          <label for="position" class="fb-label">Position #</label>
          <input
            id="position"
            class="filter-input"
            type="search"
            placeholder="id"
            [ngModel]="positionFilter()"
            (ngModelChange)="positionFilter.set($event)"
          />
        </div>
        <div class="fb-field">
          <label for="source" class="fb-label">Source</label>
          <select
            id="source"
            class="filter-select"
            [ngModel]="sourceFilter()"
            (ngModelChange)="sourceFilter.set($event)"
          >
            <option value="">all sources</option>
            <option value="EA">EA (delta)</option>
            <option value="EASnapshot">EASnapshot</option>
            <option value="OrderFilled">OrderFilled</option>
            <option value="OrderFilledEventHandler">OrderFilledEventHandler</option>
            <option value="PositionWorker">PositionWorker</option>
            <option value="Manual">Manual</option>
            <option value="ReceivePositionSnapshot">ReceivePositionSnapshot</option>
          </select>
        </div>
        <div class="fb-field">
          <label for="eventType" class="fb-label">Type</label>
          <select
            id="eventType"
            class="filter-select"
            [ngModel]="eventTypeFilter()"
            (ngModelChange)="eventTypeFilter.set($event)"
          >
            <option value="">all types</option>
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
          message="Engine returned an error. The lifecycle audit may be empty if the writer-side wiring hasn't shipped."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- KPI strip — canonical metric-cards, always rendered. -->
        <div class="kpi-strip">
          <app-metric-card
            label="Events"
            [value]="filteredRows().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Types"
            [value]="typeBuckets().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Sources"
            [value]="sourceBuckets().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Positions"
            [value]="positionRollups().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Symbols"
            [value]="distinctSymbols()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="StaleCloses"
            [value]="staleCloseCount()"
            format="number"
            [dotColor]="staleCloseCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Closing pending"
            [value]="closingPendingCount()"
            format="number"
            [dotColor]="closingPendingCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Last event (min ago)"
            [value]="lastEventMinutes()"
            format="number"
            dotColor="#AF52DE"
          />
        </div>

        @if (filteredRows().length === 0) {
          <app-empty-state
            title="No position deltas in this window"
            message="Either no positions changed in the chosen window, or the active filters exclude everything. Widen the window or clear filters."
          />
        } @else {
          <!-- Insights row — histogram + notable patterns + breakdowns -->
          <section class="insights-section">
            <header class="insights-head">
              <h3>Lifecycle insights</h3>
              <span class="muted">
                {{ filteredRows().length }} event{{ filteredRows().length === 1 ? '' : 's' }} · last
                {{ windowHours() }}h
              </span>
            </header>
            <div class="insights-grid">
              <!-- Activity histogram -->
              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">Activity</span>
                  <span class="muted insight-status">
                    peak {{ peakHour() }} · avg {{ avgHour() | number: '1.1-1' }}/h
                  </span>
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
                  <span>now</span>
                </footer>
              </article>

              <!-- Notable patterns -->
              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">Notable patterns</span>
                  <span class="muted insight-status">{{ anomalies().length }} flagged</span>
                </header>
                @if (anomalies().length === 0) {
                  <p class="empty-line muted">
                    No closing-pending, stale-close, or reconcile-churn patterns in window.
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
              </article>

              <!-- By type -->
              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">By type</span>
                  <span class="muted insight-status">{{ typeBuckets().length }} distinct</span>
                </header>
                <ul class="breakdown">
                  @for (b of typeBuckets(); track b.eventType) {
                    <li class="bd-row">
                      <span class="badge" [attr.data-type]="eventBucket(b.eventType)">
                        {{ b.eventType }}
                      </span>
                      <span class="bd-bar">
                        <span class="bd-fill" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="mono num">{{ b.count }}</span>
                      <span class="muted small">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </li>
                  }
                </ul>
              </article>

              <!-- By source -->
              <article class="insight-card">
                <header class="insight-head">
                  <span class="insight-title">By source</span>
                  <span class="muted insight-status">{{ sourceBuckets().length }} distinct</span>
                </header>
                <ul class="breakdown">
                  @for (b of sourceBuckets(); track b.source) {
                    <li class="bd-row">
                      <span class="small mono">{{ b.source }}</span>
                      <span class="bd-bar">
                        <span class="bd-fill purple" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="mono num">{{ b.count }}</span>
                      <span class="muted small">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </li>
                  }
                </ul>
              </article>
            </div>
          </section>

          <!-- By position rollup — board pattern -->
          <section class="data-table-card">
            <header class="board-head">
              <h3>By position</h3>
              <span class="muted">{{ positionRollups().length }} touched</span>
            </header>
            <div class="table-scroll table-scroll--rollup">
              <table class="board-table">
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
                          <span class="dir-pill" [attr.data-dir]="r.direction">{{
                            r.direction
                          }}</span>
                        } @else {
                          <span class="muted small">—</span>
                        }
                      </td>
                      <td class="small muted">{{ r.status ?? '—' }}</td>
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
            </div>
          </section>

          <!-- Recent events table -->
          <section class="data-table-card">
            <header class="board-head">
              <h3>Recent events</h3>
              <span class="muted">{{ filteredRows().length }} shown</span>
            </header>
            <div class="table-scroll table-scroll--events">
              <table class="board-table">
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
                          <span class="dir-pill" [attr.data-dir]="s.direction">{{
                            s.direction
                          }}</span>
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
                      <td class="desc">{{ s.description }}</td>
                    </tr>
                  }
                </tbody>
              </table>
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
        gap: var(--space-4);
      }

      /* ── Filter bar — matches the ml-models / market-data toolbar ── */
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

      /* ── KPI strip — canonical 8-col grid (matches market-data) ── */
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

      /* ── Insights section — board-style wrapper + 1px-border grid trick ── */
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

      /* ── Histogram (inside insight-card) ── */
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
        font-size: 10px;
        color: var(--text-tertiary);
      }

      /* ── Notable patterns list (inside insight-card) ── */
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

      /* ── Breakdown list (in-card) ── */
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
        background: #ff9500;
      }
      .bd-fill.purple {
        background: #9b59b6;
      }
      .bd-row .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* ── Board-pattern data tables — match market-data ── */
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
      /* Bound the rollup + events tables so the page doesn't stretch to
         hundreds of pixels of vertical scroll. Each table gets its own
         max-height + an internal scroll; the sticky thead keeps the
         column labels visible as the operator scrolls within the panel. */
      .table-scroll {
        overflow: auto;
      }
      .table-scroll--rollup {
        max-height: 360px;
      }
      .table-scroll--events {
        max-height: 520px;
      }
      .board-table td.num,
      .board-table th.num {
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
        font-family: 'SF Mono', 'Fira Code', monospace;
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
        color: var(--text-tertiary);
        font-size: 11px;
        white-space: nowrap;
      }
      .arrow {
        margin: 0 4px;
        color: var(--text-tertiary);
      }

      /* ── Badges & pills ── */
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
    `,
  ],
})
export class PositionDeltasPageComponent {
  private readonly positions = inject(PositionsService);
  private readonly realtime = inject(RealtimeService);

  protected readonly windowPresets = [1, 6, 24, 72, 168];
  protected readonly windowHours = signal(24);
  protected readonly symbolFilter = signal('');
  protected readonly positionFilter = signal('');
  protected readonly sourceFilter = signal('');
  protected readonly eventTypeFilter = signal('');

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

  protected readonly lastEventMinutes = computed(() => {
    const rows = this.filteredRows();
    if (rows.length === 0) return 0;
    const latest = rows.reduce(
      (max, r) => (r.occurredAt > max ? r.occurredAt : max),
      rows[0].occurredAt,
    );
    return Math.floor((Date.now() - new Date(latest).getTime()) / 60_000);
  });

  protected readonly distinctSymbols = computed(
    () => new Set(this.filteredRows().map((r) => r.symbol ?? '—')).size,
  );

  protected readonly staleCloseCount = computed(
    () => this.filteredRows().filter((r) => r.eventType === 'StaleClose').length,
  );

  protected readonly closingPendingCount = computed(() => {
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

  protected readonly anomalies = computed<AnomalyFlag[]>(() => {
    const flags: AnomalyFlag[] = [];
    const rollups = this.positionRollups();

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

  eventBucket(type: string): 'open' | 'close' | 'modify' | 'reconcile' | 'other' {
    const t = (type ?? '').toLowerCase();
    if (t === 'opened') return 'open';
    if (t.includes('close')) return 'close';
    if (t === 'modified') return 'modify';
    if (t.includes('reconcile')) return 'reconcile';
    return 'other';
  }

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
    const raw = d as unknown;
    if (raw === 'Long' || raw === 0 || raw === '0') return 'Long';
    if (raw === 'Short' || raw === 1 || raw === '1') return 'Short';
    return null;
  }

  private normaliseStatus(s: PositionLifecycleEventDto['positionStatus']): string | null {
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
