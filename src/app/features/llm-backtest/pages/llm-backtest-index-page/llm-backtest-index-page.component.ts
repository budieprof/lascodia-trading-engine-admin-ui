import {
  Component,
  ChangeDetectionStrategy,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, forkJoin, of, Subscription, switchMap, timer } from 'rxjs';

import {
  BacktestBudgetStatus,
  BacktestStatus,
  BacktestStatusName,
  LlmBacktestRunSummary,
  LlmBacktestService,
} from '@core/services/llm-backtest.service';
import { Timeframe } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

const STATUS_FILTERS: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'Pending', value: 'Pending' },
  { label: 'Running', value: 'Running' },
  { label: 'Completed', value: 'Completed' },
  { label: 'Failed', value: 'Failed' },
  { label: 'Cancelled', value: 'Cancelled' },
];

type ModeFilter = 'all' | 'standard' | 'dry' | 'sweep' | 'multisample';

const MODE_FILTERS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'standard', label: 'Standard' },
  { value: 'dry', label: 'Dry-run' },
  { value: 'sweep', label: 'Sweep' },
  { value: 'multisample', label: 'Multi-sample' },
];

const TIMEFRAME_LABEL: Record<number, string> = {
  0: 'M1',
  1: 'M5',
  2: 'M15',
  3: 'H1',
  4: 'H4',
  5: 'D1',
  6: 'W1',
  7: 'MN',
};

/** Live-tick refresh cadence when any visible row is in Running state. */
const LIVE_TICK_MS = 5000;

/**
 * Dense LLM-Backtest index page.
 *
 * Layout:
 *   1. KPI stat strip (today's runs / today spend / 7d spend + budget bars /
 *      avg hit-rate / avg ER / cache-hit ratio).
 *   2. Filter row (status + mode + symbol + prompt + name + page-size + refresh).
 *   3. Selection bar — shows when ≥1 row is selected; "Compare 2 runs" CTA
 *      lights up at exactly 2.
 *   4. Wide dense table with sticky header, ~36px row height, tabular
 *      numerals, mode + grid-scope badges, inline progress bar, terminal-
 *      state metrics (hit %, ER, viable count), cost actual/estimated stack.
 *   5. Cancel-confirm modal (unchanged behaviour).
 *
 * Polls every 5s while any visible row is Running.
 */
@Component({
  selector: 'app-llm-backtest-index-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    PercentPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="LLM Backtest"
        subtitle="Re-invokes spot-analysis at historical timestamps and scores recommendations forward."
      >
        <a routerLink="/llm-backtest/new" class="btn-primary">+ Launch new</a>
      </app-page-header>

      <!-- ── 1. KPI stat strip ─────────────────────────────────────────── -->
      <section class="kpi-strip">
        <div class="kpi-card">
          <div class="kpi-label">Runs visible</div>
          <div class="kpi-value">{{ visibleCount() }} / {{ totalItems() }}</div>
          <div class="kpi-sub">{{ statusBreakdownLabel() }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Daily spend</div>
          <div class="kpi-value">
            {{ daily()?.spentUsd ?? 0 | currency: 'USD' : 'symbol' : '1.2-2' }}
          </div>
          @if (daily()?.enabled) {
            <div class="budget-bar">
              <span
                [style.width.%]="dailyPct()"
                [class.bar--ok]="dailyPct() < 70"
                [class.bar--warn]="dailyPct() >= 70 && dailyPct() < 90"
                [class.bar--bad]="dailyPct() >= 90"
              ></span>
            </div>
            <div class="kpi-sub">
              of {{ daily()!.capUsd | currency: 'USD' : 'symbol' : '1.0-0' }} ·
              {{ daily()!.remainingUsd | currency: 'USD' : 'symbol' : '1.2-2' }} left
            </div>
          } @else {
            <div class="kpi-sub muted">no daily cap configured</div>
          }
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Weekly spend</div>
          <div class="kpi-value">
            {{ weekly()?.spentUsd ?? 0 | currency: 'USD' : 'symbol' : '1.2-2' }}
          </div>
          @if (weekly()?.enabled) {
            <div class="budget-bar">
              <span
                [style.width.%]="weeklyPct()"
                [class.bar--ok]="weeklyPct() < 70"
                [class.bar--warn]="weeklyPct() >= 70 && weeklyPct() < 90"
                [class.bar--bad]="weeklyPct() >= 90"
              ></span>
            </div>
            <div class="kpi-sub">
              of {{ weekly()!.capUsd | currency: 'USD' : 'symbol' : '1.0-0' }} ·
              {{ weekly()!.remainingUsd | currency: 'USD' : 'symbol' : '1.2-2' }} left
            </div>
          } @else {
            <div class="kpi-sub muted">no weekly cap configured</div>
          }
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg hit-rate</div>
          <div class="kpi-value">
            @if (avgHitRate() !== null) {
              {{ avgHitRate() | percent: '1.0-1' }}
            } @else {
              <span class="muted">—</span>
            }
          </div>
          <div class="kpi-sub">across {{ completedRowsInView() }} completed</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg expected R</div>
          <div class="kpi-value">
            @if (avgExpectedR() !== null) {
              {{ avgExpectedR() | number: '1.2-2' }}R
            } @else {
              <span class="muted">—</span>
            }
          </div>
          <div class="kpi-sub">across {{ completedRowsInView() }} completed</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Cache hits (page)</div>
          <div class="kpi-value">{{ pageCacheHits() }} / {{ pagePointsCompleted() }}</div>
          <div class="kpi-sub">
            {{ pageCacheHitRatio() | percent: '1.0-1' }} of all points reused cached calls
          </div>
        </div>
      </section>

      <!-- ── 2. Filter row ─────────────────────────────────────────────── -->
      <section class="filter-bar">
        <label class="field">
          <span>Status</span>
          <select [(ngModel)]="statusFilter" (ngModelChange)="onFilterChange()">
            @for (opt of statusFilters; track opt.label) {
              <option [ngValue]="opt.value">{{ opt.label }}</option>
            }
          </select>
        </label>

        <div class="field mode-field">
          <span>Mode</span>
          <div class="mode-chips">
            @for (m of modeFilters; track m.value) {
              <button
                type="button"
                class="mode-chip"
                [class.mode-chip--active]="modeFilter() === m.value"
                (click)="setModeFilter(m.value)"
              >
                {{ m.label }}
              </button>
            }
          </div>
        </div>

        <label class="field">
          <span>Symbol</span>
          <input
            type="text"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />
        </label>

        <label class="field">
          <span>Prompt</span>
          <input
            type="text"
            placeholder="version contains…"
            [ngModel]="promptFilter()"
            (ngModelChange)="promptFilter.set($event)"
          />
        </label>

        <label class="field">
          <span>Name</span>
          <input
            type="text"
            placeholder="name contains…"
            [ngModel]="nameFilter()"
            (ngModelChange)="nameFilter.set($event)"
          />
        </label>

        <label class="field">
          <span>Per page</span>
          <select [(ngModel)]="pageSize" (ngModelChange)="onFilterChange()">
            <option [ngValue]="20">20</option>
            <option [ngValue]="50">50</option>
            <option [ngValue]="100">100 (max)</option>
          </select>
        </label>

        <div class="field field--actions">
          <span>&nbsp;</span>
          <div class="actions-row">
            <button type="button" class="btn-secondary btn-sm" (click)="refresh()">
              ↻ Refresh
            </button>
            <button type="button" class="btn-secondary btn-sm" (click)="clearFilters()">
              Clear
            </button>
          </div>
        </div>
      </section>

      <!-- ── 3. Selection bar ──────────────────────────────────────────── -->
      @if (selectedIds().size > 0) {
        <section class="selection-bar">
          <span class="selection-count">{{ selectedIds().size }} selected</span>
          <button type="button" class="btn-link" (click)="clearSelection()">Clear</button>
          <span class="spacer"></span>
          @if (selectedIds().size === 2) {
            <button type="button" class="btn-primary btn-sm" (click)="navigateToCompare()">
              Compare these 2 →
            </button>
          } @else {
            <span class="selection-hint muted">Select exactly 2 to enable Compare</span>
          }
        </section>
      }

      <!-- ── 4. Dense table ────────────────────────────────────────────── -->
      <div class="table-wrap">
        <table class="dense-table">
          <thead>
            <tr>
              <th class="col-chk">
                <input
                  type="checkbox"
                  [checked]="allSelected()"
                  [indeterminate]="someSelected()"
                  (change)="toggleSelectAll($event)"
                />
              </th>
              <th class="col-id">#</th>
              <th class="col-status">Status</th>
              <th class="col-mode">Mode</th>
              <th class="col-name">Name</th>
              <th class="col-symbols">Symbols × TF</th>
              <th class="col-window">Window (UTC)</th>
              <th class="col-progress">Progress</th>
              <th class="col-llmcalls">LLM calls</th>
              <th class="col-cost">Cost</th>
              <th class="col-hr">Hit%</th>
              <th class="col-er">ER</th>
              <th class="col-recs">Viable / Recs</th>
              <th class="col-prompt">Prompt</th>
              <th class="col-created">Created</th>
              <th class="col-duration">Dur</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            @if (loading()) {
              <tr>
                <td colspan="17" class="empty">Loading…</td>
              </tr>
            } @else if (filteredRuns().length === 0) {
              <tr>
                <td colspan="17" class="empty">
                  @if (totalItems() === 0) {
                    No backtest runs yet. <a routerLink="/llm-backtest/new">Launch one →</a>
                  } @else {
                    No rows match the current filters.
                    <button type="button" class="btn-link" (click)="clearFilters()">Clear</button>
                  }
                </td>
              </tr>
            } @else {
              @for (r of filteredRuns(); track r.id) {
                <tr [class.row--selected]="selectedIds().has(r.id)">
                  <td class="col-chk">
                    <input
                      type="checkbox"
                      [checked]="selectedIds().has(r.id)"
                      (change)="toggleSelect(r.id, $event)"
                    />
                  </td>
                  <td class="col-id">
                    <a [routerLink]="['/llm-backtest', r.id]" class="id-link">#{{ r.id }}</a>
                  </td>
                  <td class="col-status">
                    <span
                      class="status-pill"
                      [class]="'status-pill--' + statusLabel(r.status).toLowerCase()"
                    >
                      {{ statusLabel(r.status) }}
                    </span>
                  </td>
                  <td class="col-mode">
                    @if (r.dryRun) {
                      <span class="badge badge--dry" title="Dry run — no LLM cost">DRY</span>
                    }
                    @if (r.sweepKnob) {
                      <span
                        class="badge badge--sweep"
                        [title]="
                          'Sweep over ' + r.sweepKnob + ' × ' + r.sweepValueCount + ' values'
                        "
                      >
                        SWEEP·{{ r.sweepKnob }}·{{ r.sweepValueCount }}
                      </span>
                    }
                    @if (r.sampleCount && r.sampleCount > 1) {
                      <span
                        class="badge badge--ms"
                        [title]="r.sampleCount + ' samples per snapshot'"
                      >
                        MS×{{ r.sampleCount }}
                      </span>
                    }
                    @if (!r.dryRun && !r.sweepKnob && !r.sampleCount) {
                      <span class="muted">std</span>
                    }
                  </td>
                  <td class="col-name">
                    <a [routerLink]="['/llm-backtest', r.id]" class="name-link" [title]="r.name">
                      {{ r.name }}
                    </a>
                    @if (r.note) {
                      <div class="row-note muted" [title]="r.note">{{ r.note }}</div>
                    }
                  </td>
                  <td class="col-symbols">
                    <div class="chip-row">
                      @for (s of r.symbols.slice(0, 3); track s) {
                        <span class="chip chip--sym">{{ s }}</span>
                      }
                      @if (r.symbols.length > 3) {
                        <span class="chip-more" [title]="r.symbols.join(', ')"
                          >+{{ r.symbols.length - 3 }}</span
                        >
                      }
                      <span class="chip-dot">×</span>
                      @for (tf of r.timeframes; track tf) {
                        <span class="chip chip--tf">{{ timeframeLabel(tf) }}</span>
                      }
                    </div>
                  </td>
                  <td class="col-window">
                    @if (r.windowStartUtc && r.windowEndUtc) {
                      <div class="window-cell">
                        <div class="window-row">
                          {{ r.windowStartUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}
                        </div>
                        <div class="window-row muted">
                          → {{ r.windowEndUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}
                        </div>
                        <div class="window-row muted small">{{ windowDurationLabel(r) }}</div>
                      </div>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="col-progress">
                    <div class="progress-cell">
                      <div class="progress-bar">
                        <div
                          class="progress-fill"
                          [style.width.%]="progressPct(r)"
                          [class.bar--done]="r.status === BacktestStatus.Completed"
                          [class.bar--bad]="r.status === BacktestStatus.Failed"
                        ></div>
                      </div>
                      <div class="progress-text">
                        {{ r.completedPoints }} / {{ r.totalPoints }}
                        <span class="muted">({{ progressPct(r) }}%)</span>
                      </div>
                    </div>
                  </td>
                  <td class="col-llmcalls">
                    <div class="stack">
                      <div>{{ llmCallCount(r) }} call(s)</div>
                      <div class="muted small">
                        cache {{ r.cacheHits }} ({{ r.cacheHitRatio ?? 0 | percent: '1.0-0' }})
                      </div>
                    </div>
                  </td>
                  <td class="col-cost">
                    <div class="stack">
                      <div class="cost-actual">
                        {{ r.actualCostUsd | currency: 'USD' : 'symbol' : '1.2-4' }}
                      </div>
                      <div class="cost-est muted small">
                        est {{ r.estimatedCostUsd | currency: 'USD' : 'symbol' : '1.2-2' }}
                      </div>
                    </div>
                  </td>
                  <td class="col-hr">
                    @if (r.hitRate !== null) {
                      <span
                        class="metric-cell"
                        [class.metric-cell--good]="r.hitRate >= 0.5"
                        [class.metric-cell--bad]="r.hitRate < 0.3"
                      >
                        {{ r.hitRate | percent: '1.0-1' }}
                      </span>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="col-er">
                    @if (r.expectedR !== null) {
                      <span
                        class="metric-cell"
                        [class.metric-cell--good]="r.expectedR >= 0.5"
                        [class.metric-cell--bad]="r.expectedR < 0"
                      >
                        {{ r.expectedR | number: '1.2-2' }}R
                      </span>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="col-recs">
                    @if (r.viableCount !== null && r.totalRecommendations !== null) {
                      <div class="stack">
                        <div>{{ r.viableCount }} / {{ r.totalRecommendations }}</div>
                        <div class="muted small">rej {{ r.rejectedByGateCount ?? 0 }}</div>
                      </div>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="col-prompt">
                    <span class="chip chip--prompt" [title]="r.promptVersion">{{
                      r.promptVersion
                    }}</span>
                  </td>
                  <td class="col-created">
                    <div class="stack">
                      <div>{{ r.createdAt | date: 'yyyy-MM-dd HH:mm' }}</div>
                      <div class="muted small">{{ relativeTime(r.createdAt) }}</div>
                    </div>
                  </td>
                  <td class="col-duration">
                    {{ durationLabel(r) }}
                  </td>
                  <td class="col-actions">
                    @if (canCancel(r.status)) {
                      <button
                        type="button"
                        class="btn-danger-sm"
                        [disabled]="cancellingId() === r.id"
                        (click)="confirmCancel(r)"
                      >
                        {{ cancellingId() === r.id ? 'Cancelling…' : 'Cancel' }}
                      </button>
                    }
                    <a [routerLink]="['/llm-backtest', r.id]" class="btn-link btn-sm">View →</a>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>

      <!-- ── 5. Pagination ─────────────────────────────────────────────── -->
      <div class="pager">
        <span class="pager-info">
          Page {{ currentPage() }} of {{ totalPages() }} — {{ totalItems() }} run(s)
          @if (filteredRuns().length !== runs().length) {
            <span class="muted">· {{ filteredRuns().length }} after filters</span>
          }
        </span>
        <div class="pager-buttons">
          <button
            type="button"
            class="btn-secondary btn-sm"
            [disabled]="currentPage() <= 1"
            (click)="prevPage()"
          >
            ‹ Prev
          </button>
          <button
            type="button"
            class="btn-secondary btn-sm"
            [disabled]="currentPage() >= totalPages()"
            (click)="nextPage()"
          >
            Next ›
          </button>
        </div>
      </div>

      <!-- Cancel confirm modal -->
      @if (cancelTarget()) {
        <div class="modal-scrim" (click)="cancelTarget.set(null)">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Cancel run?</h2></div>
            <div class="modal-body">
              <p>
                Cancel run <strong>#{{ cancelTarget()!.id }} {{ cancelTarget()!.name }}</strong
                >?
              </p>
              <p class="muted small">
                The worker will stop after the in-flight point completes; already-emitted points
                remain. Cost incurred so far is not refundable.
              </p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary btn-sm" (click)="cancelTarget.set(null)">
                Back
              </button>
              <button
                type="button"
                class="btn-danger-sm"
                [disabled]="cancellingId() === cancelTarget()!.id"
                (click)="executeCancel()"
              >
                {{ cancellingId() === cancelTarget()!.id ? 'Cancelling…' : 'Confirm cancel' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        padding: var(--space-4) var(--space-5) var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        font-size: 13px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: 11px;
      }

      /* ── KPI strip ───────────────────────────────────────────────────── */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
      }
      .kpi-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: 0.65rem 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      .kpi-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 600;
      }
      .kpi-value {
        font-size: 19px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
      }
      .kpi-sub {
        font-size: 11px;
        color: var(--text-secondary);
      }
      .budget-bar {
        height: 4px;
        background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
        border-radius: 2px;
        overflow: hidden;
        margin: 0.25rem 0;
      }
      .budget-bar > span {
        display: block;
        height: 100%;
        transition: width 0.3s ease;
      }
      .bar--ok {
        background: #1f8a3d;
      }
      .bar--warn {
        background: #c4810a;
      }
      .bar--bad {
        background: #c4290a;
      }
      .bar--done {
        background: #1f8a3d;
      }

      /* ── Filter bar ──────────────────────────────────────────────────── */
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem 0.75rem;
        align-items: flex-end;
        padding: 0.65rem 0.75rem;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        min-width: 0;
      }
      .field > span {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 600;
      }
      .field select,
      .field input {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.32rem 0.55rem;
        font-size: 12px;
        min-width: 120px;
      }
      .field input {
        width: 150px;
      }
      .field--actions {
        margin-left: auto;
      }
      .actions-row {
        display: flex;
        gap: 0.4rem;
      }

      .mode-field {
        flex: 1 1 auto;
      }
      .mode-chips {
        display: flex;
        gap: 0.25rem;
        flex-wrap: wrap;
      }
      .mode-chip {
        background: var(--bg-primary);
        color: var(--text-secondary);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.2rem 0.65rem;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .mode-chip--active {
        background: var(--accent, #4060a0);
        color: #fff;
        border-color: var(--accent, #4060a0);
      }

      /* ── Selection bar ───────────────────────────────────────────────── */
      .selection-bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.75rem;
        background: color-mix(in srgb, var(--accent, #4060a0) 12%, var(--bg-secondary));
        border: 1px solid var(--accent, #4060a0);
        border-radius: var(--radius-md);
        font-size: 12px;
      }
      .selection-count {
        font-weight: 600;
      }
      .spacer {
        flex: 1;
      }

      /* ── Dense table ─────────────────────────────────────────────────── */
      .table-wrap {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: auto;
        max-height: calc(100vh - 380px);
      }
      .dense-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .dense-table thead {
        position: sticky;
        top: 0;
        z-index: 2;
        background: var(--bg-secondary);
      }
      .dense-table th {
        text-align: left;
        font-weight: 600;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        padding: 0.4rem 0.55rem;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .dense-table td {
        padding: 0.4rem 0.55rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .dense-table tbody tr:hover {
        background: color-mix(in srgb, var(--accent, #4060a0) 6%, transparent);
      }
      .row--selected {
        background: color-mix(in srgb, var(--accent, #4060a0) 10%, transparent);
      }
      .empty {
        text-align: center;
        padding: 1.5rem;
        color: var(--text-secondary);
      }

      /* Column widths */
      .col-chk {
        width: 28px;
      }
      .col-id {
        width: 56px;
      }
      .col-status {
        width: 90px;
      }
      .col-mode {
        width: 140px;
      }
      .col-name {
        min-width: 180px;
        max-width: 280px;
      }
      .col-symbols {
        min-width: 160px;
      }
      .col-window {
        width: 170px;
      }
      .col-progress {
        width: 180px;
      }
      .col-llmcalls {
        width: 110px;
      }
      .col-cost {
        width: 110px;
      }
      .col-hr {
        width: 64px;
        text-align: right;
      }
      .col-er {
        width: 72px;
        text-align: right;
      }
      .col-recs {
        width: 95px;
      }
      .col-prompt {
        width: 160px;
      }
      .col-created {
        width: 140px;
      }
      .col-duration {
        width: 60px;
        text-align: right;
      }
      .col-actions {
        width: 140px;
        text-align: right;
        white-space: nowrap;
      }

      .id-link,
      .name-link {
        color: var(--accent, #4060a0);
        text-decoration: none;
        font-weight: 600;
      }
      .name-link {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row-note {
        font-size: 11px;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Status pills */
      .status-pill {
        display: inline-block;
        padding: 0.15rem 0.55rem;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .status-pill--pending {
        background: rgba(196, 129, 10, 0.18);
        color: #c4810a;
      }
      .status-pill--running {
        background: rgba(64, 96, 160, 0.18);
        color: #4060a0;
      }
      .status-pill--completed {
        background: rgba(31, 138, 61, 0.18);
        color: #1f8a3d;
      }
      .status-pill--failed {
        background: rgba(196, 41, 10, 0.18);
        color: #c4290a;
      }
      .status-pill--cancelled {
        background: rgba(110, 110, 115, 0.18);
        color: #6e6e73;
      }

      /* Mode badges */
      .badge {
        display: inline-block;
        padding: 0.1rem 0.4rem;
        border-radius: var(--radius-xs, 3px);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin-right: 0.25rem;
        font-family: ui-monospace, SFMono-Regular, monospace;
      }
      .badge--dry {
        background: rgba(110, 110, 115, 0.18);
        color: #888;
      }
      .badge--sweep {
        background: rgba(196, 129, 10, 0.18);
        color: #c4810a;
      }
      .badge--ms {
        background: rgba(100, 40, 160, 0.18);
        color: #7a3acc;
      }

      /* Chips for symbols/timeframes/prompt */
      .chip-row {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.2rem;
      }
      .chip {
        display: inline-block;
        padding: 0.08rem 0.45rem;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.4;
      }
      .chip--sym {
        background: rgba(64, 96, 160, 0.18);
        color: var(--accent, #4060a0);
      }
      .chip--tf {
        background: rgba(31, 138, 61, 0.18);
        color: #1f8a3d;
      }
      .chip--prompt {
        background: rgba(160, 160, 170, 0.18);
        color: var(--text-secondary);
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-weight: 500;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chip-more {
        font-size: 11px;
        color: var(--text-secondary);
        cursor: default;
      }
      .chip-dot {
        color: var(--text-secondary);
        margin: 0 0.15rem;
      }

      /* Window cell stacks 3 lines */
      .window-cell {
        display: flex;
        flex-direction: column;
        line-height: 1.25;
      }
      .window-row {
        white-space: nowrap;
      }

      /* Progress bar inside the table */
      .progress-cell {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      .progress-bar {
        height: 5px;
        background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
        border-radius: 3px;
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        background: var(--accent, #4060a0);
        transition: width 0.3s ease;
      }
      .progress-text {
        font-size: 11px;
      }

      .stack {
        display: flex;
        flex-direction: column;
        line-height: 1.2;
      }
      .cost-actual {
        font-weight: 600;
      }
      .cost-est {
        font-size: 11px;
      }

      .metric-cell {
        display: inline-block;
        padding: 0.08rem 0.4rem;
        border-radius: var(--radius-xs, 3px);
        font-weight: 600;
      }
      .metric-cell--good {
        background: rgba(31, 138, 61, 0.15);
        color: #1f8a3d;
      }
      .metric-cell--bad {
        background: rgba(196, 41, 10, 0.15);
        color: #c4290a;
      }

      /* Buttons */
      .btn-primary,
      .btn-secondary,
      .btn-danger-sm,
      .btn-link {
        font-size: 12px;
        padding: 0.35rem 0.8rem;
        border-radius: var(--radius-sm);
        cursor: pointer;
        border: 1px solid transparent;
        text-decoration: none;
        font-weight: 600;
        white-space: nowrap;
      }
      .btn-sm {
        padding: 0.25rem 0.55rem;
        font-size: 11px;
      }
      .btn-primary {
        background: var(--accent, #4060a0);
        color: #fff;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-color: var(--border);
      }
      .btn-secondary:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-danger-sm {
        background: rgba(196, 41, 10, 0.12);
        color: #c4290a;
        border-color: rgba(196, 41, 10, 0.4);
        padding: 0.2rem 0.5rem;
        font-size: 11px;
      }
      .btn-link {
        background: transparent;
        color: var(--accent, #4060a0);
        padding: 0.2rem 0.3rem;
      }
      .btn-link:hover {
        text-decoration: underline;
      }

      /* Pager */
      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding-top: 0.4rem;
      }
      .pager-info {
        font-size: 12px;
        color: var(--text-secondary);
      }
      .pager-buttons {
        display: flex;
        gap: 0.4rem;
      }

      /* Modal */
      .modal-scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        width: min(440px, 90vw);
      }
      .modal-header {
        padding: 0.85rem 1rem;
        border-bottom: 1px solid var(--border);
      }
      .modal-header h2 {
        margin: 0;
        font-size: 15px;
      }
      .modal-body {
        padding: 0.85rem 1rem;
        line-height: 1.5;
      }
      .modal-body p {
        margin: 0 0 0.5rem;
      }
      .modal-footer {
        padding: 0.6rem 1rem;
        border-top: 1px solid var(--border);
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
      }
    `,
  ],
})
export class LlmBacktestIndexPageComponent implements OnInit, OnDestroy {
  readonly BacktestStatus = BacktestStatus;
  readonly statusFilters = STATUS_FILTERS;
  readonly modeFilters = MODE_FILTERS;

  private readonly svc = inject(LlmBacktestService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  // ── Filters (signals) ────────────────────────────────────────────────
  statusFilter: string | null = null;
  pageSize = 50;
  readonly modeFilter = signal<ModeFilter>('all');
  readonly symbolFilter = signal('');
  readonly promptFilter = signal('');
  readonly nameFilter = signal('');

  // ── Data ────────────────────────────────────────────────────────────
  readonly loading = signal(false);
  readonly runs = signal<LlmBacktestRunSummary[]>([]);
  readonly totalItems = signal(0);
  readonly currentPage = signal(1);
  readonly daily = signal<BacktestBudgetStatus['daily'] | null>(null);
  readonly weekly = signal<BacktestBudgetStatus['weekly'] | null>(null);

  readonly cancelTarget = signal<LlmBacktestRunSummary | null>(null);
  readonly cancellingId = signal<number | null>(null);

  // ── Selection model ─────────────────────────────────────────────────
  readonly selectedIds = signal<Set<number>>(new Set());

  // ── Derived ─────────────────────────────────────────────────────────
  readonly filteredRuns = computed(() => {
    const sym = this.symbolFilter().trim().toUpperCase();
    const prm = this.promptFilter().trim().toLowerCase();
    const nm = this.nameFilter().trim().toLowerCase();
    const mode = this.modeFilter();
    return this.runs().filter((r) => {
      if (sym && !r.symbols.some((s) => s.toUpperCase().includes(sym))) return false;
      if (prm && !r.promptVersion.toLowerCase().includes(prm)) return false;
      if (nm && !r.name.toLowerCase().includes(nm)) return false;
      switch (mode) {
        case 'standard':
          return !r.dryRun && !r.sweepKnob && (r.sampleCount ?? 1) <= 1;
        case 'dry':
          return r.dryRun;
        case 'sweep':
          return r.sweepKnob != null;
        case 'multisample':
          return (r.sampleCount ?? 0) > 1;
        case 'all':
          return true;
      }
    });
  });

  readonly visibleCount = computed(() => this.filteredRuns().length);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalItems() / this.pageSize)));
  readonly hasRunning = computed(() =>
    this.runs().some((r) => r.status === BacktestStatus.Running),
  );

  readonly statusBreakdownLabel = computed(() => {
    const rs = this.filteredRuns();
    const c = (s: BacktestStatus) => rs.filter((r) => r.status === s).length;
    return `${c(BacktestStatus.Completed)} ✓ · ${c(BacktestStatus.Running)} ▶ · ${c(BacktestStatus.Failed)} ✗`;
  });

  readonly completedRowsInView = computed(
    () =>
      this.filteredRuns().filter((r) => r.status === BacktestStatus.Completed && r.hitRate != null)
        .length,
  );

  readonly avgHitRate = computed(() => {
    const rs = this.filteredRuns().filter((r) => r.hitRate != null);
    if (rs.length === 0) return null;
    return rs.reduce((s, r) => s + (r.hitRate as number), 0) / rs.length;
  });

  readonly avgExpectedR = computed(() => {
    const rs = this.filteredRuns().filter((r) => r.expectedR != null);
    if (rs.length === 0) return null;
    return rs.reduce((s, r) => s + (r.expectedR as number), 0) / rs.length;
  });

  readonly pageCacheHits = computed(() => this.filteredRuns().reduce((s, r) => s + r.cacheHits, 0));

  readonly pagePointsCompleted = computed(() =>
    this.filteredRuns().reduce((s, r) => s + r.completedPoints, 0),
  );

  readonly pageCacheHitRatio = computed(() => {
    const pts = this.pagePointsCompleted();
    return pts > 0 ? this.pageCacheHits() / pts : 0;
  });

  readonly dailyPct = computed(() => {
    const d = this.daily();
    if (!d || !d.enabled || d.capUsd <= 0) return 0;
    return Math.min(100, Math.round((d.spentUsd / d.capUsd) * 100));
  });

  readonly weeklyPct = computed(() => {
    const w = this.weekly();
    if (!w || !w.enabled || w.capUsd <= 0) return 0;
    return Math.min(100, Math.round((w.spentUsd / w.capUsd) * 100));
  });

  readonly allSelected = computed(() => {
    const sel = this.selectedIds();
    const visible = this.filteredRuns();
    return visible.length > 0 && visible.every((r) => sel.has(r.id));
  });

  readonly someSelected = computed(() => {
    const sel = this.selectedIds();
    const visible = this.filteredRuns();
    return visible.some((r) => sel.has(r.id)) && !this.allSelected();
  });

  private liveSub?: Subscription;

  ngOnInit(): void {
    this.fetch();
    this.fetchBudget();
    this.liveSub = timer(LIVE_TICK_MS, LIVE_TICK_MS)
      .pipe(
        switchMap(() => {
          if (!this.hasRunning()) return of(null);
          return forkJoin({
            runs: this.svc
              .listRuns({
                currentPage: this.currentPage(),
                itemCountPerPage: this.pageSize,
                statusFilter: this.statusFilter,
              })
              .pipe(catchError(() => of(null))),
            budget: this.svc.getBudgetStatus().pipe(catchError(() => of(null))),
          });
        }),
      )
      .subscribe((res) => {
        if (!res) return;
        if (res.runs?.status && res.runs.data) {
          this.runs.set(res.runs.data.data ?? []);
          this.totalItems.set(res.runs.data.pager?.totalItemCount ?? 0);
        }
        if (res.budget?.status && res.budget.data) {
          this.daily.set(res.budget.data.daily);
          this.weekly.set(res.budget.data.weekly);
        }
      });
  }

  ngOnDestroy(): void {
    this.liveSub?.unsubscribe();
  }

  fetch(): void {
    this.loading.set(true);
    this.svc
      .listRuns({
        currentPage: this.currentPage(),
        itemCountPerPage: this.pageSize,
        statusFilter: this.statusFilter,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.runs.set(res.data.data ?? []);
          this.totalItems.set(res.data.pager?.totalItemCount ?? 0);
        } else {
          this.runs.set([]);
          this.totalItems.set(0);
          if (res && res.message) {
            this.notifications.error(`Failed to load backtest runs: ${res.message}`);
          }
        }
      });
  }

  fetchBudget(): void {
    this.svc
      .getBudgetStatus()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.status && res.data) {
          this.daily.set(res.data.daily);
          this.weekly.set(res.data.weekly);
        }
      });
  }

  refresh(): void {
    this.fetch();
    this.fetchBudget();
  }

  onFilterChange(): void {
    this.currentPage.set(1);
    this.fetch();
  }

  setModeFilter(m: ModeFilter): void {
    this.modeFilter.set(m);
  }

  clearFilters(): void {
    this.statusFilter = null;
    this.modeFilter.set('all');
    this.symbolFilter.set('');
    this.promptFilter.set('');
    this.nameFilter.set('');
    this.onFilterChange();
  }

  prevPage(): void {
    if (this.currentPage() > 1) {
      this.currentPage.set(this.currentPage() - 1);
      this.fetch();
    }
  }
  nextPage(): void {
    if (this.currentPage() < this.totalPages()) {
      this.currentPage.set(this.currentPage() + 1);
      this.fetch();
    }
  }

  // ── Selection ───────────────────────────────────────────────────────
  toggleSelect(id: number, ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Set(this.selectedIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.selectedIds.set(next);
  }

  toggleSelectAll(ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked;
    const visible = this.filteredRuns().map((r) => r.id);
    const next = new Set(this.selectedIds());
    if (checked) visible.forEach((id) => next.add(id));
    else visible.forEach((id) => next.delete(id));
    this.selectedIds.set(next);
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  navigateToCompare(): void {
    const ids = [...this.selectedIds()];
    if (ids.length !== 2) return;
    this.router.navigate(['/llm-backtest', 'compare'], {
      queryParams: { left: ids[0], right: ids[1] },
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────
  canCancel(status: BacktestStatus): boolean {
    return status === BacktestStatus.Pending || status === BacktestStatus.Running;
  }
  confirmCancel(r: LlmBacktestRunSummary): void {
    this.cancelTarget.set(r);
  }
  executeCancel(): void {
    const target = this.cancelTarget();
    if (!target) return;
    this.cancellingId.set(target.id);
    this.svc
      .cancelRun(target.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.cancellingId.set(null);
        this.cancelTarget.set(null);
        if (res?.status) {
          this.notifications.success(`Run #${target.id} cancellation requested.`);
          this.fetch();
        } else {
          this.notifications.error(res?.message ?? `Failed to cancel run #${target.id}.`);
        }
      });
  }

  // ── Presentation ────────────────────────────────────────────────────
  statusLabel(s: BacktestStatus): string {
    return BacktestStatusName[s] ?? String(s);
  }
  progressPct(r: LlmBacktestRunSummary): number {
    if (r.totalPoints <= 0) return 0;
    return Math.min(100, Math.round((r.completedPoints / r.totalPoints) * 100));
  }
  llmCallCount(r: LlmBacktestRunSummary): number {
    return Math.max(0, r.completedPoints - r.cacheHits);
  }
  timeframeLabel(tf: Timeframe | number): string {
    return TIMEFRAME_LABEL[tf as number] ?? `TF${tf}`;
  }
  windowDurationLabel(r: LlmBacktestRunSummary): string {
    if (!r.windowStartUtc || !r.windowEndUtc) return '';
    const ms = +new Date(r.windowEndUtc) - +new Date(r.windowStartUtc);
    const hours = Math.round(ms / 3_600_000);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }
  durationLabel(r: LlmBacktestRunSummary): string {
    if (!r.startedAt) return '—';
    const endIso = r.completedAt ?? new Date().toISOString();
    const ms = +new Date(endIso) - +new Date(r.startedAt);
    if (ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${rs.toString().padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
  }
  relativeTime(iso: string): string {
    const ms = Date.now() - +new Date(iso);
    if (ms < 0) return 'in future';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }
}
