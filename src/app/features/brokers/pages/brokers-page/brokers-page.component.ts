import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  OnInit,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subject, catchError, forkJoin, of, takeUntil, timer } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { EAAdminService } from '@core/services/ea-admin.service';
import type { EAFleetItem, TradingAccountDto } from '@core/api/api.types';
import {
  FLEET_STATUS_LABELS,
  currentFleetIds,
  fleetStatusOf,
  type FleetStatus,
} from '@features/ea-instances/current-fleet';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

import {
  type AccountModeClass,
  type BrokerEa,
  type BrokerGroup,
  accountMode,
  ageSec,
  brokerKeyOf,
  buildBrokerGroups,
  eaSymbols,
  formatAge,
} from '../../broker-grouping';

/**
 * Broker connectivity overview. Brokers are derived from the trading accounts
 * (see `broker-grouping.ts` for the key) because the engine ships no
 * first-class Broker resource yet — once one lands, this view can compose its
 * data instead of inferring.
 */
@Component({
  selector: 'app-brokers-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    ErrorStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Brokers"
        subtitle="Connectivity, accounts, and EA fleet — derived from trading-account + EA-instance state"
      >
        <button class="btn btn-secondary" (click)="loadAll()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : '↻ Refresh' }}
        </button>
        <!-- A broker is added by provisioning its MT5 terminal (Terminals → Add broker terminal);
             this used to raise a "coming soon" toast. -->
        <a class="btn btn-primary" routerLink="/terminals">+ Add broker terminal</a>
      </app-page-header>

      <!-- ── KPI strip ─────────────────────────────────────────────── -->
      <!-- Six pure-number tiles. The old strip carried counts as "deltas"
           ("↑ 7.00" under "Active accounts 6" was the *inactive* count) and
           split live/paper into value+delta; neither reads as a change, so
           those splits now live on the broker cards instead. The only delta
           kept is floating P&L, hidden when flat. -->
      <!-- Tiles go to "—" (null) while the account list is failing, so a
           dead engine never reads as a fleet with zero balance. -->
      <div class="kpi-strip">
        <app-metric-card
          label="Brokers"
          [value]="dataUnavailable() ? null : brokers().length"
          format="number"
          dotColor="#0071E3"
          [caption]="accounts().length + ' trading accounts'"
        />
        <app-metric-card
          label="Active accounts"
          [value]="dataUnavailable() ? null : activeAccountsCount()"
          format="number"
          [dotColor]="inactiveAccountsCount() > 0 ? '#FF9500' : '#34C759'"
          [caption]="inactiveAccountsCount() + ' inactive'"
        />
        <app-metric-card
          label="Active EAs"
          [value]="dataUnavailable() ? null : activeEaCount()"
          format="number"
          [dotColor]="anyEaDisconnected() ? '#FF3B30' : '#34C759'"
          [caption]="
            anyEaDisconnected() ? disconnectedEaCount() + ' disconnected' : 'all connected'
          "
        />
        <app-metric-card
          label="Total balance"
          [value]="dataUnavailable() ? null : totalBalance()"
          format="currency"
          dotColor="#0071E3"
          caption="active accounts only"
        />
        <app-metric-card
          label="Total equity"
          [value]="dataUnavailable() ? null : totalEquity()"
          format="currency"
          [dotColor]="floatingPnl() >= 0 ? '#34C759' : '#FF3B30'"
          [delta]="dataUnavailable() ? undefined : floatingPnlDelta()"
        />
        <app-metric-card
          label="Margin used"
          [value]="dataUnavailable() ? null : totalMarginUsed()"
          format="currency"
          [dotColor]="overallMarginUtilizationPct() > 80 ? '#FF3B30' : '#FF9500'"
          [caption]="overallMarginUtilizationPct().toFixed(1) + '% of equity'"
        />
      </div>

      @if (dataUnavailable()) {
        <section class="brokers-section">
          <app-error-state
            title="Could not load broker data"
            [message]="loadError()"
            (retry)="loadAll()"
          />
        </section>
      } @else {
        <!-- ── Per-broker cards ──────────────────────────────────────── -->
        <section class="brokers-section">
          <header class="section-head">
            <h3>Brokers</h3>
            <span class="count-chip">{{ brokers().length }}</span>
            <span class="muted head-note">
              grouped by broker server family · money totals cover active accounts only ·
              {{ inactiveAccountsCount() }} inactive account(s) · {{ disconnectedEaCount() }}
              disconnected EA(s) · refreshes every 15s
            </span>
          </header>
          @if (brokers().length > 0) {
            <div class="broker-grid">
              @for (b of brokers(); track b.key) {
                <article
                  class="broker-card"
                  [class.down]="b.disconnectedEas > 0"
                  [class.live]="b.activeEas > 0 && b.disconnectedEas === 0"
                >
                  <header class="broker-head">
                    <div class="broker-title">
                      <a class="broker-id" [routerLink]="['/brokers', b.slug]">{{ b.key }} ›</a>
                      @if (b.servers.length > 0) {
                        <div class="broker-server" [title]="b.servers.join(', ')">
                          {{ b.servers.join(' · ') }}
                        </div>
                      }
                      @if (b.companies.length > 1) {
                        <div class="broker-server muted" [title]="b.companies.join(' / ')">
                          reported as {{ b.companies.join(' / ') }}
                        </div>
                      }
                    </div>
                    <div class="broker-tags">
                      @if (b.realAccounts > 0) {
                        <span class="tag real">{{ b.realAccounts }} real</span>
                      }
                      @if (b.demoAccounts > 0) {
                        <span class="tag demo">{{ b.demoAccounts }} demo</span>
                      }
                      @if (b.contestAccounts > 0) {
                        <span class="tag contest">{{ b.contestAccounts }} contest</span>
                      }
                      @if (b.paperAccounts > 0) {
                        <span class="tag paper">{{ b.paperAccounts }} paper</span>
                      }
                    </div>
                  </header>
                  <dl class="broker-stats">
                    <div>
                      <dt>Accounts</dt>
                      <dd class="mono">
                        {{ b.accounts.length }} ({{ b.activeAccounts }} active)
                        @if (b.inactiveBalance > 0) {
                          <small
                            class="muted inactive-note"
                            title="Last-synced balance on inactive accounts — not in the totals"
                          >
                            +{{ b.inactiveBalance | currency: 'USD' : 'symbol' : '1.0-0' }} inactive
                          </small>
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>Balance</dt>
                      <dd class="mono">
                        {{ b.totalBalance | currency: 'USD' : 'symbol' : '1.2-2' }}
                      </dd>
                    </div>
                    <div>
                      <dt>Equity</dt>
                      <dd
                        class="mono"
                        [class.profit]="b.totalEquity > b.totalBalance"
                        [class.loss]="b.totalEquity < b.totalBalance"
                      >
                        {{ b.totalEquity | currency: 'USD' : 'symbol' : '1.2-2' }}
                      </dd>
                    </div>
                    <div>
                      <dt>Margin used</dt>
                      <dd class="mono">
                        {{ b.totalMargin | currency: 'USD' : 'symbol' : '1.2-2' }}
                      </dd>
                    </div>
                    <div>
                      <dt>Margin util.</dt>
                      <dd>
                        <div class="util-bar">
                          <span
                            class="util-fill"
                            [class.high]="b.marginUtilizationPct > 75"
                            [class.med]="
                              b.marginUtilizationPct > 50 && b.marginUtilizationPct <= 75
                            "
                            [style.width.%]="Math.min(100, b.marginUtilizationPct)"
                          ></span>
                        </div>
                        <small class="mono">{{ b.marginUtilizationPct.toFixed(1) }}%</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Free margin</dt>
                      <dd class="mono">
                        {{ b.totalMarginAvailable | currency: 'USD' : 'symbol' : '1.2-2' }}
                      </dd>
                    </div>
                  </dl>
                  <div class="broker-fleet">
                    <span class="fleet-title">EA fleet</span>
                    <div class="fleet-pills">
                      <span class="pill active" [class.empty]="b.activeEas === 0">
                        ● {{ b.activeEas }} active
                      </span>
                      @if (b.shuttingDownEas > 0) {
                        <span class="pill idle">○ {{ b.shuttingDownEas }} shutting down</span>
                      }
                      @if (b.disconnectedEas > 0) {
                        <span class="pill down">⊘ {{ b.disconnectedEas }} down</span>
                      }
                      @if (b.activeEas + b.shuttingDownEas + b.disconnectedEas === 0) {
                        <span class="pill empty">no EAs registered</span>
                      }
                    </div>
                    @if (b.newestHeartbeatAgeSec !== null) {
                      <small class="muted">
                        newest heartbeat: {{ formatAge(b.newestHeartbeatAgeSec) }}
                        @if (
                          b.oldestHeartbeatAgeSec !== null &&
                          b.oldestHeartbeatAgeSec !== b.newestHeartbeatAgeSec
                        ) {
                          · oldest: {{ formatAge(b.oldestHeartbeatAgeSec) }}
                        }
                      </small>
                    }
                  </div>
                  @if (b.symbolsCovered.length > 0) {
                    <div class="broker-symbols">
                      <span class="symbols-title">Symbols ({{ b.symbolsCovered.length }})</span>
                      <div class="symbol-chips">
                        @for (s of b.symbolsCovered; track s) {
                          <span class="symbol-chip">{{ s }}</span>
                        }
                      </div>
                    </div>
                  }
                </article>
              }
            </div>
          } @else if (loading()) {
            <div class="empty-state">
              <span class="muted">Loading broker data…</span>
            </div>
          } @else {
            <div class="empty-state">
              <span class="muted">No trading accounts found.</span>
              <span class="empty-hint">
                Brokers materialise once a TradingAccount is created with a brokerName. Use "+ Add
                Broker" to provision the first account.
              </span>
            </div>
          }
        </section>

        <!-- ── Trading accounts table ────────────────────────────────── -->
        <section class="brokers-section">
          <header class="section-head">
            <h3>Trading accounts</h3>
            <span class="count-chip">{{ accounts().length }}</span>
            <span class="muted head-note">sorted by broker, then ID</span>
          </header>
          @if (accounts().length > 0) {
            <div class="table-scroll">
              <table class="grid-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Broker</th>
                    <th>Account</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th class="num">Balance</th>
                    <th class="num">Equity</th>
                    <th class="num">Margin used</th>
                    <th class="num" title="Free margin">Margin free</th>
                    <th class="num" title="Margin used as % of equity">Util</th>
                    <th>Status</th>
                    <th class="num">Last sync</th>
                  </tr>
                </thead>
                <tbody>
                  @for (a of sortedAccounts(); track a.id) {
                    <tr>
                      <td class="mono id-cell">{{ a.id }}</td>
                      <td>
                        <span class="cell-main">{{ brokerKeyOf(a) }}</span>
                        @if (a.brokerServer) {
                          <span class="cell-sub">{{ a.brokerServer }}</span>
                        }
                      </td>
                      <td class="mono">{{ a.accountId ?? '—' }}</td>
                      <td class="name-cell" [title]="a.accountName ?? ''">
                        {{ a.accountName ?? '—' }}
                      </td>
                      <td>
                        <span class="mode-pill" [attr.data-mode]="accountMode(a).cls">
                          {{ accountMode(a).label }}
                        </span>
                      </td>
                      <td class="num mono">
                        {{ a.balance | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                      </td>
                      <td
                        class="num mono"
                        [class.profit]="a.equity > a.balance"
                        [class.loss]="a.equity < a.balance"
                      >
                        {{ a.equity | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                      </td>
                      <td class="num mono">
                        {{ a.marginUsed | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                      </td>
                      <td class="num mono">
                        {{ a.marginAvailable | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                      </td>
                      <td class="num mono">{{ accountUtilPct(a).toFixed(1) }}%</td>
                      <td>
                        <span
                          class="status-pill"
                          [class.active]="a.isActive"
                          [class.inactive]="!a.isActive"
                        >
                          {{ a.isActive ? 'Active' : 'Inactive' }}
                        </span>
                      </td>
                      <td
                        class="num muted nowrap"
                        [title]="a.lastSyncedAt | date: 'MMM d, HH:mm:ss'"
                      >
                        {{ ageLabel(a.lastSyncedAt) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="empty-state">
              <span class="muted">No trading accounts.</span>
            </div>
          }
        </section>

        <!-- ── EA instances table ────────────────────────────────────── -->
        <section class="brokers-section">
          <header class="section-head">
            <h3>EA instances</h3>
            <span class="count-chip">{{ eaInstances().length }}</span>
            <span class="muted head-note">sorted by account, then instance</span>
          </header>
          @if (eaInstances().length > 0) {
            <div class="table-scroll">
              <table class="grid-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Owned symbols</th>
                    <th>Registered</th>
                    <th>Last heartbeat</th>
                    <th class="num" title="Heartbeat age">HB age</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ea of sortedEaInstances(); track ea.instanceId) {
                    <tr>
                      <td class="mono ea-instance" [title]="ea.instanceId">
                        {{ shortInstanceId(ea.instanceId) }}
                      </td>
                      <td class="mono">{{ ea.tradingAccountId }}</td>
                      <td>
                        <span
                          class="status-pill"
                          [class.active]="statusOf(ea) === 'Active'"
                          [class.idle]="statusOf(ea) === 'ShuttingDown'"
                          [class.down]="statusOf(ea) === 'Disconnected'"
                        >
                          {{ statusLabel(statusOf(ea)) }}
                        </span>
                      </td>
                      <td>
                        @if (eaSymbols(ea).length > 0) {
                          <div class="symbol-chips">
                            @for (s of eaSymbols(ea); track s) {
                              <span class="symbol-chip small">{{ s }}</span>
                            }
                          </div>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="muted nowrap">{{ ea.registeredAt | date: 'MMM d, HH:mm' }}</td>
                      <td class="muted nowrap">
                        {{ ea.lastHeartbeat ? (ea.lastHeartbeat | date: 'MMM d, HH:mm:ss') : '—' }}
                      </td>
                      <td
                        class="num mono nowrap"
                        [class.loss]="
                          statusOf(ea) !== 'Deregistered' &&
                          heartbeatAgeSec(ea) !== null &&
                          heartbeatAgeSec(ea)! > 120
                        "
                      >
                        {{ heartbeatAgeSec(ea) === null ? '—' : formatAge(heartbeatAgeSec(ea)!) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="empty-state">
              <span class="muted">No EA instances registered.</span>
              <span class="empty-hint">
                Once an EA registers via <code>POST /ea/register</code>, it appears here.
              </span>
            </div>
          }
        </section>
      }
    </div>
  `,
  styleUrl: './brokers-page.component.scss',
})
export class BrokersPageComponent implements OnInit, OnDestroy {
  /** Expose Math for percentage clamps in the template. */
  protected readonly Math = Math;

  private readonly accountsService = inject(TradingAccountsService);
  private readonly eaAdmin = inject(EAAdminService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly destroy$ = new Subject<void>();

  readonly loading = signal(false);
  /** Why the last account fetch failed, or null. */
  readonly loadError = signal<string | null>(null);
  /** No account data on screen and the fetch is failing — show the error, not an empty fleet. */
  readonly dataUnavailable = computed(
    () => this.loadError() !== null && this.accounts().length === 0,
  );

  readonly accounts = signal<TradingAccountDto[]>([]);
  /** Every registered instance (all statuses), as the engine's fleet list returns it. */
  private readonly fleet = signal<EAFleetItem[]>([]);
  readonly nowMs = signal(Date.now());

  /** The current fleet: live instances plus the ones that dropped off recently or left an active
   *  account without an EA. Recomputed on refresh, not on the 1 s age tick. */
  readonly eaInstances = computed<BrokerEa[]>(() => {
    const active = new Map(this.accounts().map((a) => [a.id, a.isActive]));
    const ids = currentFleetIds(this.fleet(), (id) => active.get(id) === true, Date.now());
    return this.fleet().filter((ea) => ids.has(ea.instanceId));
  });

  brokerKeyOf(a: TradingAccountDto): string {
    return brokerKeyOf(a);
  }

  /** Distinct brokers with derived aggregates — same grouping the detail page resolves. */
  readonly brokers = computed<BrokerGroup[]>(() =>
    buildBrokerGroups(this.accounts(), this.eaInstances(), this.nowMs()),
  );

  // ── Page-wide aggregates ─────────────────────────────────────
  // Active accounts only: an inactive account's snapshot is frozen at its last sync, and summing it
  // put $1.06M of stale balance and the whole $35.5k "margin used" of two dead accounts on the strip.
  private readonly liveAccounts = computed(() => this.accounts().filter((a) => a.isActive));
  readonly totalBalance = computed(() =>
    this.liveAccounts().reduce((acc, a) => acc + (a.balance ?? 0), 0),
  );
  readonly totalEquity = computed(() =>
    this.liveAccounts().reduce((acc, a) => acc + (a.equity ?? 0), 0),
  );
  readonly totalMarginUsed = computed(() =>
    this.liveAccounts().reduce((acc, a) => acc + (a.marginUsed ?? 0), 0),
  );
  readonly totalMarginAvailable = computed(() =>
    this.liveAccounts().reduce((acc, a) => acc + (a.marginAvailable ?? 0), 0),
  );
  readonly overallMarginUtilizationPct = computed(() => {
    const eq = this.totalEquity();
    return eq > 0 ? (this.totalMarginUsed() / eq) * 100 : 0;
  });

  /** Equity − balance across the fleet: the one delta that is a real change. */
  readonly floatingPnl = computed(() => this.totalEquity() - this.totalBalance());
  /** Hidden (undefined) when flat — "↑ $0.00" is not information. */
  readonly floatingPnlDelta = computed<number | undefined>(() => {
    const d = this.floatingPnl();
    return Math.abs(d) < 0.005 ? undefined : d;
  });

  /** Table order: broker family, then engine id — matches the card grouping above. */
  readonly sortedAccounts = computed(() =>
    [...this.accounts()].sort(
      (a, b) => this.brokerKeyOf(a).localeCompare(this.brokerKeyOf(b)) || a.id - b.id,
    ),
  );
  readonly sortedEaInstances = computed(() =>
    [...this.eaInstances()].sort(
      (a, b) => a.tradingAccountId - b.tradingAccountId || a.instanceId.localeCompare(b.instanceId),
    ),
  );

  readonly activeAccountsCount = computed(() => this.accounts().filter((a) => a.isActive).length);
  readonly inactiveAccountsCount = computed(
    () => this.accounts().filter((a) => !a.isActive).length,
  );
  readonly activeEaCount = computed(
    () => this.eaInstances().filter((ea) => ea.status === 'Active').length,
  );
  readonly disconnectedEaCount = computed(
    () => this.eaInstances().filter((ea) => ea.status === 'Disconnected').length,
  );
  readonly anyEaDisconnected = computed(() => this.disconnectedEaCount() > 0);

  ngOnInit(): void {
    this.loadAll();
    // 15s refresh — accounts/EAs change on the same cadence as broker
    // heartbeat (~1s) but the UI doesn't need finer than 15s for the
    // dashboard view; keeps API load low.
    timer(15_000, 15_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadAll());
    // Wall-clock tick so heartbeat-age numbers freshen even between
    // network refreshes.
    timer(1_000, 1_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.nowMs.set(Date.now()));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadAll(): void {
    this.loading.set(true);
    forkJoin({
      accounts: this.accountsService
        .list({ currentPage: 1, itemCountPerPage: 200 })
        .pipe(catchError(() => of(null))),
      eas: this.eaAdmin.listFleet().pipe(catchError(() => of(null))),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe(({ accounts, eas }) => {
        this.loading.set(false);
        if (accounts?.data?.data) {
          this.accounts.set(accounts.data.data);
          this.loadError.set(null);
        } else {
          this.loadError.set(
            accounts?.message || 'The trading-account list did not load. Is the engine reachable?',
          );
        }
        if (eas?.data) this.fleet.set(eas.data);
      });
  }

  /** Engine enum → words: "ShuttingDown" is not copy. */
  statusLabel(status: FleetStatus): string {
    return FLEET_STATUS_LABELS[status] ?? status ?? '—';
  }

  /** A long-silent ShuttingDown row is a finished deregistration (same rule as EA Instances). */
  statusOf(ea: BrokerEa): FleetStatus {
    return fleetStatusOf(ea, Date.now());
  }

  accountUtilPct(a: TradingAccountDto): number {
    const eq = a.equity ?? 0;
    if (eq <= 0) return 0;
    return ((a.marginUsed ?? 0) / eq) * 100;
  }

  accountMode(a: TradingAccountDto): { label: string; cls: AccountModeClass } {
    return accountMode(a);
  }

  /** Compact age ("42s ago") for a timestamp; "—" when missing or unparseable. */
  ageLabel(iso: string | null | undefined): string {
    const s = ageSec(iso, this.nowMs());
    return s === null ? '—' : formatAge(s);
  }

  heartbeatAgeSec(ea: BrokerEa): number | null {
    return ageSec(ea.lastHeartbeat, this.nowMs());
  }

  eaSymbols(ea: BrokerEa): string[] {
    return eaSymbols(ea);
  }

  formatAge(sec: number): string {
    return formatAge(sec);
  }

  /**
   * One-line instance id. Ids look like "LASC-MULTI-6210-134253940642976210-A107699364": the
   * 18-digit terminal hash in the middle is the only part too long to show, so it keeps its last
   * six digits; the prefix, symbol and the account suffix that tell instances apart stay whole.
   * The full id is on the cell's tooltip.
   */
  shortInstanceId(id: string): string {
    return id
      .split('-')
      .map((part) => (/^\d{12,}$/.test(part) ? '…' + part.slice(-6) : part))
      .join('-');
  }
}
