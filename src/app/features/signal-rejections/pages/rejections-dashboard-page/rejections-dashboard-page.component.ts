import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import type { SignalRejectionEventDto, SignalRejectionStage } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
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
  share: number; // 0..1 of max count — drives the bar width
}

const WINDOW_PRESETS = [1, 6, 24, 168] as const;

/**
 * Fleet-wide rejection dashboard. Answers "what's the worst rejection pattern
 * across my whole fleet in the last N hours, and is it getting worse?"
 *
 * Layout follows the canonical "feed" page pattern used by Position Deltas and
 * Signal Exits:
 *   - <app-page-header> with Refresh action
 *   - .filter-bar with window-preset chips + symbol / account / stage filters
 *   - <app-metric-card> tiles in a .kpi-strip for Local / Engine / Broker
 *     + secondary counters
 *   - .data-table-card with sticky-thead board-tables for Top reasons +
 *     Recent activity, each capped with .table-scroll for a predictable
 *     page footprint regardless of cohort size.
 */
@Component({
  selector: 'app-rejections-dashboard-page',
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
        title="Signal rejections"
        subtitle="Fleet-wide rejection log — every reason an EA, the engine, or a broker declined a signal"
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          {{ resource.loading() ? 'Loading…' : 'Refresh' }}
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
          <label for="account" class="fb-label">Account #</label>
          <input
            id="account"
            class="filter-input"
            type="search"
            placeholder="id"
            [ngModel]="accountFilter()"
            (ngModelChange)="accountFilter.set($event)"
          />
        </div>
        <div class="fb-field">
          <label for="stage" class="fb-label">Stage</label>
          <select
            id="stage"
            class="filter-select"
            [ngModel]="stageFilter()"
            (ngModelChange)="stageFilter.set($event)"
          >
            <option value="">all</option>
            <option value="Local">Local</option>
            <option value="Engine">Engine</option>
            <option value="Broker">Broker</option>
          </select>
        </div>
        <div class="fb-field">
          <label for="substage" class="fb-label">Sub-stage</label>
          <input
            id="substage"
            class="filter-input"
            type="search"
            placeholder="e.g. SpreadFilter"
            [ngModel]="subStageFilter()"
            (ngModelChange)="subStageFilter.set($event)"
          />
        </div>
      </section>

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
        <!-- KPI strip — canonical metric-cards, always rendered -->
        <div class="kpi-strip">
          <app-metric-card
            label="Local"
            [value]="localCount()"
            format="number"
            [dotColor]="localCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Engine"
            [value]="engineCount()"
            format="number"
            [dotColor]="engineCount() > 0 ? '#0071E3' : '#34C759'"
          />
          <app-metric-card
            label="Broker"
            [value]="brokerCount()"
            format="number"
            [dotColor]="brokerCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Last hour"
            [value]="lastHourCount()"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Accounts"
            [value]="distinctAccounts()"
            format="number"
            dotColor="#5856D6"
          />
          <app-metric-card
            label="Symbols"
            [value]="distinctSymbols()"
            format="number"
            dotColor="#5856D6"
          />
          <app-metric-card
            label="Distinct reasons"
            [value]="distinctSubStages()"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Events shown"
            [value]="filteredRows().length"
            format="number"
            dotColor="#0071E3"
          />
        </div>

        <!-- Top reasons -->
        <section class="data-table-card">
          <header class="board-head">
            <h3>Top reasons</h3>
            <span class="muted">{{ topSubStages().length }} sub-stages</span>
          </header>
          <div class="table-scroll table-scroll--rollup">
            <table class="board-table">
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th>Stage</th>
                  <th>Sub-stage</th>
                  <th class="num">Count</th>
                  <th class="bar-col">Share</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                @for (s of topSubStages(); track s.subStage; let i = $index) {
                  <tr>
                    <td class="num muted">{{ i + 1 }}</td>
                    <td>
                      <span class="stage-pill" [attr.data-stage]="s.stage">{{ s.stage }}</span>
                    </td>
                    <td class="mono">{{ s.subStage }}</td>
                    <td class="num">{{ s.count | number }}</td>
                    <td class="bar-col">
                      <span class="bar-track">
                        <span
                          class="bar-fill"
                          [attr.data-stage]="s.stage"
                          [style.width.%]="s.share * 100"
                        ></span>
                      </span>
                    </td>
                    <td class="time" [title]="s.latest | date: 'medium'">
                      {{ s.latest | relativeTime }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- Recent activity -->
        <section class="data-table-card">
          <header class="board-head">
            <h3>Recent activity</h3>
            <span class="muted">{{ filteredRows().length | number }} events</span>
          </header>
          <div class="table-scroll table-scroll--events">
            <table class="board-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Signal</th>
                  <th>Acct</th>
                  <th>Symbol</th>
                  <th>Stage</th>
                  <th>Sub-stage</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                @for (row of recent(); track row.id) {
                  <tr>
                    <td class="time" [title]="row.createdAt | date: 'medium'">
                      {{ row.createdAt | relativeTime }}
                    </td>
                    <td>
                      <a class="link mono" [routerLink]="['/trade-signals', row.tradeSignalId]"
                        >#{{ row.tradeSignalId }}</a
                      >
                    </td>
                    <td class="mono">acct {{ row.tradingAccountId }}</td>
                    <td class="mono">{{ row.symbol ?? '—' }}</td>
                    <td>
                      <span class="stage-pill" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                    </td>
                    <td class="mono small">{{ row.subStage }}</td>
                    <td class="reason small">{{ row.reason }}</td>
                  </tr>
                }
              </tbody>
            </table>
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

      /* ── Filter bar — matches sibling feed pages ─────────────────────── */
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
        height: 28px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        font-size: var(--text-xs);
        color: var(--text-primary);
        min-width: 130px;
      }
      .filter-input:focus,
      .filter-select:focus {
        outline: none;
        border-color: var(--accent);
      }
      .window-presets {
        display: inline-flex;
        gap: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .preset {
        background: var(--bg-primary);
        color: var(--text-secondary);
        border: none;
        padding: 4px 10px;
        font-size: var(--text-xs);
        cursor: pointer;
        border-right: 1px solid var(--border);
      }
      .preset:last-child {
        border-right: none;
      }
      .preset:hover {
        background: var(--bg-tertiary);
      }
      .preset.active {
        background: var(--accent);
        color: var(--accent-contrast, #fff);
        font-weight: var(--font-semibold);
      }

      /* ── KPI strip ───────────────────────────────────────────────────── */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: var(--space-3);
      }

      /* ── Board-pattern tables (sibling of feed-page board-tables) ────── */
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
      .table-scroll {
        overflow: auto;
      }
      /* Bound each panel — pages should never grow to thousands of pixels.
         Both tables become scroll surfaces that stay below the fold. */
      .table-scroll--rollup {
        max-height: 320px;
      }
      .table-scroll--events {
        max-height: 520px;
      }

      /* ── Stage pill (Local / Engine / Broker) ────────────────────────── */
      .stage-pill {
        display: inline-block;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.03em;
        line-height: 1.5;
      }
      .stage-pill[data-stage='Local'] {
        background: rgba(255, 149, 0, 0.15);
        color: #b86200;
      }
      .stage-pill[data-stage='Engine'] {
        background: rgba(0, 113, 227, 0.14);
        color: #0058b8;
      }
      .stage-pill[data-stage='Broker'] {
        background: rgba(255, 59, 48, 0.15);
        color: #c4290a;
      }

      /* ── Share bar (Top reasons count column) ───────────────────────── */
      .bar-col {
        min-width: 140px;
      }
      .bar-track {
        display: block;
        width: 100%;
        height: 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: #8e8e93;
        transition: width 200ms ease;
      }
      .bar-fill[data-stage='Local'] {
        background: #ff9500;
      }
      .bar-fill[data-stage='Engine'] {
        background: #0071e3;
      }
      .bar-fill[data-stage='Broker'] {
        background: #ff3b30;
      }

      /* ── Inline utility classes ──────────────────────────────────────── */
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .time {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .link {
        color: var(--accent);
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
      .reason {
        color: var(--text-secondary);
        max-width: 520px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ],
})
export class RejectionsDashboardPageComponent {
  private readonly rejectionsService = inject(SignalRejectionsService);

  readonly windowPresets = WINDOW_PRESETS;

  readonly windowHours = signal<number>(24);
  readonly symbolFilter = signal<string>('');
  readonly accountFilter = signal<string>('');
  readonly stageFilter = signal<string>('');
  readonly subStageFilter = signal<string>('');

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

  /** Filtered set drives every downstream KPI + breakdown — single source of truth. */
  readonly filteredRows = computed(() => {
    const sym = this.symbolFilter().trim().toUpperCase();
    const acct = this.accountFilter().trim();
    const stage = this.stageFilter().trim();
    const sub = this.subStageFilter().trim().toLowerCase();
    return this.rows().filter((r) => {
      if (sym && (r.symbol ?? '').toUpperCase().indexOf(sym) === -1) return false;
      if (acct && String(r.tradingAccountId).indexOf(acct) === -1) return false;
      if (stage && r.stage !== stage) return false;
      if (sub && r.subStage.toLowerCase().indexOf(sub) === -1) return false;
      return true;
    });
  });

  readonly stageCounts = computed<StageCount[]>(() => {
    const seed = new Map<SignalRejectionStage, number>([
      ['Local', 0],
      ['Engine', 0],
      ['Broker', 0],
    ]);
    for (const r of this.filteredRows()) {
      seed.set(r.stage, (seed.get(r.stage) ?? 0) + 1);
    }
    return Array.from(seed.entries()).map(([stage, count]) => ({ stage, count }));
  });

  readonly localCount = computed(
    () => this.stageCounts().find((s) => s.stage === 'Local')?.count ?? 0,
  );
  readonly engineCount = computed(
    () => this.stageCounts().find((s) => s.stage === 'Engine')?.count ?? 0,
  );
  readonly brokerCount = computed(
    () => this.stageCounts().find((s) => s.stage === 'Broker')?.count ?? 0,
  );

  readonly lastHourCount = computed(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.filteredRows().filter((r) => new Date(r.createdAt).getTime() >= cutoff).length;
  });

  readonly distinctAccounts = computed(
    () => new Set(this.filteredRows().map((r) => r.tradingAccountId)).size,
  );

  readonly distinctSymbols = computed(
    () => new Set(this.filteredRows().map((r) => r.symbol ?? '—')).size,
  );

  readonly distinctSubStages = computed(
    () => new Set(this.filteredRows().map((r) => r.subStage)).size,
  );

  /**
   * Top sub-stages by count (capped at 10 rows). The `share` field is the
   * count divided by the top row's count so the bar visualisation in the
   * Share column scales 0–100% relative to the leader.
   */
  readonly topSubStages = computed<SubStageCount[]>(() => {
    const groups = new Map<string, SubStageCount>();
    for (const r of this.filteredRows()) {
      const key = `${r.stage}::${r.subStage}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (r.createdAt > existing.latest) existing.latest = r.createdAt;
      } else {
        groups.set(key, {
          subStage: r.subStage,
          stage: r.stage,
          count: 1,
          latest: r.createdAt,
          share: 0,
        });
      }
    }
    const list = Array.from(groups.values()).sort((a, b) => b.count - a.count);
    const top = list[0]?.count ?? 1;
    return list.slice(0, 10).map((s) => ({ ...s, share: s.count / top }));
  });

  /**
   * Recent activity feed — cap at 200 rows so the table-scroll container
   * stays responsive even on a busy window. The total count surfaces on the
   * card header so the operator knows the cap is in effect.
   */
  readonly recent = computed(() => this.filteredRows().slice(0, 200));
}
