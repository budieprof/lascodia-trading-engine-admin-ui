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
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

import {
  FAILURE_OUTCOMES,
  OUTCOME_TONE_HEX,
  OUTCOME_TONE_VAR,
  POSITIVE_OUTCOMES,
  REFUSAL_OUTCOMES,
  escapeHtml,
  outcomeTone,
  type OutcomeTone,
} from './audit-trail.util';

type DateRange = 'all' | '24h' | '7d' | '30d';
type QuickFilter = 'all' | '24h' | 'critical' | 'kill' | 'ml';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
    ModalA11yDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Audit Trail" subtitle="Decision logs and system audit records" />

      <!-- KPI strip. "Total ever" is the whole table; every other tile is
           computed over the most recent sample (capped at 2,000 rows), so the
           scope is spelled out once under the strip rather than letting a
           sample-bounded "Last 7d = 2,000" sit beside a global 236,590.
           Colour is reserved for outcomes: green for approvals, amber for a gate
           saying no, red only for something that broke. -->
      <div class="kpis">
        <app-metric-card label="Total ever" [value]="totalEver()" format="number" />
        <app-metric-card
          label="Last 24h"
          [value]="last24hSaturated() ? null : last24hCount()"
          format="number"
        />
        <app-metric-card
          label="Approved / Executed"
          [value]="positiveCount()"
          format="number"
          [dotColor]="positiveCount() > 0 ? '#34C759' : ''"
        />
        <app-metric-card
          label="Rejected / Blocked"
          [value]="refusalCount()"
          format="number"
          [dotColor]="refusalCount() > 0 ? '#FF9500' : ''"
          caption="a gate said no"
        />
        <app-metric-card
          label="Failed / Critical"
          [value]="failureCount()"
          format="number"
          [dotColor]="failureCount() > 0 ? '#FF3B30' : '#34C759'"
          caption="something broke"
        />
        <app-metric-card label="Decision types" [value]="distinctDecisionTypes()" format="number" />
        <app-metric-card label="Sources" [value]="distinctSources()" format="number" />
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
          subtitle="Decisions per hour, local time"
          [options]="activityByHourOptions()"
          height="220px"
        />
      </div>

      <!-- Quick filter chips + labelled filter dropdowns + what is applied right now -->
      <div class="filter-bar">
        <div class="filter-row">
          <div class="seg" role="group" aria-label="Quick filters">
            @for (q of quickFilters; track q.value) {
              <button
                type="button"
                [class.on]="quickFilter() === q.value"
                [attr.aria-pressed]="quickFilter() === q.value"
                [title]="q.title"
                (click)="setQuickFilter(q.value)"
              >
                {{ q.label }}
              </button>
            }
          </div>

          <div class="selects">
            <label class="field">
              <span class="label">Decision type</span>
              <select
                class="input"
                [ngModel]="decisionTypeFilter()"
                (ngModelChange)="onFilterChange('decisionType', $event)"
              >
                <!-- The count beside "All" was the sample size (2,000), not a number of types, and it
                     was clipped to "(200(" by the select's width. -->
                <option value="">All decision types</option>
                @for (t of decisionTypeOptions(); track t.value) {
                  <option [value]="t.value">{{ t.value }} ({{ t.count }})</option>
                }
              </select>
            </label>
            <label class="field">
              <span class="label">Outcome</span>
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
            </label>
            <label class="field">
              <span class="label">Entity</span>
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
            </label>
            <label class="field">
              <span class="label">Period</span>
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
            </label>
          </div>
        </div>

        <!-- The entity-id filter set from a detail dialog had no visible trace: the table was
             narrowed with nothing on screen saying so. Every applied filter is listed here. -->
        @if (hasActiveFilters()) {
          <div class="active-filters" aria-label="Applied filters">
            <span>Showing only:</span>
            @if (decisionTypeFilter()) {
              <span class="chip"
                ><span class="k">Type</span> {{ decisionTypeFilter() }}
                <button
                  type="button"
                  aria-label="Remove decision type filter"
                  (click)="onFilterChange('decisionType', '')"
                >
                  &times;
                </button></span
              >
            }
            @if (outcomeFilter()) {
              <span class="chip"
                ><span class="k">Outcome</span> {{ outcomeFilter() }}
                <button
                  type="button"
                  aria-label="Remove outcome filter"
                  (click)="onFilterChange('outcome', '')"
                >
                  &times;
                </button></span
              >
            }
            @if (entityTypeFilter() || entityIdFilter() !== null) {
              <span class="chip"
                ><span class="k">Entity</span> {{ entityTypeFilter() || 'any' }}
                @if (entityIdFilter() !== null) {
                  #{{ entityIdFilter() }}
                }
                <button type="button" aria-label="Remove entity filter" (click)="clearEntity()">
                  &times;
                </button></span
              >
            }
            @if (dateRangeFilter() !== 'all') {
              <span class="chip"
                ><span class="k">Period</span> last {{ dateRangeFilter() }}
                <button
                  type="button"
                  aria-label="Remove period filter"
                  (click)="onFilterChange('dateRange', 'all')"
                >
                  &times;
                </button></span
              >
            }
            <button type="button" class="link-btn" (click)="resetFilters()">Reset filters</button>
          </div>
        }
      </div>

      <app-data-table
        #auditTable
        [columnDefs]="columns"
        [fetchData]="fetchData"
        [searchable]="true"
        emptyTitle="No decisions match"
        emptyDescription="Nothing in the audit log matches these filters and search."
        (rowClick)="toggleExpand($event)"
      />

      @if (expandedEntry(); as e) {
        <!-- Escape + focus come from appModalA11y: the overlay's (keydown.escape) never fired
             because focus stayed on the clicked row, outside the dialog. -->
        <div class="detail-overlay" role="presentation" (click)="expandedEntry.set(null)">
          <div
            class="detail-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-detail-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="expandedEntry.set(null)"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <div class="detail-header">
              <h3 class="detail-title" id="audit-detail-title">
                Decision Log #{{ e.id }}
                <span class="sub">{{ e.decisionType }} · {{ e.createdAt | relativeTime }}</span>
              </h3>
              <span [class]="'pill ' + toneOf(e.outcome)">{{ e.outcome ?? '—' }}</span>
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
              <dl class="detail-meta">
                <div class="meta-item wide">
                  <dt>Logged</dt>
                  <dd>
                    {{ e.createdAt | date: 'MMM d, yyyy HH:mm:ss' }}
                    <span class="meta-sub"
                      >local · {{ utcStamp(e.createdAt) }} · {{ e.createdAt | relativeTime }}</span
                    >
                  </dd>
                </div>
                <div class="meta-item">
                  <dt>Decision Type</dt>
                  <dd class="mono">{{ e.decisionType ?? '—' }}</dd>
                </div>
                <div class="meta-item">
                  <dt>Entity</dt>
                  <dd>{{ e.entityType ?? '—' }} #{{ e.entityId }}</dd>
                </div>
                <div class="meta-item">
                  <dt>Outcome</dt>
                  <dd>{{ e.outcome ?? '—' }}</dd>
                </div>
                <div class="meta-item">
                  <dt>Source</dt>
                  <dd class="mono">{{ e.source ?? '—' }}</dd>
                </div>
              </dl>
              <div class="detail-section">
                <h4 class="detail-label">Reason</h4>
                <p class="detail-value" [class.none]="!e.reason">
                  {{ e.reason || 'No reason recorded' }}
                </p>
              </div>
              <div class="detail-section">
                <div class="section-head">
                  <h4 class="detail-label">Context JSON</h4>
                  @if (e.contextJson) {
                    <button type="button" class="mini-btn" (click)="copyJson(e.contextJson)">
                      {{ copied() ? 'Copied' : 'Copy JSON' }}
                    </button>
                  }
                </div>
                <pre class="detail-json">{{ formatJson(e.contextJson) }}</pre>
              </div>
              <div class="related-bar">
                <button type="button" class="related-btn" (click)="filterByEntity(e)">
                  Filter to all decisions for {{ e.entityType }} #{{ e.entityId }}
                </button>
              </div>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './audit-trail-page.scss',
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
  readonly quickFilter = signal<QuickFilter>('all');

  /** "Critical" was labelled "Critical / Failed only" but has always filtered outcome = Critical alone. */
  readonly quickFilters: { value: QuickFilter; label: string; title: string }[] = [
    { value: 'all', label: 'All', title: 'Clear the decision type, outcome and period filters' },
    { value: '24h', label: 'Last 24h', title: 'Decisions logged in the last 24 hours' },
    { value: 'critical', label: 'Critical', title: 'Outcome = Critical' },
    { value: 'kill', label: 'Kill switches', title: 'Decision type = KillSwitchActivated' },
    { value: 'ml', label: 'ML model events', title: 'Decision type = ModelActivated' },
  ];

  readonly copied = signal(false);

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
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['auditDecisionLogged'],
    },
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

  /** A gate or check saying no — the system working, not breaking. */
  readonly refusalCount = computed(
    () => this.analyticsRows().filter((r) => REFUSAL_OUTCOMES.has(r.outcome ?? '')).length,
  );

  readonly failureCount = computed(
    () => this.analyticsRows().filter((r) => FAILURE_OUTCOMES.has(r.outcome ?? '')).length,
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
    const colorFor = (name: string): string =>
      name.startsWith('Other (') ? OUTCOME_TONE_HEX.grey : OUTCOME_TONE_HEX[outcomeTone(name)];
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

  setQuickFilter(value: QuickFilter): void {
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

  clearEntity(): void {
    this.entityTypeFilter.set('');
    this.entityIdFilter.set(null);
  }

  toneOf(outcome: string | null): OutcomeTone {
    return outcomeTone(outcome);
  }

  utcStamp(value: string): string {
    return value ? formatDate(value, 'yyyy-MM-dd HH:mm:ss', 'en-US', 'UTC') + ' UTC' : '—';
  }

  copyJson(json: string | null): void {
    const text = this.formatJson(json);
    void navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 1500);
      },
      () => undefined,
    );
  }

  filterByEntity(entry: DecisionLogDto): void {
    if (entry.entityType) this.entityTypeFilter.set(entry.entityType);
    this.entityIdFilter.set(entry.entityId);
    this.expandedEntry.set(null);
  }

  // ---------- Table column defs (unchanged outcome cell renderer) ----------

  columns: ColDef<DecisionLogDto>[] = [
    {
      headerName: 'Time (local)',
      field: 'createdAt',
      width: 200,
      sortable: true,
      // An audit trail needs the absolute time; the relative form and UTC are the tooltip.
      valueFormatter: (params) =>
        params.value ? formatDate(params.value, 'yyyy-MM-dd HH:mm:ss', 'en-US') : '—',
      tooltipValueGetter: (params) =>
        params.value
          ? `${this.relativeTimePipe.transform(params.value)} · ${this.utcStamp(params.value)}`
          : '',
      cellStyle: { fontVariantNumeric: 'tabular-nums' },
    },
    {
      headerName: 'Decision Type',
      field: 'decisionType',
      width: 160,
      tooltipField: 'decisionType',
    },
    { headerName: 'Entity Type', field: 'entityType', width: 124 },
    {
      headerName: 'Entity ID',
      field: 'entityId',
      width: 116,
      type: 'rightAligned',
      // Cells are flex: rightAligned alone does not move the text.
      cellStyle: { justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' },
    },
    {
      headerName: 'Outcome',
      field: 'outcome',
      width: 118,
      cellRenderer: (params: { value: string | null }) => {
        // Theme tones; a refusal (Rejected / Blocked) is amber, a failure red.
        const t = OUTCOME_TONE_VAR[outcomeTone(params.value)];
        return `<span style="background:color-mix(in srgb, var(${t}) 16%, transparent);color:var(${t});padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${escapeHtml(params.value ?? '—')}</span>`;
      },
    },
    {
      headerName: 'Source',
      field: 'source',
      width: 200,
      // Source names ("SignalOrderBridgeWorker") clipped at 130px with no
      // ellipsis; the grid's own cell truncation applies once the cell is
      // flex-sized, and the full value is the tooltip.
      tooltipField: 'source',
    },
    {
      // The reason is the evidence; it was only reachable through the dialog. One line here,
      // full text on hover and in Details.
      headerName: 'Reason',
      field: 'reason',
      flex: 1,
      minWidth: 220,
      tooltipField: 'reason',
      valueFormatter: (params) => (params.value ? String(params.value) : '—'),
      cellStyle: { color: 'var(--text-secondary)' },
    },
    {
      headerName: '',
      field: 'id',
      width: 86,
      sortable: false,
      cellRenderer: () => {
        return `<button data-action="expand" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:color-mix(in srgb, var(--tone-blue) 16%, transparent);color:var(--tone-blue)">Details</button>`;
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
