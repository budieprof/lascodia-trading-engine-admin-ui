import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';
import { catchError, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type {
  AlertSeverity,
  DriftAlertDto,
  DriftReportQueryFilter,
  PagedData,
  PagerRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  TimeRangePickerComponent,
  TimeRange,
} from '@shared/components/time-range-picker/time-range-picker.component';

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  Info: '#0A84FF',
  Medium: '#FF9500',
  High: '#FF3B30',
  Critical: '#D70015',
};

@Component({
  selector: 'app-drift-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    DataTableComponent,
    EmptyStateComponent,
    DatePipe,
    TimeRangePickerComponent,
    ChartCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Drift Report"
        subtitle="ML drift alerts across all detector families"
      />

      <!-- 8-card KPI strip — fleet-wide drift posture across the active range -->
      <div class="dr-kpis">
        <div class="dr-kpi">
          <span class="kpi-label">Total alerts</span>
          <span class="kpi-value">{{ driftStats().total }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Critical</span>
          <span class="kpi-value bad">{{ driftStats().critical }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">High</span>
          <span class="kpi-value warn">{{ driftStats().high }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Active</span>
          <span class="kpi-value">{{ driftStats().active }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Auto-resolved</span>
          <span class="kpi-value good">{{ driftStats().autoResolved }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Symbols hit</span>
          <span class="kpi-value">{{ driftStats().symbolCount }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Detectors firing</span>
          <span class="kpi-value">{{ driftStats().detectorCount }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Triggered &lt; 1h</span>
          <span
            class="kpi-value"
            [class.bad]="driftStats().lastHour > 0"
            [class.good]="driftStats().lastHour === 0"
          >
            {{ driftStats().lastHour }}
          </span>
        </div>
      </div>

      <!-- 3-col chart row -->
      <div class="dr-charts">
        <app-chart-card
          title="Severity distribution"
          subtitle="Critical · High · Medium · Info"
          [options]="severityDonutOptions()"
          height="240px"
        />
        <app-chart-card
          title="Top symbols by alert count"
          subtitle="Most-impacted instruments in this range"
          [options]="bySymbolOptions()"
          height="240px"
        />
        <app-chart-card
          title="By detector"
          subtitle="Which detectors are firing the most"
          [options]="byDetectorOptions()"
          height="240px"
        />
      </div>

      <!-- 2-col tables: per-detector breakdown + most-recently triggered list -->
      <div class="dr-board-row">
        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Per-detector severity</h3>
            <span class="muted">Severity counts grouped by detector family</span>
          </header>
          @if (perDetectorBreakdown().length > 0) {
            <table class="dr-board-table">
              <thead>
                <tr>
                  <th>Detector</th>
                  <th class="num">Total</th>
                  <th class="num">Critical</th>
                  <th class="num">High</th>
                  <th class="num">Med/Info</th>
                  <th class="num">Active %</th>
                </tr>
              </thead>
              <tbody>
                @for (row of perDetectorBreakdown(); track row.detector) {
                  <tr>
                    <td class="mono">{{ row.detector }}</td>
                    <td class="num mono">{{ row.total }}</td>
                    <td class="num mono bad">{{ row.critical }}</td>
                    <td class="num mono warn">{{ row.high }}</td>
                    <td class="num mono">{{ row.mediumOrInfo }}</td>
                    <td
                      class="num mono"
                      [class.bad]="row.activePct >= 50"
                      [class.good]="row.activePct === 0"
                    >
                      {{ row.activePct.toFixed(0) }}%
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted" style="padding: var(--space-4)">No alerts in this range.</p>
          }
        </section>

        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Most-recent firings</h3>
            <span class="muted">Last 10 in the active range</span>
          </header>
          @if (recentFirings().length > 0) {
            <table class="dr-board-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Detector</th>
                  <th>Severity</th>
                  <th>Last triggered</th>
                </tr>
              </thead>
              <tbody>
                @for (a of recentFirings(); track a.id) {
                  <tr (click)="selectRow(a)">
                    <td class="mono">{{ a.symbol ?? '—' }}</td>
                    <td class="mono">{{ a.detectorType ?? '—' }}</td>
                    <td>
                      <span
                        class="severity-pill"
                        [style.background]="severityBg(a.severity)"
                        [style.color]="severityColor(a.severity)"
                      >
                        {{ a.severity }}
                      </span>
                    </td>
                    <td class="mono">
                      {{ a.lastTriggeredAt ? (a.lastTriggeredAt | date: 'MMM d HH:mm:ss') : '—' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted" style="padding: var(--space-4)">No firings in this range.</p>
          }
        </section>
      </div>

      <section class="dr-board">
        <header class="dr-board-head">
          <h3>All drift alerts</h3>
          <span class="muted">Server-paged — filters apply to this table only</span>
        </header>
        <section class="filter-bar">
          <label class="filter">
            <span class="filter-label">Symbol</span>
            <input
              type="text"
              placeholder="e.g. EURUSD"
              [(ngModel)]="filterSymbol"
              (change)="reload()"
            />
          </label>
          <label class="filter">
            <span class="filter-label">Detector</span>
            <select [(ngModel)]="filterDetector" (change)="reload()">
              <option value="">All</option>
              <option value="DriftAgreement">DriftAgreement</option>
              <option value="CUSUM">CUSUM</option>
              <option value="Adwin">Adwin</option>
              <option value="CovariateShift">CovariateShift</option>
              <option value="MultiScale">MultiScale</option>
            </select>
          </label>
          <label class="filter">
            <span class="filter-label">Severity</span>
            <select [(ngModel)]="filterSeverity" (change)="reload()">
              <option value="">All</option>
              <option value="Info">Info</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </label>
          <label class="filter checkbox">
            <input type="checkbox" [(ngModel)]="unresolvedOnly" (change)="reload()" />
            <span>Unresolved only</span>
          </label>
          <div class="filter">
            <span class="filter-label">Range</span>
            <app-time-range-picker
              [(value)]="range"
              defaultPreset="7d"
              (valueChange)="onRangeChange($event)"
            />
          </div>
        </section>

        <app-data-table
          [columnDefs]="columns"
          [fetchData]="fetchPage"
          (rowClick)="selectRow($event)"
          stateKey="drift-report"
        />
      </section>

      @if (selected(); as alert) {
        <section class="detail">
          <header class="detail-head">
            <h3>Alert #{{ alert.id }} — {{ alert.symbol || '(no symbol)' }}</h3>
            <span
              class="severity-pill"
              [style.background]="severityBg(alert.severity)"
              [style.color]="severityColor(alert.severity)"
              >{{ alert.severity }}</span
            >
          </header>

          <dl class="detail-grid">
            <div>
              <dt>Detector</dt>
              <dd>{{ alert.detectorType || '—' }}</dd>
            </div>
            <div>
              <dt>Alert type</dt>
              <dd>{{ alert.alertType }}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{{ alert.isActive ? 'Yes' : 'No' }}</dd>
            </div>
            <div>
              <dt>Auto-resolved</dt>
              <dd>
                {{ alert.autoResolvedAt ? (alert.autoResolvedAt | date: 'MMM d, HH:mm:ss') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Last triggered</dt>
              <dd>
                {{
                  alert.lastTriggeredAt
                    ? (alert.lastTriggeredAt | date: 'MMM d, HH:mm:ss')
                    : 'Never'
                }}
              </dd>
            </div>
            <div>
              <dt>Cooldown</dt>
              <dd>{{ alert.cooldownSeconds }} s</dd>
            </div>
            <div class="full">
              <dt>Dedup key</dt>
              <dd class="mono">{{ alert.deduplicationKey || '—' }}</dd>
            </div>
          </dl>

          <details open>
            <summary>Condition payload</summary>
            <pre class="json">{{ formatJson(alert.conditionJson) }}</pre>
          </details>
        </section>
      } @else {
        <app-empty-state
          title="No alert selected"
          description="Click a row above to inspect the detector payload."
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
        gap: var(--space-5);
      }
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3) var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .filter {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 160px;
      }
      .filter.checkbox {
        flex-direction: row;
        align-items: center;
        gap: var(--space-2);
      }
      .filter-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .filter input[type='text'],
      .filter select {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .detail {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .detail-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .detail-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .severity-pill {
        padding: 4px var(--space-3);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .detail-grid > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .detail-grid .full {
        grid-column: 1 / -1;
      }
      .detail-grid dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .detail-grid dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .detail-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        word-break: break-all;
      }
      summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        padding: var(--space-2) 0;
      }
      .json {
        margin: var(--space-2) 0 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        max-height: 320px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* Drift Report density additions */
      .dr-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .dr-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .dr-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .dr-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dr-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .dr-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .dr-kpi .kpi-value.good {
        color: var(--profit);
      }
      .dr-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .dr-kpi .kpi-value.warn {
        color: #c93400;
      }

      .dr-charts {
        display: grid;
        grid-template-columns: 1fr 1fr 1.2fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .dr-charts {
          grid-template-columns: 1fr;
        }
      }

      .dr-board-row {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .dr-board-row {
          grid-template-columns: 1fr;
        }
      }

      .dr-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .dr-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .dr-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .dr-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .dr-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .dr-board-table th,
      .dr-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .dr-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .dr-board-table tbody tr {
        cursor: pointer;
        transition: background 0.1s;
      }
      .dr-board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .dr-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .dr-board-table th.num,
      .dr-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .dr-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .dr-board-table .bad {
        color: var(--loss);
      }
      .dr-board-table .good {
        color: var(--profit);
      }
      .dr-board-table .warn {
        color: #c93400;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      /* Filter bar inside the board no longer needs its own background */
      .dr-board > .filter-bar {
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--border);
        border-radius: 0;
      }
    `,
  ],
})
export class DriftReportPageComponent {
  private readonly mlService = inject(MLModelsService);

  filterSymbol = '';
  filterDetector = '';
  filterSeverity = '';
  unresolvedOnly = false;

  // Default 7d is computed lazily by the picker itself when left null, but
  // we seed a signal so the picker can emit into it via [(value)].
  readonly range = signal<TimeRange | null>(null);

  readonly selected = signal<DriftAlertDto | null>(null);
  private reloadTick = signal(0);

  // ── Analytics sample ─────────────────────────────────────────────────
  // Cap at 5000 to keep the browser snappy; the paged table below still
  // shows everything. KPIs/charts/tables compute over this sample, which
  // already represents the active filter range.
  readonly driftSample = signal<DriftAlertDto[]>([]);

  driftStats = computed(() => {
    const all = this.driftSample();
    if (all.length === 0) {
      return {
        total: 0,
        critical: 0,
        high: 0,
        active: 0,
        autoResolved: 0,
        symbolCount: 0,
        detectorCount: 0,
        lastHour: 0,
      };
    }
    let critical = 0;
    let high = 0;
    let active = 0;
    let autoResolved = 0;
    let lastHour = 0;
    const symbols = new Set<string>();
    const detectors = new Set<string>();
    const oneHourAgo = Date.now() - 3600_000;
    for (const a of all) {
      if (a.severity === 'Critical') critical++;
      else if (a.severity === 'High') high++;
      if (a.isActive) active++;
      if (a.autoResolvedAt) autoResolved++;
      if (a.symbol) symbols.add(a.symbol);
      if (a.detectorType) detectors.add(a.detectorType);
      if (a.lastTriggeredAt && new Date(a.lastTriggeredAt).getTime() >= oneHourAgo) lastHour++;
    }
    return {
      total: all.length,
      critical,
      high,
      active,
      autoResolved,
      symbolCount: symbols.size,
      detectorCount: detectors.size,
      lastHour,
    };
  });

  severityDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {
      Critical: 0,
      High: 0,
      Medium: 0,
      Info: 0,
    };
    for (const a of this.driftSample()) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    if (this.driftSample().length === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: Object.entries(counts)
            .map(([name, value]) => ({
              name,
              value,
              itemStyle: { color: SEVERITY_COLOR[name as AlertSeverity] ?? '#8E8E93' },
            }))
            .filter((d) => d.value > 0),
        },
      ],
    };
  });

  bySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const a of this.driftSample()) {
      const k = a.symbol ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 90 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#FF3B30', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  byDetectorOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const a of this.driftSample()) {
      const k = a.detectorType ?? 'unspecified';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 130 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  perDetectorBreakdown = computed(() => {
    type Row = {
      detector: string;
      total: number;
      critical: number;
      high: number;
      mediumOrInfo: number;
      active: number;
      activePct: number;
    };
    const groups: Record<string, Row> = {};
    for (const a of this.driftSample()) {
      const k = a.detectorType ?? 'unspecified';
      if (!groups[k])
        groups[k] = {
          detector: k,
          total: 0,
          critical: 0,
          high: 0,
          mediumOrInfo: 0,
          active: 0,
          activePct: 0,
        };
      const g = groups[k];
      g.total++;
      if (a.severity === 'Critical') g.critical++;
      else if (a.severity === 'High') g.high++;
      else g.mediumOrInfo++;
      if (a.isActive) g.active++;
    }
    return Object.values(groups)
      .map((g) => ({ ...g, activePct: g.total > 0 ? (g.active / g.total) * 100 : 0 }))
      .sort((a, b) => b.total - a.total);
  });

  recentFirings = computed(() =>
    [...this.driftSample()]
      .filter((a) => !!a.lastTriggeredAt)
      .sort(
        (a, b) => new Date(b.lastTriggeredAt!).getTime() - new Date(a.lastTriggeredAt!).getTime(),
      )
      .slice(0, 10),
  );

  constructor() {
    // Re-fetch the analytics sample whenever the filter range or any of the
    // filter inputs change. reloadTick already flips on every filter event,
    // so binding to it covers symbol/detector/severity/unresolvedOnly too.
    effect(() => {
      this.reloadTick();
      this.range();
      this.loadDriftAnalyticsSample();
    });
  }

  private loadDriftAnalyticsSample(): void {
    const r = this.range();
    const filter: DriftReportQueryFilter = {
      symbol: this.filterSymbol || undefined,
      detectorType: this.filterDetector || undefined,
      severity: this.filterSeverity || undefined,
      unresolvedOnly: this.unresolvedOnly || undefined,
      fromDate: r?.from ?? undefined,
      toDate: r?.to ?? undefined,
    };
    // Probe-and-fetch: read the true total from a 1-row query, then bring
    // back min(total, 5000) rows so the analytics panel always reflects
    // the same range as the table below — without unbounded fetches.
    this.mlService
      .listDriftReport({ currentPage: 1, itemCountPerPage: 1, filter })
      .pipe(catchError(() => of(null)))
      .subscribe((probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.driftSample.set([]);
          return;
        }
        this.mlService
          .listDriftReport({
            currentPage: 1,
            itemCountPerPage: Math.min(total, 5000),
            filter,
          })
          .pipe(catchError(() => of(null)))
          .subscribe((full) => {
            this.driftSample.set(full?.data?.data ?? []);
          });
      });
  }

  readonly columns: ColDef<DriftAlertDto>[] = [
    { headerName: 'ID', field: 'id', width: 90 },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    {
      headerName: 'Detector',
      field: 'detectorType',
      width: 160,
      valueFormatter: (p) => (p.value as string | null) ?? '—',
    },
    {
      headerName: 'Severity',
      field: 'severity',
      width: 120,
      cellRenderer: (p: { value: AlertSeverity }) => {
        const color = SEVERITY_COLOR[p.value] ?? 'currentColor';
        return `<span style="color: ${color}; font-weight: 600;">${p.value}</span>`;
      },
    },
    {
      headerName: 'Active',
      field: 'isActive',
      width: 90,
      valueFormatter: (p) => (p.value ? 'Yes' : 'No'),
    },
    {
      headerName: 'Last triggered',
      field: 'lastTriggeredAt',
      width: 200,
      valueFormatter: (p) => (p.value ? new Date(p.value as string).toLocaleString() : '—'),
    },
    {
      headerName: 'Auto-resolved',
      field: 'autoResolvedAt',
      width: 200,
      valueFormatter: (p) => (p.value ? new Date(p.value as string).toLocaleString() : '—'),
    },
  ];

  readonly fetchPage = (params: PagerRequest) => {
    // Touch reloadTick so changing filters re-runs the fetcher.
    this.reloadTick();
    const r = this.range();
    const filter: DriftReportQueryFilter = {
      symbol: this.filterSymbol || undefined,
      detectorType: this.filterDetector || undefined,
      severity: this.filterSeverity || undefined,
      unresolvedOnly: this.unresolvedOnly || undefined,
      fromDate: r?.from ?? undefined,
      toDate: r?.to ?? undefined,
    };
    return this.mlService
      .listDriftReport({
        currentPage: params.currentPage,
        itemCountPerPage: params.itemCountPerPage,
        filter,
      })
      .pipe(
        map((res): PagedData<DriftAlertDto> => res.data ?? this.emptyPage()),
        catchError(() => of(this.emptyPage())),
      );
  };

  reload(): void {
    // Force the table to refetch by bumping the tick and clearing selection.
    this.selected.set(null);
    this.reloadTick.update((n) => n + 1);
  }

  onRangeChange(_range: TimeRange | null): void {
    // Value is already written into `range` via the two-way model binding;
    // just nudge the table to refetch.
    this.reload();
  }

  selectRow(row: DriftAlertDto): void {
    this.selected.set(row);
  }

  severityColor(s: AlertSeverity): string {
    return SEVERITY_COLOR[s] ?? 'inherit';
  }

  severityBg(s: AlertSeverity): string {
    const color = SEVERITY_COLOR[s];
    return color ? `${color}1f` : 'transparent';
  }

  formatJson(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  private emptyPage(): PagedData<DriftAlertDto> {
    return {
      pager: {
        totalItemCount: 0,
        filter: null,
        currentPage: 1,
        itemCountPerPage: 25,
        pageNo: 1,
        pageSize: 25,
      },
      data: [],
    };
  }
}
