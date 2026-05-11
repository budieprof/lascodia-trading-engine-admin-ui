import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, finalize, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyCapacityProfileDto } from '@core/api/api.types';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Capacity profile card for the strategy detail page (PRD §5.3 FR-3.4).
 * Renders the engine's AUM-vs-Sharpe capacity sweep as a dual-axis chart
 * (Sharpe line + ProfitFactor line + Max-DD bars) so operators can pick a
 * sizing target where the strategy still meets its Sharpe floor.
 */
@Component({
  selector: 'app-strategy-capacity-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    ChartCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel">
      <header class="panel-head">
        <h3>Capacity Profile</h3>
        <span class="muted small" *ngIf="profile() as p">
          Computed
          <span [title]="p.computedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
            {{ p.computedAt | relativeTime }}
          </span>
        </span>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (error()) {
        <app-error-state
          title="Could not load capacity profile"
          message="Engine returned an error. The capacity sweep worker may not have run yet for this strategy."
          (retry)="load()"
        />
      } @else if (!profile() || profile()!.tiers.length === 0) {
        <app-empty-state
          title="No capacity profile yet"
          description="The engine's capacity-sweep worker hasn't produced an AUM-vs-Sharpe profile for this strategy. It runs periodically once the strategy has enough live evidence."
        />
      } @else {
        <div class="meta-strip">
          <span class="meta">
            Baseline AUM:
            <strong class="mono">{{ profile()!.baselineAum | number: '1.0-0' }}</strong>
          </span>
          <span class="meta">
            Baseline Sharpe:
            <strong
              class="mono"
              [class.positive]="profile()!.baselineSharpe > 0"
              [class.negative]="profile()!.baselineSharpe < 0"
            >
              {{ profile()!.baselineSharpe | number: '1.0-2' }}
            </strong>
          </span>
          <span class="meta">
            Capacity floor AUM:
            <strong class="mono" [class.warn]="profile()!.capacityFloorAum === 0">
              @if (profile()!.capacityFloorAum > 0) {
                {{ profile()!.capacityFloorAum | number: '1.0-0' }}
              } @else {
                no tier passes the floor
              }
            </strong>
          </span>
          <span class="meta muted">
            {{ profile()!.tiers.length }} tier{{ profile()!.tiers.length === 1 ? '' : 's' }} ·
            {{ passingCount() }} meets floor
          </span>
        </div>

        <app-chart-card
          title="AUM tier — Sharpe (left) · Profit factor (left) · Max DD % (right, bars)"
          subtitle="Tiers where Sharpe stays above the floor are coloured green; failing tiers red"
          [options]="chartOptions()"
          height="280px"
        />

        <section class="card">
          <table class="tiers-table">
            <thead>
              <tr>
                <th class="num">AUM tier</th>
                <th class="num">Sharpe</th>
                <th class="num">Profit factor</th>
                <th class="num">Max DD %</th>
                <th>Meets floor?</th>
              </tr>
            </thead>
            <tbody>
              @for (t of profile()!.tiers; track t.aumTier) {
                <tr [class.passing]="t.meetsFloor" [class.failing]="!t.meetsFloor">
                  <td class="num mono">{{ t.aumTier | number: '1.0-0' }}</td>
                  <td
                    class="num mono"
                    [class.positive]="t.sharpeAtTier > 0"
                    [class.negative]="t.sharpeAtTier < 0"
                  >
                    {{ t.sharpeAtTier | number: '1.0-2' }}
                  </td>
                  <td class="num mono">{{ t.profitFactorAtTier | number: '1.0-2' }}</td>
                  <td class="num mono">{{ t.maxDrawdownPctAtTier | number: '1.0-2' }}%</td>
                  <td>
                    @if (t.meetsFloor) {
                      <span class="pill ok">passes</span>
                    } @else {
                      <span class="pill fail">fails</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .meta-strip {
        display: flex;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .meta {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .meta strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .meta.muted {
        color: var(--text-tertiary);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .positive {
        color: #248a3d;
      }
      .negative {
        color: #d70015;
      }
      .warn {
        color: #c93400;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        overflow-x: auto;
      }
      .tiers-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .tiers-table th,
      .tiers-table td {
        padding: 6px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .tiers-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .tiers-table td.num,
      .tiers-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .tiers-table tr.passing {
        background: rgba(52, 199, 89, 0.04);
      }
      .tiers-table tr.failing {
        background: rgba(255, 59, 48, 0.03);
      }
      .pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .pill.ok {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill.fail {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
    `,
  ],
})
export class StrategyCapacityCardComponent {
  private readonly strategies = inject(StrategiesService);

  readonly strategyId = input.required<number>();

  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly profile = signal<StrategyCapacityProfileDto | null>(null);

  protected readonly passingCount = computed(
    () => this.profile()?.tiers.filter((t) => t.meetsFloor).length ?? 0,
  );

  constructor() {
    effect(() => {
      const id = this.strategyId();
      if (id) this.load(id);
    });
  }

  protected load(idOverride?: number): void {
    const id = idOverride ?? this.strategyId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(false);
    this.strategies
      .getCapacityProfile(id)
      .pipe(
        map((res) => (res.status ? (res.data ?? null) : null)),
        catchError(() => of(null)),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((data) => {
        if (data === null) this.error.set(true);
        else this.profile.set(data);
      });
  }

  protected readonly chartOptions = computed<EChartsOption>(() => {
    const p = this.profile();
    if (!p || p.tiers.length === 0) return {};
    const aums = p.tiers.map((t) => t.aumTier);
    const sharpes = p.tiers.map((t) => ({
      value: t.sharpeAtTier,
      itemStyle: { color: t.meetsFloor ? '#34c759' : '#ff3b30' },
    }));
    const pfs = p.tiers.map((t) => t.profitFactorAtTier);
    const dds = p.tiers.map((t) => t.maxDrawdownPctAtTier);
    return {
      grid: { left: 56, right: 56, top: 32, bottom: 36 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: {
        data: ['Sharpe', 'Profit factor', 'Max DD %'],
        top: 0,
        textStyle: { fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: aums.map((a) => a.toLocaleString()),
        axisLabel: { fontSize: 10 },
        name: 'AUM',
        nameLocation: 'middle',
        nameGap: 26,
      },
      yAxis: [
        {
          type: 'value',
          name: 'Sharpe / PF',
          position: 'left',
          axisLabel: { fontSize: 10 },
          splitLine: { lineStyle: { type: 'dashed', opacity: 0.4 } },
        },
        {
          type: 'value',
          name: 'Max DD %',
          position: 'right',
          axisLabel: { fontSize: 10, formatter: '{value}%' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Sharpe',
          type: 'line',
          yAxisIndex: 0,
          data: sharpes,
          smooth: true,
          showSymbol: true,
          symbolSize: 6,
          lineStyle: { width: 2, color: '#0071e3' },
        },
        {
          name: 'Profit factor',
          type: 'line',
          yAxisIndex: 0,
          data: pfs,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#8e8e93', type: 'dashed' },
        },
        {
          name: 'Max DD %',
          type: 'bar',
          yAxisIndex: 1,
          data: dds,
          itemStyle: { color: 'rgba(255, 149, 0, 0.4)' },
          barWidth: '40%',
        },
      ],
    };
  });
}
