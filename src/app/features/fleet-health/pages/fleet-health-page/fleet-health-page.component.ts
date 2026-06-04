import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

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
 * Layout:
 *   1. Summary cards — one row, equal heights, each headline = the metric
 *      that triggers operator action (active count, online count, db
 *      latency). Sub-counters live in a compact two-column grid below.
 *   2. EA instances table — bounded scroll surface with sticky thead and
 *      a quick-filter bar (status chips + free-text). Without bounding
 *      the page grew unbounded as the fleet rolled new versions.
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
    FormsModule,
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
        <a class="btn-secondary" [href]="metricsHref()" target="_blank" rel="noopener"
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
            <article class="kpi-card" [attr.data-tone]="eaTone(f)">
              <header class="kpi-head">
                <h4>EAs</h4>
                <span class="kpi-total">{{ f.eas.total }}</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value ok">{{ f.eas.active }}</span>
                <span class="hl-sep">/</span>
                <span class="hl-total">{{ f.eas.total }}</span>
                <span class="hl-label">active</span>
              </div>
              <dl class="kpi-grid">
                <dt>Idle &gt;10m</dt>
                <dd [class.warn]="f.eas.idleOverStale > 0">{{ f.eas.idleOverStale }}</dd>
                <dt>Disconnected</dt>
                <dd [class.bad]="f.eas.disconnected > 0">{{ f.eas.disconnected }}</dd>
                <dt>Coordinators</dt>
                <dd>{{ f.eas.coordinators }}</dd>
                <dt>Accounts</dt>
                <dd>{{ f.eas.distinctAccounts }}</dd>
                <dt>Versions</dt>
                <dd>{{ f.eas.distinctVersions }}</dd>
              </dl>
            </article>

            <article class="kpi-card" [attr.data-tone]="f.daemons.offline ? 'bad' : 'ok'">
              <header class="kpi-head">
                <h4>Daemons</h4>
                <span class="kpi-total">{{ f.daemons.total }}</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value ok">{{ f.daemons.online }}</span>
                <span class="hl-sep">/</span>
                <span class="hl-total">{{ f.daemons.total }}</span>
                <span class="hl-label">online</span>
              </div>
              <dl class="kpi-grid">
                <dt>Online</dt>
                <dd class="ok">{{ f.daemons.online }}</dd>
                <dt>Offline</dt>
                <dd [class.bad]="f.daemons.offline > 0">{{ f.daemons.offline }}</dd>
              </dl>
            </article>

            <article class="kpi-card" data-tone="ok">
              <header class="kpi-head">
                <h4>Sessions</h4>
                <span class="kpi-total">{{ f.sessions.running + f.sessions.closed }}</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value ok">{{ f.sessions.running }}</span>
                <span class="hl-sep">/</span>
                <span class="hl-total">{{ f.sessions.running + f.sessions.closed }}</span>
                <span class="hl-label">running</span>
              </div>
              <dl class="kpi-grid">
                <dt>Running</dt>
                <dd class="ok">{{ f.sessions.running }}</dd>
                <dt>Closed</dt>
                <dd class="muted">{{ f.sessions.closed }}</dd>
              </dl>
            </article>
          }

          @if (engine(); as e) {
            <article class="kpi-card" [attr.data-tone]="dbTier(e.dbLatencyMs)">
              <header class="kpi-head">
                <h4>Engine</h4>
                <span class="kpi-total" [attr.data-tier]="dbTier(e.dbLatencyMs)">
                  {{ e.dbLatencyMs | number: '1.0-0' }} ms
                </span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value" [attr.data-tier]="dbTier(e.dbLatencyMs)">{{
                  e.dbLatencyMs | number: '1.0-0'
                }}</span>
                <span class="hl-label">ms db latency</span>
              </div>
              <dl class="kpi-grid">
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
        <section class="board-card">
          <header class="board-head">
            <h3>EA instances</h3>
            <span class="muted">
              {{ filteredInstances().length }} of {{ instances().length }}
            </span>

            <div class="filter-bar">
              <div class="chip-row" role="tablist" aria-label="Status filter">
                @for (s of statusFilters; track s.value) {
                  <button
                    type="button"
                    class="chip"
                    role="tab"
                    [class.active]="statusFilter() === s.value"
                    [attr.aria-selected]="statusFilter() === s.value"
                    (click)="statusFilter.set(s.value)"
                  >
                    {{ s.label }}
                    <span class="chip-count">{{ statusCount(s.value) }}</span>
                  </button>
                }
              </div>
              <input
                type="search"
                class="filter-input"
                placeholder="Search instance, account, version…"
                [ngModel]="searchTerm()"
                (ngModelChange)="searchTerm.set($event)"
                aria-label="Search EA instances"
              />
            </div>
          </header>

          @if (instances().length === 0) {
            <p class="empty">No EA instances registered.</p>
          } @else if (filteredInstances().length === 0) {
            <p class="empty">No instances match the current filter.</p>
          } @else {
            <div class="table-scroll table-scroll--events">
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th>Last heartbeat</th>
                    <th class="ctr">Coord</th>
                    <th>Account</th>
                    <th class="row-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of filteredInstances(); track i.instanceId) {
                    <tr [attr.data-status]="i.status">
                      <td class="instance-cell">
                        <span class="mono trunc" [title]="i.instanceId">{{ i.instanceId }}</span>
                      </td>
                      <td>
                        <span class="status-pill" [attr.data-status]="i.status">{{
                          i.status
                        }}</span>
                      </td>
                      <td class="mono">{{ i.eaVersion }}</td>
                      <td>
                        <span [title]="i.lastHeartbeat | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                          {{ i.lastHeartbeat | relativeTime }}
                        </span>
                      </td>
                      <td class="ctr">{{ i.isCoordinator ? '✓' : '' }}</td>
                      <td>#{{ i.tradingAccountId }}</td>
                      <td class="row-actions">
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
            </div>
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

      /* ── Summary cards row ─────────────────────────────────────── */
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: var(--space-3);
        align-items: stretch;
      }
      .kpi-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-left: 3px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-elevated);
        min-height: 168px;
      }
      .kpi-card[data-tone='ok'] {
        border-left-color: #1d8a3e;
      }
      .kpi-card[data-tone='warn'] {
        border-left-color: #cb8a17;
      }
      .kpi-card[data-tone='bad'] {
        border-left-color: #c93631;
      }
      .kpi-card[data-tone='fast'] {
        border-left-color: #1d8a3e;
      }
      .kpi-card[data-tone='slow'] {
        border-left-color: #c93631;
      }
      .kpi-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .kpi-head h4 {
        margin: 0;
        font-size: 11px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .kpi-total {
        font-size: 12px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .kpi-total[data-tier='fast'] {
        color: #1d8a3e;
      }
      .kpi-total[data-tier='warn'] {
        color: #cb8a17;
      }
      .kpi-total[data-tier='slow'] {
        color: #c93631;
      }
      .kpi-headline {
        display: flex;
        align-items: baseline;
        gap: 6px;
        line-height: 1;
      }
      .kpi-headline .hl-value {
        font-size: 30px;
        font-weight: var(--font-bold);
        font-variant-numeric: tabular-nums;
      }
      .kpi-headline .hl-value[data-tier='fast'] {
        color: #1d8a3e;
      }
      .kpi-headline .hl-value[data-tier='warn'] {
        color: #cb8a17;
      }
      .kpi-headline .hl-value[data-tier='slow'] {
        color: #c93631;
      }
      .kpi-headline .hl-sep {
        color: var(--text-tertiary);
        font-size: 22px;
      }
      .kpi-headline .hl-total {
        color: var(--text-secondary);
        font-size: 22px;
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .kpi-headline .hl-label {
        margin-left: auto;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: 1fr auto;
        column-gap: var(--space-3);
        row-gap: 3px;
        margin: 0;
        padding-top: 4px;
        border-top: 1px dashed var(--border);
        font-size: 12px;
      }
      .kpi-grid dt {
        color: var(--text-tertiary);
      }
      .kpi-grid dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* ── Status colors (shared) ───────────────────────────────── */
      .ok {
        color: #1d8a3e;
      }
      .warn {
        color: #cb8a17;
      }
      .bad {
        color: #c93631;
      }
      .muted {
        color: var(--text-secondary);
      }

      /* ── EA instances board ────────────────────────────────────── */
      .board-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-elevated);
        overflow: hidden;
      }
      .board-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .filter-bar {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .chip-row {
        display: inline-flex;
        gap: 4px;
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .chip {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 4px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition:
          background 120ms ease,
          color 120ms ease;
      }
      .chip:hover {
        color: var(--text-primary);
      }
      .chip.active {
        background: var(--bg-elevated);
        color: var(--text-primary);
        box-shadow: 0 0 0 1px var(--border);
      }
      .chip-count {
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .chip.active .chip-count {
        color: var(--text-secondary);
      }
      .filter-input {
        appearance: none;
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--text-primary);
        font-size: 12px;
        padding: 5px 10px;
        border-radius: var(--radius-sm);
        width: 220px;
      }
      .filter-input:focus {
        outline: none;
        border-color: var(--color-accent, #0058b8);
      }

      .table-scroll {
        overflow: auto;
      }
      .table-scroll--events {
        max-height: 560px;
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .board-table th,
      .board-table td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        vertical-align: middle;
      }
      .board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .board-table th.ctr,
      .board-table td.ctr {
        text-align: center;
      }
      .board-table th.row-actions,
      .board-table td.row-actions {
        text-align: right;
        white-space: nowrap;
        width: 1%;
      }

      .instance-cell {
        max-width: 360px;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
      }
      .trunc {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
      }

      /* ── Status pill ───────────────────────────────────────────── */
      .status-pill {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status-pill[data-status='Active'] {
        background: color-mix(in srgb, #1d8a3e 18%, transparent);
        color: #1d8a3e;
      }
      .status-pill[data-status='Disconnected'] {
        background: color-mix(in srgb, #c93631 18%, transparent);
        color: #c93631;
      }
      .status-pill[data-status='ShuttingDown'] {
        background: color-mix(in srgb, #cb8a17 22%, transparent);
        color: #b07412;
      }
      .status-pill[data-status='Deregistered'] {
        background: color-mix(in srgb, #888 18%, transparent);
        color: var(--text-secondary);
      }

      /* ── Detail expand row ─────────────────────────────────────── */
      .btn-link {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 12px;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }
      .btn-link:hover {
        color: var(--text-primary);
        background: var(--bg);
      }
      .detail-row td {
        background: var(--bg-tertiary);
        padding: var(--space-3) var(--space-4);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
      }
      .detail-grid h5 {
        margin: 0 0 6px 0;
        font-size: 11px;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      dl.kv-compact {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 3px 12px;
        margin: 0;
        font-size: 12px;
      }
      dl.kv-compact dt {
        color: var(--text-secondary);
      }
      dl.kv-compact dd {
        margin: 0;
      }

      .small {
        font-size: 12px;
      }
      .empty {
        margin: 0;
        padding: var(--space-4);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      .btn-secondary {
        padding: 5px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        color: var(--text-primary);
        text-decoration: none;
        font-size: 12px;
        font-weight: var(--font-semibold);
      }
      .btn-secondary:hover {
        background: var(--bg-tertiary);
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

  // ── Filter state ─────────────────────────────────────────────────
  protected readonly statusFilter = signal<'All' | 'Active' | 'Disconnected' | 'ShuttingDown'>(
    'All',
  );
  protected readonly searchTerm = signal<string>('');
  protected readonly statusFilters: ReadonlyArray<{
    label: string;
    value: 'All' | 'Active' | 'Disconnected' | 'ShuttingDown';
  }> = [
    { label: 'All', value: 'All' },
    { label: 'Active', value: 'Active' },
    { label: 'Disconnected', value: 'Disconnected' },
    { label: 'Shutting down', value: 'ShuttingDown' },
  ];

  protected statusCount(value: 'All' | 'Active' | 'Disconnected' | 'ShuttingDown'): number {
    const xs = this.instances();
    if (value === 'All') return xs.length;
    return xs.filter((i) => i.status === value).length;
  }

  protected readonly filteredInstances = computed(() => {
    const status = this.statusFilter();
    const term = this.searchTerm().trim().toLowerCase();
    const xs = this.instances();
    return xs.filter((i) => {
      if (status !== 'All' && i.status !== status) return false;
      if (term.length === 0) return true;
      return (
        i.instanceId.toLowerCase().includes(term) ||
        (i.eaVersion ?? '').toLowerCase().includes(term) ||
        String(i.tradingAccountId).includes(term)
      );
    });
  });

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
  /**
   * EA-card tone. Bad when anything is disconnected, warn when stale-idle
   * but still nominally connected, ok otherwise. Surfacing this on the
   * left border lets a glance over the dashboard immediately tell
   * "fleet healthy" vs "something to look at".
   */
  protected eaTone(f: FleetObservabilityDto): 'ok' | 'warn' | 'bad' {
    if (f.eas.disconnected > 0) return 'bad';
    if (f.eas.idleOverStale > 0) return 'warn';
    return 'ok';
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
