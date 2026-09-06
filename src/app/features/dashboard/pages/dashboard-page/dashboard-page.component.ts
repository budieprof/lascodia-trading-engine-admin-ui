import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
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
import { PageContextService } from '@core/assistant/page-context.service';

import type {
  AlertDto,
  DrawdownSnapshotDto,
  EAInstanceDto,
  EngineStatusDto,
  MLModelDto,
  MLModelOverfitFlagDto,
  OrderDto,
  PagerRequest,
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

      <!--
        Hero: the four numbers an operator checks first get full tiles; the
        rest sit in one compact strip beneath. Twelve equal tiles gave the
        equity figure the same weight as the worker count.
      -->
      <div class="hero-strip">
        <div class="kpi-grid">
          <app-metric-card
            label="Account Equity"
            [value]="equity()"
            format="currency"
            dotColor="#0071E3"
          />
          <!--
            Reads the fetched closed-position window (most recent 1000 in
            scope, closedAt desc), not all history — calling it "Lifetime"
            overstated it on any account with more closed trades than the
            page holds.
          -->
          <app-metric-card
            label="Realized P&L (recent)"
            [value]="lifetimePnl()"
            format="currency"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Drawdown"
            [value]="drawdownPct()"
            format="percent"
            [colorByValue]="true"
            [invertColor]="true"
            [dotColor]="drawdownDot()"
          />
          <app-metric-card
            label="Open Positions"
            [value]="openPositionCount()"
            format="number"
            dotColor="#5AC8FA"
          />
        </div>
        <div class="stat-strip">
          @for (s of secondaryStats(); track s.label) {
            <div class="strip-item" [title]="s.hint ?? ''">
              <span class="strip-label">{{ s.label }}</span>
              <span
                class="strip-value"
                [class.profit]="s.tone === 'good'"
                [class.loss]="s.tone === 'bad'"
                [class.warn]="s.tone === 'warn'"
              >
                {{ s.value }}
              </span>
            </div>
          }
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

      <!--
        3-up: P&L by symbol attribution, exposure, allocation. P&L sizes
        itself to its row count (top 10 + "Other") so bars never collapse
        into invisibility; exposure is a plain bar list because two or three
        symbols in a 380px chart box was mostly empty canvas.
      -->
      <div class="charts-3">
        <app-chart-card
          title="P&L by Symbol"
          [subtitle]="pnlBySymbolSubtitle()"
          [options]="pnlBySymbolChart()"
          [height]="pnlBySymbolHeight()"
          [loading]="loading()"
        />
        <section class="panel exposure-panel">
          <header class="panel-head">
            <h3>Position Exposure</h3>
            <span class="muted">Open lots by symbol</span>
          </header>
          @if (exposureRows().length > 0) {
            <ul class="xbar-list">
              @for (r of exposureRows(); track r.symbol) {
                <li class="xbar-row">
                  <span class="mono xbar-symbol">{{ r.symbol }}</span>
                  <span class="xbar-track">
                    <span class="xbar-fill" [style.width.%]="r.pct"></span>
                  </span>
                  <span class="mono xbar-value">{{ r.lots | number: '1.2-2' }}</span>
                </li>
              }
            </ul>
            <div class="xbar-total muted">
              {{ exposureTotalLots() | number: '1.2-2' }} lots across
              {{ exposureRows().length }} symbol{{ exposureRows().length === 1 ? '' : 's' }}
            </div>
          } @else {
            <div class="empty-panel">No open positions</div>
          }
        </section>
        <app-chart-card
          title="Strategy Allocation"
          [subtitle]="allocationSubtitle()"
          [options]="allocationChart()"
          height="300px"
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
                    <td class="num mono">{{ fmtPrice(p.symbol, p.averageEntryPrice) }}</td>
                    <td class="num mono">{{ fmtPrice(p.symbol, p.currentPrice) }}</td>
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

      <!--
        Activity feed + worker health on one row, alerts + overfit watchlist
        on the next. Four panels in a three-column grid left the watchlist
        alone on a half-empty row.
      -->
      <div class="ops-grid">
        <section class="panel ops-activity">
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
                  <!-- One absolute stamp per row; mixed "about 20 hours ago" / "1 day ago" read as two scales. -->
                  <span class="muted activity-time" [title]="e.at | date: 'd MMM yyyy, HH:mm:ss'">
                    {{ e.at | date: 'd MMM HH:mm' }}
                  </span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No recent activity</div>
          }
        </section>

        <section class="panel ops-workers">
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
                <li class="worker-row" [attr.data-status]="w.statusLabel">
                  <span class="status-dot" [attr.data-status]="w.statusLabel"></span>
                  <span class="worker-name mono">{{ w.name }}</span>
                  <span class="worker-meta muted">{{ w.statusLabel }}</span>
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

        <section class="panel ops-alerts">
          <header class="panel-head">
            <h3>Recent Alerts</h3>
            <a routerLink="/alerts" class="link">All alerts</a>
          </header>
          @if (recentAlerts().length > 0) {
            <ul class="alerts">
              @for (a of recentAlerts(); track a.id) {
                <li class="alert-item">
                  <span
                    class="alert-pill"
                    [attr.data-severity]="a.severity"
                    [title]="a.isActive ? 'Rule enabled' : 'Rule disabled'"
                  >
                    {{ a.alertType }}
                  </span>
                  <span class="mono">{{ a.symbol ?? 'fleet' }}</span>
                  <span class="muted alert-channel">
                    {{ a.severity }}{{ a.isActive ? '' : ' · rule disabled' }}
                  </span>
                  <span
                    class="muted alert-time"
                    [title]="a.lastTriggeredAt | date: 'd MMM yyyy, HH:mm'"
                  >
                    {{ a.lastTriggeredAt | relativeTime }}
                  </span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-panel">No alert has fired yet</div>
          }
        </section>

        <section class="panel ops-overfit">
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

      <!-- Compact status footer — same strip styling as the hero's secondary stats. -->
      <div class="stat-strip status-strip">
        <div class="strip-item">
          <span class="strip-label">Engine</span>
          <span class="strip-value" [class.profit]="healthStatus()" [class.loss]="!healthStatus()">
            {{ healthStatus() ? 'Running' : 'Stopped' }}
          </span>
          @if (engineStatus(); as s) {
            <!--
              paperMode is the raw EngineConfig string ("true" / "false"), not a mode name — the
              card used to print a literal "false" under "Running".
            -->
            <span class="strip-sub">
              {{ isPaperMode(s.paperMode) ? 'paper trading' : 'live trading' }} · checked
              {{ s.checkedAt | relativeTime }}
            </span>
          }
        </div>
        <div class="strip-item">
          <span class="strip-label">Drawdown</span>
          @if (drawdown(); as d) {
            <span class="strip-value" [class.loss]="d.drawdownPct > 0">
              {{ d.drawdownPct | number: '1.2-2' }}%
            </span>
            <span class="strip-sub">{{ d.recoveryMode }} mode</span>
          } @else {
            <span class="strip-value muted">—</span>
          }
        </div>
        <div class="strip-item">
          <span class="strip-label">Account</span>
          @if (account(); as a) {
            <span class="strip-value">{{ a.accountName ?? a.accountId }}</span>
            <span class="strip-sub">
              {{ a.currency ?? '' }} · margin {{ marginUsedPct() | number: '1.1-1' }}%
            </span>
          } @else {
            <span class="strip-value muted">—</span>
          }
        </div>
        <div class="strip-item">
          <span class="strip-label">ML Models</span>
          @if (activeMlModelCount() !== null) {
            <span class="strip-value">{{ activeMlModelCount() | number }} active</span>
            <span class="strip-sub">
              @if (mostRecentMlModel(); as m) {
                latest {{ m.symbol }} {{ m.timeframe }} · {{ m.trainedAt | relativeTime }}
              } @else {
                no active models
              }
            </span>
          } @else {
            <span class="strip-value muted">—</span>
          }
        </div>
        <div class="strip-item">
          <span class="strip-label">Last Signal</span>
          @if (lastSignalAt()) {
            <span class="strip-value">{{ lastSignalAt() | relativeTime }}</span>
            <span class="strip-sub">{{ todaysSignalCount() | number }} today</span>
          } @else {
            <span class="strip-value muted">No signals yet</span>
          }
        </div>
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
      /* minmax(0, 1fr) keeps every tile the same width — with plain 1fr a long
         currency value widened its own column and squeezed its neighbours. */
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
        position: relative;
        z-index: 1;
        align-items: start;
      }
      @media (max-width: 900px) {
        .kpi-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      /* One strip style for the demoted hero stats and the status footer. */
      .stat-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: var(--space-2);
        position: relative;
        z-index: 1;
        margin-top: var(--space-3);
      }
      .stat-strip.status-strip {
        margin-top: 0;
      }
      .strip-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .strip-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .strip-value {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .strip-value.warn {
        color: var(--warning);
      }
      .strip-sub {
        font-size: 10.5px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .charts-2-1 {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: var(--space-4);
        align-items: start;
      }
      .charts-3 {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-4);
        align-items: start;
      }
      .tables-2 {
        display: grid;
        grid-template-columns: 3fr 2fr;
        gap: var(--space-4);
        align-items: start;
      }
      .ops-grid {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-4);
        align-items: start;
      }
      .ops-activity {
        grid-column: span 4;
      }
      .ops-workers {
        grid-column: span 2;
      }
      .ops-alerts,
      .ops-overfit {
        grid-column: span 3;
      }
      @media (max-width: 1200px) {
        .charts-2-1,
        .charts-3,
        .tables-2 {
          grid-template-columns: 1fr;
        }
        .ops-grid {
          grid-template-columns: 1fr;
        }
        .ops-activity,
        .ops-workers,
        .ops-alerts,
        .ops-overfit {
          grid-column: auto;
        }
      }

      /* Exposure bar list */
      .xbar-list {
        list-style: none;
        margin: 0;
        padding: var(--space-2) 0;
      }
      .xbar-row {
        display: grid;
        grid-template-columns: 72px 1fr 56px;
        align-items: center;
        gap: var(--space-3);
        padding: 5px var(--space-4);
        font-size: var(--text-xs);
      }
      .xbar-symbol {
        font-weight: var(--font-semibold);
      }
      .xbar-track {
        height: 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .xbar-fill {
        display: block;
        height: 100%;
        background: #0071e3;
        border-radius: var(--radius-full);
      }
      .xbar-value {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .xbar-total {
        padding: var(--space-2) var(--space-4) var(--space-3);
        font-size: 10.5px;
        border-top: 1px solid var(--border);
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
      .status-dot[data-status='Stale'] {
        background: var(--warning);
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
      /* Colour carries severity, not whether the rule is switched on. */
      .alert-pill[data-severity='High'],
      .alert-pill[data-severity='Critical'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .alert-pill[data-severity='Medium'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .alert-channel,
      .alert-time {
        font-size: 10.5px;
      }
      .alert-time {
        white-space: nowrap;
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

      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
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

  private readonly pageContext = inject(PageContextService);

  constructor() {
    this.pageContext.publish(() => ({
      headline: 'Live engine overview for the selected account scope',
      figures: {
        accountEquity: this.equity(),
        drawdownPct: this.drawdownPct(),
        openPositions: this.openPositionCount(),
        activeStrategies: this.activeStrategyCount(),
        engineRunning: this.healthStatus() ? 'running' : 'not running',
      },
    }));

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

    // Re-fetch everything account-scoped any time the scoped account set
    // changes — selecting a different account (or the aggregate) in the
    // header dropdown re-issues /drawdown-recovery/latest?accountIds=…
    // AND re-runs the position/order queries, which are now narrowed
    // server-side and would otherwise keep serving the previous scope's
    // page until the 15 s poll came round.
    //
    // The dependency is `accountIdsKey()`, NOT `accountIds()` /
    // `scopedAccountIds()`: those recompute to a fresh array (or Set) on
    // every 30 s account refresh, so an effect reading them would re-fire
    // — and re-fetch — even when the selection never moved. The key only
    // changes when the id set genuinely does.
    //
    // refresh() is untracked because it writes back into the very signals
    // the key derives from (accounts / eaInstances); tracking its reads
    // would close the loop.  Effect runs in injection context so
    // takeUntilDestroyed is handled automatically.
    effect(() => {
      const key = this.accountScope.accountIdsKey();
      if (key.length === 0) return;
      // refresh() issues the drawdown fetch scoped to the same id set, so
      // a second dedicated call here would only race it — and the loser
      // was the one that decided what the tile showed.
      untracked(() => this.refresh());
    });
  }

  // ── Data signals ──────────────────────────────────────────────────────
  readonly loading = signal(true);
  // Derived from openPositions() — re-derives when scope changes.
  readonly unrealizedPnl = computed<number | null>(() => {
    const open = this.openPositions();
    if (open.length === 0) return null;
    return open.reduce((s, p) => s + p.unrealizedPnL, 0);
  });
  readonly openPositionCount = computed<number | null>(() => this.openPositions().length || null);
  readonly strategies = signal<StrategyDto[]>([]);
  /**
   * A strategy is "active" if its status says so OR the ensemble is giving it
   * weight — the allocation donut draws the second set, so counting only the
   * first showed "Active Strategies 0" beside a donut of six.
   */
  readonly activeStrategyCount = computed<number | null>(() => {
    const ids = new Set<number>();
    for (const s of this.strategies()) if (s.status === 'Active') ids.add(s.id);
    for (const a of this.allocations()) if (a.weight > 0) ids.add(a.strategyId);
    if (this.strategies().length === 0 && this.allocations().length === 0) return null;
    return ids.size;
  });
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

  // Resolve through the scope service's `effectiveSelected` rather than
  // the raw `selected` signal, so the account this tile-set aggregates
  // over is *by construction* the same one the header pill displays and
  // the same one `accountIds()` filters by.  Re-deriving the sentinel /
  // stale-id fallback locally is what let the two drift apart.
  readonly account = computed<TradingAccountDto | null>(() => {
    const live = this.liveAccounts();
    if (live.length === 0) return null;
    const sel = this.accountScope.effectiveSelected();
    if (sel === AccountScopeService.SCOPE_AGGREGATE_REAL) {
      return DashboardPageComponent.aggregateReal(live.filter((a) => !a.isPaper));
    }
    if (sel === AccountScopeService.SCOPE_AGGREGATE_ALL) {
      return DashboardPageComponent.aggregateReal(live);
    }
    return live.find((a) => a.id === Number(sel)) ?? null;
  });

  // Account Equity tile — derived from the scoped account() so it re-computes
  // the instant the header dropdown changes, exactly like the other
  // account-scoped KPIs. (Previously an imperative signal set only inside
  // refresh(), so switching accounts left it stale until the next 15s poll.)
  readonly equity = computed<number | null>(() => this.account()?.equity ?? null);

  readonly realAccountCount = computed(() => this.liveAccounts().filter((a) => !a.isPaper).length);

  // Engine-tagged ids set the dashboard filters against.  Reads
  // straight from the global scope; the AccountScopeService owns the
  // sentinel-vs-id resolution, paper-exclusion default, and stale-
  // selection fallback.
  readonly scopedAccountIds = computed<Set<number>>(() => new Set(this.accountScope.accountIds()));

  /** Synthesize an aggregated DTO across the supplied accounts.  Sums balance/
   *  equity/margin; pairs the resulting equity-weighted marginLevel.
   *  Returns the only account when there's just one, or null when the set
   *  is empty.
   *
   *  The caller decides membership and passes exactly the accounts to roll
   *  up — this used to re-apply its own `!isPaper` filter, which silently
   *  dropped every paper account back out of the "All live (incl. paper)"
   *  scope, so that option aggregated the same set as "All real".  Callers
   *  pass already-live accounts (those with an actually-running
   *  EAInstance); `isActive` is sticky and would readmit detached ones. */
  private static aggregateReal(scopedAccounts: TradingAccountDto[]): TradingAccountDto | null {
    const real = scopedAccounts;
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
      accountName: `Aggregate · ${real.length} accounts`,
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
      isPaper: real.every((a) => a.isPaper),
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
  // Owned by AccountScopeService — refresh() writes the fetched list
  // there, not into a page-local copy.  This used to be a separate
  // `signal([])` that nothing ever set, which pinned the EA Connections
  // tile at 0 no matter how many EAs were attached.
  readonly eaInstances = this.accountScope.eaInstances;
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

  /** null when there is nothing to divide; Infinity when there were wins and no losses. */
  readonly profitFactor = computed<number | null>(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return null;
    const grossWin = closed.filter((p) => p.realizedPnL > 0).reduce((s, p) => s + p.realizedPnL, 0);
    const grossLoss = Math.abs(
      closed.filter((p) => p.realizedPnL < 0).reduce((s, p) => s + p.realizedPnL, 0),
    );
    if (grossLoss === 0) return grossWin > 0 ? Infinity : null;
    return grossWin / grossLoss;
  });

  /**
   * Null until a snapshot for the CURRENT scope has arrived — the tile then
   * shows "—" rather than a hard 0.00%, which would be a measurement the
   * page does not have. (An account genuinely at its high-water mark does
   * report 0.00%, and that reads as the measurement it is.)
   */
  readonly drawdownPct = computed(() => this.drawdown()?.drawdownPct ?? null);

  /** Engine defaults: Reduced from 10 %, Halted from 20 %. */
  readonly drawdownDot = computed(() => {
    const dd = this.drawdownPct();
    if (dd == null) return 'var(--text-tertiary)';
    if (dd >= 20) return '#FF3B30';
    if (dd >= 10) return '#FF9500';
    return '#34C759';
  });

  /**
   * The demoted hero stats. Formatted here so the strip shows one number
   * style (USD, thousands separators, fixed decimals) and colour only where
   * the sign or a threshold means something — a 63 % win rate is not "good"
   * next to a losing book, and a 0.7 profit factor is not.
   */
  readonly secondaryStats = computed<
    { label: string; value: string; tone: 'good' | 'bad' | 'warn' | ''; hint?: string }[]
  >(() => {
    const money = (v: number | null) =>
      v == null
        ? '—'
        : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
    const signTone = (v: number | null): 'good' | 'bad' | '' =>
      v == null || v === 0 ? '' : v > 0 ? 'good' : 'bad';
    const pf = this.profitFactor();
    const pfTone: 'good' | 'bad' | 'warn' | '' =
      pf == null ? '' : pf >= 1.5 ? 'good' : pf >= 1 ? 'warn' : 'bad';
    const closed = this.closedPositions().length;
    const failed = this.failedWorkerCount();
    const stale = this.staleWorkerCount();
    return [
      {
        label: 'Unrealized P&L',
        value: money(this.unrealizedPnl()),
        tone: signTone(this.unrealizedPnl()),
      },
      { label: 'Today P&L', value: money(this.todaysPnl()), tone: signTone(this.todaysPnl()) },
      {
        label: 'Win rate',
        value: closed === 0 ? '—' : `${this.winRatePct().toFixed(1)}%`,
        tone: '',
        hint: closed === 0 ? undefined : `${closed.toLocaleString('en-US')} recent closed trades`,
      },
      {
        label: 'Profit factor',
        value: pf == null ? '—' : pf === Infinity ? '∞' : pf.toFixed(2),
        tone: pfTone,
        hint: 'Gross wins ÷ gross losses over the recent closed window',
      },
      {
        label: 'Active strategies',
        value: this.activeStrategyCount() == null ? '—' : String(this.activeStrategyCount()),
        tone: '',
      },
      {
        label: 'Pending signals',
        value: this.pendingSignalCount() == null ? '—' : String(this.pendingSignalCount()),
        tone: (this.pendingSignalCount() ?? 0) > 0 ? 'warn' : '',
      },
      {
        label: 'EA connections',
        value: String(this.activeEaCount()),
        tone: this.activeEaCount() === 0 && this.liveAccounts().length > 0 ? 'bad' : '',
      },
      {
        label: 'Workers OK',
        value: `${this.healthyWorkerCount()} / ${this.totalWorkerCount()}`,
        tone: failed > 0 ? 'bad' : stale > 0 ? 'warn' : '',
        hint: failed > 0 || stale > 0 ? `${failed} failed · ${stale} stale` : undefined,
      },
    ];
  });

  /**
   * Price precision follows the instrument: 3 decimals for JPY crosses and
   * metals-style quotes, 5 for everything else — and the same digits for entry
   * and current so the two columns line up.
   */
  fmtPrice(symbol: string | null, price: number | null): string {
    if (price == null || !Number.isFinite(price)) return '—';
    const s = (symbol ?? '').toUpperCase();
    const digits = s.includes('JPY') || s.startsWith('XAU') || s.startsWith('XAG') ? 3 : 5;
    return price.toFixed(digits);
  }

  readonly marginUsedPct = computed(() => {
    const a = this.account();
    if (!a || !a.equity || a.equity <= 0) return 0;
    return ((a.marginUsed ?? 0) / a.equity) * 100;
  });

  // Scoped like every other account-tagged tile: under an aggregate scope
  // this is the EA count across all selected accounts, under a singleton
  // scope it's just that account's EAs.
  readonly activeEaCount = computed(() => {
    const scope = this.scopedAccountIds();
    return this.eaInstances().filter((e) => e.status === 'Active' && scope.has(e.tradingAccountId))
      .length;
  });

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

  // Surface only the worth-investigating workers so the panel stays compact. Stale is a
  // problem too: `isStale` is a flag that overlaps the status (a "Healthy" worker whose last
  // heartbeat is old is stale), so the panel used to say "All 64 workers nominal" under a row
  // reading 61 healthy · 3 idle · 2 stale — numbers that neither add up nor agree with the
  // message.
  readonly problemWorkers = computed(() =>
    this.workers()
      .filter((w) => w.status === 'Failed' || w.status === 'Degraded' || w.isStale)
      .map((w) => ({
        ...w,
        // What the row SAYS. A stale worker keeps its engine status for filtering but is shown
        // as stale, because that is the reason it is in this list.
        statusLabel:
          w.isStale && w.status !== 'Failed' && w.status !== 'Degraded' ? 'Stale' : w.status,
      }))
      .slice(0, 5),
  );

  /** The engine reports paper mode as the raw config string, "true" or "false". */
  isPaperMode(raw: string | null | undefined): boolean {
    return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
  }

  readonly topOpenPositions = computed(() =>
    [...this.openPositions()].sort((a, b) => b.unrealizedPnL - a.unrealizedPnL).slice(0, 6),
  );

  /**
   * Alerts that have actually fired, newest first, one row per (type, symbol).
   * The engine keeps several rule rows for the same type+symbol (each with its
   * own dedup key), so the raw list showed "MLMonitoringStale EURUSD" twice.
   */
  readonly recentAlerts = computed(() => {
    const byKey = new Map<string, AlertDto>();
    for (const a of this.alerts()) {
      if (!a.lastTriggeredAt) continue;
      const key = `${a.alertType}|${a.symbol ?? ''}`;
      const prev = byKey.get(key);
      if (!prev || (prev.lastTriggeredAt ?? '') < a.lastTriggeredAt) byKey.set(key, a);
    }
    return [...byKey.values()]
      .sort((a, b) => (b.lastTriggeredAt ?? '').localeCompare(a.lastTriggeredAt ?? ''))
      .slice(0, 6);
  });

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

  /**
   * Realized P&L per symbol over 30 days, biggest winners first, losers last.
   * Twenty symbols in a fixed box made most bars sub-pixel; the chart now
   * keeps the ten largest contributors by magnitude, folds the rest into one
   * "Other" bar, and sizes its own height from the row count.
   */
  private readonly pnlBySymbolRows = computed(() => {
    const closed = this.closedPositions();
    const buckets = new Map<string, number>();
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    for (const p of closed) {
      if (!p.closedAt || !p.symbol) continue;
      if (new Date(p.closedAt).getTime() < cutoff) continue;
      buckets.set(p.symbol, (buckets.get(p.symbol) ?? 0) + p.realizedPnL);
    }
    const byMagnitude = Array.from(buckets.entries()).sort(
      (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
    );
    const top = byMagnitude.slice(0, 10);
    const rest = byMagnitude.slice(10);
    const rows = top.sort((a, b) => b[1] - a[1]).map(([symbol, pnl]) => ({ symbol, pnl }));
    if (rest.length > 0) {
      rows.push({
        symbol: `Other (${rest.length})`,
        pnl: rest.reduce((s, [, v]) => s + v, 0),
      });
    }
    return { rows, symbolCount: buckets.size };
  });

  readonly pnlBySymbolHeight = computed(
    () => `${Math.max(220, 48 + 26 * this.pnlBySymbolRows().rows.length)}px`,
  );

  readonly pnlBySymbolSubtitle = computed(() => {
    const { rows, symbolCount } = this.pnlBySymbolRows();
    if (rows.length === 0) return 'Realized contribution, last 30 days';
    return symbolCount > 10
      ? `Realized, last 30 days · top 10 of ${symbolCount} symbols + other`
      : `Realized, last 30 days · ${symbolCount} symbol${symbolCount === 1 ? '' : 's'}`;
  });

  readonly pnlBySymbolChart = computed<EChartsOption>(() => {
    if (this.closedPositions().length === 0) return emptyChart('No closed trades yet');
    const { rows } = this.pnlBySymbolRows();
    if (rows.length === 0) return emptyChart('No trades in the last 30 days');
    return {
      grid: { top: 8, right: 24, bottom: 28, left: 8, containLabel: true },
      xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.symbol),
        axisLabel: { fontSize: 10 },
      },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) =>
          new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(v)),
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: +r.pnl.toFixed(2),
            itemStyle: {
              color: r.pnl >= 0 ? '#34C759' : '#FF3B30',
              borderRadius: r.pnl >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3],
            },
          })),
          barMaxWidth: 16,
        },
      ],
    };
  });

  /** Open lots per symbol as a bar list — sized against the largest symbol. */
  readonly exposureRows = computed(() => {
    const byBreakdown = new Map<string, number>();
    for (const p of this.openPositions()) {
      if (!p.symbol) continue;
      byBreakdown.set(p.symbol, (byBreakdown.get(p.symbol) ?? 0) + p.openLots);
    }
    const sorted = Array.from(byBreakdown.entries()).sort((a, b) => b[1] - a[1]);
    const max = sorted[0]?.[1] ?? 0;
    return sorted.map(([symbol, lots]) => ({
      symbol,
      lots,
      pct: max > 0 ? (lots / max) * 100 : 0,
    }));
  });

  readonly exposureTotalLots = computed(() => this.exposureRows().reduce((s, r) => s + r.lots, 0));

  readonly allocationSubtitle = computed(() => {
    const n = this.allocations().filter((a) => a.weight > 0).length;
    return n === 0
      ? 'Ensemble weights'
      : `Ensemble weights · ${n} strateg${n === 1 ? 'y' : 'ies'} allocated`;
  });

  readonly allocationChart = computed<EChartsOption>(() => {
    const allocs = this.allocations().filter((a) => a.weight > 0);
    if (allocs.length === 0) return emptyChart('No active allocations');
    const data = allocs
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((a, i) => ({
        name: a.strategyName ?? `#${a.strategyId}`,
        value: +(a.weight * 100).toFixed(2),
        itemStyle: { color: PALETTE[i % PALETTE.length] },
      }));
    const pct = new Map(data.map((d) => [d.name, d.value]));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      // A vertical legend beside the ring lists every strategy with its
      // weight; the scrolling bottom legend showed one truncated name at a time.
      legend: {
        orient: 'vertical',
        right: 0,
        top: 'middle',
        type: 'plain',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 6,
        textStyle: { fontSize: 10, width: 118, overflow: 'truncate' },
        formatter: (name: string) => `${name}  ${(pct.get(name) ?? 0).toFixed(1)}%`,
      },
      series: [
        {
          type: 'pie',
          radius: ['46%', '72%'],
          center: ['30%', '50%'],
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

  /**
   * Narrow a paged request to the accounts currently in scope so the
   * engine filters before paging.  Left undecorated when the scope is
   * empty (accounts not loaded yet) — the client-side `scopedAccountIds`
   * filter on the derived signals still holds the line, so a first paint
   * that races the account fetch shows nothing rather than everything.
   */
  private scopedRequest(params: PagerRequest): PagerRequest {
    const ids = this.accountScope.accountIds();
    if (ids.length === 0) return params;
    return {
      ...params,
      filter: {
        ...((params.filter as object | null) ?? {}),
        tradingAccountIds: Array.from(ids),
      },
    };
  }

  // Single-shot refresh — tolerant: every leaf catchError returns an empty
  // shape so a flaky ML endpoint doesn't blank the rest of the dashboard.
  /**
   * Monotonic token for in-flight refreshes. Every query in the forkJoin is
   * scoped to the account set as it stood when the refresh STARTED, so a
   * response that arrives after a newer refresh began describes the wrong
   * scope. The first load proves it: the initial refresh runs before the
   * account list resolves, so it asks for the fleet, and the scoped refresh
   * that follows finished FIRST — leaving a brand-new account showing the
   * fleet's 7.62% drawdown and "Reduced mode". Results from a superseded
   * refresh are now dropped rather than written over the current scope.
   */
  private refreshGeneration = 0;

  private refresh(): void {
    const generation = ++this.refreshGeneration;
    forkJoin({
      // Open and closed are fetched as SEPARATE status-scoped queries, the
      // same way the Positions page loads its KPI window, and for the same
      // reason: one mixed page is an arbitrary truncation. It used to be a
      // single unscoped 500-row pull filtered down in the browser, which
      // failed twice over —
      //   1. the page budget was spent FLEET-wide, so under an aggregate
      //      scope across six accounts the tiles saw whatever slice each
      //      account happened to get, and under a single-account scope
      //      most of the 500 rows were discarded on arrival;
      //   2. the server's default sort is by OPEN date, so a trade opened
      //      long ago and closed yesterday fell outside the window and
      //      went missing from the 30-day equity curve and daily P&L.
      // Closed is now sorted by closedAt desc so the window really is the
      // most recently closed trades, and open positions get their own
      // budget instead of competing with thousands of closed rows.
      openPositions: this.positionsService
        .list(
          this.scopedRequest({
            currentPage: 1,
            itemCountPerPage: 500,
            filter: { status: 'Open' },
          }),
        )
        .pipe(
          map((r) => r.data?.data ?? []),
          catchError(() => of([] as PositionDto[])),
        ),
      // 1000 covers the 30-day window the charts draw with room to spare at
      // current fleet volume (~870 closed trades / 30 days across six live
      // accounts). The headline P&L / win-rate / profit-factor tiles read
      // this same window — they are "recent", not all-time, and the labels
      // say so.
      closedPositions: this.positionsService
        .list(
          this.scopedRequest({
            currentPage: 1,
            itemCountPerPage: 1000,
            filter: { status: 'Closed' },
            sortBy: 'closedAt',
            sortDirection: 'desc',
          }),
        )
        .pipe(
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
      orders: this.ordersService
        .list(this.scopedRequest({ currentPage: 1, itemCountPerPage: 50 }))
        .pipe(
          map((r) => r.data?.data ?? []),
          catchError(() => of([] as OrderDto[])),
        ),
      status: this.healthService.getStatus().pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as EngineStatusDto | null)),
      ),
      // Scoped like every other account-aware query on this page. Fetching
      // it unscoped here overwrote the per-account value on every poll, so
      // a brand-new account with a flat equity curve reported the FLEET's
      // drawdown (7.62% and "Reduced mode" on an account whose own
      // snapshot said 0.0% / Normal). The tile and the footer strip read
      // the same signal, so both were wrong together.
      drawdown: this.drawdownService.getLatest(this.accountScope.accountIds()).pipe(
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
        openPositions,
        closedPositions,
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
        // A newer refresh (usually an account-scope change) started while
        // this one was in flight — its scope is the current truth.
        if (generation !== this.refreshGeneration) return;

        // Set RAW position/order buckets — derived signals
        // (openPositions/closedPositions/recentOrders/unrealizedPnl/
        // openPositionCount/topOpenPositions/recentActivity/equityCurve/
        // dailyPnL/winRate/profitFactor/etc.) re-compute reactively when
        // the account scope changes.
        // Defensive status re-partition — the server-side status filter is
        // a no-op on older engine builds. Closing rows are admitted here
        // because they are still live broker exposure; the engine's
        // Status='Open' filter is an exact enum match and won't return
        // them, which matches how the Positions page loads its own window.
        this.rawOpenPositions.set(
          openPositions.filter((p) => p.status === 'Open' || p.status === 'Closing'),
        );
        this.rawClosedPositions.set(closedPositions.filter((p) => p.status === 'Closed'));
        this.rawRecentOrders.set(orders);

        this.strategies.set(strategies);

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
        // selection points at a no-longer-live account. Account Equity is a
        // computed off account(), so it needs no imperative set here — it
        // re-derives reactively from the refreshed accounts + the scope.

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
