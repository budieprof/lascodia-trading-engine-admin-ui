import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, merge, of, throttleTime } from 'rxjs';

import { HealthService } from '@core/services/health.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { EngineStatusDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

@Component({
  selector: 'app-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    TabsComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="System Health"
        subtitle="Live engine status and operational metrics"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'overview') {
          @if (loading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (status()) {
            @if (status(); as s) {
              <div
                class="health-hero"
                [class.healthy]="s.isRunning"
                [class.unhealthy]="!s.isRunning"
              >
                <div class="health-circle">
                  <span class="health-icon" aria-hidden="true">{{ s.isRunning ? '✓' : '!' }}</span>
                </div>
                <div class="health-text">
                  <span class="health-status">{{
                    s.isRunning ? 'Engine Running' : 'Engine Stopped'
                  }}</span>
                  <span class="health-sub"
                    >Last checked {{ s.checkedAt | date: 'MMM d, HH:mm:ss' }}</span
                  >
                  @if (s.paperMode) {
                    <span class="mode-pill">{{ s.paperMode }} mode</span>
                  }
                </div>
              </div>

              <div class="metrics">
                <app-metric-card
                  label="Active Strategies"
                  [value]="s.activeStrategies"
                  format="number"
                />
                <app-metric-card label="Open Positions" [value]="s.openPositions" format="number" />
                <app-metric-card label="Pending Orders" [value]="s.pendingOrders" format="number" />
              </div>

              <div class="note">
                <strong>Additional health surfaces:</strong>
                The engine also exposes
                <code>GET /health/workers</code> (147-worker breakdown),
                <code>GET /health/defaults-calibration</code> (screening-gate recommendations), and
                <code>GET /health/strategy-generation</code> (replay-state diagnostics). These power
                the <em>Worker Health</em> and <em>Calibration</em> sections added in Phase 2 of the
                upgrade plan.
              </div>
            }
          } @else {
            <app-empty-state
              title="Unable to reach engine"
              description="The /health/status endpoint is not responding."
            />
          }
        }

        @if (activeTab() === 'infrastructure') {
          <app-empty-state
            title="Infrastructure metrics unavailable"
            description="Connection pool, queue depth, and per-broker latency are not exposed by the engine today. The Worker Monitor in Phase 2 will surface cycle duration, error rate, and backlog for all 147 workers."
          />
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
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
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .healthy .health-circle {
        background: rgba(52, 199, 89, 0.15);
      }
      .unhealthy .health-circle {
        background: rgba(255, 59, 48, 0.15);
      }
      .healthy .health-icon {
        color: var(--profit);
      }
      .unhealthy .health-icon {
        color: var(--loss);
      }
      .health-icon {
        font-size: 32px;
        font-weight: bold;
      }
      .health-text {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .health-status {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .healthy .health-status {
        color: var(--profit);
      }
      .unhealthy .health-status {
        color: var(--loss);
      }
      .health-sub {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .mode-pill {
        display: inline-block;
        margin-top: var(--space-1);
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
        width: fit-content;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      @media (max-width: 768px) {
        .metrics {
          grid-template-columns: 1fr;
        }
      }
      .note {
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4) var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .note code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    `,
  ],
})
export class HealthPageComponent {
  private readonly healthService = inject(HealthService);
  private readonly realtime = inject(RealtimeService);

  constructor() {
    // Risk events are the reason someone is staring at this page — surface
    // them immediately so the "is the engine still okay?" question resolves
    // before the next 15s poll. Throttle 1s to de-dupe duplicate breach
    // notifications on the same VaR cycle but otherwise push hard.
    merge(this.realtime.on('vaRBreach'), this.realtime.on('emergencyFlatten'))
      .pipe(throttleTime(1_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.resource.refresh());
  }

  readonly tabs: TabItem[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Infrastructure', value: 'infrastructure' },
  ];
  readonly activeTab = signal('overview');

  private readonly resource = createPolledResource(
    () =>
      this.healthService.getStatus().pipe(
        map((r) => r.data),
        catchError(() => of(null as EngineStatusDto | null)),
      ),
    { intervalMs: 15_000 },
  );

  readonly status = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
}
