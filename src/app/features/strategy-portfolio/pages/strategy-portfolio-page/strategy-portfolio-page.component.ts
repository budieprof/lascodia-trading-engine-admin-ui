import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  PortfolioFwerReportDto,
  StrategyAllocationWeightEntry,
  StrategyAllocationWeightsDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { DatePipe } from '@angular/common';

/**
 * Portfolio-level lens: complements `/strategy-ensemble` by showing the same
 * allocation surface plus the multiple-testing-tax (FWER) report. Refreshes
 * via push when `StrategyAllocatorWorker` rebalances — operators see the new
 * weight set without polling.
 */
@Component({
  selector: 'app-strategy-portfolio-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    RelativeTimePipe,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Portfolio"
        subtitle="Allocations, throttle posture, and multiple-testing-tax across the active set"
      />

      <!-- KPI strip — combined allocation + FWER posture -->
      <div class="pf-kpis">
        <div class="pf-kpi">
          <span class="kpi-label">Covered strategies</span>
          <span class="kpi-value">{{ portfolioKpis().covered }}</span>
        </div>
        <div class="pf-kpi">
          <span class="kpi-label">Throttled</span>
          <span
            class="kpi-value"
            [class.warn]="portfolioKpis().throttled > 0"
            [class.good]="portfolioKpis().throttled === 0 && portfolioKpis().covered > 0"
          >
            {{ portfolioKpis().throttled }}
          </span>
        </div>
        <div class="pf-kpi">
          <span class="kpi-label">Target Sharpe</span>
          <span class="kpi-value">{{ portfolioKpis().targetSharpe.toFixed(2) }}</span>
        </div>
        <div class="pf-kpi">
          <span class="kpi-label">Avg recent Sharpe</span>
          <span
            class="kpi-value"
            [class.good]="portfolioKpis().avgSharpe > 1"
            [class.bad]="portfolioKpis().avgSharpe < 0"
          >
            {{ portfolioKpis().avgSharpe.toFixed(2) }}
          </span>
        </div>
        <div class="pf-kpi">
          <span class="kpi-label">Bonferroni passes</span>
          <span class="kpi-value" [class.good]="portfolioKpis().bonf > 0">
            {{ fwer() ? portfolioKpis().bonf : '—' }}
          </span>
        </div>
        <div class="pf-kpi">
          <span class="kpi-label">BH-FDR passes</span>
          <span class="kpi-value" [class.good]="portfolioKpis().bh > 0">
            {{ fwer() ? portfolioKpis().bh : '—' }}
          </span>
        </div>
      </div>

      <!-- Allocations -->
      <section class="section">
        <header class="section-head">
          <h3>Throttle posture</h3>
          @if (weights(); as w) {
            <span class="muted small">
              {{ w.coveredStrategies }} strategies · {{ w.throttledStrategies }} throttled · target
              Sharpe {{ w.targetSharpe.toFixed(2) }} · floor {{ (w.minWeight * 100).toFixed(0) }}%
              @if (hasSnapshot(w)) {
                · updated {{ w.latestComputedAt | relativeTime }}
              } @else {
                · never run
              }
            </span>
          }
        </header>
        <!-- The allocator weight is a per-strategy SIZE MULTIPLIER (1.0 = full
             size, 0.25 = a quarter), not a share of the book — three
             strategies at 100 / 25 / 100 are correct data, so the old "weight
             distribution" donut summing them to 225% was the wrong chart. -->
        <p class="muted small explain">
          Each weight is the position-size multiplier the allocator applies to that strategy — 1.00
          is full size, anything below is throttled toward the floor because its recent Sharpe fell
          short of the target. Weights are independent per strategy and do not sum to 100%.
        </p>

        @if (weightsLoading() && !weights()) {
          <app-card-skeleton [lines]="6" />
        } @else if (weightsFailed()) {
          <app-error-state
            title="Could not load allocation weights"
            message="The allocation-weights endpoint returned an error — the throttle posture is unknown."
            (retry)="loadWeights()"
          />
        } @else if (weights(); as w) {
          @if (w.entries.length > 0) {
            <div class="allocation-grid">
              <app-chart-card
                title="Size multiplier by strategy"
                subtitle="Sorted high → low · throttled bars amber · floor line dashed"
                [options]="weightBarOptions()"
                height="320px"
              />
              <div class="drift-card">
                <h4 class="card-title">Per-strategy weights</h4>
                <div class="drift-scroll">
                  <table class="drift-table">
                    <thead>
                      <tr>
                        <th>Strategy</th>
                        <th>Symbol</th>
                        <th class="num">Size multiplier</th>
                        <th class="num">Sharpe</th>
                        <th class="num">N</th>
                        <th>Computed</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (e of w.entries; track e.strategyId) {
                        <tr (click)="openStrategy(e.strategyId)">
                          <td class="name-cell" [title]="e.strategyName">{{ e.strategyName }}</td>
                          <td class="mono">{{ e.symbol }}</td>
                          <td class="num" [attr.data-throttled]="e.weight < 1 ? '1' : null">
                            {{ e.weight.toFixed(2) }}×
                            @if (e.weight < 1) {
                              <span class="pill pill-warn">throttled</span>
                            }
                          </td>
                          <td
                            class="num"
                            [class.profit]="e.recentSharpe > 1"
                            [class.loss]="e.recentSharpe < 0"
                          >
                            {{ e.recentSharpe.toFixed(2) }}
                          </td>
                          <td class="num">{{ e.observationCount }}</td>
                          <td class="muted small nowrap" [title]="e.computedAt | date: 'medium'">
                            {{ e.computedAt | relativeTime }}
                            @if (isStale(e, w)) {
                              <span
                                class="pill pill-warn"
                                title="This row was not recomputed in the latest allocator cycle — the multiplier may be stale."
                                >stale</span
                              >
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <app-chart-card
              title="Sharpe vs observations"
              subtitle="Dots in the lower-left are throttle candidates (Sharpe below target) · dot size = multiplier"
              [options]="sharpeScatterOptions()"
              height="280px"
            />
          } @else {
            <app-empty-state
              title="No allocation snapshot yet"
              description="StrategyAllocatorWorker hasn't run a cycle, or no strategies are eligible."
            />
          }
        }
      </section>

      <!-- FWER report -->
      <section class="section">
        <header class="section-head">
          <h3>Multiple-testing tax (FWER)</h3>
          @if (fwer(); as f) {
            <span class="muted small">
              α = {{ f.alpha }} · {{ f.lookbackDays }}-day lookback · {{ f.totalTrialsInWindow }}
              trials counted
            </span>
          }
        </header>

        @if (fwerLoading() && !fwer()) {
          <app-card-skeleton [lines]="4" />
        } @else if (fwerFailed()) {
          <app-error-state
            title="Could not load the FWER report"
            message="The portfolio FWER endpoint returned an error."
            (retry)="loadFwer()"
          />
        } @else if (fwer(); as f) {
          <div class="fwer-meta">
            <div>
              <span class="meta-label">Active strategies</span>
              <span class="meta-value">{{ f.totalActiveStrategies }}</span>
            </div>
            <div>
              <span class="meta-label">Eligible (Sharpe ≥ 0)</span>
              <span class="meta-value">{{ f.eligibleStrategies }}</span>
            </div>
            <div>
              <span class="meta-label">Bonferroni survivors</span>
              <span class="meta-value">{{ f.bonferroniSurvivors }}</span>
            </div>
            <div>
              <span class="meta-label">BH-FDR survivors</span>
              <span class="meta-value">{{ f.benjaminiHochbergSurvivors }}</span>
            </div>
            <div>
              <span class="meta-label">BH critical p-value</span>
              <span class="meta-value">
                @if (f.totalTrialsInWindow > 0) {
                  {{ f.benjaminiHochbergCriticalPValue.toFixed(4) }}
                } @else {
                  —
                }
              </span>
            </div>
          </div>

          <!-- 2-col charts: survival comparison + class distribution -->
          <div class="pf-charts">
            <app-chart-card
              title="Survival comparison"
              subtitle="Active → Eligible → Bonferroni → BH-FDR funnel"
              [options]="fwerFunnelOptions()"
              height="240px"
            />
            @if (f.byHypothesisClass.length >= 2) {
              <app-chart-card
                title="Trials by hypothesis class"
                subtitle="How the testing tax is distributed across classes"
                [options]="fwerClassDonutOptions()"
                height="240px"
              />
            } @else {
              <div class="drift-card stat-card">
                <h4 class="card-title">Trials by hypothesis class</h4>
                @if (f.byHypothesisClass.length === 1) {
                  <p class="stat-line">
                    <span class="stat-value">{{ f.byHypothesisClass[0].trialsInWindow }}</span>
                    trial{{ f.byHypothesisClass[0].trialsInWindow === 1 ? '' : 's' }} — all in one
                    class, <b>{{ f.byHypothesisClass[0].hypothesisClass }}</b> ({{
                      f.byHypothesisClass[0].activeStrategies
                    }}
                    active, {{ f.byHypothesisClass[0].bonferroniSurvivors }} survive Bonferroni).
                  </p>
                } @else {
                  <p class="stat-line muted">
                    No trials in the {{ f.lookbackDays }}-day window — nothing to distribute.
                  </p>
                }
              </div>
            }
          </div>

          @if (f.byHypothesisClass.length > 0) {
            <section class="drift-card">
              <h4 class="card-title">Per-hypothesis-class breakdown</h4>
              <table class="fwer-table">
                <thead>
                  <tr>
                    <th>Hypothesis class</th>
                    <th class="num">Active</th>
                    <th class="num">Trials</th>
                    <th class="num">Bonferroni survivors</th>
                    <th class="num">Survival rate</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of f.byHypothesisClass; track row.hypothesisClass) {
                    <tr>
                      <td>{{ row.hypothesisClass }}</td>
                      <td class="num">{{ row.activeStrategies }}</td>
                      <td class="num">{{ row.trialsInWindow }}</td>
                      <td class="num" [class.profit]="row.bonferroniSurvivors > 0">
                        {{ row.bonferroniSurvivors }}
                      </td>
                      <td class="num">
                        @if (row.activeStrategies > 0) {
                          {{ ((row.bonferroniSurvivors / row.activeStrategies) * 100).toFixed(1) }}%
                        } @else {
                          —
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        } @else {
          <app-empty-state
            title="FWER report unavailable"
            description="No active strategies, or the screening ledger is empty in the lookback window."
          />
        }
      </section>
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

      .section {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .section-head h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .small {
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-secondary);
      }

      .allocation-grid {
        display: grid;
        grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.4fr);
        gap: var(--space-4);
        align-items: start;
      }
      .explain {
        margin: calc(-1 * var(--space-2)) 0 0;
        max-width: 90ch;
      }
      .name-cell {
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .nowrap {
        white-space: nowrap;
      }
      .pill {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 7px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        vertical-align: middle;
      }
      .pill-warn {
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
      }
      .stat-card {
        justify-content: center;
        min-height: 240px;
      }
      .stat-line {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        line-height: 1.5;
      }
      .stat-value {
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        margin-right: var(--space-2);
        font-variant-numeric: tabular-nums;
      }
      @media (max-width: 900px) {
        .allocation-grid {
          grid-template-columns: 1fr;
        }
      }
      .drift-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card-title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .drift-scroll {
        max-height: 320px;
        overflow-y: auto;
      }
      .drift-table,
      .fwer-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .drift-table th,
      .drift-table td,
      .fwer-table th,
      .fwer-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .drift-table tbody tr {
        cursor: pointer;
      }
      .drift-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .drift-table th,
      .fwer-table th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      td.num[data-throttled='1'] {
        color: var(--warning);
        font-weight: var(--font-semibold);
      }

      .fwer-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-4);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .fwer-meta div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .meta-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .meta-value {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      /* Portfolio density additions */
      .pf-kpis {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
        align-items: start;
      }
      @media (max-width: 1400px) {
        .pf-kpis {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 720px) {
        .pf-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .pf-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 4px;
        min-height: 72px;
      }
      .pf-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pf-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .pf-kpi .kpi-value.good {
        color: var(--profit);
      }
      .pf-kpi .kpi-value.bad {
        color: var(--loss);
      }
      /* Throttling is a normal allocator state, not a failure — amber. */
      .pf-kpi .kpi-value.warn {
        color: var(--warning);
      }

      .pf-charts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .pf-charts {
          grid-template-columns: 1fr;
        }
      }

      .drift-table .profit,
      .fwer-table .profit {
        color: var(--profit);
      }
      .drift-table .loss,
      .fwer-table .loss {
        color: var(--loss);
      }
    `,
  ],
})
export class StrategyPortfolioPageComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly weights = signal<StrategyAllocationWeightsDto | null>(null);
  readonly weightsLoading = signal(true);
  readonly weightsFailed = signal(false);

  readonly fwer = signal<PortfolioFwerReportDto | null>(null);
  readonly fwerLoading = signal(true);
  readonly fwerFailed = signal(false);

  /** The engine sends DateTime.MinValue when the allocator has never run. */
  hasSnapshot(w: StrategyAllocationWeightsDto): boolean {
    return !!w.latestComputedAt && new Date(w.latestComputedAt).getTime() > 0;
  }

  /**
   * A row whose ComputedAt trails the snapshot's newest stamp by more than a
   * day was not touched in the latest allocator cycle — the engine keeps the
   * last row per strategy, so a strategy the allocator skipped keeps showing
   * whatever multiplier it last received.
   */
  isStale(e: StrategyAllocationWeightEntry, w: StrategyAllocationWeightsDto): boolean {
    if (!this.hasSnapshot(w)) return false;
    const latest = new Date(w.latestComputedAt).getTime();
    const mine = new Date(e.computedAt).getTime();
    return latest - mine > 24 * 3600_000;
  }

  // ── Combined KPI roll-ups for the strip at the top ────────────────────
  readonly portfolioKpis = computed(() => {
    const w = this.weights();
    const f = this.fwer();
    const sharpes =
      w?.entries.filter((e) => Number.isFinite(e.recentSharpe)).map((e) => e.recentSharpe) ?? [];
    return {
      covered: w?.coveredStrategies ?? 0,
      throttled: w?.throttledStrategies ?? 0,
      targetSharpe: w?.targetSharpe ?? 0,
      avgSharpe: sharpes.length > 0 ? sharpes.reduce((s, v) => s + v, 0) / sharpes.length : 0,
      fwerActive: f?.totalActiveStrategies ?? 0,
      fwerEligible: f?.eligibleStrategies ?? 0,
      bonf: f?.bonferroniSurvivors ?? 0,
      bh: f?.benjaminiHochbergSurvivors ?? 0,
    };
  });

  // ── Allocation charts ────────────────────────────────────────────────
  readonly weightBarOptions = computed<EChartsOption>(() => {
    const w = this.weights();
    if (!w || w.entries.length === 0) return {};
    const sorted = [...w.entries].sort((a, b) => b.weight - a.weight);
    const floorPct = +(w.minWeight * 100).toFixed(0);
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>Size multiplier: ${(p.value / 100).toFixed(2)}×`;
        },
      },
      grid: { top: 10, right: 44, bottom: 30, left: 150 },
      xAxis: {
        type: 'value',
        max: 100,
        splitNumber: 4,
        axisLabel: { formatter: '{value}%', fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((e) => shortName(e.strategyName)).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73', width: 140, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          data: sorted
            .map((e) => ({
              value: +(e.weight * 100).toFixed(1),
              itemStyle: {
                // Throttled (weight < 1) bars are amber so the eye lands on
                // sub-cycle allocations first.
                color: e.weight < 1 ? '#FF9500' : '#0071E3',
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
            formatter: (p: any) => `${(p.value / 100).toFixed(2)}×`,
          },
          markLine:
            floorPct > 0
              ? {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { type: 'dashed', color: '#FF9500' },
                  label: { formatter: `floor ${floorPct}%`, fontSize: 10, position: 'end' },
                  data: [{ xAxis: floorPct }],
                }
              : undefined,
        },
      ],
    };
  });

  readonly sharpeScatterOptions = computed<EChartsOption>(() => {
    const w = this.weights();
    if (!w || w.entries.length === 0) return {};
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) =>
          `${p.data.name}<br/>Sharpe: ${p.value[0]}<br/>Observations: ${p.value[1]}<br/>Weight: ${p.value[2]}%`,
      },
      // No legend / toolbox: the theme's defaults were painting a stray grey
      // marker in the top-right corner of the plot.
      legend: { show: false },
      toolbox: { show: false },
      grid: { top: 40, right: 40, bottom: 50, left: 60 },
      xAxis: {
        type: 'value',
        name: 'Recent Sharpe',
        nameLocation: 'middle',
        nameGap: 28,
        scale: true,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'value',
        name: 'Observations',
        nameGap: 16,
        min: 0,
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'scatter',
          symbolSize: (val: any) => 8 + (val[2] ?? 0) / 10,
          data: w.entries.map((e) => ({
            name: e.strategyName,
            value: [+e.recentSharpe.toFixed(3), e.observationCount, +(e.weight * 100).toFixed(1)],
            itemStyle: {
              color: e.weight < 1 ? '#FF9500' : '#0071E3',
              opacity: 0.8,
            },
          })),
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => shortName(p.name),
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { type: 'dashed', color: '#8E8E93' },
            label: { formatter: `target ${w.targetSharpe.toFixed(2)}`, fontSize: 10 },
            data: [{ xAxis: +w.targetSharpe.toFixed(2) }],
          },
        },
      ],
    };
  });

  // ── FWER charts ──────────────────────────────────────────────────────
  readonly fwerFunnelOptions = computed<EChartsOption>(() => {
    const f = this.fwer();
    if (!f) return {};
    const stages = [
      { name: 'Active', value: f.totalActiveStrategies, color: '#0071E3' },
      { name: 'Eligible', value: f.eligibleStrategies, color: '#5AC8FA' },
      { name: 'Bonferroni', value: f.bonferroniSurvivors, color: '#34C759' },
      { name: 'BH-FDR', value: f.benjaminiHochbergSurvivors, color: '#AF52DE' },
    ];
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: stages.map((s) => s.name),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: stages.map((s) => ({
            value: s.value,
            itemStyle: { color: s.color, borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '50%',
          label: { show: true, position: 'top', fontSize: 11, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly fwerClassDonutOptions = computed<EChartsOption>(() => {
    const f = this.fwer();
    if (!f || f.byHypothesisClass.length === 0) return {};
    const palette = ['#0071E3', '#34C759', '#FF9500', '#AF52DE', '#5AC8FA', '#FF3B30'];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} trials ({d}%)' },
      legend: { bottom: 0, type: 'plain', textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
          label: { show: false },
          data: f.byHypothesisClass.map((row, i) => ({
            name: row.hypothesisClass,
            value: row.trialsInWindow,
            itemStyle: { color: palette[i % palette.length] },
          })),
        },
      ],
    };
  });

  constructor() {
    this.loadWeights();
    this.loadFwer();

    // The allocator broadcasts one event per non-empty cycle. Throttle so a
    // chatty cycle doesn't trigger more than one refetch. FWER doesn't have
    // its own event yet — we reuse the rebalance signal because the active
    // set changing is what matters for both panels.
    this.realtime
      .on('strategyAllocationRebalanced')
      .pipe(
        throttleTime(2_000, undefined, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.loadWeights();
      });
  }

  protected openStrategy(id: number): void {
    this.router.navigate(['/strategies', id]);
  }

  protected loadWeights(): void {
    this.weightsLoading.set(true);
    this.weightsFailed.set(false);
    this.strategies.getAllocationWeights().subscribe({
      next: (res) => {
        this.weightsFailed.set(!res?.status);
        this.weights.set(res?.data ?? null);
        this.weightsLoading.set(false);
      },
      error: () => {
        this.weightsFailed.set(true);
        this.weights.set(null);
        this.weightsLoading.set(false);
      },
    });
  }

  protected loadFwer(): void {
    this.fwerLoading.set(true);
    this.fwerFailed.set(false);
    this.strategies.getPortfolioFwerReport().subscribe({
      next: (res) => {
        this.fwerFailed.set(!res?.status);
        this.fwer.set(res?.data ?? null);
        this.fwerLoading.set(false);
      },
      error: () => {
        this.fwerFailed.set(true);
        this.fwer.set(null);
        this.fwerLoading.set(false);
      },
    });
  }
}

/** Legend/axis form of a strategy name — drops the "LLM:" prefix and clips long tails. */
function shortName(name: string): string {
  const trimmed = (name ?? '').replace(/^LLM:\s*/i, '');
  return trimmed.length > 28 ? trimmed.slice(0, 26) + '…' : trimmed;
}
