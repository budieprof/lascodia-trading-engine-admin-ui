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
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * EA signal-feedback feed (PRD-V2 FR-5.4).
 *
 * Surfaces the EA-sourced rejection/expiration audit trail: every signal
 * whose state was driven by ProcessSignalFeedbackCommand carries an
 * "EA: <Reason>" prefix on its RejectionReason. The new engine filters
 * (Statuses + RejectionReasonContains) let us pull both Rejected and
 * Expired in one query, scoped to EA-sourced rows.
 *
 * Operator use case: spot stuck or broken EAs producing pathological
 * feedback patterns (e.g. one EA producing 80% of expirations on a
 * particular symbol). The reason-aggregation card answers "what's
 * happening?" at a glance; the events table answers "give me the rows".
 */
interface ReasonBucket {
  reason: string;
  count: number;
  share: number;
  recentAt: string;
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
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Signal feedback feed"
        subtitle="EA-sourced rejection &amp; expiration events from ProcessSignalFeedback"
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
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load signal feedback"
          message="Engine returned an error. The trade-signals query may be paused — check System Health."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No EA feedback in this window"
          message="Either no EAs reported feedback, or all reported signals executed cleanly. Widen the window to look further back."
        />
      } @else {
        <div class="kpis">
          <app-metric-card label="Events" [value]="filteredRows().length.toString()" />
          <app-metric-card label="Reasons" [value]="reasonBuckets().length.toString()" />
          <app-metric-card
            label="Rejected"
            [value]="rejectedCount().toString()"
            [trend]="rejectedShare() > 0 ? (rejectedShare() * 100 | number: '1.0-0') + '%' : null"
          />
          <app-metric-card
            label="Expired"
            [value]="expiredCount().toString()"
            [trend]="expiredShare() > 0 ? (expiredShare() * 100 | number: '1.0-0') + '%' : null"
          />
        </div>

        <section class="card">
          <header class="card-head">
            <h3>Reasons</h3>
            <span class="muted small">aggregated over window</span>
          </header>
          <table class="feedback-table">
            <thead>
              <tr>
                <th>Reason</th>
                <th class="num">Count</th>
                <th class="num">Share</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              @for (b of reasonBuckets(); track b.reason) {
                <tr>
                  <td class="mono">{{ b.reason }}</td>
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
            <h3>Recent events</h3>
            <span class="muted small">{{ filteredRows().length }} shown</span>
          </header>
          <table class="feedback-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Status</th>
                <th>Reason</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              @for (s of filteredRows(); track s.id) {
                <tr>
                  <td>
                    <a class="link mono" [routerLink]="['/trade-signals', s.id]">#{{ s.id }}</a>
                  </td>
                  <td class="mono">{{ s.symbol ?? '—' }}</td>
                  <td>
                    <a class="link" [routerLink]="['/strategies', s.strategyId]">
                      #{{ s.strategyId }}
                    </a>
                  </td>
                  <td>
                    <span class="status" [attr.data-status]="s.status">{{ s.status }}</span>
                  </td>
                  <td class="reason">{{ stripEaPrefix(s.rejectionReason) }}</td>
                  <td class="time">{{ s.generatedAt | date: 'short' }}</td>
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
        gap: var(--space-4);
      }
      .controls {
        display: flex;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .control-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .control-group label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .control-group input {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        min-width: 180px;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: var(--space-3);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .feedback-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .feedback-table th,
      .feedback-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .feedback-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .feedback-table td.num,
      .feedback-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
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
        max-width: 360px;
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
        font-size: var(--text-xs);
      }
      .status {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary, var(--bg-secondary));
      }
      .status[data-status='Rejected'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .status[data-status='Expired'] {
        background: rgba(245, 158, 11, 0.15);
        color: rgb(217, 119, 6);
      }
      .bar-track {
        display: inline-block;
        width: 80px;
        height: 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
        vertical-align: middle;
        margin-right: 8px;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: #ff9500;
        border-radius: var(--radius-full);
      }
    `,
  ],
})
export class SignalFeedbackPageComponent {
  private readonly signals = inject(TradeSignalsService);

  protected readonly windowHours = signal(24);
  protected readonly symbolFilter = signal('');

  protected readonly resource = createPolledResource(
    () => {
      const since = new Date(Date.now() - this.windowHours() * 60 * 60 * 1000).toISOString();
      return this.signals
        .list({
          currentPage: 1,
          itemCountPerPage: 200,
          filter: {
            statuses: ['Rejected', 'Expired'],
            rejectionReasonContains: 'EA:',
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
      this.resource.refresh();
    });
  }

  protected readonly rows = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.rows().length === 0);

  protected readonly filteredRows = computed(() => {
    const needle = this.symbolFilter().trim().toUpperCase();
    if (!needle) return this.rows();
    return this.rows().filter((r) => (r.symbol ?? '').toUpperCase().includes(needle));
  });

  protected readonly rejectedCount = computed(
    () => this.filteredRows().filter((r) => r.status === 'Rejected').length,
  );
  protected readonly expiredCount = computed(
    () => this.filteredRows().filter((r) => r.status === 'Expired').length,
  );
  protected readonly rejectedShare = computed(() => {
    const total = this.filteredRows().length;
    return total > 0 ? this.rejectedCount() / total : 0;
  });
  protected readonly expiredShare = computed(() => {
    const total = this.filteredRows().length;
    return total > 0 ? this.expiredCount() / total : 0;
  });

  protected readonly reasonBuckets = computed<ReasonBucket[]>(() => {
    const rows = this.filteredRows();
    const total = rows.length;
    const map = new Map<string, { count: number; recentAt: string }>();
    for (const row of rows) {
      const reason = this.stripEaPrefix(row.rejectionReason).trim() || 'Unknown';
      const existing = map.get(reason);
      if (existing) {
        existing.count++;
        if (row.generatedAt > existing.recentAt) existing.recentAt = row.generatedAt;
      } else {
        map.set(reason, { count: 1, recentAt: row.generatedAt });
      }
    }
    return Array.from(map.entries())
      .map(([reason, v]) => ({
        reason,
        count: v.count,
        share: total > 0 ? v.count / total : 0,
        recentAt: v.recentAt,
      }))
      .sort((a, b) => b.count - a.count);
  });

  protected setWindow(v: number | string): void {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 168) this.windowHours.set(n);
  }

  protected stripEaPrefix(reason: string | null | undefined): string {
    if (!reason) return '';
    return reason.startsWith('EA:') ? reason.slice(3).trim() : reason;
  }
}
