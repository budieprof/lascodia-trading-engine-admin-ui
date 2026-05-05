import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, map, of, switchMap } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { EAInstancesService } from '@core/services/ea-instances.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import type { CurrencyPairDto, EAInstanceDto, EAInstanceStatus } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

type StatusFilter = 'all' | EAInstanceStatus;
type ViewMode = 'cards' | 'table';
type CoverageFilter = 'all' | 'covered' | 'uncovered';

@Component({
  selector: 'app-ea-instances-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    DatePipe,
    FormsModule,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="EA Instances"
        subtitle="Expert Advisor heartbeats and symbol ownership"
      />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (instances().length > 0) {
        <!-- 8-card KPI strip — fleet status + symbol coverage -->
        <div class="kpis">
          <app-metric-card
            label="Total"
            [value]="instances().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Active"
            [value]="activeCount()"
            format="number"
            [dotColor]="activeCount() === 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Idle"
            [value]="idleCount()"
            format="number"
            [dotColor]="idleCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Disconnected"
            [value]="disconnectedCount()"
            format="number"
            [dotColor]="disconnectedCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Owned symbols"
            [value]="totalOwnedSymbols()"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Unique symbols"
            [value]="uniqueOwnedSymbols().size"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Coverage"
            [value]="coveragePct()"
            format="percent"
            [dotColor]="
              coveragePct() >= 90 ? '#34C759' : coveragePct() >= 50 ? '#FF9500' : '#FF3B30'
            "
          />
          <app-metric-card
            label="Accounts"
            [value]="uniqueAccounts().size"
            format="number"
            dotColor="#AF52DE"
          />
        </div>

        <!-- 2-col chart row: status donut + symbols-per-EA -->
        <div class="chart-row">
          <app-chart-card
            title="Status distribution"
            subtitle="Active · Idle · Disconnected"
            [options]="statusDonutOptions()"
            height="220px"
          />
          <app-chart-card
            title="Symbols owned per EA"
            subtitle="How the {{ uniqueOwnedSymbols().size }} unique symbols are distributed"
            [options]="symbolsPerEAOptions()"
            height="220px"
          />
        </div>

        <!-- Toolbar -->
        <div class="toolbar">
          <input
            type="text"
            class="input search"
            placeholder="Filter by instance ID, account, or symbol…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <select
            class="input"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="all">All statuses</option>
            <option value="Active">Active ({{ activeCount() }})</option>
            <option value="Idle">Idle ({{ idleCount() }})</option>
            <option value="Disconnected">Disconnected ({{ disconnectedCount() }})</option>
          </select>
          <div class="view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              [class.active]="viewMode() === 'cards'"
              (click)="viewMode.set('cards')"
            >
              Cards
            </button>
            <button
              type="button"
              [class.active]="viewMode() === 'table'"
              (click)="viewMode.set('table')"
            >
              Dense
            </button>
          </div>
          <span class="muted">{{ filtered().length }} of {{ instances().length }}</span>
        </div>

        @if (viewMode() === 'cards') {
          <section class="grid">
            @for (i of filtered(); track i.instanceId) {
              <article class="card" [attr.data-status]="i.status">
                <header class="head">
                  <div class="title">
                    <span class="status-dot" [attr.data-status]="i.status"></span>
                    <h4 [title]="i.instanceId">{{ i.instanceId }}</h4>
                  </div>
                  <span class="pill" [attr.data-status]="i.status">{{ i.status }}</span>
                </header>
                <dl class="info">
                  <div>
                    <dt>Account</dt>
                    <dd class="mono">{{ i.accountId ?? '—' }}</dd>
                  </div>
                  <div>
                    <dt>Heartbeat</dt>
                    <dd
                      class="mono"
                      [class.bad]="heartbeatTier(i) === 'dead'"
                      [class.warn]="heartbeatTier(i) === 'stale'"
                      [class.good]="heartbeatTier(i) === 'fresh'"
                      [title]="i.lastHeartbeatAt ?? ''"
                    >
                      {{ heartbeatLabel(i) }}
                    </dd>
                  </div>
                  <div>
                    <dt>Uptime</dt>
                    <dd
                      class="mono"
                      [title]="i.registeredAt ? (i.registeredAt | date: 'MMM d, HH:mm') : ''"
                    >
                      {{ uptimeLabel(i) }}
                    </dd>
                  </div>
                  <div class="full">
                    <dt>Owned symbols ({{ i.ownedSymbols?.length ?? 0 }})</dt>
                    <dd>
                      @if ((i.ownedSymbols?.length ?? 0) > 0) {
                        <div class="chips">
                          @for (s of i.ownedSymbols ?? []; track s) {
                            <span
                              class="chip"
                              [class.chip-active]="activeSymbolSet().has(s)"
                              [title]="
                                activeSymbolSet().has(s)
                                  ? s + ' · active currency pair'
                                  : s + ' · not in active currency pairs'
                              "
                            >
                              {{ s }}
                            </span>
                          }
                        </div>
                      } @else {
                        <span class="muted">No symbols owned</span>
                      }
                    </dd>
                  </div>
                </dl>
              </article>
            }
          </section>
        } @else {
          <section class="dense-wrap">
            <table class="dense">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Instance</th>
                  <th>Account</th>
                  <th class="num">Symbols</th>
                  <th>Heartbeat</th>
                  <th>Uptime</th>
                  <th>Owned symbols</th>
                </tr>
              </thead>
              <tbody>
                @for (i of filtered(); track i.instanceId) {
                  <tr>
                    <td>
                      <span class="pill" [attr.data-status]="i.status">{{ i.status }}</span>
                    </td>
                    <td class="mono name" [title]="i.instanceId">{{ i.instanceId }}</td>
                    <td class="mono">{{ i.accountId ?? '—' }}</td>
                    <td class="num mono">{{ i.ownedSymbols?.length ?? 0 }}</td>
                    <td
                      class="mono"
                      [class.bad]="heartbeatTier(i) === 'dead'"
                      [class.warn]="heartbeatTier(i) === 'stale'"
                      [class.good]="heartbeatTier(i) === 'fresh'"
                    >
                      {{ heartbeatLabel(i) }}
                    </td>
                    <td class="mono muted">{{ uptimeLabel(i) }}</td>
                    <td class="symbols-cell">
                      @if ((i.ownedSymbols?.length ?? 0) > 0) {
                        <span class="symbols-inline">
                          {{ (i.ownedSymbols ?? []).join(', ') }}
                        </span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        <!-- Symbol coverage board: cross-references active currency pairs -->
        @if (coverageRows().length > 0) {
          <section class="cov-board">
            <header class="cov-head">
              <h3>Symbol coverage</h3>
              <span class="muted">
                {{ coveredSymbols().size }} covered ·
                <span [class.bad]="uncoveredSymbols().size > 0">
                  {{ uncoveredSymbols().size }} uncovered
                </span>
                · {{ activeSymbolSet().size }} active currency pairs
              </span>
              <div class="cov-filter" role="group" aria-label="Coverage filter">
                <button
                  type="button"
                  [class.active]="coverageFilter() === 'all'"
                  (click)="coverageFilter.set('all')"
                >
                  All
                </button>
                <button
                  type="button"
                  [class.active]="coverageFilter() === 'covered'"
                  (click)="coverageFilter.set('covered')"
                >
                  Covered
                </button>
                <button
                  type="button"
                  [class.active]="coverageFilter() === 'uncovered'"
                  (click)="coverageFilter.set('uncovered')"
                >
                  Uncovered
                </button>
              </div>
            </header>
            <div class="cov-scroll">
              <table class="dense sticky">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Coverage</th>
                    <th>Owner</th>
                    <th>Owner status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of coverageRowsFiltered(); track row.symbol) {
                    <tr>
                      <td class="mono">{{ row.symbol }}</td>
                      <td>
                        @if (row.isCovered) {
                          <span class="pill" data-status="Active">Covered</span>
                        } @else {
                          <span class="pill" data-status="Disconnected">DATA_UNAVAILABLE</span>
                        }
                      </td>
                      <td class="mono">
                        @if (row.ownerId) {
                          {{ row.ownerId }}
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td>
                        @if (row.ownerStatus) {
                          <span class="pill" [attr.data-status]="row.ownerStatus">
                            {{ row.ownerStatus }}
                          </span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <p class="note">
          Dead EAs mark their symbols <code>DATA_UNAVAILABLE</code> after ~60s without a heartbeat.
          Symbols are reassigned automatically when a new EA registers.
        </p>
      } @else {
        <app-empty-state
          title="No EA instances registered"
          description="Register an Expert Advisor from MT5 to populate this view."
        />
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

      /* 8-card KPI strip */
      .kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* 2-col chart row */
      .chart-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      .toolbar {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .search {
        flex: 1 1 280px;
        min-width: 240px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .view-toggle {
        display: inline-flex;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        border: 1px solid var(--border);
      }
      .view-toggle button {
        height: 36px;
        padding: 0 var(--space-3);
        background: transparent;
        border: none;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .view-toggle button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }

      /* Cards grid */
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card[data-status='Active'] {
        border-left: 3px solid var(--profit);
      }
      .card[data-status='Idle'] {
        border-left: 3px solid var(--warning);
      }
      .card[data-status='Disconnected'] {
        border-left: 3px solid var(--loss);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
      }
      .title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
        flex: 1;
      }
      .title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-tertiary);
        flex-shrink: 0;
      }
      .status-dot[data-status='Active'] {
        background: var(--profit);
      }
      .status-dot[data-status='Idle'] {
        background: var(--warning);
      }
      .status-dot[data-status='Disconnected'] {
        background: var(--loss);
      }
      .pill {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .pill[data-status='Active'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Idle'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill[data-status='Disconnected'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .info {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
        margin: 0;
      }
      .info .full {
        grid-column: 1 / -1;
      }
      .info dt {
        font-size: 10.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .info dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .info dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .info dd.good {
        color: var(--profit);
      }
      .info dd.warn {
        color: #c93400;
      }
      .info dd.bad {
        color: var(--loss);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chip {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: 11px;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      /* Symbols that match an active currency pair are highlighted —
         operator can spot orphaned symbols (owned but not in pair list). */
      .chip.chip-active {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }

      /* Dense table view */
      .dense-wrap {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: auto;
        max-height: 540px;
      }
      .dense-wrap thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      table.dense {
        width: 100%;
        border-collapse: collapse;
      }
      table.dense th,
      table.dense td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      table.dense thead th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      table.dense th.num,
      table.dense td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      table.dense td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      table.dense td.muted {
        color: var(--text-tertiary);
      }
      table.dense td.name {
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      table.dense td.bad,
      table.dense td.warn,
      table.dense td.good {
        font-weight: var(--font-semibold);
      }
      table.dense td.bad {
        color: var(--loss);
      }
      table.dense td.warn {
        color: #c93400;
      }
      table.dense td.good {
        color: var(--profit);
      }
      table.dense tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .symbols-cell {
        max-width: 480px;
      }
      .symbols-inline {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-secondary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* Coverage board */
      .cov-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .cov-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .cov-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .cov-head .bad {
        color: var(--loss);
      }
      .cov-filter {
        margin-left: auto;
        display: inline-flex;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        border: 1px solid var(--border);
      }
      .cov-filter button {
        height: 30px;
        padding: 0 var(--space-3);
        background: transparent;
        border: none;
        font-size: 11px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .cov-filter button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .cov-scroll {
        max-height: 480px;
        overflow-y: auto;
      }
      .dense.sticky thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .note {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-5);
        margin: 0;
      }
      .note code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    `,
  ],
})
export class EAInstancesPageComponent {
  private readonly service = inject(EAInstancesService);
  private readonly currencyPairsService = inject(CurrencyPairsService);

  private readonly resource = createPolledResource(
    () =>
      this.service.list().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as EAInstanceDto[])),
      ),
    { intervalMs: 15_000 },
  );

  // Active currency pairs — used to score coverage. Probe-and-fetch so a
  // fresh deployment with hundreds of pairs all loads in one round-trip.
  private readonly pairsResource = createPolledResource(
    () =>
      this.currencyPairsService
        .list({ currentPage: 1, itemCountPerPage: 1, filter: { isActive: true } })
        .pipe(
          switchMap((probe) => {
            const total = probe.data?.pager?.totalItemCount ?? 0;
            if (total === 0) return of([] as CurrencyPairDto[]);
            return this.currencyPairsService
              .list({
                currentPage: 1,
                itemCountPerPage: Math.min(total, 5000),
                filter: { isActive: true },
              })
              .pipe(map((r) => r.data?.data ?? []));
          }),
          catchError(() => of([] as CurrencyPairDto[])),
        ),
    { intervalMs: 60_000 },
  );

  readonly instances = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  readonly search = signal('');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly viewMode = signal<ViewMode>('cards');
  readonly coverageFilter = signal<CoverageFilter>('uncovered');

  readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim();
    const st = this.statusFilter();
    return this.instances().filter((i) => {
      if (st !== 'all' && i.status !== st) return false;
      if (!q) return true;
      if (i.instanceId.toLowerCase().includes(q)) return true;
      if (i.accountId != null && String(i.accountId).includes(q)) return true;
      if (i.ownedSymbols?.some((s) => s.toLowerCase().includes(q))) return true;
      return false;
    });
  });

  readonly activeCount = computed(
    () => this.instances().filter((i) => i.status === 'Active').length,
  );
  readonly idleCount = computed(() => this.instances().filter((i) => i.status === 'Idle').length);
  readonly disconnectedCount = computed(
    () => this.instances().filter((i) => i.status === 'Disconnected').length,
  );

  readonly totalOwnedSymbols = computed(() =>
    this.instances().reduce((s, i) => s + (i.ownedSymbols?.length ?? 0), 0),
  );

  readonly uniqueOwnedSymbols = computed(() => {
    const set = new Set<string>();
    for (const i of this.instances()) {
      for (const s of i.ownedSymbols ?? []) set.add(s);
    }
    return set;
  });

  readonly uniqueAccounts = computed(() => {
    const set = new Set<number>();
    for (const i of this.instances()) {
      if (i.accountId != null) set.add(i.accountId);
    }
    return set;
  });

  // Active currency-pair symbols, keyed by symbol for O(1) coverage checks.
  readonly activeSymbolSet = computed(() => {
    const set = new Set<string>();
    for (const p of this.pairsResource.value() ?? []) {
      if (p.isActive && p.symbol) set.add(p.symbol);
    }
    return set;
  });

  readonly coveredSymbols = computed(() => {
    const owned = this.uniqueOwnedSymbols();
    const active = this.activeSymbolSet();
    const covered = new Set<string>();
    for (const s of owned) if (active.has(s)) covered.add(s);
    return covered;
  });

  readonly uncoveredSymbols = computed(() => {
    const owned = this.uniqueOwnedSymbols();
    const active = this.activeSymbolSet();
    const uncovered = new Set<string>();
    for (const s of active) if (!owned.has(s)) uncovered.add(s);
    return uncovered;
  });

  readonly coveragePct = computed(() => {
    const active = this.activeSymbolSet();
    if (active.size === 0) return 0;
    return (this.coveredSymbols().size / active.size) * 100;
  });

  // symbol -> first owning EA, for the coverage board.
  private readonly symbolOwnerMap = computed(() => {
    const map = new Map<string, EAInstanceDto>();
    for (const i of this.instances()) {
      for (const s of i.ownedSymbols ?? []) {
        if (!map.has(s)) map.set(s, i);
      }
    }
    return map;
  });

  readonly coverageRows = computed(() => {
    const owners = this.symbolOwnerMap();
    const allSymbols = new Set<string>([...this.activeSymbolSet(), ...this.uniqueOwnedSymbols()]);
    return Array.from(allSymbols)
      .map((symbol) => {
        const owner = owners.get(symbol) ?? null;
        const isActive = this.activeSymbolSet().has(symbol);
        const isCovered = isActive && !!owner && owner.status === 'Active';
        return {
          symbol,
          isActive,
          ownerId: owner?.instanceId ?? null,
          ownerStatus: owner?.status ?? null,
          isCovered,
        };
      })
      .sort((a, b) => {
        // Uncovered first (most urgent), then alphabetical.
        if (a.isCovered !== b.isCovered) return a.isCovered ? 1 : -1;
        return a.symbol.localeCompare(b.symbol);
      });
  });

  readonly coverageRowsFiltered = computed(() => {
    const f = this.coverageFilter();
    const rows = this.coverageRows();
    if (f === 'covered') return rows.filter((r) => r.isCovered);
    if (f === 'uncovered') return rows.filter((r) => !r.isCovered);
    return rows;
  });

  readonly statusDonutOptions = computed<EChartsOption>(() => {
    const total = this.instances().length;
    if (total === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: [
            { value: this.activeCount(), name: 'Active', itemStyle: { color: '#34C759' } },
            { value: this.idleCount(), name: 'Idle', itemStyle: { color: '#FF9500' } },
            {
              value: this.disconnectedCount(),
              name: 'Disconnected',
              itemStyle: { color: '#FF3B30' },
            },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  readonly symbolsPerEAOptions = computed<EChartsOption>(() => {
    const rows = [...this.instances()]
      .map((i) => ({
        name: this.shortenInstanceId(i.instanceId),
        value: i.ownedSymbols?.length ?? 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 50, bottom: 30, left: 130 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.name).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.value,
              itemStyle: {
                color: r.value === 0 ? '#FF9500' : '#0071E3',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // EAs use a long ULID-ish id ("LASC-MULTI-10-9480-1342186910048494…"). The
  // chart label runs out of room — keep just the trailing segment for the bar.
  private shortenInstanceId(id: string): string {
    const parts = id.split('-');
    return parts.length > 2 ? `…${parts.slice(-2).join('-')}` : id;
  }

  heartbeatLabel(instance: EAInstanceDto): string {
    if (!instance.lastHeartbeatAt) return '—';
    const elapsed = Date.now() - new Date(instance.lastHeartbeatAt).getTime();
    if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s ago`;
    if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
    return `${Math.round(elapsed / 3_600_000)}h ago`;
  }

  // Heartbeat tier mirrors the engine's 60s DATA_UNAVAILABLE threshold — past
  // that, the EA's symbols are about to be released.
  heartbeatTier(instance: EAInstanceDto): 'fresh' | 'stale' | 'dead' | 'unknown' {
    if (!instance.lastHeartbeatAt) return 'unknown';
    const elapsed = Date.now() - new Date(instance.lastHeartbeatAt).getTime();
    if (elapsed < 30_000) return 'fresh';
    if (elapsed < 60_000) return 'stale';
    return 'dead';
  }

  uptimeLabel(instance: EAInstanceDto): string {
    if (!instance.registeredAt) return '—';
    const elapsed = Date.now() - new Date(instance.registeredAt).getTime();
    if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s`;
    if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m`;
    if (elapsed < 86_400_000) return `${(elapsed / 3_600_000).toFixed(1)}h`;
    return `${Math.round(elapsed / 86_400_000)}d`;
  }
}
