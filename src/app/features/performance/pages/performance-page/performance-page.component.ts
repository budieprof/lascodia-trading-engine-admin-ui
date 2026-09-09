import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, merge, of, switchMap, throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { PerformanceService, PerformanceAttributionDto } from '@core/services/performance.service';
import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyPerformanceSnapshotDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RealtimeService } from '@core/realtime/realtime.service';

import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';

/**
 * One leaderboard row: the attribution record joined with the latest
 * StrategyPerformanceSnapshot (profit factor + health), which the attribution
 * endpoint does not carry.
 */
interface PerfRow {
  strategyId: number;
  name: string | null;
  trades: number;
  winRate: number; // 0..1
  pnl: number;
  avgPnlPerTrade: number;
  /** null when the engine's Sharpe is not meaningful (see `sharpeOf`). */
  sharpe: number | null;
  /** Drawdown as % of peak cumulative profit, clamped to 100 for aggregates. */
  ddPct: number;
  /** True when the raw drawdown exceeded 100% (equity fell below zero after a peak). */
  ddOverflow: boolean;
  netR: number | null;
  rTrades: number;
  profitFactor: number | null;
  health: string | null;
}

type SortKey = 'strategyId' | 'trades' | 'winRate' | 'profitFactor' | 'sharpe' | 'ddPct' | 'pnl';

const DD_CAP = 100;

@Component({
  selector: 'app-performance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MetricCardComponent,
    ChartCardComponent,
    PageHeaderComponent,
    TabsComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    CardSkeletonComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Performance"
        subtitle="Latest per-strategy attribution from the engine's feedback window"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (loading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (loadError()) {
          <app-error-state
            title="Could not load performance attribution"
            message="GET /performance/all failed. The leaderboard and tiles are unavailable until the engine responds."
            (retry)="refresh()"
          />
        } @else if (rows().length === 0) {
          <app-empty-state
            title="No performance snapshots available"
            description="The engine has not yet evaluated any active strategies, or none closed a position inside the feedback window."
          />
        } @else if (activeTab() === 'overview') {
          <div class="perf-kpis">
            <app-metric-card
              label="Total P&amp;L"
              [value]="totalPnl()"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card label="Strategies tracked" [value]="rows().length" format="number" />
            <app-metric-card label="Profitable" [value]="profitableCount()" format="number" />
            <app-metric-card label="Losing" [value]="losingCount()" format="number" />
            <app-metric-card label="Flat (0.00)" [value]="flatCount()" format="number" />
            <app-metric-card label="Closed trades" [value]="totalTrades()" format="number" />
            <app-metric-card label="Avg win rate" [value]="avgWinRate()" format="percent" />
            <app-metric-card
              label="Avg Sharpe (≥ 2 trades)"
              [value]="avgSharpe()"
              format="number"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Avg profit factor"
              [value]="avgProfitFactor()"
              format="number"
            />
            <app-metric-card
              label="Worst drawdown (of peak profit)"
              [value]="maxDrawdown()"
              format="percent"
              [colorByValue]="true"
              [invertColor]="true"
            />
          </div>
          @if (ddOverflowCount() > 0) {
            <p class="note">
              {{ ddOverflowCount() }} of {{ rows().length }} strategies report a drawdown above 100%
              — the engine measures drawdown against peak cumulative profit, so a small early peak
              followed by a loss below zero overflows. Those values are shown as “&gt;100%” and
              clamped at 100% in every average and histogram.
            </p>
          }

          <div class="charts-grid">
            <app-chart-card
              title="P&amp;L by strategy"
              subtitle="Total P&amp;L over the feedback window"
              [options]="pnlByStrategyChart()"
              [height]="rankedChartHeight()"
            />
            @if (sharpeRows().length > 0) {
              <app-chart-card
                title="Sharpe ratio leaderboard"
                subtitle="{{ sharpeRows().length }} strategies with ≥ 2 trades"
                [options]="sharpeChart()"
                [height]="rankedChartHeight()"
              />
            } @else {
              <section class="table-card stat-card">
                <header class="card-head"><h3>Sharpe ratio leaderboard</h3></header>
                <p class="muted pad">
                  No strategy has ≥ 2 closed trades yet, so Sharpe is not computable.
                </p>
              </section>
            }
          </div>

          <div class="perf-charts">
            @if (healthBuckets().length > 1) {
              <app-chart-card
                title="Health distribution"
                subtitle="Healthy · Degrading · Critical"
                [options]="healthDonutOptions()"
                height="240px"
              />
            } @else {
              <section class="table-card stat-card">
                <header class="card-head"><h3>Health distribution</h3></header>
                <p class="muted pad">
                  @if (healthBuckets().length === 1) {
                    Health: {{ healthBuckets()[0].name }} ({{ healthBuckets()[0].count }}/{{
                      rows().length
                    }})
                    @if (healthBuckets()[0].name === 'Unknown') {
                      — health scoring not yet populated.
                    }
                  } @else {
                    Health scoring not yet populated.
                  }
                </p>
              </section>
            }
            <app-chart-card
              title="Win-rate distribution"
              subtitle="Strategies per win-rate band"
              [options]="winRateHistogramOptions()"
              height="240px"
            />
            <app-chart-card
              title="Drawdown distribution"
              subtitle="Strategies per max-drawdown band (clamped at 100%)"
              [options]="ddHistogramOptions()"
              height="240px"
            />
          </div>

          <div class="perf-board-row">
            <section class="table-card">
              <header class="card-head">
                <h3>Top winners</h3>
                <span class="card-sub">Highest total P&amp;L</span>
              </header>
              @if (topWinners().length > 0) {
                <table class="table compact">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th class="num">P&amp;L</th>
                      <th class="num">Win %</th>
                      <th class="num">Sharpe</th>
                      <th class="num">Trades</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of topWinners(); track s.strategyId) {
                      <tr>
                        <td class="mono" [title]="s.name ?? ''">#{{ s.strategyId }}</td>
                        <td class="num profit">{{ money(s.pnl) }}</td>
                        <td class="num">{{ pct(s.winRate * 100) }}</td>
                        <td class="num">{{ num(s.sharpe) }}</td>
                        <td class="num">{{ int(s.trades) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="muted pad">No profitable strategies in the current window.</p>
              }
            </section>

            <section class="table-card">
              <header class="card-head">
                <h3>Worst losers</h3>
                <span class="card-sub">Lowest total P&amp;L — candidates for review</span>
              </header>
              @if (worstLosers().length > 0) {
                <table class="table compact">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th class="num">P&amp;L</th>
                      <th class="num">Win %</th>
                      <th class="num">Max DD</th>
                      <th class="num">Trades</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of worstLosers(); track s.strategyId) {
                      <tr>
                        <td class="mono" [title]="s.name ?? ''">#{{ s.strategyId }}</td>
                        <td class="num loss">{{ money(s.pnl) }}</td>
                        <td class="num">{{ pct(s.winRate * 100) }}</td>
                        <td class="num" [class.loss]="s.ddPct > 0">{{ dd(s) }}</td>
                        <td class="num">{{ int(s.trades) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="muted pad">No losing strategies — fleet is fully profitable.</p>
              }
            </section>
          </div>

          <section class="table-card">
            <header class="card-head">
              <h3>Strategy leaderboard</h3>
              <span class="card-sub">{{ rows().length }} strategies · click a column to sort</span>
            </header>
            <div class="lb-scroll">
              <table class="table sticky-head">
                <thead>
                  <tr>
                    <th (click)="sortBy('strategyId')" class="sortable">
                      Strategy{{ caret('strategyId') }}
                    </th>
                    <th class="num sortable" (click)="sortBy('trades')">
                      Trades{{ caret('trades') }}
                    </th>
                    <th class="num sortable" (click)="sortBy('winRate')">
                      Win rate{{ caret('winRate') }}
                    </th>
                    <th class="num sortable" (click)="sortBy('profitFactor')">
                      Profit factor{{ caret('profitFactor') }}
                    </th>
                    <th class="num sortable" (click)="sortBy('sharpe')">
                      Sharpe{{ caret('sharpe') }}
                    </th>
                    <th class="num sortable" (click)="sortBy('ddPct')">
                      Max DD{{ caret('ddPct') }}
                    </th>
                    <th class="num sortable" (click)="sortBy('pnl')">
                      Total P&amp;L{{ caret('pnl') }}
                    </th>
                    <th class="num">Net R</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of sortedRows(); track s.strategyId) {
                    <tr>
                      <td class="mono" [title]="s.name ?? ''">#{{ s.strategyId }}</td>
                      <td class="num">{{ int(s.trades) }}</td>
                      <td class="num">{{ pct(s.winRate * 100) }}</td>
                      <td class="num">{{ num(s.profitFactor) }}</td>
                      <td
                        class="num"
                        [class.profit]="(s.sharpe ?? 0) > 1"
                        [class.loss]="(s.sharpe ?? 0) < 0"
                        [title]="s.sharpe === null ? 'Needs ≥ 2 closed trades' : ''"
                      >
                        {{ num(s.sharpe) }}
                      </td>
                      <td class="num" [class.loss]="s.ddPct > 0">{{ dd(s) }}</td>
                      <td class="num" [class.profit]="s.pnl > 0" [class.loss]="s.pnl < 0">
                        {{ money(s.pnl) }}
                      </td>
                      <td class="num" [title]="s.netR === null ? '' : s.rTrades + ' trades with R'">
                        {{ s.netR === null ? '—' : num(s.netR) + 'R' }}
                      </td>
                      <td>
                        <span
                          class="pill"
                          [class.healthy]="s.health === 'Healthy'"
                          [class.degrading]="s.health === 'Degrading'"
                          [class.critical]="s.health === 'Critical'"
                        >
                          {{ s.health ?? '—' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        } @else {
          <div class="perf-kpis">
            <app-metric-card
              label="Total P&amp;L"
              [value]="totalPnl()"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Profitable P&amp;L"
              [value]="positivePnlSum()"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Losing P&amp;L"
              [value]="negativePnlSum()"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Top contributor"
              [value]="topContributorPnl()"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Top detractor"
              [value]="topDetractorPnl()"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Concentration (top 3)"
              [value]="top3Concentration()"
              format="percent"
            />
          </div>

          <div class="perf-board-row">
            <app-chart-card
              title="P&amp;L contribution by strategy"
              subtitle="Each bar = one strategy's net contribution to book P&amp;L"
              [options]="contributionChartOptions()"
              [height]="rankedChartHeight()"
            />
            <div class="stack">
              @if (healthBuckets().length > 1) {
                <app-chart-card
                  title="P&amp;L by health bucket"
                  subtitle="Healthy strategies typically carry the book"
                  [options]="pnlByHealthOptions()"
                  height="240px"
                />
              } @else {
                <section class="table-card stat-card">
                  <header class="card-head"><h3>P&amp;L by health bucket</h3></header>
                  <p class="muted pad">
                    @if (healthBuckets().length === 1) {
                      All {{ rows().length }} strategies are {{ healthBuckets()[0].name }} — book
                      P&amp;L {{ money(totalPnl()) }}.
                    } @else {
                      Health scoring not yet populated.
                    }
                  </p>
                </section>
              }
              @if (pfValues().length > 1) {
                <app-chart-card
                  title="Profit-factor distribution"
                  subtitle="Strategies per profit-factor band"
                  [options]="pfHistogramOptions()"
                  height="240px"
                />
              } @else {
                <section class="table-card stat-card">
                  <header class="card-head"><h3>Profit-factor distribution</h3></header>
                  <p class="muted pad">
                    @if (pfValues().length === 1) {
                      One strategy with a profit factor: {{ num(pfValues()[0]) }}.
                    } @else {
                      No profit-factor data — the latest strategy snapshots did not load.
                    }
                  </p>
                </section>
              }
            </div>
          </div>

          @if (perHealthBreakdown().length > 0) {
            <section class="table-card">
              <header class="card-head">
                <h3>Per-health breakdown</h3>
                <span class="card-sub">Strategies grouped by latest snapshot health</span>
              </header>
              <table class="table compact">
                <thead>
                  <tr>
                    <th>Health</th>
                    <th class="num">Strategies</th>
                    <th class="num">Total P&amp;L</th>
                    <th class="num">Share of |P&amp;L|</th>
                    <th class="num">Avg PF</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perHealthBreakdown(); track row.bucket) {
                    <tr>
                      <td>
                        <span
                          class="pill"
                          [class.healthy]="row.bucket === 'Healthy'"
                          [class.degrading]="row.bucket === 'Degrading'"
                          [class.critical]="row.bucket === 'Critical'"
                        >
                          {{ row.bucket }}
                        </span>
                      </td>
                      <td class="num">{{ int(row.count) }}</td>
                      <td
                        class="num"
                        [class.profit]="row.totalPnl > 0"
                        [class.loss]="row.totalPnl < 0"
                      >
                        {{ money(row.totalPnl) }}
                      </td>
                      <td class="num">{{ pct(row.sharePct) }}</td>
                      <td class="num">{{ num(row.avgPf) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }

          <section class="table-card">
            <header class="card-head">
              <h3>Per-strategy attribution</h3>
              <span class="card-sub">
                {{ rows().length }} strategies · ranked by absolute contribution
              </span>
            </header>
            <div class="lb-scroll">
              <table class="table sticky-head compact">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Name</th>
                    <th>Health</th>
                    <th class="num">Trades</th>
                    <th class="num">Total P&amp;L</th>
                    <th class="num">Avg P&amp;L / trade</th>
                    <th class="num">Share</th>
                    <th class="num">Sharpe</th>
                    <th class="num">PF</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perStrategyAttribution(); track row.strategyId) {
                    <tr>
                      <td class="mono">#{{ row.strategyId }}</td>
                      <td class="ellipsis" [title]="row.name ?? ''">{{ row.name ?? '—' }}</td>
                      <td>
                        <span
                          class="pill"
                          [class.healthy]="row.health === 'Healthy'"
                          [class.degrading]="row.health === 'Degrading'"
                          [class.critical]="row.health === 'Critical'"
                        >
                          {{ row.health ?? '—' }}
                        </span>
                      </td>
                      <td class="num">{{ int(row.trades) }}</td>
                      <td class="num" [class.profit]="row.pnl > 0" [class.loss]="row.pnl < 0">
                        {{ money(row.pnl) }}
                      </td>
                      <td class="num">{{ money(row.avgPnlPerTrade) }}</td>
                      <td
                        class="num"
                        [class.profit]="row.sharePct > 0"
                        [class.loss]="row.sharePct < 0"
                      >
                        {{ signedPct(row.sharePct) }}
                      </td>
                      <td class="num">{{ num(row.sharpe) }}</td>
                      <td class="num">{{ num(row.profitFactor) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      /* auto-fit wraps the tile row instead of squeezing 8–10 tiles past the
       * viewport; align-items:start keeps short tiles from stretching. */
      .perf-kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-2);
        margin-bottom: var(--space-3);
        align-items: start;
      }
      .note {
        margin: 0 0 var(--space-3);
        padding: var(--space-2) var(--space-3);
        border-left: 3px solid var(--warning);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        border-radius: var(--radius-sm);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
        align-items: start;
      }
      .perf-charts {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .perf-charts {
          grid-template-columns: 1fr;
        }
      }
      .perf-board-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
        align-items: start;
      }
      .stack {
        display: grid;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .perf-board-row,
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }
      .table.compact th,
      .table.compact td {
        padding: 6px var(--space-3);
        font-size: var(--text-xs);
      }
      .card-sub {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin-left: var(--space-3);
      }
      .lb-scroll {
        max-height: 480px;
        overflow: auto;
      }
      .table.sticky-head thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .table .ellipsis {
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .pad {
        padding: var(--space-4) var(--space-5);
        margin: 0;
      }
      .table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-3);
      }
      .stat-card {
        margin-bottom: 0;
      }
      .card-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
        white-space: nowrap;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .table th.sortable {
        cursor: pointer;
        user-select: none;
      }
      .table th.sortable:hover {
        color: var(--text-primary);
      }
      .table th.num,
      .table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .profit {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      .loss {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .pill.healthy {
        background: rgba(52, 199, 89, 0.12);
        color: var(--profit);
      }
      .pill.degrading {
        background: rgba(255, 149, 0, 0.12);
        color: var(--warning);
      }
      .pill.critical {
        background: rgba(255, 59, 48, 0.12);
        color: var(--loss);
      }
    `,
  ],
})
export class PerformancePageComponent {
  private readonly service = inject(PerformanceService);
  private readonly strategies = inject(StrategiesService);
  private readonly realtime = inject(RealtimeService);

  readonly tabs: TabItem[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Attribution', value: 'attribution' },
  ];
  readonly activeTab = signal('overview');

  private readonly sortKey = signal<SortKey>('pnl');
  private readonly sortDir = signal<'asc' | 'desc'>('desc');

  /**
   * `/performance/all` carries no profit factor or health, so the latest
   * StrategyPerformanceSnapshot per strategy is fetched in the same cycle and
   * joined by id. The enrichment is best-effort: if it fails the leaderboard
   * still renders with "—" in those two columns rather than failing the page.
   */
  private readonly resource = createPolledResource(
    () =>
      this.service.getAll().pipe(
        map((r) => r.data ?? []),
        switchMap((attr) => {
          const ids = attr.map((a) => a.strategyId);
          if (ids.length === 0) return of({ attr, snaps: [] as StrategyPerformanceSnapshotDto[] });
          return this.strategies
            .getRecentSnapshots({ strategyIds: ids.slice(0, 100), count: 1 })
            .pipe(
              map((r) => ({ attr, snaps: r.data ?? [] })),
              catchError(() => of({ attr, snaps: [] as StrategyPerformanceSnapshotDto[] })),
            );
        }),
      ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['positionClosed'],
    },
  );

  constructor() {
    // Push-refresh when the engine reports a closed position or a new fill —
    // both nudge per-strategy P&L. Throttled so a burst of fills during a
    // close-out doesn't hammer `/performance/all` while still beating the
    // 60 s poll.
    merge(this.realtime.on('positionClosed'), this.realtime.on('orderFilled'))
      .pipe(throttleTime(5_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.resource.refresh());
  }

  refresh(): void {
    this.resource.refresh();
  }

  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly loadError = computed(
    () => this.resource.error() !== null && this.resource.value() === null,
  );

  readonly rows = computed<PerfRow[]>(() => {
    const v = this.resource.value();
    if (!v) return [];
    const snapById = new Map<number, StrategyPerformanceSnapshotDto>();
    for (const s of v.snaps) {
      const prev = snapById.get(s.strategyId);
      if (!prev || s.evaluatedAt > prev.evaluatedAt) snapById.set(s.strategyId, s);
    }
    return v.attr.map((a) => {
      const snap = snapById.get(a.strategyId);
      const rawDd = Number.isFinite(a.maxDrawdownPct) ? Math.max(0, a.maxDrawdownPct) : 0;
      return {
        strategyId: a.strategyId,
        name: a.strategyName,
        trades: Number.isFinite(a.totalTrades) ? a.totalTrades : 0,
        winRate: Number.isFinite(a.winRate) ? a.winRate : 0,
        pnl: Number.isFinite(a.totalPnL) ? a.totalPnL : 0,
        avgPnlPerTrade: Number.isFinite(a.averagePnLPerTrade) ? a.averagePnLPerTrade : 0,
        sharpe: this.sharpeOf(a),
        ddPct: Math.min(rawDd, DD_CAP),
        ddOverflow: rawDd > DD_CAP,
        netR:
          a.netRExpectancy != null && Number.isFinite(a.netRExpectancy) ? a.netRExpectancy : null,
        rTrades: a.rComputableTrades ?? 0,
        profitFactor:
          snap && snap.profitFactor != null && Number.isFinite(snap.profitFactor)
            ? snap.profitFactor
            : null,
        health: snap?.healthStatus ?? null,
      };
    });
  });

  /**
   * The engine's Sharpe divides mean P&L by the stddev of per-trade P&L and
   * falls back to stddev = 1 when variance is zero — so with a single trade
   * (or identical trades) "Sharpe" is literally the P&L number. Treat those
   * as not computable rather than plotting a P&L figure on a Sharpe axis.
   */
  private sharpeOf(a: PerformanceAttributionDto): number | null {
    if (!Number.isFinite(a.sharpeRatio)) return null;
    if (a.totalTrades < 2) return null;
    if (a.sharpeRatio === a.averagePnLPerTrade && a.sharpeRatio !== 0) return null;
    return a.sharpeRatio;
  }

  private avgOf(getter: (x: PerfRow) => number | null): number | null {
    let sum = 0;
    let count = 0;
    for (const s of this.rows()) {
      const v = getter(s);
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  }

  readonly totalPnl = computed(() => this.rows().reduce((s, x) => s + x.pnl, 0));
  readonly totalTrades = computed(() => this.rows().reduce((s, x) => s + x.trades, 0));
  readonly maxDrawdown = computed(() => {
    const all = this.rows().map((x) => x.ddPct);
    return all.length > 0 ? Math.max(...all) : 0;
  });
  readonly ddOverflowCount = computed(() => this.rows().filter((x) => x.ddOverflow).length);
  readonly avgWinRate = computed(() => {
    const v = this.avgOf((x) => x.winRate);
    return v === null ? null : v * 100;
  });
  readonly avgProfitFactor = computed(() => this.avgOf((x) => x.profitFactor));
  readonly avgSharpe = computed(() => this.avgOf((x) => x.sharpe));

  readonly profitableCount = computed(() => this.rows().filter((x) => x.pnl > 0).length);
  readonly losingCount = computed(() => this.rows().filter((x) => x.pnl < 0).length);
  readonly flatCount = computed(() => this.rows().filter((x) => x.pnl === 0).length);

  readonly topWinners = computed(() =>
    [...this.rows()]
      .filter((s) => s.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 6),
  );
  readonly worstLosers = computed(() =>
    [...this.rows()]
      .filter((s) => s.pnl < 0)
      .sort((a, b) => a.pnl - b.pnl)
      .slice(0, 6),
  );

  readonly sortedRows = computed(() => {
    const key = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    return [...this.rows()].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      // Nulls (non-computable Sharpe / PF) always sink to the bottom.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  });

  sortBy(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === 'strategyId' || key === 'ddPct' ? 'asc' : 'desc');
    }
  }

  caret(key: SortKey): string {
    if (this.sortKey() !== key) return '';
    return this.sortDir() === 'asc' ? ' ▲' : ' ▼';
  }

  // ── Health (from the joined snapshots) ──────────────────────────────────
  readonly healthBuckets = computed(() => {
    const counts = new Map<string, number>();
    for (const s of this.rows()) {
      const k = s.health ?? 'Unknown';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  });

  private readonly healthColors: Record<string, string> = {
    Healthy: '#34C759',
    Degrading: '#FF9500',
    Critical: '#FF3B30',
    Unknown: '#8E8E93',
  };

  readonly healthDonutOptions = computed<EChartsOption>(() => ({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, textStyle: { fontSize: 10 } },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        label: { show: false },
        data: this.healthBuckets().map((b) => ({
          name: b.name,
          value: b.count,
          itemStyle: { color: this.healthColors[b.name] ?? '#8E8E93' },
        })),
      },
    ],
  }));

  readonly winRateHistogramOptions = computed<EChartsOption>(() =>
    this.bandHistogram(
      this.rows().map((s) => s.winRate * 100),
      [0, 20, 40, 50, 60, 80, 100],
      '%',
      '#34C759',
    ),
  );

  readonly ddHistogramOptions = computed<EChartsOption>(() =>
    this.bandHistogram(
      this.rows().map((s) => s.ddPct),
      [0, 10, 25, 50, 75, 100],
      '%',
      '#FF3B30',
    ),
  );

  readonly pfValues = computed(() =>
    this.rows()
      .map((s) => s.profitFactor)
      .filter((v): v is number => v !== null),
  );

  readonly pfHistogramOptions = computed<EChartsOption>(() =>
    this.bandHistogram(this.pfValues(), [0, 0.5, 1, 1.5, 2, 3, Infinity], '', '#0071E3'),
  );

  // ── Attribution-tab KPIs ─────────────────────────────────────────────
  readonly positivePnlSum = computed(() =>
    this.rows()
      .filter((s) => s.pnl > 0)
      .reduce((sum, s) => sum + s.pnl, 0),
  );
  readonly negativePnlSum = computed(() =>
    this.rows()
      .filter((s) => s.pnl < 0)
      .reduce((sum, s) => sum + s.pnl, 0),
  );
  readonly topContributorPnl = computed(() => {
    const best = Math.max(...this.rows().map((s) => s.pnl));
    return Number.isFinite(best) ? Math.max(best, 0) : 0;
  });
  readonly topDetractorPnl = computed(() => {
    const worst = Math.min(...this.rows().map((s) => s.pnl));
    return Number.isFinite(worst) ? Math.min(worst, 0) : 0;
  });
  // |top-3 by absolute P&L| / |total absolute P&L| — whether the book's
  // outcome is driven by a handful of strategies.
  readonly top3Concentration = computed(() => {
    const all = this.rows().map((s) => Math.abs(s.pnl));
    const total = all.reduce((sum, v) => sum + v, 0);
    if (total === 0) return 0;
    const top3 = [...all]
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((sum, v) => sum + v, 0);
    return (top3 / total) * 100;
  });

  /** Horizontal ranked bars need ~22px per strategy to keep labels legible. */
  readonly rankedChartHeight = computed(
    () => `${Math.min(640, Math.max(280, 60 + this.rows().length * 22))}px`,
  );

  private rankedBarOptions(
    data: { label: string; value: number; color: string }[],
    axisName: string,
    formatter: (v: number) => string,
  ): EChartsOption {
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v) => formatter(Number(v)),
      },
      grid: { left: 70, right: 24, top: 12, bottom: 48, containLabel: false },
      xAxis: {
        type: 'value',
        name: axisName,
        nameLocation: 'middle',
        nameGap: 30,
        axisLabel: { formatter: (v: number) => formatter(v) },
      },
      yAxis: {
        type: 'category',
        data: data.map((d) => d.label),
        inverse: true,
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          type: 'bar',
          data: data.map((d) => ({ value: +d.value.toFixed(2), itemStyle: { color: d.color } })),
          barMaxWidth: 18,
        },
      ],
    };
  }

  readonly pnlByStrategyChart = computed<EChartsOption>(() =>
    this.rankedBarOptions(
      [...this.rows()]
        .sort((a, b) => b.pnl - a.pnl)
        .map((d) => ({
          label: `#${d.strategyId}`,
          value: d.pnl,
          color: d.pnl >= 0 ? '#34C759' : '#FF3B30',
        })),
      'Total P&L ($)',
      (v) => this.compactMoney(v),
    ),
  );

  readonly sharpeRows = computed(() =>
    this.rows()
      .filter((s): s is PerfRow & { sharpe: number } => s.sharpe !== null)
      .sort((a, b) => b.sharpe - a.sharpe),
  );

  readonly sharpeChart = computed<EChartsOption>(() =>
    this.rankedBarOptions(
      this.sharpeRows().map((d) => ({
        label: `#${d.strategyId}`,
        value: d.sharpe,
        color: d.sharpe >= 0 ? '#0071E3' : '#FF3B30',
      })),
      'Sharpe ratio',
      (v) => v.toFixed(2),
    ),
  );

  readonly contributionChartOptions = computed<EChartsOption>(() =>
    this.rankedBarOptions(
      [...this.rows()]
        .sort((a, b) => b.pnl - a.pnl)
        .map((d) => ({
          label: `#${d.strategyId}`,
          value: d.pnl,
          color: d.pnl >= 0 ? '#34C759' : '#FF3B30',
        })),
      'Contribution ($)',
      (v) => this.compactMoney(v),
    ),
  );

  readonly perHealthBreakdown = computed(() => {
    type Row = {
      bucket: string;
      count: number;
      totalPnl: number;
      sharePct: number;
      avgPf: number | null;
      _pfSum: number;
      _pfCount: number;
    };
    // Only meaningful when at least one strategy has a health status; an
    // all-"Unknown" table is just the leaderboard restated.
    if (!this.rows().some((s) => s.health)) return [];
    const groups: Record<string, Row> = {};
    let totalAbsPnl = 0;
    for (const s of this.rows()) {
      const k = s.health ?? 'Unknown';
      groups[k] ??= {
        bucket: k,
        count: 0,
        totalPnl: 0,
        sharePct: 0,
        avgPf: null,
        _pfSum: 0,
        _pfCount: 0,
      };
      const g = groups[k];
      g.count++;
      g.totalPnl += s.pnl;
      totalAbsPnl += Math.abs(s.pnl);
      if (s.profitFactor !== null) {
        g._pfSum += s.profitFactor;
        g._pfCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        sharePct: totalAbsPnl > 0 ? (Math.abs(g.totalPnl) / totalAbsPnl) * 100 : 0,
        avgPf: g._pfCount > 0 ? g._pfSum / g._pfCount : null,
      }))
      .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
  });

  readonly perStrategyAttribution = computed(() => {
    const totalAbs = this.rows().reduce((sum, s) => sum + Math.abs(s.pnl), 0);
    return [...this.rows()]
      .map((s) => ({
        ...s,
        // Signed share against |total| so the absolute shares sum to 100%.
        sharePct: totalAbs > 0 ? (s.pnl / totalAbs) * 100 : 0,
      }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  });

  readonly pnlByHealthOptions = computed<EChartsOption>(() => {
    const buckets = new Map<string, number>();
    for (const s of this.rows()) {
      const k = s.health ?? 'Unknown';
      buckets.set(k, (buckets.get(k) ?? 0) + s.pnl);
    }
    const entries = [...buckets.entries()];
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => this.money(Number(v)) },
      grid: { top: 24, right: 20, bottom: 32, left: 64 },
      xAxis: { type: 'category', data: entries.map(([k]) => k) },
      yAxis: {
        type: 'value',
        name: 'P&L ($)',
        nameGap: 12,
        axisLabel: { formatter: (v: number) => this.compactMoney(v) },
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([name, v]) => ({
            value: +v.toFixed(2),
            itemStyle: { color: this.healthColors[name] ?? '#8E8E93' },
          })),
          barMaxWidth: 48,
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            formatter: (p) => this.compactMoney(Number(p.value)),
          },
        },
      ],
    };
  });

  /**
   * Fixed-edge histogram: bands are chosen for the metric (win-rate deciles,
   * drawdown quartiles) so labels stay short and horizontal instead of ten
   * auto-spaced "8723.7%" bins that overlap.
   */
  private bandHistogram(
    values: number[],
    edges: number[],
    unit: string,
    color: string,
  ): EChartsOption {
    if (values.length === 0) return {};
    const labels: string[] = [];
    const counts: number[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i];
      const hi = edges[i + 1];
      labels.push(hi === Infinity ? `≥ ${lo}${unit}` : `${lo}–${hi}${unit}`);
      counts.push(
        values.filter(
          (v) => v >= lo && (hi === Infinity || v < hi || (v === hi && i === edges.length - 2)),
        ).length,
      );
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 24, right: 16, bottom: 28, left: 44 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, interval: 0 } },
      yAxis: { type: 'value', name: 'Strategies', nameGap: 12, minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: counts.map((c) => ({ value: c, itemStyle: { color, borderRadius: [4, 4, 0, 0] } })),
          barMaxWidth: 40,
        },
      ],
    };
  }

  // ── Formatting: one money / percent / number format for the whole page ──
  money(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    const abs = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(v));
    return `${v < 0 ? '−' : v > 0 ? '+' : ''}$${abs}`;
  }

  compactMoney(v: number): string {
    const abs = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(0)}k`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    return `${sign}$${abs.toFixed(0)}`;
  }

  pct(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v.toFixed(1)}%`;
  }

  signedPct(v: number): string {
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  }

  num(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
  }

  int(v: number): string {
    return new Intl.NumberFormat('en-US').format(v);
  }

  dd(s: PerfRow): string {
    if (s.ddOverflow) return '>100%';
    return this.pct(s.ddPct);
  }
}
