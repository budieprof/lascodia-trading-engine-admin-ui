import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Observable, catchError, map, of } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { CalibrationService } from '@core/services/calibration.service';
import type {
  CalibrationTrendReportDto,
  CalibrationTrendRowDto,
  DefaultsCalibrationDto,
  DefaultsCalibrationEntryDto,
  PagedData,
  PagerRequest,
  ScreeningGateBindingReportDto,
  SignalRejectionEntryDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Calibration / Tuning operator console — four tabs, all populated from
 * dedicated engine reports:
 *
 *   - Trend: latest-month vs baseline rejection-mix delta with
 *     anomaly flags
 *   - Screening Gates: which gate is bindingly tight on candidate
 *     qualification, with the engine's textual recommendation
 *   - Signal Rejections: paged audit log of every per-signal rejection
 *     (paged because the table grows to hundreds of thousands)
 *   - Recommended Defaults: per-config-key percentile distributions
 *     with current vs recommended floor
 *
 * Follows the same dense layout as /alert-triage, /dead-letters,
 * /positions/deltas, /trade-signals/feedback — metric-cards in a
 * kpi-strip + insights-section with insights-grid + board-table
 * data panes — so the operator's eye knows where to look.
 */
@Component({
  selector: 'app-calibration-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    TabsComponent,
    DataTableComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Tuning"
        subtitle="Calibration reports and operator guidance — what's bindingly tight on candidate qualification, where the rejection mix shifted, which floors to raise."
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        <!-- ═══════════ TREND ═══════════ -->
        @if (activeTab() === 'trend') {
          @if (trendLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (!trend()) {
            <app-error-state
              title="No trend report"
              message="Engine returned no trend report. The trend endpoint may need data — try the Recommended Defaults tab if this persists."
            />
          } @else if (trend(); as t) {
            <div class="kpi-strip">
              <app-metric-card
                label="Latest month"
                [value]="t.latestMonthTotal"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Baseline total"
                [value]="t.baselineTotal"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Anomalies"
                [value]="anomalyCount()"
                format="number"
                [dotColor]="anomalyCount() > 0 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Largest |Δ|"
                [value]="largestDeltaPct()"
                format="percent"
                [dotColor]="
                  largestDeltaPct() >= 30
                    ? '#FF3B30'
                    : largestDeltaPct() >= 15
                      ? '#FF9500'
                      : '#34C759'
                "
              />
              <app-metric-card
                label="Buckets"
                [value]="t.rows.length"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Threshold"
                [value]="t.anomalyThresholdPct * 100"
                format="percent"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Stages"
                [value]="distinctStages()"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Baseline floor"
                [value]="t.minBaselineCount"
                format="number"
                dotColor="#0071E3"
              />
            </div>

            <section class="insights-section">
              <header class="insights-head">
                <h3>Trend insights</h3>
                <span class="muted">
                  Latest {{ t.latestMonthStart | date: 'MMM d' }}–{{
                    t.latestMonthEnd | date: 'MMM d'
                  }}
                  vs baseline
                  {{ t.baselineStart | date: 'MMM d' }}–{{ t.baselineEnd | date: 'MMM d' }}
                </span>
              </header>
              <div class="insights-grid two-col">
                <article class="insight-card">
                  <header class="insight-head">
                    <span class="insight-title">Anomalies</span>
                    <span class="muted insight-status">
                      {{ anomalyCount() }} flagged · threshold ±{{
                        t.anomalyThresholdPct * 100 | number: '1.0-0'
                      }}%
                    </span>
                  </header>
                  @if (anomalyRows().length === 0) {
                    <p class="empty-line muted">
                      No buckets crossed the ±{{ t.anomalyThresholdPct * 100 | number: '1.0-0' }}%
                      drift threshold. Rejection mix is stable vs baseline.
                    </p>
                  } @else {
                    <ul class="anomaly-list">
                      @for (row of anomalyRows(); track row.stage + row.reason) {
                        <li class="anomaly" [attr.data-sign]="row.deltaPct >= 0 ? 'up' : 'down'">
                          <span class="anomaly-tag">
                            {{ row.deltaPct >= 0 ? '↑' : '↓' }}
                            {{ row.deltaPct * 100 | number: '1.0-0' }}%
                          </span>
                          <span class="small mono">{{ row.stage }} / {{ row.reason }}</span>
                          @if (row.hint) {
                            <span class="small muted">— {{ row.hint }}</span>
                          }
                        </li>
                      }
                    </ul>
                  }
                </article>

                <article class="insight-card">
                  <header class="insight-head">
                    <span class="insight-title">Largest |Δ|</span>
                    <span class="muted insight-status">top by abs delta</span>
                  </header>
                  <ul class="breakdown">
                    @for (row of topDeltaRows(); track row.stage + row.reason) {
                      <li class="bd-row delta">
                        <span class="small mono">{{ row.stage }} / {{ row.reason }}</span>
                        <span class="bd-bar">
                          <span
                            class="bd-fill"
                            [class.up]="row.deltaPct >= 0"
                            [class.down]="row.deltaPct < 0"
                            [style.width.%]="deltaBarPct(row.deltaPct)"
                          ></span>
                        </span>
                        <span class="mono num">
                          {{ row.deltaPct >= 0 ? '+' : ''
                          }}{{ row.deltaPct * 100 | number: '1.1-1' }}%
                        </span>
                      </li>
                    }
                  </ul>
                </article>
              </div>
            </section>

            <section class="data-table-card">
              <header class="board-head">
                <h3>Latest month vs baseline</h3>
                <span class="muted">{{ t.rows.length }} (stage, reason) bucket(s)</span>
              </header>
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Reason</th>
                    <th class="num">Latest #</th>
                    <th class="num">Latest %</th>
                    <th class="num">Baseline #</th>
                    <th class="num">Baseline %</th>
                    <th class="num">Δ</th>
                    <th>Anomaly</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of t.rows; track row.stage + row.reason) {
                    <tr [class.row-anomaly]="row.isAnomaly">
                      <td class="mono small">{{ row.stage }}</td>
                      <td class="mono small">{{ row.reason }}</td>
                      <td class="num mono">{{ row.latestMonthCount | number }}</td>
                      <td class="num mono">
                        {{ row.latestMonthSharePct * 100 | number: '1.1-1' }}%
                      </td>
                      <td class="num mono">{{ row.baselineCount | number }}</td>
                      <td class="num mono">{{ row.baselineSharePct * 100 | number: '1.1-1' }}%</td>
                      <td
                        class="num mono"
                        [class.delta-up]="row.deltaPct > 0"
                        [class.delta-down]="row.deltaPct < 0"
                      >
                        {{ row.deltaPct >= 0 ? '+' : ''
                        }}{{ row.deltaPct * 100 | number: '1.1-1' }}%
                      </td>
                      <td>
                        @if (row.isAnomaly) {
                          <span class="sev-pill" data-sev="High">flagged</span>
                        } @else {
                          <span class="muted small">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        }

        <!-- ═══════════ SCREENING GATES ═══════════ -->
        @if (activeTab() === 'gates') {
          @if (gatesLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (!gates()) {
            <app-error-state
              title="No screening-gate binding report"
              message="Engine returned no gate binding report. The endpoint may need recent backtest failures."
            />
          } @else if (gates(); as g) {
            <div class="kpi-strip">
              <app-metric-card
                label="Total failures"
                [value]="g.totalFailures"
                format="number"
                dotColor="#FF9500"
              />
              <app-metric-card
                label="Lookback"
                [value]="g.lookbackDays"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Reliable"
                [value]="g.isReliable ? 1 : 0"
                format="number"
                [dotColor]="g.isReliable ? '#34C759' : '#FF3B30'"
              />
              <app-metric-card
                label="Reasons"
                [value]="g.rows.length"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Binding share"
                [value]="g.bindingReasonShare * 100"
                format="percent"
                [dotColor]="
                  g.bindingReasonShare >= 0.7
                    ? '#FF3B30'
                    : g.bindingReasonShare >= 0.4
                      ? '#FF9500'
                      : '#34C759'
                "
              />
              <app-metric-card
                label="Strategy types"
                [value]="distinctTopTypes()"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Underfit rows"
                [value]="underfitCount()"
                format="number"
                [dotColor]="underfitCount() > 0 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Overfit rows"
                [value]="overfitCount()"
                format="number"
                [dotColor]="overfitCount() > 0 ? '#FF3B30' : '#34C759'"
              />
            </div>

            <section class="insights-section">
              <header class="insights-head">
                <h3>Gate binding · {{ g.overallClass }}</h3>
                <span class="muted">
                  {{ g.windowStart | date: 'MMM d' }}–{{ g.windowEnd | date: 'MMM d' }} · binding on
                  <strong>{{ g.bindingReason }}</strong>
                  ({{ g.bindingReasonShare * 100 | number: '1.0-0' }}%)
                </span>
              </header>
              <div class="insights-grid two-col">
                <article class="insight-card">
                  <header class="insight-head">
                    <span class="insight-title">Engine recommendation</span>
                    <span
                      class="sev-pill insight-status"
                      [attr.data-sev]="g.overallClass === 'Overfit' ? 'High' : 'Medium'"
                    >
                      {{ g.overallClass }}
                    </span>
                  </header>
                  <p class="recommendation">{{ g.recommendation }}</p>
                </article>

                <article class="insight-card">
                  <header class="insight-head">
                    <span class="insight-title">By reason</span>
                    <span class="muted insight-status">share of failures</span>
                  </header>
                  <ul class="breakdown">
                    @for (row of g.rows; track row.reason) {
                      <li class="bd-row">
                        <span class="small mono">{{ row.reason }}</span>
                        <span class="bd-bar">
                          <span class="bd-fill amber" [style.width.%]="row.sharePct * 100"></span>
                        </span>
                        <span class="mono num">{{ row.count | number }}</span>
                        <span class="muted small">{{ row.sharePct * 100 | number: '1.0-0' }}%</span>
                      </li>
                    }
                  </ul>
                </article>
              </div>
            </section>

            <section class="data-table-card">
              <header class="board-head">
                <h3>Per-reason breakdown</h3>
                <span class="muted">{{ g.rows.length }} reason(s)</span>
              </header>
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th class="num">Count</th>
                    <th class="num">Share</th>
                    <th>Class</th>
                    <th>Top strategy type</th>
                    <th class="num">Top type #</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of g.rows; track row.reason) {
                    <tr [class.row-binding]="row.reason === g.bindingReason">
                      <td class="mono small">{{ row.reason }}</td>
                      <td class="num mono">{{ row.count | number }}</td>
                      <td class="num mono">{{ row.sharePct * 100 | number: '1.1-1' }}%</td>
                      <td>
                        <span
                          class="sev-pill"
                          [attr.data-sev]="row.class === 'Overfit' ? 'High' : 'Medium'"
                          >{{ row.class }}</span
                        >
                      </td>
                      <td class="mono small">{{ row.topStrategyType ?? '—' }}</td>
                      <td class="num mono">{{ row.topStrategyTypeCount | number }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        }

        <!-- ═══════════ SIGNAL REJECTIONS ═══════════ -->
        @if (activeTab() === 'rejections') {
          <section class="data-table-card">
            <header class="board-head">
              <h3>Signal rejections</h3>
              <span class="muted">
                Per-signal audit log — server-side paged. Use the search to filter.
              </span>
            </header>
            <app-data-table
              #rejectionsTable
              [columnDefs]="rejectionColumns"
              [fetchData]="fetchRejections"
              [searchable]="true"
            />
          </section>
        }

        <!-- ═══════════ RECOMMENDED DEFAULTS ═══════════ -->
        @if (activeTab() === 'defaults') {
          @if (defaultsLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (!defaults()) {
            <app-error-state
              title="No defaults recommendation"
              message="Engine returned no defaults report. Needs recent observations to compute distributions."
            />
          } @else if (defaults(); as d) {
            <div class="kpi-strip">
              <app-metric-card
                label="Recommendations"
                [value]="d.defaults.length"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Tightens"
                [value]="tightenCount()"
                format="number"
                [dotColor]="tightenCount() > 0 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Loosens"
                [value]="loosenCount()"
                format="number"
                [dotColor]="loosenCount() > 0 ? '#0071E3' : '#34C759'"
              />
              <app-metric-card
                label="Unchanged"
                [value]="unchangedCount()"
                format="number"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Total samples"
                [value]="totalSamples()"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Avg exclusion"
                [value]="avgExclusion()"
                format="percent"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Generated (min ago)"
                [value]="generatedMinutesAgo()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Analysis days"
                [value]="analysisDays()"
                format="number"
                dotColor="#AF52DE"
              />
            </div>

            <section class="defaults-list">
              @for (entry of d.defaults; track entry.configKey) {
                <article class="default-card" [attr.data-trend]="trendOf(entry)">
                  <header class="default-head">
                    <div class="default-title">
                      <span class="mono key">{{ entry.configKey }}</span>
                      <span class="sev-pill" [attr.data-sev]="severityOf(entry)">
                        {{ trendOf(entry) }}
                      </span>
                    </div>
                    <div class="default-numbers">
                      <span class="num-cell">
                        <span class="num-label">CURRENT</span>
                        <span class="num-val mono">{{ entry.currentFloor }}</span>
                      </span>
                      <span class="arrow">→</span>
                      <span class="num-cell">
                        <span class="num-label">RECOMMENDED</span>
                        <span class="num-val mono">{{ entry.recommendedFloor }}</span>
                      </span>
                      <span class="num-cell">
                        <span class="num-label">EXCLUDES</span>
                        <span class="num-val mono">
                          {{ entry.exclusionRatePct | number: '1.1-1' }}%
                        </span>
                      </span>
                    </div>
                  </header>
                  <p class="default-desc">{{ entry.floorDescription }} · {{ entry.dataSource }}</p>
                  <p class="default-rationale">{{ entry.recommendationRationale }}</p>

                  @if (hasDistribution(entry)) {
                    <div class="distribution">
                      <div class="dist-label">
                        <span class="small muted"
                          >DISTRIBUTION ({{ entry.sampleCount }} samples)</span
                        >
                        <span class="dist-legend">
                          <span class="dist-legend-dot current"></span>
                          current
                        </span>
                        <span class="dist-legend">
                          <span class="dist-legend-dot recommended"></span>
                          recommended
                        </span>
                      </div>
                      <div class="dist-bar">
                        @for (p of percentilePoints(entry); track p.label) {
                          <span
                            class="dist-tick"
                            [style.left.%]="p.pct"
                            [title]="p.label + ': ' + p.value"
                          >
                            <span class="dist-tick-bar"></span>
                            <span class="dist-tick-label">{{ p.label }}</span>
                            <span class="dist-tick-val mono">{{ formatDistValue(p.value) }}</span>
                          </span>
                        }
                        <span
                          class="dist-marker current"
                          [style.left.%]="markerPct(entry, entry.currentFloor)"
                          [title]="'Current: ' + formatDistValue(entry.currentFloor)"
                        ></span>
                        <span
                          class="dist-marker recommended"
                          [style.left.%]="markerPct(entry, entry.recommendedFloor)"
                          [title]="'Recommended: ' + formatDistValue(entry.recommendedFloor)"
                        ></span>
                      </div>
                    </div>
                  } @else {
                    <p class="small muted dist-empty">
                      No distribution available — {{ entry.sampleCount }} sample(s).
                    </p>
                  }
                </article>
              }
            </section>
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      /* Page-level vertical rhythm matches the other operator-console
         pages (positions/deltas, alert-triage, etc.) — flex column with
         space-4 gap between major sections, then each section can still
         opt for extra bottom margin if it needs more breathing room. */
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }

      /* ── KPI strip ── */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      @media (max-width: 1400px) {
        .kpi-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* ── Insights ── */
      .insights-section {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .insights-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .insights-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .insights-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .insights-grid {
        display: grid;
        gap: 1px;
        background: var(--border);
      }
      .insights-grid.two-col {
        grid-template-columns: 1fr 1fr;
      }
      @media (max-width: 900px) {
        .insights-grid.two-col {
          grid-template-columns: 1fr;
        }
      }
      .insight-card {
        background: var(--bg-secondary);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-height: 160px;
      }
      .insight-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-2);
      }
      .insight-title {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .insight-status {
        font-size: 10.5px;
      }
      .empty-line {
        margin: 0;
        font-size: var(--text-xs);
      }
      .recommendation {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }

      /* ── Anomaly list (Trend tab) ── */
      .anomaly-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .anomaly {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 4px 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .anomaly[data-sign='up'] {
        background: rgba(239, 68, 68, 0.08);
      }
      .anomaly[data-sign='down'] {
        background: rgba(59, 130, 246, 0.08);
      }
      .anomaly-tag {
        font-size: 10px;
        font-weight: var(--font-bold);
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--bg-secondary);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      /* ── Breakdown ── */
      .breakdown {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .bd-row {
        display: grid;
        grid-template-columns: 1fr 60px 36px 36px;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .bd-row.delta {
        grid-template-columns: 1fr 80px 56px;
      }
      .bd-bar {
        display: inline-block;
        position: relative;
        height: 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .bd-fill {
        display: block;
        height: 100%;
        background: #ff9500;
      }
      .bd-fill.amber {
        background: #ff9500;
      }
      .bd-fill.up {
        background: #ef4444;
      }
      .bd-fill.down {
        background: #3b82f6;
      }
      .bd-row .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* ── Board tables ── */
      .data-table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .board-table th,
      .board-table td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        vertical-align: middle;
      }
      .board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .board-table td.num,
      .board-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .row-anomaly {
        background: rgba(255, 149, 0, 0.05);
      }
      .row-binding {
        background: rgba(239, 68, 68, 0.05);
      }
      .delta-up {
        color: rgb(220, 38, 38);
        font-weight: var(--font-semibold);
      }
      .delta-down {
        color: rgb(37, 99, 235);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-secondary);
      }
      .sev-pill {
        font-size: 10px;
        font-weight: var(--font-bold);
        padding: 1px 6px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sev-pill[data-sev='Critical'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .sev-pill[data-sev='High'] {
        background: rgba(255, 149, 0, 0.15);
        color: rgb(217, 119, 6);
      }
      .sev-pill[data-sev='Medium'] {
        background: rgba(59, 130, 246, 0.15);
        color: rgb(37, 99, 235);
      }
      .sev-pill[data-sev='Info'] {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      /* ── Recommended Defaults cards ── */
      .defaults-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .default-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5) var(--space-5) var(--space-5);
        box-shadow: var(--shadow-sm);
      }
      .default-card[data-trend='Tighten'] {
        border-left: 3px solid #ff9500;
      }
      .default-card[data-trend='Loosen'] {
        border-left: 3px solid #0071e3;
      }
      .default-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
        margin-bottom: var(--space-4);
        padding-bottom: var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .default-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .default-title .key {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .default-numbers {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .num-cell {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 1px;
      }
      .num-label {
        font-size: 9px;
        font-weight: var(--font-bold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .num-val {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .arrow {
        color: var(--text-tertiary);
        font-size: var(--text-base);
      }
      .default-desc {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.5;
      }
      .default-rationale {
        margin: var(--space-3) 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.5;
      }

      .distribution {
        margin-top: var(--space-5);
        padding-top: var(--space-4);
        border-top: 1px dashed var(--border);
      }
      .dist-label {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        margin-bottom: var(--space-3);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .dist-legend {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: none;
        letter-spacing: 0;
      }
      .dist-legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      .dist-legend-dot.current {
        background: #ff9500;
      }
      .dist-legend-dot.recommended {
        background: #0071e3;
      }
      /* Pad the bar horizontally so ticks at the extreme min/max edges
         don't clip against the rounded corners and have room to render
         their labels without being cut off. */
      .dist-bar {
        position: relative;
        height: 80px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        margin: 0 var(--space-4);
      }
      .dist-tick {
        position: absolute;
        top: 0;
        height: 100%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
        padding: 6px 0;
        min-width: 0;
      }
      .dist-tick-bar {
        width: 1px;
        height: 14px;
        background: var(--text-tertiary);
        flex-shrink: 0;
      }
      .dist-tick-label {
        font-size: 9px;
        color: var(--text-tertiary);
        font-weight: var(--font-bold);
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .dist-tick-val {
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        white-space: nowrap;
        padding: 1px 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
      }
      .dist-marker {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        transform: translateX(-50%);
        z-index: 2;
      }
      .dist-marker.current {
        background: #ff9500;
        box-shadow: 0 0 0 1px var(--bg-secondary);
      }
      .dist-marker.recommended {
        background: #0071e3;
        box-shadow: 0 0 0 1px var(--bg-secondary);
      }
      .dist-empty {
        margin: var(--space-4) 0 0;
        padding: var(--space-3) var(--space-4);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        border-top: 1px dashed var(--border);
      }
    `,
  ],
  providers: [DatePipe],
})
export class CalibrationPageComponent {
  private readonly service = inject(CalibrationService);

  @ViewChild('rejectionsTable')
  rejectionsTable?: DataTableComponent<SignalRejectionEntryDto>;

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
    { headerName: 'Stage', field: 'stage', width: 160 },
    { headerName: 'Reason', field: 'reason', flex: 1, minWidth: 220 },
    { headerName: 'Detail', field: 'detail', flex: 2, minWidth: 320 },
    { headerName: 'Strategy', field: 'strategyId', width: 110 },
    { headerName: 'Symbol', field: 'symbol', width: 100 },
    { headerName: 'Source', field: 'source', width: 160 },
    { headerName: 'Rejected', field: 'rejectedAt', width: 180 },
  ];

  readonly fetchRejections = (
    params: PagerRequest,
  ): Observable<PagedData<SignalRejectionEntryDto>> =>
    this.service
      .listSignalRejections(params)
      .pipe(map((r) => r.data ?? emptyPaged<SignalRejectionEntryDto>()));

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

  // ── Trend computeds ────────────────────────────────────────────────

  readonly anomalyRows = computed(() => (this.trend()?.rows ?? []).filter((r) => r.isAnomaly));
  readonly anomalyCount = computed(() => this.anomalyRows().length);
  readonly distinctStages = computed(
    () => new Set((this.trend()?.rows ?? []).map((r) => r.stage)).size,
  );
  readonly largestDeltaPct = computed(() => {
    const rows = this.trend()?.rows ?? [];
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((r) => Math.abs(r.deltaPct) * 100));
  });
  readonly topDeltaRows = computed<CalibrationTrendRowDto[]>(() =>
    [...(this.trend()?.rows ?? [])]
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
      .slice(0, 6),
  );
  /** Map a deltaPct into a 0-100% bar width — bar maxes out at 50% delta. */
  deltaBarPct(deltaPct: number): number {
    return Math.min(100, (Math.abs(deltaPct) / 0.5) * 100);
  }

  // ── Gates computeds ────────────────────────────────────────────────

  readonly distinctTopTypes = computed(() => {
    const types = new Set(
      (this.gates()?.rows ?? []).map((r) => r.topStrategyType).filter((t): t is string => !!t),
    );
    return types.size;
  });
  readonly underfitCount = computed(
    () => (this.gates()?.rows ?? []).filter((r) => r.class === 'Underfit').length,
  );
  readonly overfitCount = computed(
    () => (this.gates()?.rows ?? []).filter((r) => r.class === 'Overfit').length,
  );

  // ── Defaults computeds ────────────────────────────────────────────

  readonly tightenCount = computed(
    () => (this.defaults()?.defaults ?? []).filter((d) => this.trendOf(d) === 'Tighten').length,
  );
  readonly loosenCount = computed(
    () => (this.defaults()?.defaults ?? []).filter((d) => this.trendOf(d) === 'Loosen').length,
  );
  readonly unchangedCount = computed(
    () => (this.defaults()?.defaults ?? []).filter((d) => this.trendOf(d) === 'Unchanged').length,
  );
  readonly totalSamples = computed(() =>
    (this.defaults()?.defaults ?? []).reduce((sum, d) => sum + d.sampleCount, 0),
  );
  readonly avgExclusion = computed(() => {
    const items = this.defaults()?.defaults ?? [];
    if (items.length === 0) return 0;
    return items.reduce((sum, d) => sum + d.exclusionRatePct, 0) / items.length;
  });
  readonly generatedMinutesAgo = computed(() => {
    const d = this.defaults();
    if (!d) return 0;
    return Math.floor((Date.now() - new Date(d.generatedAtUtc).getTime()) / 60_000);
  });
  readonly analysisDays = computed(() => {
    const d = this.defaults();
    if (!d) return 0;
    const from = new Date(d.analysisFromUtc).getTime();
    const to = new Date(d.analysisToUtc).getTime();
    return Math.round((to - from) / (24 * 60 * 60 * 1000));
  });

  trendOf(entry: DefaultsCalibrationEntryDto): 'Tighten' | 'Loosen' | 'Unchanged' {
    if (entry.recommendedFloor > entry.currentFloor) return 'Tighten';
    if (entry.recommendedFloor < entry.currentFloor) return 'Loosen';
    return 'Unchanged';
  }

  severityOf(entry: DefaultsCalibrationEntryDto): 'High' | 'Medium' | 'Info' {
    const t = this.trendOf(entry);
    if (t === 'Tighten') return 'High';
    if (t === 'Loosen') return 'Medium';
    return 'Info';
  }

  /**
   * Map an absolute value into a percentage position along the distribution
   * bar (min → 0%, max → 100%). Used to plot the current / recommended
   * floor markers and the percentile ticks. Returns 50% (mid-bar) when the
   * entry has no distribution — e.g. the strategy-promotion floor that
   * comes back with 0 samples and no percentile object.
   */
  markerPct(entry: DefaultsCalibrationEntryDto, value: number): number {
    if (!entry.distribution) return 50;
    const { min, max } = entry.distribution;
    if (max <= min) return 50;
    const pct = ((value - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  percentilePoints(
    entry: DefaultsCalibrationEntryDto,
  ): Array<{ label: string; pct: number; value: number }> {
    if (!entry.distribution) return [];
    const d = entry.distribution;
    const raw = [
      { label: 'P5', value: d.p5 },
      { label: 'P25', value: d.p25 },
      { label: 'P50', value: d.p50 },
      { label: 'P75', value: d.p75 },
      { label: 'P95', value: d.p90 },
    ].map((p) => ({ ...p, pct: this.markerPct(entry, p.value) }));

    // Merge ticks that land within 6% of each other so labels never overlap.
    // Common pattern: P5/P10/P25 collapsing to the same value at low-spread
    // distributions (e.g. WalkForward:MinInSampleDays where p5=p10=p25=67).
    // Without this dedupe, the labels stack on top of each other and read
    // as a garbled mash.
    const merged: Array<{ label: string; pct: number; value: number }> = [];
    for (const p of raw) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.pct - p.pct) < 6) {
        last.label = `${last.label}/${p.label}`;
      } else {
        merged.push({ ...p });
      }
    }
    return merged;
  }

  hasDistribution(entry: DefaultsCalibrationEntryDto): boolean {
    return !!entry.distribution;
  }

  /**
   * Compact value formatting for distribution ticks — keeps the rendering
   * legible when values are either huge integers (sample sizes) or very
   * precise floats (e.g. MinDeflatedSharpe at -17.7675681222764). Fixes the
   * label-overflow bug where long decimals bled into the next tick.
   */
  formatDistValue(v: number): string {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    if (abs >= 100) return v.toFixed(0);
    if (abs >= 10) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(2);
    return v.toFixed(3);
  }
}

function emptyPaged<T>(): PagedData<T> {
  return {
    pager: {
      totalItemCount: 0,
      filter: null,
      currentPage: 1,
      itemCountPerPage: 25,
      pageNo: 1,
      pageSize: 25,
    },
    data: [] as T[],
  };
}
