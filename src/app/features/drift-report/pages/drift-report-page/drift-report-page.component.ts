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
import { formatDistanceToNow, parseISO } from 'date-fns';
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
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

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
const REASON_PREFIX = 'Reason: ';

/** Analytics sample cap — keeps the browser snappy on large ranges. */
const SAMPLE_CAP = 5000;

const DAY_MS = 24 * 3600 * 1000;

/** One date format for the whole page; timestamps are rendered in UTC. */
const DATE_FMT = 'd MMM yyyy, HH:mm:ss';

/** Payload keys that identify the producing process, not the condition — listed last in the drawer. */
const PAYLOAD_PROVENANCE_KEYS = new Set(['schemaVersion', 'cycleId', 'hostname', 'pid']);

const AXIS_TEXT = '#6E6E73';

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

function relative(iso: string | null): string {
  if (!iso) return '';
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

/** Cell-renderer strings go straight into innerHTML; payload-derived text must be escaped. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** "ml_degradation_mode_activated" → "ML degradation mode activated". */
function humanizeReason(reason: string): string {
  const words = reason
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.toLowerCase() === 'ml' ? 'ML' : w.toLowerCase()));
  if (words.length === 0) return reason;
  words[0] = words[0] === 'ML' ? 'ML' : words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

/** 21600 → "6 h". */
function humanizeSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec % 86400 === 0) return `${sec / 86400} d`;
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${fmt(sec)} s`;
}

/**
 * The detector names the engine's drift workers write as `ConditionJson.DetectorType`. The engine's `detectorType`
 * filter is a substring test on that key and on the `Detector` / `detector` / `worker` keys other producers use, so
 * the Detector filter offers these plus every other name seen in the sample (worker names included); it used to offer
 * "Adwin" / "MultiScale" (never emitted — the workers write "AdwinDrift" / "MultiSignal") and miss "FeaturePSI", the
 * detector behind half the alerts.
 */
const KNOWN_DETECTOR_TYPES = ['AdwinDrift', 'CUSUM', 'DriftMonitor', 'FeaturePSI', 'MultiSignal'];

/** The "By detector" chart keeps this many bars; the rest are summed into one "Other" bar. */
const DETECTOR_CHART_BARS = 10;
/** The "Top symbols" chart keeps this many bars. */
const SYMBOL_CHART_BARS = 12;

const detectorCache = new WeakMap<DriftAlertDto, string>();

function firstString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Who raised an alert. The engine reports `detectorType` from the payload's `DetectorType` / `Detector` / `detector` /
 * `worker` keys (since 2026-10-19 — before that only `DetectorType`, which left ~300 alerts unattributed). Two gaps
 * remain, read here: a few FeaturePSI alerts write camel-case `detectorType`, which the engine's key list misses, and
 * the degradation-mode / training-failure / resource-guard producers name no source at all — only a `reason`.
 */
function alertDetector(a: DriftAlertDto): string {
  const hit = detectorCache.get(a);
  if (hit !== undefined) return hit;
  let label = a.detectorType || null;
  if (!label && a.conditionJson) {
    try {
      const root: unknown = JSON.parse(a.conditionJson);
      if (root && typeof root === 'object' && !Array.isArray(root)) {
        const o = root as Record<string, unknown>;
        label = firstString(o, ['detectorType']);
        if (!label) {
          const reason = firstString(o, ['reason', 'Reason']);
          if (reason) label = `${REASON_PREFIX}${reason}`;
        }
      }
    } catch {
      // A malformed payload has no detector to read.
    }
  }
  label ??= NO_DETECTOR_LABEL;
  detectorCache.set(a, label);
  return label;
}

type DetectorKind = 'detector' | 'reason' | 'none';

/** Splits a detector label into what the UI shows: a named source, a bare reason, or nothing. */
function detectorParts(label: string): { kind: DetectorKind; name: string } {
  if (label === NO_DETECTOR_LABEL) return { kind: 'none', name: label };
  if (label.startsWith(REASON_PREFIX)) {
    return { kind: 'reason', name: humanizeReason(label.slice(REASON_PREFIX.length)) };
  }
  return { kind: 'detector', name: label };
}

/** Short chart-axis form: reasons are humanised, sources keep their name. */
function detectorShort(label: string): string {
  return detectorParts(label).name;
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

/** One horizontal bar chart, stacked by severity, with the row total printed at the bar's end. */
function severityStackedBars(
  rows: { label: string; counts: SeverityCounts; total: number }[],
  levels: AlertSeverity[],
  opts: { left: number; axisLabel: (label: string) => string; tooltipLabel: (l: string) => string },
): EChartsOption {
  const ordered = [...rows].reverse();
  const totals = ordered.map((r) => r.total);
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const list = (Array.isArray(params) ? params : [params]).filter(
          (p: any) => p.seriesName !== '__total' && p.value > 0,
        );
        if (list.length === 0) return '';
        const idx = list[0].dataIndex as number;
        const head = `<b>${esc(opts.tooltipLabel(ordered[idx].label))}</b> · ${fmt(totals[idx])}`;
        const lines = list.map((p: any) => `${p.marker} ${p.seriesName}: ${fmt(p.value)}`);
        return [head, ...lines].join('<br/>');
      },
    },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 8,
      itemHeight: 8,
      icon: 'circle',
      textStyle: { fontSize: 10, color: AXIS_TEXT },
      data: levels,
    },
    grid: { top: 24, right: 36, bottom: 4, left: opts.left, containLabel: false },
    xAxis: {
      type: 'value',
      axisLabel: { show: false },
      splitLine: { lineStyle: { color: 'rgba(127,127,127,0.12)' } },
    },
    yAxis: {
      type: 'category',
      data: ordered.map((r) => r.label),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        fontSize: 11,
        color: AXIS_TEXT,
        width: opts.left - 12,
        overflow: 'truncate',
        formatter: (v: string) => opts.axisLabel(v),
      },
    },
    series: [
      ...levels.map((lvl, i) => ({
        name: lvl,
        type: 'bar' as const,
        stack: 'sev',
        barWidth: 12,
        itemStyle: {
          color: SEVERITY_COLOR[lvl],
          // Round only the outer end of the outermost segment.
          borderRadius: i === levels.length - 1 ? [0, 4, 4, 0] : 0,
        },
        emphasis: { focus: 'series' as const },
        data: ordered.map((r) => r.counts[lvl]),
      })),
      // Zero-width carrier bar whose label prints the row total after the stack.
      {
        name: '__total',
        type: 'bar' as const,
        stack: 'sev',
        barWidth: 12,
        silent: true,
        itemStyle: { color: 'transparent' },
        data: ordered.map(() => 0),
        label: {
          show: true,
          position: 'right' as const,
          fontSize: 10,
          color: AXIS_TEXT,
          formatter: (p: any) => fmt(totals[p.dataIndex]),
        },
      },
    ],
  };
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
    ModalA11yDirective,
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
          <span class="kpi-hint">from {{ fmt(perDetectorBreakdown().length) }} sources</span>
        </div>
        <div class="dr-kpi" [class.tone-bad]="driftStats().critical > 0">
          <span class="kpi-label">Critical</span>
          <span class="kpi-value">{{ fmt(driftStats().critical) }}</span>
          <span class="kpi-hint"
            >{{ pct(driftStats().critical, driftStats().total) }} of alerts</span
          >
        </div>
        <div class="dr-kpi" [class.tone-warn]="driftStats().high > 0">
          <span class="kpi-label">High</span>
          <span class="kpi-value">{{ fmt(driftStats().high) }}</span>
          <span class="kpi-hint">{{ pct(driftStats().high, driftStats().total) }} of alerts</span>
        </div>
        <div class="dr-kpi" [class.tone-info]="driftStats().active > 0">
          <span class="kpi-label">Active</span>
          <span class="kpi-value">{{ fmt(driftStats().active) }}</span>
          <span class="kpi-hint"
            >{{ pct(driftStats().active, driftStats().total) }} unresolved</span
          >
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Symbols hit</span>
          <span class="kpi-value">{{ fmt(driftStats().symbolCount) }}</span>
          <span class="kpi-hint">
            @if (driftStats().topSymbol; as top) {
              most: {{ top.symbol }} ({{ fmt(top.count) }})
            } @else {
              no instrument alerts
            }
          </span>
        </div>
        <div class="dr-kpi" [class.tone-bad]="driftStats().lastHour > 0">
          <span class="kpi-label">Triggered &lt; 1h</span>
          <span class="kpi-value">{{ fmt(driftStats().lastHour) }}</span>
          <span class="kpi-hint" [title]="latestFiringAbs()">
            {{ latestFiringRel() ? 'latest ' + latestFiringRel() : 'no firings' }}
          </span>
        </div>
      </div>
      @if (sampleCapped()) {
        <p class="note">
          Tiles, charts and breakdowns cover the first {{ fmt(sampleCap) }} of
          {{ fmt(sampleTotal()) }} alerts in this range; the table below pages through all of them.
        </p>
      }

      <!-- Chart row: severity mix + where alerts land + who raises them -->
      <div class="dr-charts">
        <section class="panel sev-panel">
          <header class="panel-head">
            <h3>Severity mix</h3>
            <p>Share of alerts in the range, and how many are still open</p>
          </header>
          @if (driftStats().total > 0) {
            <div class="sev-body">
              <div class="sev-headline">
                <span class="sev-big">{{ fmt(driftStats().total) }}</span>
                <span class="sev-big-label">alerts</span>
              </div>
              <div class="sev-stack" role="img" [attr.aria-label]="severitySubtitle()">
                @for (lvl of severityLevels(); track lvl) {
                  <span
                    [style.width.%]="share(severityCounts()[lvl])"
                    [style.background]="severityColor(lvl)"
                    [title]="lvl + ': ' + fmt(severityCounts()[lvl])"
                  ></span>
                }
              </div>
              <ul class="sev-rows">
                @for (lvl of severityLevels(); track lvl) {
                  <li>
                    <span class="sev-dot" [style.background]="severityColor(lvl)"></span>
                    <span class="sev-name">{{ lvl }}</span>
                    <span class="sev-track">
                      <i
                        [style.width.%]="share(severityCounts()[lvl])"
                        [style.background]="severityColor(lvl)"
                      ></i>
                    </span>
                    <span class="sev-count">{{ fmt(severityCounts()[lvl]) }}</span>
                    <span class="sev-pct">{{
                      pct(severityCounts()[lvl], driftStats().total)
                    }}</span>
                  </li>
                }
              </ul>
              <div class="sev-foot">
                <div class="open-track">
                  <i [style.width.%]="share(driftStats().active)"></i>
                </div>
                <div class="open-legend">
                  <span
                    ><b>{{ fmt(driftStats().active) }}</b> active</span
                  >
                  <span>
                    <b>{{ fmt(driftStats().total - driftStats().active) }}</b> resolved
                  </span>
                </div>
              </div>
            </div>
          } @else {
            <p class="panel-empty">No alerts in this range.</p>
          }
        </section>
        <app-chart-card
          title="Top symbols"
          subtitle="Alert count by severity · fleet-wide and symbol-less alerts listed separately"
          [options]="bySymbolOptions()"
          height="260px"
        />
        <app-chart-card
          title="By detector"
          subtitle="Which sources raise the most alerts"
          [options]="byDetectorOptions()"
          height="260px"
        />
      </div>

      <!-- Per-detector breakdown + most-recently triggered list -->
      <div class="dr-board-row">
        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Per-detector severity</h3>
            <span class="muted">Severity counts grouped by detector or reason</span>
          </header>
          @if (perDetectorBreakdown().length > 0) {
            <div class="board-scroll">
              <table class="dr-board-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th class="num">Total</th>
                    <th class="mix-col">Mix</th>
                    @for (lvl of severityLevels(); track lvl) {
                      <th class="num">{{ lvl }}</th>
                    }
                    <th class="active-col">Active</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perDetectorBreakdown(); track row.detector) {
                    <tr>
                      <td [title]="row.detector">
                        <span class="source-cell">
                          @if (row.kind === 'reason') {
                            <span class="tag">Reason</span>
                          }
                          <span class="source-name" [class.mono]="row.kind === 'detector'">
                            {{ row.name }}
                          </span>
                        </span>
                      </td>
                      <td class="num strong">{{ fmt(row.total) }}</td>
                      <td class="mix-col">
                        <span class="mix-bar">
                          @for (lvl of severityLevels(); track lvl) {
                            @if (row.counts[lvl] > 0) {
                              <i
                                [style.width.%]="(row.counts[lvl] / row.total) * 100"
                                [style.background]="severityColor(lvl)"
                              ></i>
                            }
                          }
                        </span>
                      </td>
                      @for (lvl of severityLevels(); track lvl) {
                        <td
                          class="num"
                          [class.zero]="row.counts[lvl] === 0"
                          [style.color]="
                            row.counts[lvl] > 0 && lvl !== 'Medium' && lvl !== 'Info'
                              ? severityColor(lvl)
                              : null
                          "
                        >
                          {{ row.counts[lvl] > 0 ? fmt(row.counts[lvl]) : '–' }}
                        </td>
                      }
                      <td class="active-col">
                        <span class="active-cell">
                          <span class="active-track">
                            <i
                              [style.width.%]="row.activePct"
                              [class.hot]="row.activePct >= 50"
                            ></i>
                          </span>
                          <span class="active-pct" [class.hot]="row.activePct >= 50">
                            {{ row.activePct.toFixed(0) }}%
                          </span>
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="muted board-empty">No alerts in this range.</p>
          }
        </section>

        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Most-recent firings</h3>
            <span class="muted">Last 10 in the range · click to inspect</span>
          </header>
          @if (recentFirings().length > 0) {
            <ul class="recent">
              @for (a of recentFirings(); track a.id) {
                <li>
                  <button type="button" class="recent-row" (click)="selectRow(a)">
                    <span class="sev-dot" [style.background]="severityColor(a.severity)"></span>
                    <span class="recent-main">
                      <span class="recent-symbol">{{ symbolLabel(a.symbol) }}</span>
                      <span class="recent-detector" [title]="detectorLabel(a)">
                        {{ detectorName(a) }}
                      </span>
                    </span>
                    <span class="recent-when">
                      <span class="recent-rel">{{ rel(a.lastTriggeredAt) }}</span>
                      <span class="recent-abs">
                        {{ a.lastTriggeredAt | date: 'd MMM, HH:mm' : 'UTC' }} UTC
                      </span>
                    </span>
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="muted board-empty">No firings in this range.</p>
          }
        </section>
      </div>

      <section class="dr-board">
        <header class="dr-board-head">
          <h3>All drift alerts</h3>
          <span class="count-chip">{{ fmt(sampleTotal()) }}</span>
          <span class="muted head-right">Server-paged · filters apply to the whole page · UTC</span>
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
          <label class="filter wide">
            <span class="filter-label">Detector</span>
            <select [(ngModel)]="filterDetector" (ngModelChange)="reload()">
              <option value="">All detectors</option>
              @for (d of detectorOptions(); track d) {
                <option [value]="d">{{ d }}</option>
              }
            </select>
          </label>
          <label class="filter">
            <span class="filter-label">Severity</span>
            <select [(ngModel)]="filterSeverity" (ngModelChange)="reload()">
              <option value="">All severities</option>
              <option value="Critical">Critical</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Info">Info</option>
            </select>
          </label>
          <div class="filter">
            <span class="filter-label">Range</span>
            <app-time-range-picker
              [(value)]="range"
              defaultPreset="7d"
              (valueChange)="onRangeChange($event)"
            />
          </div>
          <label class="toggle-chip" [class.on]="unresolvedOnly">
            <input type="checkbox" [(ngModel)]="unresolvedOnly" (ngModelChange)="reload()" />
            <span>Unresolved only</span>
          </label>
          @if (hasFilters()) {
            <button type="button" class="clear-btn" (click)="clearFilters()">Clear filters</button>
          }
        </section>

        <app-data-table
          #table
          [columnDefs]="columns()"
          [fetchData]="fetchPage"
          (rowClick)="selectRow($event)"
          stateKey="drift-report"
          emptyTitle="No drift alerts"
          emptyDescription="Nothing matches this range and these filters."
        />
      </section>

      @if (selected(); as alert) {
        <div class="overlay" (click)="selected.set(null)" role="presentation">
          <aside
            class="drawer"
            (click)="$event.stopPropagation()"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dr-drawer-title"
            appModalA11y
            (dismiss)="selected.set(null)"
          >
            <header class="drawer-head">
              <div class="drawer-title">
                <span class="drawer-kicker">Alert #{{ alert.id }}</span>
                <h2 id="dr-drawer-title">{{ symbolLabel(alert.symbol) }}</h2>
                <div class="drawer-pills">
                  <span
                    class="pill"
                    [style.background]="severityBg(alert.severity)"
                    [style.color]="severityColor(alert.severity)"
                  >
                    <span class="sev-dot" [style.background]="severityColor(alert.severity)"></span>
                    {{ alert.severity }}
                  </span>
                  <span class="pill" [class.pill-active]="alert.isActive">
                    {{ alert.isActive ? 'Active' : 'Resolved' }}
                  </span>
                </div>
              </div>
              <button
                type="button"
                class="close-btn"
                (click)="selected.set(null)"
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <dl class="facts">
              <div class="full">
                <dt>Detector</dt>
                <dd>
                  @if (detectorKind(alert) === 'reason') {
                    <span class="tag">Reason</span>
                  }
                  {{ detectorName(alert) }}
                </dd>
              </div>
              <div>
                <dt>Alert type</dt>
                <dd>{{ alert.alertType }}</dd>
              </div>
              <div>
                <dt>Cooldown</dt>
                <dd>
                  {{ humanizeSeconds(alert.cooldownSeconds) }}
                  <span class="dim">({{ fmt(alert.cooldownSeconds) }} s)</span>
                </dd>
              </div>
              <div>
                <dt>Last triggered</dt>
                <dd>
                  @if (alert.lastTriggeredAt) {
                    {{ alert.lastTriggeredAt | date: dateFmt : 'UTC' }} UTC
                    <span class="dim block">{{ rel(alert.lastTriggeredAt) }}</span>
                  } @else {
                    Never
                  }
                </dd>
              </div>
              <div>
                <dt>Auto-resolved</dt>
                <dd>
                  @if (alert.autoResolvedAt) {
                    {{ alert.autoResolvedAt | date: dateFmt : 'UTC' }} UTC
                    <span class="dim block">{{ rel(alert.autoResolvedAt) }}</span>
                  } @else {
                    —
                  }
                </dd>
              </div>
              <div class="full">
                <dt>Dedup key</dt>
                <dd class="mono">{{ alert.deduplicationKey || '—' }}</dd>
              </div>
            </dl>

            @if (payloadEntries().length > 0) {
              <section class="payload">
                <h4>Condition</h4>
                <table class="kv">
                  <tbody>
                    @for (e of payloadEntries(); track e.key) {
                      <tr [class.provenance]="e.provenance">
                        <th>{{ e.key }}</th>
                        <td class="mono">{{ e.value }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }

            <details class="raw" [open]="payloadEntries().length === 0">
              <summary>Raw payload</summary>
              <pre class="json">{{ formatJson(alert.conditionJson) }}</pre>
            </details>
          </aside>
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
        gap: var(--space-4);
      }
      .note {
        margin: calc(-1 * var(--space-2)) 0 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .sev-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
      }
      .tag {
        flex: none;
        display: inline-block;
        font-size: 9.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: 1px 6px;
        border-radius: 4px;
        line-height: 16px;
      }

      /* ── KPI strip ─────────────────────────────────────────────── */
      .dr-kpis {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-3);
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
        --tone: var(--text-tertiary);
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 2px);
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .dr-kpi::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--tone);
        opacity: 0.35;
      }
      .dr-kpi.tone-bad {
        --tone: #d70015;
      }
      .dr-kpi.tone-warn {
        --tone: var(--warning);
      }
      .dr-kpi.tone-info {
        --tone: var(--accent);
      }
      .dr-kpi.tone-bad::before,
      .dr-kpi.tone-warn::before,
      .dr-kpi.tone-info::before {
        opacity: 1;
      }
      .kpi-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-value {
        font-size: 26px;
        line-height: 1.2;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .tone-bad .kpi-value {
        color: #d70015;
      }
      .tone-warn .kpi-value {
        color: var(--warning);
      }
      .kpi-hint {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ── Chart row ─────────────────────────────────────────────── */
      .dr-charts {
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1fr) minmax(0, 1.2fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1200px) {
        .dr-charts {
          grid-template-columns: 1fr;
        }
      }
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .panel-head {
        margin-bottom: var(--space-4);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .panel-head p {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .panel-empty {
        height: 260px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
      }
      .sev-body {
        height: 260px;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .sev-headline {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .sev-big {
        font-size: 30px;
        font-weight: var(--font-semibold);
        line-height: 1;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      .sev-big-label {
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .sev-stack {
        display: flex;
        height: 14px;
        border-radius: 7px;
        overflow: hidden;
        gap: 2px;
        background: var(--bg-tertiary);
      }
      .sev-stack span {
        display: block;
        min-width: 3px;
      }
      .sev-rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        flex: 1;
      }
      .sev-rows li {
        display: grid;
        grid-template-columns: 8px 64px 1fr 44px 40px;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .sev-name {
        color: var(--text-primary);
      }
      .sev-track,
      .open-track,
      .active-track {
        display: block;
        height: 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .sev-track i,
      .open-track i,
      .active-track i {
        display: block;
        height: 100%;
        border-radius: 3px;
      }
      .sev-count {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
      }
      .sev-pct {
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .sev-foot {
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .open-track i {
        background: var(--accent);
      }
      .open-legend {
        display: flex;
        justify-content: space-between;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .open-legend b {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      /* ── Boards ────────────────────────────────────────────────── */
      .dr-board-row {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
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
        box-shadow: var(--shadow-sm);
      }
      .dr-board-head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .dr-board-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .head-right {
        margin-left: auto;
      }
      .count-chip {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        padding: 1px 8px;
      }
      .board-empty {
        margin: 0;
        padding: var(--space-5) var(--space-4);
      }
      .board-scroll {
        overflow-x: auto;
      }
      .dr-board-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .dr-board-table th,
      .dr-board-table td {
        padding: 9px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .dr-board-table th:first-child,
      .dr-board-table td:first-child {
        padding-left: var(--space-4);
      }
      .dr-board-table th:last-child,
      .dr-board-table td:last-child {
        padding-right: var(--space-4);
      }
      .dr-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .dr-board-table tbody tr:hover {
        background: var(--bg-primary);
      }
      .dr-board-table th {
        background: var(--bg-primary);
        color: var(--text-tertiary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .dr-board-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        width: 1%;
      }
      .dr-board-table .strong {
        font-weight: var(--font-semibold);
      }
      .dr-board-table .zero {
        color: var(--text-tertiary);
        opacity: 0.6;
      }
      .source-cell {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        max-width: 340px;
      }
      .source-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .source-name.mono {
        font-size: 12px;
      }
      .mix-col {
        width: 120px;
      }
      .mix-bar {
        display: flex;
        width: 100px;
        height: 8px;
        border-radius: 4px;
        overflow: hidden;
        background: var(--bg-tertiary);
        gap: 1px;
      }
      .mix-bar i {
        display: block;
        height: 100%;
      }
      .active-col {
        width: 130px;
      }
      .active-cell {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .active-track {
        width: 64px;
      }
      .active-track i {
        background: var(--text-tertiary);
      }
      .active-track i.hot {
        background: var(--loss);
      }
      .active-pct {
        width: 38px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
      }
      .active-pct.hot {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }

      /* Most-recent firings list */
      .recent {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .recent li + li {
        border-top: 1px solid var(--border);
      }
      .recent-row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 9px var(--space-4);
        background: none;
        border: none;
        text-align: left;
        cursor: pointer;
        color: inherit;
        font: inherit;
      }
      .recent-row:hover {
        background: var(--bg-primary);
      }
      .recent-row:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .recent-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        line-height: 1.3;
      }
      .recent-symbol {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .recent-detector {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .recent-when {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        line-height: 1.3;
        flex: none;
      }
      .recent-rel {
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .recent-abs {
        font-size: 10.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }

      /* ── Filter bar ────────────────────────────────────────────── */
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--space-3) var(--space-4);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .filter {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 150px;
      }
      .filter.wide {
        min-width: 220px;
      }
      .filter-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .filter input[type='text'],
      .filter select {
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .filter input[type='text']:focus,
      .filter select:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
      }
      .toggle-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
      }
      .toggle-chip.on {
        border-color: var(--accent);
        color: var(--accent);
        background: rgba(0, 113, 227, 0.08);
      }
      .toggle-chip input {
        margin: 0;
        accent-color: var(--accent);
      }
      .clear-btn {
        height: 32px;
        padding: 0 var(--space-3);
        border: none;
        background: none;
        color: var(--accent);
        font-size: var(--text-sm);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }
      .clear-btn:hover {
        background: rgba(0, 113, 227, 0.08);
      }

      /* ── Detail drawer ─────────────────────────────────────────── */
      .overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.4));
        z-index: 1000;
        display: flex;
        justify-content: flex-end;
        animation: fadeIn 0.15s ease-out;
      }
      .drawer {
        width: min(560px, 100%);
        background: var(--bg-primary);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
        padding: var(--space-6);
        overflow-y: auto;
        animation: slideInRight 0.2s ease-out;
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
      }
      @keyframes slideInRight {
        from {
          transform: translateX(24px);
          opacity: 0;
        }
      }
      .drawer-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .drawer-title {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .drawer-kicker {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .drawer-title h2 {
        margin: 0;
        font-size: 22px;
        font-weight: var(--font-semibold);
      }
      .drawer-pills {
        display: flex;
        gap: var(--space-2);
        margin-top: 4px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill-active {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .close-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--bg-secondary);
        border: none;
        font-size: 20px;
        color: var(--text-secondary);
        cursor: pointer;
        line-height: 1;
      }
      .close-btn:hover {
        background: var(--bg-tertiary);
      }
      .facts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4) var(--space-5);
        margin: 0;
        padding: var(--space-4);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
      }
      .facts > div {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .facts .full {
        grid-column: 1 / -1;
      }
      .facts dt {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .facts dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .facts dd.mono {
        font-size: var(--text-xs);
        word-break: break-all;
      }
      .dim {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .dim.block {
        flex-basis: 100%;
      }
      .payload h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .kv {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .kv th,
      .kv td {
        padding: 7px var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .kv tr:last-child th,
      .kv tr:last-child td {
        border-bottom: none;
      }
      .kv th {
        width: 40%;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        background: var(--bg-secondary);
      }
      .kv td {
        word-break: break-word;
      }
      .kv tr.provenance th,
      .kv tr.provenance td {
        color: var(--text-tertiary);
      }
      .raw summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .json {
        margin: var(--space-2) 0 0;
        padding: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        max-height: 360px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
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
  readonly detectorLabel = alertDetector;
  readonly rel = relative;
  readonly humanizeSeconds = humanizeSeconds;

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

  /** The Detector filter's choices: the engine's DetectorType names, any other seen, and the current pick. */
  readonly detectorOptions = computed(() => {
    this.reloadTick();
    const names = new Set(KNOWN_DETECTOR_TYPES);
    for (const a of this.driftSample()) if (a.detectorType) names.add(a.detectorType);
    if (this.filterDetector) names.add(this.filterDetector);
    return [...names].sort((a, b) => a.localeCompare(b));
  });

  driftStats = computed(() => {
    const all = this.driftSample();
    let critical = 0;
    let high = 0;
    let active = 0;
    let lastHour = 0;
    const perSymbol = new Map<string, number>();
    const oneHourAgo = Date.now() - 3600_000;
    for (const a of all) {
      if (a.severity === 'Critical') critical++;
      else if (a.severity === 'High') high++;
      if (a.isActive) active++;
      if (isRealSymbol(a.symbol)) perSymbol.set(a.symbol!, (perSymbol.get(a.symbol!) ?? 0) + 1);
      if (a.lastTriggeredAt && new Date(a.lastTriggeredAt).getTime() >= oneHourAgo) lastHour++;
    }
    let topSymbol: { symbol: string; count: number } | null = null;
    for (const [symbol, count] of perSymbol) {
      if (!topSymbol || count > topSymbol.count) topSymbol = { symbol, count };
    }
    return {
      total: all.length,
      critical,
      high,
      active,
      symbolCount: perSymbol.size,
      topSymbol,
      lastHour,
    };
  });

  readonly severityCounts = computed<SeverityCounts>(() => {
    const counts = emptySeverityCounts();
    for (const a of this.driftSample()) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    return counts;
  });

  /** Severities actually present in the sample — drives the legend, charts and table alike. */
  readonly severityLevels = computed<AlertSeverity[]>(() => {
    const counts = this.severityCounts();
    return SEVERITY_ORDER.filter((lvl) => counts[lvl] > 0);
  });

  readonly severitySubtitle = computed(() => {
    const counts = this.severityCounts();
    const levels = this.severityLevels();
    return levels.length > 0
      ? levels.map((l) => `${l} ${fmt(counts[l])}`).join(' · ')
      : 'No alerts in this range';
  });

  /** Whether any alert in the sample ever auto-resolved; decides if the column earns its space. */
  readonly hasAutoResolved = computed(() => this.driftSample().some((a) => !!a.autoResolvedAt));

  readonly recentFirings = computed(() =>
    [...this.driftSample()]
      .filter((a) => !!a.lastTriggeredAt)
      .sort(
        (a, b) => new Date(b.lastTriggeredAt!).getTime() - new Date(a.lastTriggeredAt!).getTime(),
      )
      .slice(0, 10),
  );

  readonly latestFiringRel = computed(() =>
    relative(this.recentFirings()[0]?.lastTriggeredAt ?? null),
  );
  readonly latestFiringAbs = computed(() =>
    this.formatDate(this.recentFirings()[0]?.lastTriggeredAt ?? null),
  );

  bySymbolOptions = computed<EChartsOption>(() => {
    const groups = new Map<string, { label: string; counts: SeverityCounts; total: number }>();
    for (const a of this.driftSample()) {
      const k = symbolLabel(a.symbol);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { label: k, counts: emptySeverityCounts(), total: 0 }));
      g.counts[a.severity]++;
      g.total++;
    }
    const rows = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, SYMBOL_CHART_BARS);
    if (rows.length === 0) return {};
    return severityStackedBars(rows, this.severityLevels(), {
      left: 104,
      axisLabel: (l) => l,
      tooltipLabel: (l) => l,
    });
  });

  byDetectorOptions = computed<EChartsOption>(() => {
    const groups = new Map<string, { label: string; counts: SeverityCounts; total: number }>();
    for (const a of this.driftSample()) {
      const k = alertDetector(a);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { label: k, counts: emptySeverityCounts(), total: 0 }));
      g.counts[a.severity]++;
      g.total++;
    }
    let rows = [...groups.values()].sort((a, b) => b.total - a.total);
    if (rows.length === 0) return {};
    // Twenty-odd sources do not fit 260 px; the long tail is one bar (the table below lists every one).
    if (rows.length > DETECTOR_CHART_BARS) {
      const tail = rows.slice(DETECTOR_CHART_BARS - 1);
      const other = { label: `Other (${tail.length})`, counts: emptySeverityCounts(), total: 0 };
      for (const r of tail) {
        for (const lvl of SEVERITY_ORDER) other.counts[lvl] += r.counts[lvl];
        other.total += r.total;
      }
      rows = [...rows.slice(0, DETECTOR_CHART_BARS - 1), other];
    }
    return severityStackedBars(rows, this.severityLevels(), {
      left: 200,
      axisLabel: detectorShort,
      tooltipLabel: (l) => l,
    });
  });

  perDetectorBreakdown = computed(() => {
    type Row = {
      detector: string;
      kind: DetectorKind;
      name: string;
      total: number;
      counts: SeverityCounts;
      active: number;
      activePct: number;
    };
    const groups: Record<string, Row> = {};
    for (const a of this.driftSample()) {
      const k = alertDetector(a);
      groups[k] ??= {
        detector: k,
        ...detectorParts(k),
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

  /** The selected alert's payload as rows: condition fields first, producer provenance last. */
  readonly payloadEntries = computed(() => {
    const a = this.selected();
    if (!a?.conditionJson) return [];
    let root: unknown;
    try {
      root = JSON.parse(a.conditionJson);
    } catch {
      return [];
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
    const rows = Object.entries(root as Record<string, unknown>).map(([key, v]) => ({
      key,
      provenance: PAYLOAD_PROVENANCE_KEYS.has(key),
      value:
        v === null || v === undefined
          ? '—'
          : typeof v === 'object'
            ? JSON.stringify(v)
            : typeof v === 'number'
              ? fmt(v)
              : String(v),
    }));
    return [...rows.filter((r) => !r.provenance), ...rows.filter((r) => r.provenance)];
  });

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
  // Cell renderers return HTML strings rendered by AG Grid outside this
  // component's style scope, so they style inline.
  readonly columns = computed<ColDef<DriftAlertDto>[]>(() => {
    const twoLine = (iso: string | null): string => {
      if (!iso) return `<span style="color:var(--text-tertiary)">—</span>`;
      return (
        `<span style="display:inline-block;vertical-align:middle;line-height:1.3">` +
        `<span style="font-variant-numeric:tabular-nums">${esc(this.formatDate(iso))}</span><br/>` +
        `<span style="font-size:11px;color:var(--text-tertiary)">${esc(relative(iso))}</span></span>`
      );
    };
    const cols: ColDef<DriftAlertDto>[] = [
      {
        headerName: 'ID',
        field: 'id',
        width: 84,
        cellRenderer: (p: { value: number }) =>
          `<span style="color:var(--text-tertiary);font-variant-numeric:tabular-nums">#${p.value}</span>`,
      },
      {
        headerName: 'Symbol',
        field: 'symbol',
        width: 130,
        cellRenderer: (p: { value: string | null }) => {
          const label = symbolLabel(p.value ?? null);
          const real = isRealSymbol(p.value ?? null);
          return `<span style="font-weight:600;${real ? '' : 'color:var(--text-secondary);font-weight:500'}">${esc(label)}</span>`;
        },
      },
      {
        headerName: 'Detector',
        field: 'detectorType',
        flex: 1,
        minWidth: 260,
        // Same attribution as the boards above (the engine's detector, else the payload's reason).
        cellRenderer: (p: { data?: DriftAlertDto }) => {
          if (!p.data) return '';
          const { kind, name } = detectorParts(alertDetector(p.data));
          const tag =
            kind === 'reason'
              ? `<span style="flex:none;font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);background:var(--bg-tertiary);padding:0 6px;border-radius:4px;line-height:16px">Reason</span>`
              : '';
          const nameStyle =
            kind === 'detector'
              ? `font-family:'SF Mono','Fira Code',monospace;font-size:12px`
              : kind === 'none'
                ? 'color:var(--text-tertiary)'
                : '';
          return (
            `<span style="display:flex;align-items:center;gap:8px;min-width:0;height:100%">${tag}` +
            `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${nameStyle}">${esc(name)}</span></span>`
          );
        },
        tooltipValueGetter: (p) => (p.data ? alertDetector(p.data) : null),
      },
      {
        headerName: 'Alert type',
        field: 'alertType',
        width: 170,
        cellStyle: { color: 'var(--text-secondary)' },
      },
      {
        headerName: 'Severity',
        field: 'severity',
        width: 124,
        cellRenderer: (p: { value: AlertSeverity }) => {
          const c = SEVERITY_COLOR[p.value] ?? '#8E8E93';
          return (
            `<span style="display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:999px;` +
            `background:${c}1a;color:${c};font-size:12px;font-weight:600;line-height:22px">` +
            `<span style="width:6px;height:6px;border-radius:50%;background:${c}"></span>${esc(String(p.value))}</span>`
          );
        },
      },
      {
        headerName: 'Status',
        field: 'isActive',
        width: 116,
        cellRenderer: (p: { value: boolean }) =>
          p.value
            ? `<span style="display:inline-flex;align-items:center;gap:6px;color:#D70015;font-size:12px;font-weight:600"><span style="width:7px;height:7px;border-radius:50%;background:#FF3B30;box-shadow:0 0 0 3px rgba(255,59,48,.18)"></span>Active</span>`
            : `<span style="display:inline-flex;align-items:center;gap:6px;color:var(--text-tertiary);font-size:12px;font-weight:500"><span style="width:7px;height:7px;border-radius:50%;background:var(--text-tertiary);opacity:.5"></span>Resolved</span>`,
      },
      {
        headerName: 'Last triggered (UTC)',
        field: 'lastTriggeredAt',
        width: 190,
        cellRenderer: (p: { value: string | null }) => twoLine(p.value ?? null),
      },
    ];
    if (this.hasAutoResolved()) {
      cols.push({
        headerName: 'Auto-resolved (UTC)',
        field: 'autoResolvedAt',
        width: 190,
        cellRenderer: (p: { value: string | null }) => twoLine(p.value ?? null),
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

  hasFilters(): boolean {
    return !!(
      this.filterSymbol ||
      this.filterDetector ||
      this.filterSeverity ||
      this.unresolvedOnly
    );
  }

  clearFilters(): void {
    this.filterSymbol = '';
    this.filterDetector = '';
    this.filterSeverity = '';
    this.unresolvedOnly = false;
    this.reload();
  }

  onRangeChange(_range: TimeRange | null): void {
    // Value is already written into `range` via the two-way model binding;
    // just nudge the table to refetch.
    this.reload();
  }

  selectRow(row: DriftAlertDto): void {
    this.selected.set(row);
  }

  detectorName(a: DriftAlertDto): string {
    return detectorParts(alertDetector(a)).name;
  }

  detectorKind(a: DriftAlertDto): DetectorKind {
    return detectorParts(alertDetector(a)).kind;
  }

  /** Width share of the whole sample, for bars. */
  share(n: number): number {
    const total = this.driftStats().total;
    return total > 0 ? (n / total) * 100 : 0;
  }

  pct(n: number, total: number): string {
    if (total <= 0) return '0%';
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? '<1%' : `${p.toFixed(0)}%`;
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
