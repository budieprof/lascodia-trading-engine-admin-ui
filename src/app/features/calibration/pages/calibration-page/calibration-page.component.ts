import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of, switchMap, type Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { CalibrationService } from '@core/services/calibration.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type {
  CalibrationTrendReportDto,
  DefaultsCalibrationDto,
  PagedData,
  PagerRequest,
  ScreeningGateBindingReportDto,
  SignalRejectionEntryDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

@Component({
  selector: 'app-calibration-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    DataTableComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header title="Tuning" subtitle="Calibration reports and operator guidance" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'trend') {
          <div class="tab-content">
            @if (trendLoading()) {
              <app-card-skeleton [lines]="8" />
            } @else if (trend()) {
              @if (trend(); as t) {
                <!-- 6-card KPI strip — anomaly overview -->
                <div class="kpis kpis-6">
                  <app-metric-card
                    label="Metrics tracked"
                    [value]="metricsTrackedCount()"
                    format="number"
                    dotColor="#0071E3"
                  />
                  <app-metric-card
                    label="Anomalies"
                    [value]="t.anomalies?.length ?? 0"
                    format="number"
                    [dotColor]="(t.anomalies?.length ?? 0) > 0 ? '#FF3B30' : '#34C759'"
                  />
                  <app-metric-card
                    label="Critical"
                    [value]="anomalyCounts().Critical"
                    format="number"
                    [dotColor]="anomalyCounts().Critical > 0 ? '#FF3B30' : '#34C759'"
                  />
                  <app-metric-card
                    label="Warning"
                    [value]="anomalyCounts().Warning"
                    format="number"
                    [dotColor]="anomalyCounts().Warning > 0 ? '#FF9500' : '#34C759'"
                  />
                  <app-metric-card
                    label="Largest |Δ|"
                    [value]="largestAnomalyDelta()"
                    format="number"
                    dotColor="#AF52DE"
                  />
                  <app-metric-card
                    label="Baseline window"
                    [value]="t.baselineMonths"
                    format="number"
                    dotColor="#5AC8FA"
                  />
                </div>

                <!-- Anomalies + top deltas chart side-by-side -->
                <div class="trend-row">
                  <section class="card">
                    <header class="card-head">
                      <h3>Anomalies vs {{ t.baselineMonths }}-month baseline</h3>
                      @if ((t.anomalies?.length ?? 0) > 0) {
                        <span class="head-meta muted">
                          {{ anomalyCounts().Critical }} critical ·
                          {{ anomalyCounts().Warning }} warning · {{ anomalyCounts().Info }} info
                        </span>
                      }
                    </header>
                    @if ((t.anomalies?.length ?? 0) > 0) {
                      <ul class="anomaly-list">
                        @for (a of sortedAnomalies(); track a.metric) {
                          <li class="anomaly" [attr.data-sev]="a.severity ?? 'Info'">
                            <span class="metric">{{ a.metric }}</span>
                            <span class="delta" [class.up]="a.delta > 0" [class.down]="a.delta < 0">
                              {{ a.delta >= 0 ? '+' : '' }}{{ a.delta }}
                            </span>
                            @if (a.severity) {
                              <span class="sev">{{ a.severity }}</span>
                            }
                            @if (a.note) {
                              <span class="note">{{ a.note }}</span>
                            }
                          </li>
                        }
                      </ul>
                    } @else {
                      <p class="muted">No anomalies detected against baseline.</p>
                    }
                  </section>

                  <app-chart-card
                    title="Largest deltas vs baseline"
                    subtitle="Top {{ topDeltasCount() }} metrics by |delta|"
                    [options]="topDeltasOptions()"
                    height="320px"
                  />
                </div>

                <!-- Side-by-side comparison with explicit delta column -->
                <section class="card">
                  <header class="card-head">
                    <h3>Latest month vs baseline</h3>
                    <span class="head-meta muted">
                      {{ metricsTrackedCount() }} metrics ·
                      {{ comparisonRows().length - metricsTrackedCount() }} added/removed
                    </span>
                  </header>
                  <div class="cmp-scroll">
                    <table class="table sticky">
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th class="num">Latest month</th>
                          <th class="num">Baseline</th>
                          <th class="num">Δ absolute</th>
                          <th class="num">Δ %</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (row of comparisonRows(); track row.key) {
                          <tr>
                            <td>{{ row.key }}</td>
                            <td class="num mono">{{ row.latestStr }}</td>
                            <td class="num mono">{{ row.baselineStr }}</td>
                            <td
                              class="num mono"
                              [class.up]="row.deltaAbs !== null && row.deltaAbs > 0"
                              [class.down]="row.deltaAbs !== null && row.deltaAbs < 0"
                            >
                              {{ formatDelta(row.deltaAbs) }}
                            </td>
                            <td
                              class="num mono"
                              [class.up]="row.deltaPct !== null && row.deltaPct > 0"
                              [class.down]="row.deltaPct !== null && row.deltaPct < 0"
                            >
                              {{ formatDeltaPct(row.deltaPct) }}
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                </section>
              }
            } @else {
              <app-empty-state
                title="Trend report unavailable"
                description="The engine returned no calibration trend data."
              />
            }
          </div>
        }

        @if (activeTab() === 'gates') {
          <div class="tab-content">
            @if (gatesLoading()) {
              <app-card-skeleton [lines]="6" />
            } @else if (gates()) {
              @if (gates(); as g) {
                <!-- 4-card KPI strip -->
                <div class="kpis kpis-4">
                  <app-metric-card
                    label="Total rejections"
                    [value]="totalGateRejections()"
                    format="number"
                    dotColor="#0071E3"
                  />
                  <app-metric-card
                    label="Active gates"
                    [value]="g.gates?.length ?? 0"
                    format="number"
                    dotColor="#5AC8FA"
                  />
                  <app-metric-card
                    label="Top gate share"
                    [value]="topGateShare()"
                    format="percent"
                    [dotColor]="topGateShare() > 60 ? '#FF9500' : '#34C759'"
                  />
                  <app-metric-card
                    label="Gates with notes"
                    [value]="gatesWithNotesCount()"
                    format="number"
                    dotColor="#AF52DE"
                  />
                </div>

                <div class="gates-row">
                  <app-chart-card
                    title="Rejection share by gate"
                    subtitle="Where signals are getting blocked"
                    [options]="gateDonutOptions()"
                    height="280px"
                  />
                  <app-chart-card
                    title="Top gates by rejections"
                    subtitle="Largest contributors first"
                    [options]="gateBarOptions()"
                    height="280px"
                  />
                </div>

                <section class="card">
                  <header class="card-head">
                    <h3>Screening gate binding</h3>
                    <span class="head-meta muted">
                      Concentration:
                      <span [class.bad]="topGateShare() > 80">
                        {{ topGateShare().toFixed(1) }}%
                      </span>
                      of rejections from a single gate
                    </span>
                  </header>
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Gate</th>
                        <th class="num">Rejections</th>
                        <th class="num">Share</th>
                        <th>Distribution</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of g.gates ?? []; track row.gate) {
                        <tr>
                          <td class="mono">{{ row.gate }}</td>
                          <td class="num">{{ row.rejectionCount }}</td>
                          <td
                            class="num"
                            [class.warn]="(row.sharePct ?? 0) > 40"
                            [class.bad]="(row.sharePct ?? 0) > 70"
                          >
                            {{ (row.sharePct ?? 0).toFixed(1) }}%
                          </td>
                          <td class="bar-cell">
                            <span
                              class="share-bar"
                              [style.width.%]="row.sharePct ?? 0"
                              [class.warn]="(row.sharePct ?? 0) > 40"
                              [class.bad]="(row.sharePct ?? 0) > 70"
                            ></span>
                          </td>
                          <td class="muted">{{ row.notes ?? '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </section>
              }
            } @else {
              <app-empty-state
                title="Gate report unavailable"
                description="No screening-gate binding data returned."
              />
            }
          </div>
        }

        @if (activeTab() === 'rejections') {
          <div class="tab-content">
            <!-- 6-card KPI strip — analytics over recent rejections -->
            <div class="kpis kpis-6">
              <app-metric-card
                label="Total ever"
                [value]="rejectionTotalEver()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="In sample"
                [value]="rejectionAnalyticsRows().length"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Distinct rules"
                [value]="distinctRules().length"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Distinct strategies"
                [value]="distinctStrategies()"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Distinct symbols"
                [value]="distinctSymbols().length"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Last 24h"
                [value]="rejectionsLast24h()"
                format="number"
                [dotColor]="rejectionsLast24h() > 0 ? '#FF9500' : '#34C759'"
              />
            </div>

            <div class="rej-row">
              <app-chart-card
                title="Top rejection rules"
                subtitle="Most-active rules in the {{ rejectionAnalyticsRows().length }}-row sample"
                [options]="topRulesOptions()"
                height="260px"
              />
              <app-chart-card
                title="Top rejected symbols"
                subtitle="Symbols where signals are getting blocked"
                [options]="topSymbolsOptions()"
                height="260px"
              />
            </div>

            <app-data-table
              #rejectionsTable
              [columnDefs]="rejectionColumns"
              [fetchData]="fetchRejections"
              [searchable]="true"
            />
          </div>
        }

        @if (activeTab() === 'defaults') {
          <div class="tab-content">
            @if (defaultsLoading()) {
              <app-card-skeleton [lines]="6" />
            } @else if (defaults()) {
              @if (defaults(); as d) {
                <!-- 4-card KPI strip -->
                <div class="kpis kpis-4">
                  <app-metric-card
                    label="Recommendations"
                    [value]="d.recommendations?.length ?? 0"
                    format="number"
                    [dotColor]="(d.recommendations?.length ?? 0) > 0 ? '#FF9500' : '#34C759'"
                  />
                  <app-metric-card
                    label="Numeric diffs"
                    [value]="numericRecommendations()"
                    format="number"
                    dotColor="#5AC8FA"
                  />
                  <app-metric-card
                    label="Avg |Δ %|"
                    [value]="avgRecommendationDeltaPct()"
                    format="percent"
                    dotColor="#AF52DE"
                  />
                  <app-metric-card
                    label="Largest |Δ %|"
                    [value]="largestRecommendationDeltaPct()"
                    format="percent"
                    [dotColor]="largestRecommendationDeltaPct() > 50 ? '#FF3B30' : '#FF9500'"
                  />
                </div>

                <section class="card">
                  <header class="card-head">
                    <h3>Recommended default floors</h3>
                    <span class="head-meta muted">
                      Suggestions are read-only — apply via Engine Config
                    </span>
                  </header>
                  @if ((d.recommendations?.length ?? 0) > 0) {
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th class="num">Current</th>
                          <th class="num">Suggested</th>
                          <th class="num">Δ</th>
                          <th class="num">Δ %</th>
                          <th>Rationale</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (r of recommendationRows(); track r.key) {
                          <tr>
                            <td class="mono">{{ r.key }}</td>
                            <td class="num mono">{{ r.currentStr }}</td>
                            <td class="num mono">{{ r.suggestedStr }}</td>
                            <td
                              class="num mono"
                              [class.up]="r.delta !== null && r.delta > 0"
                              [class.down]="r.delta !== null && r.delta < 0"
                            >
                              {{ formatDelta(r.delta) }}
                            </td>
                            <td
                              class="num mono"
                              [class.up]="r.deltaPct !== null && r.deltaPct > 0"
                              [class.down]="r.deltaPct !== null && r.deltaPct < 0"
                            >
                              {{ formatDeltaPct(r.deltaPct) }}
                            </td>
                            <td class="muted">{{ r.rationale ?? '—' }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else {
                    <p class="muted">
                      No recommendations at this time — all floors within empirical ranges.
                    </p>
                  }
                </section>
              }
            } @else {
              <app-empty-state
                title="Defaults unavailable"
                description="No defaults-calibration recommendations returned."
              />
            }
          </div>
        }
      </ui-tabs>
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
      /* Each tab's body — flex column with consistent gap. The .page-level
         flex gap can't reach into ui-tabs' projected slot, so every tab
         needs its own wrapper to space sections evenly. */
      .tab-content {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding-top: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1024px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .kv {
        display: flex;
        flex-direction: column;
        gap: 0;
        margin: 0;
      }
      .kv > div {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .kv > div:last-child {
        border-bottom: none;
      }
      .kv dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .kv dd {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .kv dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .anomaly-list {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .anomaly {
        display: grid;
        grid-template-columns: 1fr auto auto 2fr;
        gap: var(--space-3);
        align-items: center;
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .anomaly:last-child {
        border-bottom: none;
      }
      .anomaly .metric {
        font-weight: var(--font-semibold);
      }
      .anomaly .delta {
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
      }
      .anomaly .delta.up {
        color: var(--profit);
      }
      .anomaly .delta.down {
        color: var(--loss);
      }
      .anomaly .sev {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .anomaly[data-sev='Critical'] .sev {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .anomaly[data-sev='Warning'] .sev {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .anomaly .note {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        padding: var(--space-4);
        margin: 0;
      }
      .head-meta.muted {
        padding: 0;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .table tbody tr:last-child td {
        border-bottom: none;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .table th.num,
      .table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }

      /* KPI strips */
      .kpis {
        display: grid;
        gap: var(--space-2);
      }
      .kpis.kpis-4 {
        grid-template-columns: repeat(4, 1fr);
      }
      .kpis.kpis-6 {
        grid-template-columns: repeat(6, 1fr);
      }
      @media (max-width: 1100px) {
        .kpis.kpis-4 {
          grid-template-columns: repeat(2, 1fr);
        }
        .kpis.kpis-6 {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpis.kpis-4,
        .kpis.kpis-6 {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* Side-by-side row of anomalies + chart on the trend tab */
      .trend-row {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .trend-row {
          grid-template-columns: 1fr;
        }
      }

      /* Gates row + rejections row */
      .gates-row,
      .rej-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .gates-row,
        .rej-row {
          grid-template-columns: 1fr;
        }
      }

      .head-meta {
        margin-left: auto;
        font-size: 11px;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
      }

      /* Comparison table — bounded scroll, sticky header */
      .cmp-scroll {
        max-height: 480px;
        overflow-y: auto;
      }
      .table.sticky thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .table .up {
        color: var(--profit);
      }
      .table .down {
        color: var(--loss);
      }
      .table .warn {
        color: #c93400;
      }
      .table .bad {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }

      /* Inline share-bar for gates table */
      .bar-cell {
        width: 200px;
        padding: 0 var(--space-3);
      }
      .share-bar {
        display: block;
        height: 8px;
        border-radius: 4px;
        background: rgba(0, 113, 227, 0.6);
        min-width: 2px;
      }
      .share-bar.warn {
        background: #ff9500;
      }
      .share-bar.bad {
        background: #ff3b30;
      }
    `,
  ],
})
export class CalibrationPageComponent {
  private readonly service = inject(CalibrationService);
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('rejectionsTable') rejectionsTable?: DataTableComponent<SignalRejectionEntryDto>;

  readonly tabs: TabItem[] = [
    { label: 'Trend', value: 'trend' },
    { label: 'Screening Gates', value: 'gates' },
    { label: 'Signal Rejections', value: 'rejections' },
    { label: 'Recommended Defaults', value: 'defaults' },
  ];
  readonly activeTab = signal('trend');

  readonly trend = signal<CalibrationTrendReportDto | null>(null);
  readonly gates = signal<ScreeningGateBindingReportDto | null>(null);
  readonly defaults = signal<DefaultsCalibrationDto | null>(null);
  readonly trendLoading = signal(true);
  readonly gatesLoading = signal(true);
  readonly defaultsLoading = signal(true);

  readonly rejectionColumns: ColDef<SignalRejectionEntryDto>[] = [
    { headerName: 'Signal', field: 'tradeSignalId', width: 110 },
    { headerName: 'Rule', field: 'ruleId', width: 180 },
    { headerName: 'Reason', field: 'reason', flex: 2, minWidth: 260 },
    { headerName: 'Strategy', field: 'strategyId', width: 110 },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    {
      headerName: 'Rejected',
      field: 'rejectedAt',
      width: 180,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm:ss') ?? '-',
    },
  ];

  readonly fetchRejections = (
    params: PagerRequest,
  ): Observable<PagedData<SignalRejectionEntryDto>> =>
    this.service
      .listSignalRejections(params)
      .pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  constructor() {
    this.service
      .getTrendReport()
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as CalibrationTrendReportDto | null)),
      )
      .subscribe((data) => {
        this.trend.set(data);
        this.trendLoading.set(false);
      });

    this.service
      .getScreeningGateBinding()
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as ScreeningGateBindingReportDto | null)),
      )
      .subscribe((data) => {
        this.gates.set(data);
        this.gatesLoading.set(false);
      });

    this.service
      .getDefaultsCalibration()
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as DefaultsCalibrationDto | null)),
      )
      .subscribe((data) => {
        this.defaults.set(data);
        this.defaultsLoading.set(false);
      });
  }

  kv(
    record: Record<string, number | string | null> | null | undefined,
  ): Array<{ key: string; value: string }> {
    if (!record) return [];
    return Object.entries(record).map(([key, value]) => ({
      key,
      value: value == null ? '—' : typeof value === 'number' ? String(value) : value,
    }));
  }

  // ---------- Trend tab computeds ----------

  readonly anomalyCounts = computed<{ Critical: number; Warning: number; Info: number }>(() => {
    let critical = 0;
    let warning = 0;
    let info = 0;
    for (const a of this.trend()?.anomalies ?? []) {
      const sev = a.severity ?? 'Info';
      if (sev === 'Critical') critical++;
      else if (sev === 'Warning') warning++;
      else info++;
    }
    return { Critical: critical, Warning: warning, Info: info };
  });

  readonly metricsTrackedCount = computed(() => {
    const t = this.trend();
    if (!t) return 0;
    const set = new Set<string>([
      ...Object.keys(t.latestMonthMetrics ?? {}),
      ...Object.keys(t.baselineMetrics ?? {}),
    ]);
    return set.size;
  });

  readonly largestAnomalyDelta = computed(() => {
    const anomalies = this.trend()?.anomalies ?? [];
    let largest = 0;
    for (const a of anomalies) {
      if (Math.abs(a.delta) > Math.abs(largest)) largest = a.delta;
    }
    return largest;
  });

  // Anomalies sorted Critical → Warning → Info, then by |delta| descending so
  // the most operationally-relevant anomalies surface at the top.
  readonly sortedAnomalies = computed(() => {
    const anomalies = this.trend()?.anomalies ?? [];
    const rank: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
    return [...anomalies].sort((a, b) => {
      const sa = rank[a.severity ?? 'Info'] ?? 99;
      const sb = rank[b.severity ?? 'Info'] ?? 99;
      if (sa !== sb) return sa - sb;
      return Math.abs(b.delta) - Math.abs(a.delta);
    });
  });

  // Side-by-side metric comparison table — full union of latest + baseline
  // keys, with absolute and percent deltas where both are numeric.
  readonly comparisonRows = computed(() => {
    const t = this.trend();
    if (!t) return [];
    const keys = new Set<string>([
      ...Object.keys(t.latestMonthMetrics ?? {}),
      ...Object.keys(t.baselineMetrics ?? {}),
    ]);
    return Array.from(keys)
      .map((key) => {
        const latest = t.latestMonthMetrics?.[key] ?? null;
        const baseline = t.baselineMetrics?.[key] ?? null;
        const latestNum = typeof latest === 'number' ? latest : null;
        const baselineNum = typeof baseline === 'number' ? baseline : null;
        const deltaAbs =
          latestNum !== null && baselineNum !== null ? latestNum - baselineNum : null;
        const deltaPct =
          latestNum !== null && baselineNum !== null && baselineNum !== 0
            ? ((latestNum - baselineNum) / Math.abs(baselineNum)) * 100
            : null;
        return {
          key,
          latestStr: latest == null ? '—' : String(latest),
          baselineStr: baseline == null ? '—' : String(baseline),
          deltaAbs,
          deltaPct,
        };
      })
      .sort((a, b) => {
        // Rows with the largest |Δ %| float to the top — that's where the
        // calibration drift is most pronounced. Non-numeric rows fall to the
        // bottom so they don't crowd out the actionable signal.
        const ax = a.deltaPct === null ? -1 : Math.abs(a.deltaPct);
        const bx = b.deltaPct === null ? -1 : Math.abs(b.deltaPct);
        if (bx !== ax) return bx - ax;
        return a.key.localeCompare(b.key);
      });
  });

  readonly topDeltasCount = computed(() =>
    Math.min(10, this.comparisonRows().filter((r) => r.deltaPct !== null).length),
  );

  readonly topDeltasOptions = computed<EChartsOption>(() => {
    const rows = this.comparisonRows()
      .filter((r) => r.deltaPct !== null)
      .slice(0, 10);
    if (rows.length === 0) {
      return {
        title: {
          text: 'No numeric metrics to compare',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>Δ ${p.value > 0 ? '+' : ''}${p.value.toFixed(2)}%`;
        },
      },
      grid: { top: 10, right: 50, bottom: 30, left: 140 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.key).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: Number(((r.deltaPct ?? 0) as number).toFixed(2)),
              itemStyle: {
                color: (r.deltaPct ?? 0) >= 0 ? '#34C759' : '#FF3B30',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 12,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (params: any) => `${params.value > 0 ? '+' : ''}${params.value.toFixed(1)}%`,
          },
        },
      ],
    };
  });

  // ---------- Gates tab computeds ----------

  readonly totalGateRejections = computed(() =>
    (this.gates()?.gates ?? []).reduce((s, g) => s + (g.rejectionCount ?? 0), 0),
  );

  readonly topGateShare = computed(() => {
    const gates = this.gates()?.gates ?? [];
    if (gates.length === 0) return 0;
    return Math.max(...gates.map((g) => g.sharePct ?? 0));
  });

  readonly gatesWithNotesCount = computed(
    () => (this.gates()?.gates ?? []).filter((g) => !!g.notes).length,
  );

  readonly gateDonutOptions = computed<EChartsOption>(() => {
    const gates = (this.gates()?.gates ?? []).filter((g) => g.rejectionCount > 0);
    if (gates.length === 0) {
      return {
        title: {
          text: 'No rejections recorded',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#34C759', fontWeight: 'normal' },
        },
      };
    }
    const palette = [
      '#0071E3',
      '#5AC8FA',
      '#34C759',
      '#FF9500',
      '#FF3B30',
      '#AF52DE',
      '#FFCC00',
      '#8E8E93',
    ];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: {
        bottom: 0,
        type: 'scroll',
        textStyle: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: gates.map((g, i) => ({
            name: g.gate,
            value: g.rejectionCount,
            itemStyle: { color: palette[i % palette.length] },
          })),
        },
      ],
    };
  });

  readonly gateBarOptions = computed<EChartsOption>(() => {
    const gates = [...(this.gates()?.gates ?? [])]
      .sort((a, b) => (b.rejectionCount ?? 0) - (a.rejectionCount ?? 0))
      .slice(0, 10);
    if (gates.length === 0) return {};
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
        data: gates.map((g) => g.gate).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: gates
            .map((g) => ({
              value: g.rejectionCount,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // ---------- Rejections tab analytics ----------
  // Probe-and-fetch up to 1000 most-recent rejections so the KPIs and top-N
  // charts reflect the live engine, not just whatever page the user happens
  // to be viewing in the data table. Polled every 60s.
  private readonly rejectionAnalyticsResource = createPolledResource(
    () =>
      this.service.listSignalRejections({ currentPage: 1, itemCountPerPage: 1, filter: null }).pipe(
        switchMap((probe) => {
          const total = probe.data?.pager?.totalItemCount ?? 0;
          const limit = Math.min(total, 1000);
          if (limit === 0) return of({ rows: [] as SignalRejectionEntryDto[], total });
          return this.service
            .listSignalRejections({ currentPage: 1, itemCountPerPage: limit, filter: null })
            .pipe(map((r) => ({ rows: r.data?.data ?? [], total })));
        }),
        catchError(() => of({ rows: [] as SignalRejectionEntryDto[], total: 0 })),
      ),
    { intervalMs: 60_000 },
  );

  readonly rejectionAnalyticsRows = computed(
    () => this.rejectionAnalyticsResource.value()?.rows ?? [],
  );
  readonly rejectionTotalEver = computed(() => this.rejectionAnalyticsResource.value()?.total ?? 0);

  readonly distinctRules = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.rejectionAnalyticsRows()) {
      if (!r.ruleId) continue;
      counts.set(r.ruleId, (counts.get(r.ruleId) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count);
  });

  readonly distinctSymbols = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.rejectionAnalyticsRows()) {
      if (!r.symbol) continue;
      counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count);
  });

  readonly distinctStrategies = computed(() => {
    const set = new Set<number>();
    for (const r of this.rejectionAnalyticsRows()) {
      if (r.strategyId != null) set.add(r.strategyId);
    }
    return set.size;
  });

  readonly rejectionsLast24h = computed(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.rejectionAnalyticsRows().filter((r) => new Date(r.rejectedAt).getTime() > cutoff)
      .length;
  });

  readonly topRulesOptions = computed<EChartsOption>(() => {
    const rows = this.distinctRules().slice(0, 10);
    if (rows.length === 0) {
      return {
        title: {
          text: 'No rejections in sample',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#34C759', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 50, bottom: 30, left: 150 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.rule).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.count,
              itemStyle: { color: '#FF3B30', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly topSymbolsOptions = computed<EChartsOption>(() => {
    const rows = this.distinctSymbols().slice(0, 10);
    if (rows.length === 0) {
      return {
        title: {
          text: 'No rejections in sample',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 50, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.symbol).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.count,
              itemStyle: { color: '#FF9500', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // ---------- Defaults tab computeds ----------

  readonly recommendationRows = computed(() => {
    const recs = this.defaults()?.recommendations ?? [];
    return recs.map((r) => {
      const cur = typeof r.current === 'number' ? r.current : null;
      const sug = typeof r.suggested === 'number' ? r.suggested : null;
      const delta = cur !== null && sug !== null ? sug - cur : null;
      const deltaPct =
        cur !== null && sug !== null && cur !== 0 ? ((sug - cur) / Math.abs(cur)) * 100 : null;
      return {
        key: r.key,
        currentStr: r.current == null ? '—' : String(r.current),
        suggestedStr: r.suggested == null ? '—' : String(r.suggested),
        delta,
        deltaPct,
        rationale: r.rationale,
      };
    });
  });

  readonly numericRecommendations = computed(
    () => this.recommendationRows().filter((r) => r.delta !== null).length,
  );

  readonly avgRecommendationDeltaPct = computed(() => {
    const pcts = this.recommendationRows()
      .map((r) => r.deltaPct)
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .map((v) => Math.abs(v));
    if (pcts.length === 0) return 0;
    return pcts.reduce((s, v) => s + v, 0) / pcts.length;
  });

  readonly largestRecommendationDeltaPct = computed(() => {
    const pcts = this.recommendationRows()
      .map((r) => r.deltaPct)
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .map((v) => Math.abs(v));
    if (pcts.length === 0) return 0;
    return Math.max(...pcts);
  });

  // ---------- Shared formatting helpers ----------

  formatDelta(v: number | null): string {
    if (v === null) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}`;
  }

  formatDeltaPct(v: number | null): string {
    if (v === null) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
  }
}

function emptyPager() {
  return {
    totalItemCount: 0,
    filter: null,
    currentPage: 1,
    itemCountPerPage: 25,
    pageNo: 1,
    pageSize: 25,
  };
}
