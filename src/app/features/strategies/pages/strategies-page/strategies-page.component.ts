import { Component, ChangeDetectionStrategy, inject, signal, ViewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { map, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import {
  StrategyDto,
  StrategyPerformanceSnapshotDto,
  PagerRequest,
  CreateStrategyRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { StrategyFormComponent } from '../../components/strategy-form/strategy-form.component';

@Component({
  selector: 'app-strategies-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    StrategyFormComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <ui-tabs [tabs]="pageTabs" [(activeTab)]="activeTab">
        <!-- Strategy List Tab -->
        @if (activeTab() === 'list') {
          <app-page-header title="Strategies" subtitle="Manage trading strategies">
            <button class="btn btn-primary" (click)="showCreateForm.set(true)">
              + Create Strategy
            </button>
          </app-page-header>

          <app-data-table
            [columnDefs]="columns"
            [fetchData]="fetchStrategies"
            (rowClick)="onRowClick($event)"
          />
        }

        <!-- Strategy Monitor Tab -->
        @if (activeTab() === 'monitor') {
          <app-page-header title="Strategy Monitor" subtitle="Real-time performance monitoring" />

          <div class="selector-bar">
            <label class="selector-label">Strategy</label>
            <select
              class="selector-input"
              [value]="selectedStrategyId()"
              (change)="onStrategySelect($event)"
            >
              <option value="">-- Select a strategy --</option>
              @for (s of strategiesList(); track s.id) {
                <option [value]="s.id">{{ s.name }} ({{ s.symbol }})</option>
              }
            </select>
          </div>

          @if (performance()) {
            <div class="kpi-grid">
              <app-metric-card
                label="Win Rate"
                [value]="performance()!.winRate"
                format="percent"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Profit Factor"
                [value]="performance()!.profitFactor"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Sharpe Ratio"
                [value]="performance()!.sharpeRatio"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Max Drawdown"
                [value]="performance()!.maxDrawdownPct"
                format="percent"
                dotColor="#FF3B30"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Total Trades"
                [value]="performance()!.windowTrades"
                format="number"
                dotColor="#FF9500"
              />
              <app-metric-card
                label="Total P&L"
                [value]="performance()!.totalPnL"
                format="currency"
                [colorByValue]="true"
                dotColor="#30D158"
              />
            </div>

            <div class="chart-grid">
              <app-chart-card
                title="Equity Curve"
                subtitle="Cumulative P&L over time"
                [options]="equityCurveOptions"
                height="320px"
              />
              <app-chart-card
                title="Win Rate Over Time"
                subtitle="Rolling 20-trade win rate"
                [options]="winRateOptions"
                height="320px"
              />
              <app-chart-card
                title="Profit Factor Trend"
                subtitle="Rolling profit factor with quality bands"
                [options]="profitFactorOptions"
                height="320px"
              />
              <app-chart-card
                title="Monthly Returns"
                subtitle="Return distribution by month"
                [options]="monthlyReturnsOptions"
                height="320px"
              />
            </div>
          } @else if (selectedStrategyId()) {
            <div class="empty-monitor">
              <p>Loading performance data...</p>
            </div>
          } @else {
            <div class="empty-monitor">
              <p>Select a strategy to view performance metrics</p>
            </div>
          }
        }
      </ui-tabs>

      <app-strategy-form
        [open]="showCreateForm()"
        [strategy]="null"
        (submitted)="onCreate($event)"
        (cancelled)="showCreateForm.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .btn:active {
        transform: scale(0.97);
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }

      .selector-bar {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-6);
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }

      .selector-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        white-space: nowrap;
      }

      .selector-input {
        flex: 1;
        max-width: 400px;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }

      .chart-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }

      .empty-monitor {
        text-align: center;
        padding: var(--space-16);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }

      @media (max-width: 900px) {
        .chart-grid {
          grid-template-columns: 1fr;
        }
        .kpi-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
    `,
  ],
})
export class StrategiesPageComponent {
  private readonly strategiesService = inject(StrategiesService);
  private readonly feedbackService = inject(StrategyFeedbackService);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  private readonly enumLabel = new EnumLabelPipe();
  private readonly relativeTime = new RelativeTimePipe();

  @ViewChild(DataTableComponent) dataTable?: DataTableComponent<StrategyDto>;

  constructor() {
    this.realtime
      .on('strategyActivated')
      .pipe(throttleTime(2_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.dataTable?.loadData());
  }

  activeTab = signal('list');
  showCreateForm = signal(false);
  selectedStrategyId = signal<number | null>(null);
  strategiesList = signal<StrategyDto[]>([]);
  performance = signal<StrategyPerformanceSnapshotDto | null>(null);

  readonly pageTabs: TabItem[] = [
    { label: 'Strategy List', value: 'list' },
    { label: 'Strategy Monitor', value: 'monitor' },
  ];

  readonly columns: ColDef[] = [
    { field: 'name', headerName: 'Name', flex: 2, minWidth: 160 },
    { field: 'symbol', headerName: 'Symbol', flex: 1, minWidth: 100 },
    {
      field: 'timeframe',
      headerName: 'Timeframe',
      flex: 1,
      minWidth: 90,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value, 'timeframe'),
    },
    {
      field: 'strategyType',
      headerName: 'Type',
      flex: 1.5,
      minWidth: 140,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value),
    },
    {
      field: 'status',
      headerName: 'Status',
      flex: 1,
      minWidth: 100,
      cellRenderer: (p: any) => {
        const variant = this.getStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${variant.bg};color:${variant.color}">${p.value}</span>`;
      },
    },
    {
      field: 'riskProfileId',
      headerName: 'Risk Profile',
      flex: 1,
      minWidth: 100,
      valueFormatter: (p: any) => (p.value != null ? `#${p.value}` : '-'),
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      flex: 1.2,
      minWidth: 120,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly fetchStrategies = (params: PagerRequest) =>
    this.strategiesService.list(params).pipe(
      map((res) => {
        if (res.data) {
          this.strategiesList.set(res.data.data);
        }
        return res.data!;
      }),
    );

  onRowClick(strategy: StrategyDto): void {
    this.router.navigate(['/strategies', strategy.id]);
  }

  onStrategySelect(event: Event): void {
    const id = +(event.target as HTMLSelectElement).value;
    if (!id) {
      this.selectedStrategyId.set(null);
      this.performance.set(null);
      return;
    }
    this.selectedStrategyId.set(id);
    this.feedbackService.getPerformance(id).subscribe({
      next: (res) => {
        if (res.data) {
          this.performance.set(res.data);
        }
      },
      error: () => this.notifications.error('Failed to load performance data'),
    });
  }

  onCreate(data: any): void {
    this.strategiesService.create(data as CreateStrategyRequest).subscribe({
      next: () => {
        this.notifications.success('Strategy created successfully');
        this.showCreateForm.set(false);
        this.dataTable?.loadData();
      },
      error: () => this.notifications.error('Failed to create strategy'),
    });
  }

  private getStatusVariant(status: string): { bg: string; color: string } {
    const map: Record<string, { bg: string; color: string }> = {
      Active: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Paused: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Backtesting: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Stopped: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return map[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }

  // ---- Chart Options ----

  readonly equityCurveOptions: EChartsOption = (() => {
    const dates: string[] = [];
    const values: number[] = [];
    let cumulative = 0;
    const base = new Date('2025-01-02');
    for (let i = 0; i < 120; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
      cumulative += (Math.random() - 0.42) * 150;
      values.push(Math.round(cumulative * 100) / 100);
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 60, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { formatter: '${value}' } },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#0071E3', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0, 113, 227, 0.25)' },
                { offset: 1, color: 'rgba(0, 113, 227, 0.02)' },
              ],
            },
          },
        },
      ],
    } as EChartsOption;
  })();

  readonly winRateOptions: EChartsOption = (() => {
    const dates: string[] = [];
    const values: number[] = [];
    const base = new Date('2025-01-02');
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i * 2);
      dates.push(d.toISOString().slice(0, 10));
      values.push(Math.round((45 + Math.random() * 25) * 100) / 100);
    }
    return {
      tooltip: { trigger: 'axis', formatter: '{b}<br/>Win Rate: {c}%' },
      grid: { left: 50, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', min: 30, max: 80, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#34C759', width: 2 },
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 50,
                lineStyle: { color: '#FF9500', type: 'dashed' },
                label: { formatter: '50%' },
              },
            ],
          },
        },
      ],
    } as EChartsOption;
  })();

  readonly profitFactorOptions: EChartsOption = (() => {
    const dates: string[] = [];
    const values: number[] = [];
    const base = new Date('2025-01-02');
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i * 2);
      dates.push(d.toISOString().slice(0, 10));
      values.push(Math.round((0.8 + Math.random() * 1.4) * 100) / 100);
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', min: 0, max: 3, axisLabel: { formatter: '{value}' } },
      visualMap: {
        show: false,
        pieces: [
          { lt: 1.0, color: '#FF3B30' },
          { gte: 1.0, lt: 1.5, color: '#FF9500' },
          { gte: 1.5, color: '#34C759' },
        ],
      },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2 },
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 1.0,
                lineStyle: { color: '#FF3B30', type: 'dashed' },
                label: { formatter: '1.0' },
              },
              {
                yAxis: 1.5,
                lineStyle: { color: '#34C759', type: 'dashed' },
                label: { formatter: '1.5' },
              },
            ],
          },
          markArea: {
            silent: true,
            data: [
              [{ yAxis: 0, itemStyle: { color: 'rgba(255, 59, 48, 0.06)' } }, { yAxis: 1.0 }],
              [{ yAxis: 1.0, itemStyle: { color: 'rgba(255, 149, 0, 0.06)' } }, { yAxis: 1.5 }],
              [{ yAxis: 1.5, itemStyle: { color: 'rgba(52, 199, 89, 0.06)' } }, { yAxis: 3.0 }],
            ],
          },
        },
      ],
    } as EChartsOption;
  })();

  readonly monthlyReturnsOptions: EChartsOption = (() => {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const years = ['2024', '2025'];
    const data: [number, number, number][] = [];
    for (let yi = 0; yi < years.length; yi++) {
      for (let mi = 0; mi < 12; mi++) {
        const val = Math.round((Math.random() - 0.35) * 12 * 100) / 100;
        data.push([mi, yi, val]);
      }
    }
    return {
      tooltip: {
        formatter: (p: any) => {
          const d = p.data;
          return `${months[d[0]]} ${years[d[1]]}<br/>Return: ${d[2] >= 0 ? '+' : ''}${d[2]}%`;
        },
      },
      grid: { left: 60, right: 40, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: months, splitArea: { show: true } },
      yAxis: { type: 'category', data: years, splitArea: { show: true } },
      visualMap: {
        min: -10,
        max: 10,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: {
          color: ['#FF3B30', '#FF6961', '#FFD4D1', '#FFFFFF', '#D1F2D9', '#69D97A', '#34C759'],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: data,
          label: {
            show: true,
            formatter: (p: any) => {
              const v = p.data[2];
              return `${v >= 0 ? '+' : ''}${v}%`;
            },
            fontSize: 10,
          },
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.3)' },
          },
        },
      ],
    } as EChartsOption;
  })();
}
