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
import { EAInstancesService } from '@core/services/ea-instances.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EAInstanceDto, TradingAccountDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

import {
  type AccountModeClass,
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
        <button class="btn btn-primary" (click)="onAddBroker()">+ Add Broker</button>
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
        />
        <app-metric-card
          label="Active accounts"
          [value]="dataUnavailable() ? null : activeAccountsCount()"
          format="number"
          [dotColor]="inactiveAccountsCount() > 0 ? '#FF9500' : '#34C759'"
        />
        <app-metric-card
          label="Active EAs"
          [value]="dataUnavailable() ? null : activeEaCount()"
          format="number"
          [dotColor]="anyEaDisconnected() ? '#FF3B30' : '#34C759'"
        />
        <app-metric-card
          label="Total balance"
          [value]="dataUnavailable() ? null : totalBalance()"
          format="currency"
          dotColor="#0071E3"
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
            <span class="muted">
              grouped by broker server family · {{ inactiveAccountsCount() }} inactive account(s) ·
              {{ disconnectedEaCount() }} disconnected EA(s) · refreshes every 15s
            </span>
          </header>
          @if (brokers().length > 0) {
            <div class="broker-grid">
              @for (b of brokers(); track b.key) {
                <article class="broker-card">
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
            <span class="muted">{{ accounts().length }} record(s) · sorted by broker, then ID</span>
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
                    <th class="num">Margin avail.</th>
                    <th class="num">Util %</th>
                    <th>Status</th>
                    <th class="num">Last sync</th>
                  </tr>
                </thead>
                <tbody>
                  @for (a of sortedAccounts(); track a.id) {
                    <tr>
                      <td class="mono">{{ a.id }}</td>
                      <td>
                        {{ brokerKeyOf(a) }}
                        @if (a.brokerServer) {
                          <span class="muted nowrap">· {{ a.brokerServer }}</span>
                        }
                      </td>
                      <td class="mono">{{ a.accountId ?? '—' }}</td>
                      <td>{{ a.accountName ?? '—' }}</td>
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
            <span class="muted"
              >{{ eaInstances().length }} record(s) · sorted by account, then instance</span
            >
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
                    <th class="num">Heartbeat age</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ea of sortedEaInstances(); track ea.instanceId) {
                    <tr>
                      <td class="mono ea-instance" [title]="ea.instanceId">{{ ea.instanceId }}</td>
                      <td class="mono">{{ ea.tradingAccountId }}</td>
                      <td>
                        <span
                          class="status-pill"
                          [class.active]="ea.status === 'Active'"
                          [class.idle]="ea.status === 'ShuttingDown'"
                          [class.down]="ea.status === 'Disconnected'"
                        >
                          {{ statusLabel(ea.status) }}
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
                        [class.loss]="heartbeatAgeSec(ea) !== null && heartbeatAgeSec(ea)! > 120"
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
      /* minmax(0, 1fr) — a bare 1fr track can't shrink below its content's
         min-width, which is what pushed the eight-tile row 235px past the
         content column. Six equal tracks that may shrink to zero never do. */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
        margin-top: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1200px) {
        .kpi-strip {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
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
      .broker-title {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .broker-id {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-sm);
        font-weight: var(--font-bold);
        color: var(--text-primary);
        text-decoration: none;
      }
      .broker-id:hover {
        color: var(--accent);
      }
      .broker-server {
        font-size: 10.5px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .broker-tags {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        flex-shrink: 0;
      }
      .tag {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      /* Account-type palette shared by the card tags and the table pills:
         real money = green, demo = blue, contest = purple, paper = grey. */
      .tag.real,
      .mode-pill[data-mode='real'] {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .tag.demo,
      .mode-pill[data-mode='demo'] {
        background: rgba(0, 113, 227, 0.14);
        color: #0040dd;
      }
      .tag.contest,
      .mode-pill[data-mode='contest'] {
        background: rgba(175, 82, 222, 0.14);
        color: #6f2dbd;
      }
      .tag.paper,
      .mode-pill[data-mode='paper'] {
        background: rgba(142, 142, 147, 0.16);
        color: var(--text-secondary);
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
      /* Twelve columns don't fit every viewport; scroll the table inside
         its card rather than letting it widen the page. */
      .table-scroll {
        overflow-x: auto;
      }
      .grid-table {
        width: 100%;
        border-collapse: collapse;
      }
      .nowrap {
        white-space: nowrap;
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
      /* Instance ids are "LASC-MULTI-10-9480-1342…4849480": the numeric
         suffix is the part that tells instances apart, so a mid-string
         ellipsis hid exactly the distinguishing bit. Wrap at the hyphens
         instead and keep the whole id readable. */
      .grid-table .ea-instance {
        max-width: 260px;
        font-size: 11px;
        overflow-wrap: anywhere;
        line-height: 1.35;
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
        white-space: nowrap;
      }
      .status-pill.active {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
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
  /** Why the last account fetch failed, or null. */
  readonly loadError = signal<string | null>(null);
  /** No account data on screen and the fetch is failing — show the error, not an empty fleet. */
  readonly dataUnavailable = computed(
    () => this.loadError() !== null && this.accounts().length === 0,
  );

  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly eaInstances = signal<EAInstanceDto[]>([]);
  readonly nowMs = signal(Date.now());

  brokerKeyOf(a: TradingAccountDto): string {
    return brokerKeyOf(a);
  }

  /** Distinct brokers with derived aggregates — same grouping the detail page resolves. */
  readonly brokers = computed<BrokerGroup[]>(() =>
    buildBrokerGroups(this.accounts(), this.eaInstances(), this.nowMs()),
  );

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
      eas: this.eaService.list().pipe(catchError(() => of(null))),
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
        if (eas?.data) this.eaInstances.set(eas.data);
      });
  }

  /** Engine enum → words: "ShuttingDown" is not copy. */
  statusLabel(status: string): string {
    switch (status) {
      case 'ShuttingDown':
        return 'Shutting down';
      case 'Disconnected':
        return 'Disconnected';
      case 'Active':
        return 'Active';
      default:
        return status || '—';
    }
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

  heartbeatAgeSec(ea: EAInstanceDto): number | null {
    return ageSec(ea.lastHeartbeat, this.nowMs());
  }

  eaSymbols(ea: EAInstanceDto): string[] {
    return eaSymbols(ea);
  }

  formatAge(sec: number): string {
    return formatAge(sec);
  }

  onAddBroker(): void {
    this.notifications.info(
      'Add Broker dialog coming soon — engine ships no Broker resource yet; provision a TradingAccount with a brokerName in the Accounts page for now.',
    );
  }
}
