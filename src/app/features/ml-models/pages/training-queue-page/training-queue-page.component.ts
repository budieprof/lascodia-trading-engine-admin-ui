import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type { ActiveMLTrainingRunDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { NotificationService } from '@core/notifications/notification.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Live snapshot of every Queued/Running ML training run. Powered by
 * `GET /ml-model/training/queue` — a flat list with no pagination because the
 * active set is bounded by the per-pair active-run unique index. Polled at
 * 15s so the queue age stays fresh without hammering the engine.
 *
 * Operator surface for two recurring questions:
 *   "Why hasn't pair X started training yet?" → look at `Queued for` age.
 *   "Is MLTrainingWorker actually doing anything?" → look at the running-row
 *   count + `Running for` age (zero running + non-zero queued = worker stuck
 *   or gated off via Workers:MLTrainingWorker:Enabled).
 */
@Component({
  selector: 'app-training-queue-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
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
        title="ML — Training Queue"
        subtitle="Live snapshot of every Queued or Running training run"
      >
        <a routerLink="/ml-models" class="btn btn-secondary">← ML Models</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load training queue"
          message="Engine returned an error fetching the active runs. Verify the engine is reachable."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Total active"
            [value]="runs().length"
            format="number"
            [dotColor]="runs().length > 0 ? '#0A84FF' : '#34C759'"
          />
          <app-metric-card
            label="Queued (no worker)"
            [value]="queuedCount()"
            format="number"
            [dotColor]="queuedCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Running"
            [value]="runningCount()"
            format="number"
            [dotColor]="runningCount() > 0 ? '#34C759' : '#8E8E93'"
          />
          <!-- Custom text tile — MetricCard is numeric-only and the queue age
               is a human-readable duration string ("3.2h", "1.4d"). -->
          <div class="text-metric" [class.warn]="oldestQueueWarning()">
            <div class="text-metric-label">
              <span
                class="dot"
                [style.background]="oldestQueueWarning() ? '#FF3B30' : '#8E8E93'"
              ></span>
              Oldest queue age
            </div>
            <div class="text-metric-value">{{ oldestQueueAge() }}</div>
          </div>
        </section>

        @if (runs().length === 0) {
          <app-empty-state
            title="Nothing queued or running"
            description="No active training runs. Trigger one from the ML Models page or wait for an auto-degrading retrain."
          />
        } @else {
          <section class="card">
            <table class="queue-table">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Pair</th>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Architecture</th>
                  <th>Queued</th>
                  <th>Running</th>
                  <th class="num">Attempts</th>
                  <th>Last error</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr
                    [class.is-queued]="r.status === 'Queued'"
                    [class.is-running]="r.status === 'Running'"
                    [class.is-cancel-pending]="r.cancelRequested"
                  >
                    <td class="mono">#{{ r.id }}</td>
                    <td>
                      <span class="mono symbol">{{ r.symbol }}</span>
                      <span class="muted small"> · {{ r.timeframe }}</span>
                    </td>
                    <td>
                      <span class="chip" [attr.data-state]="r.status.toLowerCase()">
                        {{ r.status }}
                      </span>
                      @if (r.cancelRequested) {
                        <span class="chip cancel-chip" title="Cancel requested by operator"
                          >cancel pending</span
                        >
                      }
                    </td>
                    <td class="mono small">{{ r.triggerType }}</td>
                    <td class="mono small">{{ r.learnerArchitecture }}</td>
                    <td class="time" [title]="r.startedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ r.startedAt | relativeTime }}
                    </td>
                    <td
                      class="time"
                      [title]="r.pickedUpAt ? (r.pickedUpAt | date: 'yyyy-MM-dd HH:mm:ss UTC') : ''"
                    >
                      @if (r.pickedUpAt) {
                        {{ r.pickedUpAt | relativeTime }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">{{ r.attemptCount }}/{{ r.maxAttempts }}</td>
                    <td class="reason">
                      @if (r.errorMessage) {
                        <span [title]="r.errorMessage">{{ truncate(r.errorMessage, 80) }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn btn-xs btn-secondary"
                        (click)="cancel(r)"
                        [disabled]="r.cancelRequested || cancelling().has(r.id)"
                        title="Cancel this training run"
                      >
                        {{ cancelling().has(r.id) ? 'Cancelling…' : 'Cancel' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
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
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
      }
      .text-metric {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 90px;
        justify-content: center;
      }
      .text-metric-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        gap: 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .text-metric-label .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      .text-metric-value {
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .text-metric.warn .text-metric-value {
        color: #d70015;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .queue-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .queue-table th,
      .queue-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .queue-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .queue-table td.num,
      .queue-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .queue-table tr.is-running {
        background: rgba(52, 199, 89, 0.05);
      }
      .queue-table tr.is-queued td:first-child {
        border-left: 3px solid #ff9500;
        padding-left: 8px;
      }
      .queue-table tr.is-running td:first-child {
        border-left: 3px solid #34c759;
        padding-left: 8px;
      }
      .queue-table tr.is-cancel-pending {
        opacity: 0.65;
      }
      .symbol {
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .reason {
        max-width: 360px;
        color: var(--text-secondary);
        word-break: break-word;
        font-size: var(--text-xs);
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        white-space: nowrap;
      }
      .chip {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .chip[data-state='running'] {
        background: rgba(52, 199, 89, 0.15);
        color: #34c759;
      }
      .chip[data-state='queued'] {
        background: rgba(255, 149, 0, 0.15);
        color: #ff9500;
      }
      .chip.cancel-chip {
        margin-left: 6px;
        background: rgba(255, 59, 48, 0.1);
        color: #d70015;
      }
      .actions {
        text-align: right;
        white-space: nowrap;
      }
      .btn-xs {
        padding: 4px 10px;
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class TrainingQueuePageComponent {
  private readonly ml = inject(MLModelsService);
  private readonly notifications = inject(NotificationService);

  protected readonly resource = createPolledResource(
    () =>
      this.ml.listActiveTrainingRuns().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<ActiveMLTrainingRunDto[]>([])),
      ),
    { intervalMs: 15_000 },
  );

  protected readonly runs = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.runs().length === 0);
  protected readonly queuedCount = computed(
    () => this.runs().filter((r) => r.status === 'Queued').length,
  );
  protected readonly runningCount = computed(
    () => this.runs().filter((r) => r.status === 'Running').length,
  );

  /**
   * Oldest queue age across the active set, rendered as a relative string.
   * Used both for the "Oldest queue age" KPI tile and to drive the warning
   * colour when it exceeds 6h — the empirical threshold above which the
   * operator should investigate (worker gated off, pair stuck on quality
   * gate, etc.).
   */
  protected readonly oldestQueueAge = computed(() => {
    const arr = this.runs();
    if (arr.length === 0) return '—';
    const oldestMs = Math.min(...arr.map((r) => new Date(r.startedAt).getTime()));
    const ageS = Math.max(0, (Date.now() - oldestMs) / 1000);
    return this.formatDuration(ageS);
  });
  protected readonly oldestQueueWarning = computed(() => {
    const arr = this.runs();
    if (arr.length === 0) return false;
    const oldestMs = Math.min(...arr.map((r) => new Date(r.startedAt).getTime()));
    return Date.now() - oldestMs > 6 * 60 * 60 * 1000; // > 6h
  });

  protected readonly cancelling = signal<Set<number>>(new Set());

  protected cancel(run: ActiveMLTrainingRunDto): void {
    if (!confirm(`Cancel training run #${run.id} (${run.symbol} / ${run.timeframe})?`)) return;

    const pending = new Set(this.cancelling());
    pending.add(run.id);
    this.cancelling.set(pending);

    this.ml.cancelTraining(run.id).subscribe({
      next: (res) => {
        const next = new Set(this.cancelling());
        next.delete(run.id);
        this.cancelling.set(next);
        if (res?.status === true) {
          this.notifications.success(`Cancelled training run #${run.id}`);
          this.resource.refresh();
        } else {
          this.notifications.error(res?.message ?? 'Cancel request failed');
        }
      },
      error: () => {
        const next = new Set(this.cancelling());
        next.delete(run.id);
        this.cancelling.set(next);
        this.notifications.error('Failed to cancel the training run');
      },
    });
  }

  protected truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const hours = seconds / 3600;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  }
}
