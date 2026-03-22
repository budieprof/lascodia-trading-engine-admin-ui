import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import type { EChartsOption } from 'echarts';

interface SymbolSentiment {
  symbol: string;
  regime: string;
  regimeType: 'strategy' | 'default';
  direction: 'Bullish' | 'Bearish' | 'Neutral';
  score: number;
}

@Component({
  selector: 'app-sentiment-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, PageHeaderComponent, StatusBadgeComponent, TabsComponent],
  template: `
    <div class="page">
      <app-page-header title="Sentiment" subtitle="Market regime detection and sentiment analysis" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          <div class="symbol-grid">
            @for (item of symbols; track item.symbol) {
              <div class="symbol-card">
                <div class="symbol-header">
                  <span class="symbol-name">{{ item.symbol }}</span>
                  <app-status-badge [status]="item.regime" [type]="item.regimeType" />
                </div>
                <div class="sentiment-row">
                  <span class="direction-arrow" [class.bullish]="item.direction === 'Bullish'" [class.bearish]="item.direction === 'Bearish'">
                    {{ item.direction === 'Bullish' ? '\u2191' : item.direction === 'Bearish' ? '\u2193' : '\u2194' }}
                  </span>
                  <span class="direction-label">{{ item.direction }}</span>
                  <span class="score">{{ item.score }}/100</span>
                </div>
              </div>
            }
          </div>

          <div class="charts-grid single">
            <app-chart-card
              title="Global Sentiment Radar"
              subtitle="Multi-factor sentiment scores"
              [options]="radarOptions"
              height="400px"
            />
          </div>
        }

        @if (activeTab() === 'regime') {
          <div class="charts-grid">
            <app-chart-card
              title="ADX + Volatility Time Series"
              subtitle="Trend strength and volatility over time"
              [options]="adxVolOptions"
              height="360px"
            />
            <app-chart-card
              title="Regime Distribution"
              subtitle="Time spent in each market regime"
              [options]="regimeDonutOptions"
              height="360px"
            />
          </div>
          <div class="charts-grid single">
            <app-chart-card
              title="Regime History Timeline"
              subtitle="Detected regime transitions over time"
              [options]="regimeTimelineOptions"
              height="180px"
            />
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .symbol-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }
    .symbol-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--card-padding);
      box-shadow: var(--shadow-sm);
    }
    .symbol-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-3);
    }
    .symbol-name {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
    }
    .sentiment-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .direction-arrow {
      font-size: 20px;
      font-weight: var(--font-semibold);
      color: var(--text-secondary);
    }
    .direction-arrow.bullish { color: #34C759; }
    .direction-arrow.bearish { color: #FF3B30; }
    .direction-label {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      font-weight: var(--font-medium);
    }
    .score {
      margin-left: auto;
      font-size: var(--text-sm);
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
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
export class SentimentPageComponent {
  tabs: TabItem[] = [
    { label: 'Market Overview', value: 'overview' },
    { label: 'Regime Analysis', value: 'regime' },
  ];
  activeTab = signal('overview');

  symbols: SymbolSentiment[] = [
    { symbol: 'EUR/USD', regime: 'Active', regimeType: 'strategy', direction: 'Bullish', score: 72 },
    { symbol: 'GBP/USD', regime: 'Active', regimeType: 'strategy', direction: 'Bearish', score: 38 },
    { symbol: 'USD/JPY', regime: 'Paused', regimeType: 'strategy', direction: 'Bullish', score: 65 },
    { symbol: 'AUD/USD', regime: 'Active', regimeType: 'strategy', direction: 'Neutral', score: 51 },
  ];

  radarOptions: EChartsOption = {
    tooltip: {},
    radar: {
      indicator: [
        { name: 'Trend Strength', max: 100 },
        { name: 'Momentum', max: 100 },
        { name: 'Volume', max: 100 },
        { name: 'Volatility', max: 100 },
        { name: 'Order Flow', max: 100 },
        { name: 'Correlation', max: 100 },
      ],
      shape: 'polygon',
      splitArea: { areaStyle: { color: ['rgba(0,113,227,0.02)', 'rgba(0,113,227,0.04)'] } },
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      splitLine: { lineStyle: { color: '#E5E5EA' } },
    },
    series: [{
      type: 'radar',
      data: [
        {
          value: [78, 64, 55, 42, 71, 60],
          name: 'Current',
          areaStyle: { color: 'rgba(0, 113, 227, 0.15)' },
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
        {
          value: [65, 72, 48, 58, 54, 68],
          name: 'Previous Week',
          areaStyle: { color: 'rgba(142, 142, 147, 0.1)' },
          lineStyle: { color: '#8E8E93', type: 'dashed', width: 1 },
          itemStyle: { color: '#8E8E93' },
        },
      ],
    }],
    legend: { data: ['Current', 'Previous Week'], bottom: 0 },
  };

  adxVolOptions: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['ADX', 'Volatility (ATR)'], bottom: 0 },
    grid: { left: 50, right: 50, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: Array.from({ length: 30 }, (_, i) => {
        const d = new Date(2026, 2, 21);
        d.setDate(d.getDate() - 29 + i);
        return `${d.getMonth() + 1}/${d.getDate()}`;
      }),
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93', fontSize: 10 },
    },
    yAxis: [
      {
        type: 'value', name: 'ADX', position: 'left',
        axisLabel: { color: '#0071E3' },
        splitLine: { lineStyle: { color: '#F2F2F7' } },
      },
      {
        type: 'value', name: 'ATR', position: 'right',
        axisLabel: { color: '#FF9500' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'ADX', type: 'line', yAxisIndex: 0, smooth: true,
        data: [22, 25, 28, 32, 35, 38, 42, 40, 36, 33, 30, 27, 24, 22, 20, 18, 21, 26, 31, 36, 40, 44, 48, 45, 41, 38, 34, 30, 28, 32],
        lineStyle: { width: 2, color: '#0071E3' },
        itemStyle: { color: '#0071E3' },
      },
      {
        name: 'Volatility (ATR)', type: 'line', yAxisIndex: 1, smooth: true,
        data: [0.0062, 0.0058, 0.0065, 0.0072, 0.0078, 0.0085, 0.0092, 0.0088, 0.0081, 0.0074, 0.0068, 0.0061, 0.0055, 0.0052, 0.0048, 0.0045, 0.0051, 0.0059, 0.0068, 0.0076, 0.0084, 0.0091, 0.0098, 0.0094, 0.0087, 0.0080, 0.0073, 0.0066, 0.0060, 0.0068],
        lineStyle: { width: 2, color: '#FF9500' },
        itemStyle: { color: '#FF9500' },
      },
    ],
  };

  regimeDonutOptions: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: { bottom: 0, data: ['Trending', 'Ranging', 'High Volatility'] },
    series: [{
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { show: true, formatter: '{b}\n{d}%', fontSize: 12 },
      data: [
        { value: 42, name: 'Trending', itemStyle: { color: '#0071E3' } },
        { value: 35, name: 'Ranging', itemStyle: { color: '#34C759' } },
        { value: 23, name: 'High Volatility', itemStyle: { color: '#FF9500' } },
      ],
    }],
  };

  regimeTimelineOptions: EChartsOption = {
    tooltip: {
      formatter: (params: any) => `${params.name}: ${params.value[1]} - ${params.value[2]}`,
    },
    grid: { left: 80, right: 20, top: 10, bottom: 30 },
    xAxis: {
      type: 'category',
      data: ['Feb 20', 'Feb 24', 'Feb 28', 'Mar 4', 'Mar 8', 'Mar 12', 'Mar 16', 'Mar 20'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'category',
      data: ['EUR/USD'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    series: [
      {
        type: 'bar',
        stack: 'timeline',
        data: [3, 0, 0, 0, 0, 0, 0, 0],
        itemStyle: { color: '#0071E3' },
        name: 'Trending',
        barWidth: '80%',
      },
      {
        type: 'bar',
        stack: 'timeline',
        data: [0, 2, 2, 0, 0, 0, 0, 0],
        itemStyle: { color: '#34C759' },
        name: 'Ranging',
        barWidth: '80%',
      },
      {
        type: 'bar',
        stack: 'timeline',
        data: [0, 0, 0, 1, 2, 0, 0, 0],
        itemStyle: { color: '#FF9500' },
        name: 'High Volatility',
        barWidth: '80%',
      },
      {
        type: 'bar',
        stack: 'timeline',
        data: [0, 0, 0, 0, 0, 3, 2, 1],
        itemStyle: { color: '#0071E3' },
        name: 'Trending',
        barWidth: '80%',
      },
    ],
    legend: { data: ['Trending', 'Ranging', 'High Volatility'], bottom: 0 },
  };
}
