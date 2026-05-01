import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyDto, StrategyEquityCurveDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/**
 * Side-by-side comparison of 2–4 strategies. Picker drives a forkJoin over
 * the per-strategy equity-curve endpoint; the curves render normalized to
 * each strategy's first close-time so different start dates don't squash
 * shorter histories against the right edge.
 *
 * Cap at 4 because the chart legend gets unreadable past that and the
 * cumulative-pnl scale loses meaning when half the lines are flat starting
 * regions.
 */
@Component({
  selector: 'app-strategies-compare-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    FormsModule,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Compare"
        subtitle="Overlay realised cumulative PnL for up to 4 strategies"
      />

      <section class="picker">
        <header class="picker-head">
          <h3>Pick strategies</h3>
          <span class="muted small">{{ picked().length }}/{{ MAX }} selected</span>
        </header>
        @if (allLoading()) {
          <app-card-skeleton [lines]="3" />
        } @else if (allStrategies().length === 0) {
          <app-empty-state
            title="No strategies to compare"
            description="Create at least two strategies first."
          />
        } @else {
          <div class="chips">
            @for (s of allStrategies(); track s.id) {
              <button
                type="button"
                class="chip"
                [class.picked]="isPicked(s.id)"
                [disabled]="!isPicked(s.id) && picked().length >= MAX"
                (click)="toggle(s.id)"
              >
                {{ s.name }}
                <span class="muted">({{ s.symbol }})</span>
              </button>
            }
          </div>
        }
      </section>

      @if (picked().length >= 2) {
        @if (curvesLoading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (overlayChart(); as opts) {
          <app-chart-card
            title="Cumulative realised PnL"
            subtitle="Normalised to each strategy's first close — flat segments mean no closed positions in that window"
            [options]="opts"
            height="420px"
          />
          <table class="summary">
            <thead>
              <tr>
                <th>Strategy</th>
                <th class="num">Closed positions</th>
                <th class="num">Final cumulative PnL</th>
                <th class="num">First close</th>
                <th class="num">Last close</th>
              </tr>
            </thead>
            <tbody>
              @for (row of summaryRows(); track row.strategyId) {
                <tr>
                  <td>{{ row.name }}</td>
                  <td class="num">{{ row.pointCount }}</td>
                  <td class="num" [attr.data-sign]="row.finalCumulativePnL >= 0 ? 'pos' : 'neg'">
                    {{ row.finalCumulativePnL.toFixed(2) }}
                  </td>
                  <td class="num">{{ row.firstAt ?? '—' }}</td>
                  <td class="num">{{ row.lastAt ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <app-empty-state
            title="No closed positions in the selected strategies"
            description="None of the picked strategies have any closed positions yet, so there's nothing to overlay."
          />
        }
      } @else {
        <app-empty-state
          title="Pick at least 2 strategies"
          description="Select 2–4 strategies above to overlay their cumulative PnL curves."
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

      .picker {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .picker-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .picker-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-sm);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .chip:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
      }
      .chip.picked {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .chip.picked .muted {
        color: rgba(255, 255, 255, 0.85);
      }
      .chip:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .summary {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .summary th,
      .summary td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .summary th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        background: var(--bg-secondary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      td.num[data-sign='pos'] {
        color: #248a3d;
      }
      td.num[data-sign='neg'] {
        color: #d70015;
      }
    `,
  ],
})
export class StrategiesComparePageComponent {
  protected readonly MAX = 4;

  private readonly strategiesService = inject(StrategiesService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly allStrategies = signal<StrategyDto[]>([]);
  readonly allLoading = signal(true);

  readonly picked = signal<number[]>([]);

  readonly curves = signal<Map<number, StrategyEquityCurveDto>>(new Map());
  readonly curvesLoading = signal(false);

  readonly summaryRows = computed(() => {
    const map = this.curves();
    const byId = new Map(this.allStrategies().map((s) => [s.id, s]));
    return this.picked().map((id) => {
      const c = map.get(id);
      const s = byId.get(id);
      return {
        strategyId: id,
        name: s?.name ?? `#${id}`,
        pointCount: c?.pointCount ?? 0,
        finalCumulativePnL: c?.finalCumulativePnL ?? 0,
        firstAt: c?.points?.[0]?.closedAt ?? null,
        lastAt: c?.points?.[c.points.length - 1]?.closedAt ?? null,
      };
    });
  });

  readonly overlayChart = computed<EChartsOption | null>(() => {
    const map = this.curves();
    const byId = new Map(this.allStrategies().map((s) => [s.id, s]));
    const series = this.picked()
      .map((id) => ({ id, curve: map.get(id), s: byId.get(id) }))
      .filter((x) => x.curve && x.curve.points.length > 0);

    if (series.length === 0) return null;

    return {
      grid: { left: 64, right: 24, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis' },
      legend: { data: series.map((x) => x.s?.name ?? `#${x.id}`) },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'Cumulative PnL' },
      series: series.map((x) => ({
        name: x.s?.name ?? `#${x.id}`,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: x.curve!.points.map((p) => [p.closedAt, +p.cumulativePnL.toFixed(2)]),
      })),
    };
  });

  constructor() {
    this.loadStrategies();

    // Pre-select via ?ids=1,2,3 query string so deep links work.
    const idsParam = this.route.snapshot.queryParamMap.get('ids');
    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n))
        .slice(0, this.MAX);
      this.picked.set(ids);
      if (ids.length >= 2) this.loadCurves();
    }
  }

  protected isPicked(id: number): boolean {
    return this.picked().includes(id);
  }

  protected toggle(id: number): void {
    const cur = this.picked();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, this.MAX);
    this.picked.set(next);
    this.syncQueryParam(next);
    if (next.length >= 2) this.loadCurves();
  }

  private syncQueryParam(ids: number[]): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ids: ids.length > 0 ? ids.join(',') : null },
      queryParamsHandling: 'merge',
    });
  }

  private loadStrategies(): void {
    this.allLoading.set(true);
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 100, filter: null }).subscribe({
      next: (res) => {
        this.allStrategies.set(res?.data?.data ?? []);
        this.allLoading.set(false);
      },
      error: () => {
        this.allStrategies.set([]);
        this.allLoading.set(false);
      },
    });
  }

  private loadCurves(): void {
    const ids = this.picked();
    if (ids.length === 0) return;
    this.curvesLoading.set(true);
    forkJoin(
      ids.map((id) => this.strategiesService.getEquityCurve(id).pipe(catchError(() => of(null)))),
    ).subscribe((results) => {
      const next = new Map<number, StrategyEquityCurveDto>();
      results.forEach((res, i) => {
        const data = res?.data;
        if (data) next.set(ids[i], data);
      });
      this.curves.set(next);
      this.curvesLoading.set(false);
    });
  }
}
