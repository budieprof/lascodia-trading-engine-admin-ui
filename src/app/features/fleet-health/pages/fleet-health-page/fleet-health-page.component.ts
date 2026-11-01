import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ObservabilityService } from '@core/services/observability.service';
import { EAAdminService } from '@core/services/ea-admin.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
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

import { dbTier, EaStats, FleetVerdict, fleetVerdict } from './fleet-verdict';

/** Rows per page on the instance board. */
const PAGE_SIZE = 25;

/** Fallback liveness window when the fleet summary has not loaded yet. */
const DEFAULT_STALE_MINUTES = 10;

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
  styleUrl: './fleet-health-page.component.scss',
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
        <!-- /metrics is served by the engine itself, never through Caddy: through the tunnel
             there is nothing to link to (the old host:5081 link was dead off this machine). -->
        @if (metricsHref(); as href) {
          <a class="btn-secondary" [href]="href" target="_blank" rel="noopener">Open /metrics ↗</a>
        }
      </app-page-header>

      @if (initialLoading()) {
        <app-card-skeleton [lines]="6" />
      } @else {
        <!-- ── Verdict: the answer to "is anything wrong?", from the same numbers as the tiles ── -->
        @let v = verdict();
        <section class="verdict" [attr.data-tone]="v.tone" role="status">
          <span class="verdict-dot" aria-hidden="true"></span>
          <strong class="verdict-head">{{ v.headline }}</strong>
          @if (v.issues.length > 1) {
            <ul class="verdict-list">
              @for (it of v.issues; track it.text) {
                <li [attr.data-tone]="it.tone">{{ it.text }}</li>
              }
            </ul>
          } @else if (v.issues.length === 0) {
            <span class="verdict-facts">{{ v.facts.join(' · ') }}</span>
          }
          @if (eaStats(); as s) {
            @if (s.disconnected - s.disconnectedRecent > 0) {
              <span
                class="verdict-note"
                title="Disconnected instances whose last heartbeat is more than 24 h old — instance ids retired by restarts and upgrades. Listed below, greyed out."
              >
                {{ s.disconnected - s.disconnectedRecent }} disconnected for over 24 h — retired
                ids, greyed below
              </span>
            }
          }
        </section>

        <!-- ── Summary cards row ─────────────────────────────────── -->
        <section class="summary-grid">
          <!--
            Every number on this card is derived from the SAME instance list the table renders,
            so the tile and the table can never disagree. The engine's fleet summary leaves out
            deregistered instances, so its total is not this card's; its coordinator count is
            live-only since 2026-10-19, the same rule as "Coordinators (live)" here.
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
              <dl class="kpi-grid pairs">
                <dt>Idle &gt;{{ staleMinutes() }}m</dt>
                <dd [class.warn]="s.idleOverStale > 0">{{ s.idleOverStale }}</dd>
                <!-- Red only for a recent drop: 48 Disconnected rows are mostly retired instance ids
                     from restarts months ago, and a permanently red card stops meaning anything. -->
                <dt title="Every instance the engine marked Disconnected, retired ids included">
                  Disconnected
                </dt>
                <dd [class.bad]="s.disconnectedRecent > 0">{{ s.disconnected }}</dd>
                <dt title="Disconnected with a last heartbeat inside the past 24 hours">
                  · dropped in 24h
                </dt>
                <dd [class.bad]="s.disconnectedRecent > 0">{{ s.disconnectedRecent }}</dd>
                <dt title="Deregistered and still heartbeating inside the liveness window">
                  Shutting down
                </dt>
                <dd [class.warn]="s.shuttingDown > 0">{{ s.shuttingDown }}</dd>
                <dt
                  title="Deregistered cleanly (OnDeinit) and silent since. The engine keeps them as ShuttingDown for good — they are finished, not in flight."
                >
                  Deregistered
                </dt>
                <dd class="muted">{{ s.deregistered }}</dd>
                <dt
                  title="Coordinator flag set on an Active instance whose heartbeat is inside the liveness window — the engine's rule for its fleet summary"
                >
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
                <dt
                  title="Every order not yet terminal — Pending, Submitted, PartiallyFilled AND Cancelling. Engine Overview's 'Pending orders' counts Pending only."
                >
                  Working orders
                </dt>
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
                      title="Coordinator flag, shown only on an Active instance with a live heartbeat"
                    >
                      Coord
                    </th>
                    <th>Account</th>
                    <th class="row-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of pagedInstances(); track i.instanceId) {
                    <tr [attr.data-status]="i.status" [class.quiet]="!isLive(i)">
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
                        @if (isLiveCoordinator(i)) {
                          ✓
                        } @else if (i.isCoordinator) {
                          <span
                            class="muted"
                            title="Coordinator flag is set but the instance is not Active with a live heartbeat — the flag is not cleared when an EA goes quiet"
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
                                  <dd
                                    [class.bad]="isSafetyStopped(d.highlights?.safetyStopCategory)"
                                  >
                                    {{ d.highlights?.safetyStopCategory ?? 'NONE' }}
                                  </dd>
                                  <dt>Market</dt>
                                  <dd>{{ d.highlights?.marketState ?? '—' }}</dd>
                                  <dt>Broker connected</dt>
                                  <dd [attr.data-good]="boolGood(d.highlights?.brokerConnected)">
                                    {{ boolEmoji(d.highlights?.brokerConnected) }}
                                  </dd>
                                  <dt>Engine reachable</dt>
                                  <dd [attr.data-good]="boolGood(d.highlights?.engineReachable)">
                                    {{ boolEmoji(d.highlights?.engineReachable) }}
                                  </dd>
                                  <dt>Kill switch</dt>
                                  <dd
                                    [attr.data-good]="
                                      boolGood(d.highlights?.killSwitchActive, true)
                                    "
                                  >
                                    {{ boolEmoji(d.highlights?.killSwitchActive, true) }}
                                  </dd>
                                </dl>
                              </div>
                              <div>
                                <h5>Latency</h5>
                                <dl class="kv-compact">
                                  <dt>HTTP P95</dt>
                                  <dd>{{ withUnit(d.highlights?.latencyP95Ms, 'ms') }}</dd>
                                  <dt>HTTP P99</dt>
                                  <dd>{{ withUnit(d.highlights?.latencyP99Ms, 'ms') }}</dd>
                                  <dt>HTTP success</dt>
                                  <dd>
                                    {{
                                      pct($safeNavigationMigration(d.highlights?.httpSuccessRate))
                                    }}
                                  </dd>
                                  <dt>HTTP circuit</dt>
                                  <dd
                                    [attr.data-good]="boolGood(d.highlights?.httpCircuitOpen, true)"
                                  >
                                    {{ boolEmoji(d.highlights?.httpCircuitOpen, true) }}
                                  </dd>
                                  <dt>Last tick age</dt>
                                  <dd>{{ withUnit(d.highlights?.lastTickAgeSec, 's') }}</dd>
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
                                    {{
                                      isNum(d.highlights?.dailyPnL)
                                        ? (d.highlights!.dailyPnL | number: '1.2-2')
                                        : '—'
                                    }}
                                  </dd>
                                  <dt>GVar usage</dt>
                                  <dd>
                                    {{
                                      isNum(d.highlights?.gvarTotal)
                                        ? d.highlights!.gvarTotal + ' / 4096'
                                        : '—'
                                    }}
                                  </dd>
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
})
export class FleetHealthPageComponent {
  private readonly observ = inject(ObservabilityService);
  private readonly eaAdmin = inject(EAAdminService);
  private readonly runtimeConfig = inject(RUNTIME_CONFIG);

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
   * The engine's rule (ObservabilityQueries, 2026-10-19): the flag on an Active instance with a
   * live heartbeat. The flag itself is never cleared when an EA goes quiet.
   */
  protected isLiveCoordinator(i: EAFleetItem): boolean {
    return i.isCoordinator && i.status === 'Active' && this.isLive(i);
  }

  /**
   * One source of truth for the EA card: the same list the table renders. The engine's summary
   * leaves deregistered rows out of its total (and, before 2026-10-19, counted coordinators
   * regardless of heartbeat age).
   */
  protected readonly eaStats = computed<EaStats | null>(() => {
    if (this.instancesResource.value() === null) return null;
    const xs = this.instances();
    const accounts = new Set<number>();
    const versions = new Set<string>();
    let active = 0;
    let disconnected = 0;
    let disconnectedRecent = 0;
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    let shuttingDown = 0;
    let deregistered = 0;
    let idleOverStale = 0;
    let coordinatorsLive = 0;
    for (const i of xs) {
      accounts.add(i.tradingAccountId);
      versions.add(i.eaVersion ?? '');
      const live = this.isLive(i);
      if (i.status === 'Active') {
        active++;
        if (!live) idleOverStale++;
      } else if (i.status === 'Disconnected') {
        disconnected++;
        if (Date.parse(i.lastHeartbeat) >= dayAgo) disconnectedRecent++;
      } else if (i.status === 'ShuttingDown') {
        if (live) shuttingDown++;
        else deregistered++;
      }
      if (this.isLiveCoordinator(i)) coordinatorsLive++;
    }
    return {
      total: xs.length,
      active,
      disconnected,
      disconnectedRecent,
      shuttingDown,
      deregistered,
      idleOverStale,
      coordinatorsLive,
      accounts: accounts.size,
      versions: versions.size,
    };
  });

  /** Headline over the tiles — derived from the same numbers, see fleet-verdict.ts. */
  protected readonly verdict = computed<FleetVerdict>(() => {
    const f = this.fleet();
    const e = this.engine();
    return fleetVerdict({
      stats: this.eaStats(),
      daemons: f ? f.daemons : null,
      dbLatencyMs: e ? e.dbLatencyMs : null,
      outboxPending: e ? e.outboxPending : null,
      staleMinutes: this.staleMinutes(),
    });
  });

  /**
   * ShuttingDown is what the engine sets on a clean deregister (EA OnDeinit) — and it never moves
   * on from there (EAHealthMonitorWorker only ages Active rows). A ShuttingDown row with no
   * heartbeat inside the window is therefore a finished, deregistered instance, not one stuck
   * mid-shutdown: label it that way instead of "Shutdown (stale)".
   */
  protected displayStatus(i: EAFleetItem): { key: string; label: string; hint: string } {
    if (i.status === 'ShuttingDown' && !this.isLive(i)) {
      const at = i.deregisteredAt ?? i.lastHeartbeat;
      return {
        key: 'Deregistered',
        label: 'Deregistered',
        hint: `Deregistered cleanly ${at ? 'at ' + at.slice(0, 16).replace('T', ' ') + ' UTC' : ''} and silent since — the engine keeps the ShuttingDown status for good.`,
      };
    }
    if (i.status === 'ShuttingDown') return { key: i.status, label: 'Shutting down', hint: '' };
    // Red only for a recent drop — the rest are instance ids retired by restarts long ago, and
    // 40+ red pills drowned the one that mattered. Same 24 h rule as the tile.
    if (i.status === 'Disconnected' && !(Date.parse(i.lastHeartbeat) >= Date.now() - 86_400_000)) {
      return {
        key: 'DisconnectedOld',
        label: 'Disconnected',
        hint: 'No heartbeat for over 24 h — most likely an instance id retired by a restart or upgrade.',
      };
    }
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
    // Engine status ShuttingDown — in practice instances that deregistered cleanly and stopped.
    { label: 'Shut down', value: 'ShuttingDown' },
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

  /**
   * The engine's Prometheus endpoint. It is served by the engine, not Caddy: a release bakes
   * apiBaseUrl "" (same origin) and "/metrics" would hit the SPA catch-all, and the old
   * `${hostname}:5081` link was unreachable through the tunnel. On this machine it is
   * localhost:5081; anywhere else there is nothing to link to, so the button is hidden.
   */
  protected readonly metricsHref = signal<string | null>(
    (() => {
      const base = this.runtimeConfig.apiBaseUrl.replace(/\/$/, '');
      if (base) return `${base}/metrics`;
      const host = typeof location === 'undefined' ? '' : location.hostname;
      return host === 'localhost' || host === '127.0.0.1' ? 'http://localhost:5081/metrics' : null;
    })(),
  );

  protected isNum(v: number | null | undefined): v is number {
    return v !== null && v !== undefined && Number.isFinite(v);
  }

  /** "12 ms" / "—" — the old template printed "— ms" when the EA had not reported a value. */
  protected withUnit(v: number | null | undefined, unit: string): string {
    return v == null || !Number.isFinite(v) ? '—' : `${v} ${unit}`;
  }

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
    return dbTier(ms);
  }
  protected dbTierLabel(ms: number): string {
    const tier = this.dbTier(ms);
    return tier === 'fast' ? 'fast' : tier === 'warn' ? 'slow' : 'very slow';
  }
  /**
   * EA-card tone. Bad when an instance dropped in the last 24 h, warn when stale-idle or a
   * shutdown is in flight, neutral when nothing is active at all (an empty fleet is not
   * "healthy"), ok otherwise. Long-retired Disconnected ids and cleanly deregistered instances
   * are history, not a reason to paint the card red forever.
   */
  protected eaTone(s: EaStats): 'ok' | 'warn' | 'bad' | 'neutral' {
    if (s.disconnectedRecent > 0) return 'bad';
    if (s.idleOverStale > 0 || s.shuttingDown > 0) return 'warn';
    if (s.active === 0) return 'neutral';
    return 'ok';
  }
  /** 'yes' when the value is the healthy one, 'no' when not, null when unknown — drives ✓/✗ colour. */
  protected boolGood(v: boolean | null | undefined, invertGreen = false): 'yes' | 'no' | null {
    if (v === null || v === undefined) return null;
    return (invertGreen ? !v : v) ? 'yes' : 'no';
  }
  protected isSafetyStopped(cat: string | null | undefined): boolean {
    return !!cat && cat.toUpperCase() !== 'NONE';
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
