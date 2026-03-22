import { Component, ChangeDetectionStrategy } from '@angular/core';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-drawdown-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, PageHeaderComponent, GaugeComponent],
  template: `
    <div class="page">
      <app-page-header title="Drawdown Recovery" subtitle="Risk monitoring and drawdown management" />

      <!-- Hero Section -->
      <div class="hero-section">
        <div class="hero-gauge">
          <app-gauge
            [value]="currentDrawdown"
            [min]="0"
            [max]="25"
            label="Current Drawdown"
            size="200px"
            [thresholds]="drawdownThresholds"
          />
        </div>
        <div class="hero-info">
          <div class="recovery-badge-row">
            <span class="recovery-label">Recovery Mode</span>
            <span class="recovery-badge" [class]="recoveryMode">{{ recoveryModeLabel }}</span>
          </div>
          <div class="equity-comparison">
            <div class="equity-item">
              <span class="equity-label">Peak Equity</span>
              <span class="equity-value peak">$148,600</span>
            </div>
            <div class="equity-divider">
              <span class="arrow-down">\u2193</span>
            </div>
            <div class="equity-item">
              <span class="equity-label">Current Equity</span>
              <span class="equity-value current">$141,230</span>
            </div>
            <div class="equity-item delta">
              <span class="equity-label">Drawdown Amount</span>
              <span class="equity-value loss">-$7,370</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Charts -->
      <div class="charts-grid">
        <app-chart-card
          title="Drawdown History"
          subtitle="Maximum drawdown over time"
          [options]="drawdownHistoryOptions"
          height="320px"
        />
        <app-chart-card
          title="Equity vs Peak Equity"
          subtitle="Current equity tracking against all-time high"
          [options]="equityVsPeakOptions"
          height="320px"
        />
      </div>
      <div class="charts-grid single">
        <app-chart-card
          title="Mode Transition Timeline"
          subtitle="Trading mode changes based on drawdown levels"
          [options]="modeTimelineOptions"
          height="160px"
        />
      </div>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .hero-section {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--space-8);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-6);
      margin-bottom: var(--space-6);
      box-shadow: var(--shadow-sm);
      align-items: center;
    }
    .hero-gauge {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hero-info {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
    }
    .recovery-badge-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }
    .recovery-label {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      font-weight: var(--font-medium);
    }
    .recovery-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-2) var(--space-4);
      border-radius: var(--radius-full);
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
    }
    .recovery-badge.normal {
      background: rgba(52, 199, 89, 0.12);
      color: #248A3D;
    }
    .recovery-badge.reduced {
      background: rgba(255, 149, 0, 0.12);
      color: #C93400;
    }
    .recovery-badge.halted {
      background: rgba(255, 59, 48, 0.12);
      color: #D70015;
    }
    .equity-comparison {
      display: flex;
      align-items: center;
      gap: var(--space-6);
    }
    .equity-item {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .equity-item.delta {
      margin-left: var(--space-4);
      padding-left: var(--space-4);
      border-left: 1px solid var(--border);
    }
    .equity-label {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      font-weight: var(--font-medium);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .equity-value {
      font-size: var(--text-xl);
      font-weight: var(--font-semibold);
      font-variant-numeric: tabular-nums;
      color: var(--text-primary);
    }
    .equity-value.peak { color: var(--text-secondary); }
    .equity-value.current { color: var(--text-primary); }
    .equity-value.loss { color: #FF3B30; }
    .equity-divider {
      display: flex;
      align-items: center;
    }
    .arrow-down {
      font-size: 20px;
      color: var(--text-tertiary);
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
export class DrawdownPageComponent {
  currentDrawdown = 4.96;
  recoveryMode = 'normal';
  recoveryModeLabel = 'Normal';

  drawdownThresholds = [
    { value: 5, color: '#34C759' },
    { value: 10, color: '#FF9500' },
    { value: 25, color: '#FF3B30' },
  ];

  drawdownHistoryOptions: EChartsOption = {
    tooltip: { trigger: 'axis', formatter: (params: any) => `${params[0].axisValue}: -${params[0].value}%` },
    grid: { left: 50, right: 20, top: 10, bottom: 30 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: Array.from({ length: 60 }, (_, i) => {
        const d = new Date(2026, 2, 21);
        d.setDate(d.getDate() - 59 + i);
        return `${d.getMonth() + 1}/${d.getDate()}`;
      }),
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93', fontSize: 10, interval: 9 },
    },
    yAxis: {
      type: 'value',
      inverse: true,
      axisLabel: { color: '#8E8E93', formatter: '-{value}%' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [{
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: [
        0.2, 0.5, 1.1, 1.8, 2.4, 3.1, 3.8, 4.2, 3.9, 3.4,
        2.8, 2.1, 1.6, 1.2, 0.8, 0.3, 0.1, 0.4, 0.9, 1.6,
        2.3, 3.2, 4.8, 6.1, 7.4, 8.3, 7.8, 7.1, 6.4, 5.8,
        5.1, 4.6, 4.0, 3.5, 3.0, 2.4, 1.8, 1.2, 0.6, 0.2,
        0.5, 1.1, 1.8, 2.6, 3.4, 4.1, 4.8, 5.2, 5.6, 5.2,
        4.8, 4.4, 4.0, 3.6, 3.2, 3.8, 4.2, 4.6, 5.0, 4.96,
      ],
      lineStyle: { width: 2, color: '#FF3B30' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(255, 59, 48, 0.02)' },
            { offset: 1, color: 'rgba(255, 59, 48, 0.25)' },
          ],
        },
      },
    }],
  };

  equityVsPeakOptions: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Equity', 'Peak Equity'], bottom: 0 },
    grid: { left: 60, right: 20, top: 10, bottom: 40 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93', formatter: (v: number) => `$${(v / 1000).toFixed(0)}k` },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      {
        name: 'Equity',
        type: 'line',
        smooth: true,
        data: [100000, 105200, 110800, 108400, 114200, 119600, 125400, 122800, 128600, 134200, 140800, 145600, 148600, 143200, 141230],
        lineStyle: { width: 2, color: '#0071E3' },
        itemStyle: { color: '#0071E3' },
      },
      {
        name: 'Peak Equity',
        type: 'line',
        smooth: false,
        data: [100000, 105200, 110800, 110800, 114200, 119600, 125400, 125400, 128600, 134200, 140800, 145600, 148600, 148600, 148600],
        lineStyle: { width: 1.5, color: '#8E8E93', type: 'dashed' },
        itemStyle: { color: '#8E8E93' },
        symbol: 'none',
      },
    ],
  };

  modeTimelineOptions: EChartsOption = {
    tooltip: { trigger: 'item' },
    grid: { left: 80, right: 20, top: 10, bottom: 30 },
    xAxis: {
      type: 'category',
      data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'category',
      data: ['Mode'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    legend: { data: ['Normal', 'Reduced', 'Halted'], bottom: 0 },
    series: [
      {
        name: 'Normal',
        type: 'bar',
        stack: 'mode',
        data: [1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1],
        itemStyle: { color: '#34C759' },
        barWidth: '90%',
      },
      {
        name: 'Reduced',
        type: 'bar',
        stack: 'mode',
        data: [0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0],
        itemStyle: { color: '#FF9500' },
        barWidth: '90%',
      },
      {
        name: 'Halted',
        type: 'bar',
        stack: 'mode',
        data: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        itemStyle: { color: '#FF3B30' },
        barWidth: '90%',
      },
    ],
  };
}
