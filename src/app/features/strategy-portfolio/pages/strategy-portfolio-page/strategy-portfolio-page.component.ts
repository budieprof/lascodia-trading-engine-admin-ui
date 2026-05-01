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
import type { PortfolioFwerReportDto, StrategyAllocationWeightsDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

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
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Portfolio"
        subtitle="Allocations, throttle posture, and multiple-testing-tax across the active set"
      />

      <!-- Allocations -->
      <section class="section">
        <header class="section-head">
          <h3>Active allocations</h3>
          @if (weights(); as w) {
            <span class="muted small">
              {{ w.coveredStrategies }} strategies · {{ w.throttledStrategies }} throttled · target
              Sharpe {{ w.targetSharpe.toFixed(2) }} · floor {{ (w.minWeight * 100).toFixed(0) }}% ·
              updated {{ w.latestComputedAt | relativeTime }}
            </span>
          }
        </header>

        @if (weightsLoading() && !weights()) {
          <app-card-skeleton [lines]="6" />
        } @else if (weights(); as w) {
          @if (w.entries.length > 0) {
            <div class="allocation-grid">
              <app-chart-card
                title="Weight distribution"
                subtitle="Donut sized by allocator weight"
                [options]="donutOptions()!"
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
                        <th class="num">Weight</th>
                        <th class="num">Sharpe</th>
                        <th class="num">N</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (e of w.entries; track e.strategyId) {
                        <tr (click)="openStrategy(e.strategyId)">
                          <td>{{ e.strategyName }}</td>
                          <td>{{ e.symbol }}</td>
                          <td class="num" [attr.data-throttled]="e.weight < 1 ? '1' : null">
                            {{ (e.weight * 100).toFixed(0) }}%
                          </td>
                          <td class="num">{{ e.recentSharpe.toFixed(2) }}</td>
                          <td class="num">{{ e.observationCount }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          } @else {
            <app-empty-state
              title="No allocation snapshot yet"
              description="StrategyAllocatorWorker hasn't run a cycle, or no strategies are eligible."
            />
          }
        } @else {
          <app-empty-state
            title="Allocations unavailable"
            description="The allocation-weights endpoint returned no data."
          />
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
              <span class="meta-value">{{ f.benjaminiHochbergCriticalPValue.toFixed(4) }}</span>
            </div>
          </div>

          @if (f.byHypothesisClass.length > 0) {
            <table class="fwer-table">
              <thead>
                <tr>
                  <th>Hypothesis class</th>
                  <th class="num">Active</th>
                  <th class="num">Trials</th>
                  <th class="num">Bonferroni survivors</th>
                </tr>
              </thead>
              <tbody>
                @for (row of f.byHypothesisClass; track row.hypothesisClass) {
                  <tr>
                    <td>{{ row.hypothesisClass }}</td>
                    <td class="num">{{ row.activeStrategies }}</td>
                    <td class="num">{{ row.trialsInWindow }}</td>
                    <td class="num">{{ row.bonferroniSurvivors }}</td>
                  </tr>
                }
              </tbody>
            </table>
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
        grid-template-columns: minmax(280px, 1fr) minmax(360px, 2fr);
        gap: var(--space-4);
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
        color: #c93400;
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

  readonly fwer = signal<PortfolioFwerReportDto | null>(null);
  readonly fwerLoading = signal(true);

  readonly donutOptions = computed<EChartsOption | null>(() => {
    const w = this.weights();
    if (!w || w.entries.length === 0) return null;
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { type: 'scroll', bottom: 0 },
      series: [
        {
          name: 'Allocation',
          type: 'pie',
          radius: ['40%', '70%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 1 },
          label: { show: false },
          data: w.entries.map((e) => ({
            name: `${e.strategyName} (${e.symbol})`,
            value: +(e.weight * 100).toFixed(2),
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

  private loadWeights(): void {
    this.weightsLoading.set(true);
    this.strategies.getAllocationWeights().subscribe({
      next: (res) => {
        this.weights.set(res?.data ?? null);
        this.weightsLoading.set(false);
      },
      error: () => {
        this.weights.set(null);
        this.weightsLoading.set(false);
      },
    });
  }

  private loadFwer(): void {
    this.fwerLoading.set(true);
    this.strategies.getPortfolioFwerReport().subscribe({
      next: (res) => {
        this.fwer.set(res?.data ?? null);
        this.fwerLoading.set(false);
      },
      error: () => {
        this.fwer.set(null);
        this.fwerLoading.set(false);
      },
    });
  }
}
