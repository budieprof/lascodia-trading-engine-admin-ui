import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { ObservabilityService } from '@core/services/observability.service';
import { EAAdminService } from '@core/services/ea-admin.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type {
  EAFleetItem,
  EAObservabilityDto,
  EngineObservabilityDto,
  FleetObservabilityDto,
} from '@core/api/api.types';
import { catchError, map, of } from 'rxjs';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Phase-16: single-glance health page for the engine + fleet.
 *
 * Three blocks polled in parallel every 10 s:
 *   1. Fleet summary cards — EAs / daemons / sessions by state.
 *   2. Engine vitals — DB latency proxy + working-order/position counts.
 *   3. Per-EA table — instance status + click-to-expand state envelope.
 *
 * For raw time-series data (signal-generation rates, evaluator
 * rejections, kestrel histograms) the page links to the engine's
 * Prometheus ``/metrics`` endpoint — Grafana is the proper home for
 * that, this page is the operator's first-touch dashboard.
 */
@Component({
  selector: 'app-fleet-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    PageHeaderComponent,
    CardSkeletonComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Fleet Health"
        subtitle="Engine + EA + daemon vitals — refreshes every 10 s."
      >
        <a class="btn btn-secondary" [href]="metricsHref()" target="_blank" rel="noopener"
          >Open /metrics ↗</a
        >
      </app-page-header>

      <ui-progress-bar [active]="loading()" />

      @if (initialLoading()) {
        <app-card-skeleton [lines]="6" />
      } @else {
        <!-- ── Summary cards row ─────────────────────────────────── -->
        <section class="summary-grid">
          @if (fleet(); as f) {
            <article class="summary-card">
              <header class="head">
                <h4>EAs</h4>
                <span class="total">{{ f.eas.total }}</span>
              </header>
              <dl class="kv">
                <dt>Active</dt>
                <dd class="ok">{{ f.eas.active }}</dd>
                <dt>Idle (>10m)</dt>
                <dd class="warn">{{ f.eas.idleOverStale }}</dd>
                <dt>Disconnected</dt>
                <dd class="bad">{{ f.eas.disconnected }}</dd>
                <dt>Coordinators</dt>
                <dd>{{ f.eas.coordinators }}</dd>
                <dt>Accounts</dt>
                <dd>{{ f.eas.distinctAccounts }}</dd>
                <dt>Versions</dt>
                <dd>{{ f.eas.distinctVersions }}</dd>
              </dl>
            </article>

            <article class="summary-card">
              <header class="head">
                <h4>Daemons</h4>
                <span class="total">{{ f.daemons.total }}</span>
              </header>
              <dl class="kv">
                <dt>Online</dt>
                <dd class="ok">{{ f.daemons.online }}</dd>
                <dt>Offline</dt>
                <dd class="bad">{{ f.daemons.offline }}</dd>
              </dl>
            </article>

            <article class="summary-card">
              <header class="head">
                <h4>Sessions</h4>
                <span class="total">{{ f.sessions.running + f.sessions.closed }}</span>
              </header>
              <dl class="kv">
                <dt>Running</dt>
                <dd class="ok">{{ f.sessions.running }}</dd>
                <dt>Closed</dt>
                <dd class="muted">{{ f.sessions.closed }}</dd>
              </dl>
            </article>
          }

          @if (engine(); as e) {
            <article class="summary-card engine">
              <header class="head">
                <h4>Engine</h4>
                <span class="total" [attr.data-tier]="dbTier(e.dbLatencyMs)">
                  {{ e.dbLatencyMs | number: '1.0-0' }} ms
                </span>
              </header>
              <dl class="kv">
                <dt>DB latency</dt>
                <dd>{{ e.dbLatencyMs | number: '1.0-0' }} ms</dd>
                <dt>Open positions</dt>
                <dd>{{ e.openPositions }}</dd>
                <dt>Working orders</dt>
                <dd>{{ e.workingOrders }}</dd>
                <dt>Active accounts</dt>
                <dd>{{ e.activeAccounts }}</dd>
                <dt>Outbox pending</dt>
                <dd [class.warn]="(e.outboxPending ?? 0) > 100">
                  {{ e.outboxPending ?? '—' }}
                </dd>
              </dl>
            </article>
          }
        </section>

        <!-- ── Per-EA table ────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <h3>
              EA instances <span class="count">{{ instances().length }}</span>
            </h3>
          </header>
          @if (instances().length === 0) {
            <p class="muted small">No EA instances registered.</p>
          } @else {
            <table class="ea-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Last heartbeat</th>
                  <th>Coord</th>
                  <th>Account</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (i of instances(); track i.instanceId) {
                  <tr [attr.data-status]="i.status">
                    <td class="mono small">{{ i.instanceId }}</td>
                    <td>
                      <span class="status-pill" [attr.data-status]="i.status">{{ i.status }}</span>
                    </td>
                    <td class="mono small">{{ i.eaVersion }}</td>
                    <td class="small">
                      <span [title]="i.lastHeartbeat | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                        {{ i.lastHeartbeat | relativeTime }}
                      </span>
                    </td>
                    <td>{{ i.isCoordinator ? '✓' : '' }}</td>
                    <td class="small">#{{ i.tradingAccountId }}</td>
                    <td>
                      <button type="button" class="btn-link" (click)="expand(i.instanceId)">
                        @if (expanded() === i.instanceId) {
                          Hide
                        } @else {
                          Details
                        }
                      </button>
                    </td>
                  </tr>
                  @if (expanded() === i.instanceId) {
                    <tr class="detail-row">
                      <td colspan="7">
                        @if (detailLoading()) {
                          <p class="muted small">Loading state envelope…</p>
                        } @else if (detailErr()) {
                          <p class="bad small">{{ detailErr() }}</p>
                        } @else if (detail(); as d) {
                          <div class="detail-grid">
                            <div>
                              <h5>Runtime</h5>
                              <dl class="kv-compact">
                                <dt>State</dt>
                                <dd>{{ d.highlights?.stateMachine ?? '—' }}</dd>
                                <dt>Safety stop</dt>
                                <dd>{{ d.highlights?.safetyStopCategory ?? 'NONE' }}</dd>
                                <dt>Market</dt>
                                <dd>{{ d.highlights?.marketState ?? '—' }}</dd>
                                <dt>Broker connected</dt>
                                <dd>{{ boolEmoji(d.highlights?.brokerConnected) }}</dd>
                                <dt>Engine reachable</dt>
                                <dd>{{ boolEmoji(d.highlights?.engineReachable) }}</dd>
                                <dt>Kill switch</dt>
                                <dd>{{ boolEmoji(d.highlights?.killSwitchActive, true) }}</dd>
                              </dl>
                            </div>
                            <div>
                              <h5>Latency</h5>
                              <dl class="kv-compact">
                                <dt>HTTP P95</dt>
                                <dd>{{ d.highlights?.latencyP95Ms ?? '—' }} ms</dd>
                                <dt>HTTP P99</dt>
                                <dd>{{ d.highlights?.latencyP99Ms ?? '—' }} ms</dd>
                                <dt>HTTP success</dt>
                                <dd>{{ pct(d.highlights?.httpSuccessRate) }}</dd>
                                <dt>HTTP circuit</dt>
                                <dd>{{ boolEmoji(d.highlights?.httpCircuitOpen, true) }}</dd>
                                <dt>Last tick age</dt>
                                <dd>{{ d.highlights?.lastTickAgeSec ?? '—' }} s</dd>
                              </dl>
                            </div>
                            <div>
                              <h5>Trading</h5>
                              <dl class="kv-compact">
                                <dt>Positions</dt>
                                <dd>{{ d.highlights?.positionCount ?? '—' }}</dd>
                                <dt>Order queue</dt>
                                <dd>
                                  {{ d.highlights?.orderQueueSize ?? '—' }} /
                                  {{ d.highlights?.orderQueueCapacity ?? '—' }}
                                </dd>
                                <dt>Pending acks</dt>
                                <dd>{{ d.highlights?.pendingCommandAcks ?? '—' }}</dd>
                                <dt>Daily P&L</dt>
                                <dd [class.bad]="(d.highlights?.dailyPnL ?? 0) < 0">
                                  {{ d.highlights?.dailyPnL ?? '—' }}
                                </dd>
                                <dt>GVar usage</dt>
                                <dd>{{ d.highlights?.gvarTotal ?? '—' }} / 4096</dd>
                              </dl>
                            </div>
                          </div>
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        max-width: var(--page-max-width);
        margin: 0 auto;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
      }
      .summary-card {
        padding: var(--space-3);
        border: 1px solid var(--border-primary);
        border-radius: 8px;
        background: var(--bg-secondary);
      }
      .summary-card.engine {
        background: var(--bg-tertiary);
      }
      .summary-card .head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 8px;
      }
      .summary-card .head h4 {
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .summary-card .total {
        font-size: 22px;
        font-weight: 600;
      }
      .summary-card .total[data-tier='fast'] {
        color: #1d8a3e;
      }
      .summary-card .total[data-tier='warn'] {
        color: #cb8a17;
      }
      .summary-card .total[data-tier='slow'] {
        color: #c93631;
      }
      dl.kv,
      dl.kv-compact {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0;
        font-size: 12px;
      }
      dl.kv-compact dt,
      dl.kv dt {
        color: var(--text-secondary);
      }
      dl.kv dd,
      dl.kv-compact dd {
        margin: 0;
      }
      .ok {
        color: #1d8a3e;
        font-weight: 600;
      }
      .warn {
        color: #cb8a17;
        font-weight: 600;
      }
      .bad {
        color: #c93631;
        font-weight: 600;
      }
      .muted {
        color: var(--text-secondary);
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .block-head {
        display: flex;
        gap: 8px;
        align-items: baseline;
      }
      .block-head h3 {
        margin: 0;
      }
      .count {
        color: var(--text-secondary);
        font-size: 12px;
      }
      .ea-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .ea-table th,
      .ea-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border-primary);
      }
      .ea-table th {
        font-size: 11px;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .status-pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        background: var(--bg-tertiary);
      }
      .status-pill[data-status='Active'] {
        background: color-mix(in srgb, #1d8a3e 18%, transparent);
        color: #1d8a3e;
      }
      .status-pill[data-status='Disconnected'] {
        background: color-mix(in srgb, #c93631 18%, transparent);
        color: #c93631;
      }
      .status-pill[data-status='Deregistered'] {
        background: color-mix(in srgb, #888 18%, transparent);
        color: var(--text-secondary);
      }
      .btn-link {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
      }
      .btn-link:hover {
        color: var(--text-primary);
        text-decoration: underline;
      }
      .detail-row td {
        background: var(--bg-tertiary);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
      }
      .detail-grid h5 {
        margin: 0 0 8px 0;
        font-size: 12px;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .small {
        font-size: 12px;
      }
      .btn-secondary {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--border-primary);
        background: var(--bg-secondary);
        color: var(--text-primary);
        text-decoration: none;
        font-size: 13px;
      }
    `,
  ],
})
export class FleetHealthPageComponent {
  private readonly observ = inject(ObservabilityService);
  private readonly eaAdmin = inject(EAAdminService);

  // ── Polled resources ─────────────────────────────────────────────
  protected readonly fleetResource = createPolledResource(
    () =>
      this.observ.fleet().pipe(
        map((r) => r.data ?? null),
        catchError(() => of<FleetObservabilityDto | null>(null)),
      ),
    { intervalMs: 10_000 },
  );
  protected readonly engineResource = createPolledResource(
    () =>
      this.observ.engine().pipe(
        map((r) => r.data ?? null),
        catchError(() => of<EngineObservabilityDto | null>(null)),
      ),
    { intervalMs: 10_000 },
  );
  protected readonly instancesResource = createPolledResource(
    () =>
      this.eaAdmin.listFleet().pipe(
        map((r) => r.data ?? []),
        catchError(() => of<EAFleetItem[]>([])),
      ),
    { intervalMs: 10_000 },
  );

  protected readonly fleet = computed(() => this.fleetResource.value());
  protected readonly engine = computed(() => this.engineResource.value());
  protected readonly instances = computed(() => this.instancesResource.value() ?? []);
  protected readonly loading = computed(
    () =>
      this.fleetResource.loading() ||
      this.engineResource.loading() ||
      this.instancesResource.loading(),
  );
  protected readonly initialLoading = computed(
    () =>
      (this.fleetResource.loading() && this.fleetResource.value() === null) ||
      (this.engineResource.loading() && this.engineResource.value() === null) ||
      (this.instancesResource.loading() && this.instancesResource.value() === null),
  );

  // ── Expand-row state for per-EA detail ───────────────────────────
  protected readonly expanded = signal<string | null>(null);
  protected readonly detail = signal<EAObservabilityDto | null>(null);
  protected readonly detailLoading = signal<boolean>(false);
  protected readonly detailErr = signal<string | null>(null);

  // The /metrics link on the page header — same origin as the engine
  // API.  Hardcoded for now; could be derived from ApiService if the
  // engine URL ever moves off the default.
  protected readonly metricsHref = signal<string>(
    `${location.protocol}//${location.hostname}:5081/metrics`,
  );

  protected expand(instanceId: string): void {
    if (this.expanded() === instanceId) {
      this.expanded.set(null);
      this.detail.set(null);
      return;
    }
    this.expanded.set(instanceId);
    this.detail.set(null);
    this.detailErr.set(null);
    this.detailLoading.set(true);
    this.observ.ea(instanceId).subscribe({
      next: (res) => {
        this.detailLoading.set(false);
        if (!res.status || !res.data) {
          this.detailErr.set(res.message ?? 'Failed to load EA detail.');
          return;
        }
        this.detail.set(res.data);
      },
      error: (err) => {
        this.detailLoading.set(false);
        this.detailErr.set(err?.error?.message ?? 'Failed to load EA detail.');
      },
    });
  }

  // ── Formatters ───────────────────────────────────────────────────
  protected dbTier(ms: number): 'fast' | 'warn' | 'slow' {
    if (ms < 50) return 'fast';
    if (ms < 200) return 'warn';
    return 'slow';
  }
  protected boolEmoji(v: boolean | null | undefined, invertGreen = false): string {
    if (v === null || v === undefined) return '—';
    const good = invertGreen ? !v : v;
    return good ? '✓' : '✗';
  }
  protected pct(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return `${(v * 100).toFixed(1)}%`;
  }
}
