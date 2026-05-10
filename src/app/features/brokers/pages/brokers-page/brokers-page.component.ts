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
import { Subject, catchError, forkJoin, of, takeUntil, timer } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EAInstanceDto, TradingAccountDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Aggregate slice of broker connectivity, derived from `TradingAccount.brokerName`
 * because the engine ships no first-class Broker resource yet — once one
 * lands, this view can compose its data instead of inferring.
 */
interface BrokerGroup {
  brokerName: string;
  brokerServer: string | null;
  accounts: TradingAccountDto[];
  eaInstances: EAInstanceDto[];
  liveAccounts: number;
  paperAccounts: number;
  activeAccounts: number;
  totalBalance: number;
  totalEquity: number;
  totalMargin: number;
  totalMarginAvailable: number;
  marginUtilizationPct: number;
  activeEas: number;
  shuttingDownEas: number;
  disconnectedEas: number;
  newestHeartbeatAgeSec: number | null;
  oldestHeartbeatAgeSec: number | null;
  symbolsCovered: string[];
}

@Component({
  selector: 'app-brokers-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, PageHeaderComponent, MetricCardComponent, RelativeTimePipe],
  template: `
    <div class="page">
      <app-page-header
        title="Brokers"
        subtitle="Connectivity, accounts, and EA fleet — derived from trading-account + EA-instance state"
      >
        <button class="btn btn-secondary" (click)="loadAll()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : '↻ Refresh' }}
        </button>
        <button class="btn btn-primary" (click)="onAddBroker()">+ Add Broker</button>
      </app-page-header>

      <!-- ── KPI strip (8 cards) ───────────────────────────────────── -->
      <div class="kpi-strip">
        <app-metric-card
          label="Distinct brokers"
          [value]="brokers().length"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Active accounts"
          [value]="activeAccountsCount()"
          format="number"
          dotColor="#0071E3"
          [delta]="inactiveAccountsCount()"
        />
        <app-metric-card
          label="Active EAs"
          [value]="activeEaCount()"
          format="number"
          [dotColor]="anyEaDisconnected() ? '#FF3B30' : '#34C759'"
          [delta]="disconnectedEaCount()"
        />
        <app-metric-card
          label="Live / Paper"
          [value]="liveAccountsCount()"
          format="number"
          dotColor="#AF52DE"
          [delta]="paperAccountsCount()"
        />
        <app-metric-card
          label="Total balance"
          [value]="totalBalance()"
          format="currency"
          dotColor="#34C759"
        />
        <app-metric-card
          label="Total equity"
          [value]="totalEquity()"
          format="currency"
          [dotColor]="totalEquity() >= totalBalance() ? '#34C759' : '#FF3B30'"
          [delta]="totalEquity() - totalBalance()"
        />
        <app-metric-card
          label="Margin used"
          [value]="totalMarginUsed()"
          format="currency"
          [dotColor]="overallMarginUtilizationPct() > 80 ? '#FF3B30' : '#FF9500'"
        />
        <app-metric-card
          label="Free margin"
          [value]="totalMarginAvailable()"
          format="currency"
          [dotColor]="totalMarginAvailable() > 0 ? '#34C759' : '#FF3B30'"
        />
      </div>

      <!-- ── Per-broker cards ──────────────────────────────────────── -->
      <section class="brokers-section">
        <header class="section-head">
          <h3>Brokers</h3>
          <span class="muted">
            grouped by <code>TradingAccount.brokerName</code> · refreshes every 15s
          </span>
        </header>
        @if (brokers().length > 0) {
          <div class="broker-grid">
            @for (b of brokers(); track b.brokerName) {
              <article class="broker-card">
                <header class="broker-head">
                  <div class="broker-id">
                    {{ b.brokerName }}
                    @if (b.brokerServer) {
                      <span class="broker-server">· {{ b.brokerServer }}</span>
                    }
                  </div>
                  <div class="broker-tags">
                    @if (b.liveAccounts > 0) {
                      <span class="tag live">{{ b.liveAccounts }} live</span>
                    }
                    @if (b.paperAccounts > 0) {
                      <span class="tag paper">{{ b.paperAccounts }} paper</span>
                    }
                  </div>
                </header>
                <dl class="broker-stats">
                  <div>
                    <dt>Accounts</dt>
                    <dd class="mono">{{ b.accounts.length }} ({{ b.activeAccounts }} active)</dd>
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
                    <dd class="mono">{{ b.totalMargin | currency: 'USD' : 'symbol' : '1.2-2' }}</dd>
                  </div>
                  <div>
                    <dt>Margin util.</dt>
                    <dd>
                      <div class="util-bar">
                        <span
                          class="util-fill"
                          [class.high]="b.marginUtilizationPct > 75"
                          [class.med]="b.marginUtilizationPct > 50 && b.marginUtilizationPct <= 75"
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
          <span class="muted">{{ accounts().length }} record(s)</span>
        </header>
        @if (accounts().length > 0) {
          <table class="grid-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Broker</th>
                <th>Account</th>
                <th>Name</th>
                <th>Mode</th>
                <th class="num">Balance</th>
                <th class="num">Equity</th>
                <th class="num">Margin used</th>
                <th class="num">Margin avail.</th>
                <th class="num">Util %</th>
                <th>Status</th>
                <th>Last sync</th>
              </tr>
            </thead>
            <tbody>
              @for (a of accounts(); track a.id) {
                <tr>
                  <td class="mono">{{ a.id }}</td>
                  <td>{{ a.brokerName ?? '—' }}</td>
                  <td class="mono">{{ a.accountId ?? '—' }}</td>
                  <td>{{ a.accountName ?? '—' }}</td>
                  <td>
                    <span class="mode-pill" [class.paper]="a.isPaper" [class.live]="!a.isPaper">
                      {{ a.isPaper ? 'Paper' : 'Live' }}
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
                  <td class="muted">{{ a.lastSyncedAt | relativeTime }}</td>
                </tr>
              }
            </tbody>
          </table>
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
          <span class="muted">{{ eaInstances().length }} record(s)</span>
        </header>
        @if (eaInstances().length > 0) {
          <table class="grid-table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Account</th>
                <th>Status</th>
                <th>Owned symbols</th>
                <th>Registered</th>
                <th>Last heartbeat</th>
                <th class="num">Heartbeat age</th>
              </tr>
            </thead>
            <tbody>
              @for (ea of eaInstances(); track ea.instanceId) {
                <tr>
                  <td class="mono ea-instance">{{ ea.instanceId }}</td>
                  <td class="mono">{{ ea.tradingAccountId }}</td>
                  <td>
                    <span
                      class="status-pill"
                      [class.active]="ea.status === 'Active'"
                      [class.idle]="ea.status === 'ShuttingDown'"
                      [class.down]="ea.status === 'Disconnected'"
                    >
                      {{ ea.status }}
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
                  <td class="muted">{{ ea.registeredAt | relativeTime }}</td>
                  <td class="muted">{{ ea.lastHeartbeat | date: 'HH:mm:ss' }}</td>
                  <td
                    class="num mono"
                    [class.profit]="heartbeatAgeSec(ea) !== null && heartbeatAgeSec(ea)! < 30"
                    [class.loss]="heartbeatAgeSec(ea) !== null && heartbeatAgeSec(ea)! > 120"
                  >
                    {{ heartbeatAgeSec(ea) === null ? '—' : formatAge(heartbeatAgeSec(ea)!) }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty-state">
            <span class="muted">No EA instances registered.</span>
            <span class="empty-hint">
              Once an EA registers via <code>POST /ea/register</code>, it appears here.
            </span>
          </div>
        }
      </section>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        padding: var(--space-2) 0;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .btn:active {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }

      /* ── KPI strip ────────────────────────────────────────────── */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      @media (max-width: 1400px) {
        .kpi-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* ── Sections ─────────────────────────────────────────────── */
      .brokers-section {
        margin-top: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .section-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      code {
        font-size: 11px;
        background: var(--bg-tertiary);
        padding: 1px 4px;
        border-radius: 3px;
      }

      /* ── Broker cards grid ────────────────────────────────────── */
      .broker-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }
      .broker-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .broker-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
      }
      .broker-id {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-sm);
        font-weight: var(--font-bold);
        color: var(--text-primary);
      }
      .broker-tags {
        display: flex;
        gap: 4px;
      }
      .tag {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .tag.live {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .tag.paper {
        background: rgba(0, 113, 227, 0.14);
        color: #0040dd;
      }

      .broker-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px var(--space-3);
        margin: 0;
      }
      .broker-stats > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .broker-stats dt {
        font-size: 9.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .broker-stats dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .util-bar {
        position: relative;
        height: 6px;
        background: rgba(142, 142, 147, 0.18);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 2px;
      }
      .util-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        background: #0071e3;
        border-radius: 3px;
      }
      .util-fill.med {
        background: #ff9500;
      }
      .util-fill.high {
        background: #ff3b30;
      }

      .broker-fleet {
        border-top: 1px dashed var(--border);
        padding-top: var(--space-2);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .fleet-title,
      .symbols-title {
        font-size: 9.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-semibold);
      }
      .fleet-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .pill {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(142, 142, 147, 0.14);
        color: var(--text-secondary);
      }
      .pill.active {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .pill.active.empty {
        background: rgba(142, 142, 147, 0.14);
        color: var(--text-secondary);
      }
      .pill.idle {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .pill.down {
        background: rgba(255, 59, 48, 0.14);
        color: #b91c1c;
      }

      .broker-symbols {
        border-top: 1px dashed var(--border);
        padding-top: var(--space-2);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .symbol-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .symbol-chip {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        font-weight: var(--font-medium);
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        color: var(--text-secondary);
      }
      .symbol-chip.small {
        font-size: 10px;
        padding: 0 5px;
      }

      /* ── Tables ───────────────────────────────────────────────── */
      .grid-table {
        width: 100%;
        border-collapse: collapse;
      }
      .grid-table th,
      .grid-table td {
        padding: var(--space-2) var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .grid-table tbody tr:last-child td {
        border-bottom: none;
      }
      .grid-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .grid-table th.num,
      .grid-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .grid-table .ea-instance {
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mode-pill,
      .status-pill {
        display: inline-block;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 10px;
        border-radius: 999px;
        background: rgba(142, 142, 147, 0.14);
        color: var(--text-secondary);
      }
      .mode-pill.live,
      .status-pill.active {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .mode-pill.paper {
        background: rgba(0, 113, 227, 0.14);
        color: #0040dd;
      }
      .status-pill.idle {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .status-pill.down,
      .status-pill.inactive {
        background: rgba(255, 59, 48, 0.14);
        color: #b91c1c;
      }

      /* ── Shared utility ───────────────────────────────────────── */
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .profit {
        color: var(--profit, #15803d);
      }
      .loss {
        color: var(--loss, #b91c1c);
      }
      .empty-state {
        padding: var(--space-6) var(--space-4);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
        text-align: center;
      }
      .empty-hint {
        font-size: 10.5px;
        color: var(--text-tertiary);
        max-width: 480px;
        line-height: 1.5;
      }
    `,
  ],
})
export class BrokersPageComponent implements OnInit, OnDestroy {
  /** Expose Math for percentage clamps in the template. */
  protected readonly Math = Math;

  private readonly accountsService = inject(TradingAccountsService);
  private readonly eaService = inject(EAInstancesService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly destroy$ = new Subject<void>();

  readonly loading = signal(false);

  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly eaInstances = signal<EAInstanceDto[]>([]);
  readonly nowMs = signal(Date.now());

  /** Distinct broker names with derived aggregates. Sorted by accounts desc. */
  readonly brokers = computed<BrokerGroup[]>(() => {
    const now = this.nowMs();
    const accountsByBroker = new Map<string, TradingAccountDto[]>();
    const serverByBroker = new Map<string, string | null>();
    for (const a of this.accounts()) {
      const k = a.brokerName ?? '—';
      const bucket = accountsByBroker.get(k) ?? [];
      bucket.push(a);
      accountsByBroker.set(k, bucket);
      // Capture the broker server (typically same across accounts for one broker)
      if (!serverByBroker.has(k)) serverByBroker.set(k, a.brokerServer);
    }

    // EA → tradingAccountId → broker mapping
    const eaByBroker = new Map<string, EAInstanceDto[]>();
    const accountIdToBroker = new Map<number, string>();
    for (const a of this.accounts()) accountIdToBroker.set(a.id, a.brokerName ?? '—');
    for (const ea of this.eaInstances()) {
      const brokerName = accountIdToBroker.get(ea.tradingAccountId);
      if (brokerName === undefined) continue;
      const bucket = eaByBroker.get(brokerName) ?? [];
      bucket.push(ea);
      eaByBroker.set(brokerName, bucket);
    }

    const out: BrokerGroup[] = [];
    for (const [brokerName, accounts] of accountsByBroker) {
      const eaInstances = eaByBroker.get(brokerName) ?? [];
      const totalBalance = accounts.reduce((acc, a) => acc + (a.balance ?? 0), 0);
      const totalEquity = accounts.reduce((acc, a) => acc + (a.equity ?? 0), 0);
      const totalMargin = accounts.reduce((acc, a) => acc + (a.marginUsed ?? 0), 0);
      const totalMarginAvailable = accounts.reduce((acc, a) => acc + (a.marginAvailable ?? 0), 0);
      const marginUtilizationPct = totalEquity > 0 ? (totalMargin / totalEquity) * 100 : 0;
      const liveAccounts = accounts.filter((a) => !a.isPaper).length;
      const paperAccounts = accounts.filter((a) => a.isPaper).length;
      const activeAccounts = accounts.filter((a) => a.isActive).length;
      const activeEas = eaInstances.filter((ea) => ea.status === 'Active').length;
      const shuttingDownEas = eaInstances.filter((ea) => ea.status === 'ShuttingDown').length;
      const disconnectedEas = eaInstances.filter((ea) => ea.status === 'Disconnected').length;
      const heartbeats = eaInstances
        .map((ea) =>
          ea.lastHeartbeat
            ? Math.max(0, (now - new Date(ea.lastHeartbeat).getTime()) / 1000)
            : null,
        )
        .filter((v): v is number => v !== null);
      const newestHeartbeatAgeSec = heartbeats.length > 0 ? Math.min(...heartbeats) : null;
      const oldestHeartbeatAgeSec = heartbeats.length > 0 ? Math.max(...heartbeats) : null;
      const symbolsCovered = Array.from(
        new Set(
          eaInstances.flatMap((ea) =>
            (ea.symbols ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        ),
      ).sort();

      out.push({
        brokerName,
        brokerServer: serverByBroker.get(brokerName) ?? null,
        accounts,
        eaInstances,
        liveAccounts,
        paperAccounts,
        activeAccounts,
        totalBalance,
        totalEquity,
        totalMargin,
        totalMarginAvailable,
        marginUtilizationPct,
        activeEas,
        shuttingDownEas,
        disconnectedEas,
        newestHeartbeatAgeSec,
        oldestHeartbeatAgeSec,
        symbolsCovered,
      });
    }
    return out.sort((a, b) => b.accounts.length - a.accounts.length);
  });

  // ── Page-wide aggregates ─────────────────────────────────────
  readonly totalBalance = computed(() =>
    this.accounts().reduce((acc, a) => acc + (a.balance ?? 0), 0),
  );
  readonly totalEquity = computed(() =>
    this.accounts().reduce((acc, a) => acc + (a.equity ?? 0), 0),
  );
  readonly totalMarginUsed = computed(() =>
    this.accounts().reduce((acc, a) => acc + (a.marginUsed ?? 0), 0),
  );
  readonly totalMarginAvailable = computed(() =>
    this.accounts().reduce((acc, a) => acc + (a.marginAvailable ?? 0), 0),
  );
  readonly overallMarginUtilizationPct = computed(() => {
    const eq = this.totalEquity();
    return eq > 0 ? (this.totalMarginUsed() / eq) * 100 : 0;
  });

  readonly activeAccountsCount = computed(() => this.accounts().filter((a) => a.isActive).length);
  readonly inactiveAccountsCount = computed(
    () => this.accounts().filter((a) => !a.isActive).length,
  );
  readonly liveAccountsCount = computed(() => this.accounts().filter((a) => !a.isPaper).length);
  readonly paperAccountsCount = computed(() => this.accounts().filter((a) => a.isPaper).length);
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
      eas: this.eaService.list().pipe(catchError(() => of(null))),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe(({ accounts, eas }) => {
        this.loading.set(false);
        if (accounts?.data?.data) this.accounts.set(accounts.data.data);
        if (eas?.data) this.eaInstances.set(eas.data);
      });
  }

  accountUtilPct(a: TradingAccountDto): number {
    const eq = a.equity ?? 0;
    if (eq <= 0) return 0;
    return ((a.marginUsed ?? 0) / eq) * 100;
  }

  heartbeatAgeSec(ea: EAInstanceDto): number | null {
    if (!ea.lastHeartbeat) return null;
    const t = new Date(ea.lastHeartbeat).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor((this.nowMs() - t) / 1000));
  }

  /** Split the engine's CSV `symbols` field into a clean array. */
  eaSymbols(ea: EAInstanceDto): string[] {
    if (!ea?.symbols) return [];
    return ea.symbols
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  formatAge(ageSec: number): string {
    if (ageSec < 60) return `${Math.floor(ageSec)}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86400)}d ago`;
  }

  onAddBroker(): void {
    this.notifications.info(
      'Add Broker dialog coming soon — engine ships no Broker resource yet; provision a TradingAccount with a brokerName in the Accounts page for now.',
    );
  }
}
