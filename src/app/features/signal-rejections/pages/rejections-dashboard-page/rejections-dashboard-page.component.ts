import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import type { SignalRejectionEventDto, SignalRejectionStage } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

interface StageCount {
  stage: SignalRejectionStage;
  count: number;
}

interface SubStageCount {
  subStage: string;
  stage: SignalRejectionStage;
  count: number;
  latest: string;
}

/**
 * v8.47.175 — fleet-wide rejection dashboard.  The per-instance
 * Rejection log answers "what has EA-X been rejecting today?"; the
 * per-signal Account-attempts panel answers "what happened to signal
 * Y across every account?".  This page answers the third operator
 * question that neither covers:
 *
 *   "What's the worst rejection pattern across my whole fleet
 *    in the last N hours, and is it getting worse?"
 *
 * Two aggregated views computed from a single 500-row fetch:
 *
 *  - Stage tiles — Local / Engine / Broker counts as headline
 *    cards.  Operator glances and sees instantly whether the day's
 *    rejection load is dominated by EA-local gates (safety stack
 *    doing its job), engine checks (probably misconfiguration), or
 *    broker retcodes (real broker-side trouble).
 *
 *  - Top sub-stages table — the 10 most-frequent SubStage values,
 *    sorted by count.  Catches "SafetyGate.GlobalCB pile-up on
 *    Exness" or "Validator.SpreadFilter killing every BTC trade"
 *    patterns that the per-instance view can't surface without
 *    cycling through every EA.
 *
 * Stats are computed client-side from the 500-row paged sample —
 * cheap, no new engine endpoint, accurate for the operator's day-
 * scale window.  If the working set grows past the sample size,
 * a future GetRejectionStatsQuery on the engine can replace the
 * client-side aggregation without changing the page's surface.
 */
@Component({
  selector: 'app-rejections-dashboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <header class="page-head">
        <h1 class="page-title">Signal rejections</h1>
        <p class="page-subtitle">
          Fleet-wide rejection log — every reason an EA, the engine, or a broker declined a signal
          in the last
          <select [ngModel]="windowHours()" (ngModelChange)="windowHours.set(+$event)">
            <option [value]="1">1 hour</option>
            <option [value]="6">6 hours</option>
            <option [value]="24">24 hours</option>
            <option [value]="168">7 days</option>
          </select>
          .
        </p>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load rejection dashboard"
          message="Engine returned an error fetching aggregated rejection events."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No rejections in this window"
          message="Every EA in the fleet is processing every eligible signal — no local gate, engine check, or broker retcode has fired."
        />
      } @else {
        <!-- Stage headline cards -->
        <section class="stage-cards" aria-label="Counts by stage">
          @for (sc of stageCounts(); track sc.stage) {
            <article class="stage-card" [attr.data-stage]="sc.stage">
              <div class="stage-label">{{ sc.stage }}</div>
              <div class="stage-count">{{ sc.count }}</div>
              <div class="stage-hint">{{ stageHint(sc.stage) }}</div>
            </article>
          }
        </section>

        <!-- Top sub-stages -->
        <section class="panel" aria-label="Top sub-stages">
          <header class="panel-head"><h2>Top reasons</h2></header>
          @if (topSubStages().length === 0) {
            <p class="muted">(no sub-stage activity)</p>
          } @else {
            <table class="substage-table">
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th>Stage</th>
                  <th>Sub-stage</th>
                  <th class="num">Count</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                @for (s of topSubStages(); track s.subStage; let i = $index) {
                  <tr>
                    <td class="num muted">{{ i + 1 }}</td>
                    <td>
                      <span class="stage" [attr.data-stage]="s.stage">{{ s.stage }}</span>
                    </td>
                    <td class="mono">{{ s.subStage }}</td>
                    <td class="num">{{ s.count }}</td>
                    <td class="muted" [title]="s.latest | date: 'medium'">
                      {{ s.latest | relativeTime }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        <!-- Recent activity feed -->
        <section class="panel" aria-label="Recent activity">
          <header class="panel-head">
            <h2>Recent activity</h2>
            <span class="muted">{{ rows().length }} event{{ rows().length === 1 ? '' : 's' }}</span>
          </header>
          <ul class="rejection-list" role="list">
            @for (row of recent(); track row.id) {
              <li class="rejection-row">
                <span class="time" [title]="row.createdAt | date: 'medium'">
                  {{ row.createdAt | relativeTime }}
                </span>
                <a
                  class="signal"
                  [routerLink]="['/trade-signals', row.tradeSignalId]"
                  title="Open signal detail"
                  >#{{ row.tradeSignalId }}</a
                >
                <span class="acct">acct&nbsp;{{ row.tradingAccountId }}</span>
                <span class="symbol">{{ row.symbol ?? '—' }}</span>
                <span class="stage" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                <span class="substage mono">{{ row.subStage }}</span>
                <span class="reason">{{ row.reason }}</span>
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .page-head {
        margin-bottom: var(--space-3);
      }
      .page-title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-1);
        letter-spacing: var(--tracking-tight);
      }
      .page-subtitle {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }
      .page-subtitle select {
        margin: 0 4px;
        padding: 2px 6px;
      }
      .stage-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 20px;
      }
      .stage-card {
        background: var(--surface-base);
        border-radius: 8px;
        padding: 14px 16px;
        border-left: 4px solid;
      }
      .stage-card[data-stage='Local'] {
        border-left-color: var(--badge-amber-fg);
      }
      .stage-card[data-stage='Engine'] {
        border-left-color: var(--badge-blue-fg);
      }
      .stage-card[data-stage='Broker'] {
        border-left-color: var(--badge-red-fg);
      }
      .stage-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted);
        font-weight: 600;
      }
      .stage-count {
        font-size: 28px;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 4px;
        font-variant-numeric: tabular-nums;
      }
      .stage-hint {
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 4px;
      }
      .panel {
        background: var(--surface-base);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 12px;
      }
      .panel-head h2 {
        margin: 0;
        font-size: var(--text-lg);
      }
      .substage-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .substage-table th {
        text-align: left;
        font-weight: 600;
        color: var(--text-muted);
        padding: 8px 6px;
        border-bottom: 1px solid var(--border-subtle);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .substage-table td {
        padding: 8px 6px;
        border-bottom: 1px solid var(--border-subtle);
      }
      .substage-table tr:last-child td {
        border-bottom: 0;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-muted);
      }
      .stage {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
        font-weight: 600;
      }
      .stage[data-stage='Local'] {
        background: var(--badge-amber-bg);
        color: var(--badge-amber-fg);
      }
      .stage[data-stage='Engine'] {
        background: var(--badge-blue-bg);
        color: var(--badge-blue-fg);
      }
      .stage[data-stage='Broker'] {
        background: var(--badge-red-bg);
        color: var(--badge-red-fg);
      }
      .rejection-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .rejection-row {
        display: grid;
        grid-template-columns: 80px 70px 70px 80px 80px 160px 1fr;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid var(--border-subtle);
        align-items: center;
        font-size: 13px;
      }
      .rejection-row:last-child {
        border-bottom: 0;
      }
      .time {
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }
      .signal {
        font-family: var(--font-mono);
      }
      .acct {
        font-family: var(--font-mono);
        font-weight: 600;
      }
      .symbol {
        font-family: var(--font-mono);
        font-weight: 600;
      }
      .substage {
        font-size: 12px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .reason {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class RejectionsDashboardPageComponent {
  private readonly rejectionsService = inject(SignalRejectionsService);

  readonly windowHours = signal<number>(24);

  protected readonly resource = createPolledResource(
    () => {
      const hours = this.windowHours();
      const fromIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      return this.rejectionsService
        .list({
          currentPage: 1,
          itemCountPerPage: 500,
          createdFrom: fromIso,
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<SignalRejectionEventDto[]>([])),
        );
    },
    { intervalMs: 30_000 },
  );

  readonly rows = computed(() => this.resource.value() ?? []);
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  readonly stageCounts = computed<StageCount[]>(() => {
    const seed = new Map<SignalRejectionStage, number>([
      ['Local', 0],
      ['Engine', 0],
      ['Broker', 0],
    ]);
    for (const r of this.rows()) {
      seed.set(r.stage, (seed.get(r.stage) ?? 0) + 1);
    }
    return Array.from(seed.entries()).map(([stage, count]) => ({ stage, count }));
  });

  readonly topSubStages = computed<SubStageCount[]>(() => {
    const groups = new Map<string, SubStageCount>();
    for (const r of this.rows()) {
      const key = `${r.stage}::${r.subStage}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (r.createdAt > existing.latest) existing.latest = r.createdAt;
      } else {
        groups.set(key, { subStage: r.subStage, stage: r.stage, count: 1, latest: r.createdAt });
      }
    }
    return Array.from(groups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  });

  readonly recent = computed(() => this.rows().slice(0, 50));

  stageHint(stage: SignalRejectionStage): string {
    switch (stage) {
      case 'Local':
        return 'EA-local gates (validator, safety, staleness)';
      case 'Engine':
        return 'Engine Tier-2 / risk / kill switch';
      case 'Broker':
        return 'MT5 retcodes (CLIENT_DISABLES_AT, NO_MONEY, …)';
    }
  }
}
