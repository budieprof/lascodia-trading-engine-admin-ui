import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { CalibrationService } from '@core/services/calibration.service';
import type {
  CalibrationTrendReportDto,
  DefaultsCalibrationDto,
  PagedData,
  PagerRequest,
  ScreeningGateBindingReportDto,
  SignalRejectionEntryDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
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
          @if (trendLoading()) {
            <app-card-skeleton [lines]="8" />
          } @else if (trend()) {
            @if (trend(); as t) {
              <section class="card">
                <header class="card-head">
                  <h3>Anomalies vs {{ t.baselineMonths }}-month baseline</h3>
                </header>
                @if (t.anomalies.length > 0) {
                  <ul class="anomaly-list">
                    @for (a of t.anomalies; track a.metric) {
                      <li class="anomaly" [attr.data-sev]="a.severity ?? 'Info'">
                        <span class="metric">{{ a.metric }}</span>
                        <span class="delta" [class.up]="a.delta > 0" [class.down]="a.delta < 0"
                          >{{ a.delta >= 0 ? '+' : '' }}{{ a.delta }}</span
                        >
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
              <div class="grid">
                <section class="card">
                  <header class="card-head"><h3>Latest Month</h3></header>
                  <dl class="kv">
                    @for (e of kv(t.latestMonthMetrics); track e.key) {
                      <div>
                        <dt>{{ e.key }}</dt>
                        <dd class="mono">{{ e.value }}</dd>
                      </div>
                    }
                  </dl>
                </section>
                <section class="card">
                  <header class="card-head"><h3>Baseline</h3></header>
                  <dl class="kv">
                    @for (e of kv(t.baselineMetrics); track e.key) {
                      <div>
                        <dt>{{ e.key }}</dt>
                        <dd class="mono">{{ e.value }}</dd>
                      </div>
                    }
                  </dl>
                </section>
              </div>
            }
          } @else {
            <app-empty-state
              title="Trend report unavailable"
              description="The engine returned no calibration trend data."
            />
          }
        }

        @if (activeTab() === 'gates') {
          @if (gatesLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (gates()) {
            @if (gates(); as g) {
              <section class="card">
                <header class="card-head"><h3>Screening Gate Binding</h3></header>
                <table class="table">
                  <thead>
                    <tr>
                      <th>Gate</th>
                      <th class="num">Rejections</th>
                      <th class="num">Share</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of g.gates; track row.gate) {
                      <tr>
                        <td>{{ row.gate }}</td>
                        <td class="num">{{ row.rejectionCount }}</td>
                        <td class="num">{{ row.sharePct.toFixed(1) }}%</td>
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
        }

        @if (activeTab() === 'rejections') {
          <app-data-table
            #rejectionsTable
            [columnDefs]="rejectionColumns"
            [fetchData]="fetchRejections"
            [searchable]="true"
          />
        }

        @if (activeTab() === 'defaults') {
          @if (defaultsLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (defaults()) {
            @if (defaults(); as d) {
              <section class="card">
                <header class="card-head"><h3>Recommended Default Floors</h3></header>
                @if (d.recommendations.length > 0) {
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Current</th>
                        <th>Suggested</th>
                        <th>Rationale</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of d.recommendations; track r.key) {
                        <tr>
                          <td class="mono">{{ r.key }}</td>
                          <td class="mono">{{ r.current ?? '—' }}</td>
                          <td class="mono">{{ r.suggested ?? '—' }}</td>
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
        gap: var(--space-5);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
        margin-top: var(--space-4);
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
        padding: var(--space-3) var(--space-5);
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
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
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
        font-size: var(--text-sm);
        padding: var(--space-5);
        margin: 0;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
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

  kv(record: Record<string, number | string | null>): Array<{ key: string; value: string }> {
    return Object.entries(record).map(([key, value]) => ({
      key,
      value: value == null ? '—' : typeof value === 'number' ? String(value) : value,
    }));
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
