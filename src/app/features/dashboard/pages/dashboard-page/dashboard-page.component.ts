import { Component, ChangeDetectionStrategy, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subject, forkJoin, timer, switchMap, takeUntil, catchError, of } from 'rxjs';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';
import { PositionsService } from '@core/services/positions.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { HealthService } from '@core/services/health.service';
import { BrokersService } from '@core/services/brokers.service';
import { DrawdownRecoveryService } from '@core/services/drawdown-recovery.service';
import { PaperTradingService } from '@core/services/paper-trading.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EChartsOption } from 'echarts';
import {
  TradeSignalDto, PositionDto, StrategyDto, BrokerDto,
  DrawdownSnapshotDto, HealthStatusDto,
} from '@core/api/api.types';

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MetricCardComponent, ChartCardComponent, StatusBadgeComponent,
    PageHeaderComponent,
  ],
  template: `
    <div class="dashboard">
      <app-page-header title="Dashboard" subtitle="Real-time trading engine overview" />

      <!-- Hero Metric Cards -->
      <div class="metrics-row">
        <app-metric-card
          label="Account Equity"
          [value]="equity()"
          format="currency"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Today's P&L"
          [value]="todayPnL()"
          format="currency"
          [colorByValue]="true"
          [delta]="todayPnLDelta()"
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

      <!-- Charts Row -->
      <div class="charts-grid">
        <app-chart-card
          title="Equity Curve"
          subtitle="Account balance over time"
          [options]="equityCurveOptions"
          height="320px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Daily P&L"
          subtitle="Profit/loss per day (last 30 days)"
          [options]="dailyPnLOptions"
          height="320px"
          [loading]="loading()"
        />
      </div>

      <div class="charts-grid">
        <app-chart-card
          title="Strategy Allocation"
          subtitle="Capital allocation by strategy"
          [options]="allocationOptions"
          height="300px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Position Exposure"
          subtitle="Open positions by symbol"
          [options]="exposureOptions"
          height="300px"
          [loading]="loading()"
        />
      </div>

      <!-- Activity Row -->
      <div class="activity-row">
        <!-- Pending Signals -->
        <div class="panel">
          <div class="panel-header">
            <h3>Pending Signals</h3>
            <span class="badge-count">{{ pendingSignals().length }}</span>
          </div>
          <div class="panel-body signal-list">
            @for (signal of pendingSignals(); track signal.id) {
              <div class="signal-item">
                <div class="signal-main">
                  <span class="signal-symbol">{{ signal.symbol }}</span>
                  <span class="signal-direction" [class.buy]="signal.direction === 'Buy'" [class.sell]="signal.direction === 'Sell'">
                    {{ signal.direction === 'Buy' ? '↑' : '↓' }} {{ signal.direction }}
                  </span>
                  <span class="signal-confidence">{{ (signal.confidence * 100).toFixed(0) }}%</span>
                </div>
                <div class="signal-actions">
                  <button class="action-btn approve" (click)="approveSignal(signal.id)">✓</button>
                  <button class="action-btn reject" (click)="rejectSignal(signal.id)">✕</button>
                </div>
              </div>
            }
            @if (pendingSignals().length === 0) {
              <div class="empty-panel">No pending signals</div>
            }
          </div>
        </div>

        <!-- Engine Status -->
        <div class="panel">
          <div class="panel-header">
            <h3>Engine Status</h3>
          </div>
          <div class="panel-body status-grid">
            <div class="status-item">
              <span class="status-label">System</span>
              <app-status-badge [status]="healthStatus() ? 'Connected' : 'Disconnected'" type="broker" />
            </div>
            <div class="status-item">
              <span class="status-label">Active Broker</span>
              <span class="status-value">{{ activeBroker()?.name || 'None' }}</span>
            </div>
            <div class="status-item">
              <span class="status-label">Drawdown</span>
              <span class="status-value" [class.warning]="(drawdown()?.drawdownPct ?? 0) > 5">
                {{ (drawdown()?.drawdownPct ?? 0).toFixed(2) }}%
              </span>
            </div>
            <div class="status-item">
              <span class="status-label">Recovery Mode</span>
              <app-status-badge [status]="drawdown()?.recoveryMode || 'Normal'" type="default" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .dashboard { padding: var(--space-2) 0; }

    .metrics-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }

    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-4);
    }

    .activity-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-4);
    }

    .panel {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--border);
    }

    .panel-header h3 {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0;
    }

    .badge-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 8px;
      border-radius: var(--radius-full);
      background: rgba(255, 149, 0, 0.12);
      color: #C93400;
      font-size: var(--text-xs);
      font-weight: var(--font-semibold);
    }

    .panel-body {
      max-height: 320px;
      overflow-y: auto;
    }

    .signal-list {
      padding: var(--space-2) 0;
    }

    .signal-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-5);
      transition: background 0.15s ease;
    }
    .signal-item:hover { background: var(--bg-tertiary); }

    .signal-main {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .signal-symbol {
      font-size: var(--text-sm);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      min-width: 80px;
    }

    .signal-direction {
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
    }
    .signal-direction.buy { color: var(--profit); }
    .signal-direction.sell { color: var(--loss); }

    .signal-confidence {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .signal-actions {
      display: flex;
      gap: var(--space-2);
    }

    .action-btn {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 50%;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .action-btn:active { transform: scale(0.9); }
    .action-btn.approve {
      background: rgba(52, 199, 89, 0.12);
      color: #248A3D;
    }
    .action-btn.approve:hover { background: rgba(52, 199, 89, 0.25); }
    .action-btn.reject {
      background: rgba(255, 59, 48, 0.12);
      color: #D70015;
    }
    .action-btn.reject:hover { background: rgba(255, 59, 48, 0.25); }

    .empty-panel {
      padding: var(--space-8);
      text-align: center;
      color: var(--text-tertiary);
      font-size: var(--text-sm);
    }

    .status-grid {
      padding: var(--space-4) var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .status-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .status-label {
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    .status-value {
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }
    .status-value.warning { color: var(--warning); }

    @media (max-width: 1200px) {
      .metrics-row { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 768px) {
      .metrics-row { grid-template-columns: repeat(2, 1fr); }
      .charts-grid, .activity-row { grid-template-columns: 1fr; }
    }
  `],
})
export class DashboardPageComponent implements OnInit, OnDestroy {
  private positionsService = inject(PositionsService);
  private strategiesService = inject(StrategiesService);
  private signalsService = inject(TradeSignalsService);
  private healthService = inject(HealthService);
  private brokersService = inject(BrokersService);
  private drawdownService = inject(DrawdownRecoveryService);
  private notifications = inject(NotificationService);
  private router = inject(Router);
  private destroy$ = new Subject<void>();

  loading = signal(true);
  equity = signal<number | null>(null);
  todayPnL = signal<number | null>(null);
  todayPnLDelta = signal<number | undefined>(undefined);
  openPositionCount = signal<number | null>(null);
  activeStrategyCount = signal<number | null>(null);
  pendingSignalCount = signal<number | null>(null);
  pendingSignals = signal<TradeSignalDto[]>([]);
  healthStatus = signal(false);
  activeBroker = signal<BrokerDto | null>(null);
  drawdown = signal<DrawdownSnapshotDto | null>(null);

  // Chart options with sample data
  equityCurveOptions: EChartsOption = {
    grid: { top: 20, right: 20, bottom: 30, left: 60 },
    xAxis: { type: 'category', data: this.generateDates(90), axisLabel: { fontSize: 11, color: '#6E6E73' }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '${value}' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    tooltip: { trigger: 'axis' },
    series: [{
      type: 'line', smooth: true, symbol: 'none',
      data: this.generateEquityCurve(90, 100000),
      lineStyle: { color: '#0071E3', width: 2 },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(0,113,227,0.15)' }, { offset: 1, color: 'rgba(0,113,227,0)' }] } },
    }],
  };

  dailyPnLOptions: EChartsOption = {
    grid: { top: 20, right: 20, bottom: 30, left: 60 },
    xAxis: { type: 'category', data: this.generateDates(30), axisLabel: { fontSize: 11, color: '#6E6E73' }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '${value}' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    tooltip: { trigger: 'axis' },
    series: [{
      type: 'bar',
      data: this.generateDailyPnL(30),
      itemStyle: { color: (params: any) => params.value >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4, 4, 0, 0] },
    }],
  };

  allocationOptions: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    series: [{
      type: 'pie', radius: ['45%', '70%'],
      label: { fontSize: 11, color: '#6E6E73' },
      data: [
        { value: 30, name: 'MA Crossover', itemStyle: { color: '#0071E3' } },
        { value: 25, name: 'RSI Reversion', itemStyle: { color: '#34C759' } },
        { value: 20, name: 'Breakout', itemStyle: { color: '#FF9500' } },
        { value: 15, name: 'MACD Div', itemStyle: { color: '#AF52DE' } },
        { value: 10, name: 'Momentum', itemStyle: { color: '#5AC8FA' } },
      ],
    }],
  };

  exposureOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 30, left: 80 },
    xAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    yAxis: { type: 'category', data: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'EUR/GBP'], axisLabel: { fontSize: 11, color: '#6E6E73' } },
    tooltip: { trigger: 'axis' },
    series: [{
      type: 'bar',
      data: [2.5, 1.8, 1.2, 0.8, 0.5],
      itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
      barWidth: 20,
    }],
  };

  ngOnInit() {
    this.loadData();
    // Poll every 15 seconds
    timer(15000, 15000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadData());
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadData() {
    const empty = { currentPage: 1, itemCountPerPage: 100 };

    forkJoin({
      positions: this.positionsService.list(empty).pipe(catchError(() => of(null))),
      strategies: this.strategiesService.list(empty).pipe(catchError(() => of(null))),
      signals: this.signalsService.list(empty).pipe(catchError(() => of(null))),
      health: this.healthService.getStatus().pipe(catchError(() => of(null))),
      broker: this.brokersService.getActive().pipe(catchError(() => of(null))),
      drawdown: this.drawdownService.getLatest().pipe(catchError(() => of(null))),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe((results) => {
        if (results.positions?.data) {
          const data = results.positions.data as any;
          const positions: PositionDto[] = data.data || [];
          const open = positions.filter((p: PositionDto) => p.status === 'Open');
          this.openPositionCount.set(open.length);
          const totalPnL = open.reduce((sum: number, p: PositionDto) => sum + p.unrealizedPnL, 0);
          this.todayPnL.set(totalPnL);
          this.equity.set(100000 + totalPnL);
        }

        if (results.strategies?.data) {
          const data = results.strategies.data as any;
          const strategies: StrategyDto[] = data.data || [];
          this.activeStrategyCount.set(strategies.filter((s: StrategyDto) => s.status === 'Active').length);
        }

        if (results.signals?.data) {
          const data = results.signals.data as any;
          const signals: TradeSignalDto[] = data.data || [];
          const pending = signals.filter((s: TradeSignalDto) => s.status === 'Pending');
          this.pendingSignalCount.set(pending.length);
          this.pendingSignals.set(pending.slice(0, 10));
        }

        if (results.health?.data) {
          const health = results.health.data as HealthStatusDto;
          this.healthStatus.set(health.isRunning);
        }

        if (results.broker?.data) {
          this.activeBroker.set(results.broker.data as BrokerDto);
        }

        if (results.drawdown?.data) {
          this.drawdown.set(results.drawdown.data as DrawdownSnapshotDto);
        }

        this.loading.set(false);
      });
  }

  approveSignal(id: number) {
    this.signalsService.approve(id).subscribe({
      next: () => {
        this.notifications.success('Signal approved');
        this.loadData();
      },
      error: () => this.notifications.error('Failed to approve signal'),
    });
  }

  rejectSignal(id: number) {
    this.signalsService.reject(id, { reason: 'Rejected from dashboard' }).subscribe({
      next: () => {
        this.notifications.warning('Signal rejected');
        this.loadData();
      },
      error: () => this.notifications.error('Failed to reject signal'),
    });
  }

  private generateDates(days: number): string[] {
    const dates: string[] = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    return dates;
  }

  private generateEquityCurve(days: number, start: number): number[] {
    const data: number[] = [];
    let val = start;
    for (let i = 0; i < days; i++) {
      val += (Math.random() - 0.45) * 500;
      data.push(Math.round(val));
    }
    return data;
  }

  private generateDailyPnL(days: number): number[] {
    return Array.from({ length: days }, () => Math.round((Math.random() - 0.45) * 2000));
  }
}
