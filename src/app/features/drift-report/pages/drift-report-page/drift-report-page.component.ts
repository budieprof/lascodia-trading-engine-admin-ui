import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
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

/** Display order for severities wherever they are listed side by side. */
const SEVERITY_ORDER: AlertSeverity[] = ['Critical', 'High', 'Medium', 'Info'];

/**
 * The engine emits fleet-wide drift alerts under the symbol sentinel "ALL"
 * and some detectors emit with no symbol at all. Neither is an instrument, so
 * they must not count towards "symbols hit" — but they still carry alerts the
 * operator needs to see, hence they get their own labelled entries instead of
 * being dropped.
 */
const FLEET_WIDE_SYMBOL = 'ALL';
const FLEET_WIDE_LABEL = 'Fleet-wide (ALL)';
const NO_SYMBOL_LABEL = 'No symbol';
const NO_DETECTOR_LABEL = 'No detector recorded';
const SENTINEL_COLOR = '#8E8E93';

/** Analytics sample cap — keeps the browser snappy on large ranges. */
const SAMPLE_CAP = 5000;

const DAY_MS = 24 * 3600 * 1000;

/** One date format for the whole page; timestamps are rendered in UTC. */
const DATE_FMT = 'd MMM yyyy, HH:mm:ss';

const numberFmt = new Intl.NumberFormat('en-US');
const fmt = (n: number): string => numberFmt.format(n);

function symbolLabel(symbol: string | null): string {
  if (!symbol || symbol.toLowerCase() === 'unknown') return NO_SYMBOL_LABEL;
  if (symbol === FLEET_WIDE_SYMBOL) return FLEET_WIDE_LABEL;
  return symbol;
}

function isRealSymbol(symbol: string | null): boolean {
  return !!symbol && symbol.toLowerCase() !== 'unknown' && symbol !== FLEET_WIDE_SYMBOL;
}

function detectorLabel(detector: string | null): string {
  return detector || NO_DETECTOR_LABEL;
}

/**
 * Mirrors the picker's "7d" preset. The picker computes its default lazily and
 * never writes it back, so a null seed would leave the table and analytics
 * unbounded while the picker *displays* 7d — the two would disagree on load.
 */
function defaultRange(): TimeRange {
  return { preset: '7d', from: new Date(Date.now() - 7 * DAY_MS).toISOString(), to: null };
}

type SeverityCounts = Record<AlertSeverity, number>;

function emptySeverityCounts(): SeverityCounts {
  return { Critical: 0, High: 0, Medium: 0, Info: 0 };
}

@Component({
  selector: 'app-drift-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    DataTableComponent,
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

      <!-- KPI strip — fleet-wide drift posture across the active range -->
      <div class="dr-kpis">
        <div class="dr-kpi">
          <span class="kpi-label">Total alerts</span>
          <span class="kpi-value">{{ fmt(driftStats().total) }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Critical</span>
          <span class="kpi-value" [class.bad]="driftStats().critical > 0">
            {{ fmt(driftStats().critical) }}
          </span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">High</span>
          <span class="kpi-value" [class.warn]="driftStats().high > 0">
            {{ fmt(driftStats().high) }}
          </span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Active</span>
          <span class="kpi-value">{{ fmt(driftStats().active) }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Symbols hit</span>
          <span class="kpi-value">{{ fmt(driftStats().symbolCount) }}</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Triggered &lt; 1h</span>
          <span class="kpi-value" [class.bad]="driftStats().lastHour > 0">
            {{ fmt(driftStats().lastHour) }}
          </span>
        </div>
      </div>
      @if (sampleCapped()) {
        <p class="note">
          Tiles, charts and breakdowns cover the first {{ fmt(sampleCap) }} of
          {{ fmt(sampleTotal()) }} alerts in this range; the table below pages through all of them.
        </p>
      }

      <!-- 3-col chart row -->
      <div class="dr-charts">
        <app-chart-card
          title="Severity distribution"
          [subtitle]="severitySubtitle()"
          [options]="severityBarOptions()"
          height="240px"
        />
        <app-chart-card
          title="Top symbols by alert count"
          subtitle="Fleet-wide and symbol-less alerts listed separately"
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
                  @for (lvl of severityLevels(); track lvl) {
                    <th class="num">{{ lvl }}</th>
                  }
                  <th class="num">Active %</th>
                </tr>
              </thead>
              <tbody>
                @for (row of perDetectorBreakdown(); track row.detector) {
                  <tr>
                    <td class="mono">{{ row.detector }}</td>
                    <td class="num mono">{{ fmt(row.total) }}</td>
                    @for (lvl of severityLevels(); track lvl) {
                      <td
                        class="num mono"
                        [class.bad]="lvl === 'Critical' && row.counts[lvl] > 0"
                        [class.warn]="lvl === 'High' && row.counts[lvl] > 0"
                      >
                        {{ fmt(row.counts[lvl]) }}
                      </td>
                    }
                    <td class="num mono" [class.bad]="row.activePct >= 50">
                      {{ row.activePct.toFixed(0) }}%
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted board-empty">No alerts in this range.</p>
          }
        </section>

        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Most-recent firings</h3>
            <span class="muted">Last 10 in the active range · times in UTC</span>
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
                    <td class="mono">{{ symbolLabel(a.symbol) }}</td>
                    <td class="mono">{{ detectorLabel(a.detectorType) }}</td>
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
                      {{ a.lastTriggeredAt ? (a.lastTriggeredAt | date: dateFmt : 'UTC') : '—' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted board-empty">No firings in this range.</p>
          }
        </section>
      </div>

      <section class="dr-board">
        <header class="dr-board-head">
          <h3>All drift alerts</h3>
          <span class="muted">
            Server-paged · the range and filters below apply to the whole page · times in UTC
          </span>
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
            <select [(ngModel)]="filterDetector" (ngModelChange)="reload()">
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
            <select [(ngModel)]="filterSeverity" (ngModelChange)="reload()">
              <option value="">All</option>
              <option value="Info">Info</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </label>
          <label class="filter checkbox">
            <input type="checkbox" [(ngModel)]="unresolvedOnly" (ngModelChange)="reload()" />
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
          #table
          [columnDefs]="columns()"
          [fetchData]="fetchPage"
          (rowClick)="selectRow($event)"
          stateKey="drift-report"
        />
      </section>

      @if (selected(); as alert) {
        <section class="detail">
          <header class="detail-head">
            <h3>Alert #{{ alert.id }} — {{ symbolLabel(alert.symbol) }}</h3>
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
              <dd>{{ detectorLabel(alert.detectorType) }}</dd>
            </div>
            <div>
              <dt>Alert type</dt>
              <dd>{{ alert.alertType }}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{{ alert.isActive ? 'Active' : 'Resolved' }}</dd>
            </div>
            <div>
              <dt>Auto-resolved (UTC)</dt>
              <dd>
                {{ alert.autoResolvedAt ? (alert.autoResolvedAt | date: dateFmt : 'UTC') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Last triggered (UTC)</dt>
              <dd>
                {{
                  alert.lastTriggeredAt ? (alert.lastTriggeredAt | date: dateFmt : 'UTC') : 'Never'
                }}
              </dd>
            </div>
            <div>
              <dt>Cooldown</dt>
              <dd>{{ fmt(alert.cooldownSeconds) }} s</dd>
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
      .note {
        margin: calc(-1 * var(--space-3)) 0 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
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

      /* KPI strip — six equal tiles, one-line labels */
      .dr-kpis {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .dr-kpis {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .dr-kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
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
        min-width: 0;
      }
      .dr-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dr-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .dr-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .dr-kpi .kpi-value.warn {
        color: var(--warning);
      }

      .dr-charts {
        display: grid;
        grid-template-columns: 1fr 1fr 1.2fr;
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .dr-charts {
          grid-template-columns: 1fr;
        }
      }

      /* Boards size to their own content — a 3-row breakdown must not be
         stretched to the height of its neighbour. */
      .dr-board-row {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: var(--space-3);
        align-items: start;
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
      .board-empty {
        margin: 0;
        padding: var(--space-4);
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
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
      .dr-board-table .warn {
        color: var(--warning);
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
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('table') table?: DataTableComponent<DriftAlertDto>;

  readonly dateFmt = DATE_FMT;
  readonly sampleCap = SAMPLE_CAP;
  readonly fmt = fmt;
  readonly symbolLabel = symbolLabel;
  readonly detectorLabel = detectorLabel;

  filterSymbol = '';
  filterDetector = '';
  filterSeverity = '';
  unresolvedOnly = false;

  readonly range = signal<TimeRange | null>(defaultRange());

  readonly selected = signal<DriftAlertDto | null>(null);
  private reloadTick = signal(0);

  // ── Analytics sample ─────────────────────────────────────────────────
  // KPIs/charts/breakdowns compute over this sample, which is fetched with
  // exactly the same filter + range as the paged table so the two agree.
  readonly driftSample = signal<DriftAlertDto[]>([]);
  readonly sampleTotal = signal(0);
  readonly sampleCapped = computed(() => this.sampleTotal() > SAMPLE_CAP);

  driftStats = computed(() => {
    const all = this.driftSample();
    let critical = 0;
    let high = 0;
    let active = 0;
    let lastHour = 0;
    const symbols = new Set<string>();
    const oneHourAgo = Date.now() - 3600_000;
    for (const a of all) {
      if (a.severity === 'Critical') critical++;
      else if (a.severity === 'High') high++;
      if (a.isActive) active++;
      if (isRealSymbol(a.symbol)) symbols.add(a.symbol!);
      if (a.lastTriggeredAt && new Date(a.lastTriggeredAt).getTime() >= oneHourAgo) lastHour++;
    }
    return { total: all.length, critical, high, active, symbolCount: symbols.size, lastHour };
  });

  readonly severityCounts = computed<SeverityCounts>(() => {
    const counts = emptySeverityCounts();
    for (const a of this.driftSample()) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    return counts;
  });

  /** Severities actually present in the sample — drives subtitle, legend and table alike. */
  readonly severityLevels = computed<AlertSeverity[]>(() => {
    const counts = this.severityCounts();
    return SEVERITY_ORDER.filter((lvl) => counts[lvl] > 0);
  });

  readonly severitySubtitle = computed(() => {
    const levels = this.severityLevels();
    return levels.length > 0 ? levels.join(' · ') : 'No alerts in this range';
  });

  /** Whether any alert in the sample ever auto-resolved; decides if the column earns its space. */
  readonly hasAutoResolved = computed(() => this.driftSample().some((a) => !!a.autoResolvedAt));

  // A single stacked horizontal bar reads correctly even when one severity
  // dominates (a donut with a 95% slice hides the rest).
  severityBarOptions = computed<EChartsOption>(() => {
    const counts = this.severityCounts();
    const levels = this.severityLevels();
    const total = this.driftSample().length;
    if (total === 0) return {};
    const share = (n: number) => (n / total) * 100;
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) => `${p.seriesName}: ${fmt(p.value)} (${share(p.value).toFixed(1)}%)`,
      },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 24, right: 16, bottom: 44, left: 16 },
      xAxis: { type: 'value', max: total, show: false },
      yAxis: { type: 'category', data: ['Alerts'], show: false },
      series: levels.map((lvl) => ({
        name: lvl,
        type: 'bar' as const,
        stack: 'severity',
        data: [counts[lvl]],
        barWidth: 40,
        itemStyle: { color: SEVERITY_COLOR[lvl] },
        label: {
          show: true,
          position: 'inside' as const,
          fontSize: 10,
          color: '#fff',
          // Thin segments cannot fit a label; the tooltip and legend still cover them.
          formatter: (p: any) =>
            share(p.value) >= 8 ? `${fmt(p.value)} · ${share(p.value).toFixed(0)}%` : '',
        },
      })),
    };
  });

  bySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const a of this.driftSample()) {
      const k = symbolLabel(a.symbol);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    const isSentinel = (label: string) => label === FLEET_WIDE_LABEL || label === NO_SYMBOL_LABEL;
    return {
      grid: { top: 10, right: 40, bottom: 30, left: 110 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([k, v]) => ({
              value: v,
              itemStyle: {
                color: isSentinel(k) ? SENTINEL_COLOR : '#FF3B30',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => fmt(p.value),
          },
        },
      ],
    };
  });

  byDetectorOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const a of this.driftSample()) {
      const k = detectorLabel(a.detectorType);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 40, bottom: 30, left: 140 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([k, v]) => ({
              value: v,
              itemStyle: {
                color: k === NO_DETECTOR_LABEL ? SENTINEL_COLOR : '#AF52DE',
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
            formatter: (p: any) => fmt(p.value),
          },
        },
      ],
    };
  });

  perDetectorBreakdown = computed(() => {
    type Row = {
      detector: string;
      total: number;
      counts: SeverityCounts;
      active: number;
      activePct: number;
    };
    const groups: Record<string, Row> = {};
    for (const a of this.driftSample()) {
      const k = detectorLabel(a.detectorType);
      groups[k] ??= {
        detector: k,
        total: 0,
        counts: emptySeverityCounts(),
        active: 0,
        activePct: 0,
      };
      const g = groups[k];
      g.total++;
      g.counts[a.severity] = (g.counts[a.severity] ?? 0) + 1;
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
    // Re-fetch the analytics sample whenever the range or any filter changes.
    // reloadTick flips on every filter event, so binding to it covers
    // symbol/detector/severity/unresolvedOnly too.
    effect(() => {
      this.reloadTick();
      this.range();
      this.loadDriftAnalyticsSample();
    });
  }

  private currentFilter(): DriftReportQueryFilter {
    const r = this.range();
    return {
      symbol: this.filterSymbol || undefined,
      detectorType: this.filterDetector || undefined,
      severity: this.filterSeverity || undefined,
      unresolvedOnly: this.unresolvedOnly || undefined,
      fromDate: r?.from ?? undefined,
      toDate: r?.to ?? undefined,
    };
  }

  private loadDriftAnalyticsSample(): void {
    const filter = this.currentFilter();
    // Probe-and-fetch: read the true total from a 1-row query, then bring
    // back min(total, cap) rows — without unbounded fetches.
    this.mlService
      .listDriftReport({ currentPage: 1, itemCountPerPage: 1, filter })
      .pipe(catchError(() => of(null)))
      .subscribe((probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        this.sampleTotal.set(total);
        if (total === 0) {
          this.driftSample.set([]);
          return;
        }
        this.mlService
          .listDriftReport({
            currentPage: 1,
            itemCountPerPage: Math.min(total, SAMPLE_CAP),
            filter,
          })
          .pipe(catchError(() => of(null)))
          .subscribe((full) => {
            this.driftSample.set(full?.data?.data ?? []);
          });
      });
  }

  // The auto-resolved column only appears once at least one alert in the
  // sample carries a timestamp — a column of dashes tells the operator nothing.
  readonly columns = computed<ColDef<DriftAlertDto>[]>(() => {
    const cols: ColDef<DriftAlertDto>[] = [
      { headerName: 'ID', field: 'id', width: 90 },
      {
        headerName: 'Symbol',
        field: 'symbol',
        width: 130,
        valueFormatter: (p) => symbolLabel((p.value as string | null) ?? null),
      },
      {
        headerName: 'Detector',
        field: 'detectorType',
        width: 160,
        valueFormatter: (p) => (p.value as string | null) || 'Not recorded',
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
        headerName: 'Status',
        field: 'isActive',
        width: 110,
        cellRenderer: (p: { value: boolean }) =>
          p.value
            ? `<span style="background:rgba(255,59,48,0.12);color:#D70015;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">Active</span>`
            : `<span style="background:var(--bg-tertiary);color:var(--text-secondary);padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">Resolved</span>`,
      },
      {
        headerName: 'Last triggered (UTC)',
        field: 'lastTriggeredAt',
        width: 200,
        valueFormatter: (p) => this.formatDate(p.value as string | null),
      },
    ];
    if (this.hasAutoResolved()) {
      cols.push({
        headerName: 'Auto-resolved (UTC)',
        field: 'autoResolvedAt',
        width: 200,
        valueFormatter: (p) => this.formatDate(p.value as string | null),
      });
    }
    return cols;
  });

  readonly fetchPage = (params: PagerRequest) => {
    return this.mlService
      .listDriftReport({
        currentPage: params.currentPage,
        itemCountPerPage: params.itemCountPerPage,
        sortBy: params.sortBy,
        sortDirection: params.sortDirection,
        filter: this.currentFilter(),
      })
      .pipe(
        map((res): PagedData<DriftAlertDto> => res.data ?? this.emptyPage()),
        catchError(() => of(this.emptyPage())),
      );
  };

  reload(): void {
    this.selected.set(null);
    this.reloadTick.update((n) => n + 1);
    // The data-table only refetches on its own page/sort/search events, so a
    // filter change must ask it explicitly. Deferred a microtask so the
    // ngModel write that triggered this call has landed before the fetch.
    queueMicrotask(() => this.table?.loadData());
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

  private formatDate(iso: string | null): string {
    return iso ? (this.datePipe.transform(iso, DATE_FMT, 'UTC') ?? '—') : '—';
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
