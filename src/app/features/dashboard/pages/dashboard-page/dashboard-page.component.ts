import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { catchError, map, merge, of, throttleTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { EChartsOption } from 'echarts';

import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PositionsService } from '@core/services/positions.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { HealthService } from '@core/services/health.service';
import { DrawdownRecoveryService } from '@core/services/drawdown-recovery.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { StrategyEnsembleService } from '@core/services/strategy-ensemble.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { createPolledResource } from '@core/polling/polled-resource';

import type {
  DrawdownSnapshotDto,
  EngineStatusDto,
  PositionDto,
  StrategyAllocationDto,
  StrategyDto,
  TradeSignalDto,
  TradingAccountDto,
} from '@core/api/api.types';

const PALETTE = [
  '#0071E3',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#5AC8FA',
  '#FF3B30',
  '#FFCC00',
  '#30D158',
];

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MetricCardComponent, ChartCardComponent, PageHeaderComponent],
  template: `
    <div class="dashboard page">
      <app-page-header title="Dashboard" subtitle="Live engine overview" />

      <!--
        Hero strip sits behind the metric cards. Glass + a whisper of gradient
        so the eye's first target on load is the overall P&L posture rather
        than a flat grid of numbers.
      -->
      <div class="hero-strip">
        <div class="metrics-row">
          <app-metric-card
            label="Account Equity"
            [value]="equity()"
            format="currency"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Unrealized P&L"
            [value]="unrealizedPnl()"
            format="currency"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Open Positions"
            [value]="openPositionCount()"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Active Strategies"
            [value]="activeStrategyCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Pending Signals"
            [value]="pendingSignalCount()"
            format="number"
            dotColor="#FF9500"
          />
        </div>
      </div>

      <div class="charts-grid">
        <app-chart-card
          title="Daily P&L"
          subtitle="Realized P&L per day, last 30 days (from closed positions)"
          [options]="dailyPnlChart()"
          height="320px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Position Exposure"
          subtitle="Open positions grouped by symbol"
          [options]="exposureChart()"
          height="320px"
          [loading]="loading()"
        />
      </div>

      <div class="charts-grid">
        <app-chart-card
          title="Strategy Allocation"
          subtitle="Weight distribution across the active ensemble"
          [options]="allocationChart()"
          height="300px"
          [loading]="loading()"
        />
        <section class="panel">
          <header class="panel-head">
            <h3>Pending Signals</h3>
            @if (pendingSignals().length > 0) {
              <a routerLink="/trade-signals" class="link">View all</a>
            }
          </header>
          @if (pendingSignals().length > 0) {
            <ul class="signal-list">
              @for (sig of pendingSignals(); track sig.id) {
                <li class="signal-item">
                  <div class="signal-main">
                    <span class="signal-symbol">{{ sig.symbol }}</span>
                    <span
                      class="signal-direction"
                      [class.buy]="sig.direction === 'Buy'"
                      [class.sell]="sig.direction === 'Sell'"
                    >
                      {{ sig.direction === 'Buy' ? '↑' : '↓' }} {{ sig.direction }}
                    </span>
                    <span class="signal-confidence">{{ (sig.confidence * 100).toFixed(0) }}%</span>
                  </div>
                  <div class="signal-actions">
                    <button
                      type="button"
                      class="action-btn approve"
                      (click)="approveSignal(sig.id)"
                      [attr.aria-label]="'Approve signal ' + sig.symbol + ' ' + sig.direction"
                      title="Approve"
                    >
                      <span aria-hidden="true">✓</span>
                    </button>
                    <button
                      type="button"
                      class="action-btn reject"
                      (click)="rejectSignal(sig.id)"
                      [attr.aria-label]="'Reject signal ' + sig.symbol + ' ' + sig.direction"
                      title="Reject"
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  </div>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No pending signals</div>
          }
        </section>
      </div>

      <div class="status-grid">
        <section class="status-card">
          <h4>Engine</h4>
          @if (healthStatus()) {
            <p class="pill healthy">Running</p>
          } @else {
            <p class="pill down">Stopped</p>
          }
        </section>
        <section class="status-card">
          <h4>Drawdown</h4>
          @if (drawdown(); as d) {
            <p class="mono">{{ d.drawdownPct.toFixed(2) }}%</p>
            <span class="muted">{{ d.recoveryMode }}</span>
          } @else {
            <p class="muted">—</p>
          }
        </section>
        <section class="status-card">
          <h4>Account</h4>
          @if (account(); as a) {
            <p class="mono">{{ a.accountName ?? a.accountId }}</p>
            <span class="muted">{{ a.currency ?? '' }}</span>
          } @else {
            <p class="muted">—</p>
          }
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      .dashboard {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .hero-strip {
        position: relative;
        padding: var(--space-5);
        background: var(--bg-glass);
        backdrop-filter: var(--blur-md);
        -webkit-backdrop-filter: var(--blur-md);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .hero-strip::before {
        content: '';
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 0% 0%, rgba(10, 132, 255, 0.08), transparent 40%),
          radial-gradient(circle at 100% 100%, rgba(52, 199, 89, 0.06), transparent 40%);
        pointer-events: none;
      }
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .hero-strip {
          background: var(--bg-secondary);
        }
      }
      .metrics-row {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: var(--space-4);
        position: relative;
        z-index: 1;
      }
      .charts-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
      }
      .panel,
      .status-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .link {
        color: var(--accent);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .link:hover {
        text-decoration: underline;
      }
      .signal-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 300px;
        overflow-y: auto;
      }
      .signal-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        gap: var(--space-3);
      }
      .signal-item:last-child {
        border-bottom: none;
      }
      .signal-item:hover {
        background: var(--bg-tertiary);
      }
      .signal-main {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex: 1;
      }
      .signal-symbol {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .signal-direction {
        font-weight: var(--font-semibold);
        font-size: var(--text-xs);
      }
      .signal-direction.buy {
        color: var(--profit);
      }
      .signal-direction.sell {
        color: var(--loss);
      }
      .signal-confidence {
        margin-left: auto;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .signal-actions {
        display: flex;
        gap: var(--space-1);
      }
      .action-btn {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-full);
        border: none;
        cursor: pointer;
        font-weight: var(--font-semibold);
        font-size: 14px;
      }
      .action-btn.approve {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .action-btn.approve:hover {
        background: rgba(52, 199, 89, 0.25);
      }
      .action-btn.reject {
        background: rgba(255, 59, 48, 0.15);
        color: #d70015;
      }
      .action-btn.reject:hover {
        background: rgba(255, 59, 48, 0.25);
      }
      .empty-panel {
        padding: var(--space-8) var(--space-5);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      .status-card {
        padding: var(--space-4) var(--space-5);
      }
      .status-card h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .status-card p {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .status-card .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .pill.healthy {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill.down {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      @media (max-width: 1200px) {
        .metrics-row {
          grid-template-columns: repeat(3, 1fr);
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
        .status-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 768px) {
        .metrics-row {
          grid-template-columns: repeat(2, 1fr);
        }
      }
    `,
  ],
})
export class DashboardPageComponent implements OnInit {
  private readonly positionsService = inject(PositionsService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly signalsService = inject(TradeSignalsService);
  private readonly healthService = inject(HealthService);
  private readonly drawdownService = inject(DrawdownRecoveryService);
  private readonly accountsService = inject(TradingAccountsService);
  private readonly ensembleService = inject(StrategyEnsembleService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);

  constructor() {
    // The dashboard aggregates six different resources — throttle aggressively
    // (3s) so a flurry of fills + position flips doesn't trigger six refreshes
    // in two seconds. VaR breaches and emergency-flatten are rare but deserve
    // an immediate pull because they change every tile on the page at once.
    merge(
      this.realtime.on('orderFilled'),
      this.realtime.on('positionOpened'),
      this.realtime.on('positionClosed'),
      this.realtime.on('vaRBreach'),
      this.realtime.on('emergencyFlatten'),
    )
      .pipe(throttleTime(3_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.refresh());
  }

  readonly loading = signal(true);
  readonly equity = signal<number | null>(null);
  readonly unrealizedPnl = signal<number | null>(null);
  readonly openPositionCount = signal<number | null>(null);
  readonly activeStrategyCount = signal<number | null>(null);
  readonly pendingSignalCount = signal<number | null>(null);
  readonly pendingSignals = signal<TradeSignalDto[]>([]);
  readonly healthStatus = signal(false);
  readonly drawdown = signal<DrawdownSnapshotDto | null>(null);
  readonly account = signal<TradingAccountDto | null>(null);
  readonly closedPositions = signal<PositionDto[]>([]);
  readonly openPositions = signal<PositionDto[]>([]);
  readonly allocations = signal<StrategyAllocationDto[]>([]);

  readonly dailyPnlChart = computed<EChartsOption>(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return emptyChart('No closed positions yet');
    const buckets = new Map<string, number>();
    const now = new Date();
    const cutoff = now.getTime() - 30 * 24 * 3600_000;
    for (const p of closed) {
      if (!p.closedAt) continue;
      const ts = new Date(p.closedAt).getTime();
      if (ts < cutoff) continue;
      const key = p.closedAt.slice(0, 10);
      buckets.set(key, (buckets.get(key) ?? 0) + p.realizedPnL);
    }
    const dates = Array.from(buckets.keys()).sort();
    const values = dates.map((d) => +(buckets.get(d) ?? 0).toFixed(2));
    return {
      grid: { top: 20, right: 20, bottom: 30, left: 60 },
      xAxis: { type: 'category', data: dates.map((d) => d.slice(5)), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value' },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'bar',
          data: values.map((v) => ({
            value: v,
            itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4, 4, 0, 0] },
          })),
        },
      ],
    };
  });

  readonly exposureChart = computed<EChartsOption>(() => {
    const open = this.openPositions();
    if (open.length === 0) return emptyChart('No open positions');
    const byBreakdown = new Map<string, number>();
    for (const p of open) {
      if (!p.symbol) continue;
      byBreakdown.set(p.symbol, (byBreakdown.get(p.symbol) ?? 0) + p.openLots);
    }
    const sorted = Array.from(byBreakdown.entries()).sort((a, b) => b[1] - a[1]);
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 80 },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: sorted.map(([s]) => s) },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'bar',
          data: sorted.map(([, lots]) => +lots.toFixed(2)),
          itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
          barWidth: 18,
        },
      ],
    };
  });

  readonly allocationChart = computed<EChartsOption>(() => {
    const allocs = this.allocations();
    if (allocs.length === 0) return emptyChart('No active allocations');
    const data = allocs
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((a, i) => ({
        name: a.strategyName ?? `#${a.strategyId}`,
        value: +(a.weight * 100).toFixed(2),
        itemStyle: { color: PALETTE[i % PALETTE.length] },
      }));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          label: { fontSize: 11, color: '#6E6E73' },
          data,
        },
      ],
    };
  });

  ngOnInit(): void {
    this.refresh();
  }

  private readonly _poll = createPolledResource(
    () =>
      of(null).pipe(
        map(() => {
          this.refresh();
          return null;
        }),
      ),
    { intervalMs: 15_000, runImmediately: false },
  );

  private refresh(): void {
    this.positionsService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as PositionDto[])),
      )
      .subscribe((positions) => {
        const open = positions.filter((p) => p.status === 'Open' || p.status === 'Closing');
        const closed = positions.filter((p) => p.status === 'Closed');
        this.openPositions.set(open);
        this.closedPositions.set(closed);
        this.openPositionCount.set(open.length);
        this.unrealizedPnl.set(open.reduce((s, p) => s + p.unrealizedPnL, 0));
        this.loading.set(false);
      });

    this.strategiesService
      .list({ currentPage: 1, itemCountPerPage: 200 })
      .pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as StrategyDto[])),
      )
      .subscribe((strategies) => {
        this.activeStrategyCount.set(strategies.filter((s) => s.status === 'Active').length);
      });

    this.signalsService
      .list({ currentPage: 1, itemCountPerPage: 100 })
      .pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as TradeSignalDto[])),
      )
      .subscribe((signals) => {
        const pending = signals.filter((s) => s.status === 'Pending');
        this.pendingSignalCount.set(pending.length);
        this.pendingSignals.set(pending.slice(0, 8));
      });

    this.healthService
      .getStatus()
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as EngineStatusDto | null)),
      )
      .subscribe((status) => {
        this.healthStatus.set(status?.isRunning ?? false);
      });

    this.drawdownService
      .getLatest()
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as DrawdownSnapshotDto | null)),
      )
      .subscribe((d) => this.drawdown.set(d));

    this.accountsService
      .getCurrentActive()
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as TradingAccountDto | null)),
      )
      .subscribe((a) => {
        this.account.set(a);
        if (a) this.equity.set(a.equity);
      });

    this.ensembleService
      .getAllocations()
      .pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as StrategyAllocationDto[])),
      )
      .subscribe((allocs) => this.allocations.set(allocs));
  }

  approveSignal(id: number): void {
    this.signalsService.approve(id).subscribe({
      next: () => {
        this.notifications.success('Signal approved');
        this.refresh();
      },
      error: () => this.notifications.error('Failed to approve signal'),
    });
  }

  rejectSignal(id: number): void {
    this.signalsService.reject(id, { reason: 'Rejected from dashboard' }).subscribe({
      next: () => {
        this.notifications.warning('Signal rejected');
        this.refresh();
      },
      error: () => this.notifications.error('Failed to reject signal'),
    });
  }
}

function emptyChart(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'center',
      textStyle: { color: '#8E8E93', fontSize: 13, fontWeight: 'normal' as const },
    },
  };
}
