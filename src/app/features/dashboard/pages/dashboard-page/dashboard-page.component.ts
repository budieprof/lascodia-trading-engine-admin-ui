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

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
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

/**
 * Strategy-allocation hues, in fixed order. Validated with the dataviz palette checker in light
 * and dark (lightness band, chroma, colour-blind separation of neighbours). Green and red stay
 * out: on this page they mean profit and loss. Past six strategies the tail folds into "Other".
 */
const ALLOC_PALETTE = ['#0071E3', '#E8620C', '#8E44AD', '#0F9D8A', '#B58100', '#D6336C'];
const ALLOC_OTHER = '#8E8E93';

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
    ChartCardComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
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
          Multi-account scope is owned by the global selector in the header
          chrome (AccountScopePillComponent). With a single live account, a
          lightweight label here keeps the chosen account visible.
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
        Hero: equity is the one number the page leads with. Realized (30d),
        drawdown and the open book sit beside it at the next size down; the
        rest of the old KPI tiles live in the strip underneath.
      -->
      <section class="hero" aria-label="Account summary">
        <div class="hero-main">
          <span class="eyebrow">Account equity</span>
          <div class="hero-figure">{{ fmtMoney(equity()) }}</div>
          <div class="hero-sub">
            @if (account(); as a) {
              <span>{{ a.accountName ?? a.accountId }}</span>
              <span class="sep" aria-hidden="true"></span>
              <span>Balance {{ fmtMoney(a.balance) }}</span>
              <span class="sep" aria-hidden="true"></span>
              <span>Margin used {{ marginUsedPct() | number: '1.1-1' }}%</span>
            } @else {
              <span>No live account in scope</span>
            }
          </div>
          <dl class="hero-pnl">
            <div>
              <dt>Unrealized</dt>
              <dd [class]="toneClass(unrealizedPnl())">{{ fmtMoney(unrealizedPnl(), true) }}</dd>
            </div>
            <div>
              <dt>Today</dt>
              <dd [class]="toneClass(todaysPnl())">{{ fmtMoney(todaysPnl(), true) }}</dd>
            </div>
            <div>
              <!--
                The same 30-day window the equity curve, daily P&L and P&L-by-symbol
                charts draw, so the tile and the charts agree.
              -->
              <dt>{{ realizedLabel() }}</dt>
              <dd [class]="toneClass(realizedPnl30d())">{{ fmtMoney(realizedPnl30d(), true) }}</dd>
            </div>
          </dl>
        </div>

        <div class="hero-side">
          <div class="hero-tile">
            <div class="tile-head">
              <span class="eyebrow">Drawdown</span>
              @if (drawdown(); as d) {
                <span class="mode-chip" [attr.data-tone]="drawdownMeter().tone">
                  {{ d.recoveryMode }}
                </span>
              }
            </div>
            <div class="tile-figure" [class.loss]="(drawdownPct() ?? 0) >= 10">
              {{ drawdownPct() === null ? '—' : (drawdownPct() | number: '1.2-2') + '%' }}
            </div>
            <!-- Meter against the engine's recovery thresholds: Reduced 10 %, Halted 20 %. -->
            <div
              class="meter"
              [attr.data-tone]="drawdownMeter().tone"
              role="meter"
              aria-label="Drawdown"
              [attr.aria-valuenow]="drawdownPct() ?? 0"
              aria-valuemin="0"
              [attr.aria-valuemax]="DD_SCALE"
            >
              <span class="meter-fill" [style.width.%]="drawdownMeter().pct"></span>
              <span class="meter-tick" [style.left.%]="(10 / DD_SCALE) * 100"></span>
              <span class="meter-tick" [style.left.%]="(20 / DD_SCALE) * 100"></span>
            </div>
            <div class="meter-scale" aria-hidden="true">
              <span>0%</span>
              <span [style.left.%]="(10 / DD_SCALE) * 100">10% reduced</span>
              <span [style.left.%]="(20 / DD_SCALE) * 100">20% halted</span>
            </div>
          </div>

          <a class="hero-tile tile-link" routerLink="/positions">
            <div class="tile-head">
              <span class="eyebrow">Open positions</span>
              <span class="tile-arrow" aria-hidden="true">→</span>
            </div>
            <div class="tile-figure">
              {{ openPositionCount() === null ? '—' : openPositionCount() }}
            </div>
            <div class="tile-sub">
              @if (exposureRows().length > 0) {
                {{ exposureTotalLots() | number: '1.2-2' }} lots ·
                {{ exposureRows().length }} symbol{{ exposureRows().length === 1 ? '' : 's' }}
              } @else if (openPositionsKnown()) {
                Flat book
              } @else {
                Unavailable
              }
            </div>
          </a>
        </div>
      </section>

      <!-- Secondary stats: one quiet row, hairline-divided, instead of eight boxes. -->
      <section class="stat-row" aria-label="Key figures">
        @for (s of secondaryStats(); track s.label) {
          <div class="stat" [title]="s.hint ?? ''">
            <span class="stat-label">{{ s.label }}</span>
            <span class="stat-value" [attr.data-tone]="s.tone || null">{{ s.value }}</span>
          </div>
        }
      </section>

      <!-- Equity curve dominates; daily P&L histogram alongside. -->
      <div class="grid-2-1">
        <app-chart-card
          title="Equity Curve"
          subtitle="Cumulative realized P&L, last 30 days"
          [options]="equityCurveChart()"
          height="280px"
          [loading]="loading()"
        />
        <app-chart-card
          title="Daily P&L"
          subtitle="Realized P&L per day, last 30 days"
          [options]="dailyPnlChart()"
          height="280px"
          [loading]="loading()"
        />
      </div>

      <div class="grid-3">
        <app-chart-card
          title="P&L by Symbol"
          [subtitle]="pnlBySymbolSubtitle()"
          [options]="pnlBySymbolChart()"
          [height]="pnlBySymbolHeight()"
          [loading]="loading()"
        />

        <section class="card">
          <header class="card-head">
            <h3>Position Exposure</h3>
            <p>Open lots by symbol</p>
          </header>
          @if (!openPositionsKnown()) {
            <div class="empty">Open positions unavailable</div>
          } @else if (exposureRows().length > 0) {
            <ul class="bar-list">
              @for (r of exposureRows(); track r.symbol) {
                <li class="bar-row">
                  <span class="mono bar-name">{{ r.symbol }}</span>
                  <span class="bar-track"
                    ><span class="bar-fill" [style.width.%]="r.pct"></span
                  ></span>
                  <span class="mono bar-value">{{ r.lots | number: '1.2-2' }}</span>
                </li>
              }
            </ul>
            <div class="card-foot">
              {{ exposureTotalLots() | number: '1.2-2' }} lots across
              {{ exposureRows().length }} symbol{{ exposureRows().length === 1 ? '' : 's' }}
            </div>
          } @else {
            <div class="empty">No open positions</div>
          }
        </section>

        <!--
          Ensemble weights as a part-to-whole bar plus a ranked list. The donut
          made close weights hard to compare and its legend truncated names.
        -->
        <section class="card">
          <header class="card-head">
            <h3>Strategy Allocation</h3>
            <p>{{ allocationSubtitle() }}</p>
          </header>
          @if (allocationRows().length > 0) {
            <div class="seg-bar alloc-bar" role="img" [attr.aria-label]="allocationSubtitle()">
              @for (r of allocationRows(); track r.key) {
                <span
                  class="seg"
                  [style.flex-grow]="r.share"
                  [style.background]="r.color"
                  [title]="r.name + ' · ' + (r.share | number: '1.1-1') + '%'"
                ></span>
              }
            </div>
            <ul class="alloc-list">
              @for (r of allocationRows(); track r.key) {
                <li class="alloc-row">
                  <span class="swatch" [style.background]="r.color"></span>
                  @if (r.strategyId !== null) {
                    <a
                      class="alloc-name"
                      [routerLink]="['/strategies', r.strategyId]"
                      [title]="r.name"
                    >
                      {{ r.name }}
                    </a>
                  } @else {
                    <span class="alloc-name">{{ r.name }}</span>
                  }
                  <span class="mono alloc-pct">{{ r.share | number: '1.1-1' }}%</span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty">No active strategy holds an allocation</div>
          }
        </section>
      </div>

      <div class="grid-3-2">
        <section class="card flush">
          <header class="card-head row">
            <h3>Top Open Positions</h3>
            @if (openPositions().length > 0) {
              <a routerLink="/positions" class="link">View all {{ openPositions().length }} →</a>
            }
          </header>
          @if (topOpenPositions().length > 0) {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Lots</th>
                    <th class="num">Entry</th>
                    <th class="num">Current</th>
                    <th class="num">Unrealized</th>
                    <th class="num">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of topOpenPositions(); track p.id) {
                    <tr>
                      <td class="mono strong">{{ p.symbol }}</td>
                      <td>
                        <span
                          class="side"
                          [attr.data-side]="p.direction === 'Long' ? 'buy' : 'sell'"
                        >
                          {{ p.direction === 'Long' ? '▲ Long' : '▼ Short' }}
                        </span>
                      </td>
                      <td class="num mono">{{ p.openLots | number: '1.2-2' }}</td>
                      <td class="num mono">{{ fmtPrice(p.symbol, p.averageEntryPrice) }}</td>
                      <td class="num mono">{{ fmtPrice(p.symbol, p.currentPrice) }}</td>
                      <td class="num mono strong" [class]="toneClass(p.unrealizedPnL)">
                        {{ p.unrealizedPnL >= 0 ? '+' : '' }}{{ p.unrealizedPnL | number: '1.2-2' }}
                      </td>
                      <td class="num muted">{{ p.openedAt | relativeTime }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (!openPositionsKnown()) {
            <div class="empty">Open positions unavailable</div>
          } @else {
            <div class="empty">No open positions</div>
          }
        </section>

        <section class="card flush">
          <header class="card-head row">
            <h3>
              Pending Signals
              @if ((pendingSignalCount() ?? 0) > 0) {
                <span class="count-badge">{{ pendingSignalCount() }}</span>
              }
            </h3>
            @if (pendingSignals().length > 0) {
              <a routerLink="/trade-signals" class="link">View all →</a>
            }
          </header>
          @if (pendingSignals().length > 0) {
            <ul class="rows signal-list">
              @for (sig of pendingSignals(); track sig.id) {
                <li class="signal-item">
                  <span class="side" [attr.data-side]="sig.direction === 'Buy' ? 'buy' : 'sell'">
                    {{ sig.direction === 'Buy' ? '▲' : '▼' }} {{ sig.direction }}
                  </span>
                  <div class="signal-main">
                    <span class="mono strong">{{ sig.symbol }}</span>
                    <span class="muted small">{{ sig.generatedAt | relativeTime }}</span>
                  </div>
                  <div
                    class="confidence"
                    [title]="'Confidence ' + (sig.confidence * 100).toFixed(0) + '%'"
                  >
                    <span class="conf-track">
                      <span class="conf-fill" [style.width.%]="sig.confidence * 100"></span>
                    </span>
                    <span class="mono small">{{ (sig.confidence * 100).toFixed(0) }}%</span>
                  </div>
                  <div class="signal-actions">
                    <button
                      type="button"
                      class="action-btn approve"
                      (click)="signalAction.set({ kind: 'approve', signal: sig })"
                      [attr.aria-label]="'Approve signal ' + sig.symbol + ' ' + sig.direction"
                      title="Approve"
                    >
                      <span aria-hidden="true">✓</span>
                    </button>
                    <button
                      type="button"
                      class="action-btn reject"
                      (click)="signalAction.set({ kind: 'reject', signal: sig })"
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
            <div class="empty">No signals waiting for approval</div>
          }
        </section>
      </div>

      <div class="ops-grid">
        <section class="card flush ops-activity">
          <header class="card-head row">
            <h3>Recent Activity</h3>
            <span class="muted small">Last {{ activityFeed().length }} events</span>
          </header>
          @if (activityFeed().length > 0) {
            <ul class="rows activity">
              @for (e of activityFeed(); track e.id) {
                <li class="activity-item" [attr.data-kind]="e.kind">
                  <span class="kind-dot" aria-hidden="true"></span>
                  <span class="activity-tag">{{ e.kind }}</span>
                  <span class="mono strong">{{ e.symbol }}</span>
                  <span class="activity-text">
                    {{ e.text }}
                    @if (e.detail) {
                      <span class="activity-detail" [class]="detailTone(e)">{{ e.detail }}</span>
                    }
                  </span>
                  <!-- One absolute stamp per row; mixed relative times read as two scales. -->
                  <span class="muted small nowrap" [title]="e.at | date: 'd MMM yyyy, HH:mm:ss'">
                    {{ e.at | date: 'd MMM HH:mm' }}
                  </span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty">No recent activity</div>
          }
        </section>

        <section class="card ops-workers">
          <header class="card-head row">
            <h3>Worker Health</h3>
            <a routerLink="/worker-health" class="link">All workers →</a>
          </header>
          @if (totalWorkerCount() > 0) {
            <div class="worker-headline">
              <span class="tile-figure">{{ healthyWorkerCount() }}</span>
              <span class="muted">of {{ totalWorkerCount() }} healthy</span>
            </div>
            <!-- Every worker sits in exactly one bucket, so the segments sum to the total. -->
            <div class="seg-bar" role="img" [attr.aria-label]="workerSummaryLabel()">
              @for (s of workerSegments(); track s.label) {
                @if (s.count > 0) {
                  <span
                    class="seg"
                    [attr.data-status]="s.label"
                    [style.flex-grow]="s.count"
                    [title]="s.count + ' ' + s.label"
                  ></span>
                }
              }
            </div>
            <ul class="legend">
              @for (s of workerSegments(); track s.label) {
                <li [class.dim]="s.count === 0">
                  <span class="status-dot" [attr.data-status]="s.label"></span>
                  <span class="mono">{{ s.count }}</span> {{ s.label }}
                </li>
              }
            </ul>
            @if (problemWorkers().length > 0) {
              <ul class="worker-list">
                @for (w of problemWorkers(); track w.name) {
                  <li class="worker-row">
                    <span class="status-dot" [attr.data-status]="w.statusLabel"></span>
                    <span class="worker-name mono" [title]="w.name">{{ w.name }}</span>
                    <span class="worker-meta" [attr.data-status]="w.statusLabel">{{
                      w.statusLabel
                    }}</span>
                    @if (w.lastErrorMessage) {
                      <span class="worker-err" [title]="w.lastErrorMessage">{{
                        w.lastErrorMessage
                      }}</span>
                    }
                  </li>
                }
              </ul>
            } @else {
              <div class="all-good">✓ All {{ totalWorkerCount() }} workers nominal</div>
            }
          } @else {
            <div class="empty">No worker data yet</div>
          }
        </section>

        <section class="card flush ops-alerts">
          <header class="card-head row">
            <h3>Recent Alerts</h3>
            <a routerLink="/alerts" class="link">All alerts →</a>
          </header>
          @if (recentAlerts().length > 0) {
            <ul class="rows alerts">
              @for (a of recentAlerts(); track a.id) {
                <li class="alert-item">
                  <span class="sev" [attr.data-severity]="a.severity">{{ a.severity }}</span>
                  <span class="alert-type" [title]="a.isActive ? 'Rule enabled' : 'Rule disabled'">
                    {{ a.alertType }}
                    @if (!a.isActive) {
                      <span class="muted small">· rule disabled</span>
                    }
                  </span>
                  <span class="mono muted small">{{ a.symbol ?? 'fleet' }}</span>
                  <span
                    class="muted small nowrap"
                    [title]="a.lastTriggeredAt | date: 'd MMM yyyy, HH:mm'"
                  >
                    {{ a.lastTriggeredAt | relativeTime }}
                  </span>
                </li>
              }
            </ul>
          } @else if (alertsUnavailable()) {
            <div class="empty">Recently fired alerts could not be loaded</div>
          } @else {
            <div class="empty">No alert has fired yet</div>
          }
        </section>

        <section class="card flush ops-overfit">
          <header class="card-head row">
            <h3>Overfit Watchlist</h3>
            <a routerLink="/ml-models" class="link">All models →</a>
          </header>
          @if (overfitWatchlist().length > 0) {
            <ul class="rows overfit-list">
              @for (m of overfitWatchlist(); track m.mlModelId) {
                <li class="overfit-item">
                  <a
                    [routerLink]="['/ml-models', m.mlModelId]"
                    class="overfit-pair"
                    [title]="m.reason"
                  >
                    <span class="mono strong">{{ m.symbol }} {{ m.timeframe }}</span>
                    <span class="muted small"
                      >{{ m.learnerArchitecture }} · {{ m.resolvedSignals }} signals</span
                    >
                  </a>
                  <div class="overfit-stats">
                    <span class="kv">
                      <span class="muted small">CV</span>
                      <span class="mono">{{
                        m.cvSharpe !== null ? m.cvSharpe.toFixed(2) : '—'
                      }}</span>
                    </span>
                    <span class="kv">
                      <span class="muted small">Live 7d</span>
                      <span class="mono" [class.loss]="(m.liveSharpe7d ?? 0) <= 0">
                        {{ m.liveSharpe7d !== null ? m.liveSharpe7d.toFixed(2) : '—' }}
                      </span>
                    </span>
                    @if (m.sharpeRatio !== null) {
                      <span class="pill" data-tone="warn"
                        >{{ m.sharpeRatio.toFixed(1) }}× drift</span
                      >
                    } @else {
                      <span class="pill" data-tone="bad">edge collapse</span>
                    }
                  </div>
                </li>
              }
            </ul>
          } @else {
            <div class="empty">No models flagged — CV and live Sharpe in line</div>
          }
        </section>
      </div>

      <!-- System footer: engine mode, account margin, models, signal cadence. -->
      <footer class="status-row">
        <div class="status-item">
          <span
            class="status-dot"
            [attr.data-status]="healthStatus() ? 'Healthy' : 'Failed'"
          ></span>
          <span class="stat-label">Engine</span>
          <span class="strong">{{ healthStatus() ? 'Running' : 'Stopped' }}</span>
          @if (engineStatus(); as s) {
            <!-- paperMode is the raw EngineConfig string ("true" / "false"), not a mode name. -->
            <span class="muted">
              {{ isPaperMode(s.paperMode) ? 'paper trading' : 'live trading' }} · checked
              {{ s.checkedAt | relativeTime }}
            </span>
          }
        </div>
        <div class="status-item">
          <span class="stat-label">Account</span>
          @if (account(); as a) {
            <span class="strong">{{ a.accountName ?? a.accountId }}</span>
            <span class="muted"
              >{{ a.currency ?? '' }} · margin {{ marginUsedPct() | number: '1.1-1' }}%</span
            >
          } @else {
            <span class="muted">—</span>
          }
        </div>
        <div class="status-item">
          <span class="stat-label">ML models</span>
          @if (activeMlModelCount() !== null) {
            <span class="strong">{{ activeMlModelCount() | number }} active</span>
            <span class="muted">
              @if (mostRecentMlModel(); as m) {
                latest {{ m.symbol }} {{ m.timeframe }} · {{ m.trainedAt | relativeTime }}
              } @else {
                no active models
              }
            </span>
          } @else {
            <span class="muted">—</span>
          }
        </div>
        <div class="status-item">
          <span class="stat-label">Last signal</span>
          @if (lastSignalAt()) {
            <span class="strong">{{ lastSignalAt() | relativeTime }}</span>
            <span class="muted">{{ todaysSignalCount() | number }} today</span>
          } @else {
            <span class="muted">No signals yet</span>
          }
        </div>
      </footer>

      <!--
        Approving a signal sends it to the accounts for execution — one stray
        click on a 26px tick used to do that with no second step.
      -->
      <app-confirm-dialog
        [open]="signalAction() !== null"
        [title]="signalAction()?.kind === 'approve' ? 'Approve signal' : 'Reject signal'"
        [message]="signalActionMessage()"
        [confirmLabel]="signalAction()?.kind === 'approve' ? 'Approve' : 'Reject'"
        [confirmVariant]="signalAction()?.kind === 'approve' ? 'primary' : 'destructive'"
        [loading]="signalActionBusy()"
        (confirm)="confirmSignalAction()"
        (cancelled)="signalAction.set(null)"
      />
    </div>
  `,
  styles: [
    `
      .dashboard {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }

      /* ── Header pills ─────────────────────────────────────────── */
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
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .head-pill[data-state='up'] {
        background: color-mix(in srgb, var(--profit) 13%, transparent);
        color: var(--tone-green);
      }
      .head-pill[data-state='up'] .dot {
        background: var(--profit);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--profit) 25%, transparent);
      }
      .head-pill[data-state='down'] {
        background: color-mix(in srgb, var(--loss) 13%, transparent);
        color: var(--tone-red);
      }
      .head-pill[data-state='down'] .dot {
        background: var(--loss);
      }
      .head-pill[data-state='muted'] .dot {
        display: none;
      }

      /* ── Shared atoms ─────────────────────────────────────────── */
      .eyebrow,
      .stat-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        white-space: nowrap;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .strong {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 10.5px;
      }
      .nowrap {
        white-space: nowrap;
      }
      .profit {
        color: var(--tone-green);
      }
      .loss {
        color: var(--tone-red);
      }
      .link {
        color: var(--accent);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        white-space: nowrap;
      }
      .link:hover {
        text-decoration: underline;
      }

      /* ── Hero ─────────────────────────────────────────────────── */
      .hero {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
        gap: var(--space-5);
        padding: var(--space-6);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background:
          radial-gradient(
            120% 140% at 0% 0%,
            color-mix(in srgb, var(--accent) 9%, transparent),
            transparent 55%
          ),
          var(--bg-secondary);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
      .hero-main {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
      }
      .hero-figure {
        font-size: clamp(36px, 4vw, 52px);
        font-weight: var(--font-semibold);
        letter-spacing: -0.03em;
        line-height: 1.05;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .hero-sub {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .sep {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: var(--text-tertiary);
        opacity: 0.6;
      }
      .hero-pnl {
        margin: auto 0 0;
        padding-top: var(--space-4);
        display: grid;
        grid-template-columns: repeat(3, minmax(0, auto));
        justify-content: start;
        gap: var(--space-8);
      }
      .hero-pnl div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .hero-pnl dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .hero-pnl dd {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        letter-spacing: -0.01em;
        white-space: nowrap;
      }
      .hero-side {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--space-3);
      }
      .hero-tile {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
        padding: var(--space-4);
        border-radius: var(--radius-md);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: inherit;
        text-decoration: none;
      }
      .tile-link {
        transition:
          border-color var(--dur-base) var(--ease-out-soft),
          transform var(--dur-base) var(--ease-out-soft);
      }
      .tile-link:hover {
        border-color: color-mix(in srgb, var(--accent) 45%, transparent);
        transform: translateY(-1px);
      }
      .tile-link:hover .tile-arrow {
        color: var(--accent);
        transform: translateX(2px);
      }
      .tile-arrow {
        color: var(--text-tertiary);
        transition: transform var(--dur-base) var(--ease-out-soft);
      }
      .tile-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .tile-figure {
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        letter-spacing: -0.02em;
        line-height: 1.1;
        color: var(--text-primary);
      }
      .tile-figure.loss {
        color: var(--tone-red);
      }
      .tile-sub {
        margin-top: auto;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .mode-chip,
      .pill,
      .count-badge,
      .side,
      .sev {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        white-space: nowrap;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      [data-tone='good'].mode-chip {
        background: color-mix(in srgb, var(--profit) 14%, transparent);
        color: var(--tone-green);
      }
      [data-tone='warn'].mode-chip,
      [data-tone='warn'].pill {
        background: color-mix(in srgb, var(--warning) 15%, transparent);
        color: var(--tone-amber);
      }
      [data-tone='bad'].mode-chip,
      [data-tone='bad'].pill {
        background: color-mix(in srgb, var(--loss) 14%, transparent);
        color: var(--tone-red);
      }

      /* Drawdown meter: fill carries severity, track is a light step of the same hue. */
      .meter {
        --meter: var(--profit);
        position: relative;
        height: 8px;
        margin-top: auto;
        border-radius: var(--radius-full);
        background: color-mix(in srgb, var(--meter) 16%, transparent);
      }
      .meter[data-tone='warn'] {
        --meter: var(--warning);
      }
      .meter[data-tone='bad'] {
        --meter: var(--loss);
      }
      .meter[data-tone='none'] {
        --meter: var(--text-tertiary);
      }
      .meter-fill {
        display: block;
        height: 100%;
        min-width: 4px;
        border-radius: inherit;
        background: var(--meter);
        transition: width var(--dur-slow) var(--ease-out-soft);
      }
      .meter-tick {
        position: absolute;
        top: -3px;
        bottom: -3px;
        width: 2px;
        margin-left: -1px;
        border-radius: 1px;
        background: var(--text-tertiary);
        opacity: 0.55;
      }
      .meter-scale {
        position: relative;
        height: 14px;
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .meter-scale span {
        position: absolute;
        top: 0;
        white-space: nowrap;
        transform: translateX(-50%);
      }
      .meter-scale span:first-child {
        transform: none;
      }
      .meter-scale span:last-child {
        transform: translateX(-70%);
      }

      /* ── Secondary stat row ───────────────────────────────────── */
      .stat-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr));
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
      .stat {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        padding: var(--space-3) var(--space-4);
        /* Left and top hairlines; the card clips the outer ones, so only inner dividers show
           (including between wrapped rows). */
        box-shadow:
          -1px 0 0 var(--border),
          0 -1px 0 var(--border);
      }
      .stat-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stat-value[data-tone='good'] {
        color: var(--tone-green);
      }
      .stat-value[data-tone='bad'] {
        color: var(--tone-red);
      }
      .stat-value[data-tone='warn'] {
        color: var(--tone-amber);
      }

      /* ── Grids ────────────────────────────────────────────────── */
      .grid-2-1,
      .grid-3,
      .grid-3-2,
      .ops-grid {
        display: grid;
        gap: var(--space-4);
        align-items: stretch;
      }
      .grid-2-1 {
        grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
      }
      .grid-3 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        align-items: start;
      }
      .grid-3 > .card {
        align-self: stretch;
      }
      /* Lists keep their natural height: stretching a short list to a tall neighbour left a
         blank band under its last row. */
      .grid-3-2 {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        align-items: start;
      }
      .ops-grid {
        grid-template-columns: repeat(6, minmax(0, 1fr));
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
        .hero,
        .grid-2-1,
        .grid-3,
        .grid-3-2,
        .ops-grid {
          grid-template-columns: minmax(0, 1fr);
        }
        .ops-grid > * {
          grid-column: auto;
        }
      }
      @media (max-width: 640px) {
        .hero {
          padding: var(--space-4);
        }
        .hero-side {
          grid-template-columns: minmax(0, 1fr);
        }
        .hero-pnl {
          gap: var(--space-4);
        }
      }

      /* ── Cards ────────────────────────────────────────────────── */
      .card {
        display: flex;
        flex-direction: column;
        min-width: 0;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .card.flush {
        padding: 0;
        overflow: hidden;
      }
      .card-head {
        margin-bottom: var(--space-4);
      }
      .card-head.row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .card.flush > .card-head {
        margin: 0;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .card-head p {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .count-badge {
        background: color-mix(in srgb, var(--warning) 16%, transparent);
        color: var(--tone-amber);
      }
      .card-foot {
        margin-top: auto;
        padding-top: var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        border-top: 1px solid var(--border);
      }
      .empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 120px;
        margin: var(--space-4);
        padding: var(--space-5);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
      }
      .card:not(.flush) > .empty {
        margin: 0;
      }

      /* Ranked bar list (exposure). */
      .bar-list,
      .alloc-list,
      .rows,
      .legend,
      .worker-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .bar-row {
        display: grid;
        grid-template-columns: 72px minmax(0, 1fr) 48px;
        align-items: center;
        gap: var(--space-3);
        padding: 6px 0;
        font-size: var(--text-xs);
      }
      .bar-name {
        font-weight: var(--font-semibold);
      }
      .bar-track {
        height: 8px;
        border-radius: var(--radius-full);
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        overflow: hidden;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: var(--accent);
        border-radius: var(--radius-full);
      }
      .bar-value {
        text-align: right;
      }

      /* Part-to-whole bar: 2px surface gaps between segments. */
      .seg-bar {
        display: flex;
        gap: 2px;
        height: 10px;
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .seg {
        min-width: 4px;
        flex-basis: 0;
      }
      .alloc-bar {
        height: 14px;
        margin-bottom: var(--space-4);
      }
      .alloc-row {
        display: grid;
        grid-template-columns: 10px minmax(0, 1fr) auto;
        align-items: center;
        gap: var(--space-2);
        padding: 6px 0;
        font-size: var(--text-xs);
        border-bottom: 1px solid var(--border);
      }
      .alloc-row:last-child {
        border-bottom: none;
      }
      .swatch {
        width: 10px;
        height: 10px;
        border-radius: 3px;
      }
      .alloc-name {
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      a.alloc-name:hover {
        color: var(--accent);
      }
      .alloc-pct {
        color: var(--text-secondary);
      }

      /* ── Table ────────────────────────────────────────────────── */
      .table-wrap {
        overflow-x: auto;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: 10px var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        white-space: nowrap;
      }
      .table th:first-child,
      .table td:first-child {
        padding-left: var(--space-5);
      }
      .table th:last-child,
      .table td:last-child {
        padding-right: var(--space-5);
      }
      .table tbody tr:last-child td {
        border-bottom: none;
      }
      .table tbody tr {
        transition: background var(--dur-fast);
      }
      .table tbody tr:hover {
        background: color-mix(in srgb, var(--accent) 5%, transparent);
      }
      .table th {
        color: var(--text-tertiary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .table .num {
        text-align: right;
      }
      .side[data-side='buy'] {
        background: color-mix(in srgb, var(--profit) 13%, transparent);
        color: var(--tone-green);
      }
      .side[data-side='sell'] {
        background: color-mix(in srgb, var(--loss) 13%, transparent);
        color: var(--tone-red);
      }

      /* ── Row lists (signals, activity, alerts, overfit) ───────── */
      .rows {
        overflow-y: auto;
      }
      .rows > li {
        padding: 10px var(--space-5);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        transition: background var(--dur-fast);
      }
      .rows > li:last-child {
        border-bottom: none;
      }
      .rows > li:hover {
        background: color-mix(in srgb, var(--accent) 5%, transparent);
      }
      .signal-list {
        max-height: 340px;
      }
      .signal-item {
        display: grid;
        grid-template-columns: 72px minmax(0, 1fr) 96px auto;
        align-items: center;
        gap: var(--space-3);
      }
      .signal-main {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .confidence {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .conf-track {
        flex: 1;
        height: 5px;
        border-radius: var(--radius-full);
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        overflow: hidden;
      }
      .conf-fill {
        display: block;
        height: 100%;
        background: var(--accent);
        border-radius: inherit;
      }
      .signal-actions {
        display: flex;
        gap: var(--space-1);
      }
      .action-btn {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-full);
        border: 1px solid transparent;
        cursor: pointer;
        font-weight: var(--font-semibold);
        font-size: 13px;
        transition:
          background var(--dur-fast),
          transform var(--dur-fast);
      }
      .action-btn:active {
        transform: scale(0.94);
      }
      .action-btn.approve {
        background: color-mix(in srgb, var(--profit) 14%, transparent);
        color: var(--tone-green);
      }
      .action-btn.approve:hover {
        background: color-mix(in srgb, var(--profit) 26%, transparent);
      }
      .action-btn.reject {
        background: color-mix(in srgb, var(--loss) 12%, transparent);
        color: var(--tone-red);
      }
      .action-btn.reject:hover {
        background: color-mix(in srgb, var(--loss) 24%, transparent);
      }

      .activity {
        max-height: 420px;
      }
      .activity-item {
        --kind: var(--text-tertiary);
        display: grid;
        grid-template-columns: 8px 56px 64px minmax(0, 1fr) auto;
        align-items: center;
        gap: var(--space-3);
      }
      .activity-item[data-kind='fill'],
      .activity-item[data-kind='open'] {
        --kind: var(--accent);
      }
      .activity-item[data-kind='close'] {
        --kind: var(--profit);
      }
      .activity-item[data-kind='signal'] {
        --kind: var(--warning);
      }
      .activity-item[data-kind='reject'] {
        --kind: var(--loss);
      }
      .kind-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--kind);
      }
      .activity-tag {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .activity-text {
        min-width: 0;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .activity-detail {
        margin-left: var(--space-2);
        font-size: 10.5px;
      }

      /* ── Worker health ────────────────────────────────────────── */
      .worker-headline {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        margin-bottom: var(--space-3);
        font-size: var(--text-xs);
      }
      .seg[data-status='Healthy'],
      .status-dot[data-status='Healthy'] {
        background: var(--profit);
      }
      .seg[data-status='Idle'],
      .status-dot[data-status='Idle'] {
        background: var(--text-tertiary);
      }
      .seg[data-status='Stale'],
      .status-dot[data-status='Stale'] {
        background: var(--tone-purple);
      }
      .seg[data-status='Degraded'],
      .status-dot[data-status='Degraded'] {
        background: var(--warning);
      }
      .seg[data-status='Failed'],
      .status-dot[data-status='Failed'] {
        background: var(--loss);
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
        margin-top: var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .legend li {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .legend li.dim {
        opacity: 0.45;
      }
      .status-dot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .worker-list {
        margin-top: var(--space-4);
        border-top: 1px solid var(--border);
        max-height: 220px;
        overflow-y: auto;
      }
      /* minmax(0, 1fr): a long worker name must ellipsise, not push the label out. */
      .worker-row {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr) auto;
        align-items: center;
        gap: var(--space-2);
        padding: 8px 0;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .worker-row:last-child {
        border-bottom: none;
      }
      .worker-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .worker-meta {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .worker-meta[data-status='Failed'] {
        color: var(--tone-red);
      }
      .worker-meta[data-status='Degraded'] {
        color: var(--tone-amber);
      }
      .worker-meta[data-status='Stale'] {
        color: var(--tone-purple);
      }
      .worker-err {
        grid-column: 2 / -1;
        color: var(--text-tertiary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .all-good {
        margin-top: var(--space-4);
        padding: var(--space-3);
        text-align: center;
        border-radius: var(--radius-sm);
        background: color-mix(in srgb, var(--profit) 10%, transparent);
        color: var(--tone-green);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }

      /* ── Alerts ───────────────────────────────────────────────── */
      .alerts {
        max-height: 340px;
      }
      .alert-item {
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr) auto auto;
        align-items: center;
        gap: var(--space-3);
      }
      /* Colour carries severity, not whether the rule is switched on. */
      .sev {
        justify-self: start;
      }
      .sev[data-severity='High'],
      .sev[data-severity='Critical'] {
        background: color-mix(in srgb, var(--loss) 14%, transparent);
        color: var(--tone-red);
      }
      .sev[data-severity='Medium'] {
        background: color-mix(in srgb, var(--warning) 15%, transparent);
        color: var(--tone-amber);
      }
      .alert-type {
        min-width: 0;
        color: var(--text-primary);
        font-weight: var(--font-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Overfit watchlist ────────────────────────────────────── */
      .overfit-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .overfit-pair {
        display: flex;
        flex-direction: column;
        gap: 2px;
        color: var(--text-primary);
        text-decoration: none;
      }
      .overfit-pair:hover .strong {
        color: var(--accent);
      }
      .overfit-stats {
        display: flex;
        align-items: center;
        gap: var(--space-4);
      }
      .kv {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 1px;
      }

      /* ── Status footer ────────────────────────────────────────── */
      .status-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3) var(--space-6);
        padding: var(--space-3) var(--space-5);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        font-size: var(--text-xs);
      }
      .status-item {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
        white-space: nowrap;
      }
      /* Phone overrides — last, so they beat the base rules above. */
      @media (max-width: 640px) {
        /* Phone: the event text needs the room the kind label took; the dot still carries kind. */
        .activity-item {
          grid-template-columns: 8px 60px minmax(0, 1fr) auto;
        }
        .activity-tag {
          display: none;
        }
        .signal-item {
          grid-template-columns: auto minmax(0, 1fr) 64px auto;
          gap: var(--space-2);
        }
        .conf-track {
          display: none;
        }
        .rows > li {
          padding-inline: var(--space-4);
        }
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
  private readonly auth = inject(AuthService);
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
  /**
   * True once the open-positions query has answered for the current scope.
   * An empty book is a measurement (0 positions, $0.00 unrealized); a failed
   * or pending fetch is not — the tiles used to print "—" for both, so a flat
   * account looked like a broken one.
   */
  readonly openPositionsKnown = signal(false);
  // Derived from openPositions() — re-derives when scope changes.
  readonly unrealizedPnl = computed<number | null>(() =>
    this.openPositionsKnown()
      ? this.openPositions().reduce((s, p) => s + p.unrealizedPnL, 0)
      : null,
  );
  readonly openPositionCount = computed<number | null>(() =>
    this.openPositionsKnown() ? this.openPositions().length : null,
  );
  /**
   * Strategies with status Active, fetched with a server-side status filter
   * (null until the query answers, or when it failed). The rebalancer only
   * weights Active strategies, but it never retires the allocation rows of a
   * strategy that later paused or was deleted — so counting "status Active OR
   * has ensemble weight" reported 5 active strategies on an engine with one.
   */
  readonly activeStrategies = signal<StrategyDto[] | null>(null);
  readonly activeStrategyTotal = signal<number | null>(null);
  readonly activeStrategyCount = computed<number | null>(() => this.activeStrategyTotal());
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
  /** The alert query failed, or could not reach a fired alert (see loadRecentAlerts). */
  readonly alertsUnavailable = signal(false);
  // Owned by AccountScopeService — refresh() writes the fetched list
  // there, not into a page-local copy.  This used to be a separate
  // `signal([])` that nothing ever set, which pinned the EA Connections
  // tile at 0 no matter how many EAs were attached.
  readonly eaInstances = this.accountScope.eaInstances;
  readonly workers = signal<WorkerHealthDto[]>([]);
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
  /** True once the closed-positions query has answered for the current scope. */
  readonly closedPositionsKnown = signal(false);

  /**
   * Start of the 30-day window every realized figure on the page reads — the
   * headline tile, win rate, profit factor and all three P&L charts. Re-read
   * on each refresh (via closedPositions) so a page left open keeps sliding.
   */
  private readonly windowStart = computed(() => {
    this.closedPositions();
    return Date.now() - WINDOW_MS;
  });

  /** Closed trades inside the 30-day window, oldest first. */
  readonly closedInWindow = computed<PositionDto[]>(() => {
    const cutoff = this.windowStart();
    return this.closedPositions()
      .filter((p) => p.closedAt && new Date(p.closedAt).getTime() >= cutoff)
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
  });

  /**
   * True when the fetched page is full AND its oldest trade is still inside
   * the window: trades older than the page exist that the window should have
   * held, so the 30-day figures are a lower bound and the label says so.
   */
  readonly windowTruncated = computed(() => {
    const closed = this.closedPositions();
    if (this.rawClosedPositions().length < CLOSED_PAGE_SIZE) return false;
    const oldest = closed.reduce<string | null>(
      (min, p) => (p.closedAt && (min === null || p.closedAt < min) ? p.closedAt : min),
      null,
    );
    return oldest !== null && new Date(oldest).getTime() >= this.windowStart();
  });

  /**
   * Trades the engine could not recover a realized P&L for (`pnlUnreconciledAt`
   * set): their 0.00 means UNKNOWN, so they are left out of win rate and profit
   * factor rather than counted as break-even non-wins.
   */
  private readonly reconciledInWindow = computed(() =>
    this.closedInWindow().filter((p) => !p.pnlUnreconciledAt),
  );
  readonly unreconciledInWindow = computed(
    () => this.closedInWindow().length - this.reconciledInWindow().length,
  );

  readonly todaysPnl = computed<number | null>(() => {
    if (!this.closedPositionsKnown()) return null;
    const start = startOfToday();
    return this.closedInWindow()
      .filter((p) => new Date(p.closedAt!).getTime() >= start)
      .reduce((s, p) => s + p.realizedPnL, 0);
  });

  readonly realizedPnl30d = computed<number | null>(() =>
    this.closedPositionsKnown()
      ? this.closedInWindow().reduce((s, p) => s + p.realizedPnL, 0)
      : null,
  );

  readonly realizedLabel = computed(() =>
    this.windowTruncated() ? 'Realized P&L (30d, partial)' : 'Realized P&L (30d)',
  );

  readonly winRatePct = computed(() => {
    const closed = this.reconciledInWindow();
    if (closed.length === 0) return 0;
    const wins = closed.filter((p) => p.realizedPnL > 0).length;
    return (wins / closed.length) * 100;
  });

  /** null when there is nothing to divide; Infinity when there were wins and no losses. */
  readonly profitFactor = computed<number | null>(() => {
    const closed = this.reconciledInWindow();
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

  /** Drawdown meter scale: 0-25 %, so both engine thresholds (Reduced 10 %, Halted 20 %) show. */
  readonly DD_SCALE = 25;

  /** Fill width and severity of the drawdown meter. */
  readonly drawdownMeter = computed<{ pct: number; tone: 'good' | 'warn' | 'bad' | 'none' }>(() => {
    const dd = this.drawdownPct();
    if (dd == null) return { pct: 0, tone: 'none' };
    const pct = Math.min(100, Math.max(0, (dd / this.DD_SCALE) * 100));
    return { pct, tone: dd >= 20 ? 'bad' : dd >= 10 ? 'warn' : 'good' };
  });

  /** USD with thousands separators; `signed` prefixes a plus on gains. "—" for unknown. */
  fmtMoney(v: number | null | undefined, signed = false): string {
    if (v == null || !Number.isFinite(v)) return '—';
    const s = usd(v);
    return signed && v > 0 ? `+${s}` : s;
  }

  /** profit / loss class for a signed figure; none for zero or unknown. */
  toneClass(v: number | null | undefined): string {
    return v == null || v === 0 ? '' : v > 0 ? 'profit' : 'loss';
  }

  /** A close's signed P&L detail gets its sign colour; other details stay muted. */
  detailTone(e: ActivityEntry): string {
    if (e.kind !== 'close' || !e.detail) return 'muted';
    return e.detail.startsWith('+') ? 'profit' : e.detail.startsWith('-') ? 'loss' : 'muted';
  }

  /**
   * The stat row under the hero (unrealized and today's P&L live in the hero). Formatted here so the strip shows one number
   * style (USD, thousands separators, fixed decimals) and colour only where
   * the sign or a threshold means something — a 63 % win rate is not "good"
   * next to a losing book, and a 0.7 profit factor is not.
   */
  readonly secondaryStats = computed<
    { label: string; value: string; tone: 'good' | 'bad' | 'warn' | ''; hint?: string }[]
  >(() => {
    const pf = this.profitFactor();
    const pfTone: 'good' | 'bad' | 'warn' | '' =
      pf == null ? '' : pf >= 1.5 ? 'good' : pf >= 1 ? 'warn' : 'bad';
    const closed = this.reconciledInWindow().length;
    const unknown = this.unreconciledInWindow();
    const sample =
      `${closed.toLocaleString('en-US')} closed trade${closed === 1 ? '' : 's'}, last 30 days` +
      (unknown > 0 ? ` · ${unknown} with unknown P&L excluded` : '') +
      (this.windowTruncated() ? ' · partial: fetch limit reached' : '');
    const failed = this.failedWorkerCount();
    const degraded = this.degradedWorkerCount();
    const stale = this.staleWorkerCount();
    const idle = this.idleWorkerCount();
    return [
      {
        label: 'Win rate (30d)',
        value: closed === 0 ? '—' : `${this.winRatePct().toFixed(1)}%`,
        tone: '',
        hint: closed === 0 ? undefined : sample,
      },
      {
        label: 'Profit factor (30d)',
        value: pf == null ? '—' : pf === Infinity ? '∞' : pf.toFixed(2),
        tone: pfTone,
        hint: `Gross wins ÷ gross losses · ${sample}`,
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
        tone: failed > 0 ? 'bad' : degraded > 0 || stale > 0 ? 'warn' : '',
        hint:
          this.totalWorkerCount() === 0
            ? undefined
            : `${this.healthyWorkerCount()} healthy · ${degraded} degraded · ${failed} failed · ${idle} idle · ${stale} stale`,
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

  /**
   * Every worker lands in exactly ONE bucket, so the five tiles always sum to
   * the total and "Workers OK" is the Healthy tile over that total. `isStale`
   * is a flag that overlaps the derived status, and counting it as a sixth
   * column alongside the statuses read "69 healthy + 3 idle + 2 stale" against
   * "69 / 72". Precedence: Failed > Degraded > Stale > Idle > Healthy.
   *
   * A completed one-shot worker (`isCompleted`: a backfill or warm-up that ran
   * once and exited) has no next cycle to be late for, so it is never stale —
   * its last success only gets older. Those two were the whole "2 stale".
   */
  private readonly workerBuckets = computed(() => {
    const counts = { Healthy: 0, Degraded: 0, Failed: 0, Idle: 0, Stale: 0 };
    for (const w of this.workers()) counts[workerBucket(w)]++;
    return counts;
  });
  readonly totalWorkerCount = computed(() => this.workers().length);
  readonly healthyWorkerCount = computed(() => this.workerBuckets().Healthy);
  readonly degradedWorkerCount = computed(() => this.workerBuckets().Degraded);
  readonly failedWorkerCount = computed(() => this.workerBuckets().Failed);
  readonly idleWorkerCount = computed(() => this.workerBuckets().Idle);
  readonly staleWorkerCount = computed(() => this.workerBuckets().Stale);

  // Surface only the worth-investigating workers so the panel stays compact; the
  // row label is the worker's bucket, the same word the tile above counted it under.
  readonly problemWorkers = computed(() =>
    this.workers()
      .map((w) => ({ ...w, statusLabel: workerBucket(w) }))
      .filter(
        (w) =>
          w.statusLabel === 'Failed' || w.statusLabel === 'Degraded' || w.statusLabel === 'Stale',
      )
      .slice(0, 5),
  );

  /** Worker buckets in severity order for the segmented bar and its legend. */
  readonly workerSegments = computed(() => {
    const b = this.workerBuckets();
    return (['Healthy', 'Idle', 'Stale', 'Degraded', 'Failed'] as const).map((label) => ({
      label,
      count: b[label],
    }));
  });

  readonly workerSummaryLabel = computed(() =>
    this.workerSegments()
      .map((s) => `${s.count} ${s.label.toLowerCase()}`)
      .join(', '),
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

  /**
   * Counted server-side (`isActive` filter, the pager's total) — it used to
   * count the active models inside the 25 most recently TRAINED models of 900+,
   * which read "1 active" on an engine serving ten.
   */
  readonly activeMlModelCount = signal<number | null>(null);
  readonly mostRecentMlModel = signal<MLModelDto | null>(null);

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
      // openLots is decremented to 0 by a full close; tradedLots is the size that traded.
      const lots = p.tradedLots ?? p.openLots;
      events.push({
        id: `pos-close-${p.id}`,
        kind: 'close',
        symbol: p.symbol ?? '—',
        text: `Closed ${p.direction} ${lots.toFixed(2)} lots`,
        // An unreconciled close's 0.00 is UNKNOWN, not break-even.
        detail: p.pnlUnreconciledAt
          ? 'P&L unknown'
          : `${p.realizedPnL >= 0 ? '+' : ''}${p.realizedPnL.toFixed(2)}`,
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
  /**
   * Both P&L-over-time charts share a TIME axis pinned to the 30-day window.
   * They were category axes — one slot per trade (or per trading day) — so 16
   * trades on 22 Sep took half the width while the quiet 25 Sep → 6 Oct
   * fortnight took one slot, and the two charts could not be read against
   * each other.
   */
  private timeAxis(): EChartsOption['xAxis'] {
    return {
      type: 'time',
      min: this.windowStart(),
      max: Date.now(),
      axisLabel: { fontSize: 10, hideOverlap: true, formatter: '{dd} {MMM}' },
      splitLine: { show: false },
    };
  }

  readonly equityCurveChart = computed<EChartsOption>(() => {
    if (!this.closedPositionsKnown()) return emptyChart('Closed positions unavailable');
    const inWindow = this.closedInWindow();
    if (inWindow.length === 0) return emptyChart('No trades in the last 30 days');

    // Realized equity only moves when a trade closes: a step line from 0 at
    // the window start. The old smoothed line drew curves between closes —
    // including dips and recoveries no account ever had.
    let cum = 0;
    const points: [number, number][] = [[this.windowStart(), 0]];
    for (const p of inWindow) {
      cum += p.realizedPnL;
      points.push([new Date(p.closedAt!).getTime(), +cum.toFixed(2)]);
    }
    points.push([Date.now(), +cum.toFixed(2)]);
    const lineColor = cum >= 0 ? '#34C759' : '#FF3B30';
    return {
      grid: { top: 16, right: 24, bottom: 28, left: 56 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => usd(tooltipNumber(v)),
      },
      xAxis: this.timeAxis(),
      yAxis: valueAxis(),
      series: [
        {
          type: 'line',
          step: 'end',
          symbol: 'none',
          name: 'Cumulative realized',
          data: points,
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
    if (!this.closedPositionsKnown()) return emptyChart('Closed positions unavailable');
    const inWindow = this.closedInWindow();
    if (inWindow.length === 0) return emptyChart('No trades in the last 30 days');
    // Local calendar days — the same days "Today P&L" counts — keyed by the
    // day's local midnight. (It bucketed by UTC date while Today used local.)
    const buckets = new Map<number, number>();
    for (const p of inWindow) {
      const day = new Date(p.closedAt!);
      day.setHours(0, 0, 0, 0);
      buckets.set(day.getTime(), (buckets.get(day.getTime()) ?? 0) + p.realizedPnL);
    }
    const days = Array.from(buckets.keys()).sort((a, b) => a - b);
    return {
      grid: { top: 16, right: 12, bottom: 28, left: 50 },
      xAxis: this.timeAxis(),
      yAxis: valueAxis(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v) => usd(tooltipNumber(v)),
      },
      series: [
        {
          type: 'bar',
          name: 'Realized',
          barMaxWidth: 10,
          // Plotted at midday so each bar sits inside its own day on the axis.
          data: days.map((d) => {
            const v = +(buckets.get(d) ?? 0).toFixed(2);
            return {
              value: [d + 12 * 3600_000, v],
              itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [3, 3, 0, 0] },
            };
          }),
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
    const buckets = new Map<string, number>();
    for (const p of this.closedInWindow()) {
      if (!p.symbol) continue;
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
    if (!this.closedPositionsKnown()) return emptyChart('Closed positions unavailable');
    const { rows } = this.pnlBySymbolRows();
    if (rows.length === 0) return emptyChart('No trades in the last 30 days');
    return {
      grid: { top: 8, right: 24, bottom: 28, left: 8, containLabel: true },
      xAxis: valueAxis(),
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

  /**
   * The CURRENT ensemble: weighted allocations of strategies that are Active
   * now. The raw list used to mix today's 100% with stale 100% / 50% / 50% /
   * 33% rows from deleted strategies (no name, so "#405"), and the legend
   * summed to 333%. Since 2026-10-19 the engine skips deleted strategies'
   * rows and a rebalance zeroes the rest of the non-Active set — but a
   * strategy paused since the last rebalance still carries its weight, so the
   * Active filter stays. Shares are normalised over what is drawn so the
   * legend and the ring agree. If the strategy query failed, a resolved name
   * (the engine resolves names for non-deleted strategies only) is the
   * fallback test.
   */
  readonly currentAllocations = computed(() => {
    const active = this.activeStrategies();
    const names = new Map((active ?? []).map((s) => [s.id, s.name]));
    const rows = this.allocations().filter(
      (a) => a.weight > 0 && (active ? names.has(a.strategyId) : a.strategyName != null),
    );
    const total = rows.reduce((s, a) => s + a.weight, 0);
    return rows
      .map((a) => ({
        strategyId: a.strategyId,
        name: a.strategyName ?? names.get(a.strategyId) ?? `Strategy #${a.strategyId}`,
        share: total > 0 ? (a.weight / total) * 100 : 0,
      }))
      .sort((a, b) => b.share - a.share);
  });

  readonly allocationSubtitle = computed(() => {
    const n = this.currentAllocations().length;
    return n === 0
      ? 'Ensemble weights of active strategies'
      : `Ensemble weights · ${n} active strateg${n === 1 ? 'y' : 'ies'}`;
  });

  /**
   * Allocation rows for the part-to-whole bar and its list. A strategy's colour follows its id
   * (ascending), not its rank, so a rebalance that reorders weights does not repaint it; past
   * six strategies the smallest fold into one grey "Other" row.
   */
  readonly allocationRows = computed(() => {
    const rows = this.currentAllocations();
    const shown = rows.slice(
      0,
      rows.length > ALLOC_PALETTE.length ? ALLOC_PALETTE.length - 1 : rows.length,
    );
    const rest = rows.slice(shown.length);
    const byId = [...shown].map((r) => r.strategyId).sort((a, b) => a - b);
    const out: {
      key: string;
      strategyId: number | null;
      name: string;
      share: number;
      color: string;
    }[] = shown.map((r) => ({
      key: `s${r.strategyId}`,
      strategyId: r.strategyId,
      name: r.name,
      share: r.share,
      color: ALLOC_PALETTE[byId.indexOf(r.strategyId)],
    }));
    if (rest.length > 0) {
      out.push({
        key: 'other',
        strategyId: null,
        name: `Other (${rest.length})`,
        share: rest.reduce((s, r) => s + r.share, 0),
        color: ALLOC_OTHER,
      });
    }
    return out;
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
    // A query issued before the account list resolved is fleet-wide and then
    // filtered to an empty scope on arrival — that is "not known yet", not
    // "zero positions".
    const scoped = this.accountScope.accountIds().length > 0;
    this.loadRecentAlerts();
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
          map((r) => (r?.status === false ? null : (r.data?.data ?? []))),
          catchError(() => of(null)),
        ),
      // 1000 covers the 30-day window every realized tile and chart reads,
      // with room to spare at current fleet volume; `windowTruncated` flags
      // the figures as partial if it ever stops doing so.
      closedPositions: this.positionsService
        .list(
          this.scopedRequest({
            currentPage: 1,
            itemCountPerPage: CLOSED_PAGE_SIZE,
            filter: { status: 'Closed' },
            sortBy: 'closedAt',
            sortDirection: 'desc',
          }),
        )
        .pipe(
          map((r) => (r?.status === false ? null : (r.data?.data ?? []))),
          catchError(() => of(null)),
        ),
      // Server-side status filter: the count and the allocation ring both mean
      // "Active now", whatever else the strategy table holds.
      strategies: this.strategiesService
        .list({ currentPage: 1, itemCountPerPage: 200, filter: { status: 'Active' } })
        .pipe(
          map((r) =>
            r?.status === false || !r.data
              ? null
              : {
                  rows: r.data.data ?? [],
                  total: r.data.pager?.totalItemCount ?? r.data.data.length,
                },
          ),
          catchError(() => of(null)),
        ),
      signals: this.signalsService.list({ currentPage: 1, itemCountPerPage: 100 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as TradeSignalDto[])),
      ),
      // Counted by the engine: filtering the 100 newest signals for Pending
      // capped the tile at whatever that page happened to hold.
      pending: this.signalsService
        .list({ currentPage: 1, itemCountPerPage: 8, filter: { status: 'Pending' } })
        .pipe(
          map((r) =>
            r?.status === false || !r.data
              ? null
              : {
                  rows: r.data.data ?? [],
                  total: r.data.pager?.totalItemCount ?? r.data.data.length,
                },
          ),
          catchError(() => of(null)),
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
      //
      // `drawdown-recovery/latest` needs `risk.manage` (catalog v2; `access.operator` before). Without
      // it the engine refuses on every poll, so the tile stays empty instead of asking.
      drawdown: this.auth.hasPermission(Permission.RiskManage)
        ? this.drawdownService.getLatest(this.accountScope.accountIds()).pipe(
            map((r) => r.data ?? null),
            catchError(() => of(null as DrawdownSnapshotDto | null)),
          )
        : of(null as DrawdownSnapshotDto | null),
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
      eaInstances: this.eaService.list().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as EAInstanceDto[])),
      ),
      workers: this.workersService.list().pipe(catchError(() => of([] as WorkerHealthDto[]))),
      // Active models only, newest first: one row (the "latest") plus the
      // pager total (the count).
      mlModels: this.mlService
        .list({
          currentPage: 1,
          itemCountPerPage: 1,
          filter: { isActive: true },
          sortBy: 'trainedAt',
          sortDirection: 'desc',
        })
        .pipe(
          map((r) =>
            r?.status === false || !r.data
              ? null
              : {
                  latest: r.data.data?.[0] ?? null,
                  total: r.data.pager?.totalItemCount ?? r.data.data?.length ?? 0,
                },
          ),
          catchError(() => of(null)),
        ),
    }).subscribe(
      ({
        openPositions,
        closedPositions,
        strategies,
        signals,
        pending,
        orders,
        status,
        drawdown,
        accounts,
        allocations,
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
        // A failed query (null) leaves the previous rows in place and marks
        // the figures unknown rather than writing an empty book over them.
        if (openPositions) {
          this.rawOpenPositions.set(
            openPositions.filter((p) => p.status === 'Open' || p.status === 'Closing'),
          );
        }
        this.openPositionsKnown.set(openPositions !== null && scoped);
        if (closedPositions) {
          this.rawClosedPositions.set(closedPositions.filter((p) => p.status === 'Closed'));
        }
        this.closedPositionsKnown.set(closedPositions !== null && scoped);
        this.rawRecentOrders.set(orders);

        this.activeStrategies.set(strategies?.rows ?? null);
        this.activeStrategyTotal.set(strategies?.total ?? null);

        // Signals are multi-account (engine-side fan-out via SignalAccountAttempt),
        // so the Pending Signals tile stays fleet-wide.
        this.pendingSignalCount.set(pending?.total ?? null);
        this.pendingSignals.set(pending?.rows ?? []);
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
        // eaInstances was set above (before the account/equity derivations)
        // so liveAccounts() resolves correctly on the same tick.
        this.workers.set(workers);
        this.activeMlModelCount.set(mlModels?.total ?? null);
        this.mostRecentMlModel.set(mlModels?.latest ?? null);

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

  /**
   * Recent Alerts reads alert RULES (2,000+ rows) and shows those that fired
   * most recently. It used to take page 1 of 25 in the engine's default order
   * (by IsActive), so it showed whatever rules sat first — fires five and six
   * months old under "Recent" while rules fired minutes ago were never fetched.
   *
   * Sorting by lastTriggeredAt desc alone was not enough: Postgres put NULLs
   * first on DESC, and ~770 rules have never fired. The engine's
   * `hasTriggered` filter (AlertQueryFilter, 2026-10-19) drops those, and it
   * now sorts never-fired rules last; the one-wider-page fallback for engines
   * without it is gone. Rows are still checked for a fire time, cheaply.
   * Polled at most once a minute — alert rules churn far slower than the 15 s
   * position poll.
   */
  private alertsFetchedAt = 0;
  private loadRecentAlerts(): void {
    if (Date.now() - this.alertsFetchedAt < 60_000) return;
    this.alertsFetchedAt = Date.now();
    this.alertsService
      .list({
        currentPage: 1,
        itemCountPerPage: RECENT_ALERT_PAGE,
        sortBy: 'lastTriggeredAt',
        sortDirection: 'desc',
        filter: { hasTriggered: true },
      })
      .pipe(
        map((r): AlertDto[] | null => (r?.status === false ? null : (r?.data?.data ?? []))),
        catchError(() => of(null)),
      )
      .subscribe((rows) => {
        if (rows === null) {
          this.alertsUnavailable.set(true);
          this.alertsFetchedAt = 0; // retry on the next refresh
          return;
        }
        this.alertsUnavailable.set(false);
        this.alerts.set(rows.filter((a) => !!a.lastTriggeredAt));
      });
  }

  /** The signal the operator is about to approve or reject — drives the confirm dialog. */
  readonly signalAction = signal<{ kind: 'approve' | 'reject'; signal: TradeSignalDto } | null>(
    null,
  );
  readonly signalActionBusy = signal(false);
  readonly signalActionMessage = computed(() => {
    const a = this.signalAction();
    if (!a) return '';
    const s = a.signal;
    const what = `#${s.id} ${s.direction} ${s.symbol ?? ''} (${(s.confidence * 100).toFixed(0)}% confidence)`;
    return a.kind === 'approve'
      ? `Approve signal ${what}? It is released to the trading accounts for execution.`
      : `Reject signal ${what}? It will not be executed.`;
  });

  confirmSignalAction(): void {
    const a = this.signalAction();
    if (!a || this.signalActionBusy()) return;
    this.signalActionBusy.set(true);
    const call =
      a.kind === 'approve'
        ? this.signalsService.approve(a.signal.id)
        : this.signalsService.reject(a.signal.id, { reason: 'Rejected from dashboard' });
    const verb = a.kind === 'approve' ? 'approve' : 'reject';
    call.subscribe({
      next: (res) => {
        this.signalActionBusy.set(false);
        // HTTP 200 with status:false is a refusal (already expired, already
        // decided, …) — it used to toast success regardless.
        if (res?.status === false) {
          this.notifications.error(res.message ?? `Failed to ${verb} signal`);
          return;
        }
        this.signalAction.set(null);
        if (a.kind === 'approve') this.notifications.success(`Signal #${a.signal.id} approved`);
        else this.notifications.warning(`Signal #${a.signal.id} rejected`);
        this.refresh();
      },
      error: () => {
        this.signalActionBusy.set(false);
        this.notifications.error(`Failed to ${verb} signal`);
      },
    });
  }
}

/** Every realized figure on the page reads the same 30-day window. */
const WINDOW_MS = 30 * 24 * 3600_000;
/** Closed-position page size; a full page whose oldest row is in the window means truncation. */
const CLOSED_PAGE_SIZE = 1000;
const RECENT_ALERT_PAGE = 25;

function usd(v: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

/** A tooltip value as a number — a [time, value] point passes its value. */
function tooltipNumber(v: unknown): number {
  return Number(Array.isArray(v) ? v[v.length - 1] : v);
}

/**
 * The single Worker Health bucket a worker is counted under (see workerBuckets).
 * `isStale` is ignored for a completed one-shot worker: it has no next cycle.
 */
function workerBucket(w: WorkerHealthDto): 'Healthy' | 'Degraded' | 'Failed' | 'Idle' | 'Stale' {
  if (w.status === 'Failed') return 'Failed';
  if (w.status === 'Degraded') return 'Degraded';
  if (w.isStale && !w.isCompleted) return 'Stale';
  if (w.status === 'Idle') return 'Idle';
  return 'Healthy';
}

/** A money value axis: compact dollar labels ("$1.2K") on solid hairline gridlines. */
function valueAxis(): { type: 'value'; axisLabel: object; splitLine: object } {
  const compact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  return {
    type: 'value',
    axisLabel: { fontSize: 10, formatter: (v: number) => compact.format(v) },
    splitLine: { show: true, lineStyle: { type: 'solid', opacity: 0.7 } },
  };
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
