import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { EAInstancesService } from '@core/services/ea-instances.service';
import type { EAInstanceDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

@Component({
  selector: 'app-ea-instances-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="EA Instances"
        subtitle="Expert Advisor heartbeats and symbol ownership"
      />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (instances().length > 0) {
        <div class="metrics">
          <app-metric-card
            label="Total"
            [value]="instances().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Active"
            [value]="activeCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card label="Idle" [value]="idleCount()" format="number" dotColor="#FF9500" />
          <app-metric-card
            label="Disconnected"
            [value]="disconnectedCount()"
            format="number"
            dotColor="#FF3B30"
          />
        </div>

        <section class="grid">
          @for (i of instances(); track i.instanceId) {
            <article class="card" [attr.data-status]="i.status">
              <header class="head">
                <div class="title">
                  <span class="status-dot" [attr.data-status]="i.status"></span>
                  <h4>{{ i.instanceId }}</h4>
                </div>
                <span class="pill" [attr.data-status]="i.status">{{ i.status }}</span>
              </header>
              <dl class="info">
                <div>
                  <dt>Account</dt>
                  <dd class="mono">{{ i.accountId ?? '—' }}</dd>
                </div>
                <div>
                  <dt>Heartbeat</dt>
                  <dd>{{ heartbeatLabel(i) }}</dd>
                </div>
                <div>
                  <dt>Registered</dt>
                  <dd>{{ i.registeredAt ? (i.registeredAt | date: 'MMM d, HH:mm') : '—' }}</dd>
                </div>
                <div class="full">
                  <dt>Owned Symbols ({{ i.ownedSymbols?.length ?? 0 }})</dt>
                  <dd>
                    @if ((i.ownedSymbols?.length ?? 0) > 0) {
                      <div class="chips">
                        @for (s of i.ownedSymbols ?? []; track s) {
                          <span class="chip">{{ s }}</span>
                        }
                      </div>
                    } @else {
                      <span class="muted">No symbols owned</span>
                    }
                  </dd>
                </div>
              </dl>
            </article>
          }
        </section>
        <p class="note">
          Dead EAs mark their symbols <code>DATA_UNAVAILABLE</code> after ~60s without a heartbeat.
          Symbols are reassigned automatically when a new EA registers.
        </p>
      } @else {
        <app-empty-state
          title="No EA instances registered"
          description="Register an Expert Advisor from MT5 to populate this view."
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-4);
      }
      @media (max-width: 768px) {
        .metrics {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card[data-status='Active'] {
        border-left: 3px solid var(--profit);
      }
      .card[data-status='Idle'] {
        border-left: 3px solid var(--warning);
      }
      .card[data-status='Disconnected'] {
        border-left: 3px solid var(--loss);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-primary);
        word-break: break-all;
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .status-dot[data-status='Active'] {
        background: var(--profit);
      }
      .status-dot[data-status='Idle'] {
        background: var(--warning);
      }
      .status-dot[data-status='Disconnected'] {
        background: var(--loss);
      }
      .pill {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill[data-status='Active'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Idle'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill[data-status='Disconnected'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .info {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
        margin: 0;
      }
      .info .full {
        grid-column: 1 / -1;
      }
      .info dt {
        font-size: 11px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .info dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .info dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chip {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: 11px;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .note {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-5);
        margin: 0;
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
export class EAInstancesPageComponent {
  private readonly service = inject(EAInstancesService);

  private readonly resource = createPolledResource(
    () =>
      this.service.list().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as EAInstanceDto[])),
      ),
    { intervalMs: 15_000 },
  );

  readonly instances = computed(() => this.resource.value() ?? []);
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly activeCount = computed(
    () => this.instances().filter((i) => i.status === 'Active').length,
  );
  readonly idleCount = computed(() => this.instances().filter((i) => i.status === 'Idle').length);
  readonly disconnectedCount = computed(
    () => this.instances().filter((i) => i.status === 'Disconnected').length,
  );

  heartbeatLabel(instance: EAInstanceDto): string {
    if (!instance.lastHeartbeatAt) return '—';
    const elapsed = Date.now() - new Date(instance.lastHeartbeatAt).getTime();
    if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s ago`;
    if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
    return `${Math.round(elapsed / 3_600_000)}h ago`;
  }
}
