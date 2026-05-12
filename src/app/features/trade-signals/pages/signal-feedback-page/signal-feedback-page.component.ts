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

import { TradeSignalsService } from '@core/services/trade-signals.service';
import type { TradeSignalDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Signal-exits feed (PRD-V2 FR-5.4 superset).
 *
 * Originally scoped narrowly to EA-sourced rejections via the "EA:"
 * RejectionReason prefix, but the engine also expires signals on its own
 * (TTL / strategy decision), and those are equally important to operators.
 * This page now surfaces ALL Rejected + Expired signals in the window and
 * classifies them by parsed source — EA / Strategy / Engine / Unknown —
 * so the EA-specific feed is still recoverable via the source filter
 * while the broader picture is the default.
 *
 * Layout matches the position-deltas operator-console style:
 *   - 8-tile compact KPI strip always rendered (zero counts visible)
 *   - Hourly activity histogram for burst detection
 *   - Notable patterns panel (rejection bursts, single-strategy dominance,
 *     symbol concentration)
 *   - By source / By reason / By symbol breakdowns
 *   - Per-strategy rollup
 *   - Recent events table enriched with strategy / direction / age
 */
type ExitSource = 'EA' | 'Strategy' | 'Engine' | 'Unknown';

interface ParsedRow extends TradeSignalDto {
  source: ExitSource;
  reasonCategory: string;
  reasonDetail: string | null;
}

interface KvBucket {
  key: string;
  count: number;
  share: number;
  recentAt: string;
}

interface StrategyRollup {
  strategyId: number;
  count: number;
  symbols: string[];
  topReason: string;
  recentAt: string;
  rejectedCount: number;
  expiredCount: number;
}

interface HourBucket {
  label: string;
  count: number;
}

interface AnomalyFlag {
  kind: 'burst' | 'strategy-dominance' | 'symbol-concentration';
  detail: string;
}

@Component({
  selector: 'app-signal-feedback-page',
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
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Signal exits"
        subtitle="Rejected & expired trade-signals — EA feedback, strategy decisions, and engine expirations"
      >
        <a routerLink="/trade-signals" class="btn btn-secondary">← Signals</a>
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
          <label for="window">Window</label>
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
          <label for="strategy">Strategy #</label>
          <input
            id="strategy"
            type="search"
            placeholder="id"
            [ngModel]="strategyFilter()"
            (ngModelChange)="strategyFilter.set($event)"
          />
        </div>
        <div class="control-group">
          <label for="status">Status</label>
          <select id="status" [ngModel]="statusFilter()" (ngModelChange)="statusFilter.set($event)">
            <option value="">all</option>
            <option value="Rejected">Rejected only</option>
            <option value="Expired">Expired only</option>
          </select>
        </div>
        <div class="control-group">
          <label for="source">Source</label>
          <select id="source" [ngModel]="sourceFilter()" (ngModelChange)="sourceFilter.set($event)">
            <option value="">all</option>
            <option value="EA">EA</option>
            <option value="Strategy">Strategy</option>
            <option value="Engine">Engine</option>
            <option value="Unknown">Unknown</option>
          </select>
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load signal exits"
          message="Engine returned an error. The trade-signal query may be paused — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- KPI strip — always rendered, zero counts visible -->
        <section class="kpi-strip" aria-label="Summary metrics">
          <div class="kpi">
            <span class="kpi-label">Events</span>
            <span class="kpi-value">{{ filteredRows().length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Rejected</span>
            <span class="kpi-value">{{ rejectedCount() }}</span>
            @if (filteredRows().length > 0) {
              <span class="kpi-trend">
                {{ (rejectedCount() / filteredRows().length) * 100 | number: '1.0-0' }}%
              </span>
            }
          </div>
          <div class="kpi">
            <span class="kpi-label">Expired</span>
            <span class="kpi-value">{{ expiredCount() }}</span>
            @if (filteredRows().length > 0) {
              <span class="kpi-trend">
                {{ (expiredCount() / filteredRows().length) * 100 | number: '1.0-0' }}%
              </span>
            }
          </div>
          <div class="kpi" [class.muted-kpi]="eaCount() === 0">
            <span class="kpi-label">EA-sourced</span>
            <span class="kpi-value">{{ eaCount() }}</span>
            @if (filteredRows().length > 0) {
              <span class="kpi-trend">
                {{ (eaCount() / filteredRows().length) * 100 | number: '1.0-0' }}%
              </span>
            }
          </div>
          <div class="kpi">
            <span class="kpi-label">Strategies</span>
            <span class="kpi-value">{{ distinctStrategies() }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Symbols</span>
            <span class="kpi-value">{{ distinctSymbols() }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Reasons</span>
            <span class="kpi-value">{{ reasonBuckets().length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Last exit</span>
            <span class="kpi-value-sm">
              @if (lastEventAt()) {
                {{ lastEventAt()! | relativeTime }}
              } @else {
                —
              }
            </span>
          </div>
        </section>

        <!-- Activity histogram + Notable patterns side-by-side -->
        <div class="row-2">
          <section class="card activity-card">
            <header class="card-head">
              <h3>Activity</h3>
              <span class="muted small">exits / hour, last {{ windowHours() }}h</span>
            </header>
            @if (filteredRows().length === 0) {
              <p class="empty-inline muted small">
                No signal exits in this window. Widen the window above or check that strategies are
                producing signals.
              </p>
            } @else {
              <div class="histogram">
                @for (h of hourBuckets(); track h.label) {
                  <div class="hist-col" [title]="h.label + ': ' + h.count + ' exits'">
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
            }
          </section>

          <section class="card patterns-card">
            <header class="card-head">
              <h3>Notable patterns</h3>
              <span class="muted small">{{ anomalies().length }} flagged</span>
            </header>
            @if (anomalies().length === 0) {
              <p class="empty-inline muted small">
                No bursts, dominance, or concentration in window.
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
          </section>
        </div>

        <!-- By source + By reason side-by-side -->
        <div class="row-2">
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
                @if (sourceBuckets().length === 0) {
                  <tr class="empty-row">
                    <td colspan="4" class="muted small">—</td>
                  </tr>
                } @else {
                  @for (b of sourceBuckets(); track b.key) {
                    <tr>
                      <td>
                        <span class="src-pill" [attr.data-source]="b.key">{{ b.key }}</span>
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
                }
              </tbody>
            </table>
          </section>

          <section class="card">
            <header class="card-head">
              <h3>By reason</h3>
              <span class="muted small">{{ reasonBuckets().length }} distinct</span>
            </header>
            <table class="deltas-table compact">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th class="num">N</th>
                  <th class="num">Share</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                @if (reasonBuckets().length === 0) {
                  <tr class="empty-row">
                    <td colspan="4" class="muted small">—</td>
                  </tr>
                } @else {
                  @for (b of reasonBuckets(); track b.key) {
                    <tr>
                      <td class="mono small">{{ b.key }}</td>
                      <td class="num">{{ b.count }}</td>
                      <td class="num">
                        <span class="bar-track">
                          <span class="bar-fill amber" [style.width.%]="b.share * 100"></span>
                        </span>
                        <span class="small muted">{{ b.share * 100 | number: '1.0-0' }}%</span>
                      </td>
                      <td class="time">{{ b.recentAt | relativeTime }}</td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </section>
        </div>

        <!-- By symbol breakdown -->
        <section class="card">
          <header class="card-head">
            <h3>By symbol</h3>
            <span class="muted small">{{ symbolBuckets().length }} touched</span>
          </header>
          <table class="deltas-table compact">
            <thead>
              <tr>
                <th>Symbol</th>
                <th class="num">N</th>
                <th class="num">Share</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              @if (symbolBuckets().length === 0) {
                <tr class="empty-row">
                  <td colspan="4" class="muted small">—</td>
                </tr>
              } @else {
                @for (b of symbolBuckets(); track b.key) {
                  <tr>
                    <td class="mono">{{ b.key }}</td>
                    <td class="num">{{ b.count }}</td>
                    <td class="num">
                      <span class="bar-track">
                        <span class="bar-fill green" [style.width.%]="b.share * 100"></span>
                      </span>
                      <span class="small muted">{{ b.share * 100 | number: '1.0-0' }}%</span>
                    </td>
                    <td class="time">{{ b.recentAt | relativeTime }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </section>

        <!-- By strategy rollup -->
        <section class="card">
          <header class="card-head">
            <h3>By strategy</h3>
            <span class="muted small">{{ strategyRollups().length }} touched</span>
          </header>
          <table class="deltas-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Symbols</th>
                <th class="num">Rejected</th>
                <th class="num">Expired</th>
                <th class="num">Total</th>
                <th>Top reason</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              @if (strategyRollups().length === 0) {
                <tr class="empty-row">
                  <td colspan="7" class="muted small">—</td>
                </tr>
              } @else {
                @for (r of strategyRollups(); track r.strategyId) {
                  <tr>
                    <td>
                      <a class="link mono" [routerLink]="['/strategies', r.strategyId]"
                        >#{{ r.strategyId }}</a
                      >
                    </td>
                    <td>
                      <div class="symbol-chips">
                        @for (s of r.symbols; track s) {
                          <span class="mono small chip">{{ s }}</span>
                        }
                      </div>
                    </td>
                    <td class="num">{{ r.rejectedCount }}</td>
                    <td class="num">{{ r.expiredCount }}</td>
                    <td class="num">{{ r.count }}</td>
                    <td class="reason small">{{ r.topReason }}</td>
                    <td class="time">{{ r.recentAt | relativeTime }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </section>

        <!-- Recent events table -->
        <section class="card">
          <header class="card-head">
            <h3>Recent events</h3>
            <span class="muted small">{{ filteredRows().length }} shown</span>
          </header>
          <table class="deltas-table compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Signal</th>
                <th>Symbol</th>
                <th>Dir</th>
                <th>Strategy</th>
                <th>Status</th>
                <th>Source</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              @if (filteredRows().length === 0) {
                <tr class="empty-row">
                  <td colspan="8" class="muted small">
                    No exits in window — adjust filters or widen the window.
                  </td>
                </tr>
              } @else {
                @for (s of filteredRows(); track s.id) {
                  <tr>
                    <td class="time" [title]="s.generatedAt">
                      {{ s.generatedAt | date: 'HH:mm:ss' }}
                    </td>
                    <td>
                      <a class="link mono" [routerLink]="['/trade-signals', s.id]">#{{ s.id }}</a>
                    </td>
                    <td class="mono">{{ s.symbol ?? '—' }}</td>
                    <td>
                      <span class="dir-pill" [attr.data-dir]="s.direction">{{ s.direction }}</span>
                    </td>
                    <td>
                      <a class="link" [routerLink]="['/strategies', s.strategyId]"
                        >#{{ s.strategyId }}</a
                      >
                    </td>
                    <td>
                      <span class="status" [attr.data-status]="s.status">{{ s.status }}</span>
                    </td>
                    <td>
                      <span class="src-pill" [attr.data-source]="s.source">{{ s.source }}</span>
                    </td>
                    <td class="reason small">{{ s.reasonDetail || s.reasonCategory }}</td>
                  </tr>
                }
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
      .window-presets {
        display: flex;
        gap: 2px;
      }
      .preset {
        padding: 4px 10px;
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

      /* ── KPI strip ───────────────────────────────────────────────── */
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
      .kpi.muted-kpi {
        opacity: 0.55;
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

      /* ── Layout rows ───────────────────────────────────────────── */
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

      /* ── Cards ────────────────────────────────────────────────── */
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
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
      .empty-inline {
        margin: 0;
        padding: var(--space-2) 0;
      }

      /* ── Histogram ────────────────────────────────────────────── */
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

      /* ── Anomaly list ─────────────────────────────────────────── */
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
      .anomaly[data-kind='burst'] {
        background: rgba(239, 68, 68, 0.08);
      }
      .anomaly[data-kind='strategy-dominance'] {
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

      /* ── Tables ────────────────────────────────────────────────── */
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
      .empty-row td {
        text-align: center;
        padding: var(--space-3) !important;
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
      .reason {
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
      .symbol-chips {
        display: flex;
        gap: 3px;
        flex-wrap: wrap;
      }
      .chip {
        background: var(--bg-tertiary);
        padding: 1px 5px;
        border-radius: 3px;
        color: var(--text-secondary);
      }

      /* ── Pills ─────────────────────────────────────────────────── */
      .status {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
      }
      .status[data-status='Rejected'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .status[data-status='Expired'] {
        background: rgba(245, 158, 11, 0.15);
        color: rgb(217, 119, 6);
      }
      .dir-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
      }
      .dir-pill[data-dir='Buy'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
      }
      .dir-pill[data-dir='Sell'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .src-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
      }
      .src-pill[data-source='EA'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
      }
      .src-pill[data-source='Strategy'] {
        background: rgba(245, 158, 11, 0.15);
        color: rgb(217, 119, 6);
      }
      .src-pill[data-source='Engine'] {
        background: rgba(59, 130, 246, 0.15);
        color: rgb(37, 99, 235);
      }
      .src-pill[data-source='Unknown'] {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }

      /* ── Share bars ───────────────────────────────────────────── */
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
        background: #9b59b6;
        border-radius: var(--radius-full);
      }
      .bar-fill.amber {
        background: #ff9500;
      }
      .bar-fill.green {
        background: #22c55e;
      }
    `,
  ],
})
export class SignalFeedbackPageComponent {
  private readonly signals = inject(TradeSignalsService);

  // Preset windows that double as quick switches (1h / 6h / 24h / 3d / 7d).
  protected readonly windowPresets = [1, 6, 24, 72, 168];
  protected readonly windowHours = signal(24);
  protected readonly symbolFilter = signal('');
  protected readonly strategyFilter = signal('');
  protected readonly statusFilter = signal('');
  protected readonly sourceFilter = signal('');

  protected readonly resource = createPolledResource(
    () => {
      const since = new Date(Date.now() - this.windowHours() * 60 * 60 * 1000).toISOString();
      // Status filter is engine-side when the operator picks one specific
      // status, otherwise we ask for both Rejected and Expired in one shot.
      const status = this.statusFilter();
      const statusFilter = status ? { status } : { statuses: ['Rejected', 'Expired'] };
      return this.signals
        .list({
          currentPage: 1,
          itemCountPerPage: 200,
          filter: {
            ...statusFilter,
            from: since,
          },
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<TradeSignalDto[]>([])),
        );
    },
    { intervalMs: 30_000 },
  );

  constructor() {
    effect(() => {
      this.windowHours();
      this.statusFilter();
      this.resource.refresh();
    });
  }

  protected readonly rawRows = computed(() => this.resource.value() ?? []);

  // Parse RejectionReason once per row into source + category + detail.
  protected readonly parsedRows = computed<ParsedRow[]>(() =>
    this.rawRows().map((r) => {
      const { source, category, detail } = this.classify(r);
      return { ...r, source, reasonCategory: category, reasonDetail: detail };
    }),
  );

  protected readonly filteredRows = computed(() => {
    const sym = this.symbolFilter().trim().toUpperCase();
    const strat = this.strategyFilter().trim();
    const stratId = strat ? Number(strat) : NaN;
    const src = this.sourceFilter();
    return this.parsedRows().filter((r) => {
      if (sym && !(r.symbol ?? '').toUpperCase().includes(sym)) return false;
      if (!isNaN(stratId) && r.strategyId !== stratId) return false;
      if (src && r.source !== src) return false;
      return true;
    });
  });

  protected readonly loading = computed(
    () => this.resource.loading() && this.rawRows().length === 0,
  );

  protected readonly rejectedCount = computed(
    () => this.filteredRows().filter((r) => r.status === 'Rejected').length,
  );
  protected readonly expiredCount = computed(
    () => this.filteredRows().filter((r) => r.status === 'Expired').length,
  );
  protected readonly eaCount = computed(
    () => this.filteredRows().filter((r) => r.source === 'EA').length,
  );
  protected readonly distinctStrategies = computed(
    () => new Set(this.filteredRows().map((r) => r.strategyId)).size,
  );
  protected readonly distinctSymbols = computed(
    () => new Set(this.filteredRows().map((r) => r.symbol ?? '—')).size,
  );

  protected readonly lastEventAt = computed(() => {
    const rows = this.filteredRows();
    if (rows.length === 0) return null;
    return rows.reduce(
      (max, r) => (r.generatedAt > max ? r.generatedAt : max),
      rows[0].generatedAt,
    );
  });

  protected readonly sourceBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.filteredRows(), (r) => r.source),
  );

  protected readonly reasonBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.filteredRows(), (r) => r.reasonCategory),
  );

  protected readonly symbolBuckets = computed<KvBucket[]>(() =>
    this.bucketize(this.filteredRows(), (r) => r.symbol ?? '—'),
  );

  protected readonly strategyRollups = computed<StrategyRollup[]>(() => {
    const rows = this.filteredRows();
    const byStrat = new Map<number, ParsedRow[]>();
    for (const r of rows) {
      const list = byStrat.get(r.strategyId) ?? [];
      list.push(r);
      byStrat.set(r.strategyId, list);
    }
    const rollups: StrategyRollup[] = [];
    for (const [strategyId, events] of byStrat.entries()) {
      events.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
      const symbols = Array.from(new Set(events.map((e) => e.symbol ?? '—')));
      const reasonCounts = new Map<string, number>();
      for (const e of events) {
        reasonCounts.set(e.reasonCategory, (reasonCounts.get(e.reasonCategory) ?? 0) + 1);
      }
      const topReason =
        Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      rollups.push({
        strategyId,
        count: events.length,
        symbols,
        topReason,
        recentAt: events[0].generatedAt,
        rejectedCount: events.filter((e) => e.status === 'Rejected').length,
        expiredCount: events.filter((e) => e.status === 'Expired').length,
      });
    }
    return rollups.sort((a, b) => b.count - a.count);
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
      const t = new Date(r.generatedAt).getTime();
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
    const rows = this.filteredRows();
    if (rows.length === 0) return flags;

    // Burst: any hour with more than 3× the average.
    const buckets = this.hourBuckets();
    const avg = this.avgHour();
    if (avg > 0) {
      const burst = buckets.reduce((max, b) => (b.count > max.count ? b : max), buckets[0]);
      if (burst.count >= 5 && burst.count > avg * 3) {
        flags.push({
          kind: 'burst',
          detail: `${burst.count} exits in one hour around ${burst.label}Z (~${(burst.count / avg).toFixed(1)}× window avg).`,
        });
      }
    }

    // Strategy dominance: one strategy responsible for ≥ 60% of all exits
    // when there's enough data (≥ 5 events total) for the signal to matter.
    if (rows.length >= 5) {
      const top = this.strategyRollups()[0];
      if (top && top.count / rows.length >= 0.6) {
        flags.push({
          kind: 'strategy-dominance',
          detail: `Strategy #${top.strategyId} produced ${top.count} of ${rows.length} exits (${((top.count / rows.length) * 100).toFixed(0)}%).`,
        });
      }
    }

    // Symbol concentration: one symbol with ≥ 70% of exits.
    if (rows.length >= 5) {
      const topSym = this.symbolBuckets()[0];
      if (topSym && topSym.share >= 0.7) {
        flags.push({
          kind: 'symbol-concentration',
          detail: `${topSym.key} accounts for ${topSym.count} of ${rows.length} exits (${(topSym.share * 100).toFixed(0)}%).`,
        });
      }
    }

    return flags;
  });

  anomalyLabel(kind: AnomalyFlag['kind']): string {
    switch (kind) {
      case 'burst':
        return 'BURST';
      case 'strategy-dominance':
        return 'STRAT';
      case 'symbol-concentration':
        return 'SYMBOL';
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  // Bucket rows by a key extractor → KvBucket[]. Reused for source/reason/symbol.
  private bucketize<T>(rows: T[], getKey: (r: T) => string): KvBucket[] {
    const total = rows.length;
    const recentByRow = (r: T) => (r as unknown as { generatedAt: string }).generatedAt;
    const map = new Map<string, { count: number; recentAt: string }>();
    for (const r of rows) {
      const k = getKey(r);
      const recent = recentByRow(r);
      const existing = map.get(k);
      if (existing) {
        existing.count++;
        if (recent > existing.recentAt) existing.recentAt = recent;
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

  // Classify a TradeSignal into source + reason category + detail. RejectionReason
  // formats observed in the wild:
  //   "EA: <Reason> - <Detail>"          → source=EA
  //   "Strategy: <Reason>"               → source=Strategy
  //   ""                                  → engine-internal expiration (status=Expired)
  //   "<anything else>"                   → engine internal w/ reason
  private classify(r: TradeSignalDto): {
    source: ExitSource;
    category: string;
    detail: string | null;
  } {
    const raw = (r.rejectionReason ?? '').trim();
    if (raw.startsWith('EA:')) {
      const rest = raw.slice(3).trim();
      const sepIdx = rest.indexOf(' - ');
      if (sepIdx >= 0) {
        return {
          source: 'EA',
          category: rest.slice(0, sepIdx).trim(),
          detail: rest.slice(sepIdx + 3).trim(),
        };
      }
      return { source: 'EA', category: rest || 'unspecified', detail: null };
    }
    if (raw.startsWith('Strategy:')) {
      return { source: 'Strategy', category: raw.slice(9).trim() || 'unspecified', detail: null };
    }
    if (raw === '') {
      // Empty reason on an Expired signal = engine TTL / scheduled cleanup.
      // Empty on a Rejected signal = something rejected it without leaving a note (rare).
      return {
        source: 'Engine',
        category: r.status === 'Expired' ? 'TTL expiration' : 'no reason recorded',
        detail: null,
      };
    }
    return { source: 'Unknown', category: raw, detail: null };
  }
}
