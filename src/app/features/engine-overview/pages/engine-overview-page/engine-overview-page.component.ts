import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, forkJoin, interval, of, startWith } from 'rxjs';

import { HealthService } from '@core/services/health.service';
import { WorkersService } from '@core/services/workers.service';
import { DeadLetterService } from '@core/services/dead-letter.service';
import type { DeadLetterDto, EngineStatusDto, WorkerHealthDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * One-screen engine health summary. Two presentation modes:
 *
 *   * **Compact** (default) — fits inside the standard layout chrome, used
 *     for desk monitoring while doing other work.
 *   * **Wall** (`?wall=1` or the toggle button) — densifies + scales for
 *     readability across a NOC. Requests browser fullscreen, hides the
 *     subtitle, scales numbers ~3×, and pushes the worker + DLQ panels into
 *     a 12-column grid that fills the viewport.
 *
 * Polls every 10s — cheaper than per-event push because all three sources
 * change continuously and a slightly-stale view is fine for a quick glance.
 * The deeper per-area pages stay where they were for drill-down.
 */
@Component({
  selector: 'app-engine-overview-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, CardSkeletonComponent, EmptyStateComponent, RelativeTimePipe],
  template: `
    <div class="page" [class.wall]="wallMode()">
      @if (!wallMode()) {
        <app-page-header
          title="Engine Overview"
          subtitle="Live status, worker health, and unresolved dead-letters at a glance"
        >
          <button type="button" class="btn-secondary" (click)="enterWallMode()">
            Wall display →
          </button>
        </app-page-header>
      } @else {
        <header class="wall-bar">
          <h1>Engine Overview</h1>
          <div class="wall-meta">
            @if (lastRefreshAt(); as t) {
              <span class="refresh">⟳ {{ t | relativeTime }}</span>
            }
            <button type="button" class="btn-ghost" (click)="exitWallMode()">Exit</button>
          </div>
        </header>
      }

      @if (loading() && !status()) {
        <app-card-skeleton [lines]="6" />
      } @else {
        <!-- Engine status row -->
        <section class="row status-row">
          <div class="status-card" [attr.data-running]="status()?.isRunning ? '1' : '0'">
            <div class="status-dot"></div>
            <div class="status-text">
              <span class="status-label">Engine</span>
              <span class="status-value">
                {{ status()?.isRunning ? 'Running' : 'Stopped' }}
              </span>
              @if (status()?.checkedAt) {
                <span class="status-meta">checked {{ status()!.checkedAt | relativeTime }}</span>
              }
            </div>
          </div>
          <div class="kpi">
            <span class="label">Active strategies</span>
            <span class="value">{{ status()?.activeStrategies ?? '—' }}</span>
          </div>
          <div class="kpi">
            <span class="label">Open positions</span>
            <span class="value">{{ status()?.openPositions ?? '—' }}</span>
          </div>
          <div class="kpi">
            <span class="label">Pending orders</span>
            <span class="value">{{ status()?.pendingOrders ?? '—' }}</span>
          </div>
          <div class="kpi">
            <span class="label">Paper mode</span>
            <span class="value">{{ status()?.paperMode ?? '—' }}</span>
          </div>
        </section>

        <!-- Worker health row -->
        <section class="row">
          <div class="panel">
            <header class="panel-head">
              <h3>Workers</h3>
              <button type="button" class="link" (click)="goWorkers()">View all →</button>
            </header>
            <div class="worker-totals">
              <div class="bucket" data-bucket="healthy">
                <span class="bucket-count">{{ workerCounts().Healthy }}</span>
                <span class="bucket-label">Healthy</span>
              </div>
              <div class="bucket" data-bucket="degraded">
                <span class="bucket-count">{{ workerCounts().Degraded }}</span>
                <span class="bucket-label">Degraded</span>
              </div>
              <div class="bucket" data-bucket="failed">
                <span class="bucket-count">{{ workerCounts().Failed }}</span>
                <span class="bucket-label">Failed</span>
              </div>
              <div class="bucket" data-bucket="idle">
                <span class="bucket-count">{{ workerCounts().Idle }}</span>
                <span class="bucket-label">Idle</span>
              </div>
            </div>
            @if (worstWorkers().length > 0) {
              <ul class="worker-list">
                @for (w of worstWorkers(); track w.name) {
                  <li class="worker-item" [attr.data-status]="w.status.toLowerCase()">
                    <span class="status-pill">{{ w.status }}</span>
                    <span class="worker-name">{{ w.name }}</span>
                    @if (w.lastMessage) {
                      <span class="worker-msg" [title]="w.lastMessage">{{ w.lastMessage }}</span>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="muted small">All workers reporting healthy.</p>
            }
          </div>

          <!-- Dead-letter row -->
          <div class="panel">
            <header class="panel-head">
              <h3>Dead-letter queue</h3>
              <button type="button" class="link" (click)="goDeadLetters()">View all →</button>
            </header>
            @if (deadLetters().length === 0) {
              <app-empty-state
                title="Queue clean"
                description="No unresolved dead-letter rows in the last 25 events."
              />
            } @else {
              <ul class="dlq-list">
                @for (d of deadLetters(); track d.id) {
                  <li class="dlq-item">
                    <span class="dlq-type">{{ d.eventType ?? 'unknown' }}</span>
                    <span class="dlq-attempts">×{{ d.attemptCount }}</span>
                    <span class="muted small">{{ d.createdAt | relativeTime }}</span>
                  </li>
                }
              </ul>
            }
          </div>
        </section>
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

      /* ── Wall display mode ─────────────────────────────────────── */
      .page.wall {
        padding: var(--space-3) var(--space-4);
        gap: var(--space-3);
        background: var(--bg-primary);
        min-height: 100vh;
      }
      .wall-bar {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding-bottom: var(--space-2);
        border-bottom: 1px solid var(--border);
      }
      .wall-bar h1 {
        margin: 0;
        font-size: 2rem;
        font-weight: var(--font-semibold);
        letter-spacing: -0.01em;
      }
      .wall-meta {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .refresh {
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        border-radius: var(--radius-full);
        padding: 4px 14px;
        cursor: pointer;
        font-size: var(--text-sm);
      }

      .btn-secondary {
        height: 32px;
        padding: 0 var(--space-3);
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        color: var(--text-primary);
        border-radius: var(--radius-full);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .btn-secondary:hover {
        background: var(--bg-secondary);
        border-color: var(--accent);
      }

      .row {
        display: grid;
        gap: var(--space-4);
      }
      .status-row {
        grid-template-columns: minmax(220px, 1.4fr) repeat(4, 1fr);
      }
      .row:not(.status-row) {
        grid-template-columns: 1fr 1fr;
      }
      @media (max-width: 900px) {
        .status-row {
          grid-template-columns: repeat(2, 1fr);
        }
        .row:not(.status-row) {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 560px) {
        .status-row {
          grid-template-columns: 1fr;
        }
      }
      /* Wall keeps the dense grid even on narrow viewports — operators
         project this onto large screens so the smallest source viewport
         is still wide. */
      .page.wall .status-row {
        grid-template-columns: minmax(280px, 1.6fr) repeat(4, 1fr);
        gap: var(--space-3);
      }

      .status-card {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .status-card[data-running='1'] {
        border-color: rgba(52, 199, 89, 0.4);
        background: rgba(52, 199, 89, 0.06);
      }
      .status-card[data-running='0'] {
        border-color: rgba(255, 59, 48, 0.4);
        background: rgba(255, 59, 48, 0.06);
      }
      .status-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #636366;
      }
      .page.wall .status-dot {
        width: 32px;
        height: 32px;
      }
      .status-card[data-running='1'] .status-dot {
        background: #34c759;
        box-shadow: 0 0 0 4px rgba(52, 199, 89, 0.15);
      }
      .page.wall .status-card[data-running='1'] .status-dot {
        box-shadow: 0 0 0 8px rgba(52, 199, 89, 0.18);
        animation: pulse-green 2s ease-in-out infinite;
      }
      .status-card[data-running='0'] .status-dot {
        background: #ff3b30;
      }
      .page.wall .status-card[data-running='0'] .status-dot {
        animation: pulse-red 1s ease-in-out infinite;
      }
      @keyframes pulse-green {
        0%,
        100% {
          box-shadow: 0 0 0 8px rgba(52, 199, 89, 0.18);
        }
        50% {
          box-shadow: 0 0 0 14px rgba(52, 199, 89, 0.06);
        }
      }
      @keyframes pulse-red {
        0%,
        100% {
          box-shadow: 0 0 0 8px rgba(255, 59, 48, 0.25);
        }
        50% {
          box-shadow: 0 0 0 14px rgba(255, 59, 48, 0.08);
        }
      }
      .status-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .status-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .page.wall .status-label {
        font-size: var(--text-base);
      }
      .status-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .page.wall .status-value {
        font-size: 3rem;
        line-height: 1;
        letter-spacing: -0.02em;
      }
      .status-meta {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .page.wall .status-meta {
        font-size: var(--text-sm);
      }

      .kpi {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .page.wall .label {
        font-size: var(--text-sm);
      }
      .value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .page.wall .value {
        font-size: 3.4rem;
        line-height: 1;
        letter-spacing: -0.02em;
      }

      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .page.wall .panel-head h3 {
        font-size: 1.4rem;
      }
      .link {
        font-size: var(--text-sm);
        color: var(--accent);
        cursor: pointer;
        background: none;
        border: none;
        padding: 0;
        font-family: inherit;
      }
      .link:hover {
        text-decoration: underline;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-sm);
      }

      .worker-totals {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-2);
      }
      .bucket {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: var(--space-2) var(--space-1);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .bucket[data-bucket='healthy'] {
        color: #248a3d;
      }
      .bucket[data-bucket='degraded'] {
        color: #c93400;
      }
      .bucket[data-bucket='failed'] {
        color: #d70015;
      }
      .bucket[data-bucket='idle'] {
        color: #636366;
      }
      .bucket-count {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .page.wall .bucket-count {
        font-size: 3rem;
        line-height: 1;
      }
      .bucket-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .page.wall .bucket-label {
        font-size: var(--text-sm);
      }

      .worker-list,
      .dlq-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .worker-item {
        display: grid;
        grid-template-columns: 80px 1fr;
        gap: var(--space-2);
        padding: 6px 8px;
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .page.wall .worker-item {
        grid-template-columns: 110px 1fr;
        font-size: var(--text-base);
        padding: 8px 12px;
      }
      .worker-msg {
        grid-column: 2;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px 6px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .page.wall .status-pill {
        font-size: var(--text-sm);
        padding: 4px 10px;
      }
      .worker-item[data-status='degraded'] .status-pill {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .worker-item[data-status='failed'] .status-pill {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .worker-item[data-status='idle'] .status-pill {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .worker-name {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .page.wall .worker-name {
        font-size: var(--text-sm);
      }

      .dlq-item {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 6px 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
      }
      .page.wall .dlq-item {
        padding: 8px 12px;
        font-size: var(--text-base);
      }
      .dlq-type {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-primary);
        flex: 1;
      }
      .page.wall .dlq-type {
        font-size: var(--text-sm);
      }
      .dlq-attempts {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: #c93400;
      }
      .page.wall .dlq-attempts {
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class EngineOverviewPageComponent {
  private readonly health = inject(HealthService);
  private readonly workers = inject(WorkersService);
  private readonly deadLetterSvc = inject(DeadLetterService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly status = signal<EngineStatusDto | null>(null);
  readonly workerSnapshots = signal<WorkerHealthDto[]>([]);
  readonly deadLetters = signal<DeadLetterDto[]>([]);
  readonly lastRefreshAt = signal<string | null>(null);

  /** Toggled via `?wall=1` query param or the in-page button. */
  readonly wallMode = signal(this.route.snapshot.queryParamMap.get('wall') === '1');

  readonly workerCounts = computed(() => {
    const buckets = { Healthy: 0, Degraded: 0, Failed: 0, Idle: 0 };
    for (const w of this.workerSnapshots()) {
      if (w.status in buckets) buckets[w.status as keyof typeof buckets]++;
    }
    return buckets;
  });

  readonly worstWorkers = computed(() => {
    const order: Record<string, number> = { Failed: 0, Degraded: 1, Idle: 2, Healthy: 3 };
    // Wall mode shows more rows because the screen is bigger and a NOC
    // operator scanning from across the room benefits from seeing every
    // unhealthy worker, not just the top 6.
    const cap = this.wallMode() ? 12 : 6;
    return this.workerSnapshots()
      .filter((w) => w.status !== 'Healthy')
      .sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99))
      .slice(0, cap);
  });

  constructor() {
    interval(10_000)
      .pipe(startWith(0), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
  }

  protected goWorkers(): void {
    this.router.navigate(['/worker-health']);
  }

  protected goDeadLetters(): void {
    this.router.navigate(['/dead-letter']);
  }

  /**
   * Enter wall mode: flip the signal, push `?wall=1` so reloads stick, and
   * request browser fullscreen so the chrome/sidebar disappear. Fullscreen
   * may be denied (cross-origin iframe, missing user gesture) — fail soft,
   * the CSS densification still applies.
   */
  protected enterWallMode(): void {
    this.wallMode.set(true);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { wall: 1 },
      queryParamsHandling: 'merge',
    });
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        /* User gesture missing or denied — wall mode still works without it. */
      });
    }
  }

  protected exitWallMode(): void {
    this.wallMode.set(false);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { wall: null },
      queryParamsHandling: 'merge',
    });
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
  }

  private refresh(): void {
    forkJoin({
      status: this.health.getStatus().pipe(catchError(() => of(null))),
      workers: this.workers.list().pipe(catchError(() => of(null))),
      deadLetters: this.deadLetterSvc
        .list({ currentPage: 1, itemCountPerPage: 25, filter: { isResolved: false } })
        .pipe(catchError(() => of(null))),
    }).subscribe(({ status, workers, deadLetters }) => {
      if (status?.data) this.status.set(status.data);
      if (workers?.data) this.workerSnapshots.set(workers.data);
      if (deadLetters?.data) this.deadLetters.set(deadLetters.data.data ?? []);
      this.lastRefreshAt.set(new Date().toISOString());
      this.loading.set(false);
    });
  }
}
