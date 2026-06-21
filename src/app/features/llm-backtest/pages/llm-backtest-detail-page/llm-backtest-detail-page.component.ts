import {
  Component,
  ChangeDetectionStrategy,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of, Subscription, switchMap, timer } from 'rxjs';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import {
  AnalyzeBacktestSensitivityRequest,
  BacktestCostAttribution,
  BacktestPointOutcome,
  BacktestStatus,
  BacktestStatusName,
  BacktestSweepCurve,
  ConfidenceBucketCohort,
  DirectionCohort,
  GUARD_KNOB_META,
  GridSampling,
  LlmBacktestPoint,
  LlmBacktestRun,
  LlmBacktestService,
  MultiSampleResult,
  MultiSampleStability,
  SweepCurvePoint,
  TimeOfDayCohort,
} from '@core/services/llm-backtest.service';
import {
  AnalyzeSignalSensitivityResultDto,
  SignalSensitivityHeatmapCellDto,
} from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { ThemeService } from '@core/theme/theme.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import {
  BacktestChartSelection,
  LlmBacktestChartModalComponent,
} from '../../components/llm-backtest-chart-modal/llm-backtest-chart-modal.component';
import {
  LlmInvocationModalComponent,
  LlmInvocationModalContext,
} from '../../components/llm-invocation-modal/llm-invocation-modal.component';

/** Header polling cadence for in-flight runs. */
const LIVE_TICK_MS = 5000;

/** Outcome labels to surface in the drill-down filter dropdown. */
const OUTCOME_FILTERS = [
  'HitTP',
  'HitSL',
  'ExpiredPositive',
  'ExpiredNegative',
  'ExpiredFlat',
  'EntryNotReached',
];

/**
 * Detail page for a single LlmBacktestRun. Composed of three rough zones:
 *
 *  1. Header — meta + status + grid summary + progress + cost. Polls every
 *     5 s while the run is Pending or Running.
 *  2. Summary — outcome counters, pie, per-symbol + per-regime cohorts, and
 *     rejection-reason bar chart. Only populated when the worker has written
 *     a terminal SummaryJson.
 *  3. Per-point drill-down — paged table of grid cells with a click-through
 *     to the candle chart modal.
 */
@Component({
  selector: 'app-llm-backtest-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    PercentPipe,
    FormsModule,
    RouterLink,
    NgxEchartsDirective,
    PageHeaderComponent,
    LlmBacktestChartModalComponent,
    LlmInvocationModalComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="run()?.name || 'Run #' + (id() ?? '…')"
        subtitle="LLM Analysis Backtest"
      >
        <a routerLink="/llm-backtest" class="btn-secondary">‹ Back to list</a>
        @if (canCancel()) {
          <button
            type="button"
            class="btn-danger"
            (click)="confirmCancel.set(true)"
            [disabled]="cancelling()"
          >
            Cancel run
          </button>
        }
      </app-page-header>

      @if (loadingRun() && !run()) {
        <section class="card empty">Loading run…</section>
      } @else if (!run()) {
        <section class="card empty error">Run not found.</section>
      } @else if (run(); as r) {
        <!-- Header card -->
        <section class="card header-card">
          <div class="header-row">
            <div class="kv">
              <span class="label">Status</span>
              <span
                class="status-pill"
                [class.pill--pending]="r.status === BacktestStatus.Pending"
                [class.pill--running]="r.status === BacktestStatus.Running"
                [class.pill--completed]="r.status === BacktestStatus.Completed"
                [class.pill--failed]="r.status === BacktestStatus.Failed"
                [class.pill--cancelled]="r.status === BacktestStatus.Cancelled"
              >
                {{ statusLabel(r.status) }}
              </span>
            </div>
            <div class="kv">
              <span class="label">ID</span>
              <span class="mono">#{{ r.id }}</span>
            </div>
            <div class="kv">
              <span class="label">Prompt</span>
              <span class="mono small">{{ r.promptVersion }}</span>
            </div>
            <div class="kv">
              <span class="label">Model tier</span>
              <!-- API serialises enum as string ("Spot"/"Macro"); TS enum is int-valued. Accept both shapes. -->
              <span>{{ modelTierLabel(r.modelTier) }}</span>
            </div>
            <div class="kv">
              <span class="label">Created</span>
              <span>{{ r.createdAt | date: 'medium' }}</span>
            </div>
            <div class="kv">
              <span class="label">Started</span>
              <span>{{ r.startedAt ? (r.startedAt | date: 'medium') : '—' }}</span>
            </div>
            <div class="kv">
              <span class="label">Completed</span>
              <span>{{ r.completedAt ? (r.completedAt | date: 'medium') : '—' }}</span>
            </div>
          </div>

          <div class="header-row">
            <div class="kv kv--wide">
              <span class="label">Grid</span>
              <span>{{ gridSummary() }}</span>
            </div>
            <div class="kv">
              <span class="label">Cost</span>
              <span>
                <strong>{{ r.actualCostUsd | currency: 'USD' }}</strong>
                <small>est {{ r.estimatedCostUsd | currency: 'USD' }}</small>
              </span>
            </div>
            <div class="kv">
              <span class="label">Cache hit ratio</span>
              <span>{{ cacheHitRatio(r) | percent: '1.0-1' }}</span>
            </div>
            <div class="kv">
              <span class="label">Progress</span>
              <span>
                <div class="progress-bar inline">
                  <div class="progress-fill" [style.width.%]="progressPct(r)"></div>
                </div>
                <small>{{ r.completedPoints }} / {{ r.totalPoints }}</small>
              </span>
            </div>
          </div>

          @if (r.note) {
            <div class="header-note">
              <span class="label">Note</span>
              <span>{{ r.note }}</span>
            </div>
          }

          @if (r.errorMessage) {
            <div class="header-error"><strong>Error:</strong> {{ r.errorMessage }}</div>
          }
        </section>

        <!-- Summary metrics — renders during a run too (live aggregates) -->
        @if (effectiveSummary(); as s) {
          @if (isLiveSummary()) {
            <div class="live-banner">
              <span class="live-dot"></span>
              Live aggregates · computed from {{ r.completedPoints }}/{{ r.totalPoints }} points ·
              refreshes every 5s
            </div>
          }
          <section class="stat-grid">
            <div class="stat-card">
              <span class="stat-label">Total Recs</span>
              <span class="stat-value">{{ s.totalRecommendations }}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Viable</span>
              <span class="stat-value">{{ s.viableCount }}</span>
              <span class="stat-foot">{{ viablePct(s) | percent: '1.0-1' }}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Rejected by gate</span>
              <span class="stat-value">{{ s.rejectedByGateCount }}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Bypassed</span>
              <span class="stat-value">{{ s.bypassedCount }}</span>
            </div>
            <div class="stat-card stat-card--hl">
              <span class="stat-label">Hit rate</span>
              <span class="stat-value">{{ s.hitRate | percent: '1.0-1' }}</span>
            </div>
            <div class="stat-card stat-card--hl">
              <span class="stat-label">Expected R</span>
              <span
                class="stat-value"
                [class.profit]="s.expectedR > 0"
                [class.loss]="s.expectedR < 0"
              >
                {{ s.expectedR | number: '1.2-2' }}
              </span>
            </div>
          </section>

          <section class="card-grid">
            <div class="card">
              <h3>Outcomes</h3>
              <div
                echarts
                [options]="outcomeChart()"
                [theme]="echartsTheme()"
                [autoResize]="true"
                class="pie-instance"
              ></div>
            </div>
            <div class="card">
              <h3>Rejection reasons</h3>
              @if (rejectionChartHasData()) {
                <div
                  echarts
                  [options]="rejectionChart()"
                  [theme]="echartsTheme()"
                  [autoResize]="true"
                  class="bar-instance"
                ></div>
              } @else {
                <p class="empty-sub">No rejections recorded.</p>
              }
            </div>
          </section>

          <!-- Phase 3 — multi-sample stability summary. Rendered between the
               headline metrics + the per-symbol breakdown so it sits with the
               other "headline reliability" signals. -->
          @if (s.stability; as stab) {
            <section class="card">
              <h3>Multi-sample stability</h3>
              <div class="stability-grid">
                <div class="stat-card">
                  <span class="stat-label">Samples per point</span>
                  <span class="stat-value">{{ stab.samplesPerPoint }}</span>
                  <span class="stat-foot">
                    {{ stab.pointsWithMultiSample }} / {{ r.completedPoints }} point(s)
                    multi-sampled
                  </span>
                </div>
                <div class="stat-card">
                  <span class="stat-label">Hit rate (mean ± SD)</span>
                  <span class="stat-value">
                    {{ stab.meanOfMeanHitRates | percent: '1.1-1' }}
                    <small>± {{ stab.meanOfStdDevHitRates | percent: '1.1-1' }}</small>
                  </span>
                </div>
                <div class="stat-card">
                  <span class="stat-label">Expected R (mean ± SD)</span>
                  <span class="stat-value">
                    {{ stab.meanOfMeanExpectedRs | number: '1.2-2' }}R
                    <small>± {{ stab.meanOfStdDevExpectedRs | number: '1.2-2' }}R</small>
                  </span>
                </div>
                <div class="stat-card">
                  <span class="stat-label">Viable count (mean ± SD)</span>
                  <span class="stat-value">
                    {{ stab.meanOfMeanViableCount | number: '1.1-1' }}
                    <small>± {{ stab.meanOfStdDevViableCount | number: '1.1-1' }}</small>
                  </span>
                </div>
              </div>
              <p class="stability-verdict" [class.stability-verdict--unstable]="isUnstable(stab)">
                @switch (stabilityVerdict(stab)) {
                  @case ('stable') {
                    <strong>Highly stable</strong> — single-sample results are trustworthy.
                  }
                  @case ('moderate') {
                    <strong>Moderately stable</strong> — single-sample point estimates are within
                    typical bounds.
                  }
                  @default {
                    <strong>Unstable</strong> — single-sample backtest results carry significant
                    variance; treat point estimates with caution.
                  }
                }
              </p>
            </section>
          }

          @if (s.sweepCurve; as sc) {
            <section class="card">
              <h3>Guard threshold sweep curve</h3>
              <p class="muted small">
                <strong>{{ sweepKnobLabel(sc) }}</strong> — {{ sc.curve.length }} value(s) from
                {{ sweepFirst(sc) }} to {{ sweepLast(sc) }}, step {{ sweepStep(sc) }}.
              </p>
              <div
                echarts
                [options]="sweepChart()"
                [theme]="echartsTheme()"
                [autoResize]="true"
                class="sweep-instance"
              ></div>
              @if (bestSweepPoint(sc); as best) {
                <div class="best-knob-card">
                  <div>
                    <span class="best-label">Best knob value</span>
                    <span class="best-value">
                      {{ best.knobValue }}
                      <small>vs default {{ sc.defaultValue }}</small>
                    </span>
                  </div>
                  <div class="best-metrics">
                    <span>Hit rate {{ best.hitRate | percent: '1.1-1' }}</span>
                    <span>Expected R {{ best.expectedR | number: '1.2-2' }}</span>
                    <span class="muted small">{{ bestVsDefaultText(sc, best) }}</span>
                  </div>
                </div>
              }
            </section>
          }

          <section class="card">
            <h3>Per-symbol breakdown</h3>
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th (click)="setSymbolSort('symbol')">Symbol</th>
                    <th class="num" (click)="setSymbolSort('count')">Count</th>
                    <th class="num" (click)="setSymbolSort('hitRate')">Hit rate</th>
                    <th class="num" (click)="setSymbolSort('expectedR')">Expected R</th>
                    <th class="num" (click)="setSymbolSort('meanMfePips')">Mean MFE (pips)</th>
                    <th class="num" (click)="setSymbolSort('meanMaePips')">Mean MAE (pips)</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of sortedPerSymbol(); track row.symbol) {
                    <tr>
                      <td class="mono">{{ row.symbol }}</td>
                      <td class="num">{{ row.count }}</td>
                      <td class="num">{{ row.hitRate | percent: '1.0-1' }}</td>
                      <td
                        class="num"
                        [class.profit]="row.expectedR > 0"
                        [class.loss]="row.expectedR < 0"
                      >
                        {{ row.expectedR | number: '1.2-2' }}
                      </td>
                      <td class="num">{{ row.meanMfePips | number: '1.1-1' }}</td>
                      <td class="num">{{ row.meanMaePips | number: '1.1-1' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          @if (s.perRegime.length > 0) {
            <section class="card">
              <h3>Per-regime breakdown</h3>
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Regime</th>
                      <th class="num">Count</th>
                      <th class="num">Hit rate</th>
                      <th class="num">Expected R</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of s.perRegime; track row.regime) {
                      <tr>
                        <td>{{ row.regime || '—' }}</td>
                        <td class="num">{{ row.count }}</td>
                        <td class="num">{{ row.hitRate | percent: '1.0-1' }}</td>
                        <td
                          class="num"
                          [class.profit]="row.expectedR > 0"
                          [class.loss]="row.expectedR < 0"
                        >
                          {{ row.expectedR | number: '1.2-2' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <!-- Phase 4 (P4.2) — per-direction outcome cohort. Renders only when
               the server emitted at least one row (zero-viable-rec runs leave
               the array empty). -->
          @if ((s.perDirection?.length ?? 0) > 0) {
            <section class="card">
              <h3>Per-direction cohorts</h3>
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th class="num">Count</th>
                      <th class="num">Hit rate</th>
                      <th class="num">Expected R</th>
                      <th class="num">Mean MFE (pips)</th>
                      <th class="num">Mean MAE (pips)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of s.perDirection!; track row.direction) {
                      <tr>
                        <td>
                          <span
                            class="cohort-chip"
                            [class.chip--buy]="row.direction === 'Buy'"
                            [class.chip--sell]="row.direction === 'Sell'"
                          >
                            {{ row.direction }}
                          </span>
                        </td>
                        <td class="num">{{ row.count }}</td>
                        <td class="num">{{ row.hitRate | percent: '1.0-1' }}</td>
                        <td
                          class="num"
                          [class.profit]="row.expectedR > 0"
                          [class.loss]="row.expectedR < 0"
                        >
                          {{ row.expectedR | number: '1.2-2' }}
                        </td>
                        <td class="num">{{ row.meanMfePips | number: '1.1-1' }}</td>
                        <td class="num">{{ row.meanMaePips | number: '1.1-1' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <!-- Phase 4 (P4.2) — per-time-of-day cohort. Bins are colour-coded
               by session (Asia / London / Overlap / NewYorkLate) and rendered
               in temporal flow order. -->
          @if ((s.perTimeOfDay?.length ?? 0) > 0) {
            <section class="card">
              <h3>Per-time-of-day cohorts</h3>
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Bin</th>
                      <th class="num">Count</th>
                      <th class="num">Hit rate</th>
                      <th class="num">Expected R</th>
                      <th class="num">Mean MFE (pips)</th>
                      <th class="num">Mean MAE (pips)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of s.perTimeOfDay!; track row.bin) {
                      <tr>
                        <td>
                          <span
                            class="cohort-chip"
                            [class.chip--asia]="row.bin === 'Asia'"
                            [class.chip--london]="row.bin === 'London'"
                            [class.chip--overlap]="row.bin === 'LondonNYOverlap'"
                            [class.chip--newyork]="row.bin === 'NewYorkLate'"
                          >
                            {{ row.bin }}
                          </span>
                        </td>
                        <td class="num">{{ row.count }}</td>
                        <td class="num">{{ row.hitRate | percent: '1.0-1' }}</td>
                        <td
                          class="num"
                          [class.profit]="row.expectedR > 0"
                          [class.loss]="row.expectedR < 0"
                        >
                          {{ row.expectedR | number: '1.2-2' }}
                        </td>
                        <td class="num">{{ row.meanMfePips | number: '1.1-1' }}</td>
                        <td class="num">{{ row.meanMaePips | number: '1.1-1' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <!-- Phase 4 (P4.2) — per-confidence-bucket cohort. Sorted low → high
               so the operator can scan for non-monotonic calibration. -->
          @if ((s.perConfidenceBucket?.length ?? 0) > 0) {
            <section class="card">
              <h3>Per-confidence cohorts</h3>
              <p class="muted small calibration-note">
                Higher confidence buckets should have higher hit rates if the LLM is
                well-calibrated. Watch for non-monotonic patterns.
              </p>
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Bucket</th>
                      <th class="num">Count</th>
                      <th class="num">Hit rate</th>
                      <th class="num">Expected R</th>
                      <th class="num">Mean MFE (pips)</th>
                      <th class="num">Mean MAE (pips)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of s.perConfidenceBucket!; track row.bucket) {
                      <tr>
                        <td>
                          <span class="cohort-chip chip--confidence">{{ row.bucket }}</span>
                        </td>
                        <td class="num">{{ row.count }}</td>
                        <td class="num">{{ row.hitRate | percent: '1.0-1' }}</td>
                        <td
                          class="num"
                          [class.profit]="row.expectedR > 0"
                          [class.loss]="row.expectedR < 0"
                        >
                          {{ row.expectedR | number: '1.2-2' }}
                        </td>
                        <td class="num">{{ row.meanMfePips | number: '1.1-1' }}</td>
                        <td class="num">{{ row.meanMaePips | number: '1.1-1' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <!-- Phase 2 — per-(symbol, timeframe) cost attribution. Lazily fetched on page load. -->
          @if (costAttribution(); as ca) {
            <section class="card">
              <h3>Cost attribution (per symbol × timeframe)</h3>
              <p class="muted small">
                Total {{ ca.totalCostUsd | currency: 'USD' }} · {{ ca.totalLlmCalls }} LLM call(s) ·
                {{ ca.totalCacheHits }} cache hit(s) ({{ ca.cacheHitRatio | percent: '1.0-1' }})
              </p>
              @if (ca.byPair.length === 0) {
                <p class="empty-sub">No cost rows yet.</p>
              } @else {
                <div class="table-scroll">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th (click)="setCostSort('symbol')">Symbol</th>
                        <th (click)="setCostSort('timeframe')">TF</th>
                        <th class="num" (click)="setCostSort('pointCount')">Points</th>
                        <th class="num" (click)="setCostSort('llmCalls')">LLM calls</th>
                        <th class="num" (click)="setCostSort('cacheHits')">Cache hits</th>
                        <th class="num" (click)="setCostSort('costUsd')">Cost</th>
                        <th class="num" (click)="setCostSort('costPerPointUsd')">Cost / point</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of sortedCostByPair(); track row.symbol + row.timeframe) {
                        <tr>
                          <td class="mono">{{ row.symbol }}</td>
                          <td>{{ row.timeframe }}</td>
                          <td class="num">{{ row.pointCount }}</td>
                          <td class="num">{{ row.llmCalls }}</td>
                          <td class="num">{{ row.cacheHits }}</td>
                          <td class="num">{{ row.costUsd | currency: 'USD' }}</td>
                          <td class="num">
                            {{ row.costPerPointUsd | currency: 'USD' : 'symbol' : '1.4-4' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </section>
          } @else if (loadingCostAttribution()) {
            <section class="card empty">Loading cost attribution…</section>
          }
        } @else {
          <section class="card empty">
            Summary not available — run is still in flight or terminated without one.
          </section>
        }

        <!-- Signal Sensitivity Sweep — replays the run's viable recs through a -->
        <!-- TP/SL multiplier grid; same DTO shape the live signal-sensitivity   -->
        <!-- page consumes so the heatmap component renders identically. P&L     -->
        <!-- on backtest replays is in pips (no lot sizing).                     -->
        <!-- NOTE: r.status arrives from the API as a STRING ("Completed", etc.) -->
        <!-- — the BacktestStatus enum is numeric (0..4) so direct === would     -->
        <!-- always be false. Compare against the string literal instead. The    -->
        <!-- pill-class bindings above (lines 124-128) have the same latent bug; -->
        <!-- left untouched here because pre-existing.                           -->
        @if (isRunCompleted(r.status)) {
          <section class="card">
            <div class="card-head">
              <h3>Signal Sensitivity Sweep</h3>
              <span class="muted small">
                Replay the viable recs at different TP / SL multipliers. Pips, no lot sizing. Free
                re-walk (no LLM tokens).
              </span>
            </div>

            <div class="sens-form">
              <label class="field">
                <span>TP × (chosen)</span>
                <input type="number" step="0.05" min="0.05" [(ngModel)]="sensitivityTp" />
              </label>
              <label class="field">
                <span>SL × (chosen)</span>
                <input type="number" step="0.05" min="0.05" [(ngModel)]="sensitivitySl" />
              </label>
              <label class="field field--wide">
                <span>TP sweep values</span>
                <input
                  type="text"
                  [(ngModel)]="sensitivityTpSweepStr"
                  placeholder="0.5, 0.75, 1.0, 1.25, 1.5"
                />
              </label>
              <label class="field field--wide">
                <span>SL sweep values</span>
                <input
                  type="text"
                  [(ngModel)]="sensitivitySlSweepStr"
                  placeholder="0.5, 0.75, 1.0, 1.5, 2.0"
                />
              </label>
              <label class="field">
                <span>Heatmap colour</span>
                <select
                  [ngModel]="sensitivityHeatmapMetric()"
                  (ngModelChange)="sensitivityHeatmapMetric.set($event)"
                >
                  <option value="winRatePct">Win rate %</option>
                  <option value="realizedPnL">Realized pips</option>
                  <option value="sumPnL">Total pips</option>
                  <option value="profitFactor">Profit factor</option>
                  <option value="expectancy">Expectancy / signal</option>
                </select>
              </label>
              <button
                type="button"
                class="btn-primary"
                (click)="runSensitivity()"
                [disabled]="sensitivityLoading()"
              >
                {{ sensitivityLoading() ? 'Running…' : 'Run sweep' }}
              </button>
            </div>

            @if (sensitivityError(); as err) {
              <div class="empty-sub error">{{ err }}</div>
            }

            @if (sensitivityResult(); as sr) {
              <div class="sens-kpis">
                <div class="kpi">
                  <span class="kpi-label">Viable replayed</span>
                  <span class="kpi-value">{{ sr.signalCount }}</span>
                </div>
                <div class="kpi">
                  <span class="kpi-label">Win rate @ chosen</span>
                  <span
                    class="kpi-value"
                    [class.profit]="sr.aggregate.winRatePct >= 55"
                    [class.loss]="sr.aggregate.winRatePct < 50"
                  >
                    {{ sr.aggregate.winRatePct | number: '1.1-1' }}%
                  </span>
                  <span class="kpi-sub">
                    {{ sr.aggregate.hitTpCount }} TP / {{ sr.aggregate.hitSlCount }} SL ·
                    {{ sr.aggregate.expiredCount }} expired
                  </span>
                </div>
                <div class="kpi">
                  <span class="kpi-label">Realized pips</span>
                  <span
                    class="kpi-value"
                    [class.profit]="sr.aggregate.realizedPnL > 0"
                    [class.loss]="sr.aggregate.realizedPnL < 0"
                  >
                    {{ sr.aggregate.realizedPnL | number: '1.0-1' }} p
                  </span>
                  <span class="kpi-sub"
                    >avg {{ sr.aggregate.avgPnL | number: '1.0-1' }} p / signal</span
                  >
                </div>
                <div class="kpi">
                  <span class="kpi-label">Profit factor</span>
                  <span class="kpi-value">{{ sr.aggregate.profitFactor | number: '1.2-2' }}</span>
                  <span class="kpi-sub"
                    >payoff {{ sr.riskMetrics.payoffRatio | number: '1.2-2' }}</span
                  >
                </div>
              </div>

              @if (sensitivityOptimal(); as opt) {
                <div class="sens-optimal">
                  <strong>Optimum ({{ sensitivityHeatmapMetricLabel() }})</strong>
                  <span class="opt-badge"
                    >TP×{{ opt.tpMultiplier }} · SL×{{ opt.slMultiplier }}</span
                  >
                  <span>
                    Win {{ opt.aggregate.winRatePct | number: '1.1-1' }}% ({{
                      opt.aggregate.hitTpCount
                    }}/{{ opt.aggregate.hitSlCount }})
                  </span>
                  <span
                    [class.profit]="opt.aggregate.realizedPnL > 0"
                    [class.loss]="opt.aggregate.realizedPnL < 0"
                  >
                    {{ opt.aggregate.realizedPnL | number: '1.0-1' }} p realized
                  </span>
                  <span class="muted small">walkable {{ opt.aggregate.walkable }}</span>
                </div>
              }

              @if (sensitivityHeatmapOptions(); as opts) {
                <div
                  echarts
                  [options]="opts"
                  [theme]="themeService.theme() === 'dark' ? 'lascodia-dark' : 'lascodia-light'"
                  class="sens-heatmap"
                ></div>
              }

              <div class="sens-breakdowns">
                @if (sr.breakdownsByDirection.length > 0) {
                  <div class="breakdown-block">
                    <h4>By direction</h4>
                    <table class="data-table compact">
                      <thead>
                        <tr>
                          <th>Side</th>
                          <th class="num">N</th>
                          <th class="num">Win %</th>
                          <th class="num">TP / SL</th>
                          <th class="num">Realized (p)</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (b of sr.breakdownsByDirection; track b.key) {
                          <tr>
                            <td>{{ b.key }}</td>
                            <td class="num">{{ b.aggregate.walkable }}</td>
                            <td
                              class="num"
                              [class.profit]="b.aggregate.winRatePct >= 55"
                              [class.loss]="b.aggregate.winRatePct < 50 && b.aggregate.walkable > 0"
                            >
                              {{ b.aggregate.winRatePct | number: '1.1-1' }}
                            </td>
                            <td class="num">
                              {{ b.aggregate.hitTpCount }} / {{ b.aggregate.hitSlCount }}
                            </td>
                            <td
                              class="num"
                              [class.profit]="b.aggregate.realizedPnL > 0"
                              [class.loss]="b.aggregate.realizedPnL < 0"
                            >
                              {{ b.aggregate.realizedPnL | number: '1.0-1' }}
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }

                @if (sr.breakdownsBySymbol.length > 1) {
                  <div class="breakdown-block">
                    <h4>By symbol</h4>
                    <table class="data-table compact">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th class="num">N</th>
                          <th class="num">Win %</th>
                          <th class="num">TP / SL</th>
                          <th class="num">Realized (p)</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (b of sr.breakdownsBySymbol; track b.key) {
                          <tr>
                            <td class="mono">{{ b.key }}</td>
                            <td class="num">{{ b.aggregate.walkable }}</td>
                            <td
                              class="num"
                              [class.profit]="b.aggregate.winRatePct >= 55"
                              [class.loss]="b.aggregate.winRatePct < 50 && b.aggregate.walkable > 0"
                            >
                              {{ b.aggregate.winRatePct | number: '1.1-1' }}
                            </td>
                            <td class="num">
                              {{ b.aggregate.hitTpCount }} / {{ b.aggregate.hitSlCount }}
                            </td>
                            <td
                              class="num"
                              [class.profit]="b.aggregate.realizedPnL > 0"
                              [class.loss]="b.aggregate.realizedPnL < 0"
                            >
                              {{ b.aggregate.realizedPnL | number: '1.0-1' }}
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }

                <div class="breakdown-block">
                  <h4>Streaks &amp; risk</h4>
                  <table class="data-table compact">
                    <tbody>
                      <tr>
                        <td>Max win streak</td>
                        <td class="num">{{ sr.streaks.maxWinStreak }}</td>
                      </tr>
                      <tr>
                        <td>Max loss streak</td>
                        <td class="num">{{ sr.streaks.maxLossStreak }}</td>
                      </tr>
                      <tr>
                        <td>Current streak</td>
                        <td class="num">
                          {{ sr.streaks.currentStreakLength }} {{ sr.streaks.currentStreakType }}
                        </td>
                      </tr>
                      <tr>
                        <td>Expectancy / signal</td>
                        <td class="num">{{ sr.riskMetrics.expectancy | number: '1.1-1' }} p</td>
                      </tr>
                      <tr>
                        <td>Payoff ratio</td>
                        <td class="num">{{ sr.riskMetrics.payoffRatio | number: '1.2-2' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            } @else if (!sensitivityLoading()) {
              <div class="empty-sub">
                No sweep run yet. Press <strong>Run sweep</strong> above to replay the viable recs
                at the selected TP / SL multipliers.
              </div>
            }
          </section>
        }

        <!-- Per-point drill-down -->
        <section class="card">
          <div class="card-head">
            <h3>Per-point drill-down</h3>
            <div class="point-filters">
              <label class="field">
                <span>Symbol</span>
                <select [(ngModel)]="symbolFilter" (ngModelChange)="onPointsFilter()">
                  <option [ngValue]="null">All</option>
                  @for (sym of availableSymbols(); track sym) {
                    <option [ngValue]="sym">{{ sym }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span>Outcome</span>
                <select [(ngModel)]="outcomeFilter" (ngModelChange)="onPointsFilter()">
                  <option [ngValue]="null">All</option>
                  @for (o of outcomeOptions; track o) {
                    <option [ngValue]="o">{{ o }}</option>
                  }
                </select>
              </label>
            </div>
          </div>

          @if (loadingPoints() && points().length === 0) {
            <div class="empty-sub">Loading points…</div>
          } @else if (points().length === 0) {
            <div class="empty-sub">No points to show.</div>
          } @else {
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>asOfUtc</th>
                    <th>Symbol</th>
                    <th>TF</th>
                    <th class="num">Viable</th>
                    <th class="num">Rejected</th>
                    <th>Outcomes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of points(); track p.id) {
                    <tr
                      class="point-row"
                      [class.point-row--clickable]="hasInvocation(p)"
                      [class.point-row--no-invocation]="!hasInvocation(p)"
                      [title]="
                        hasInvocation(p)
                          ? 'Click to view the LLM prompt + response for this point'
                          : 'No LLM invocation attached (dry-run or pre-fill point)'
                      "
                      (click)="openInvocation(p)"
                    >
                      <td>{{ p.asOfUtc | date: 'short' }}</td>
                      <td class="mono">{{ p.symbol }}</td>
                      <td>{{ p.timeframe }}</td>
                      <td class="num">
                        {{ p.viable.length }}
                        @for (adj of pointAdjustments(p); track adj.label) {
                          <span
                            class="adj-badge"
                            [class.adj-badge--sl]="adj.kind === 'sl'"
                            [class.adj-badge--tp]="adj.kind === 'tp'"
                            [title]="adj.detail"
                            >{{ adj.label }}</span
                          >
                        }
                      </td>
                      <td class="num">{{ p.rejected.length }}</td>
                      <td class="outcomes">
                        @for (chip of outcomeSummary(p); track chip.label) {
                          <span
                            class="outcome-chip chip--small"
                            [class.chip--tp]="chip.label === 'HitTP'"
                            [class.chip--sl]="chip.label === 'HitSL'"
                            [class.chip--exp]="chip.label.startsWith('Expired')"
                            [class.chip--unfilled]="chip.label === 'EntryNotReached'"
                          >
                            {{ chip.count }}× {{ chip.label }}
                          </span>
                        } @empty {
                          <span class="empty-sub">no walker outcomes</span>
                        }
                      </td>
                      <td class="row-action">
                        @if (hasViable(p)) {
                          <button
                            type="button"
                            class="row-icon"
                            title="View chart"
                            (click)="openChartIcon(p, $event)"
                          >
                            📈
                          </button>
                        }
                        @if (hasInvocation(p)) {
                          <span class="row-arrow">›</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <div class="pager">
              <button
                type="button"
                class="btn-secondary"
                (click)="prevPointsPage()"
                [disabled]="pointsPage() <= 1 || loadingPoints()"
              >
                ‹ Prev
              </button>
              <span class="pager-info">
                Page {{ pointsPage() }} of {{ pointsTotalPages() }} — {{ pointsTotal() }} point(s)
              </span>
              <button
                type="button"
                class="btn-secondary"
                (click)="nextPointsPage()"
                [disabled]="pointsPage() >= pointsTotalPages() || loadingPoints()"
              >
                Next ›
              </button>
            </div>
          }
        </section>
      }

      <!-- Chart modal — only mounts when a selection is active. -->
      <app-llm-backtest-chart-modal
        [selection]="chartSelection()"
        (closed)="chartSelection.set(null)"
      />

      <!-- LLM invocation modal — shows raw prompt + response for the
           clicked drill-down row. Opens for ANY point (including all-Hold
           cells, which is exactly when the operator most wants to see what
           the model said). -->
      <app-llm-invocation-modal
        [ctx]="invocationModalCtx()"
        (closed)="invocationModalCtx.set(null)"
      />

      @if (confirmCancel()) {
        <div class="modal-scrim" (click)="confirmCancel.set(false)">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header"><h2>Cancel this run?</h2></div>
            <div class="modal-body">
              The worker will stop at the next point boundary. Already-processed points stay.
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" (click)="confirmCancel.set(false)">
                Keep running
              </button>
              <button
                type="button"
                class="btn-danger"
                (click)="executeCancel()"
                [disabled]="cancelling()"
              >
                @if (cancelling()) {
                  Cancelling…
                } @else {
                  Yes, cancel
                }
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn-secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
        padding: 0.45rem 0.85rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        text-decoration: none;
        cursor: pointer;
      }
      .btn-secondary:hover:not([disabled]) {
        background: var(--bg-tertiary);
      }
      .btn-danger {
        background: #c4290a;
        color: #fff;
        border: none;
        padding: 0.5rem 1rem;
        font-size: 0.85rem;
        font-weight: 600;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .btn-danger:hover:not([disabled]) {
        filter: brightness(1.05);
      }
      [disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        overflow: hidden;
      }
      .card h3 {
        margin: 0 0 0.6rem 0;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: end;
        margin-bottom: 0.6rem;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .empty,
      .empty-sub {
        padding: var(--space-4);
        text-align: center;
        color: var(--text-secondary);
      }
      .empty.error {
        color: #c4290a;
      }

      .header-card {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .header-row {
        display: flex;
        flex-wrap: wrap;
        gap: 1.5rem;
        align-items: flex-start;
      }
      .kv {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .kv--wide {
        flex: 1;
        min-width: 280px;
      }
      .kv .label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .kv small {
        opacity: 0.7;
        font-weight: 400;
        margin-left: 0.25rem;
        font-size: 0.75rem;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .small {
        font-size: 0.78rem;
      }
      .header-note {
        background: var(--bg-tertiary);
        padding: 0.5rem 0.75rem;
        border-radius: var(--radius-sm);
        display: flex;
        gap: 0.5rem;
        font-size: 0.85rem;
      }
      .header-error {
        background: rgba(196, 41, 10, 0.12);
        color: #c4290a;
        padding: 0.5rem 0.75rem;
        border-radius: var(--radius-sm);
        font-size: 0.85rem;
      }

      .status-pill {
        display: inline-block;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .pill--pending {
        background: rgba(142, 142, 147, 0.2);
        color: var(--text-secondary);
      }
      .pill--running {
        background: rgba(0, 113, 227, 0.18);
        color: #0071e3;
      }
      .pill--completed {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .pill--failed {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .pill--cancelled {
        background: rgba(255, 159, 10, 0.18);
        color: #b3640a;
      }

      .progress-bar.inline {
        display: inline-block;
        width: 140px;
        vertical-align: middle;
        height: 6px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.3s ease;
      }

      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .live-banner {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.3rem 0.65rem;
        margin-bottom: 0.5rem;
        background: rgba(0, 113, 227, 0.1);
        border: 1px solid rgba(0, 113, 227, 0.35);
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        color: #0071e3;
        letter-spacing: 0.02em;
      }
      .live-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #0071e3;
        box-shadow: 0 0 0 0 rgba(0, 113, 227, 0.55);
        animation: livePulse 1.4s ease-out infinite;
      }
      @keyframes livePulse {
        0% {
          box-shadow: 0 0 0 0 rgba(0, 113, 227, 0.55);
        }
        70% {
          box-shadow: 0 0 0 8px rgba(0, 113, 227, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(0, 113, 227, 0);
        }
      }
      .stat-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .stat-card--hl {
        background: rgba(0, 113, 227, 0.08);
        border-color: rgba(0, 113, 227, 0.25);
      }
      .stat-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        font-weight: 600;
      }
      .stat-value {
        font-size: 1.4rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .stat-foot {
        font-size: 0.72rem;
        opacity: 0.65;
      }
      .stability-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .stability-grid .stat-value small {
        font-size: 0.85rem;
        opacity: 0.65;
        font-weight: 500;
        margin-left: 0.25rem;
      }
      .stability-verdict {
        margin: 0;
        padding: 0.6rem 0.85rem;
        border-radius: var(--radius-sm);
        background: rgba(0, 113, 227, 0.08);
        border: 1px solid rgba(0, 113, 227, 0.2);
        font-size: 0.88rem;
        color: var(--text-primary);
      }
      .stability-verdict--unstable {
        background: rgba(196, 41, 10, 0.12);
        border-color: rgba(196, 41, 10, 0.3);
        color: #c4290a;
      }

      .card-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 900px) {
        .card-grid {
          grid-template-columns: 1fr;
        }
      }
      .pie-instance,
      .bar-instance {
        width: 100%;
        height: 280px;
      }
      .sweep-instance {
        width: 100%;
        height: 320px;
      }
      .best-knob-card {
        margin-top: 0.6rem;
        padding: 0.75rem 1rem;
        background: rgba(0, 113, 227, 0.08);
        border: 1px solid rgba(0, 113, 227, 0.25);
        border-radius: var(--radius-sm);
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 0.6rem;
        align-items: center;
      }
      .best-label {
        display: block;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .best-value {
        font-size: 1.2rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .best-value small {
        font-size: 0.75rem;
        opacity: 0.7;
        margin-left: 0.3rem;
      }
      .best-metrics {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        font-size: 0.85rem;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-secondary);
      }

      .table-scroll {
        overflow-x: auto;
      }
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .data-table th,
      .data-table td {
        padding: 0.4rem 0.6rem;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .data-table th {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 600;
        cursor: pointer;
        user-select: none;
      }
      .data-table th.num,
      .data-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .data-table tr.point-row--clickable {
        cursor: pointer;
      }
      .data-table tr.point-row--clickable:hover td {
        background: var(--bg-tertiary);
      }
      .outcomes {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
      }
      .outcome-chip {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.1rem 0.45rem;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-weight: 600;
      }
      .chip--small {
        font-size: 0.65rem;
      }
      .chip--tp {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .chip--sl {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .chip--exp {
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }
      .chip--unfilled {
        background: rgba(0, 113, 227, 0.15);
        color: #0071e3;
      }

      /* P4.2 — cohort row chips for direction / time-of-day / confidence
         tables. Sized like the outcome chips but used inline in table cells. */
      .cohort-chip {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.15rem 0.55rem;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .chip--buy {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .chip--sell {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .chip--asia {
        background: rgba(0, 113, 227, 0.18);
        color: #0071e3;
      }
      .chip--london {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .chip--overlap {
        background: rgba(255, 159, 10, 0.22);
        color: #b3640a;
      }
      .chip--newyork {
        background: rgba(175, 82, 222, 0.22);
        color: #7d3bb3;
      }
      .chip--confidence {
        background: rgba(0, 113, 227, 0.12);
        color: #0071e3;
        font-family: var(--font-mono, monospace);
        letter-spacing: 0;
        text-transform: none;
      }
      .calibration-note {
        margin: 0 0 0.5rem 0;
      }
      .row-action {
        text-align: right;
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .row-arrow {
        font-size: 1.2rem;
      }
      .row-icon {
        background: transparent;
        border: 0;
        font-size: 0.95rem;
        margin-right: 0.4rem;
        padding: 0.05rem 0.25rem;
        cursor: pointer;
        opacity: 0.55;
      }
      .row-icon:hover {
        opacity: 1;
        background: var(--bg-secondary);
        border-radius: 4px;
      }
      .point-row--no-invocation {
        opacity: 0.85;
      }

      .point-filters {
        display: flex;
        gap: 0.75rem;
        align-items: end;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
      }
      .field select {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.4rem 0.6rem;
        font-size: 0.85rem;
        min-width: 140px;
      }

      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding-top: var(--space-3);
      }
      .pager-info {
        font-size: 0.8rem;
        color: var(--text-secondary);
      }

      .profit {
        color: #1f8a3d;
      }
      .loss {
        color: #c4290a;
      }
      :host-context([data-theme='dark']) .profit {
        color: #5dd47e;
      }
      :host-context([data-theme='dark']) .loss {
        color: #ff8278;
      }

      .sens-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 0.75rem;
        align-items: end;
        padding: 0.5rem 0 1rem;
        border-bottom: 1px solid var(--border);
      }
      .sens-form .field input,
      .sens-form .field select {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.4rem 0.6rem;
        font-size: 0.85rem;
      }
      .sens-form .field--wide {
        grid-column: span 2;
      }
      .sens-form .btn-primary {
        height: 36px;
        align-self: end;
      }
      .sens-kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 0.75rem;
        margin: 1rem 0;
      }
      .sens-kpis .kpi {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        padding: 0.65rem 0.85rem;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .sens-kpis .kpi-label {
        font-size: 0.72rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sens-kpis .kpi-value {
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
      }
      .sens-kpis .kpi-sub {
        font-size: 0.72rem;
        color: var(--text-secondary);
      }
      .sens-optimal {
        display: flex;
        gap: 0.75rem;
        align-items: center;
        flex-wrap: wrap;
        padding: 0.6rem 0.85rem;
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        font-size: 0.88rem;
      }
      .sens-optimal .opt-badge {
        background: #0071e3;
        color: white;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
        font-weight: 600;
        font-size: 0.82rem;
      }
      .sens-heatmap {
        width: 100%;
        height: 360px;
        margin: 1rem 0;
      }
      .sens-breakdowns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 1rem;
      }
      .breakdown-block h4 {
        margin: 0 0 0.4rem;
        font-size: 0.82rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .data-table.compact th,
      .data-table.compact td {
        padding: 0.32rem 0.5rem;
        font-size: 0.82rem;
      }
      .empty-sub.error {
        color: #c4290a;
      }

      .adj-badge {
        display: inline-block;
        margin-left: 4px;
        padding: 1px 5px;
        border-radius: 999px;
        font-size: 0.66rem;
        font-weight: 600;
        line-height: 1.4;
        letter-spacing: 0.02em;
        vertical-align: middle;
        cursor: help;
      }
      .adj-badge--sl {
        background: #fce8e6;
        color: #8a1c0a;
      }
      .adj-badge--tp {
        background: #e6f4ea;
        color: #145d2e;
      }
      :host-context([data-theme='dark']) .adj-badge--sl {
        background: rgba(196, 41, 10, 0.18);
        color: #ffb1a3;
      }
      :host-context([data-theme='dark']) .adj-badge--tp {
        background: rgba(31, 138, 61, 0.22);
        color: #8ce4a4;
      }

      .modal-scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 2rem;
      }
      .modal-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: min(480px, 100%);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      }
      .modal-header {
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
      }
      .modal-header h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .modal-body {
        padding: 1rem 1.25rem;
        font-size: 0.9rem;
        color: var(--text-secondary);
      }
      .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.75rem 1.25rem;
        border-top: 1px solid var(--border);
      }
    `,
  ],
})
export class LlmBacktestDetailPageComponent implements OnInit, OnDestroy {
  readonly BacktestStatus = BacktestStatus;
  readonly outcomeOptions = OUTCOME_FILTERS;

  private readonly svc = inject(LlmBacktestService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  protected readonly themeService = inject(ThemeService);

  readonly id = signal<number | null>(null);
  readonly run = signal<LlmBacktestRun | null>(null);
  readonly loadingRun = signal(false);

  /**
   * Prefer the terminal summary written by the worker at finalisation; fall
   * back to the live summary the server computes from already-persisted
   * points while the run is in flight. Returning a single value lets every
   * downstream template + computed read from one source instead of branching
   * on run status everywhere.
   */
  readonly effectiveSummary = computed(() => {
    const r = this.run();
    return r?.summary ?? r?.liveSummary ?? null;
  });

  /** True when the operator is looking at live (still-running) aggregates. */
  readonly isLiveSummary = computed(() => {
    const r = this.run();
    return !!r && r.summary == null && r.liveSummary != null;
  });

  readonly points = signal<LlmBacktestPoint[]>([]);
  readonly loadingPoints = signal(false);
  readonly pointsPage = signal(1);
  readonly pointsTotal = signal(0);
  readonly pointsPageSize = 50;

  symbolFilter: string | null = null;
  outcomeFilter: string | null = null;

  readonly chartSelection = signal<BacktestChartSelection | null>(null);

  /**
   * Setting this to a non-null context opens the LLM invocation modal.
   * Populated by <see cref="openInvocation"/> when the operator clicks a
   * drill-down row that has an attached LlmInvocation id.
   */
  readonly invocationModalCtx = signal<LlmInvocationModalContext | null>(null);
  readonly confirmCancel = signal(false);
  readonly cancelling = signal(false);

  // ── Sort state for the per-symbol table ─────────────────────────────────
  readonly symbolSortKey = signal<
    'symbol' | 'count' | 'hitRate' | 'expectedR' | 'meanMfePips' | 'meanMaePips'
  >('count');
  readonly symbolSortDir = signal<'asc' | 'desc'>('desc');

  // ── Phase 2 — cost attribution. Fetched once on page load. ───────────────
  readonly costAttribution = signal<BacktestCostAttribution | null>(null);
  readonly loadingCostAttribution = signal(false);
  readonly costSortKey = signal<
    'symbol' | 'timeframe' | 'pointCount' | 'llmCalls' | 'cacheHits' | 'costUsd' | 'costPerPointUsd'
  >('costUsd');
  readonly costSortDir = signal<'asc' | 'desc'>('desc');

  private runSub?: Subscription;

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isFinite(id) || id <= 0) {
      this.notifications.error('Invalid backtest run id.');
      this.router.navigate(['/llm-backtest']);
      return;
    }
    this.id.set(id);
    this.fetchRun(true);
    this.fetchPoints();
    this.fetchCostAttribution();

    // Live tick — every 5 s while Pending/Running, refetch:
    //  (a) the run header (progress + cost + live summary populated server-side)
    //  (b) the current page of points so the drill-down table grows in place
    //  (c) the cost attribution so per-(symbol, timeframe) spend keeps up
    // Stays silent once the run reaches a terminal state.
    this.runSub = timer(LIVE_TICK_MS, LIVE_TICK_MS)
      .pipe(
        switchMap(() => {
          const r = this.run();
          if (!r) return of(null);
          if (r.status !== BacktestStatus.Pending && r.status !== BacktestStatus.Running)
            return of(null);
          return this.svc.getRun(id).pipe(catchError(() => of(null)));
        }),
      )
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const before = this.run();
        this.run.set(res.data);
        const stillInFlight =
          res.data.status === BacktestStatus.Pending || res.data.status === BacktestStatus.Running;
        const transitionedTerminal =
          before &&
          (before.status === BacktestStatus.Pending || before.status === BacktestStatus.Running) &&
          !stillInFlight;

        // While still running, refresh the points + cost attribution panes
        // on every tick so the operator sees rows + spend grow live. On the
        // tick that lands the terminal status, do a final refresh so the
        // page swaps to the worker-emitted SummaryJson cleanly.
        if (stillInFlight || transitionedTerminal) {
          this.fetchPoints();
          this.fetchCostAttribution();
        }
      });
  }

  ngOnDestroy(): void {
    this.runSub?.unsubscribe();
  }

  fetchRun(showLoading = false): void {
    const id = this.id();
    if (id == null) return;
    if (showLoading) this.loadingRun.set(true);
    this.svc
      .getRun(id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loadingRun.set(false);
        if (res?.status && res.data) {
          this.run.set(res.data);
        } else if (res) {
          this.notifications.error(res.message ?? 'Failed to load run.');
        }
      });
  }

  fetchPoints(): void {
    const id = this.id();
    if (id == null) return;
    this.loadingPoints.set(true);
    this.svc
      .getPoints({
        backtestRunId: id,
        currentPage: this.pointsPage(),
        itemCountPerPage: this.pointsPageSize,
        symbolFilter: this.symbolFilter,
        outcomeFilter: this.outcomeFilter,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loadingPoints.set(false);
        if (res?.status && res.data) {
          this.points.set(res.data.data ?? []);
          this.pointsTotal.set(res.data.pager?.totalItemCount ?? 0);
        } else {
          this.points.set([]);
          this.pointsTotal.set(0);
        }
      });
  }

  onPointsFilter(): void {
    this.pointsPage.set(1);
    this.fetchPoints();
  }

  prevPointsPage(): void {
    if (this.pointsPage() > 1) {
      this.pointsPage.set(this.pointsPage() - 1);
      this.fetchPoints();
    }
  }

  nextPointsPage(): void {
    if (this.pointsPage() < this.pointsTotalPages()) {
      this.pointsPage.set(this.pointsPage() + 1);
      this.fetchPoints();
    }
  }

  readonly pointsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.pointsTotal() / this.pointsPageSize)),
  );

  readonly availableSymbols = computed(() => {
    const r = this.run();
    return r?.gridSpec?.symbols ?? [];
  });

  readonly echartsTheme = computed(() =>
    this.themeService.theme() === 'dark' ? 'lascodia-dark' : 'lascodia-light',
  );

  // ── Derived presentational helpers ──────────────────────────────────────

  statusLabel(s: BacktestStatus): string {
    return BacktestStatusName[s] ?? String(s);
  }

  canCancel(): boolean {
    const r = this.run();
    return !!r && (r.status === BacktestStatus.Pending || r.status === BacktestStatus.Running);
  }

  cacheHitRatio(r: LlmBacktestRun): number {
    if (r.completedPoints <= 0) return 0;
    return r.cacheHits / r.completedPoints;
  }

  progressPct(r: LlmBacktestRun): number {
    if (r.totalPoints <= 0) return 0;
    return Math.min(100, Math.round((r.completedPoints / r.totalPoints) * 100));
  }

  viablePct(s: NonNullable<LlmBacktestRun['summary']>): number {
    if (s.totalRecommendations <= 0) return 0;
    return s.viableCount / s.totalRecommendations;
  }

  /**
   * Render the model-tier enum regardless of whether the API delivers it as
   * a string ("Spot"/"Macro") or an int. ASP.NET defaults to string-enum
   * serialisation but historical/test payloads may still carry ints.
   */
  modelTierLabel(tier: unknown): string {
    if (typeof tier === 'string') return tier;
    if (typeof tier === 'number') return tier === 1 ? 'Macro' : 'Spot';
    return 'Spot';
  }

  /** Compact one-liner: "5 symbols × 2 tfs × 7 days · EveryBarClose · 1,680 pts". */
  gridSummary(): string {
    const r = this.run();
    if (!r) return '';
    const spec = r.gridSpec;
    const points = r.totalPoints;
    if (!spec) return `${points} point(s)`;
    const startMs = new Date(spec.windowStartUtc).getTime();
    const endMs = new Date(spec.windowEndUtc).getTime();
    const days = Math.max(0, Math.round((endMs - startMs) / 86_400_000));
    // API serialises enum as string ("EveryBarClose" etc.); TS enum is
    // int-valued. Compare the normalised string form so either shape works.
    const samplingStr =
      typeof spec.sampling === 'string'
        ? spec.sampling
        : GridSampling[spec.sampling as GridSampling];
    const samplingLabel =
      samplingStr === 'EveryBarClose'
        ? 'EveryBarClose'
        : samplingStr === 'EveryNthBar'
          ? `EveryNthBar (N=${spec.everyNthBar ?? '?'})`
          : 'ExplicitTimestamps';
    return (
      `${spec.symbols.length} symbol(s) × ${spec.timeframes.length} tf(s) × ${days} day(s) · ` +
      `${samplingLabel} · ${points.toLocaleString()} pts`
    );
  }

  /** Aggregate one point's walker outcomes into chip rows (label + count). */
  outcomeSummary(p: LlmBacktestPoint): { label: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const o of p.outcomes) {
      const lbl = o.status || 'Unknown';
      counts.set(lbl, (counts.get(lbl) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => ({ label, count }));
  }

  hasViable(p: LlmBacktestPoint): boolean {
    return p.viable.length > 0;
  }

  /**
   * Compact badge summary of the engine-applied geometry adjustments on
   * this point's viable recs. Each unique badge surfaces once even if
   * multiple recs trip the same adjustment. The `kind` classifies the
   * adjustment as SL-side vs TP-side for colour-coding; the full audit
   * string is kept on `detail` for the tooltip.
   */
  pointAdjustments(p: LlmBacktestPoint): { label: string; kind: 'sl' | 'tp'; detail: string }[] {
    const seen = new Map<string, { label: string; kind: 'sl' | 'tp'; detail: string }>();
    for (const r of p.viable) {
      if (!r.appliedAdjustments) continue;
      for (const note of r.appliedAdjustments) {
        // Take the first 2-4 words as the badge label.
        const label = note.startsWith('SL bumped')
          ? 'SL bumped'
          : note.startsWith('SL pushed')
            ? 'SL→wall'
            : note.startsWith('TP capped')
              ? 'TP capped'
              : note.startsWith('TP haircut')
                ? 'TP haircut'
                : note.startsWith('TP re-widened')
                  ? 'TP re-wide'
                  : 'adj';
        const kind: 'sl' | 'tp' = label.startsWith('SL') ? 'sl' : 'tp';
        if (!seen.has(label)) seen.set(label, { label, kind, detail: note });
      }
    }
    return [...seen.values()];
  }

  /**
   * True when the point row has an attached LlmInvocation row the operator
   * can drill into. False on dry-run points (no LLM call), points whose
   * invocation failed before persistence, or legacy rows that pre-date the
   * <c>LlmInvocationId</c> column.
   */
  hasInvocation(p: LlmBacktestPoint): boolean {
    return p.llmInvocationId != null && p.llmInvocationId > 0;
  }

  /**
   * Row-click handler — opens the LlmInvocationModal for ANY point that has
   * an attached invocation, regardless of whether the LLM produced viable
   * recommendations. The operator most wants to inspect the prompt when
   * the model said "Hold" with no actionable setup, and the index page's
   * outcome chips don't capture the reasoning.
   */
  openInvocation(p: LlmBacktestPoint): void {
    if (!this.hasInvocation(p)) return;
    // Pass the first viable recommendation when present so the chart pane
    // overlays entry/SL/TP mark-lines; otherwise the chart renders the
    // structure unannotated. Pass ttlBars from the grid so the forward
    // window matches the walker.
    this.invocationModalCtx.set({
      invocationId: p.llmInvocationId!,
      symbol: p.symbol,
      timeframe: p.timeframe,
      asOfUtc: p.asOfUtc,
      recommendation: p.viable[0] ?? null,
      ttlBars: this.ttlBarsFromGrid(),
    });
  }

  /**
   * Chart-icon click handler — opens the candle-chart modal. Lives on the
   * row only when <see cref="hasViable"/> is true. Stops the event from
   * bubbling so the row-level invocation modal doesn't open simultaneously.
   */
  openChartIcon(p: LlmBacktestPoint, ev: Event): void {
    ev.stopPropagation();
    this.openChart(p);
  }

  /**
   * Open the chart modal for a point. Picks the FIRST viable recommendation —
   * a backtest point can carry several (the spot prompt emits up to 4), but
   * the chart only has room for one set of levels. The point row's outcome
   * chip is what the operator reads for the whole picture.
   */
  openChart(p: LlmBacktestPoint): void {
    if (!this.hasViable(p)) return;
    const rec = p.viable[0];
    const outcome: BacktestPointOutcome | null = p.outcomes[0] ?? null;
    const ttlBars = this.ttlBarsFromGrid();
    // P4.4 — parse multi-sample results lazily here so the modal can render
    // a per-sample table beside the candle chart. Returns null when the
    // point is from a single-sample run (the modal hides the table).
    const multiSampleResults = this.parseMultiSampleResults(p);
    this.chartSelection.set({
      symbol: p.symbol,
      timeframe: p.timeframe,
      asOfUtc: p.asOfUtc,
      recommendation: rec,
      outcome,
      ttlBars,
      multiSampleResults,
    });
  }

  /**
   * P4.4 — parse the point's `multiSampleResultsJson` string into the typed
   * array the chart modal renders. Returns null on:
   *  - non-multi-sample runs (json is null/empty)
   *  - corrupted JSON (logged + swallowed — the modal degrades to single-
   *    sample mode rather than throwing)
   *  - parsed value not an array
   */
  private parseMultiSampleResults(p: LlmBacktestPoint): MultiSampleResult[] | null {
    const raw = p.multiSampleResultsJson;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MultiSampleResult[]) : null;
    } catch {
      return null;
    }
  }

  /** Per-symbol cohort sort. */
  setSymbolSort(
    key: 'symbol' | 'count' | 'hitRate' | 'expectedR' | 'meanMfePips' | 'meanMaePips',
  ): void {
    if (this.symbolSortKey() === key) {
      this.symbolSortDir.set(this.symbolSortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.symbolSortKey.set(key);
      this.symbolSortDir.set('desc');
    }
  }

  readonly sortedPerSymbol = computed(() => {
    const s = this.effectiveSummary();
    if (!s) return [];
    const rows = [...s.perSymbol];
    const key = this.symbolSortKey();
    const dir = this.symbolSortDir() === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = (a as any)[key];
      const bv = (b as any)[key];
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dir;
      }
      return ((av ?? 0) - (bv ?? 0)) * dir;
    });
    return rows;
  });

  // ── Charts ──────────────────────────────────────────────────────────────

  readonly outcomeChart = computed<EChartsOption>(() => {
    const s = this.effectiveSummary();
    if (!s) return { series: [] };
    const o = s.outcomes;
    const data = [
      { name: 'HitTP', value: o.hitTP, itemStyle: { color: '#1f8a3d' } },
      { name: 'HitSL', value: o.hitSL, itemStyle: { color: '#c4290a' } },
      { name: 'ExpiredPositive', value: o.expiredPositive, itemStyle: { color: '#7cc488' } },
      { name: 'ExpiredNegative', value: o.expiredNegative, itemStyle: { color: '#e09a8a' } },
      { name: 'ExpiredFlat', value: o.expiredFlat, itemStyle: { color: '#8e8e93' } },
      { name: 'EntryNotReached', value: o.entryNotReached, itemStyle: { color: '#0071e3' } },
    ].filter((d) => d.value > 0);
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          label: { formatter: '{b}\n{c}', fontSize: 10 },
          data,
        },
      ],
    };
  });

  readonly rejectionChartHasData = computed(() => {
    const s = this.effectiveSummary();
    return !!s && Object.keys(s.rejectionReasonCounts).length > 0;
  });

  readonly rejectionChart = computed<EChartsOption>(() => {
    const s = this.effectiveSummary();
    if (!s) return { series: [] };
    const entries = Object.entries(s.rejectionReasonCounts).sort((a, b) => b[1] - a[1]);
    const labels = entries.map(([k]) => k);
    const values = entries.map(([, v]) => v);
    return {
      grid: { left: 10, right: 30, top: 10, bottom: 10, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value' },
      yAxis: {
        type: 'category',
        data: labels,
        inverse: true,
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          type: 'bar',
          data: values,
          itemStyle: { color: '#c4290a' },
          label: { show: true, position: 'right', fontSize: 10 },
        },
      ],
    };
  });

  // ── Cancel ──────────────────────────────────────────────────────────────

  executeCancel(): void {
    const id = this.id();
    if (id == null) return;
    this.cancelling.set(true);
    this.svc
      .cancelRun(id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.cancelling.set(false);
        this.confirmCancel.set(false);
        if (res?.status) {
          this.notifications.success(`Run #${id} cancellation requested.`);
          this.fetchRun();
        } else {
          this.notifications.error(res?.message ?? 'Failed to cancel run.');
        }
      });
  }

  /**
   * Estimate the walker's TTL in bars. The engine pins TTL to a per-timeframe
   * constant we don't surface — we approximate with the LLM-analysis backtest
   * walker's documented default (`tfTtlBars`). Used only as a fetch-size hint
   * for the chart modal; the chart slices client-side so an off-by-some is
   * cosmetic.
   */
  private ttlBarsFromGrid(): number {
    // Default walker window — see SignalOutcomeWalker. Spot uses ~24 bars on
    // the timeframe of the rec. We pick a conservative 30 so the chart shows
    // the full outcome window even when TTL is at the high end.
    return 30;
  }

  // ── Phase 2 — sweep curve helpers ────────────────────────────────────────

  /** Display name for the swept knob — looked up from `GUARD_KNOB_META`. */
  sweepKnobLabel(sc: BacktestSweepCurve): string {
    return GUARD_KNOB_META[sc.knob]?.displayName ?? `Knob ${sc.knob}`;
  }

  sweepFirst(sc: BacktestSweepCurve): number {
    return sc.curve.length > 0 ? sc.curve[0].knobValue : 0;
  }

  sweepLast(sc: BacktestSweepCurve): number {
    return sc.curve.length > 0 ? sc.curve[sc.curve.length - 1].knobValue : 0;
  }

  /** Approximate the step from the first two curve points. */
  sweepStep(sc: BacktestSweepCurve): number {
    if (sc.curve.length < 2) return 0;
    return Math.round((sc.curve[1].knobValue - sc.curve[0].knobValue) * 1e6) / 1e6;
  }

  /**
   * Pick the "best" knob value by maximising ExpectedR; tie-break by lowest
   * HitSL ratio so an equal-R / lower-SL config wins over a coin-flip.
   */
  bestSweepPoint(sc: BacktestSweepCurve): SweepCurvePoint | null {
    if (sc.curve.length === 0) return null;
    let best: SweepCurvePoint = sc.curve[0];
    let bestSlRatio = best.totalRecs > 0 ? best.hitSl / best.totalRecs : 1;
    for (const p of sc.curve.slice(1)) {
      const slRatio = p.totalRecs > 0 ? p.hitSl / p.totalRecs : 1;
      if (p.expectedR > best.expectedR) {
        best = p;
        bestSlRatio = slRatio;
      } else if (p.expectedR === best.expectedR && slRatio < bestSlRatio) {
        best = p;
        bestSlRatio = slRatio;
      }
    }
    return best;
  }

  // ── Phase 3 — multi-sample stability helpers ─────────────────────────────

  /**
   * Three-band qualitative verdict on the run's multi-sample stability.
   * Thresholds are hardcoded against `meanOfStdDevHitRates`:
   *  - `< 0.05` → stable (LLM produces near-identical setups every draw)
   *  - `< 0.15` → moderate (typical bounds)
   *  - `>= 0.15` → unstable (significant variance — single-sample results
   *    should be treated as point estimates with non-trivial spread).
   *
   * Returns the literal label so the template's `@switch` can branch with
   * narrow `@case` arms instead of carrying its own ladder.
   */
  stabilityVerdict(stab: MultiSampleStability): 'stable' | 'moderate' | 'unstable' {
    if (stab.meanOfStdDevHitRates < 0.05) return 'stable';
    if (stab.meanOfStdDevHitRates < 0.15) return 'moderate';
    return 'unstable';
  }

  isUnstable(stab: MultiSampleStability): boolean {
    return this.stabilityVerdict(stab) === 'unstable';
  }

  bestVsDefaultText(sc: BacktestSweepCurve, best: SweepCurvePoint): string {
    const defPoint = sc.curve.find((p) => Math.abs(p.knobValue - sc.defaultValue) < 1e-9);
    if (!defPoint) return `Default (${sc.defaultValue}) not in swept range.`;
    const hrDelta = (best.hitRate - defPoint.hitRate) * 100;
    const erDelta = best.expectedR - defPoint.expectedR;
    const sign = (v: number) => (v >= 0 ? '+' : '');
    return (
      `vs default (${sc.defaultValue}): ` +
      `${sign(hrDelta)}${hrDelta.toFixed(2)}% hit-rate, ` +
      `${sign(erDelta)}${erDelta.toFixed(2)}R expected R.`
    );
  }

  readonly sweepChart = computed<EChartsOption>(() => {
    const sc = this.run()?.summary?.sweepCurve;
    if (!sc || sc.curve.length === 0) return { series: [] };
    const xs = sc.curve.map((p) => p.knobValue);
    const hitRate = sc.curve.map((p) => p.hitRate);
    const expectedR = sc.curve.map((p) => p.expectedR);
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          // params is an Array<{ axisValueLabel, seriesName, value, ... }>;
          // we rebuild the point from the curve so the tooltip can show
          // viable/rejected/hit-tp/hit-sl alongside the headline metrics.
          const arr = params as Array<{ axisValueLabel?: string; dataIndex?: number }>;
          if (!Array.isArray(arr) || arr.length === 0) return '';
          const i = arr[0].dataIndex ?? 0;
          const p = sc.curve[i];
          if (!p) return '';
          return (
            `<strong>Knob = ${p.knobValue}</strong><br/>` +
            `Hit rate: ${(p.hitRate * 100).toFixed(1)}%<br/>` +
            `Expected R: ${p.expectedR.toFixed(2)}<br/>` +
            `Viable / Rejected: ${p.viable} / ${p.rejected}<br/>` +
            `TP / SL: ${p.hitTp} / ${p.hitSl}<br/>` +
            `Expired +/−: ${p.expiredPositive} / ${p.expiredNegative}`
          );
        },
      },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 50, right: 60, top: 30, bottom: 40, containLabel: true },
      xAxis: {
        type: 'value',
        name: 'Knob value',
        nameLocation: 'middle',
        nameGap: 25,
        nameTextStyle: { fontSize: 11 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Hit rate',
          position: 'left',
          axisLabel: {
            formatter: (v: number) => `${Math.round(v * 100)}%`,
            fontSize: 10,
          },
          min: 0,
          max: 1,
          nameTextStyle: { fontSize: 11, color: '#0071e3' },
        },
        {
          type: 'value',
          name: 'Expected R',
          position: 'right',
          axisLabel: { fontSize: 10 },
          nameTextStyle: { fontSize: 11, color: '#1f8a3d' },
        },
      ],
      series: [
        {
          name: 'Hit rate',
          type: 'line',
          smooth: true,
          yAxisIndex: 0,
          data: xs.map((x, i) => [x, hitRate[i]]),
          itemStyle: { color: '#0071e3' },
          lineStyle: { color: '#0071e3', width: 2 },
          markLine: {
            symbol: 'none',
            silent: true,
            label: {
              formatter: `default ${sc.defaultValue}`,
              fontSize: 10,
              color: '#8e8e93',
              position: 'end',
            },
            lineStyle: { type: 'dashed', color: '#8e8e93' },
            data: [{ xAxis: sc.defaultValue }],
          },
        },
        {
          name: 'Expected R',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          data: xs.map((x, i) => [x, expectedR[i]]),
          itemStyle: { color: '#1f8a3d' },
          lineStyle: { color: '#1f8a3d', width: 2 },
        },
      ],
    };
  });

  // ── Phase 2 — cost attribution ───────────────────────────────────────────

  fetchCostAttribution(): void {
    const id = this.id();
    if (id == null) return;
    this.loadingCostAttribution.set(true);
    this.svc
      .getCostAttribution(id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loadingCostAttribution.set(false);
        if (res?.status && res.data) {
          this.costAttribution.set(res.data);
        }
      });
  }

  setCostSort(
    key:
      | 'symbol'
      | 'timeframe'
      | 'pointCount'
      | 'llmCalls'
      | 'cacheHits'
      | 'costUsd'
      | 'costPerPointUsd',
  ): void {
    if (this.costSortKey() === key) {
      this.costSortDir.set(this.costSortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.costSortKey.set(key);
      this.costSortDir.set('desc');
    }
  }

  readonly sortedCostByPair = computed(() => {
    const ca = this.costAttribution();
    if (!ca) return [];
    const rows = [...ca.byPair];
    const key = this.costSortKey();
    const dir = this.costSortDir() === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[key];
      const bv = (b as unknown as Record<string, unknown>)[key];
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dir;
      }
      const an = typeof av === 'number' ? av : 0;
      const bn = typeof bv === 'number' ? bv : 0;
      return (an - bn) * dir;
    });
    return rows;
  });

  // ────────────────────────────────────────────────────────────────────────
  // Signal Sensitivity Sweep (Phase 5+)
  //
  // Replays this run's viable recommendations through a TP/SL multiplier
  // grid; backend re-walks candles per (tp × sl) cell and returns the same
  // DTO shape the live signal-sensitivity page consumes. We render a slim
  // KPI strip + optimal-cell callout + heatmap + per-direction / per-symbol
  // breakdowns inside a single card; the existing per-point drill-down
  // below already handles per-rec inspection so we don't duplicate that.
  // ────────────────────────────────────────────────────────────────────────

  readonly sensitivityResult = signal<AnalyzeSignalSensitivityResultDto | null>(null);
  readonly sensitivityLoading = signal(false);
  readonly sensitivityError = signal<string | null>(null);

  /** Form bindings — chosen multipliers + sweep ranges (comma-separated). */
  sensitivityTp = 1.0;
  sensitivitySl = 1.0;
  sensitivityTpSweepStr = '0.5, 0.75, 1.0, 1.25, 1.5';
  sensitivitySlSweepStr = '0.5, 0.75, 1.0, 1.5, 2.0';
  /** Metric the heatmap colour scale tracks. */
  readonly sensitivityHeatmapMetric = signal<
    'winRatePct' | 'realizedPnL' | 'profitFactor' | 'sumPnL' | 'expectancy'
  >('winRatePct');

  readonly sensitivityHeatmapMetricLabel = computed(() => {
    switch (this.sensitivityHeatmapMetric()) {
      case 'winRatePct':
        return 'Win rate %';
      case 'realizedPnL':
        return 'Realized P&L (pips)';
      case 'sumPnL':
        return 'Total P&L (pips)';
      case 'profitFactor':
        return 'Profit factor';
      case 'expectancy':
        return 'Expectancy / signal (pips)';
    }
  });

  /**
   * Pick the best heatmap cell by current metric, but only consider cells
   * with at least a meaningful sample size — otherwise a single-rec cell
   * with 100% win rate "wins" but means nothing. Threshold = 5 walkable
   * specs, falling back to the highest-walkable cell when no cell clears
   * the bar (small cohorts).
   */
  readonly sensitivityOptimal = computed(() => {
    const r = this.sensitivityResult();
    if (!r || !r.heatmap?.length) return null;
    const metric = this.sensitivityHeatmapMetric();
    const scoreOf = (c: SignalSensitivityHeatmapCellDto) => {
      const a = c.aggregate;
      switch (metric) {
        case 'winRatePct':
          return a.winRatePct ?? 0;
        case 'realizedPnL':
          return a.realizedPnL ?? 0;
        case 'sumPnL':
          return a.sumPnL ?? 0;
        case 'profitFactor':
          return Math.min(a.profitFactor ?? 0, 5);
        case 'expectancy': {
          const resolved = (a.winCount ?? 0) + (a.lossCount ?? 0);
          return resolved > 0 ? (a.realizedPnL ?? 0) / resolved : 0;
        }
      }
    };
    const minWalkable = 5;
    const eligible = r.heatmap.filter((c) => (c.aggregate.walkable ?? 0) >= minWalkable);
    const pool = eligible.length > 0 ? eligible : r.heatmap;
    return pool.reduce((best, c) => (scoreOf(c) > scoreOf(best) ? c : best), pool[0]);
  });

  /** ECharts config for the TP × SL heatmap. Diverging palette centred on zero. */
  readonly sensitivityHeatmapOptions = computed<EChartsOption | null>(() => {
    const r = this.sensitivityResult();
    if (!r || !r.heatmap?.length) return null;

    const slAxis = r.slSweepAxis ?? [];
    const tpAxis = r.tpSweepAxis ?? [];
    const slIdx = new Map(slAxis.map((v, i) => [v, i]));
    const tpIdx = new Map(tpAxis.map((v, i) => [v, i]));
    const metric = this.sensitivityHeatmapMetric();

    const cellValue = (c: SignalSensitivityHeatmapCellDto): number => {
      const a = c.aggregate;
      switch (metric) {
        case 'winRatePct':
          return a.winRatePct ?? 0;
        case 'realizedPnL':
          return a.realizedPnL ?? 0;
        case 'sumPnL':
          return a.sumPnL ?? 0;
        case 'profitFactor':
          return Math.min(a.profitFactor ?? 0, 5);
        case 'expectancy': {
          const resolved = (a.winCount ?? 0) + (a.lossCount ?? 0);
          return resolved > 0 ? (a.realizedPnL ?? 0) / resolved : 0;
        }
      }
    };

    const data = r.heatmap.map((c) => [
      slIdx.get(c.slMultiplier) ?? 0,
      tpIdx.get(c.tpMultiplier) ?? 0,
      cellValue(c),
    ]);
    const values = data.map((d) => d[2] as number);
    // For win-rate, baseline at 50% so the diverging palette splits at
    // coin-flip; for P&L / expectancy, baseline at 0 (loss vs profit).
    const baseline = metric === 'winRatePct' ? 50 : 0;
    const minV = Math.min(...values, baseline);
    const maxV = Math.max(...values, baseline);
    const absMax = Math.max(Math.abs(minV - baseline), Math.abs(maxV - baseline), 1);

    const activeSlIdx = slIdx.get(r.slMultiplier) ?? -1;
    const activeTpIdx = tpIdx.get(r.tpMultiplier) ?? -1;

    return {
      animation: false,
      tooltip: {
        position: 'top',
        formatter: (params: { value: [number, number, number] }) => {
          const [sx, ty] = params.value;
          const cell = r.heatmap.find(
            (c) =>
              (slIdx.get(c.slMultiplier) ?? -1) === sx && (tpIdx.get(c.tpMultiplier) ?? -1) === ty,
          );
          if (!cell) return '';
          const a = cell.aggregate;
          const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(1));
          return `
            <b>TP×${cell.tpMultiplier} · SL×${cell.slMultiplier}</b><br/>
            Win rate: ${fmt(a.winRatePct)}% (${a.winCount}/${a.lossCount})<br/>
            Realized: ${fmt(a.realizedPnL)} p<br/>
            Expired: ${a.expiredCount} (${fmt(a.unrealizedPnL)} p)<br/>
            Profit factor: ${fmt(a.profitFactor)}<br/>
            Walkable: ${a.walkable}
          `;
        },
      },
      grid: { left: 60, right: 30, top: 30, bottom: 60, containLabel: true },
      xAxis: {
        type: 'category',
        name: 'SL ×',
        nameLocation: 'middle',
        nameGap: 30,
        data: slAxis.map((v) => v.toString()),
        splitArea: { show: true },
      },
      yAxis: {
        type: 'category',
        name: 'TP ×',
        nameLocation: 'middle',
        nameGap: 40,
        data: tpAxis.map((v) => v.toString()),
        splitArea: { show: true },
      },
      visualMap: {
        min: baseline - absMax,
        max: baseline + absMax,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        inRange: { color: ['#c4290a', '#f1eee5', '#1f8a3d'] },
      },
      series: [
        {
          name: this.sensitivityHeatmapMetricLabel(),
          type: 'heatmap' as const,
          data,
          label: {
            show: true,
            formatter: (params: { value: [number, number, number] }) => {
              const v = params.value[2];
              if (metric === 'winRatePct') return v.toFixed(0) + '%';
              if (metric === 'profitFactor') return v.toFixed(2);
              return Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);
            },
            fontSize: 10,
          },
          emphasis: { itemStyle: { borderColor: '#000', borderWidth: 2 } },
          markPoint:
            activeSlIdx >= 0 && activeTpIdx >= 0
              ? {
                  symbol: 'pin',
                  symbolSize: 26,
                  itemStyle: { color: '#0071e3' },
                  label: {
                    show: true,
                    formatter: '★',
                    color: '#ffffff',
                    fontSize: 12,
                  },
                  data: [{ coord: [activeSlIdx, activeTpIdx] }],
                }
              : undefined,
        },
      ],
    } as unknown as EChartsOption;
  });

  /** Parse the "0.5, 0.75, 1.0" sweep input into a number list. Empty / invalid → undefined (server uses default). */
  private parseSweepInput(raw: string): number[] | undefined {
    const parsed = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length > 0 ? parsed : undefined;
  }

  /**
   * Tolerant "is this run Completed?" check. The engine API serialises the
   * BacktestStatus enum as the string literal ("Completed", "Pending", …),
   * but the TS enum is numeric (Completed=2). A direct `=== BacktestStatus.Completed`
   * would always be false. This helper accepts both shapes so the call
   * site keeps working whether the wire format ever switches back to int.
   */
  protected isRunCompleted(status: unknown): boolean {
    return status === BacktestStatus.Completed || status === 'Completed';
  }

  runSensitivity(): void {
    const runId = this.run()?.id;
    if (!runId) return;
    this.sensitivityLoading.set(true);
    this.sensitivityError.set(null);
    const body: AnalyzeBacktestSensitivityRequest = {
      tpMultiplier: this.sensitivityTp,
      slMultiplier: this.sensitivitySl,
      tpSweepValues: this.parseSweepInput(this.sensitivityTpSweepStr),
      slSweepValues: this.parseSweepInput(this.sensitivitySlSweepStr),
    };
    this.svc.analyzeSensitivity(runId, body).subscribe({
      next: (res) => {
        this.sensitivityLoading.set(false);
        if (res?.status && res.data) {
          this.sensitivityResult.set(res.data);
        } else {
          this.sensitivityError.set(res?.message ?? 'Sensitivity analysis failed.');
          this.sensitivityResult.set(null);
        }
      },
      error: (err) => {
        this.sensitivityLoading.set(false);
        this.sensitivityError.set(err?.error?.message ?? err?.message ?? 'Request failed.');
        this.sensitivityResult.set(null);
      },
    });
  }
}
