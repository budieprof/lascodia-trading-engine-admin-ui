import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, forkJoin, map, merge, of, throttleTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { EChartsOption } from 'echarts';

import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { PositionsService } from '@core/services/positions.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { OrdersService } from '@core/services/orders.service';
import { HealthService } from '@core/services/health.service';
import { DrawdownRecoveryService } from '@core/services/drawdown-recovery.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { StrategyEnsembleService } from '@core/services/strategy-ensemble.service';
import { AlertsService } from '@core/services/alerts.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { WorkersService } from '@core/services/workers.service';
import { MLModelsService } from '@core/services/ml-models.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { createPolledResource } from '@core/polling/polled-resource';

import type {
  AlertDto,
  DrawdownSnapshotDto,
  EAInstanceDto,
  EngineStatusDto,
  MLModelDto,
  MLModelOverfitFlagDto,
  OrderDto,
  PositionDto,
  StrategyAllocationDto,
  StrategyDto,
  TradeSignalDto,
  TradingAccountDto,
  WorkerHealthDto,
} from '@core/api/api.types';

const PALETTE = [
  '#0071E3',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#5AC8FA',
  '#FF3B30',
  '#FFCC00',
  '#30D158',
];

interface ActivityEntry {
  id: string;
  kind: 'fill' | 'open' | 'close' | 'signal' | 'reject';
  symbol: string;
  text: string;
  detail: string | null;
  at: string;
}

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    DatePipe,
    DecimalPipe,
    MetricCardComponent,
    ChartCardComponent,
    PageHeaderComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="dashboard page">
      <app-page-header title="Dashboard" subtitle="Live engine overview">
        <span class="head-pill" [attr.data-state]="healthStatus() ? 'up' : 'down'">
          <span class="dot"></span>
          {{ healthStatus() ? 'Engine running' : 'Engine stopped' }}
        </span>
        <span class="head-pill" [attr.data-state]="realtimeOnline() ? 'up' : 'down'">
          <span class="dot"></span>
          {{ realtimeOnline() ? 'Realtime live' : 'Realtime offline' }}
        </span>
        <!--
          Multi-account scope is owned by the global selector in the
          header chrome (AccountScopePillComponent) — it shows on
          every page so flipping it reshapes orders, positions,
          drawdown, and the dashboard tiles in lockstep.  When the
          operator has a single live account, render a lightweight
          label here too so the chosen account is still visible on
          the page header.
        -->
        @if (account(); as a) {
          @if (liveAccounts().length <= 1) {
            <span class="head-pill" data-state="muted">
              {{ a.accountName ?? a.accountId }}{{ a.isPaper ? ' · paper' : '' }} · {{ a.currency }}
            </span>
          }
        }
      </app-page-header>

      <!-- Hero KPI strip — 12 dense tiles, two rows. -->
      <div class="hero-strip">
        <div class="kpi-grid">
          <app-metric-card
            label="Account Equity"
            [value]="equity()"
            format="currency"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Unrealized P&L"
            [value]="unrealizedPnl()"
            format="currency"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Today P&L"
            [value]="todaysPnl()"
            format="currency"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Lifetime P&L"
            [value]="lifetimePnl()"
            format="currency"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Win Rate"
            [value]="winRatePct()"
            format="percent"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Profit Factor"
            [value]="profitFactor()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Drawdown"
            [value]="drawdownPct()"
            format="percent"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Open Positions"
            [value]="openPositionCount()"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Active Strategies"
            [value]="activeStrategyCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Pending Signals"
            [value]="pendingSignalCount()"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="EA Connections"
            [value]="activeEaCount()"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Workers OK"
            [value]="healthyWorkerCount()"
            format="number"
            [dotColor]="failedWorkerCount() > 0 ? '#FF3B30' : '#34C759'"
          />
        </div>
      </div>

      <!-- Equity curve dominates; daily P&L histogram alongside. -->
      <div class="charts-2-1">
        <app-chart-card
          title="Equity Curve"
          subtitle="Cumulative realized P&L, last 30 days"
          [options]="equityCurveChart()"
          height="260px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Daily P&L"
          subtitle="Realized P&L per day"
          [options]="dailyPnlChart()"
          height="260px"
          [loading]="loading()"
        />
      </div>

      <!-- 3-up: P&L by symbol attribution, exposure, allocation.
           Height is 380px so P&L-by-Symbol's 30-day breakdown (often
           15-20 symbols) gets ~22px per category slot — small enough to
           fit, big enough for the bars to render at their full
           barMaxWidth without ECharts auto-shrinking them. -->
      <div class="charts-3">
        <app-chart-card
          title="P&L by Symbol"
          subtitle="Realized contribution last 30 days"
          [options]="pnlBySymbolChart()"
          height="380px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Position Exposure"
          subtitle="Open lots by symbol"
          [options]="exposureChart()"
          height="380px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Strategy Allocation"
          subtitle="Active ensemble weights"
          [options]="allocationChart()"
          height="380px"
          [loading]="loading()"
        />
      </div>

      <!-- Top open positions + pending signals queue. -->
      <div class="tables-2">
        <section class="panel">
          <header class="panel-head">
            <h3>Top Open Positions</h3>
            @if (openPositions().length > 0) {
              <a routerLink="/positions" class="link">View all ({{ openPositions().length }})</a>
            }
          </header>
          @if (topOpenPositions().length > 0) {
            <table class="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Dir</th>
                  <th class="num">Lots</th>
                  <th class="num">Entry</th>
                  <th class="num">Current</th>
                  <th class="num">Unrealized</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                @for (p of topOpenPositions(); track p.id) {
                  <tr>
                    <td class="mono">{{ p.symbol }}</td>
                    <td
                      class="dir"
                      [class.buy]="p.direction === 'Long'"
                      [class.sell]="p.direction === 'Short'"
                    >
                      {{ p.direction === 'Long' ? '↑' : '↓' }}
                    </td>
                    <td class="num mono">{{ p.openLots | number: '1.2-2' }}</td>
                    <td class="num mono">{{ p.averageEntryPrice | number: '1.4-5' }}</td>
                    <td class="num mono">
                      {{ p.currentPrice !== null ? (p.currentPrice | number: '1.4-5') : '—' }}
                    </td>
                    <td
                      class="num mono"
                      [class.profit]="p.unrealizedPnL > 0"
                      [class.loss]="p.unrealizedPnL < 0"
                    >
                      {{ p.unrealizedPnL >= 0 ? '+' : '' }}{{ p.unrealizedPnL | number: '1.2-2' }}
                    </td>
                    <td class="muted">{{ p.openedAt | relativeTime }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-panel">No open positions</div>
          }
        </section>

        <section class="panel">
          <header class="panel-head">
            <h3>Pending Signals</h3>
            @if (pendingSignals().length > 0) {
              <a routerLink="/trade-signals" class="link">
                View all ({{ pendingSignalCount() }})
              </a>
            }
          </header>
          @if (pendingSignals().length > 0) {
            <ul class="signal-list">
              @for (sig of pendingSignals(); track sig.id) {
                <li class="signal-item">
                  <div class="signal-main">
                    <span class="signal-symbol mono">{{ sig.symbol }}</span>
                    <span
                      class="signal-direction"
                      [class.buy]="sig.direction === 'Buy'"
                      [class.sell]="sig.direction === 'Sell'"
                    >
                      {{ sig.direction === 'Buy' ? '↑' : '↓' }} {{ sig.direction }}
                    </span>
                    <span class="signal-confidence mono">
                      {{ (sig.confidence * 100).toFixed(0) }}%
                    </span>
                    <span class="muted age">{{ sig.generatedAt | relativeTime }}</span>
                  </div>
                  <div class="signal-actions">
                    <button
                      type="button"
                      class="action-btn approve"
                      (click)="approveSignal(sig.id)"
                      [attr.aria-label]="'Approve signal ' + sig.symbol + ' ' + sig.direction"
                      title="Approve"
                    >
                      <span aria-hidden="true">✓</span>
                    </button>
                    <button
                      type="button"
                      class="action-btn reject"
                      (click)="rejectSignal(sig.id)"
                      [attr.aria-label]="'Reject signal ' + sig.symbol + ' ' + sig.direction"
                      title="Reject"
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  </div>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No pending signals</div>
          }
        </section>
      </div>

      <!-- Activity feed, worker health, and alerts row. -->
      <div class="ops-3">
        <section class="panel">
          <header class="panel-head">
            <h3>Recent Activity</h3>
            <span class="muted">Last {{ activityFeed().length }} events</span>
          </header>
          @if (activityFeed().length > 0) {
            <ul class="activity">
              @for (e of activityFeed(); track e.id) {
                <li class="activity-item" [attr.data-kind]="e.kind">
                  <span class="activity-tag">{{ e.kind }}</span>
                  <span class="mono activity-symbol">{{ e.symbol }}</span>
                  <span class="activity-text">{{ e.text }}</span>
                  @if (e.detail) {
                    <span class="muted activity-detail">{{ e.detail }}</span>
                  }
                  <span class="muted activity-time">{{ e.at | relativeTime }}</span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No recent activity</div>
          }
        </section>

        <section class="panel">
          <header class="panel-head">
            <h3>Worker Health</h3>
            <a routerLink="/worker-health" class="link">All workers</a>
          </header>
          <div class="worker-summary">
            <div class="ws-stat ws-healthy">
              <strong>{{ healthyWorkerCount() }}</strong>
              <span>Healthy</span>
            </div>
            <div class="ws-stat ws-degraded" [class.ws-empty]="degradedWorkerCount() === 0">
              <strong>{{ degradedWorkerCount() }}</strong>
              <span>Degraded</span>
            </div>
            <div class="ws-stat ws-failed" [class.ws-empty]="failedWorkerCount() === 0">
              <strong>{{ failedWorkerCount() }}</strong>
              <span>Failed</span>
            </div>
            <div class="ws-stat ws-idle" [class.ws-empty]="idleWorkerCount() === 0">
              <strong>{{ idleWorkerCount() }}</strong>
              <span>Idle</span>
            </div>
            <div class="ws-stat ws-stale" [class.ws-empty]="staleWorkerCount() === 0">
              <strong>{{ staleWorkerCount() }}</strong>
              <span>Stale</span>
            </div>
          </div>
          @if (problemWorkers().length > 0) {
            <ul class="worker-list">
              @for (w of problemWorkers(); track w.name) {
                <li class="worker-row" [attr.data-status]="w.status">
                  <span class="status-dot" [attr.data-status]="w.status"></span>
                  <span class="worker-name mono">{{ w.name }}</span>
                  <span class="worker-meta muted">{{ w.status }}</span>
                  @if (w.lastErrorMessage) {
                    <span class="worker-err" [title]="w.lastErrorMessage">
                      {{ w.lastErrorMessage }}
                    </span>
                  }
                </li>
              }
            </ul>
          } @else if (totalWorkerCount() > 0) {
            <div class="all-good">All {{ totalWorkerCount() }} workers nominal</div>
          } @else {
            <div class="empty-panel">No worker data yet</div>
          }
        </section>

        <section class="panel">
          <header class="panel-head">
            <h3>Active Alerts</h3>
            <a routerLink="/alerts" class="link">All alerts</a>
          </header>
          @if (recentAlerts().length > 0) {
            <ul class="alerts">
              @for (a of recentAlerts(); track a.id) {
                <li class="alert-item">
                  <span class="alert-pill" [attr.data-active]="a.isActive ? 'true' : 'false'">
                    {{ a.alertType }}
                  </span>
                  <span class="mono">{{ a.symbol ?? '—' }}</span>
                  <span class="muted alert-channel">{{ a.severity }}</span>
                  @if (a.lastTriggeredAt) {
                    <span class="muted alert-time">
                      {{ a.lastTriggeredAt | relativeTime }}
                    </span>
                  }
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No alerts configured</div>
          }
        </section>

        <section class="panel">
          <header class="panel-head">
            <h3>Overfit Watchlist</h3>
            <a routerLink="/ml-models" class="link">All models</a>
          </header>
          @if (overfitWatchlist().length > 0) {
            <ul class="overfit-list">
              @for (m of overfitWatchlist(); track m.mlModelId) {
                <li class="overfit-item">
                  <a
                    [routerLink]="['/ml-models', m.mlModelId]"
                    class="overfit-pair"
                    [title]="m.reason"
                  >
                    <span class="mono">{{ m.symbol }} {{ m.timeframe }}</span>
                    <span class="muted small">{{ m.learnerArchitecture }}</span>
                  </a>
                  <div class="overfit-stats">
                    <span class="overfit-stat">
                      <span class="muted small">CV</span>
                      <span class="mono">{{
                        m.cvSharpe !== null ? m.cvSharpe.toFixed(2) : '—'
                      }}</span>
                    </span>
                    <span class="overfit-stat">
                      <span class="muted small">Live 7d</span>
                      <span class="mono" [class.loss]="(m.liveSharpe7d ?? 0) <= 0">
                        {{ m.liveSharpe7d !== null ? m.liveSharpe7d.toFixed(2) : '—' }}
                      </span>
                    </span>
                    @if (m.sharpeRatio !== null) {
                      <span class="overfit-ratio-pill">
                        {{ m.sharpeRatio.toFixed(1) }}× drift
                      </span>
                    } @else {
                      <span class="overfit-collapse-pill">edge collapse</span>
                    }
                    <span class="muted small">{{ m.resolvedSignals }} signals</span>
                  </div>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No models flagged — CV/live Sharpe in line</div>
          }
        </section>
      </div>

      <!-- Compact status footer. -->
      <div class="status-grid">
        <section class="status-card">
          <h4>Engine</h4>
          @if (healthStatus()) {
            <p class="pill healthy">Running</p>
          } @else {
            <p class="pill down">Stopped</p>
          }
          @if (engineStatus(); as s) {
            <span class="muted">
              {{ s.paperMode ?? 'live' }} · checked {{ s.checkedAt | relativeTime }}
            </span>
          }
        </section>
        <section class="status-card">
          <h4>Drawdown</h4>
          @if (drawdown(); as d) {
            <p class="mono" [class.profit]="d.drawdownPct === 0" [class.loss]="d.drawdownPct > 0">
              {{ d.drawdownPct.toFixed(2) }}%
            </p>
            <span class="muted">{{ d.recoveryMode ?? 'Normal' }}</span>
          } @else {
            <p class="muted">—</p>
          }
        </section>
        <section class="status-card">
          <h4>Account</h4>
          @if (account(); as a) {
            <p class="mono">{{ a.accountName ?? a.accountId }}</p>
            <span class="muted">
              {{ a.currency ?? '' }} · margin {{ marginUsedPct() | number: '1.1-1' }}%
            </span>
          } @else {
            <p class="muted">—</p>
          }
        </section>
        <section class="status-card">
          <h4>ML Models</h4>
          @if (activeMlModelCount() !== null) {
            <p class="mono">{{ activeMlModelCount() }} active</p>
            <span class="muted">
              @if (mostRecentMlModel(); as m) {
                latest {{ m.symbol }} {{ m.timeframe }} · {{ m.trainedAt | relativeTime }}
              } @else {
                no active models
              }
            </span>
          } @else {
            <p class="muted">—</p>
          }
        </section>
        <section class="status-card">
          <h4>Last Signal</h4>
          @if (lastSignalAt()) {
            <p class="mono">{{ lastSignalAt() | relativeTime }}</p>
            <span class="muted">{{ todaysSignalCount() }} today</span>
          } @else {
            <p class="muted">No signals yet</p>
          }
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      .dashboard {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .head-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }
      .head-pill .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .head-pill[data-state='up'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .head-pill[data-state='up'] .dot {
        background: var(--profit);
      }
      .head-pill[data-state='down'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .head-pill[data-state='down'] .dot {
        background: var(--loss);
      }
      .head-pill[data-state='muted'] .dot {
        display: none;
      }
      .head-pill.account-select {
        gap: 6px;
        cursor: pointer;
      }
      .head-pill.account-select .select-label {
        opacity: 0.7;
        font-size: 11px;
      }
      .head-pill.account-select .select-native {
        appearance: none;
        background: transparent;
        border: 0;
        color: inherit;
        font: inherit;
        font-size: 12px;
        padding: 0 14px 0 2px;
        cursor: pointer;
        background-image:
          linear-gradient(45deg, transparent 50%, currentColor 50%),
          linear-gradient(135deg, currentColor 50%, transparent 50%);
        background-position:
          calc(100% - 8px) 50%,
          calc(100% - 4px) 50%;
        background-size:
          4px 4px,
          4px 4px;
        background-repeat: no-repeat;
      }
      .head-pill.account-select .select-native:focus {
        outline: 1px solid var(--accent);
        outline-offset: 2px;
        border-radius: 2px;
      }

      .hero-strip {
        position: relative;
        padding: var(--space-4) var(--space-5);
        background: var(--bg-glass);
        backdrop-filter: var(--blur-md);
        -webkit-backdrop-filter: var(--blur-md);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .hero-strip::before {
        content: '';
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 0% 0%, rgba(10, 132, 255, 0.08), transparent 40%),
          radial-gradient(circle at 100% 100%, rgba(52, 199, 89, 0.06), transparent 40%);
        pointer-events: none;
      }
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .hero-strip {
          background: var(--bg-secondary);
        }
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-3);
        position: relative;
        z-index: 1;
      }
      @media (max-width: 1400px) {
        .kpi-grid {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 900px) {
        .kpi-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .charts-2-1 {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: var(--space-4);
      }
      .charts-3 {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
      }
      .tables-2 {
        display: grid;
        grid-template-columns: 3fr 2fr;
        gap: var(--space-4);
      }
      .ops-3 {
        display: grid;
        grid-template-columns: 2fr 1.2fr 1.2fr;
        gap: var(--space-4);
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1200px) {
        .charts-2-1,
        .charts-3,
        .tables-2,
        .ops-3 {
          grid-template-columns: 1fr;
        }
        .status-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .link {
        color: var(--accent);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }
      .link:hover {
        text-decoration: underline;
      }

      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .table tr:last-child td {
        border-bottom: none;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .table td.num,
      .table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .dir {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .dir.buy {
        color: var(--profit);
      }
      .dir.sell {
        color: var(--loss);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }

      .signal-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 320px;
        overflow-y: auto;
      }
      .signal-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        gap: var(--space-3);
      }
      .signal-item:last-child {
        border-bottom: none;
      }
      .signal-item:hover {
        background: var(--bg-tertiary);
      }
      .signal-main {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex: 1;
        font-size: var(--text-xs);
      }
      .signal-symbol {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .signal-direction {
        font-weight: var(--font-semibold);
      }
      .signal-direction.buy {
        color: var(--profit);
      }
      .signal-direction.sell {
        color: var(--loss);
      }
      .signal-confidence {
        margin-left: auto;
        color: var(--text-secondary);
      }
      .age {
        font-size: 10.5px;
      }
      .signal-actions {
        display: flex;
        gap: var(--space-1);
      }
      .action-btn {
        width: 26px;
        height: 26px;
        border-radius: var(--radius-full);
        border: none;
        cursor: pointer;
        font-weight: var(--font-semibold);
        font-size: 13px;
      }
      .action-btn.approve {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .action-btn.approve:hover {
        background: rgba(52, 199, 89, 0.25);
      }
      .action-btn.reject {
        background: rgba(255, 59, 48, 0.15);
        color: #d70015;
      }
      .action-btn.reject:hover {
        background: rgba(255, 59, 48, 0.25);
      }
      .empty-panel {
        padding: var(--space-6) var(--space-5);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      .activity {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 360px;
        overflow-y: auto;
      }
      .activity-item {
        display: grid;
        grid-template-columns: 64px 70px 1fr auto auto;
        align-items: center;
        gap: var(--space-2);
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .activity-item:last-child {
        border-bottom: none;
      }
      .activity-tag {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-align: center;
      }
      .activity-item[data-kind='fill'] .activity-tag,
      .activity-item[data-kind='open'] .activity-tag {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .activity-item[data-kind='close'] .activity-tag {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .activity-item[data-kind='reject'] .activity-tag {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .activity-item[data-kind='signal'] .activity-tag {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .activity-symbol {
        font-weight: var(--font-semibold);
      }
      .activity-text {
        color: var(--text-primary);
      }
      .activity-detail {
        font-size: 10.5px;
      }
      .activity-time {
        font-size: 10.5px;
        text-align: right;
      }

      .worker-summary {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .ws-stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: var(--space-2) 0;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .ws-stat strong {
        font-size: var(--text-base);
        font-variant-numeric: tabular-nums;
      }
      .ws-stat span {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ws-empty {
        opacity: 0.45;
      }
      .ws-healthy strong {
        color: #248a3d;
      }
      .ws-degraded strong {
        color: #c93400;
      }
      .ws-failed strong {
        color: #d70015;
      }
      .ws-idle strong {
        color: var(--text-secondary);
      }
      .ws-stale strong {
        color: #8a2be2;
      }

      .worker-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 220px;
        overflow-y: auto;
      }
      .worker-row {
        display: grid;
        grid-template-columns: 12px 1fr auto;
        align-items: center;
        gap: var(--space-2);
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .worker-row:last-child {
        border-bottom: none;
      }
      .worker-row .worker-err {
        grid-column: 2 / -1;
        color: var(--text-tertiary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .status-dot[data-status='Healthy'] {
        background: var(--profit);
      }
      .status-dot[data-status='Degraded'] {
        background: var(--warning);
      }
      .status-dot[data-status='Failed'] {
        background: var(--loss);
      }
      .all-good {
        padding: var(--space-3) var(--space-4);
        text-align: center;
        color: #248a3d;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }

      .alerts {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 320px;
        overflow-y: auto;
      }
      .alert-item {
        display: grid;
        grid-template-columns: auto auto 1fr auto;
        align-items: center;
        gap: var(--space-2);
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .alert-item:last-child {
        border-bottom: none;
      }
      .alert-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .alert-pill[data-active='true'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .alert-channel,
      .alert-time {
        font-size: 10.5px;
      }

      .overfit-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .overfit-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) 0;
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .overfit-item:last-child {
        border-bottom: none;
      }
      .overfit-pair {
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-decoration: none;
        color: var(--text-primary);
      }
      .overfit-pair:hover {
        text-decoration: underline;
      }
      .overfit-stats {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-xs);
      }
      .overfit-stat {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
      }
      .overfit-stat .mono {
        font-variant-numeric: tabular-nums;
      }
      .overfit-stat .mono.loss {
        color: #d70015;
      }
      .overfit-ratio-pill {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      .overfit-collapse-pill {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }

      .status-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
        padding: var(--space-3) var(--space-4);
      }
      .status-card h4 {
        margin: 0 0 var(--space-1);
        font-size: 10.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .status-card p {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .status-card .muted {
        display: block;
        margin-top: 2px;
        color: var(--text-tertiary);
        font-size: 10.5px;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .pill.healthy {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill.down {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .muted {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class DashboardPageComponent implements OnInit {
  private readonly positionsService = inject(PositionsService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly signalsService = inject(TradeSignalsService);
  private readonly ordersService = inject(OrdersService);
  private readonly healthService = inject(HealthService);
  private readonly drawdownService = inject(DrawdownRecoveryService);
  private readonly accountsService = inject(TradingAccountsService);
  private readonly ensembleService = inject(StrategyEnsembleService);
  private readonly alertsService = inject(AlertsService);
  private readonly eaService = inject(EAInstancesService);
  private readonly workersService = inject(WorkersService);
  private readonly mlService = inject(MLModelsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);

  constructor() {
    // Aggressive throttle (3s): a flurry of fills + flips would otherwise
    // restart every fetch on the page.
    merge(
      this.realtime.on('orderFilled'),
      this.realtime.on('positionOpened'),
      this.realtime.on('positionClosed'),
      this.realtime.on('vaRBreach'),
      this.realtime.on('emergencyFlatten'),
    )
      .pipe(throttleTime(3_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.refresh());

    // Re-fetch the Drawdown tile any time the scoped account set
    // changes — selecting a different account in the header dropdown
    // re-issues /drawdown-recovery/latest?accountIds=… so the tile
    // shows that account's per-account snapshot instead of the
    // fleet-wide aggregate.  Effect runs in injection context so
    // takeUntilDestroyed is handled automatically.
    effect(() => {
      const scope = this.scopedAccountIds();
      if (scope.size === 0) return;
      const ids = Array.from(scope);
      this.drawdownService
        .getLatest(ids)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => this.drawdown.set(r.data ?? null),
          // Leave the previous value in place on transient errors —
          // better than flashing the tile blank.
          error: () => {},
        });
    });
  }

  private readonly destroyRef = inject(DestroyRef);

  // ── Data signals ──────────────────────────────────────────────────────
  readonly loading = signal(true);
  readonly equity = signal<number | null>(null);
  // Derived from openPositions() — re-derives when scope changes.
  readonly unrealizedPnl = computed<number | null>(() => {
    const open = this.openPositions();
    if (open.length === 0) return null;
    return open.reduce((s, p) => s + p.unrealizedPnL, 0);
  });
  readonly openPositionCount = computed<number | null>(() => this.openPositions().length || null);
  readonly activeStrategyCount = signal<number | null>(null);
  readonly pendingSignalCount = signal<number | null>(null);
  readonly pendingSignals = signal<TradeSignalDto[]>([]);
  readonly allSignals = signal<TradeSignalDto[]>([]);
  readonly healthStatus = signal(false);
  readonly engineStatus = signal<EngineStatusDto | null>(null);
  // Drawdown snapshot fetched per scope from the engine.  The
  // /drawdown-recovery/latest endpoint accepts an accountIds query
  // string and returns either a single account's row or an aggregate
  // synthesized server-side (sums equity/peak, picks the worst
  // recovery mode across the set).  We re-fetch whenever the scoped
  // account set changes — same cadence as Account Equity.
  readonly drawdown = signal<DrawdownSnapshotDto | null>(null);
  // ── Multi-account dashboard scoping ──────────────────────────────
  //
  // Sourced from the global AccountScopeService — same service drives
  // the header-pill selector, the Orders page filter, the Positions
  // page filter, and the Drawdown query parameter.  Flipping the
  // header dropdown reshapes every account-derived tile on this
  // page in lockstep with the rest of the console.
  protected readonly accountScope = inject(AccountScopeService);
  readonly accounts = this.accountScope.accounts;
  readonly liveAccounts = this.accountScope.liveAccounts;
  readonly selectedAccountId = this.accountScope.selected;

  readonly account = computed<TradingAccountDto | null>(() => {
    const live = this.liveAccounts();
    if (live.length === 0) return null;
    const sel = this.selectedAccountId();
    if (sel === AccountScopeService.SCOPE_AGGREGATE_REAL) {
      return DashboardPageComponent.aggregateReal(live.filter((a) => !a.isPaper));
    }
    if (sel === AccountScopeService.SCOPE_AGGREGATE_ALL) {
      return DashboardPageComponent.aggregateReal(live);
    }
    const id = typeof sel === 'string' ? Number(sel) : sel;
    const match = live.find((a) => a.id === id);
    if (match) return match;
    return DashboardPageComponent.aggregateReal(live.filter((a) => !a.isPaper));
  });

  readonly realAccountCount = computed(() => this.liveAccounts().filter((a) => !a.isPaper).length);

  // Engine-tagged ids set the dashboard filters against.  Reads
  // straight from the global scope; the AccountScopeService owns the
  // sentinel-vs-id resolution, paper-exclusion default, and stale-
  // selection fallback.
  readonly scopedAccountIds = computed<Set<number>>(() => new Set(this.accountScope.accountIds()));

  /** Synthesize an aggregated DTO across the supplied accounts.  Sums balance/
   *  equity/margin; pairs the resulting equity-weighted marginLevel.
   *  Returns the only real account when there's just one, or a null-
   *  placeholder when zero real accounts (operator running paper-
   *  only).  Caller is expected to pass already-live accounts (those
   *  with an actually-running EAInstance) — we only filter `isPaper`
   *  here, not `isActive` (which is sticky and includes detached
   *  accounts). */
  private static aggregateReal(liveAccounts: TradingAccountDto[]): TradingAccountDto | null {
    const real = liveAccounts.filter((a) => !a.isPaper);
    if (real.length === 0) return null;
    if (real.length === 1) return real[0];
    const sum = (k: keyof TradingAccountDto) =>
      real.reduce((acc, a) => acc + (Number(a[k] ?? 0) || 0), 0);
    const balance = sum('balance');
    const equity = sum('equity');
    const marginUsed = sum('marginUsed');
    const marginAvailable = sum('marginAvailable');
    // Equity-weighted margin level — preserves the per-account
    // proportion when accounts have wildly different equities.
    const marginLevel =
      equity > 0 ? real.reduce((acc, a) => acc + (a.marginLevel ?? 0) * a.equity, 0) / equity : 0;
    const profit = sum('profit');
    const credit = sum('credit');
    return {
      id: -1,
      accountId: null,
      accountName: `Aggregate · ${real.length} real accounts`,
      brokerServer: null,
      brokerName: null,
      accountType: real[0].accountType,
      leverage: real[0].leverage,
      marginMode: real[0].marginMode,
      currency: real[0].currency,
      balance,
      equity,
      marginUsed,
      marginAvailable,
      marginLevel,
      profit,
      credit,
      marginSoMode: real[0].marginSoMode,
      marginSoCall: real[0].marginSoCall,
      marginSoStopOut: real[0].marginSoStopOut,
      maxAbsoluteDailyLoss: sum('maxAbsoluteDailyLoss'),
      isActive: true,
      isPaper: false,
      lastSyncedAt:
        real
          .map((a) => a.lastSyncedAt)
          .filter(Boolean)
          .sort()
          .reverse()[0] ?? new Date().toISOString(),
      riskProfileId: null,
    };
  }

  // Raw fetch buckets — set verbatim from the engine response.  Each
  // derived signal below filters by scopedAccountIds() so the account
  // dropdown actively reshapes every account-tagged metric (open/closed
  // position counts, unrealized + realized PnL, top-positions list,
  // P&L by symbol, position exposure, equity curve, daily PnL, win
  // rate, profit factor, recent activity).
  readonly rawClosedPositions = signal<PositionDto[]>([]);
  readonly rawOpenPositions = signal<PositionDto[]>([]);
  readonly closedPositions = computed<PositionDto[]>(() => {
    const scope = this.scopedAccountIds();
    return this.rawClosedPositions().filter((p) => scope.has(p.tradingAccountId));
  });
  readonly openPositions = computed<PositionDto[]>(() => {
    const scope = this.scopedAccountIds();
    return this.rawOpenPositions().filter((p) => scope.has(p.tradingAccountId));
  });
  readonly allocations = signal<StrategyAllocationDto[]>([]);
  readonly alerts = signal<AlertDto[]>([]);
  readonly eaInstances = signal<EAInstanceDto[]>([]);
  readonly workers = signal<WorkerHealthDto[]>([]);
  readonly mlModels = signal<MLModelDto[]>([]);
  // Models flagged because in-sample CV Sharpe is materially higher than rolling
  // 7d live Sharpe — surfaced as a dashboard pin so operators see overfit before
  // drift workers get to it on lagging metrics.
  readonly overfitWatchlist = signal<MLModelOverfitFlagDto[]>([]);
  readonly rawRecentOrders = signal<OrderDto[]>([]);
  readonly recentOrders = computed<OrderDto[]>(() => {
    const scope = this.scopedAccountIds();
    return this.rawRecentOrders().filter(
      (o) =>
        // Tolerate older engine builds that didn't tag orders — show them
        // in all scopes rather than swallow.  Once the engine is the
        // current build, every order carries tradingAccountId.
        o.tradingAccountId == null || scope.has(o.tradingAccountId),
    );
  });
  // Reactive realtime status from the SignalR connection-state signal.
  readonly realtimeOnline = computed(() => this.realtime.isConnected());

  // ── Derived KPIs ──────────────────────────────────────────────────────
  readonly todaysPnl = computed(() => {
    const start = startOfToday();
    return this.closedPositions()
      .filter((p) => p.closedAt && new Date(p.closedAt).getTime() >= start)
      .reduce((s, p) => s + p.realizedPnL, 0);
  });

  readonly lifetimePnl = computed(() =>
    this.closedPositions().reduce((s, p) => s + p.realizedPnL, 0),
  );

  readonly winRatePct = computed(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return 0;
    const wins = closed.filter((p) => p.realizedPnL > 0).length;
    return (wins / closed.length) * 100;
  });

  readonly profitFactor = computed(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return 0;
    const grossWin = closed.filter((p) => p.realizedPnL > 0).reduce((s, p) => s + p.realizedPnL, 0);
    const grossLoss = Math.abs(
      closed.filter((p) => p.realizedPnL < 0).reduce((s, p) => s + p.realizedPnL, 0),
    );
    if (grossLoss === 0) return grossWin > 0 ? 99 : 0;
    return grossWin / grossLoss;
  });

  readonly drawdownPct = computed(() => this.drawdown()?.drawdownPct ?? 0);

  readonly marginUsedPct = computed(() => {
    const a = this.account();
    if (!a || !a.equity || a.equity <= 0) return 0;
    return ((a.marginUsed ?? 0) / a.equity) * 100;
  });

  readonly activeEaCount = computed(
    () => this.eaInstances().filter((e) => e.status === 'Active').length,
  );

  readonly totalWorkerCount = computed(() => this.workers().length);
  readonly healthyWorkerCount = computed(
    () => this.workers().filter((w) => w.status === 'Healthy').length,
  );
  readonly degradedWorkerCount = computed(
    () => this.workers().filter((w) => w.status === 'Degraded').length,
  );
  readonly failedWorkerCount = computed(
    () => this.workers().filter((w) => w.status === 'Failed').length,
  );
  readonly idleWorkerCount = computed(
    () => this.workers().filter((w) => w.status === 'Idle').length,
  );
  readonly staleWorkerCount = computed(() => this.workers().filter((w) => w.isStale).length);

  // Surface only the worth-investigating workers so the panel stays compact.
  readonly problemWorkers = computed(() =>
    this.workers()
      .filter((w) => w.status === 'Failed' || w.status === 'Degraded')
      .slice(0, 5),
  );

  readonly topOpenPositions = computed(() =>
    [...this.openPositions()].sort((a, b) => b.unrealizedPnL - a.unrealizedPnL).slice(0, 6),
  );

  readonly recentAlerts = computed(() =>
    [...this.alerts()]
      .sort((a, b) => (b.lastTriggeredAt ?? '').localeCompare(a.lastTriggeredAt ?? ''))
      .slice(0, 6),
  );

  readonly activeMlModelCount = computed(() =>
    this.mlModels().length === 0 ? null : this.mlModels().filter((m) => m.isActive).length,
  );

  readonly mostRecentMlModel = computed(() => {
    const active = this.mlModels()
      .filter((m) => m.isActive)
      .sort((a, b) => b.trainedAt.localeCompare(a.trainedAt));
    return active[0] ?? null;
  });

  readonly lastSignalAt = computed(() => {
    const sigs = this.allSignals();
    if (sigs.length === 0) return null;
    return sigs.reduce(
      (max, s) => (max === null || s.generatedAt > max ? s.generatedAt : max),
      null as string | null,
    );
  });

  readonly todaysSignalCount = computed(() => {
    const start = startOfToday();
    return this.allSignals().filter((s) => new Date(s.generatedAt).getTime() >= start).length;
  });

  // ── Activity feed ────────────────────────────────────────────────────
  // Fold the most recent positions, signals, and orders into a single
  // chronologically-ordered stream. Capped so the list stays scannable.
  readonly activityFeed = computed<ActivityEntry[]>(() => {
    const events: ActivityEntry[] = [];

    for (const p of this.openPositions().slice(0, 10)) {
      events.push({
        id: `pos-open-${p.id}`,
        kind: 'open',
        symbol: p.symbol ?? '—',
        text: `${p.direction} ${p.openLots.toFixed(2)} lots @ ${p.averageEntryPrice.toFixed(5)}`,
        detail: null,
        at: p.openedAt,
      });
    }

    for (const p of this.closedPositions().slice(0, 15)) {
      if (!p.closedAt) continue;
      events.push({
        id: `pos-close-${p.id}`,
        kind: 'close',
        symbol: p.symbol ?? '—',
        text: `Closed ${p.direction} ${p.openLots.toFixed(2)} lots`,
        detail: `${p.realizedPnL >= 0 ? '+' : ''}${p.realizedPnL.toFixed(2)}`,
        at: p.closedAt,
      });
    }

    for (const s of this.allSignals().slice(0, 15)) {
      const kind: ActivityEntry['kind'] = s.status === 'Rejected' ? 'reject' : 'signal';
      events.push({
        id: `sig-${s.id}`,
        kind,
        symbol: s.symbol ?? '—',
        text: `${s.direction} signal · ${(s.confidence * 100).toFixed(0)}% conf`,
        detail: s.status,
        at: s.generatedAt,
      });
    }

    for (const o of this.recentOrders().slice(0, 10)) {
      if (o.status !== 'Filled') continue;
      events.push({
        id: `ord-${o.id}`,
        kind: 'fill',
        symbol: o.symbol ?? '—',
        text: `Filled ${o.orderType} ${o.quantity.toFixed(2)} @ ${(o.filledPrice ?? 0).toFixed(5)}`,
        detail: null,
        at: o.filledAt ?? o.createdAt,
      });
    }

    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
  });

  // ── Charts ────────────────────────────────────────────────────────────
  readonly equityCurveChart = computed<EChartsOption>(() => {
    const closed = [...this.closedPositions()].filter((p) => p.closedAt);
    if (closed.length === 0) return emptyChart('No closed positions yet');
    closed.sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));

    const cutoff = Date.now() - 30 * 24 * 3600_000;
    const inWindow = closed.filter((p) => new Date(p.closedAt!).getTime() >= cutoff);
    if (inWindow.length === 0) return emptyChart('No trades in the last 30 days');

    let cum = 0;
    const xs: string[] = [];
    const ys: number[] = [];
    for (const p of inWindow) {
      cum += p.realizedPnL;
      xs.push(p.closedAt!.slice(5, 16).replace('T', ' '));
      ys.push(+cum.toFixed(2));
    }
    const last = ys[ys.length - 1] ?? 0;
    const lineColor = last >= 0 ? '#34C759' : '#FF3B30';
    return {
      grid: { top: 16, right: 24, bottom: 28, left: 56 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: xs, axisLabel: { fontSize: 10, hideOverlap: true } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: ys,
          lineStyle: { color: lineColor, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: hexWithAlpha(lineColor, 0.25) },
                { offset: 1, color: hexWithAlpha(lineColor, 0.0) },
              ],
            },
          },
        },
      ],
    };
  });

  readonly dailyPnlChart = computed<EChartsOption>(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return emptyChart('No closed positions yet');
    const buckets = new Map<string, number>();
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    for (const p of closed) {
      if (!p.closedAt) continue;
      if (new Date(p.closedAt).getTime() < cutoff) continue;
      const key = p.closedAt.slice(0, 10);
      buckets.set(key, (buckets.get(key) ?? 0) + p.realizedPnL);
    }
    const dates = Array.from(buckets.keys()).sort();
    const values = dates.map((d) => +(buckets.get(d) ?? 0).toFixed(2));
    return {
      grid: { top: 16, right: 12, bottom: 28, left: 50 },
      xAxis: { type: 'category', data: dates.map((d) => d.slice(5)), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'bar',
          data: values.map((v) => ({
            value: v,
            itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [3, 3, 0, 0] },
          })),
        },
      ],
    };
  });

  readonly pnlBySymbolChart = computed<EChartsOption>(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return emptyChart('No closed trades yet');
    const buckets = new Map<string, number>();
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    for (const p of closed) {
      if (!p.closedAt || !p.symbol) continue;
      if (new Date(p.closedAt).getTime() < cutoff) continue;
      buckets.set(p.symbol, (buckets.get(p.symbol) ?? 0) + p.realizedPnL);
    }
    const sorted = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return emptyChart('No trades in the last 30 days');
    return {
      grid: { top: 10, right: 24, bottom: 28, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      yAxis: { type: 'category', data: sorted.map(([s]) => s), axisLabel: { fontSize: 10 } },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'bar',
          data: sorted.map(([, v]) => ({
            value: +v.toFixed(2),
            itemStyle: {
              color: v >= 0 ? '#34C759' : '#FF3B30',
              borderRadius: [0, 3, 3, 0],
            },
          })),
          // barMaxWidth — bar grows up to 18px when there's vertical room;
          // ECharts auto-shrinks below this when the category slot is
          // narrower (lots of symbols).  Without it, a tall card with few
          // symbols ends up with chunky 40-50px bars.
          barMaxWidth: 18,
        },
      ],
    };
  });

  readonly exposureChart = computed<EChartsOption>(() => {
    const open = this.openPositions();
    if (open.length === 0) return emptyChart('No open positions');
    const byBreakdown = new Map<string, number>();
    for (const p of open) {
      if (!p.symbol) continue;
      byBreakdown.set(p.symbol, (byBreakdown.get(p.symbol) ?? 0) + p.openLots);
    }
    const sorted = Array.from(byBreakdown.entries()).sort((a, b) => b[1] - a[1]);
    return {
      grid: { top: 10, right: 20, bottom: 28, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      yAxis: { type: 'category', data: sorted.map(([s]) => s), axisLabel: { fontSize: 10 } },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'bar',
          data: sorted.map(([, lots]) => +lots.toFixed(2)),
          itemStyle: { color: '#0071E3', borderRadius: [0, 3, 3, 0] },
          barMaxWidth: 18,
        },
      ],
    };
  });

  readonly allocationChart = computed<EChartsOption>(() => {
    const allocs = this.allocations();
    if (allocs.length === 0) return emptyChart('No active allocations');
    const data = allocs
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((a, i) => ({
        name: a.strategyName ?? `#${a.strategyId}`,
        value: +(a.weight * 100).toFixed(2),
        itemStyle: { color: PALETTE[i % PALETTE.length] },
      }));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      legend: {
        bottom: 4,
        type: 'scroll',
        textStyle: { fontSize: 10 },
      },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '42%'],
          label: { show: false },
          data,
        },
      ],
    };
  });

  ngOnInit(): void {
    this.refresh();
  }

  // 15s polling backstop. Realtime push events also call refresh() when a fill
  // / position-open / position-close lands; the polling timer covers anything
  // the realtime channel doesn't.
  // Property-initializer side-effect: createPolledResource starts on subscribe.
  private readonly _poll = createPolledResource(
    () =>
      of(null).pipe(
        map(() => {
          this.refresh();
          return null;
        }),
      ),
    { intervalMs: 15_000, runImmediately: false },
  );

  // Single-shot refresh — tolerant: every leaf catchError returns an empty
  // shape so a flaky ML endpoint doesn't blank the rest of the dashboard.
  private refresh(): void {
    forkJoin({
      positions: this.positionsService.list({ currentPage: 1, itemCountPerPage: 500 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as PositionDto[])),
      ),
      strategies: this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as StrategyDto[])),
      ),
      signals: this.signalsService.list({ currentPage: 1, itemCountPerPage: 100 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as TradeSignalDto[])),
      ),
      orders: this.ordersService.list({ currentPage: 1, itemCountPerPage: 50 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as OrderDto[])),
      ),
      status: this.healthService.getStatus().pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as EngineStatusDto | null)),
      ),
      drawdown: this.drawdownService.getLatest().pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as DrawdownSnapshotDto | null)),
      ),
      // Fetch ALL accounts (not just "current active") — the dashboard
      // is multi-account aware and the operator selects which one (or
      // the aggregate) to display via the header dropdown.  The 50-item
      // page size comfortably covers any realistic operator setup.
      accounts: this.accountsService.list({ currentPage: 1, itemCountPerPage: 50 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as TradingAccountDto[])),
      ),
      allocations: this.ensembleService.getAllocations().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as StrategyAllocationDto[])),
      ),
      alerts: this.alertsService.list({ currentPage: 1, itemCountPerPage: 25 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as AlertDto[])),
      ),
      eaInstances: this.eaService.list().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as EAInstanceDto[])),
      ),
      workers: this.workersService.list().pipe(catchError(() => of([] as WorkerHealthDto[]))),
      mlModels: this.mlService.list({ currentPage: 1, itemCountPerPage: 25 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as MLModelDto[])),
      ),
    }).subscribe(
      ({
        positions,
        strategies,
        signals,
        orders,
        status,
        drawdown,
        accounts,
        allocations,
        alerts,
        eaInstances,
        workers,
        mlModels,
      }) => {
        // Set RAW position/order buckets — derived signals
        // (openPositions/closedPositions/recentOrders/unrealizedPnl/
        // openPositionCount/topOpenPositions/recentActivity/equityCurve/
        // dailyPnL/winRate/profitFactor/etc.) re-compute reactively when
        // the account scope changes.
        this.rawOpenPositions.set(
          positions.filter((p) => p.status === 'Open' || p.status === 'Closing'),
        );
        this.rawClosedPositions.set(positions.filter((p) => p.status === 'Closed'));
        this.rawRecentOrders.set(orders);

        this.activeStrategyCount.set(strategies.filter((s) => s.status === 'Active').length);

        // Signals are multi-account (engine-side fan-out via SignalAccountAttempt),
        // so the Pending Signals tile stays fleet-wide and is labelled
        // as such in the template.
        const pending = signals.filter((s) => s.status === 'Pending');
        this.pendingSignalCount.set(pending.length);
        this.pendingSignals.set(pending.slice(0, 8));
        this.allSignals.set(signals);

        this.healthStatus.set(status?.isRunning ?? false);
        this.engineStatus.set(status);

        this.drawdown.set(drawdown);

        // accounts + eaInstances are owned by AccountScopeService — no
        // local set call here.  The forkJoin still pulls them so the
        // tiles light up immediately on first paint instead of waiting
        // for the global scope service's 30s tick.
        if (accounts.length > 0) this.accountScope.accounts.set(accounts);
        this.accountScope.eaInstances.set(eaInstances);
        // Selection-staleness fallback is owned by AccountScopeService —
        // it already snaps to the real-aggregate when the persisted
        // selection points at a no-longer-live account.
        const acc = this.account();
        if (acc) this.equity.set(acc.equity);

        this.allocations.set(allocations);
        this.alerts.set(alerts);
        // eaInstances was set above (before the account/equity derivations)
        // so liveAccounts() resolves correctly on the same tick.
        this.workers.set(workers);
        this.mlModels.set(mlModels);

        this.loading.set(false);
      },
    );

    // Overfit watchlist runs as a fire-and-forget side fetch — not joined into the
    // main forkJoin so a slow MLModelPredictionLog aggregate (heavier query than the
    // others) never blocks the dashboard's first paint. Empty result on failure.
    this.mlService.getOverfitWatchlist().subscribe({
      next: (res: { data?: MLModelOverfitFlagDto[] | null } | null) =>
        this.overfitWatchlist.set(res?.data ?? []),
      error: () => this.overfitWatchlist.set([]),
    });
  }

  approveSignal(id: number): void {
    this.signalsService.approve(id).subscribe({
      next: () => {
        this.notifications.success('Signal approved');
        this.refresh();
      },
      error: () => this.notifications.error('Failed to approve signal'),
    });
  }

  rejectSignal(id: number): void {
    this.signalsService.reject(id, { reason: 'Rejected from dashboard' }).subscribe({
      next: () => {
        this.notifications.warning('Signal rejected');
        this.refresh();
      },
      error: () => this.notifications.error('Failed to reject signal'),
    });
  }
}

function emptyChart(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'center',
      textStyle: { color: '#8E8E93', fontSize: 12, fontWeight: 'normal' as const },
    },
  };
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hexWithAlpha(hex: string, alpha: number): string {
  // Accepts #RRGGBB. Returns rgba(...) so ECharts colorStops can blend it.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
