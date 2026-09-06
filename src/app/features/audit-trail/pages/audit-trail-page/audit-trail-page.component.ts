import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { catchError, map, of, switchMap, throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { AuditTrailService } from '@core/services/audit-trail.service';
import type { DecisionLogDto, PagedData, PagerRequest } from '@core/api/api.types';
import { RealtimeService } from '@core/realtime/realtime.service';
import { createPolledResource } from '@core/polling/polled-resource';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type DateRange = 'all' | '24h' | '7d' | '30d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Outcome buckets — maps the wide variety of strings the engine emits into
// three operator-meaningful tiers so KPIs and charts stay legible.
const POSITIVE_OUTCOMES = new Set([
  'Approved',
  'Executed',
  'Active',
  'Promoted',
  'Passed',
  'Resolved',
  'Allowed',
]);
const NEGATIVE_OUTCOMES = new Set([
  'Failed',
  'Rejected',
  'Critical',
  'Blocked',
  'Error',
  'Aborted',
]);

@Component({
  selector: 'app-audit-trail-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    FormsModule,
    DatePipe,
    RelativeTimePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Audit Trail" subtitle="Decision logs and system audit records" />

      <!-- KPI strip. "Total ever" is the whole table; every other tile is
           computed over the most recent sample (capped at 2,000 rows), so the
           scope is spelled out once under the strip rather than letting a
           sample-bounded "Last 7d = 2,000" sit beside a global 236,590.
           Colour is reserved for outcomes: green for approvals, red for
           failures when there are any; the rest are neutral. -->
      <div class="kpis">
        <app-metric-card
          label="Total ever"
          [value]="totalEver()"
          format="number"
          dotColor="#8E8E93"
        />
        <app-metric-card
          label="Last 24h"
          [value]="last24hSaturated() ? null : last24hCount()"
          format="number"
          dotColor="#8E8E93"
        />
        <app-metric-card
          label="Approved / Executed"
          [value]="positiveCount()"
          format="number"
          [dotColor]="positiveCount() > 0 ? '#34C759' : '#8E8E93'"
        />
        <app-metric-card
          label="Failed / Rejected"
          [value]="negativeCount()"
          format="number"
          [dotColor]="negativeCount() > 0 ? '#FF3B30' : '#8E8E93'"
        />
        <app-metric-card
          label="Decision types"
          [value]="distinctDecisionTypes()"
          format="number"
          dotColor="#8E8E93"
        />
        <app-metric-card
          label="Sources"
          [value]="distinctSources()"
          format="number"
          dotColor="#8E8E93"
        />
      </div>
      <p class="kpi-scope">{{ sampleScopeNote() }}</p>

      <!-- 3-col chart row: outcome donut + top decision types + activity-per-hour -->
      <div class="chart-row">
        <app-chart-card
          title="Outcome distribution"
          subtitle="Top 6 outcomes in the recent sample; the rest grouped as Other"
          [options]="outcomeDonutOptions()"
          height="220px"
        />
        <app-chart-card
          title="Top decision types"
          subtitle="Most-frequent decisions in the recent sample"
          [options]="topDecisionTypesOptions()"
          height="220px"
        />
        <app-chart-card
          title="Activity (last 24h)"
          subtitle="Decisions per hour"
          [options]="activityByHourOptions()"
          height="220px"
        />
      </div>

      <!-- Quick filter chips + filter dropdowns -->
      <div class="filter-bar">
        <div class="chips">
          <button
            type="button"
            [class.active]="quickFilter() === 'all'"
            (click)="setQuickFilter('all')"
          >
            All
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === '24h'"
            (click)="setQuickFilter('24h')"
          >
            Last 24h
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'critical'"
            (click)="setQuickFilter('critical')"
          >
            Critical / Failed only
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'kill'"
            (click)="setQuickFilter('kill')"
          >
            Kill switches
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'ml'"
            (click)="setQuickFilter('ml')"
          >
            ML model events
          </button>
        </div>

        <select
          class="input"
          [ngModel]="decisionTypeFilter()"
          (ngModelChange)="onFilterChange('decisionType', $event)"
        >
          <option value="">All decision types ({{ analyticsRows().length }})</option>
          @for (t of decisionTypeOptions(); track t.value) {
            <option [value]="t.value">{{ t.value }} ({{ t.count }})</option>
          }
        </select>
        <select
          class="input"
          [ngModel]="outcomeFilter()"
          (ngModelChange)="onFilterChange('outcome', $event)"
        >
          <option value="">All outcomes</option>
          @for (o of outcomeOptions(); track o.value) {
            <option [value]="o.value">{{ o.value }} ({{ o.count }})</option>
          }
        </select>
        <select
          class="input"
          [ngModel]="entityTypeFilter()"
          (ngModelChange)="onFilterChange('entityType', $event)"
        >
          <option value="">All entities</option>
          @for (e of entityTypeOptions(); track e.value) {
            <option [value]="e.value">{{ e.value }} ({{ e.count }})</option>
          }
        </select>
        <select
          class="input"
          [ngModel]="dateRangeFilter()"
          (ngModelChange)="onFilterChange('dateRange', $event)"
        >
          <option value="all">All time</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>

        @if (hasActiveFilters()) {
          <button type="button" class="link-btn" (click)="resetFilters()">Reset filters</button>
        }
      </div>

      <app-data-table
        #auditTable
        [columnDefs]="columns"
        [fetchData]="fetchData"
        [searchable]="true"
        (rowClick)="toggleExpand($event)"
      />

      @if (expandedEntry()) {
        <div
          class="detail-overlay"
          role="presentation"
          tabindex="-1"
          (click)="expandedEntry.set(null)"
          (keydown.escape)="expandedEntry.set(null)"
        >
          <div
            class="detail-panel"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <div class="detail-header">
              <h3 class="detail-title">Decision Log #{{ expandedEntry()!.id }}</h3>
              <button
                type="button"
                class="close-btn"
                aria-label="Close detail"
                (click)="expandedEntry.set(null)"
              >
                &times;
              </button>
            </div>
            <div class="detail-body">
              <div class="detail-section">
                <h4 class="detail-label">Reason</h4>
                <p class="detail-value">{{ expandedEntry()!.reason }}</p>
              </div>
              <div class="detail-section">
                <h4 class="detail-label">Context JSON</h4>
                <pre class="detail-json">{{ formatJson(expandedEntry()!.contextJson) }}</pre>
              </div>
              <div class="detail-meta">
                <div class="meta-item">
                  <span class="meta-label">Decision Type</span>
                  <span class="meta-value">{{ expandedEntry()!.decisionType }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Entity</span>
                  <span class="meta-value"
                    >{{ expandedEntry()!.entityType }} #{{ expandedEntry()!.entityId }}</span
                  >
                </div>
                <div class="meta-item">
                  <span class="meta-label">Outcome</span>
                  <span class="meta-value">{{ expandedEntry()!.outcome }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Source</span>
                  <span class="meta-value">{{ expandedEntry()!.source }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Logged</span>
                  <span class="meta-value">
                    {{ expandedEntry()!.createdAt | date: 'MMM d, yyyy HH:mm:ss' }}
                    <span class="meta-sub">({{ expandedEntry()!.createdAt | relativeTime }})</span>
                  </span>
                </div>
              </div>
              <div class="related-bar">
                <button
                  type="button"
                  class="related-btn"
                  (click)="filterByEntity(expandedEntry()!)"
                >
                  Filter to all decisions for {{ expandedEntry()!.entityType }} #{{
                    expandedEntry()!.entityId
                  }}
                </button>
              </div>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .kpis {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .kpis {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .kpi-scope {
        margin: calc(-1 * var(--space-1)) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .meta-sub {
        color: var(--text-tertiary);
        font-weight: var(--font-regular, 400);
        margin-left: var(--space-1);
      }

      .chart-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: center;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-2) var(--space-3);
      }
      .chips {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        padding: 2px;
      }
      .chips button {
        height: 28px;
        padding: 0 var(--space-3);
        border: none;
        background: transparent;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .chips button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      /* Selects share the remaining width and shrink before wrapping, so the
         last one no longer drops onto a second row on its own. */
      .input {
        height: 32px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        outline: none;
        flex: 1 1 140px;
        min-width: 120px;
        max-width: 220px;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .link-btn {
        background: transparent;
        border: none;
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      .detail-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.15s ease;
      }
      .detail-panel {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 720px;
        max-height: 80vh;
        overflow-y: auto;
        animation: scaleIn 0.2s ease-out;
      }
      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .detail-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }
      .close-btn {
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }
      .close-btn:hover {
        background: var(--border);
      }
      .detail-body {
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .detail-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .detail-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin: 0;
      }
      .detail-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        margin: 0;
        line-height: 1.5;
      }
      .detail-json {
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 12px;
        color: var(--text-primary);
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        margin: 0;
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 300px;
        overflow-y: auto;
      }
      .detail-meta {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
      }
      @media (max-width: 600px) {
        .detail-meta {
          grid-template-columns: 1fr 1fr;
        }
      }
      .meta-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .meta-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .meta-value {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .related-bar {
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
      }
      .related-btn {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .related-btn:hover {
        background: var(--bg-tertiary);
        border-color: var(--accent);
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
    `,
  ],
})
export class AuditTrailPageComponent {
  private readonly auditTrailService = inject(AuditTrailService);
  private readonly realtime = inject(RealtimeService);
  private readonly relativeTimePipe = new RelativeTimePipe();

  private readonly auditTable = viewChild<DataTableComponent<DecisionLogDto>>('auditTable');

  expandedEntry = signal<DecisionLogDto | null>(null);

  // Filter signals — fed into fetchData and refetched on change.
  readonly decisionTypeFilter = signal('');
  readonly outcomeFilter = signal('');
  readonly entityTypeFilter = signal('');
  readonly entityIdFilter = signal<number | null>(null);
  readonly dateRangeFilter = signal<DateRange>('all');
  readonly quickFilter = signal<'all' | '24h' | 'critical' | 'kill' | 'ml'>('all');

  // Analytics resource — probe-and-fetch up to the most recent 2000 decisions.
  // Used to compute KPIs, charts, and the universe of values for the filter
  // dropdowns. Polled every 60s; pushed by realtime SignalR with throttle.
  private readonly analyticsResource = createPolledResource(
    () =>
      this.auditTrailService.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).pipe(
        switchMap((probe) => {
          const total = probe.data?.pager?.totalItemCount ?? 0;
          const limit = Math.min(total, 2000);
          if (limit === 0) {
            return of({ rows: [] as DecisionLogDto[], total });
          }
          return this.auditTrailService
            .list({ currentPage: 1, itemCountPerPage: limit, filter: null })
            .pipe(map((r) => ({ rows: r.data?.data ?? [], total })));
        }),
        catchError(() => of({ rows: [] as DecisionLogDto[], total: 0 })),
      ),
    { intervalMs: 60_000 },
  );

  readonly analyticsRows = computed(() => this.analyticsResource.value()?.rows ?? []);
  readonly totalEver = computed(() => this.analyticsResource.value()?.total ?? 0);

  /** Oldest timestamp in the sample, formatted — tells the operator how far the tiles reach. */
  readonly sampleOldest = computed(() => {
    const rows = this.analyticsRows();
    if (rows.length === 0) return null;
    let oldest = Infinity;
    for (const r of rows) {
      const t = new Date(r.createdAt).getTime();
      if (t < oldest) oldest = t;
    }
    return Number.isFinite(oldest) ? formatDate(oldest, 'MMM d, yyyy HH:mm', 'en-US') : null;
  });

  /**
   * True when every sampled row is newer than 24h: the sample hit its cap before reaching
   * the window edge, so "Last 24h" would only be the cap (it read 2,000 = the cap on a
   * 236,590-row table). The tile shows "-" and the caption explains why.
   */
  readonly last24hSaturated = computed(() => {
    const rows = this.analyticsRows();
    if (rows.length === 0) return false;
    const total = this.totalEver();
    if (rows.length >= total) return false;
    return this.last24hCount() === rows.length;
  });

  readonly sampleScopeNote = computed(() => {
    const n = this.analyticsRows().length;
    if (n === 0) return 'Waiting for the recent-decisions sample.';
    const count = new Intl.NumberFormat('en-US').format(n);
    const oldest = this.sampleOldest();
    let note = `Total ever counts the whole table. The other tiles and the charts are computed over the most recent ${count} decisions`;
    if (oldest) note += ` (back to ${oldest})`;
    note += '.';
    if (this.last24hSaturated()) {
      note += ' The sample does not reach back 24 hours, so the Last 24h count is not available.';
    }
    return note;
  });

  constructor() {
    this.realtime
      .on('auditDecisionLogged')
      .pipe(throttleTime(3_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.auditTable()?.loadData();
        this.analyticsResource.refresh();
      });

    // Refetch the table whenever a filter value changes.
    effect(() => {
      // Read the filter signals so the effect is registered as a dependency.
      this.decisionTypeFilter();
      this.outcomeFilter();
      this.entityTypeFilter();
      this.entityIdFilter();
      this.dateRangeFilter();
      // Defer to the next microtask so loadData isn't called during the
      // template's binding pass (the table may not have a gridApi yet on the
      // first render).
      queueMicrotask(() => this.auditTable()?.loadData());
    });
  }

  // ---------- KPIs ----------

  readonly last24hCount = computed(() => {
    const cutoff = Date.now() - DAY_MS;
    return this.analyticsRows().filter((r) => new Date(r.createdAt).getTime() > cutoff).length;
  });

  readonly positiveCount = computed(
    () => this.analyticsRows().filter((r) => POSITIVE_OUTCOMES.has(r.outcome ?? '')).length,
  );

  readonly negativeCount = computed(
    () => this.analyticsRows().filter((r) => NEGATIVE_OUTCOMES.has(r.outcome ?? '')).length,
  );

  readonly distinctDecisionTypes = computed(() => {
    const set = new Set<string>();
    for (const r of this.analyticsRows()) if (r.decisionType) set.add(r.decisionType);
    return set.size;
  });

  readonly distinctSources = computed(() => {
    const set = new Set<string>();
    for (const r of this.analyticsRows()) if (r.source) set.add(r.source);
    return set.size;
  });

  // ---------- Filter dropdown options (sorted by frequency) ----------

  private countsByField(field: 'decisionType' | 'outcome' | 'entityType') {
    const counts = new Map<string, number>();
    for (const r of this.analyticsRows()) {
      const v = r[field] ?? '';
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
  }

  readonly decisionTypeOptions = computed(() => this.countsByField('decisionType'));
  readonly outcomeOptions = computed(() => this.countsByField('outcome'));
  readonly entityTypeOptions = computed(() => this.countsByField('entityType'));

  // ---------- Charts ----------

  readonly outcomeDonutOptions = computed<EChartsOption>(() => {
    const counts = new Map<string, number>();
    for (const r of this.analyticsRows()) {
      const k = r.outcome ?? 'Unknown';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return {};
    // The engine emits ~74 distinct outcome strings; a legend paged "1/74"
    // is unreadable. Keep the six largest and fold the tail into "Other".
    const TOP = 6;
    const entries = sorted.slice(0, TOP);
    const tail = sorted.slice(TOP);
    if (tail.length > 0) {
      entries.push([`Other (${tail.length} outcomes)`, tail.reduce((sum, [, v]) => sum + v, 0)]);
    }
    const colorFor = (name: string): string => {
      if (POSITIVE_OUTCOMES.has(name)) return '#34C759';
      if (NEGATIVE_OUTCOMES.has(name)) return '#FF3B30';
      if (name === 'Detected') return '#FF9500';
      if (name === 'Skipped' || name.startsWith('Other')) return '#8E8E93';
      return '#0071E3';
    };
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '42%'],
          label: { show: false },
          data: entries.map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: colorFor(name) },
          })),
        },
      ],
    };
  });

  readonly topDecisionTypesOptions = computed<EChartsOption>(() => {
    const counts = new Map<string, number>();
    for (const r of this.analyticsRows()) {
      if (!r.decisionType) continue;
      counts.set(r.decisionType, (counts.get(r.decisionType) ?? 0) + 1);
    }
    const rows = Array.from(counts.entries())
      .map(([decisionType, value]) => ({ decisionType, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
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
        data: rows.map((r) => r.decisionType).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.value,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // Decisions per hour for the last 24 hours — quick "is something unusual
  // happening right now?" check.
  readonly activityByHourOptions = computed<EChartsOption>(() => {
    const buckets = new Array<number>(24).fill(0);
    const labels = new Array<string>(24);
    const now = Date.now();
    const oldest = now - 24 * HOUR_MS;
    for (let i = 0; i < 24; i++) {
      const d = new Date(now - (23 - i) * HOUR_MS);
      labels[i] = d.getHours().toString().padStart(2, '0') + ':00';
    }
    for (const r of this.analyticsRows()) {
      const t = new Date(r.createdAt).getTime();
      if (t < oldest || t > now) continue;
      const idx = Math.min(23, Math.max(0, Math.floor((t - oldest) / HOUR_MS)));
      buckets[idx]++;
    }
    if (buckets.every((v) => v === 0)) {
      return {
        title: {
          text: 'No activity in the last 24h',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 20, bottom: 30, left: 30 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          fontSize: 9,
          color: '#6E6E73',
          interval: 3,
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: buckets,
          itemStyle: { color: '#0071E3', borderRadius: [3, 3, 0, 0] },
          barWidth: '70%',
        },
      ],
    };
  });

  // ---------- Quick filter chips ----------

  setQuickFilter(value: 'all' | '24h' | 'critical' | 'kill' | 'ml'): void {
    this.quickFilter.set(value);
    // Translate the chip into concrete filter signal values.
    if (value === 'all') {
      this.decisionTypeFilter.set('');
      this.outcomeFilter.set('');
      this.dateRangeFilter.set('all');
    } else if (value === '24h') {
      this.decisionTypeFilter.set('');
      this.outcomeFilter.set('');
      this.dateRangeFilter.set('24h');
    } else if (value === 'critical') {
      this.decisionTypeFilter.set('');
      this.outcomeFilter.set('Critical');
      this.dateRangeFilter.set('all');
    } else if (value === 'kill') {
      this.decisionTypeFilter.set('KillSwitchActivated');
      this.outcomeFilter.set('');
      this.dateRangeFilter.set('all');
    } else if (value === 'ml') {
      this.decisionTypeFilter.set('ModelActivated');
      this.outcomeFilter.set('');
      this.dateRangeFilter.set('all');
    }
  }

  onFilterChange(field: 'decisionType' | 'outcome' | 'entityType' | 'dateRange', value: string) {
    this.quickFilter.set('all');
    if (field === 'decisionType') this.decisionTypeFilter.set(value);
    else if (field === 'outcome') this.outcomeFilter.set(value);
    else if (field === 'entityType') this.entityTypeFilter.set(value);
    else if (field === 'dateRange') this.dateRangeFilter.set(value as DateRange);
  }

  hasActiveFilters(): boolean {
    return (
      !!this.decisionTypeFilter() ||
      !!this.outcomeFilter() ||
      !!this.entityTypeFilter() ||
      this.dateRangeFilter() !== 'all' ||
      this.entityIdFilter() !== null
    );
  }

  resetFilters(): void {
    this.decisionTypeFilter.set('');
    this.outcomeFilter.set('');
    this.entityTypeFilter.set('');
    this.entityIdFilter.set(null);
    this.dateRangeFilter.set('all');
    this.quickFilter.set('all');
  }

  filterByEntity(entry: DecisionLogDto): void {
    if (entry.entityType) this.entityTypeFilter.set(entry.entityType);
    this.entityIdFilter.set(entry.entityId);
    this.expandedEntry.set(null);
  }

  // ---------- Table column defs (unchanged outcome cell renderer) ----------

  columns: ColDef<DecisionLogDto>[] = [
    {
      headerName: 'Timestamp',
      field: 'createdAt',
      width: 170,
      sortable: true,
      // An audit trail needs the absolute time; the relative form is the tooltip.
      valueFormatter: (params) =>
        params.value ? formatDate(params.value, 'MMM d, yyyy HH:mm:ss', 'en-US') : '—',
      tooltipValueGetter: (params) => this.relativeTimePipe.transform(params.value),
    },
    { headerName: 'Decision Type', field: 'decisionType', flex: 1.2, minWidth: 150 },
    { headerName: 'Entity Type', field: 'entityType', width: 130 },
    { headerName: 'Entity ID', field: 'entityId', width: 95 },
    {
      headerName: 'Outcome',
      field: 'outcome',
      width: 120,
      cellRenderer: (params: { value: string }) => {
        const outcomeMap: Record<string, { bg: string; color: string }> = {
          Approved: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Executed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Skipped: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          Passed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Failed: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Critical: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Detected: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
        };
        const s = outcomeMap[params.value] ?? { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' };
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'Source',
      field: 'source',
      flex: 1,
      minWidth: 150,
      // Source names ("SignalOrderBridgeWorker") clipped at 130px with no
      // ellipsis; the grid's own cell truncation applies once the cell is
      // flex-sized, and the full value is the tooltip.
      tooltipField: 'source',
    },
    {
      headerName: '',
      field: 'id',
      width: 90,
      sortable: false,
      cellRenderer: () => {
        return `<button data-action="expand" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.1);color:#0040DD">Details</button>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.getAttribute('data-action');
        if (action === 'expand') this.toggleExpand(params.data);
      },
    },
  ];

  // The DataTable composes a base PagerRequest (current page, page size, and
  // its own search-string filter under {search}). We layer our explicit filter
  // values on top so the engine receives a fully-populated DecisionLogQueryFilter.
  fetchData = (params: PagerRequest) => {
    const baseFilter = (params.filter ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...baseFilter };
    if (this.decisionTypeFilter()) merged['decisionType'] = this.decisionTypeFilter();
    if (this.outcomeFilter()) merged['outcome'] = this.outcomeFilter();
    if (this.entityTypeFilter()) merged['entityType'] = this.entityTypeFilter();
    if (this.entityIdFilter() !== null) merged['entityId'] = this.entityIdFilter();
    const range = this.dateRangeFilter();
    if (range !== 'all') {
      const ms = range === '24h' ? DAY_MS : range === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
      merged['from'] = new Date(Date.now() - ms).toISOString();
    }
    return this.auditTrailService
      .list({ ...params, filter: Object.keys(merged).length > 0 ? merged : null })
      .pipe(
        map((response) => {
          if (response.data) return response.data;
          return {
            data: [],
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 0,
              pageSize: 25,
            },
          } as PagedData<DecisionLogDto>;
        }),
      );
  };

  toggleExpand(entry: DecisionLogDto): void {
    if (this.expandedEntry()?.id === entry.id) {
      this.expandedEntry.set(null);
    } else {
      this.expandedEntry.set(entry);
    }
  }

  formatJson(json: string | null): string {
    if (!json) return 'No context data';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
