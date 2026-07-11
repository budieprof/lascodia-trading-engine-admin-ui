import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { SignalRejectionEventDto, SignalRejectionStage } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type StageFilter = 'all' | SignalRejectionStage;

const STAGE_OPTIONS: ReadonlyArray<{ value: StageFilter; label: string }> = [
  { value: 'all', label: 'All stages' },
  { value: 'Local', label: 'Local (EA gate)' },
  { value: 'Engine', label: 'Engine' },
  { value: 'Broker', label: 'Broker' },
];

/**
 * v8.47.172 — per-instance rejection log.  Answers "why didn't this EA
 * take signal X?" in one click without VNC-ing into MT5.  Polls
 * `/signal-rejection` filtered by `eaInstanceId` every 15 s; admin can
 * narrow by stage, sub-stage substring, or symbol.
 *
 * Empty state is the healthy default — most EAs reject 0 signals in
 * any given 24h window once the safety stack is tuned.  Two view modes:
 *   - **Grouped** (default): events bucketed by `stage::subStage` so
 *     recurring noise collapses to one row with a count.
 *   - **Flat**: one row per event, for raw inspection.
 *
 * Click a row (in either view) to expand the metadata blob (gate-
 * specific context like drift fraction, notional projection, broker
 * retcode params).
 */
@Component({
  selector: 'app-ea-rejections-panel',
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
    <section class="panel" aria-label="EA signal-rejection log">
      <header class="panel-head">
        <div class="panel-title">
          <h3>Rejection log</h3>
          <span class="muted small">
            @if (totalItemCount() > 0) {
              {{ totalItemCount() }} event{{ totalItemCount() === 1 ? '' : 's' }}
            } @else {
              no events
            }
          </span>
        </div>
        <div class="panel-tools">
          <button
            type="button"
            class="btn btn-ghost"
            (click)="resource.refresh()"
            [disabled]="resource.loading()"
            title="Refresh now"
          >
            @if (resource.loading()) {
              Refreshing…
            } @else {
              Refresh
            }
          </button>
        </div>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      <!-- ── Compact summary strip ─────────────────────────────────── -->
      @if (rows().length > 0) {
        <div class="summary-strip">
          <span class="stat"
            ><strong>{{ rows().length }}</strong> events</span
          >
          @if (stageCount('Local') > 0) {
            <span class="stat local"
              ><span class="stage-dot" data-stage="Local"></span>Local
              <strong>{{ stageCount('Local') }}</strong></span
            >
          }
          @if (stageCount('Engine') > 0) {
            <span class="stat engine"
              ><span class="stage-dot" data-stage="Engine"></span>Engine
              <strong>{{ stageCount('Engine') }}</strong></span
            >
          }
          @if (stageCount('Broker') > 0) {
            <span class="stat broker"
              ><span class="stage-dot" data-stage="Broker"></span>Broker
              <strong>{{ stageCount('Broker') }}</strong></span
            >
          }
          <span class="stat"
            ><strong>{{ distinctSymbols() }}</strong> symbol{{
              distinctSymbols() === 1 ? '' : 's'
            }}</span
          >
          @if (latestAt(); as t) {
            <span class="stat"
              >newest <strong>{{ t | relativeTime }}</strong></span
            >
          }
        </div>
      }

      <!-- ── Filters ──────────────────────────────────────────────── -->
      <div class="filters">
        <select
          class="input"
          [ngModel]="stageFilter()"
          (ngModelChange)="onStageChange($event)"
          aria-label="Filter by stage"
        >
          @for (opt of stageOptions; track opt.value) {
            <option [value]="opt.value">{{ opt.label }}</option>
          }
        </select>
        <input
          type="text"
          class="input"
          placeholder="Sub-stage substring (e.g. SafetyGate.)"
          [ngModel]="subStageFilter()"
          (ngModelChange)="onSubStageChange($event)"
          aria-label="Filter by SubStage substring"
        />
        <input
          type="text"
          class="input"
          placeholder="Symbol (e.g. EURGBP)"
          [ngModel]="symbolFilter()"
          (ngModelChange)="onSymbolChange($event)"
          aria-label="Filter by symbol"
        />
        @if (hasFilters()) {
          <button type="button" class="link-btn" (click)="clearFilters()">Clear filters</button>
        }
      </div>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load rejection log"
          message="Engine returned an error fetching rejection events."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state [title]="emptyTitle()" [description]="emptyMessage()" />
      } @else {
        <div class="rejection-scroll">
          <table class="grid">
            <thead>
              <tr>
                <th class="expand-col"></th>
                <th>Time</th>
                <th>Signal</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Stage</th>
                <th>Sub-stage</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.id) {
                <tr
                  class="rej-row"
                  [attr.data-stage]="row.stage"
                  [class.expanded]="expanded() === row.id"
                >
                  <td class="expand-cell">
                    <button
                      type="button"
                      class="expand-btn"
                      [class.on]="expanded() === row.id"
                      (click)="toggle(row.id)"
                      [attr.aria-label]="
                        expanded() === row.id ? 'Collapse metadata' : 'Expand metadata'
                      "
                      [attr.aria-expanded]="expanded() === row.id"
                    >
                      <span class="chev">&#9654;</span>
                    </button>
                  </td>
                  <td class="time" [title]="row.createdAt | date: 'medium'">
                    {{ row.createdAt | relativeTime }}
                  </td>
                  <td class="mono">
                    <a
                      class="signal"
                      [routerLink]="['/trade-signals', row.tradeSignalId]"
                      title="Open signal detail — cross-account attempts"
                      >#{{ row.tradeSignalId }}</a
                    >
                  </td>
                  <td class="acct" [title]="accountLabel(row.tradingAccountId)">
                    {{ accountLabel(row.tradingAccountId) }}
                  </td>
                  <td>
                    <button
                      type="button"
                      class="symbol-btn mono"
                      (click)="filterBySymbol(row.symbol ?? '')"
                      [title]="row.symbol ? 'Filter by ' + row.symbol : ''"
                      [disabled]="!row.symbol"
                    >
                      {{ row.symbol ?? '—' }}
                    </button>
                  </td>
                  <td>
                    <span class="stage-pill" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                  </td>
                  <td class="mono substage">{{ row.subStage }}</td>
                  <td class="reason" [title]="row.reason">{{ row.reason }}</td>
                </tr>
                @if (expanded() === row.id) {
                  <tr class="meta-row">
                    <td colspan="8">
                      <div class="metadata-wrap">
                        <div class="metadata-bar">
                          <span class="muted small">Metadata</span>
                          <button
                            type="button"
                            class="link-btn"
                            (click)="copyMetadata(row.metadataJson)"
                          >
                            Copy JSON
                          </button>
                        </div>
                        <pre class="metadata">{{ formatMetadata(row.metadataJson) }}</pre>
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      }

      @if (totalItemCount() > pageSize() || currentPage() > 1) {
        <nav class="pager-bar" aria-label="Rejection log pagination">
          <div class="pager-info">
            Showing <strong>{{ rangeStart() }}</strong
            >–<strong>{{ rangeEnd() }}</strong> of <strong>{{ totalItemCount() }}</strong> events
          </div>
          <div class="pager-size">
            <label for="rejPageSize">Rows</label>
            <select id="rejPageSize" (change)="setPageSize(+$any($event.target).value)">
              @for (n of pageSizeOptions; track n) {
                <option [value]="n" [selected]="n === pageSize()">{{ n }}</option>
              }
            </select>
          </div>
          <div class="pager-nav">
            <button
              type="button"
              class="pager-btn"
              (click)="goToPage(1)"
              [disabled]="currentPage() <= 1"
              aria-label="First page"
            >
              «
            </button>
            <button
              type="button"
              class="pager-btn"
              (click)="goToPage(currentPage() - 1)"
              [disabled]="currentPage() <= 1"
              aria-label="Previous page"
            >
              ‹
            </button>
            <span class="pager-page">Page {{ currentPage() }} of {{ totalPages() }}</span>
            <button
              type="button"
              class="pager-btn"
              (click)="goToPage(currentPage() + 1)"
              [disabled]="currentPage() >= totalPages()"
              aria-label="Next page"
            >
              ›
            </button>
            <button
              type="button"
              class="pager-btn"
              (click)="goToPage(totalPages())"
              [disabled]="currentPage() >= totalPages()"
              aria-label="Last page"
            >
              »
            </button>
          </div>
        </nav>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding, var(--space-4));
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .panel-title {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .panel-tools {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }

      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }

      /* ── Buttons ──────────────────────────────────────────────── */
      .btn {
        height: 28px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
        font-family: inherit;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .link-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--accent, #0071e3);
        font-family: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        padding: 0;
      }
      .link-btn:hover {
        text-decoration: underline;
      }
      .link-group {
        display: inline-flex;
        gap: var(--space-2);
        align-items: center;
      }
      .link-group .link-btn + .link-btn::before {
        content: '·';
        margin-right: var(--space-2);
        color: var(--text-tertiary);
      }

      /* ── Summary strip (1-liner) ──────────────────────────────── */
      .summary-strip {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        padding: 6px var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .stat {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
      }
      .stat strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        font-size: 13px;
      }
      .stat + .stat::before {
        content: '·';
        margin-right: var(--space-3);
        color: var(--text-tertiary);
      }
      .stage-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        align-self: center;
      }
      .stage-dot[data-stage='Local'] {
        background: #cb8a17;
      }
      .stage-dot[data-stage='Engine'] {
        background: #0058b8;
      }
      .stage-dot[data-stage='Broker'] {
        background: #c93631;
      }

      /* ── Filters row ──────────────────────────────────────────── */
      .filters {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        align-items: center;
      }
      .input {
        height: 30px;
        min-width: 140px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        outline: none;
        transition: border-color 0.12s ease;
      }
      .input:focus {
        border-color: var(--accent, #0071e3);
      }

      /* ── Pagination bar ──────────────────────────────────────── */
      .pager-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4, 16px);
        flex-wrap: wrap;
        font-size: var(--text-xs, 12px);
        color: var(--text-secondary);
      }
      .pager-info strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .pager-size {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .pager-size select {
        height: 26px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
      }
      .pager-nav {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .pager-page {
        min-width: 96px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .pager-btn {
        min-width: 28px;
        height: 26px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
      }
      .pager-btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* ── Scroll surface ──────────────────────────────────────── */
      .rejection-scroll {
        max-height: 520px;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }

      /* ── Table (tabular rejection log) ───────────────────────── */
      .grid {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .grid thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--bg-secondary);
        text-align: left;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 7px var(--space-3);
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .grid tbody td {
        padding: 6px var(--space-3);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .rej-row:hover td {
        background: var(--bg-secondary);
      }
      .rej-row[data-stage='Local'] td:first-child {
        box-shadow: inset 3px 0 0 #cb8a17;
      }
      .rej-row[data-stage='Engine'] td:first-child {
        box-shadow: inset 3px 0 0 #0058b8;
      }
      .rej-row[data-stage='Broker'] td:first-child {
        box-shadow: inset 3px 0 0 #c93631;
      }
      .expand-col,
      .expand-cell {
        width: 26px;
      }
      .expand-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        cursor: pointer;
        padding: 2px;
        display: inline-flex;
      }
      .chev {
        font-size: 9px;
        transition: transform 0.15s ease;
        display: inline-block;
      }
      .expand-btn.on .chev {
        transform: rotate(90deg);
      }
      .acct {
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .meta-row td {
        padding: 0 var(--space-3) 6px;
        background: var(--bg-secondary);
      }
      .empty-line {
        margin: 0;
        padding: var(--space-3);
        text-align: center;
        font-size: var(--text-xs);
      }

      /* ── Stage pill (shared) ─────────────────────────────────── */
      .stage-pill {
        font-size: 10.5px;
        font-weight: var(--font-bold);
        padding: 1px 7px;
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        flex-shrink: 0;
      }
      .stage-pill[data-stage='Local'] {
        background: rgba(255, 149, 0, 0.16);
        color: #b86200;
      }
      .stage-pill[data-stage='Engine'] {
        background: rgba(0, 113, 227, 0.14);
        color: #0058b8;
      }
      .stage-pill[data-stage='Broker'] {
        background: rgba(255, 59, 48, 0.16);
        color: #c4290a;
      }

      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .substage {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        word-break: break-all;
      }
      .time {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .signal {
        color: var(--text-secondary);
        text-decoration: none;
      }
      .signal:hover {
        color: var(--accent, #0071e3);
        text-decoration: underline;
      }
      .symbol-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        text-align: left;
        cursor: pointer;
        padding: 0;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
      .symbol-btn:hover:not(:disabled) {
        color: var(--accent, #0071e3);
      }
      .symbol-btn:disabled {
        color: var(--text-tertiary);
        cursor: default;
      }
      .reason {
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Metadata expansion (shared) ─────────────────────────── */
      .metadata-wrap {
        background: var(--bg-secondary);
        border-top: 1px dashed var(--border);
        padding: 6px var(--space-3) 8px;
      }
      .metadata-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }
      .metadata {
        background: var(--bg-tertiary);
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        font-size: 11px;
        font-family: var(--font-mono, monospace);
        margin: 0;
        overflow-x: auto;
        max-height: 240px;
        overflow-y: auto;
      }
    `,
  ],
})
export class EARejectionsPanelComponent {
  // Intentionally non-required: createPolledResource invokes the fetcher
  // synchronously inside its field-initializer, which would otherwise
  // hit Angular's NG0950 ("required input not yet available") because
  // parent template bindings don't flush until after construction.
  // The fetcher's `if (!id)` guard handles the empty first tick and
  // picks up the real instance id on the next polling cycle.
  readonly instanceId = input<string>('');
  // Optional account-scoped mode: when set (> 0), the panel lists rejections
  // for a trading account instead of an EA instance. Used by the signals-page
  // "Account Rejections" tab, which reuses this exact presentation.
  readonly tradingAccountId = input<number | null>(null);
  // Aggregate across ALL accounts (ignore instance + account scope). Used by the
  // signals-page "Account Rejections" tab's "All accounts" default.
  readonly allAccounts = input<boolean>(false);
  /** id → display label for the Account column in aggregate mode. */
  readonly accountNames = input<Record<number, string>>({});
  readonly stageOptions = STAGE_OPTIONS;

  accountLabel(id: number | null | undefined): string {
    if (id == null) return '—';
    return this.accountNames()[id] ?? `#${id}`;
  }

  readonly stageFilter = signal<StageFilter>('all');
  readonly subStageFilter = signal<string>('');
  readonly symbolFilter = signal<string>('');
  readonly expanded = signal<number | null>(null);

  // ── Pagination (uncaps the log; each page is a window of events the
  //    grouped/flat views render). ─────────────────────────────────────────
  readonly pageSizeOptions = [50, 100, 200, 500] as const;
  readonly currentPage = signal(1);
  readonly pageSize = signal<number>(50);

  private readonly rejectionsService = inject(SignalRejectionsService);
  private readonly notifications = inject(NotificationService);

  // Debounce text inputs so each keystroke doesn't burst the engine —
  // same pattern as ea-audit-timeline.  committedSubStage/Symbol are the
  // values the fetcher actually reads; the two raw signals are bound to
  // the inputs directly so typing remains responsive.
  private readonly committedSubStage = signal<string>('');
  private readonly committedSymbol = signal<string>('');
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  onSubStageChange(value: string): void {
    this.subStageFilter.set(value);
    this.scheduleDebouncedCommit();
  }

  onSymbolChange(value: string): void {
    this.symbolFilter.set(value);
    this.scheduleDebouncedCommit();
  }

  private scheduleDebouncedCommit(): void {
    if (this.debounceHandle != null) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.committedSubStage.set(this.subStageFilter().trim());
      this.committedSymbol.set(this.symbolFilter().trim());
      this.applyFilterChange();
    }, 350);
  }

  protected readonly resource = createPolledResource<{
    rows: SignalRejectionEventDto[];
    total: number;
  }>(
    () => {
      const allMode = this.allAccounts();
      const id = this.instanceId();
      const accountId = this.tradingAccountId();
      // Account-scoped mode takes precedence when an account id is supplied;
      // otherwise fall back to the original EA-instance scope. In all-accounts
      // mode neither filter is sent so the engine returns every rejection.
      const accountScoped = accountId != null && accountId > 0;
      if (!allMode && !accountScoped && !id)
        return of({ rows: [] as SignalRejectionEventDto[], total: 0 });
      const stage = this.stageFilter();
      const subStage = this.committedSubStage();
      const symbol = this.committedSymbol();
      return this.rejectionsService
        .list({
          eaInstanceId: allMode ? undefined : accountScoped ? undefined : id,
          tradingAccountId: allMode ? undefined : accountScoped ? accountId : undefined,
          stage: stage === 'all' ? undefined : stage,
          subStage: subStage || undefined,
          symbol: symbol || undefined,
          currentPage: this.currentPage(),
          itemCountPerPage: this.pageSize(),
        })
        .pipe(
          map((res) => ({
            rows: res.data?.data ?? [],
            total: res.data?.pager?.totalItemCount ?? 0,
          })),
          catchError(() => of({ rows: [] as SignalRejectionEventDto[], total: 0 })),
        );
    },
    { intervalMs: 15_000 },
  );

  readonly rows = computed(() => this.resource.value()?.rows ?? []);
  readonly totalItemCount = computed(() => this.resource.value()?.total ?? 0);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalItemCount() / this.pageSize())),
  );
  readonly rangeStart = computed(() =>
    this.totalItemCount() === 0 ? 0 : (this.currentPage() - 1) * this.pageSize() + 1,
  );
  readonly rangeEnd = computed(() =>
    Math.min(this.currentPage() * this.pageSize(), this.totalItemCount()),
  );
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  goToPage(page: number): void {
    const clamped = Math.min(Math.max(1, page), this.totalPages());
    if (clamped === this.currentPage()) return;
    this.currentPage.set(clamped);
    this.resource.refresh();
  }

  setPageSize(size: number): void {
    if (size === this.pageSize()) return;
    this.pageSize.set(size);
    this.currentPage.set(1);
    this.resource.refresh();
  }

  /** A filter changed — jump back to page 1 and re-fetch immediately (the
   *  poll would otherwise apply the new filter only on its next 15s tick). */
  private applyFilterChange(): void {
    this.currentPage.set(1);
    this.resource.refresh();
  }

  onStageChange(value: StageFilter): void {
    this.stageFilter.set(value);
    this.applyFilterChange();
  }

  private readonly accountScoped = computed(() => {
    const id = this.tradingAccountId();
    return id != null && id > 0;
  });
  readonly emptyTitle = computed(() =>
    this.allAccounts()
      ? 'No rejections across any account.'
      : this.accountScoped()
        ? 'No rejections for this account in the window.'
        : 'No rejections in the last 24h',
  );
  readonly emptyMessage = computed(() =>
    this.allAccounts()
      ? 'Every account picked up its eligible signals — no local gate, engine check, or broker retcode has declined a signal.'
      : this.accountScoped()
        ? 'This account picked up every eligible signal — no local gate, engine check, or broker retcode declined a signal for it.'
        : 'EA is processing every eligible signal — no local gate, engine check, or broker retcode has fired against this account.',
  );

  // ── Summary metrics ────────────────────────────────────────────
  stageCount(stage: SignalRejectionStage): number {
    return this.rows().filter((r) => r.stage === stage).length;
  }

  readonly distinctSymbols = computed(() => new Set(this.rows().map((r) => r.symbol ?? '—')).size);

  readonly latestAt = computed<string | null>(() => {
    const xs = this.rows();
    if (xs.length === 0) return null;
    return xs.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), xs[0].createdAt);
  });

  hasFilters(): boolean {
    return (
      this.stageFilter() !== 'all' ||
      this.subStageFilter().trim() !== '' ||
      this.symbolFilter().trim() !== ''
    );
  }

  clearFilters(): void {
    this.stageFilter.set('all');
    this.subStageFilter.set('');
    this.symbolFilter.set('');
    this.committedSubStage.set('');
    this.committedSymbol.set('');
    this.applyFilterChange();
  }

  filterBySymbol(symbol: string): void {
    if (!symbol || symbol === '—') return;
    this.symbolFilter.set(symbol);
    this.committedSymbol.set(symbol);
    this.applyFilterChange();
  }

  // ── Per-event actions ──────────────────────────────────────────
  toggle(id: number): void {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  copyMetadata(json: string | null): void {
    const formatted = this.formatMetadata(json);
    if (!navigator.clipboard?.writeText) {
      this.notifications.error('Clipboard unavailable in this browser.');
      return;
    }
    navigator.clipboard
      .writeText(formatted)
      .then(() => this.notifications.success('Metadata copied.'))
      .catch(() => this.notifications.error('Copy failed.'));
  }

  formatMetadata(json: string | null): string {
    if (!json) return '(no metadata)';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
