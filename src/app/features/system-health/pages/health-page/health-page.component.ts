import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import type { EChartsOption } from 'echarts';

interface Subsystem {
  name: string;
  healthy: boolean;
}

interface BrokerHealth {
  name: string;
  status: string;
  latencyMs: number;
}

@Component({
  selector: 'app-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, PageHeaderComponent, StatusBadgeComponent, GaugeComponent, TabsComponent],
  template: `
    <div class="page">
      <app-page-header title="System Health" subtitle="Infrastructure monitoring and service status" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          <!-- Large health indicator -->
          <div class="health-hero">
            <div class="health-circle healthy">
              <span class="health-icon">\u2713</span>
            </div>
            <div class="health-text">
              <span class="health-status">Healthy</span>
              <span class="health-sub">All systems operational</span>
            </div>
          </div>

          <!-- Subsystem grid -->
          <div class="subsystem-grid">
            @for (sub of subsystems; track sub.name) {
              <div class="subsystem-card">
                <span class="subsystem-dot" [class.up]="sub.healthy" [class.down]="!sub.healthy"></span>
                <span class="subsystem-name">{{ sub.name }}</span>
                <span class="subsystem-status">{{ sub.healthy ? 'Operational' : 'Degraded' }}</span>
              </div>
            }
          </div>

          <!-- Error rate chart -->
          <app-chart-card
            title="Error Rate"
            subtitle="Errors per minute over the last hour"
            [options]="errorRateOptions"
            height="280px"
          />
        }

        @if (activeTab() === 'infrastructure') {
          <div class="infra-grid">
            <!-- Database -->
            <div class="infra-card">
              <h3 class="infra-title">Database</h3>
              <p class="infra-subtitle">Connection Pool Utilization</p>
              <div class="gauge-center">
                <app-gauge
                  [value]="62"
                  [min]="0"
                  [max]="100"
                  label="Pool Usage"
                  size="160px"
                />
              </div>
              <div class="infra-stats">
                <div class="stat"><span class="stat-label">Active</span><span class="stat-value">31</span></div>
                <div class="stat"><span class="stat-label">Max</span><span class="stat-value">50</span></div>
                <div class="stat"><span class="stat-label">Idle</span><span class="stat-value">19</span></div>
              </div>
            </div>

            <!-- RabbitMQ -->
            <div class="infra-card">
              <h3 class="infra-title">RabbitMQ</h3>
              <p class="infra-subtitle">Message Queue Status</p>
              <div class="queue-display">
                <span class="queue-number">142</span>
                <span class="queue-label">Messages in Queue</span>
              </div>
              <div class="infra-stats">
                <div class="stat"><span class="stat-label">Published/s</span><span class="stat-value">84</span></div>
                <div class="stat"><span class="stat-label">Consumed/s</span><span class="stat-value">81</span></div>
                <div class="stat"><span class="stat-label">Unacked</span><span class="stat-value">12</span></div>
              </div>
            </div>

            <!-- Broker Health -->
            <div class="infra-card wide">
              <h3 class="infra-title">Broker Health</h3>
              <p class="infra-subtitle">Connected broker status and latency</p>
              <div class="broker-list">
                @for (b of brokers; track b.name) {
                  <div class="broker-row">
                    <span class="broker-name">{{ b.name }}</span>
                    <app-status-badge [status]="b.status" type="broker" />
                    <span class="broker-latency">{{ b.latencyMs }}ms</span>
                  </div>
                }
              </div>
            </div>
          </div>

          <!-- API Quotas -->
          <div class="quota-section">
            <h3 class="section-title">API Quota Usage</h3>
            <div class="quota-grid">
              @for (q of quotas; track q.name) {
                <div class="quota-card">
                  <app-gauge
                    [value]="q.usage"
                    [min]="0"
                    [max]="100"
                    [label]="q.name"
                    size="140px"
                    [thresholds]="quotaThresholds"
                  />
                  <div class="quota-detail">{{ q.used }} / {{ q.limit }} req/min</div>
                </div>
              }
            </div>
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .health-hero {
      display: flex;
      align-items: center;
      gap: var(--space-5);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-6);
      margin-bottom: var(--space-6);
      box-shadow: var(--shadow-sm);
    }
    .health-circle {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .health-circle.healthy {
      background: rgba(52, 199, 89, 0.15);
    }
    .health-circle.unhealthy {
      background: rgba(255, 59, 48, 0.15);
    }
    .health-icon {
      font-size: 32px;
      font-weight: bold;
    }
    .healthy .health-icon { color: #34C759; }
    .unhealthy .health-icon { color: #FF3B30; }
    .health-text {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .health-status {
      font-size: var(--text-xl);
      font-weight: var(--font-semibold);
      color: #34C759;
    }
    .health-sub {
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }
    .subsystem-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-3);
      margin-bottom: var(--space-6);
    }
    .subsystem-card {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
    }
    .subsystem-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .subsystem-dot.up { background: #34C759; }
    .subsystem-dot.down { background: #FF3B30; }
    .subsystem-name {
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: var(--text-primary);
      flex: 1;
    }
    .subsystem-status {
      font-size: var(--text-xs);
      color: var(--text-secondary);
    }
    .infra-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }
    .infra-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-5);
      box-shadow: var(--shadow-sm);
    }
    .infra-card.wide {
      grid-column: 1 / -1;
    }
    .infra-title {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0;
    }
    .infra-subtitle {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      margin: var(--space-1) 0 var(--space-4);
    }
    .gauge-center {
      display: flex;
      justify-content: center;
      margin-bottom: var(--space-4);
    }
    .infra-stats {
      display: flex;
      justify-content: space-around;
      border-top: 1px solid var(--border);
      padding-top: var(--space-3);
    }
    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-1);
    }
    .stat-label {
      font-size: var(--text-xs);
      color: var(--text-secondary);
    }
    .stat-value {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }
    .queue-display {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: var(--space-6) 0;
    }
    .queue-number {
      font-size: 48px;
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .queue-label {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      margin-top: var(--space-2);
    }
    .broker-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .broker-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }
    .broker-name {
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: var(--text-primary);
      flex: 1;
    }
    .broker-latency {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }
    .quota-section { margin-bottom: var(--space-6); }
    .section-title {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0 0 var(--space-4);
    }
    .quota-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--space-4);
    }
    .quota-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      display: flex;
      flex-direction: column;
      align-items: center;
      box-shadow: var(--shadow-sm);
    }
    .quota-detail {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      margin-top: var(--space-2);
      font-variant-numeric: tabular-nums;
    }
  `],
})
export class HealthPageComponent {
  tabs: TabItem[] = [
    { label: 'System Overview', value: 'overview' },
    { label: 'Infrastructure', value: 'infrastructure' },
  ];
  activeTab = signal('overview');

  subsystems: Subsystem[] = [
    { name: 'Core Trading', healthy: true },
    { name: 'Market Data', healthy: true },
    { name: 'Risk Management', healthy: true },
    { name: 'ML Training', healthy: true },
    { name: 'ML Monitoring', healthy: true },
    { name: 'Backtesting', healthy: true },
    { name: 'Alerts', healthy: true },
  ];

  brokers: BrokerHealth[] = [
    { name: 'OANDA', status: 'Connected', latencyMs: 32 },
    { name: 'Interactive Brokers', status: 'Connected', latencyMs: 45 },
    { name: 'FXCM', status: 'Disconnected', latencyMs: 0 },
  ];

  quotas = [
    { name: 'OANDA', usage: 34, used: 340, limit: 1000 },
    { name: 'Interactive Brokers', usage: 58, used: 290, limit: 500 },
    { name: 'News API', usage: 12, used: 120, limit: 1000 },
    { name: 'Sentiment API', usage: 45, used: 450, limit: 1000 },
  ];

  quotaThresholds = [
    { value: 60, color: '#34C759' },
    { value: 85, color: '#FF9500' },
    { value: 100, color: '#FF3B30' },
  ];

  errorRateOptions: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 10, bottom: 30 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: Array.from({ length: 60 }, (_, i) => `${i}m ago`).reverse(),
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93', fontSize: 10, interval: 9 },
    },
    yAxis: {
      type: 'value',
      name: 'Errors/min',
      axisLabel: { color: '#8E8E93' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [{
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: [
        0, 0, 1, 0, 0, 0, 0, 1, 0, 0,
        0, 0, 0, 2, 1, 0, 0, 0, 0, 0,
        1, 0, 0, 0, 0, 0, 3, 5, 8, 4,
        2, 1, 0, 0, 0, 0, 1, 0, 0, 0,
        0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
        0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
      ],
      lineStyle: { width: 1.5, color: '#FF3B30' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(255, 59, 48, 0.2)' },
            { offset: 1, color: 'rgba(255, 59, 48, 0.02)' },
          ],
        },
      },
    }],
  };
}
