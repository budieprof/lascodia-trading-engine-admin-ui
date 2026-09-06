import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, of, timer } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { TerminalsService } from '@core/services/terminals.service';
import type {
  EAInstanceDto,
  TerminalDaemonDto,
  TerminalInstallDto,
  TerminalSessionDto,
  TradingAccountDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

import {
  type AccountModeClass,
  type BrokerGroup,
  accountMode,
  ageSec,
  brokerKeyOf,
  brokerSlug,
  buildBrokerGroups,
  eaSymbols,
  formatAge,
} from '../../broker-grouping';

/** One MT5 install on a daemon host, joined with its running session if any. */
interface HostInstall {
  daemonId: number;
  daemonName: string;
  daemonOnline: boolean;
  install: TerminalInstallDto;
  /** Trading account (engine id) whose login matches the install, if any. */
  accountId: number | null;
  session: TerminalSessionDto | null;
}

/**
 * One broker, resolved from `/brokers/:id`. The id is the slug the list page
 * links with ("exness"); a numeric id is read as an engine trading-account
 * id and resolves to that account's broker, so an old `/brokers/1` link still
 * lands somewhere real instead of on a placeholder.
 *
 * Brokers are inferred from trading accounts (see `broker-grouping.ts`) —
 * hosts and installs come from the terminal daemons, joined on the broker
 * name and the MT5 login, and are optional: the terminal endpoints are admin
 * scoped and their absence must not blank the page.
 */
@Component({
  selector: 'app-broker-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    ErrorStateComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header [title]="broker()?.key ?? 'Broker'" [subtitle]="subtitle()">
        <button class="btn btn-secondary" (click)="goBack()">← Brokers</button>
        <button class="btn btn-secondary" (click)="loadAll()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </app-page-header>

      @if (loadError() && !broker()) {
        <section class="card">
          <app-error-state
            title="Could not load broker data"
            [message]="loadError()"
            (retry)="loadAll()"
          />
        </section>
      } @else if (loading() && !loaded()) {
        <div class="empty-state"><span class="muted">Loading broker…</span></div>
      } @else if (!broker()) {
        <section class="card">
          <app-empty-state
            title="Broker not found"
            [description]="
              'No trading account resolves to “' +
              routeId() +
              '”. Brokers are derived from trading accounts, so this one may have been renamed or its accounts removed.'
            "
            actionLabel="← Back to Brokers"
            (actionClick)="goBack()"
          />
        </section>
      } @else if (broker(); as b) {
        <!-- ── KPI strip ────────────────────────────────────────── -->
        <div class="kpi-strip">
          <app-metric-card
            label="Accounts"
            [value]="b.accounts.length"
            format="number"
            [dotColor]="b.activeAccounts < b.accounts.length ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Active EAs"
            [value]="b.activeEas"
            format="number"
            [dotColor]="b.disconnectedEas > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Balance"
            [value]="b.totalBalance"
            format="currency"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Equity"
            [value]="b.totalEquity"
            format="currency"
            [dotColor]="floatingPnl() >= 0 ? '#34C759' : '#FF3B30'"
            [delta]="floatingPnlDelta()"
          />
          <app-metric-card
            label="Margin used"
            [value]="b.totalMargin"
            format="currency"
            [dotColor]="b.marginUtilizationPct > 80 ? '#FF3B30' : '#FF9500'"
          />
          <app-metric-card
            label="Free margin"
            [value]="b.totalMarginAvailable"
            format="currency"
            [dotColor]="b.totalMarginAvailable > 0 ? '#34C759' : '#FF3B30'"
          />
        </div>

        <!-- ── Identity · fleet · hosts ─────────────────────────── -->
        <div class="card-grid">
          <section class="card">
            <header class="card-head">
              <h3>Identity</h3>
              <span class="muted">derived from {{ b.accounts.length }} trading account(s)</span>
            </header>
            <dl class="facts">
              <div>
                <dt>Servers</dt>
                <dd>
                  @if (b.servers.length > 0) {
                    <div class="chips">
                      @for (s of b.servers; track s) {
                        <span class="chip mono">{{ s }}</span>
                      }
                    </div>
                  } @else {
                    <span class="muted">not reported</span>
                  }
                </dd>
              </div>
              <div>
                <dt>Reported as</dt>
                <dd>
                  @if (b.companies.length > 0) {
                    {{ b.companies.join(' / ') }}
                  } @else {
                    <span class="muted">not reported</span>
                  }
                </dd>
              </div>
              <div>
                <dt>Platform</dt>
                <dd>{{ platformLabel() }}</dd>
              </div>
              <div>
                <dt>Account types</dt>
                <dd>
                  <div class="chips">
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
                </dd>
              </div>
              <div>
                <dt>Currencies</dt>
                <dd class="mono">{{ b.currencies.length > 0 ? b.currencies.join(', ') : '—' }}</dd>
              </div>
              <div>
                <dt>Margin utilisation</dt>
                <dd>
                  <div class="util-bar">
                    <span
                      class="util-fill"
                      [class.high]="b.marginUtilizationPct > 75"
                      [class.med]="b.marginUtilizationPct > 50 && b.marginUtilizationPct <= 75"
                      [style.width.%]="Math.min(100, b.marginUtilizationPct)"
                    ></span>
                  </div>
                  <small class="mono">{{ b.marginUtilizationPct.toFixed(1) }}% of equity</small>
                </dd>
              </div>
              <div>
                <dt>Last account sync</dt>
                <dd
                  class="mono"
                  [title]="b.lastSyncedAt ? (b.lastSyncedAt | date: 'MMM d, HH:mm:ss') : ''"
                >
                  {{ ageLabel(b.lastSyncedAt) }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="card">
            <header class="card-head">
              <h3>EA fleet</h3>
              <span class="muted">{{ b.eaInstances.length }} instance(s)</span>
            </header>
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
              @if (b.eaInstances.length === 0) {
                <span class="pill">no EAs registered</span>
              }
            </div>
            <dl class="facts">
              <div>
                <dt>Newest heartbeat</dt>
                <dd class="mono">
                  {{ b.newestHeartbeatAgeSec === null ? '—' : formatAge(b.newestHeartbeatAgeSec) }}
                </dd>
              </div>
              <div>
                <dt>Oldest heartbeat</dt>
                <dd
                  class="mono"
                  [class.loss]="b.oldestHeartbeatAgeSec !== null && b.oldestHeartbeatAgeSec > 120"
                >
                  {{ b.oldestHeartbeatAgeSec === null ? '—' : formatAge(b.oldestHeartbeatAgeSec) }}
                </dd>
              </div>
              <div>
                <dt>EA versions</dt>
                <dd class="mono">{{ eaVersions().length > 0 ? eaVersions().join(', ') : '—' }}</dd>
              </div>
              <div>
                <dt>Symbols covered</dt>
                <dd>
                  @if (b.symbolsCovered.length > 0) {
                    <div class="chips">
                      @for (s of b.symbolsCovered; track s) {
                        <span class="chip mono">{{ s }}</span>
                      }
                    </div>
                  } @else {
                    <span class="muted">none</span>
                  }
                </dd>
              </div>
            </dl>
          </section>

          <section class="card">
            <header class="card-head">
              <h3>Hosts &amp; installs</h3>
              <span class="muted">
                @if (hostsUnavailable()) {
                  terminal daemons not reachable
                } @else {
                  {{ hostInstalls().length }} MT5 install(s) across {{ hostCount() }} host(s)
                }
              </span>
            </header>
            @if (hostsUnavailable()) {
              <p class="muted note">
                Host and install data comes from the terminal supervisor, which did not answer.
                Everything above is still live from the engine.
              </p>
            } @else if (hostInstalls().length === 0) {
              <p class="muted note">
                No MT5 install on any registered daemon is pinned to this broker. Installs match on
                broker name or on an account login listed below.
              </p>
            } @else {
              <ul class="host-list">
                @for (h of hostInstalls(); track h.daemonId + ':' + h.install.installId) {
                  <li class="host-row">
                    <div class="host-main">
                      <span class="host-name">{{ h.install.name }}</span>
                      <span class="muted">
                        on {{ h.daemonName }}
                        @if (h.install.accountLogin) {
                          · login <span class="mono">{{ h.install.accountLogin }}</span>
                        }
                        @if (h.accountId !== null) {
                          ·
                          <a [routerLink]="['/trading-accounts', h.accountId]"
                            >account #{{ h.accountId }}</a
                          >
                        }
                      </span>
                    </div>
                    <div class="host-status">
                      <span
                        class="status-pill"
                        [class.active]="h.daemonOnline"
                        [class.down]="!h.daemonOnline"
                      >
                        host {{ h.daemonOnline ? 'online' : 'offline' }}
                      </span>
                      @if (h.session) {
                        <span
                          class="status-pill"
                          [class.active]="isRunning(h.session.status)"
                          [class.idle]="!isRunning(h.session.status)"
                          [title]="'Launched ' + (h.session.launchedAt | date: 'MMM d, HH:mm')"
                        >
                          terminal {{ h.session.status.toLowerCase() }}
                        </span>
                      } @else {
                        <span class="status-pill">no session</span>
                      }
                    </div>
                  </li>
                }
              </ul>
              <a class="card-link" routerLink="/terminals">Manage terminals ›</a>
            }
          </section>
        </div>

        <!-- ── Trading accounts ─────────────────────────────────── -->
        <section class="card table-card">
          <header class="card-head">
            <h3>Trading accounts</h3>
            <span class="muted">{{ b.accounts.length }} record(s) · sorted by ID</span>
          </header>
          <div class="table-scroll">
            <table class="grid-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Account</th>
                  <th>Name</th>
                  <th>Server</th>
                  <th>Type</th>
                  <th class="num">Balance</th>
                  <th class="num">Equity</th>
                  <th class="num">Margin used</th>
                  <th class="num">Util %</th>
                  <th class="num">EAs</th>
                  <th>Status</th>
                  <th class="num">Last sync</th>
                </tr>
              </thead>
              <tbody>
                @for (a of sortedAccounts(); track a.id) {
                  <tr>
                    <td class="mono">
                      <a [routerLink]="['/trading-accounts', a.id]">#{{ a.id }}</a>
                    </td>
                    <td class="mono">{{ a.accountId ?? '—' }}</td>
                    <td>{{ a.accountName ?? '—' }}</td>
                    <td class="muted nowrap">{{ a.brokerServer ?? '—' }}</td>
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
                    <td class="num mono">{{ accountUtilPct(a).toFixed(1) }}%</td>
                    <td class="num mono">{{ eaCountFor(a.id) }}</td>
                    <td>
                      <span
                        class="status-pill"
                        [class.active]="a.isActive"
                        [class.inactive]="!a.isActive"
                      >
                        {{ a.isActive ? 'Active' : 'Inactive' }}
                      </span>
                    </td>
                    <td class="num muted nowrap" [title]="a.lastSyncedAt | date: 'MMM d, HH:mm:ss'">
                      {{ ageLabel(a.lastSyncedAt) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- ── EA instances ─────────────────────────────────────── -->
        <section class="card table-card">
          <header class="card-head">
            <h3>EA instances</h3>
            <span class="muted">
              {{ b.eaInstances.length }} record(s) · sorted by account, then instance
            </span>
          </header>
          @if (b.eaInstances.length > 0) {
            <div class="table-scroll">
              <table class="grid-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th>Owned symbols</th>
                    <th>Registered</th>
                    <th>Last heartbeat</th>
                    <th class="num">Heartbeat age</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ea of sortedEaInstances(); track ea.id) {
                    <tr>
                      <td class="mono ea-instance">
                        <a [routerLink]="['/ea-instances', ea.id]" [title]="ea.instanceId">
                          {{ ea.instanceId }}
                        </a>
                        @if (ea.isCoordinator) {
                          <span class="coord-tag">coordinator</span>
                        }
                      </td>
                      <td class="mono">
                        <a [routerLink]="['/trading-accounts', ea.tradingAccountId]"
                          >#{{ ea.tradingAccountId }}</a
                        >
                      </td>
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
                      <td class="mono">{{ ea.eaVersion || '—' }}</td>
                      <td>
                        @if (eaSymbols(ea).length > 0) {
                          <div class="chips">
                            @for (s of eaSymbols(ea); track s) {
                              <span class="chip mono small">{{ s }}</span>
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
              <span class="muted">No EA instances registered against this broker's accounts.</span>
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
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
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
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }

      /* ── KPI strip ──────────────────────────────────────────── */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
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

      /* ── Cards ──────────────────────────────────────────────── */
      .card-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .card-grid {
          grid-template-columns: 1fr;
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .card.table-card {
        padding: 0;
        gap: 0;
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .table-card .card-head {
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .card-link {
        align-self: flex-start;
        font-size: var(--text-xs);
        color: var(--accent);
        text-decoration: none;
      }
      .card-link:hover {
        text-decoration: underline;
      }
      .note {
        margin: 0;
        line-height: 1.5;
      }

      .facts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3) var(--space-3);
        margin: 0;
      }
      .facts > div {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .facts dt {
        font-size: 9.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .facts dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .facts dd a {
        color: var(--accent);
        text-decoration: none;
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chip {
        font-size: 10.5px;
        font-weight: var(--font-medium);
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        color: var(--text-secondary);
      }
      .chip.small {
        font-size: 10px;
        padding: 0 5px;
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
      /* Account-type palette shared with the list page:
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

      .fleet-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .pill,
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
      .pill.active,
      .status-pill.active {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .pill.active.empty {
        background: rgba(142, 142, 147, 0.14);
        color: var(--text-secondary);
      }
      .pill.idle,
      .status-pill.idle {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .pill.down,
      .status-pill.down,
      .status-pill.inactive {
        background: rgba(255, 59, 48, 0.14);
        color: #b91c1c;
      }
      .coord-tag {
        margin-left: 6px;
        font-size: 9.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }

      /* ── Hosts ──────────────────────────────────────────────── */
      .host-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .host-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) 0;
        border-bottom: 1px dashed var(--border);
      }
      .host-row:last-child {
        border-bottom: none;
      }
      .host-main {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .host-name {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .host-main a {
        color: var(--accent);
        text-decoration: none;
      }
      .host-status {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        flex-shrink: 0;
      }

      /* ── Tables ─────────────────────────────────────────────── */
      .table-scroll {
        overflow-x: auto;
      }
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
        vertical-align: middle;
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
        white-space: nowrap;
      }
      .grid-table th.num,
      .grid-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .grid-table td a {
        color: var(--accent);
        text-decoration: none;
      }
      .grid-table td a:hover {
        text-decoration: underline;
      }
      /* Instance ids differ only in their numeric suffix, so they wrap at
         the hyphens rather than ellipsise mid-string. */
      .grid-table .ea-instance {
        max-width: 280px;
        font-size: 11px;
        overflow-wrap: anywhere;
        line-height: 1.35;
      }
      .nowrap {
        white-space: nowrap;
      }

      /* ── Shared utility ─────────────────────────────────────── */
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
    `,
  ],
})
export class BrokerDetailPageComponent implements OnInit {
  protected readonly Math = Math;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly accountsService = inject(TradingAccountsService);
  private readonly eaService = inject(EAInstancesService);
  private readonly terminals = inject(TerminalsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Raw `:id` segment — a slug from the list page or a numeric account id. */
  readonly routeId = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), {
    initialValue: '',
  });

  readonly loading = signal(false);
  /** True once the first fetch has answered, so "not found" never flashes before data. */
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly accounts = signal<TradingAccountDto[]>([]);
  readonly eaInstances = signal<EAInstanceDto[]>([]);
  readonly daemons = signal<TerminalDaemonDto[] | null>(null);
  readonly sessions = signal<TerminalSessionDto[]>([]);
  readonly nowMs = signal(Date.now());

  private readonly groups = computed<BrokerGroup[]>(() =>
    buildBrokerGroups(this.accounts(), this.eaInstances(), this.nowMs()),
  );

  /** The broker this route names, or null when nothing resolves. */
  readonly broker = computed<BrokerGroup | null>(() => {
    const id = this.routeId().trim();
    if (!id) return null;
    const groups = this.groups();
    const slug = brokerSlug(id);
    const bySlug = groups.find((g) => g.slug === slug);
    if (bySlug) return bySlug;
    if (/^\d+$/.test(id)) {
      const account = this.accounts().find((a) => a.id === Number(id));
      if (account) {
        const key = brokerKeyOf(account);
        return groups.find((g) => g.key === key) ?? null;
      }
    }
    return null;
  });

  readonly subtitle = computed(() => {
    const b = this.broker();
    if (!b) return 'Broker connectivity, accounts, hosts and EA fleet';
    const parts = [
      b.servers.length > 0 ? b.servers.join(' · ') : 'server not reported',
      `${b.accounts.length} account${b.accounts.length === 1 ? '' : 's'} (${b.activeAccounts} active)`,
      `${b.eaInstances.length} EA instance${b.eaInstances.length === 1 ? '' : 's'}`,
    ];
    return parts.join(' · ');
  });

  readonly floatingPnl = computed(() => {
    const b = this.broker();
    return b ? b.totalEquity - b.totalBalance : 0;
  });
  /** Hidden when flat — "↑ $0.00" is not information. */
  readonly floatingPnlDelta = computed<number | undefined>(() => {
    const d = this.floatingPnl();
    return Math.abs(d) < 0.005 ? undefined : d;
  });

  /** Every broker the engine talks to is reached through an MT5 EA; sim accounts are engine-side. */
  readonly platformLabel = computed(() => {
    const b = this.broker();
    if (!b) return '—';
    if (b.eaInstances.length > 0) return 'MetaTrader 5 (Lascodia EA)';
    return b.paperAccounts === b.accounts.length ? 'Engine simulation' : 'MetaTrader 5';
  });

  readonly eaVersions = computed(() =>
    Array.from(new Set((this.broker()?.eaInstances ?? []).map((ea) => (ea.eaVersion ?? '').trim())))
      .filter((v) => v.length > 0)
      .sort(),
  );

  readonly sortedAccounts = computed(() =>
    [...(this.broker()?.accounts ?? [])].sort((a, b) => a.id - b.id),
  );
  readonly sortedEaInstances = computed(() =>
    [...(this.broker()?.eaInstances ?? [])].sort(
      (a, b) => a.tradingAccountId - b.tradingAccountId || a.instanceId.localeCompare(b.instanceId),
    ),
  );

  readonly hostsUnavailable = computed(() => this.daemons() === null);

  /**
   * Installs on any daemon that belong to this broker: matched on the
   * install's broker name (same key derivation as the accounts) or on the
   * MT5 login being one of this broker's account logins.
   */
  readonly hostInstalls = computed<HostInstall[]>(() => {
    const b = this.broker();
    const daemons = this.daemons();
    if (!b || !daemons) return [];
    const loginToAccount = new Map<string, number>();
    for (const a of b.accounts) {
      const login = (a.accountId ?? '').trim();
      if (login) loginToAccount.set(login, a.id);
    }
    const sessionByInstall = new Map<string, TerminalSessionDto>();
    for (const s of this.sessions()) {
      const k = `${s.daemonId}:${s.installId}`;
      const prev = sessionByInstall.get(k);
      if (!prev || new Date(s.lastSeenAt).getTime() > new Date(prev.lastSeenAt).getTime()) {
        sessionByInstall.set(k, s);
      }
    }
    const out: HostInstall[] = [];
    for (const d of daemons) {
      for (const install of d.installs ?? []) {
        const login = (install.accountLogin ?? '').trim();
        const byLogin = login ? (loginToAccount.get(login) ?? null) : null;
        const installKey = brokerSlug(
          brokerKeyOf({ brokerServer: null, brokerName: install.brokerName } as TradingAccountDto),
        );
        const byName = installKey.length > 0 && installKey === b.slug;
        if (byLogin === null && !byName) continue;
        out.push({
          daemonId: d.id,
          daemonName: d.name,
          daemonOnline: d.isOnline,
          install,
          accountId: byLogin,
          session: sessionByInstall.get(`${d.id}:${install.installId}`) ?? null,
        });
      }
    }
    return out.sort(
      (x, y) =>
        x.daemonName.localeCompare(y.daemonName) || x.install.name.localeCompare(y.install.name),
    );
  });
  readonly hostCount = computed(() => new Set(this.hostInstalls().map((h) => h.daemonId)).size);

  private readonly eaCountByAccount = computed(() => {
    const m = new Map<number, number>();
    for (const ea of this.eaInstances()) {
      m.set(ea.tradingAccountId, (m.get(ea.tradingAccountId) ?? 0) + 1);
    }
    return m;
  });

  ngOnInit(): void {
    this.loadAll();
    timer(15_000, 15_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.loadAll());
    timer(1_000, 1_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.nowMs.set(Date.now()));
  }

  loadAll(): void {
    this.loading.set(true);
    forkJoin({
      accounts: this.accountsService
        .list({ currentPage: 1, itemCountPerPage: 200 })
        .pipe(catchError(() => of(null))),
      eas: this.eaService.list().pipe(catchError(() => of(null))),
      // Terminal endpoints are admin-scoped and optional: their failure
      // degrades the hosts card, never the page.
      daemons: this.terminals.listDaemons().pipe(catchError(() => of(null))),
      sessions: this.terminals.listSessions().pipe(catchError(() => of(null))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ accounts, eas, daemons, sessions }) => {
        this.loading.set(false);
        this.loaded.set(true);
        if (accounts?.data?.data) {
          this.accounts.set(accounts.data.data);
          this.loadError.set(null);
        } else {
          this.loadError.set(
            accounts?.message || 'The trading-account list did not load. Is the engine reachable?',
          );
        }
        if (eas?.data) this.eaInstances.set(eas.data);
        this.daemons.set(daemons?.data ?? null);
        this.sessions.set(sessions?.data ?? []);
      });
  }

  goBack(): void {
    void this.router.navigate(['/brokers']);
  }

  accountMode(a: TradingAccountDto): { label: string; cls: AccountModeClass } {
    return accountMode(a);
  }

  accountUtilPct(a: TradingAccountDto): number {
    const eq = a.equity ?? 0;
    return eq > 0 ? ((a.marginUsed ?? 0) / eq) * 100 : 0;
  }

  eaCountFor(accountId: number): number {
    return this.eaCountByAccount().get(accountId) ?? 0;
  }

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

  isRunning(status: string): boolean {
    return /running|active|alive|up/i.test(status);
  }
}
