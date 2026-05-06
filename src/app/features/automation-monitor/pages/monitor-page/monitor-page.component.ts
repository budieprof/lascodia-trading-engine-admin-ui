import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { EMPTY, forkJoin, interval, of, startWith } from 'rxjs';
import { catchError, filter, switchMap, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { ResponseData, PagedData } from '@core/api/api.types';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { BacktestsService } from '@core/services/backtests.service';
import { MLModelsService } from '@core/services/ml-models.service';
import type {
  StrategyDto,
  OptimizationRunDto,
  BacktestRunDto,
  MLTrainingRunDto,
} from '@core/api/api.types';

import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

type FeedKind = 'strategy' | 'opt' | 'bt' | 'ml';

interface FeedRow {
  kind: FeedKind;
  ts: string; // ISO
  id: number;
  title: string;
  status: string;
  detail: string;
}

@Component({
  selector: 'app-automation-monitor-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MetricCardComponent],
  template: `
    <header class="page-header">
      <div>
        <h1>Automation Monitor</h1>
        <p class="subtitle">
          Live activity from the strategy-hunt / strategy-reopt / ml-train launchd loops.
          Auto-refresh
          <span class="muted"
            >every {{ pollSeconds }}s
            @if (lastRefresh()) {
              · last
              {{ lastRefresh() | date: 'HH:mm:ss' }}
            }
          </span>
        </p>
      </div>
      <div class="actions">
        <button class="btn" (click)="togglePause()">
          {{ paused() ? 'Resume' : 'Pause' }}
        </button>
        <button class="btn btn-primary" (click)="refreshNow()" [disabled]="loading()">
          Refresh now
        </button>
      </div>
    </header>

    <section class="metrics" aria-label="In-flight counts">
      <app-metric-card
        label="Active opt runs"
        [value]="activeOpt()"
        format="number"
        dotColor="#22c55e"
      />
      <app-metric-card
        label="Active backtests"
        [value]="activeBt()"
        format="number"
        dotColor="#3b82f6"
      />
      <app-metric-card
        label="Active ML training"
        [value]="activeMl()"
        format="number"
        dotColor="#8b5cf6"
      />
      <app-metric-card
        label="Strategies · last 1h"
        [value]="strategiesLastHour()"
        format="number"
        dotColor="#06b6d4"
      />
      <app-metric-card
        label="Backtests completed · last 1h"
        [value]="btCompletedLastHour()"
        format="number"
        dotColor="#10b981"
      />
    </section>

    @if (errorMessage()) {
      <div class="banner error">{{ errorMessage() }}</div>
    }

    <section class="feed" aria-label="Recent activity">
      <div class="feed-header">
        <h2>Recent activity</h2>
        <span class="muted">{{ feed().length }} events</span>
      </div>
      @if (feed().length === 0 && !loading()) {
        <div class="empty">No recent activity. The launchd loops fire every 7–60 minutes.</div>
      } @else {
        <table class="data">
          <thead>
            <tr>
              <th class="t">Time</th>
              <th class="k">Kind</th>
              <th class="i">ID</th>
              <th>Subject</th>
              <th class="s">Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            @for (row of feed(); track row.kind + ':' + row.id) {
              <tr [class]="'row-' + row.kind">
                <td class="t mono">{{ row.ts | date: 'HH:mm:ss' }}</td>
                <td class="k">
                  <span [class]="'badge badge-' + row.kind">{{ kindLabel(row.kind) }}</span>
                </td>
                <td class="i mono">#{{ row.id }}</td>
                <td>{{ row.title }}</td>
                <td class="s">
                  <span [class]="'pill pill-' + statusClass(row.status)">{{ row.status }}</span>
                </td>
                <td class="muted">{{ row.detail }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        padding: var(--space-6);
      }
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      .page-header h1 {
        margin: 0;
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .subtitle {
        margin: var(--space-1) 0 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-secondary);
      }
      .actions {
        display: flex;
        gap: var(--space-2);
      }
      .btn {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-4);
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .btn:hover {
        background: var(--bg-tertiary);
      }
      .btn-primary {
        background: var(--accent);
        color: var(--accent-fg);
        border-color: var(--accent);
      }
      .btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      .banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-4);
        font-size: var(--text-sm);
      }
      .banner.error {
        background: var(--loss-bg, #fee);
        color: var(--loss, #c00);
        border: 1px solid var(--loss-border, #fcc);
      }
      .feed {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .feed-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .feed-header h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .empty {
        padding: var(--space-8);
        text-align: center;
        color: var(--text-secondary);
      }
      table.data {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      table.data th,
      table.data td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      table.data th {
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      table.data tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .mono {
        font-variant-numeric: tabular-nums;
        font-family: var(--font-mono, ui-monospace, Menlo, monospace);
      }
      .t {
        width: 90px;
      }
      .k {
        width: 90px;
      }
      .i {
        width: 70px;
      }
      .s {
        width: 110px;
      }
      .badge {
        display: inline-block;
        padding: 2px var(--space-2);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        line-height: 1.4;
      }
      .badge-strategy {
        background: rgba(6, 182, 212, 0.15);
        color: #0e7490;
      }
      .badge-opt {
        background: rgba(34, 197, 94, 0.15);
        color: #15803d;
      }
      .badge-bt {
        background: rgba(59, 130, 246, 0.15);
        color: #1d4ed8;
      }
      .badge-ml {
        background: rgba(139, 92, 246, 0.15);
        color: #6d28d9;
      }
      .pill {
        display: inline-block;
        padding: 2px var(--space-2);
        border-radius: 999px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }
      .pill-success {
        background: rgba(34, 197, 94, 0.15);
        color: #15803d;
      }
      .pill-warn {
        background: rgba(245, 158, 11, 0.15);
        color: #b45309;
      }
      .pill-fail {
        background: rgba(239, 68, 68, 0.15);
        color: #b91c1c;
      }
      .pill-info {
        background: rgba(59, 130, 246, 0.15);
        color: #1d4ed8;
      }
      .pill-neutral {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class AutomationMonitorPageComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly feedback = inject(StrategyFeedbackService);
  private readonly backtests = inject(BacktestsService);
  private readonly mlModels = inject(MLModelsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly pollSeconds = 5;

  readonly loading = signal(false);
  readonly paused = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly lastRefresh = signal<Date | null>(null);

  // Raw lists
  private readonly recentStrategies = signal<StrategyDto[]>([]);
  private readonly recentOpts = signal<OptimizationRunDto[]>([]);
  private readonly recentBts = signal<BacktestRunDto[]>([]);
  private readonly recentMls = signal<MLTrainingRunDto[]>([]);

  // Derived metrics
  readonly activeOpt = computed(
    () => this.recentOpts().filter((r) => isActiveRunStatus(r.status as string)).length,
  );
  readonly activeBt = computed(
    () => this.recentBts().filter((r) => isActiveRunStatus(r.status as string)).length,
  );
  readonly activeMl = computed(
    () => this.recentMls().filter((r) => isActiveRunStatus(r.status as string)).length,
  );
  readonly strategiesLastHour = computed(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.recentStrategies().filter((s) => {
      const t = parseTs(s.createdAt);
      return t !== null && t >= cutoff;
    }).length;
  });
  readonly btCompletedLastHour = computed(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.recentBts().filter((b) => {
      if ((b.status as string) !== 'Completed') return false;
      const t = parseTs(b.completedAt);
      return t !== null && t >= cutoff;
    }).length;
  });

  readonly feed = computed<FeedRow[]>(() => {
    const rows: FeedRow[] = [];

    for (const s of this.recentStrategies()) {
      rows.push({
        kind: 'strategy',
        ts: s.createdAt ?? '',
        id: s.id,
        title: `${s.name ?? '(unnamed)'}`,
        status: 'Created',
        detail: `${s.symbol ?? '?'} · ${s.timeframe ?? '?'} · ${s.strategyType ?? '?'}`,
      });
    }

    for (const r of this.recentOpts()) {
      const ts = r.completedAt ?? r.startedAt ?? '';
      const baseline = r.baselineHealthScore ?? null;
      const best = r.bestHealthScore ?? null;
      const detail =
        baseline != null && best != null
          ? `health ${baseline.toFixed(3)} → ${best.toFixed(3)}`
          : (r.errorMessage ?? '').substring(0, 80);
      rows.push({
        kind: 'opt',
        ts,
        id: r.id,
        title: `Opt run on strategy #${r.strategyId}`,
        status: r.status as string,
        detail,
      });
    }

    for (const b of this.recentBts()) {
      const ts = b.completedAt ?? b.startedAt ?? '';
      const detail =
        b.totalTrades != null
          ? `${b.totalTrades} trades · WR ${((b.winRate ?? 0) * 100).toFixed(1)}% · DD ${((b.maxDrawdownPct ?? 0) * 100).toFixed(1)}%`
          : (b.errorMessage ?? '').substring(0, 80);
      rows.push({
        kind: 'bt',
        ts,
        id: b.id,
        title: `Backtest · strategy #${b.strategyId}`,
        status: b.status as string,
        detail,
      });
    }

    for (const m of this.recentMls()) {
      const ts = m.completedAt ?? m.startedAt ?? '';
      const detail =
        m.directionAccuracy != null
          ? `acc ${(m.directionAccuracy * 100).toFixed(1)}%`
          : (m.errorMessage ?? '').substring(0, 80);
      rows.push({
        kind: 'ml',
        ts,
        id: m.id,
        title: `ML training · ${m.symbol ?? '?'} ${m.timeframe ?? '?'}`,
        status: m.status as string,
        detail,
      });
    }

    return rows
      .filter((r) => !!r.ts)
      .sort((a, b) => parseTs(b.ts)! - parseTs(a.ts)!)
      .slice(0, 40);
  });

  constructor() {
    interval(this.pollSeconds * 1000)
      .pipe(
        startWith(0),
        // Skip the tick entirely while paused — don't fire the request, don't
        // touch loading state, just resume on the next tick when un-paused.
        filter(() => !this.paused()),
        // switchMap cancels any in-flight request when a new tick fires, so
        // the page never queues up overlapping fetches under slow networks.
        switchMap(() =>
          this.fetchAll().pipe(
            catchError((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              this.errorMessage.set(`Refresh failed: ${msg}`);
              this.loading.set(false);
              // Keep the outer interval alive — emit nothing for this tick.
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  refreshNow(): void {
    this.fetchAll()
      .pipe(
        catchError((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorMessage.set(`Refresh failed: ${msg}`);
          this.loading.set(false);
          return EMPTY;
        }),
      )
      .subscribe();
  }

  togglePause(): void {
    this.paused.update((p) => !p);
  }

  kindLabel(k: FeedKind): string {
    switch (k) {
      case 'strategy':
        return 'Strategy';
      case 'opt':
        return 'Optimize';
      case 'bt':
        return 'Backtest';
      case 'ml':
        return 'ML train';
    }
  }

  statusClass(status: string): string {
    const s = status.toLowerCase();
    if (s === 'completed' || s === 'created' || s === 'approved') return 'success';
    if (s === 'failed' || s === 'cancelled' || s === 'abandoned') return 'fail';
    if (s === 'queued' || s === 'running' || s === 'claimed') return 'info';
    if (s === 'deferred' || s === 'pending') return 'warn';
    return 'neutral';
  }

  private fetchAll(): Observable<unknown> {
    this.loading.set(true);
    this.errorMessage.set(null);

    const pager = (sortBy?: string) => ({
      currentPage: 1,
      itemCountPerPage: 25,
      sortBy,
      sortDirection: 'desc' as const,
    });

    // Wrap each list call so a single failing endpoint (404, 500, network)
    // doesn't blank the whole view — the others still update.
    const safe = <T>(o: Observable<ResponseData<PagedData<T>>>) =>
      o.pipe(catchError(() => of<ResponseData<PagedData<T>> | null>(null)));

    return forkJoin({
      strategies: safe(this.strategies.list(pager('CreatedAt'))),
      opts: safe(this.feedback.listOptimizationRuns(pager('StartedAt'))),
      bts: safe(this.backtests.list(pager('StartedAt'))),
      mls: safe(this.mlModels.listTrainingRuns(pager('StartedAt'))),
    }).pipe(
      tap(({ strategies, opts, bts, mls }) => {
        if (strategies?.status && strategies.data) {
          this.recentStrategies.set(strategies.data.data ?? []);
        }
        if (opts?.status && opts.data) {
          this.recentOpts.set(opts.data.data ?? []);
        }
        if (bts?.status && bts.data) {
          this.recentBts.set(bts.data.data ?? []);
        }
        if (mls?.status && mls.data) {
          this.recentMls.set(mls.data.data ?? []);
        }
        this.lastRefresh.set(new Date());
        this.loading.set(false);
      }),
    );
  }
}

function isActiveRunStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'queued' || s === 'running' || s === 'claimed';
}

function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}
