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
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/** Rows per page on the instance board. */
const PAGE_SIZE = 25;

/** Fallback liveness window when the fleet summary has not loaded yet. */
const DEFAULT_STALE_MINUTES = 10;

interface EaStats {
  total: number;
  active: number;
  disconnected: number;
  shuttingDown: number;
  idleOverStale: number;
  coordinatorsLive: number;
  accounts: number;
  versions: number;
}

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
    ErrorStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Fleet Health"
        subtitle="Engine + EA + daemon vitals — refreshes every 10 s."
      >
        <!-- Inline so a refresh never shifts the layout; the old full-width bar reserved a 6px
             grey track between the header and the tiles even when idle. -->
        @if (loading() && !initialLoading()) {
          <span class="refreshing" role="status">Refreshing…</span>
        }
        <a class="btn-secondary" [href]="metricsHref()" target="_blank" rel="noopener"
          >Open /metrics ↗</a
        >
      </app-page-header>

      @if (initialLoading()) {
        <app-card-skeleton [lines]="6" />
      } @else {
        <!-- ── Summary cards row ─────────────────────────────────── -->
        <section class="summary-grid">
          <!--
            Every number on this card is derived from the SAME instance list the table renders,
            so the tile and the table can never disagree. The engine's fleet summary omitted the
            ShuttingDown instances (51 vs 55) and counted coordinators whose last heartbeat was
            months old; those numbers are kept off this card.
          -->
          @if (eaStats(); as s) {
            <article class="kpi-card" [attr.data-tone]="eaTone(s)">
              <header class="kpi-head">
                <h4>EA instances</h4>
                <span class="kpi-total">{{ s.total }}</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value" [class.ok]="s.active > 0">{{ s.active }}</span>
                <span class="hl-sep">/</span>
                <span class="hl-total">{{ s.total }}</span>
                <span class="hl-label">active</span>
              </div>
              <dl class="kpi-grid">
                <dt>Idle &gt;{{ staleMinutes() }}m</dt>
                <dd [class.warn]="s.idleOverStale > 0">{{ s.idleOverStale }}</dd>
                <dt>Disconnected</dt>
                <dd [class.bad]="s.disconnected > 0">{{ s.disconnected }}</dd>
                <dt>Shutting down</dt>
                <dd [class.warn]="s.shuttingDown > 0">{{ s.shuttingDown }}</dd>
                <dt title="Coordinator flag set AND heartbeat inside the liveness window">
                  Coordinators (live)
                </dt>
                <dd>{{ s.coordinatorsLive }}</dd>
                <dt>Accounts</dt>
                <dd>{{ s.accounts }}</dd>
                <dt>Versions</dt>
                <dd>{{ s.versions }}</dd>
              </dl>
            </article>
          } @else {
            <article class="kpi-card" data-tone="neutral">
              <header class="kpi-head">
                <h4>EA instances</h4>
                <span class="kpi-total">—</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value">—</span>
                <span class="hl-label">not loaded</span>
              </div>
              <p class="empty-inline muted">Instance list unavailable — see the board below.</p>
            </article>
          }

          @if (fleet(); as f) {
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

            <!-- Zero running sessions is a fact, not good news: tone and value stay neutral. -->
            <article class="kpi-card" [attr.data-tone]="f.sessions.running > 0 ? 'ok' : 'neutral'">
              <header class="kpi-head">
                <h4>Sessions</h4>
                <span class="kpi-total">{{ f.sessions.running + f.sessions.closed }}</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value" [class.ok]="f.sessions.running > 0">{{
                  f.sessions.running
                }}</span>
                <span class="hl-sep">/</span>
                <span class="hl-total">{{ f.sessions.running + f.sessions.closed }}</span>
                <span class="hl-label">running</span>
              </div>
              <dl class="kpi-grid">
                <dt>Running</dt>
                <dd [class.ok]="f.sessions.running > 0">{{ f.sessions.running }}</dd>
                <dt>Closed</dt>
                <dd class="muted">{{ f.sessions.closed }}</dd>
              </dl>
            </article>
          }

          @if (engine(); as e) {
            <article class="kpi-card" [attr.data-tone]="dbTier(e.dbLatencyMs)">
              <header class="kpi-head">
                <h4>Engine</h4>
                <span class="kpi-total">db latency</span>
              </header>
              <div class="kpi-headline">
                <span class="hl-value" [attr.data-tier]="dbTier(e.dbLatencyMs)">{{
                  e.dbLatencyMs | number: '1.0-0'
                }}</span>
                <span class="hl-unit">ms</span>
                <span class="hl-label">{{ dbTierLabel(e.dbLatencyMs) }}</span>
              </div>
              <dl class="kpi-grid">
                <dt>Open positions</dt>
                <dd>{{ e.openPositions | number }}</dd>
                <dt>Working orders</dt>
                <dd>{{ e.workingOrders | number }}</dd>
                <dt>Active accounts</dt>
                <dd>{{ e.activeAccounts | number }}</dd>
                <dt>Outbox pending</dt>
                @if (e.outboxPending === null) {
                  <dd
                    class="muted"
                    title="The engine did not report an outbox depth — the outbox table may not be enabled on this build."
                  >
                    n/a
                  </dd>
                } @else {
                  <dd [class.warn]="e.outboxPending > 100">{{ e.outboxPending | number }}</dd>
                }
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
                placeholder="Search instances…"
                title="Matches instance id, account id and EA version"
                [ngModel]="searchTerm()"
                (ngModelChange)="searchTerm.set($event)"
                aria-label="Search EA instances"
              />
            </div>
          </header>

          @if (instancesFailed()) {
            <app-error-state
              title="Could not load the EA instance list"
              message="The engine did not return /admin/ea/fleet. The tiles above are read from the same call and stay blank until it succeeds."
              (retry)="instancesResource.refresh()"
            />
          } @else if (instances().length === 0) {
            <p class="empty">No EA instances registered.</p>
          } @else if (filteredInstances().length === 0) {
            <p class="empty">No instances match the current filter.</p>
          } @else {
            <!-- Paged rather than an internal scroll: the scroll surface hid rows 16-55 behind
                 an invisible scrollbar while the header claimed "55 of 55". -->
            <div class="table-scroll">
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th>Last heartbeat</th>
                    <th
                      class="ctr"
                      title="Coordinator flag, shown only while the heartbeat is live"
                    >
                      Coord
                    </th>
                    <th>Account</th>
                    <th class="row-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of pagedInstances(); track i.instanceId) {
                    <tr [attr.data-status]="i.status">
                      <td class="instance-cell">
                        <span class="mono trunc" [title]="i.instanceId">{{ i.instanceId }}</span>
                      </td>
                      <td>
                        <span
                          class="status-pill"
                          [attr.data-status]="displayStatus(i).key"
                          [title]="displayStatus(i).hint"
                          >{{ displayStatus(i).label }}</span
                        >
                      </td>
                      <td class="mono">
                        @if (isReleaseVersion(i.eaVersion)) {
                          {{ i.eaVersion }}
                        } @else {
                          <span class="version-pill" title="Not a release build">
                            {{ i.eaVersion || 'unknown' }}
                          </span>
                        }
                      </td>
                      <td>
                        <span
                          [title]="(i.lastHeartbeat | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC') + ' UTC'"
                        >
                          {{ i.lastHeartbeat | relativeTime }}
                        </span>
                      </td>
                      <td class="ctr">
                        @if (i.isCoordinator && isLive(i)) {
                          ✓
                        } @else if (i.isCoordinator) {
                          <span
                            class="muted"
                            title="Coordinator flag is set but the heartbeat is outside the liveness window"
                            >stale</span
                          >
                        }
                      </td>
                      <td class="mono">#{{ i.tradingAccountId }}</td>
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
            @if (pageCount() > 1) {
              <footer class="pager">
                <span class="muted">
                  {{ pageStart() + 1 }}–{{ pageEnd() }} of {{ filteredInstances().length }}
                </span>
                <div class="pager-controls">
                  <button
                    type="button"
                    class="btn-secondary"
                    [disabled]="page() === 0"
                    (click)="page.set(page() - 1)"
                  >
                    Previous
                  </button>
                  <span class="muted">Page {{ page() + 1 }} of {{ pageCount() }}</span>
                  <button
                    type="button"
                    class="btn-secondary"
                    [disabled]="page() >= pageCount() - 1"
                    (click)="page.set(page() + 1)"
                  >
                    Next
                  </button>
                </div>
              </footer>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      /* Same body inset as every other route — the extra padding put the h1 16px right of
         its siblings. */
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .refreshing {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        align-self: center;
      }

      /* ── Summary cards row ─────────────────────────────────────── */
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .summary-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 600px) {
        .summary-grid {
          grid-template-columns: 1fr;
        }
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
      .kpi-card[data-tone='neutral'] {
        border-left-color: var(--border);
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
      .kpi-headline .hl-unit {
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: var(--font-semibold);
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
        width: 200px;
      }
      .filter-input:focus {
        outline: none;
        border-color: var(--color-accent, #0058b8);
      }

      .table-scroll {
        overflow-x: auto;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .pager-controls {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .pager .btn-secondary {
        font-family: inherit;
        cursor: pointer;
      }
      .pager .btn-secondary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .version-pill {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: color-mix(in srgb, #888 18%, transparent);
        color: var(--text-secondary);
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
      .status-pill[data-status='ShutdownStale'],
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
      .empty-inline {
        margin: 0;
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
  /**
   * Not caught into `[]`: an empty list is "no EAs registered", and a failed call must not be
   * allowed to say that.
   */
  protected readonly instancesResource = createPolledResource(
    () => this.eaAdmin.listFleet().pipe(map((r) => r.data ?? [])),
    { intervalMs: 10_000 },
  );

  protected readonly fleet = computed(() => this.fleetResource.value());
  protected readonly engine = computed(() => this.engineResource.value());
  protected readonly instances = computed(() => this.instancesResource.value() ?? []);
  protected readonly instancesFailed = computed(
    () => this.instancesResource.error() !== null && this.instancesResource.value() === null,
  );

  /** Liveness window, from the engine's fleet summary when available. */
  protected readonly staleMinutes = computed(
    () => this.fleet()?.staleThresholdMinutes ?? DEFAULT_STALE_MINUTES,
  );

  /** Heartbeat inside the liveness window — the only sense in which "coordinator" means anything. */
  protected isLive(i: EAFleetItem): boolean {
    const t = Date.parse(i.lastHeartbeat);
    if (Number.isNaN(t)) return false;
    return Date.now() - t <= this.staleMinutes() * 60_000;
  }

  /**
   * One source of truth for the EA card: the same list the table renders. The engine's summary
   * dropped ShuttingDown from its total and counted coordinators regardless of heartbeat age.
   */
  protected readonly eaStats = computed<EaStats | null>(() => {
    if (this.instancesResource.value() === null) return null;
    const xs = this.instances();
    const accounts = new Set<number>();
    const versions = new Set<string>();
    let active = 0;
    let disconnected = 0;
    let shuttingDown = 0;
    let idleOverStale = 0;
    let coordinatorsLive = 0;
    for (const i of xs) {
      accounts.add(i.tradingAccountId);
      versions.add(i.eaVersion ?? '');
      const live = this.isLive(i);
      if (i.status === 'Active') {
        active++;
        if (!live) idleOverStale++;
      } else if (i.status === 'Disconnected') disconnected++;
      else if (i.status === 'ShuttingDown') shuttingDown++;
      if (i.isCoordinator && live) coordinatorsLive++;
    }
    return {
      total: xs.length,
      active,
      disconnected,
      shuttingDown,
      idleOverStale,
      coordinatorsLive,
      accounts: accounts.size,
      versions: versions.size,
    };
  });

  /**
   * A ShuttingDown row whose heartbeat is months old is not shutting down — the terminal died
   * mid-shutdown and the engine never aged it. Label it so instead of pretending it is in flight.
   */
  protected displayStatus(i: EAFleetItem): { key: string; label: string; hint: string } {
    if (i.status === 'ShuttingDown' && !this.isLive(i)) {
      return {
        key: 'ShutdownStale',
        label: 'Shutdown (stale)',
        hint: `Reported ShuttingDown but no heartbeat for more than ${this.staleMinutes()} minutes`,
      };
    }
    if (i.status === 'ShuttingDown') return { key: i.status, label: 'Shutting down', hint: '' };
    return { key: i.status, label: i.status, hint: '' };
  }

  protected isReleaseVersion(v: string | null | undefined): boolean {
    return /^\d+\.\d+/.test(v ?? '');
  }
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

  // ── Pagination ───────────────────────────────────────────────────
  protected readonly page = signal(0);
  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredInstances().length / PAGE_SIZE)),
  );
  /** Clamped so a filter that shrinks the list never leaves the operator on an empty page. */
  private readonly safePage = computed(() => Math.min(this.page(), this.pageCount() - 1));
  protected readonly pageStart = computed(() => this.safePage() * PAGE_SIZE);
  protected readonly pageEnd = computed(() =>
    Math.min(this.pageStart() + PAGE_SIZE, this.filteredInstances().length),
  );
  protected readonly pagedInstances = computed(() =>
    this.filteredInstances().slice(this.pageStart(), this.pageEnd()),
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
  protected dbTierLabel(ms: number): string {
    const tier = this.dbTier(ms);
    return tier === 'fast' ? 'fast' : tier === 'warn' ? 'slow' : 'very slow';
  }
  /**
   * EA-card tone. Bad when anything is disconnected, warn when stale-idle
   * or stuck shutting down, neutral when nothing is active at all (an
   * empty fleet is not "healthy"), ok otherwise.
   */
  protected eaTone(s: EaStats): 'ok' | 'warn' | 'bad' | 'neutral' {
    if (s.disconnected > 0) return 'bad';
    if (s.idleOverStale > 0 || s.shuttingDown > 0) return 'warn';
    if (s.active === 0) return 'neutral';
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
