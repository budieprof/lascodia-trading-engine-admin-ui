import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Observable, catchError, map, of, timeout } from 'rxjs';
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
                label="Stages"
                [value]="distinctStages()"
                format="number"
                dotColor="#AF52DE"
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
                  {{ t.baselineStart | date: 'MMM d' }}–{{ t.baselineEnd | date: 'MMM d' }} ·
                  anomaly threshold ±{{ t.anomalyThresholdPct * 100 | number: '1.0-0' }}% · buckets
                  need ≥ {{ t.minBaselineCount | number }} baseline rejections
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
                            [class.up]="row.deltaPct > 0"
                            [class.down]="row.deltaPct < 0"
                            [style.width.%]="deltaBarPct(row.deltaPct)"
                          ></span>
                        </span>
                        <span class="mono num" [attr.data-delta]="deltaKind(row)">
                          {{ deltaLabel(row) }}
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
                        [class.delta-up]="deltaKind(row) === 'up'"
                        [class.delta-down]="deltaKind(row) === 'down'"
                      >
                        @if (deltaKind(row) === 'new') {
                          <span
                            class="sev-pill"
                            data-sev="Medium"
                            title="No baseline rejections in this bucket — share delta is undefined"
                            >new</span
                          >
                        } @else {
                          {{ deltaLabel(row) }}
                        }
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
            <!-- Backtest screening failures are a different stream from the
                 per-signal viability rejections on the Trend tab, so the two
                 tabs can legitimately disagree; say so where the reader is. -->
            <p class="tab-note muted">
              Strategy-generation screening failures (in-sample / out-of-sample / Monte Carlo gates)
              over the last {{ g.lookbackDays }} day{{ g.lookbackDays === 1 ? '' : 's' }} —
              {{ g.windowStart | date: 'MMM d' }}–{{ g.windowEnd | date: 'MMM d' }}. Distinct from
              the per-signal viability rejections on the Trend tab.
            </p>

            @if (g.totalFailures === 0 || g.rows.length === 0) {
              <section class="insights-section">
                <div class="compact-empty">
                  <strong>No screening-gate failures recorded in this window.</strong>
                  <span class="muted">
                    The binding report classifies which gate is bindingly tight only once
                    strategy-generation backtests have failed a gate. Either no candidates were
                    screened in the last {{ g.lookbackDays }} days, or the failure log is not being
                    written — check the strategy-generation worker.
                  </span>
                </div>
              </section>
            } @else {
              <div class="kpi-strip">
                <app-metric-card
                  label="Total failures"
                  [value]="g.totalFailures"
                  format="number"
                  dotColor="#FF9500"
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
                  label="Underfit reasons"
                  [value]="underfitCount()"
                  format="number"
                  [dotColor]="underfitCount() > 0 ? '#FF9500' : '#34C759'"
                />
                <app-metric-card
                  label="Overfit reasons"
                  [value]="overfitCount()"
                  format="number"
                  [dotColor]="overfitCount() > 0 ? '#FF3B30' : '#34C759'"
                />
              </div>

              <section class="insights-section">
                <header class="insights-head">
                  <h3>Gate binding · {{ classLabel(g.overallClass) }}</h3>
                  <span class="muted">
                    @if (g.bindingReason) {
                      binding on <strong>{{ g.bindingReason }}</strong> ({{
                        g.bindingReasonShare * 100 | number: '1.0-0'
                      }}% of failures)
                    } @else {
                      no single gate dominates the failure mix
                    }
                    ·
                    @if (g.isReliable) {
                      sample size reliable
                    } @else {
                      <span class="warn-text"
                        >sample below the reliability floor — treat as indicative</span
                      >
                    }
                  </span>
                </header>
                <div class="insights-grid two-col">
                  <article class="insight-card">
                    <header class="insight-head">
                      <span class="insight-title">Engine recommendation</span>
                      <span
                        class="sev-pill insight-status"
                        [attr.data-sev]="classSeverity(g.overallClass)"
                      >
                        {{ classLabel(g.overallClass) }}
                      </span>
                    </header>
                    @if (g.recommendation) {
                      <p class="recommendation">{{ g.recommendation }}</p>
                    } @else {
                      <p class="empty-line muted">
                        No recommendation — the engine could not classify the binding gate from this
                        sample.
                      </p>
                    }
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
                          <span class="muted small"
                            >{{ row.sharePct * 100 | number: '1.0-0' }}%</span
                          >
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
                          <span class="sev-pill" [attr.data-sev]="classSeverity(row.class)">{{
                            classLabel(row.class)
                          }}</span>
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
        }

        <!-- ═══════════ SIGNAL REJECTIONS ═══════════ -->
        @if (activeTab() === 'rejections') {
          <section class="data-table-card">
            <header class="board-head">
              <h3>Signal rejections</h3>
              <span class="muted">
                Per-signal audit log, newest first, server-side paged. Search by signal id
                (<code>8566</code>), symbol (<code>EURUSD</code>), or an exact reason code
                (<code>strategy_inactive</code>).
              </span>
            </header>
            @if (rejectionsError(); as err) {
              <div class="compact-empty">
                <strong>Could not load signal rejections.</strong>
                <span class="muted">{{ err }}</span>
                <button type="button" class="retry-btn" (click)="retryRejections()">Retry</button>
              </div>
            }
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
            <p class="tab-note muted">
              Generated {{ d.generatedAtUtc | date: 'MMM d, HH:mm' }} ({{ generatedAgoLabel() }}) ·
              observations {{ d.analysisFromUtc | date: 'MMM d' }}–{{
                d.analysisToUtc | date: 'MMM d'
              }}
              ({{ analysisDays() }} days) · mean exclusion {{ avgExclusion() | number: '1.1-1' }}%
            </p>

            <div class="kpi-strip">
              <app-metric-card
                label="Floors"
                [value]="d.defaults.length"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Tighten"
                [value]="tightenCount()"
                format="number"
                [dotColor]="tightenCount() > 0 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Loosen"
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
                label="Needs review"
                [value]="reviewCount()"
                format="number"
                [dotColor]="reviewCount() > 0 ? '#FF3B30' : '#34C759'"
              />
              <app-metric-card
                label="Total samples"
                [value]="totalSamples()"
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
                        {{ trendLabel(entry) }}
                      </span>
                      <span class="default-desc">
                        {{ entry.floorDescription }} · {{ entry.dataSource }} ·
                        {{ entry.sampleCount | number }} samples
                      </span>
                    </div>
                    <!-- The decision is the point of the card, so the two
                         floors are the largest type on it; the engine's prose
                         is demoted to a footnote below. -->
                    <div class="default-numbers">
                      <span class="num-cell">
                        <span class="num-label">Current</span>
                        <span class="num-val mono">{{
                          formatFloor(entry, entry.currentFloor)
                        }}</span>
                      </span>
                      <span class="arrow" [attr.data-trend]="trendOf(entry)">→</span>
                      <span class="num-cell">
                        <span class="num-label">Recommended</span>
                        <span class="num-val mono" [attr.data-trend]="trendOf(entry)">{{
                          formatFloor(entry, entry.recommendedFloor)
                        }}</span>
                      </span>
                      <span class="num-cell secondary">
                        <span class="num-label">Excludes today</span>
                        <span class="num-val mono">
                          {{ entry.exclusionRatePct | number: '1.1-1' }}%
                        </span>
                      </span>
                    </div>
                  </header>

                  @if (reviewReason(entry); as why) {
                    <p class="review-note"><strong>Not actionable as-is.</strong> {{ why }}</p>
                  }

                  @if (hasDistribution(entry)) {
                    <div class="distribution">
                      <div class="dist-label">
                        <span class="small muted">Distribution · P5–P90 span</span>
                        <span class="dist-legend">
                          <span class="dist-legend-dot current"></span>
                          current
                        </span>
                        <span class="dist-legend">
                          <span class="dist-legend-dot recommended"></span>
                          recommended
                        </span>
                        <span class="small muted dist-range">
                          min {{ formatDistValue(entry.distribution!.min) }} · max
                          {{ formatDistValue(entry.distribution!.max) }}
                        </span>
                      </div>
                      <div class="dist-bar">
                        <!-- Marker labels live in the top band, percentile
                             labels in the bottom band, so the two can never
                             overprint each other. Markers that share a spot
                             stack instead of colliding. -->
                        @for (m of markerPoints(entry); track m.kind) {
                          <span
                            class="dist-marker"
                            [class.current]="m.kind === 'current'"
                            [class.recommended]="m.kind === 'recommended'"
                            [class.stacked]="m.stacked"
                            [class.off-scale]="m.offScale"
                            [style.left.%]="m.pct"
                            [title]="m.kind + ': ' + m.label"
                          >
                            <span class="dist-marker-label mono">
                              {{ m.offScale ? (m.pct === 0 ? '◂ ' : '') : '' }}{{ m.label
                              }}{{ m.offScale ? (m.pct === 100 ? ' ▸' : '') : '' }}
                            </span>
                          </span>
                        }
                        <span class="dist-axis"></span>
                        @for (p of percentilePoints(entry); track p.label) {
                          <span
                            class="dist-tick"
                            [style.left.%]="p.pct"
                            [title]="p.label + ': ' + formatDistValue(p.value)"
                          >
                            <span class="dist-tick-bar"></span>
                            <span class="dist-tick-label">{{ p.label }}</span>
                            <span class="dist-tick-val mono">{{ formatDistValue(p.value) }}</span>
                          </span>
                        }
                      </div>
                    </div>
                  } @else {
                    <p class="small muted dist-empty">
                      No distribution — {{ entry.sampleCount | number }} sample(s) is below the
                      minimum the engine needs for percentiles.
                    </p>
                  }

                  <p class="default-rationale">{{ entry.recommendationRationale }}</p>
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

      /* ── KPI strip ── six tracks that may shrink to zero, so the row can
         never widen the page and every label fits one line. */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
        margin-top: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1200px) {
        .kpi-strip {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .tab-note {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        line-height: 1.5;
      }
      .tab-note + .kpi-strip {
        margin-top: var(--space-2);
      }
      .warn-text {
        color: rgb(217, 119, 6);
      }
      /* One compact message instead of a row of zero tiles + empty panels. */
      .compact-empty {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-5) var(--space-4);
        font-size: var(--text-sm);
        line-height: 1.5;
        max-width: 720px;
      }
      .compact-empty .muted {
        font-size: var(--text-xs);
      }
      .retry-btn {
        align-self: flex-start;
        height: 30px;
        padding: 0 var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        background: var(--bg-tertiary);
        padding: 1px 4px;
        border-radius: 3px;
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
      /* Colour carries direction only; a zero or undefined delta stays neutral. */
      .bd-row .num[data-delta='up'] {
        color: rgb(220, 38, 38);
      }
      .bd-row .num[data-delta='down'] {
        color: rgb(37, 99, 235);
      }
      .bd-row .num[data-delta='new'] {
        color: var(--text-tertiary);
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
      .default-card[data-trend='Review'] {
        border-left: 3px solid rgb(220, 38, 38);
      }
      .default-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        margin-bottom: var(--space-4);
        padding-bottom: var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .default-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
        min-width: 0;
        flex: 1 1 320px;
      }
      .default-title .key {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .default-numbers {
        display: flex;
        align-items: flex-end;
        gap: var(--space-4);
        flex-shrink: 0;
      }
      .num-cell {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
      }
      .num-label {
        font-size: 9px;
        font-weight: var(--font-bold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      /* The floors are the decision — they get the largest type on the card. */
      .num-val {
        font-size: var(--text-2xl);
        line-height: 1.1;
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        letter-spacing: var(--tracking-tight);
      }
      .num-val[data-trend='Tighten'] {
        color: rgb(217, 119, 6);
      }
      .num-val[data-trend='Loosen'] {
        color: rgb(37, 99, 235);
      }
      .num-val[data-trend='Review'] {
        color: rgb(220, 38, 38);
      }
      .num-cell.secondary .num-val {
        font-size: var(--text-base);
        color: var(--text-secondary);
        padding-bottom: 3px;
      }
      .arrow {
        color: var(--text-tertiary);
        font-size: var(--text-xl);
        padding-bottom: 2px;
      }
      .default-desc {
        flex-basis: 100%;
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.5;
      }
      .default-rationale {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.5;
      }
      .review-note {
        margin: 0 0 var(--space-3);
        padding: var(--space-2) var(--space-3);
        font-size: var(--text-xs);
        line-height: 1.5;
        color: rgb(185, 28, 28);
        background: rgba(239, 68, 68, 0.07);
        border-radius: var(--radius-sm);
      }

      .distribution {
        margin-top: var(--space-2);
        padding-top: var(--space-3);
        border-top: 1px dashed var(--border);
      }
      .dist-label {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        margin-bottom: var(--space-2);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .dist-range {
        margin-left: auto;
        text-transform: none;
        letter-spacing: 0;
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
      /* Two label bands: marker chips above the axis, percentile labels
         below it. A generous side margin (labels are ~40px wide and centred
         on their tick) keeps P5 at 0% from spilling out of the card. */
      .dist-bar {
        position: relative;
        height: 96px;
        margin: 0 var(--space-8);
      }
      .dist-axis {
        position: absolute;
        left: 0;
        right: 0;
        top: 44px;
        height: 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .dist-tick {
        position: absolute;
        top: 40px;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
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
      }
      .dist-marker {
        position: absolute;
        top: 22px;
        height: 34px;
        width: 2px;
        transform: translateX(-50%);
        z-index: 2;
      }
      .dist-marker.current {
        background: #ff9500;
      }
      .dist-marker.recommended {
        background: #0071e3;
      }
      .dist-marker-label {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-bottom: 3px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        white-space: nowrap;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        color: #fff;
      }
      .dist-marker.current .dist-marker-label {
        background: #ff9500;
      }
      .dist-marker.recommended .dist-marker-label {
        background: #0071e3;
      }
      /* Second marker at (almost) the same x: lift its chip one row so both stay legible. */
      .dist-marker.stacked {
        top: 4px;
        height: 52px;
      }
      .dist-marker.stacked .dist-marker-label {
        margin-bottom: 1px;
      }
      /* Marker pinned to the edge because its value lies outside the plotted span. */
      .dist-marker.off-scale {
        opacity: 0.75;
      }
      .dist-empty {
        margin: var(--space-3) 0 0;
        padding: var(--space-3) var(--space-4);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
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

  /** Why the last rejections fetch failed, or null. Drives the inline retry panel. */
  readonly rejectionsError = signal<string | null>(null);

  /**
   * The shared table sends `filter: { search }`, but the engine's
   * `SignalRejectionQueryFilter` has no `search` member — it only knows
   * TradeSignalId / Symbol / Reason / Stage exact matches — so the search
   * box silently matched nothing. Translate the one free-text box into the
   * typed filter the handler actually reads: digits → signal id, a 6-letter
   * code → symbol, anything else → exact reason.
   *
   * The audit table is hundreds of thousands of rows; a request that never
   * returns used to leave the grid under a permanent "Loading…" veil. Bound
   * it, and surface a retry instead of an endless spinner.
   */
  readonly fetchRejections = (
    params: PagerRequest,
  ): Observable<PagedData<SignalRejectionEntryDto>> => {
    const raw = (params.filter as { search?: string } | null)?.search?.trim() ?? '';
    let filter: Record<string, string | number> | null = null;
    if (raw) {
      if (/^#?\d+$/.test(raw)) filter = { tradeSignalId: Number(raw.replace('#', '')) };
      else if (/^[A-Za-z]{6}$/.test(raw)) filter = { symbol: raw.toUpperCase() };
      else filter = { reason: raw };
    }
    this.rejectionsError.set(null);
    return this.service.listSignalRejections({ ...params, filter }).pipe(
      timeout({ first: 45_000 }),
      map((r) => {
        if (!r.status) throw new Error(r.message || 'Engine rejected the query.');
        return r.data ?? emptyPaged<SignalRejectionEntryDto>();
      }),
      catchError((err: unknown) => {
        const msg =
          err instanceof Error && err.name === 'TimeoutError'
            ? 'The engine did not answer within 45 s — the audit table is large; narrow the search or retry.'
            : err instanceof Error
              ? err.message
              : 'Network error.';
        this.rejectionsError.set(msg);
        return of(emptyPaged<SignalRejectionEntryDto>());
      }),
    );
  };

  retryRejections(): void {
    this.rejectionsError.set(null);
    this.rejectionsTable?.loadData();
  }

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
  /**
   * Bar width relative to the largest |Δ| on screen. A fixed 50% ceiling
   * left ±0.3% deltas as hairlines — all six bars looked empty.
   */
  private readonly topDeltaScale = computed(() =>
    Math.max(1e-6, ...this.topDeltaRows().map((r) => Math.abs(r.deltaPct))),
  );
  deltaBarPct(deltaPct: number): number {
    return Math.min(100, (Math.abs(deltaPct) / this.topDeltaScale()) * 100);
  }

  /**
   * A bucket with rejections this month but none in the baseline has no
   * meaningful share delta (the engine reports 0); "+0.0%" in red for it
   * was wrong twice over. Zero also gets no sign and no colour.
   */
  deltaKind(row: CalibrationTrendRowDto): 'up' | 'down' | 'zero' | 'new' {
    if (row.baselineCount === 0 && row.latestMonthCount > 0) return 'new';
    if (Math.abs(row.deltaPct) < 0.0005) return 'zero';
    return row.deltaPct > 0 ? 'up' : 'down';
  }
  deltaLabel(row: CalibrationTrendRowDto): string {
    const kind = this.deltaKind(row);
    if (kind === 'new') return 'new';
    if (kind === 'zero') return '0.0%';
    const pct = (row.deltaPct * 100).toFixed(1);
    return `${row.deltaPct > 0 ? '+' : ''}${pct}%`;
  }

  // ── Gates computeds ────────────────────────────────────────────────

  /** Engine class enum → operator wording; "Unknown" is not a verdict. */
  classLabel(cls: string | null | undefined): string {
    switch (cls) {
      case 'Underfit':
        return 'Underfit';
      case 'Overfit':
        return 'Overfit';
      case 'Mixed':
        return 'Mixed';
      default:
        return 'Unclassified';
    }
  }
  classSeverity(cls: string | null | undefined): 'High' | 'Medium' | 'Info' {
    if (cls === 'Overfit') return 'High';
    if (cls === 'Underfit' || cls === 'Mixed') return 'Medium';
    return 'Info';
  }

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
  readonly reviewCount = computed(
    () => (this.defaults()?.defaults ?? []).filter((d) => this.trendOf(d) === 'Review').length,
  );
  readonly generatedAgoLabel = computed(() => {
    const d = this.defaults();
    if (!d) return '';
    const mins = Math.max(
      0,
      Math.floor((Date.now() - new Date(d.generatedAtUtc).getTime()) / 60_000),
    );
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
  });
  readonly analysisDays = computed(() => {
    const d = this.defaults();
    if (!d) return 0;
    const from = new Date(d.analysisFromUtc).getTime();
    const to = new Date(d.analysisToUtc).getTime();
    return Math.round((to - from) / (24 * 60 * 60 * 1000));
  });

  /**
   * The engine's rule is mechanical — ">20% excluded → drop to P5" — and P5
   * of a degenerate distribution is not a floor anyone can ship: a negative
   * deflated-Sharpe minimum, or an evaluation window of one trade. Flag
   * those so the operator does not paste them into config, and keep them
   * out of the Tighten/Loosen tallies. Returns the reason, or null when the
   * recommendation is usable.
   */
  reviewReason(entry: DefaultsCalibrationEntryDto): string | null {
    const cur = entry.currentFloor;
    const rec = entry.recommendedFloor;
    if (rec === cur) return null;
    const key = entry.configKey.toLowerCase();
    const countLike =
      Number.isInteger(cur) &&
      /window|count|trades|size|days|samples|observations|bars|min(imum)?(trades|count)/.test(key);
    if (countLike && rec <= 1 && cur > 1) {
      return `A floor of ${this.formatFloor(entry, rec)} switches the check off; P5 of this distribution is not an operational minimum.`;
    }
    if (cur >= 0 && rec < 0) {
      return `A negative minimum (${this.formatFloor(entry, rec)}) admits every candidate; the P5 rule ran off the bottom of the distribution.`;
    }
    if (entry.exclusionRatePct >= 90 && rec < cur) {
      return `The current floor excludes ${entry.exclusionRatePct.toFixed(1)}% of ${entry.sampleCount.toLocaleString('en-US')} samples — the observed population and the floor measure different things; recalibrate the source before moving the floor.`;
    }
    return null;
  }

  trendOf(entry: DefaultsCalibrationEntryDto): 'Tighten' | 'Loosen' | 'Unchanged' | 'Review' {
    if (this.reviewReason(entry)) return 'Review';
    if (entry.recommendedFloor > entry.currentFloor) return 'Tighten';
    if (entry.recommendedFloor < entry.currentFloor) return 'Loosen';
    return 'Unchanged';
  }
  trendLabel(entry: DefaultsCalibrationEntryDto): string {
    const t = this.trendOf(entry);
    return t === 'Review' ? 'Needs review' : t;
  }

  severityOf(entry: DefaultsCalibrationEntryDto): 'Critical' | 'High' | 'Medium' | 'Info' {
    const t = this.trendOf(entry);
    if (t === 'Review') return 'Critical';
    if (t === 'Tighten') return 'High';
    if (t === 'Loosen') return 'Medium';
    return 'Info';
  }

  /**
   * Current and recommended share one format per card — integers when both
   * are whole, otherwise two decimals with separators. "0" beside
   * "-19.5448498407421" was the engine's raw decimal leaking through.
   */
  formatFloor(entry: DefaultsCalibrationEntryDto, value: number): string {
    if (!Number.isFinite(value)) return '—';
    const whole = Number.isInteger(entry.currentFloor) && Number.isInteger(entry.recommendedFloor);
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(value);
  }

  /**
   * Plotted span for the distribution strip. The strip used to run min→max,
   * and one outlier (MinDeflatedSharpe's min) crammed P5–P90 into the last
   * 8% of the bar. Plot P5→P90 instead, widened just enough to include the
   * current and recommended floors — but by at most one P5–P90 span on
   * either side, so a far-off floor pins to the edge (flagged off-scale)
   * rather than flattening the percentiles again.
   */
  private plotDomain(entry: DefaultsCalibrationEntryDto): { lo: number; hi: number } | null {
    const d = entry.distribution;
    if (!d) return null;
    let lo = Math.min(d.p5, d.p90);
    let hi = Math.max(d.p5, d.p90);
    let span = hi - lo;
    if (span <= 0) {
      const mag = Math.max(Math.abs(lo), 1);
      span = mag * 0.1;
      lo -= span / 2;
      hi += span / 2;
    }
    const pad = span;
    for (const v of [entry.currentFloor, entry.recommendedFloor]) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = Math.max(v, lo - pad);
      if (v > hi) hi = Math.min(v, hi + pad);
    }
    // Breathing room so the P5 / P90 tick labels sit inside the strip.
    const edge = (hi - lo) * 0.04;
    return { lo: lo - edge, hi: hi + edge };
  }

  /** Position of a value along the strip, clamped to [0, 100]. */
  markerPct(entry: DefaultsCalibrationEntryDto, value: number): number {
    const dom = this.plotDomain(entry);
    if (!dom || dom.hi <= dom.lo) return 50;
    const pct = ((value - dom.lo) / (dom.hi - dom.lo)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  /**
   * Current + recommended markers with their value chips. When the two
   * would sit on top of each other the second is stacked one row up; a
   * marker whose value lies outside the plotted span is pinned to the
   * nearest edge and marked off-scale.
   */
  markerPoints(entry: DefaultsCalibrationEntryDto): Array<{
    kind: 'current' | 'recommended';
    pct: number;
    label: string;
    stacked: boolean;
    offScale: boolean;
  }> {
    const dom = this.plotDomain(entry);
    if (!dom) return [];
    const mk = (kind: 'current' | 'recommended', v: number) => ({
      kind,
      pct: this.markerPct(entry, v),
      label: this.formatFloor(entry, v),
      stacked: false,
      offScale: v < dom.lo || v > dom.hi,
    });
    const cur = mk('current', entry.currentFloor);
    const rec = mk('recommended', entry.recommendedFloor);
    if (entry.recommendedFloor === entry.currentFloor) return [cur];
    if (Math.abs(cur.pct - rec.pct) < 14) rec.stacked = true;
    return [cur, rec];
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
      { label: 'P90', value: d.p90 },
    ].map((p) => ({ ...p, pct: this.markerPct(entry, p.value) }));

    // Merge ticks that land within 9% of each other so labels never overlap.
    // Common pattern: P5/P25 collapsing to the same value at low-spread
    // distributions (e.g. WalkForward:MinInSampleDays where p5=p25=67).
    const merged: Array<{ label: string; pct: number; value: number }> = [];
    for (const p of raw) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.pct - p.pct) < 9) {
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
