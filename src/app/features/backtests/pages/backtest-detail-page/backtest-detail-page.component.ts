import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DatePipe } from '@angular/common';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { BacktestsService } from '@core/services/backtests.service';
import { BacktestRunDto } from '@core/api/api.types';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-backtest-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, MetricCardComponent, ChartCardComponent, StatusBadgeComponent, DatePipe],
  template: `
    <div class="page">
      <app-page-header [title]="'Backtest #' + (backtest()?.id ?? '')" subtitle="Historical simulation results">
        <app-status-badge [status]="backtest()?.status ?? 'Queued'" type="run" />
      </app-page-header>

      @if (backtest(); as bt) {
        <!-- KPI Cards -->
        <div class="metrics-row">
          <app-metric-card label="Win Rate" [value]="resultMetrics().winRate" format="percent" dotColor="#34C759" />
          <app-metric-card label="Profit Factor" [value]="resultMetrics().profitFactor" format="number" dotColor="#0071E3" />
          <app-metric-card label="Sharpe Ratio" [value]="resultMetrics().sharpe" format="number" dotColor="#AF52DE" />
          <app-metric-card label="Max Drawdown" [value]="resultMetrics().maxDrawdown" format="percent" dotColor="#FF3B30" />
          <app-metric-card label="Total Trades" [value]="resultMetrics().totalTrades" format="number" dotColor="#5AC8FA" />
          <app-metric-card label="Avg Trade P&L" [value]="resultMetrics().avgPnL" format="currency" [colorByValue]="true" />
        </div>

        <!-- Charts -->
        <div class="charts-grid">
          <app-chart-card title="Equity Curve" subtitle="Cumulative P&L over backtest period" [options]="equityCurveOptions" height="320px" />
          <app-chart-card title="Drawdown" subtitle="Peak-to-trough drawdown" [options]="drawdownOptions" height="320px" />
        </div>
        <div class="charts-grid">
          <app-chart-card title="Trade P&L Distribution" subtitle="Distribution of individual trade results" [options]="pnlDistOptions" height="280px" />
          <app-chart-card title="Monthly Returns" subtitle="P&L by month" [options]="monthlyOptions" height="280px" />
        </div>
        <div class="charts-grid">
          <app-chart-card title="Win/Loss Streaks" subtitle="Consecutive outcomes" [options]="streakOptions" height="250px" />
          <app-chart-card title="P&L by Day of Week" subtitle="Average performance per day" [options]="dowOptions" height="250px" />
        </div>

        <!-- Info Card -->
        <div class="info-card">
          <div class="info-grid">
            <div class="info-item"><span class="info-label">Strategy</span><span class="info-value">{{ bt.strategyId }}</span></div>
            <div class="info-item"><span class="info-label">Symbol</span><span class="info-value">{{ bt.symbol }}</span></div>
            <div class="info-item"><span class="info-label">Timeframe</span><span class="info-value">{{ bt.timeframe }}</span></div>
            <div class="info-item"><span class="info-label">Initial Balance</span><span class="info-value">\${{ bt.initialBalance.toLocaleString() }}</span></div>
            <div class="info-item"><span class="info-label">Period</span><span class="info-value">{{ bt.fromDate | date:'mediumDate' }} — {{ bt.toDate | date:'mediumDate' }}</span></div>
            <div class="info-item"><span class="info-label">Started</span><span class="info-value">{{ bt.startedAt | date:'medium' }}</span></div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .metrics-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--space-4); margin-bottom: var(--space-6); }
    .charts-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-4); margin-bottom: var(--space-4); }
    .info-card {
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: var(--radius-md); padding: var(--card-padding);
    }
    .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); }
    .info-item { display: flex; flex-direction: column; gap: 2px; }
    .info-label { font-size: var(--text-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
    .info-value { font-size: var(--text-sm); color: var(--text-primary); font-weight: var(--font-medium); }
    @media (max-width: 1200px) { .metrics-row { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 768px) { .metrics-row { grid-template-columns: repeat(2, 1fr); } .charts-grid { grid-template-columns: 1fr; } }
  `],
})
export class BacktestDetailPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private backtestsService = inject(BacktestsService);
  backtest = signal<BacktestRunDto | null>(null);

  resultMetrics = signal({ winRate: 62.4, profitFactor: 1.84, sharpe: 1.52, maxDrawdown: 8.3, totalTrades: 342, avgPnL: 45.2 });

  // Sample chart data
  private days = Array.from({ length: 180 }, (_, i) => { const d = new Date(2025, 0, 1); d.setDate(d.getDate() + i); return `${d.getMonth()+1}/${d.getDate()}`; });
  private equityData = (() => { let v = 10000; return this.days.map(() => { v += (Math.random() - 0.42) * 150; return Math.round(v); }); })();

  equityCurveOptions: EChartsOption = {
    grid: { top: 20, right: 20, bottom: 30, left: 70 },
    xAxis: { type: 'category', data: this.days, axisLabel: { fontSize: 10, color: '#6E6E73', interval: 29 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '${value}' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    tooltip: { trigger: 'axis' },
    series: [{ type: 'line', data: this.equityData, smooth: true, symbol: 'none', lineStyle: { color: '#0071E3', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(0,113,227,0.15)' }, { offset: 1, color: 'rgba(0,113,227,0)' }] } } }],
  };

  drawdownOptions: EChartsOption = {
    grid: { top: 20, right: 20, bottom: 30, left: 60 },
    xAxis: { type: 'category', data: this.days, axisLabel: { fontSize: 10, color: '#6E6E73', interval: 29 } },
    yAxis: { type: 'value', inverse: true, axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    tooltip: { trigger: 'axis' },
    series: [{ type: 'line', data: this.days.map(() => Math.random() * 8), smooth: true, symbol: 'none', lineStyle: { color: '#FF3B30', width: 1.5 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(255,59,48,0.2)' }, { offset: 1, color: 'rgba(255,59,48,0)' }] } } }],
  };

  pnlDistOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 30, left: 50 },
    xAxis: { type: 'category', data: ['-200','-150','-100','-50','0','50','100','150','200','250'], axisLabel: { fontSize: 11, color: '#6E6E73' } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    series: [{ type: 'bar', data: [5,12,25,38,15,42,35,22,10,3].map((v, i) => ({ value: v, itemStyle: { color: i < 4 ? '#FF3B30' : '#34C759', borderRadius: [4,4,0,0] } })) }],
  };

  monthlyOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 30, left: 50 },
    xAxis: { type: 'category', data: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], axisLabel: { fontSize: 11, color: '#6E6E73' } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '${value}' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    series: [{ type: 'bar', data: [320,-150,480,210,-80,560,390,-220,410,280,150,-90].map(v => ({ value: v, itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4,4,0,0] } })) }],
  };

  streakOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 30, left: 50 },
    xAxis: { type: 'category', data: Array.from({ length: 20 }, (_, i) => `${i+1}`), axisLabel: { fontSize: 11, color: '#6E6E73' } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    series: [{ type: 'bar', data: Array.from({ length: 20 }, () => { const v = Math.floor(Math.random() * 8) - 3; return { value: v, itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30' } }; }) }],
  };

  dowOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 30, left: 50 },
    xAxis: { type: 'category', data: ['Mon','Tue','Wed','Thu','Fri'], axisLabel: { fontSize: 11, color: '#6E6E73' } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '${value}' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
    series: [{ type: 'bar', data: [85,-32,124,67,-15].map(v => ({ value: v, itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4,4,0,0] } })), barWidth: 30 }],
  };

  ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (id) {
      this.backtestsService.getById(id).subscribe({
        next: (res) => {
          if (res.data) {
            this.backtest.set(res.data as BacktestRunDto);
            if ((res.data as any).resultJson) {
              try {
                const parsed = JSON.parse((res.data as any).resultJson);
                this.resultMetrics.set(parsed);
              } catch { /* use defaults */ }
            }
          }
        },
      });
    }
  }
}
