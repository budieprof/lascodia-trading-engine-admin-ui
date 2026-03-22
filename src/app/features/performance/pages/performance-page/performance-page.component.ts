import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-performance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MetricCardComponent, ChartCardComponent, PageHeaderComponent, TabsComponent],
  template: `
    <div class="page">
      <app-page-header title="Performance" subtitle="Strategy performance analytics and attribution" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          <div class="metrics-row">
            <app-metric-card label="Total P&L" [value]="45230" format="currency" [colorByValue]="true" [delta]="3420" />
            <app-metric-card label="Win Rate" [value]="62.4" format="percent" dotColor="#34C759" [delta]="1.2" />
            <app-metric-card label="Profit Factor" [value]="1.84" format="number" dotColor="#0071E3" />
            <app-metric-card label="Sharpe Ratio" [value]="1.52" format="number" dotColor="#5AC8FA" />
            <app-metric-card label="Max Drawdown" [value]="8.3" format="percent" dotColor="#FF3B30" />
            <app-metric-card label="Total Trades" [value]="847" format="number" dotColor="#8E8E93" />
          </div>

          <div class="charts-grid">
            <app-chart-card
              title="Cumulative P&L by Strategy"
              subtitle="Running total profit/loss per strategy"
              [options]="cumulativePnlOptions"
              height="360px"
            />
            <app-chart-card
              title="Monthly Returns Heatmap"
              subtitle="Return % by month and year"
              [options]="heatmapOptions"
              height="360px"
            />
          </div>
          <div class="charts-grid single">
            <app-chart-card
              title="P&L Waterfall"
              subtitle="Strategy contributions to total P&L"
              [options]="waterfallOptions"
              height="320px"
            />
          </div>
        }

        @if (activeTab() === 'session') {
          <div class="charts-grid">
            <app-chart-card
              title="P&L by Session"
              subtitle="Profit/loss across trading sessions"
              [options]="sessionPnlOptions"
              height="360px"
            />
            <app-chart-card
              title="Win Rate by Session"
              subtitle="Success rate per session window"
              [options]="sessionWinRateOptions"
              height="360px"
            />
          </div>
        }

        @if (activeTab() === 'regime') {
          <div class="charts-grid">
            <app-chart-card
              title="P&L by Market Regime"
              subtitle="Profit/loss segmented by detected regime"
              [options]="regimePnlOptions"
              height="360px"
            />
            <app-chart-card
              title="Strategy Performance by Regime"
              subtitle="Per-strategy returns in each regime"
              [options]="strategyRegimeOptions"
              height="360px"
            />
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .metrics-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-4);
    }
    .charts-grid.single {
      grid-template-columns: 1fr;
    }
  `],
})
export class PerformancePageComponent {
  tabs: TabItem[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Session Analysis', value: 'session' },
    { label: 'Regime Analysis', value: 'regime' },
  ];
  activeTab = signal('overview');

  cumulativePnlOptions: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Momentum Alpha', 'Mean Reversion', 'Breakout Pro'], bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: '${value}' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      {
        name: 'Momentum Alpha',
        type: 'line',
        smooth: true,
        data: [1200, 3400, 5100, 7800, 9200, 11400, 14200, 16800, 18500, 20100, 22400, 24800],
        lineStyle: { width: 2 },
        itemStyle: { color: '#0071E3' },
      },
      {
        name: 'Mean Reversion',
        type: 'line',
        smooth: true,
        data: [800, 1600, 2900, 3200, 4800, 6100, 7400, 8200, 9800, 11200, 12600, 13100],
        lineStyle: { width: 2 },
        itemStyle: { color: '#34C759' },
      },
      {
        name: 'Breakout Pro',
        type: 'line',
        smooth: true,
        data: [500, 900, 1800, 2400, 2100, 3200, 4100, 4900, 5600, 6200, 6800, 7330],
        lineStyle: { width: 2 },
        itemStyle: { color: '#FF9500' },
      },
    ],
  };

  heatmapOptions: EChartsOption = {
    tooltip: {
      formatter: (params: any) => `${params.data[1]} ${params.data[0]}: ${params.data[2]}%`,
    },
    grid: { left: 60, right: 40, top: 10, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['2024', '2025', '2026'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'category',
      data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    visualMap: {
      min: -8,
      max: 12,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      inRange: {
        color: ['#FF3B30', '#FF6961', '#FFCCCB', '#F2F2F7', '#B7E4C7', '#52B788', '#2D6A4F'],
      },
    },
    series: [{
      type: 'heatmap',
      data: [
        ['2024', 'Jan', 3.2], ['2024', 'Feb', -1.4], ['2024', 'Mar', 5.1],
        ['2024', 'Apr', 2.8], ['2024', 'May', -0.6], ['2024', 'Jun', 4.3],
        ['2024', 'Jul', 6.2], ['2024', 'Aug', -2.1], ['2024', 'Sep', 3.7],
        ['2024', 'Oct', 1.9], ['2024', 'Nov', 7.4], ['2024', 'Dec', -0.3],
        ['2025', 'Jan', 4.1], ['2025', 'Feb', 2.6], ['2025', 'Mar', -3.2],
        ['2025', 'Apr', 5.8], ['2025', 'May', 1.2], ['2025', 'Jun', 3.9],
        ['2025', 'Jul', -1.8], ['2025', 'Aug', 6.4], ['2025', 'Sep', 2.1],
        ['2025', 'Oct', 4.7], ['2025', 'Nov', -0.9], ['2025', 'Dec', 8.3],
        ['2026', 'Jan', 5.6], ['2026', 'Feb', 3.4], ['2026', 'Mar', 2.1],
      ],
      label: {
        show: true,
        formatter: (params: any) => `${params.data[2]}%`,
        fontSize: 10,
      },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.2)' } },
    }],
  };

  waterfallOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 80, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['Momentum Alpha', 'Mean Reversion', 'Breakout Pro', 'Fees & Slippage', 'Total'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: '${value}' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      {
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { borderColor: 'transparent', color: 'transparent' },
        emphasis: { itemStyle: { borderColor: 'transparent', color: 'transparent' } },
        data: [0, 24800, 37900, 45230, 0],
      },
      {
        type: 'bar',
        stack: 'waterfall',
        data: [
          { value: 24800, itemStyle: { color: '#0071E3' } },
          { value: 13100, itemStyle: { color: '#34C759' } },
          { value: 7330, itemStyle: { color: '#FF9500' } },
          { value: -2230, itemStyle: { color: '#FF3B30' } },
          { value: 45230, itemStyle: { color: '#5856D6' } },
        ],
        label: {
          show: true,
          position: 'top',
          formatter: (params: any) => {
            const v = params.value;
            return v >= 0 ? `$${(v / 1000).toFixed(1)}k` : `-$${(Math.abs(v) / 1000).toFixed(1)}k`;
          },
          color: '#1D1D1F',
          fontSize: 11,
        },
      },
    ],
  };

  sessionPnlOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['Gross Profit', 'Gross Loss', 'Net P&L'], bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['London', 'New York', 'Asian', 'London/NY Overlap'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: '${value}' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      {
        name: 'Gross Profit',
        type: 'bar',
        data: [18200, 22400, 8600, 14800],
        itemStyle: { color: '#34C759' },
      },
      {
        name: 'Gross Loss',
        type: 'bar',
        data: [-12100, -14800, -7200, -8300],
        itemStyle: { color: '#FF3B30' },
      },
      {
        name: 'Net P&L',
        type: 'bar',
        data: [6100, 7600, 1400, 6500],
        itemStyle: { color: '#0071E3' },
      },
    ],
  };

  sessionWinRateOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 130, right: 40, top: 10, bottom: 20 },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: '#8E8E93', formatter: '{value}%' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    yAxis: {
      type: 'category',
      data: ['Asian', 'London', 'London/NY Overlap', 'New York'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    series: [{
      type: 'bar',
      data: [
        { value: 54.2, itemStyle: { color: '#FF9500' } },
        { value: 63.8, itemStyle: { color: '#0071E3' } },
        { value: 68.1, itemStyle: { color: '#34C759' } },
        { value: 65.4, itemStyle: { color: '#5AC8FA' } },
      ],
      barWidth: 20,
      label: { show: true, position: 'right', formatter: '{c}%', color: '#1D1D1F', fontSize: 12 },
    }],
  };

  regimePnlOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['Trending', 'Ranging', 'High Volatility'], bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['Q1 2025', 'Q2 2025', 'Q3 2025', 'Q4 2025', 'Q1 2026'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: '${value}' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      { name: 'Trending', type: 'bar', stack: 'regime', data: [4200, 6800, 3100, 7200, 5400], itemStyle: { color: '#0071E3' } },
      { name: 'Ranging', type: 'bar', stack: 'regime', data: [1800, 2400, 3600, 1200, 2800], itemStyle: { color: '#34C759' } },
      { name: 'High Volatility', type: 'bar', stack: 'regime', data: [3100, -1200, 4800, 2100, 1600], itemStyle: { color: '#FF9500' } },
    ],
  };

  strategyRegimeOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['Momentum Alpha', 'Mean Reversion', 'Breakout Pro'], bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['Trending', 'Ranging', 'High Volatility'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: '${value}' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      { name: 'Momentum Alpha', type: 'bar', data: [12400, 3200, 9200], itemStyle: { color: '#0071E3' } },
      { name: 'Mean Reversion', type: 'bar', data: [2800, 7600, 2700], itemStyle: { color: '#34C759' } },
      { name: 'Breakout Pro', type: 'bar', data: [5100, 1200, 1030], itemStyle: { color: '#FF9500' } },
    ],
  };
}
