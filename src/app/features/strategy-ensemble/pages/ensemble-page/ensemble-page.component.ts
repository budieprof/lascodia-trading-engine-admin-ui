import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import type { EChartsOption } from 'echarts';

interface StrategyAllocation {
  name: string;
  weight: number;
  sharpe: number;
  status: string;
}

@Component({
  selector: 'app-ensemble-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, PageHeaderComponent, StatusBadgeComponent, TabsComponent],
  template: `
    <div class="page">
      <app-page-header title="Strategy Ensemble" subtitle="Portfolio allocation and multi-strategy analytics" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'allocation') {
          <div class="allocation-layout">
            <div class="donut-section">
              <app-chart-card
                title="Current Allocation"
                subtitle="Portfolio weight distribution"
                [options]="allocationDonutOptions"
                height="340px"
              />
            </div>
            <div class="strategy-list">
              <div class="list-header">
                <span>Strategy</span>
                <span>Weight</span>
                <span>Sharpe</span>
                <span>Status</span>
              </div>
              @for (s of strategies; track s.name; let i = $index) {
                <div class="list-row">
                  <div class="strategy-name">
                    <span class="rank">{{ i + 1 }}</span>
                    <span class="dot" [style.background]="strategyColors[i]"></span>
                    {{ s.name }}
                  </div>
                  <span class="weight">{{ s.weight }}%</span>
                  <span class="sharpe">{{ s.sharpe.toFixed(2) }}</span>
                  <app-status-badge [status]="s.status" type="strategy" />
                </div>
              }
            </div>
          </div>
        }

        @if (activeTab() === 'analytics') {
          <div class="charts-grid">
            <app-chart-card
              title="Portfolio Equity Curve"
              subtitle="Combined portfolio value over time"
              [options]="equityCurveOptions"
              height="360px"
            />
            <app-chart-card
              title="Contribution to Return"
              subtitle="Monthly return contribution by strategy"
              [options]="contributionOptions"
              height="360px"
            />
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .allocation-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-6);
      align-items: start;
    }
    .strategy-list {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    .list-header {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      background: var(--bg-tertiary);
      font-size: var(--text-xs);
      font-weight: var(--font-semibold);
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .list-row {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      align-items: center;
      font-size: var(--text-sm);
      color: var(--text-primary);
    }
    .list-row:last-child { border-bottom: none; }
    .strategy-name {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: var(--font-medium);
    }
    .rank {
      width: 20px;
      height: 20px;
      border-radius: var(--radius-full);
      background: var(--bg-tertiary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      color: var(--text-secondary);
      font-weight: var(--font-semibold);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .weight {
      font-weight: var(--font-semibold);
      font-variant-numeric: tabular-nums;
    }
    .sharpe {
      font-variant-numeric: tabular-nums;
      color: var(--text-secondary);
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
    }
  `],
})
export class EnsemblePageComponent {
  tabs: TabItem[] = [
    { label: 'Current Allocation', value: 'allocation' },
    { label: 'Portfolio Analytics', value: 'analytics' },
  ];
  activeTab = signal('allocation');

  strategyColors = ['#0071E3', '#34C759', '#FF9500', '#5856D6', '#FF3B30'];

  strategies: StrategyAllocation[] = [
    { name: 'Momentum Alpha', weight: 35, sharpe: 1.82, status: 'Active' },
    { name: 'Mean Reversion', weight: 25, sharpe: 1.54, status: 'Active' },
    { name: 'Breakout Pro', weight: 20, sharpe: 1.31, status: 'Active' },
    { name: 'Volatility Harvest', weight: 12, sharpe: 0.94, status: 'Paused' },
    { name: 'Carry Trade', weight: 8, sharpe: 0.72, status: 'Active' },
  ];

  allocationDonutOptions: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c}% ({d}%)' },
    legend: { bottom: 0, data: this.strategies.map(s => s.name) },
    series: [{
      type: 'pie',
      radius: ['42%', '68%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { show: true, formatter: '{b}\n{d}%', fontSize: 11 },
      emphasis: { label: { fontSize: 14, fontWeight: 'bold' } },
      data: this.strategies.map((s, i) => ({
        value: s.weight,
        name: s.name,
        itemStyle: { color: this.strategyColors[i] },
      })),
    }],
  };

  equityCurveOptions: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: '${value}' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [{
      type: 'line',
      smooth: true,
      data: [100000, 103200, 107800, 112400, 109800, 115600, 121300, 126800, 124200, 130100, 135400, 141200],
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(0, 113, 227, 0.25)' },
            { offset: 1, color: 'rgba(0, 113, 227, 0.02)' },
          ],
        },
      },
      lineStyle: { width: 2, color: '#0071E3' },
      itemStyle: { color: '#0071E3' },
    }],
  };

  contributionOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: this.strategies.map(s => s.name), bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 50 },
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
      { name: 'Momentum Alpha', type: 'bar', stack: 'total', data: [1200, 1800, 2400, 1600, -800, 2200, 2800, 2100, -900, 2400, 1800, 2600], itemStyle: { color: '#0071E3' } },
      { name: 'Mean Reversion', type: 'bar', stack: 'total', data: [800, 1200, 1600, 900, -200, 1400, 1100, 1800, 600, 1200, 1600, 800], itemStyle: { color: '#34C759' } },
      { name: 'Breakout Pro', type: 'bar', stack: 'total', data: [600, 800, 400, 1200, -1200, 1000, 1400, 600, -400, 1600, 800, 1200], itemStyle: { color: '#FF9500' } },
      { name: 'Volatility Harvest', type: 'bar', stack: 'total', data: [400, 200, 600, 300, 100, 400, 200, 500, -100, 600, 400, 200], itemStyle: { color: '#5856D6' } },
      { name: 'Carry Trade', type: 'bar', stack: 'total', data: [200, 600, 200, 400, -500, 200, 400, 200, -200, 400, 200, 400], itemStyle: { color: '#FF3B30' } },
    ],
  };
}
