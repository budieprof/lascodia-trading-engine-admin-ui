import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  effect,
  inject,
  signal,
  computed,
  OnInit,
  ViewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { filter, map, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { OrdersService } from '@core/services/orders.service';
import { BacktestsService } from '@core/services/backtests.service';
import { WalkForwardService } from '@core/services/walk-forward.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import {
  StrategyDto,
  StrategyPerformanceSnapshotDto,
  OptimizationRunDto,
  BacktestRunDto,
  WalkForwardRunDto,
  PagerRequest,
  UpdateStrategyRequest,
  StrategyLineageDto,
  StrategyLineageNodeDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { StrategyFormComponent } from '../../components/strategy-form/strategy-form.component';
import { PromotionReadinessCardComponent } from '../../components/promotion-readiness-card/promotion-readiness-card.component';
import { StrategyVariantsTabComponent } from '../../components/strategy-variants-tab/strategy-variants-tab.component';
import { StrategyCapacityCardComponent } from '../../components/strategy-capacity-card/strategy-capacity-card.component';
import { StrategyPromotionReviewsTabComponent } from '../../components/strategy-promotion-reviews-tab/strategy-promotion-reviews-tab.component';
import { RejectionDistributionDrawerComponent } from '../../components/rejection-distribution-drawer/rejection-distribution-drawer.component';
import { RationaleInlineComponent } from '@features/llm/components/rationale-inline/rationale-inline.component';

@Component({
  selector: 'app-strategy-detail-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    PresenceBadgeComponent,
    DataTableComponent,
    StatusBadgeComponent,
    ConfirmDialogComponent,
    GaugeComponent,
    TabsComponent,
    EnumLabelPipe,
    RelativeTimePipe,
    StrategyFormComponent,
    PromotionReadinessCardComponent,
    StrategyVariantsTabComponent,
    StrategyCapacityCardComponent,
    StrategyPromotionReviewsTabComponent,
    RejectionDistributionDrawerComponent,
    RationaleInlineComponent,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (strategy()) {
        <app-page-header
          [title]="strategy()!.name ?? ''"
          [subtitle]="(strategy()!.symbol ?? '') + ' - ' + (strategy()!.description ?? '')"
        >
          <app-presence-badge [routeKey]="'strategy:' + strategyId" />
          <button class="btn btn-secondary" (click)="openAnalytics()">Open analytics →</button>
          <button
            type="button"
            class="btn btn-secondary"
            (click)="showRejectionDrawer.set(true)"
            title="Show per-gate signal-rejection counts for this strategy"
          >
            Why no signals?
          </button>
          <button class="btn btn-ghost" (click)="goBack()">Back</button>
        </app-page-header>

        <!--
          LLM-authored rationale for the strategy's most recent activation
          event. Hides itself when no rationale is attached. Operators
          looking for older / different event-type rationales can click
          through to /llm/rationales filtered by EventId=strategyId.
        -->
        <app-rationale-inline eventType="StrategyActivated" [eventId]="strategyId" />

        @if (latestSnapshot(); as s) {
          <div class="health-strip">
            <div class="health-gauge-col">
              <app-gauge
                [value]="gaugePercent()"
                [min]="0"
                [max]="100"
                label="Health"
                size="120px"
                [thresholds]="healthThresholds"
              />
              @if (weeklyDeltaPct() !== null) {
                <span class="delta-chip" [attr.data-dir]="weeklyDeltaDir()">
                  @if (weeklyDeltaDir() === 'up') {
                    ↑
                  } @else if (weeklyDeltaDir() === 'down') {
                    ↓
                  } @else {
                    →
                  }
                  {{ weeklyDeltaPct()! >= 0 ? '+' : '' }}{{ weeklyDeltaPct() }} pts vs 7d ago
                </span>
              }
            </div>
            <dl class="health-meta">
              <div>
                <dt>Status</dt>
                <dd>{{ s.healthStatus ?? '—' }}</dd>
              </div>
              <div>
                <dt>Win rate</dt>
                <dd>{{ (s.winRate * 100).toFixed(1) }}%</dd>
              </div>
              <div>
                <dt>Profit factor</dt>
                <dd>{{ s.profitFactor.toFixed(2) }}</dd>
              </div>
              <div>
                <dt>Sharpe</dt>
                <dd>{{ s.sharpeRatio.toFixed(2) }}</dd>
              </div>
              <div>
                <dt>Max DD</dt>
                <dd>{{ s.maxDrawdownPct.toFixed(1) }}%</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>{{ s.windowTrades }} trades</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ s.evaluatedAt | relativeTime }}</dd>
              </div>
            </dl>
          </div>
        }

        <ui-tabs [tabs]="detailTabs" [(activeTab)]="activeTab">
          <!-- Config Tab -->
          @if (activeTab() === 'config') {
            <div class="detail-layout">
              <!-- 8-card KPI strip — quick scan of life-to-date activity.
                   The run-count cards double as nav shortcuts to the
                   matching tabs further down. -->
              <div class="cfg-kpis">
                <button class="cfg-kpi clickable" (click)="activeTab.set('signals')">
                  <span class="cfg-kpi-label">Signals</span>
                  <span class="cfg-kpi-value">{{ totalSignals() ?? '—' }}</span>
                </button>
                <button class="cfg-kpi clickable" (click)="activeTab.set('orders')">
                  <span class="cfg-kpi-label">Orders</span>
                  <span class="cfg-kpi-value">{{ totalOrders() ?? '—' }}</span>
                </button>
                <button class="cfg-kpi clickable" (click)="activeTab.set('optimization')">
                  <span class="cfg-kpi-label">Optim. runs</span>
                  <span class="cfg-kpi-value">{{ totalOptimizations() ?? '—' }}</span>
                </button>
                <button class="cfg-kpi clickable" (click)="activeTab.set('backtests')">
                  <span class="cfg-kpi-label">Backtests</span>
                  <span class="cfg-kpi-value">{{ totalBacktests() ?? '—' }}</span>
                </button>
                <button class="cfg-kpi clickable" (click)="activeTab.set('walkforward')">
                  <span class="cfg-kpi-label">Walk-fwd runs</span>
                  <span class="cfg-kpi-value">{{ totalWalkForwards() ?? '—' }}</span>
                </button>
                <div class="cfg-kpi">
                  <span class="cfg-kpi-label">Days alive</span>
                  <span class="cfg-kpi-value">{{ daysAlive() }}</span>
                </div>
                <div class="cfg-kpi">
                  <span class="cfg-kpi-label">Status</span>
                  <span class="cfg-kpi-value">
                    <app-status-badge [status]="strategy()!.status" type="strategy" />
                  </span>
                </div>
                <div class="cfg-kpi">
                  <span class="cfg-kpi-label">Risk profile</span>
                  <span class="cfg-kpi-value">
                    {{ strategy()!.riskProfileId ? '#' + strategy()!.riskProfileId : 'None' }}
                  </span>
                </div>
              </div>

              <!-- Strategy details + Parameters side-by-side -->
              <div class="cfg-2col">
                <div class="detail-card">
                  <h3 class="card-title">Strategy Details</h3>
                  <div class="detail-grid">
                    <div class="detail-item">
                      <span class="detail-label">Name</span>
                      <span class="detail-value">{{ strategy()!.name }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Symbol</span>
                      <span class="detail-value">{{ strategy()!.symbol }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Timeframe</span>
                      <span class="detail-value">{{
                        strategy()!.timeframe | enumLabel: 'timeframe'
                      }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Type</span>
                      <span class="detail-value">{{ strategy()!.strategyType | enumLabel }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Status</span>
                      <span class="detail-value"
                        ><app-status-badge [status]="strategy()!.status" type="strategy"
                      /></span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Risk Profile</span>
                      <span class="detail-value">{{
                        strategy()!.riskProfileId ? '#' + strategy()!.riskProfileId : 'None'
                      }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Created</span>
                      <span class="detail-value">{{ strategy()!.createdAt | relativeTime }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Strategy ID</span>
                      <span class="detail-value mono">#{{ strategy()!.id }}</span>
                    </div>
                  </div>
                </div>

                @if (strategy()!.parametersJson) {
                  <div class="detail-card">
                    <h3 class="card-title">Parameters</h3>
                    <pre class="code-block">{{ formatJson(strategy()!.parametersJson!) }}</pre>
                  </div>
                } @else {
                  <div class="detail-card">
                    <h3 class="card-title">Parameters</h3>
                    <p class="muted">No tunable parameters defined.</p>
                  </div>
                }
              </div>

              <!-- Recent signals + Recent orders mini-feed -->
              <div class="cfg-2col">
                <div class="detail-card">
                  <h3 class="card-title">Recent signals</h3>
                  @if (recentSignals().length > 0) {
                    <table class="mini-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Dir</th>
                          <th class="num">Entry</th>
                          <th class="num">Conf %</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (s of recentSignals(); track s.id) {
                          <tr>
                            <td class="mono">{{ s.generatedAt | relativeTime }}</td>
                            <td
                              class="mono"
                              [class.profit]="String(s.direction) === 'Buy'"
                              [class.loss]="String(s.direction) === 'Sell'"
                            >
                              {{ s.direction }}
                            </td>
                            <td class="num mono">{{ s.entryPrice.toFixed(5) }}</td>
                            <td class="num mono">
                              {{ (s.confidence * 100).toFixed(0) }}
                            </td>
                            <td>{{ s.status }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else {
                    <p class="muted">No signals generated yet.</p>
                  }
                </div>

                <div class="detail-card">
                  <h3 class="card-title">Recent orders</h3>
                  @if (recentOrders().length > 0) {
                    <table class="mini-table">
                      <thead>
                        <tr>
                          <th>Created</th>
                          <th>Type</th>
                          <th class="num">Qty</th>
                          <th class="num">Price</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (o of recentOrders(); track o.id) {
                          <tr>
                            <td class="mono">{{ o.createdAt | relativeTime }}</td>
                            <td class="mono">{{ o.orderType }}</td>
                            <td class="num mono">{{ o.quantity.toFixed(2) }}</td>
                            <td class="num mono">{{ o.price.toFixed(5) }}</td>
                            <td>{{ o.status }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else {
                    <p class="muted">No orders placed yet.</p>
                  }
                </div>
              </div>

              <div class="action-bar">
                @if (strategy()!.status === 'Paused' || strategy()!.status === 'Stopped') {
                  <button
                    class="btn btn-success"
                    (click)="onActivate()"
                    [disabled]="actionLoading()"
                  >
                    Activate
                  </button>
                }
                @if (strategy()!.status === 'Active') {
                  <button class="btn btn-warning" (click)="onPause()" [disabled]="actionLoading()">
                    Pause
                  </button>
                }
                <button class="btn btn-outline" (click)="showEditForm.set(true)">Edit</button>
                <button class="btn btn-destructive" (click)="showDeleteConfirm.set(true)">
                  Delete
                </button>
              </div>
            </div>
          }

          <!-- Promotion Tab — live evaluation of every PromotionGateValidator
               check (paper-trade duration, adversarial robustness, edge posterior,
               CPCV, TCA, correlation). Shows the breakdown the engine would emit
               on activation, with a paper-gate bypass toggle for hand-promoted
               strategies that have no PaperExecution history yet. -->
          @if (activeTab() === 'promotion' && strategy()) {
            <app-promotion-readiness-card
              [strategyId]="strategy()!.id"
              (activated)="onPromotionActivated()"
            />
          }

          <!-- Signals Tab -->
          @if (activeTab() === 'signals') {
            <app-data-table [columnDefs]="signalColumns" [fetchData]="fetchSignals" />
          }

          <!-- Orders Tab -->
          @if (activeTab() === 'orders') {
            <app-data-table [columnDefs]="orderColumns" [fetchData]="fetchOrders" />
          }

          <!-- Optimization Tab -->
          @if (activeTab() === 'optimization') {
            <div class="optimization-header">
              <button
                class="btn btn-primary"
                (click)="onTriggerOptimization()"
                [disabled]="optimizationLoading()"
              >
                @if (optimizationLoading()) {
                  <span class="spinner"></span>
                } @else {
                  Trigger Optimization
                }
              </button>
            </div>

            <app-data-table
              #optimizationTable
              [columnDefs]="optimizationColumns"
              [fetchData]="fetchOptimizations"
            />
          }

          <!-- Backtests Tab — runs filtered to this strategy. Click-through
               navigates to the backtest detail page (same view the global
               Backtests page links to). -->
          @if (activeTab() === 'backtests') {
            <app-data-table
              [columnDefs]="backtestColumns"
              [fetchData]="fetchBacktests"
              (rowClick)="onBacktestRowClick($event)"
            />
          }

          <!-- Walk-Forward Tab — runs filtered to this strategy. -->
          @if (activeTab() === 'walkforward') {
            <app-data-table
              [columnDefs]="walkForwardColumns"
              [fetchData]="fetchWalkForward"
              (rowClick)="onWalkForwardRowClick($event)"
            />
          }

          <!-- Variants Tab — A/B shadow tests attached to this base strategy. -->
          @if (activeTab() === 'variants') {
            <app-strategy-variants-tab [strategyId]="strategyId" />
          }

          <!-- Capacity Profile Tab — AUM-vs-Sharpe sweep with sizing guidance. -->
          @if (activeTab() === 'capacity') {
            <app-strategy-capacity-card [strategyId]="strategyId" />
          }

          <!-- Promotion Reviews Tab — bull/bear/judge advisory pipeline output. -->
          @if (activeTab() === 'reviews') {
            <app-strategy-promotion-reviews-tab [strategyId]="strategyId" />
          }

          <!-- Lineage Tab — parent/child tree centred on this strategy. -->
          @if (activeTab() === 'lineage') {
            <section class="lineage-panel">
              @if (loadingLineage()) {
                <p class="muted">Loading lineage…</p>
              } @else if (lineage(); as l) {
                @if (l.nodes.length <= 1) {
                  <p class="muted">
                    No ancestors or descendants — this strategy was created standalone.
                  </p>
                } @else {
                  <div class="lineage-legend">
                    <span class="muted small"
                      >{{ ancestorCount() }} ancestor(s) · 1 focus ·
                      {{ descendantCount() }} descendant(s)</span
                    >
                  </div>
                  @if (lineageLayout(); as layout) {
                    <div class="lineage-tree" [style.height.px]="layout.height">
                      <svg
                        class="lineage-svg"
                        [attr.width]="layout.width"
                        [attr.height]="layout.height"
                        [attr.viewBox]="'0 0 ' + layout.width + ' ' + layout.height"
                      >
                        @for (e of layout.edges; track e.id) {
                          <path
                            [attr.d]="e.path"
                            fill="none"
                            [attr.stroke]="e.color"
                            stroke-width="1.4"
                          />
                        }
                      </svg>
                      @for (n of layout.nodes; track n.id) {
                        <a
                          class="lineage-tree-node"
                          [class.is-focus]="n.depthOffset === 0"
                          [class.is-ancestor]="n.depthOffset < 0"
                          [class.is-descendant]="n.depthOffset > 0"
                          [routerLink]="n.depthOffset === 0 ? null : ['/strategies', n.id]"
                          [style.left.px]="n.x - n.width / 2"
                          [style.top.px]="n.y - 14"
                          [style.width.px]="n.width"
                          [title]="n.tooltip"
                        >
                          <span class="lineage-tree-name">{{ n.name }}</span>
                          <span class="muted small"
                            >#{{ n.id }} · {{ n.symbol }}/{{ n.timeframe }}</span
                          >
                        </a>
                      }
                    </div>
                  }
                }
              } @else {
                <p class="muted">Lineage unavailable.</p>
              }
            </section>
          }
        </ui-tabs>
      } @else if (loadError()) {
        <div class="error-state">
          <h2>Strategy not found</h2>
          <p>The requested strategy could not be loaded.</p>
          <button class="btn btn-outline" (click)="goBack()">Back to Strategies</button>
        </div>
      } @else {
        <div class="loading-state">
          <div class="loading-shimmer"></div>
          <div class="loading-shimmer short"></div>
        </div>
      }

      <app-confirm-dialog
        [open]="showDeleteConfirm()"
        title="Delete Strategy"
        [message]="
          'Are you sure you want to delete ' +
          (strategy()?.name ?? 'this strategy') +
          '? This action cannot be undone.'
        "
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="deleteLoading()"
        (confirm)="onDelete()"
        (cancelled)="showDeleteConfirm.set(false)"
      />

      <app-strategy-form
        [open]="showEditForm()"
        [strategy]="strategy()"
        (submitted)="onUpdate($event)"
        (cancelled)="showEditForm.set(false)"
      />

      @if (showRejectionDrawer()) {
        <app-rejection-distribution-drawer
          [strategyId]="strategyId"
          (closed)="showRejectionDrawer.set(false)"
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .health-strip {
        display: flex;
        align-items: center;
        gap: var(--space-6);
        padding: var(--space-4) var(--space-5);
        margin: var(--space-3) 0 var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .health-gauge-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-2);
      }
      .delta-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .delta-chip[data-dir='up'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .delta-chip[data-dir='down'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .health-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: var(--space-4) var(--space-5);
        margin: 0;
        flex: 1;
      }
      .health-meta div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .health-meta dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .health-meta dd {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
        font-variant-numeric: tabular-nums;
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
        justify-content: center;
        gap: var(--space-1);
        min-width: 80px;
      }
      .btn:active:not(:disabled) {
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

      .btn-success {
        background: #34c759;
        color: white;
      }
      .btn-success:hover:not(:disabled) {
        background: #2db84e;
      }

      .btn-warning {
        background: #ff9500;
        color: white;
      }
      .btn-warning:hover:not(:disabled) {
        background: #e68600;
      }

      .btn-destructive {
        background: var(--loss);
        color: white;
      }
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
      }

      .btn-outline {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-outline:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }

      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
      }
      .btn-ghost:hover {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }

      .btn-sm {
        height: 28px;
        padding: 0 var(--space-3);
        font-size: var(--text-xs);
        min-width: auto;
      }

      .detail-layout {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }

      .detail-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }

      .card-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-4);
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: var(--space-4);
      }

      .detail-item {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }

      .detail-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .detail-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }

      .code-block {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-4);
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 12px;
        color: var(--text-primary);
        overflow-x: auto;
        line-height: 1.6;
        margin: 0;
        white-space: pre-wrap;
        word-wrap: break-word;
      }

      .action-bar {
        display: flex;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }

      /* Config-tab density additions */
      .cfg-kpis {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1100px) {
        .cfg-kpis {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 600px) {
        .cfg-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .cfg-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-height: 64px;
        text-align: left;
        font-family: inherit;
      }
      .cfg-kpi.clickable {
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .cfg-kpi.clickable:hover {
        border-color: var(--accent);
        transform: translateY(-1px);
        box-shadow: var(--shadow-sm);
      }
      .cfg-kpi.clickable:active {
        transform: translateY(0);
      }
      .cfg-kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cfg-kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .cfg-2col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 1100px) {
        .cfg-2col {
          grid-template-columns: 1fr;
        }
      }

      .mini-table {
        width: 100%;
        border-collapse: collapse;
      }
      .mini-table th,
      .mini-table td {
        padding: 6px var(--space-2);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .mini-table tbody tr:last-child td {
        border-bottom: none;
      }
      .mini-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mini-table th.num,
      .mini-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mini-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .mini-table .profit {
        color: var(--profit);
      }
      .mini-table .loss {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 0;
      }
      .detail-value.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      .optimization-header {
        display: flex;
        justify-content: flex-end;
        margin-bottom: var(--space-4);
      }

      .error-state {
        text-align: center;
        padding: var(--space-16);
      }
      .error-state h2 {
        font-size: var(--text-lg);
        color: var(--text-primary);
        margin: 0 0 var(--space-2);
      }
      .error-state p {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0 0 var(--space-6);
      }

      .loading-state {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-8) 0;
      }

      .loading-shimmer {
        height: 20px;
        width: 60%;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        animation: shimmer 1.5s infinite;
      }
      .loading-shimmer.short {
        width: 30%;
        height: 14px;
      }

      @keyframes shimmer {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .lineage-panel {
        background: var(--bg-secondary, #f7f8fa);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
        padding: 12px 16px;
      }
      .lineage-legend {
        margin-bottom: 8px;
      }
      .lineage-tree {
        position: relative;
        margin: 8px 0;
        overflow-x: auto;
      }
      .lineage-svg {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
      }
      .lineage-tree-node {
        position: absolute;
        height: 36px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 2px 8px;
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.2;
        text-decoration: none;
        color: var(--text-primary, #1d1d1f);
        box-sizing: border-box;
        text-align: center;
        overflow: hidden;
      }
      .lineage-tree-node.is-focus {
        background: rgba(0, 113, 227, 0.08);
        border-color: #0071e3;
        cursor: default;
        font-weight: 500;
      }
      .lineage-tree-node.is-ancestor {
        border-color: #c5b3e6;
      }
      .lineage-tree-node.is-descendant {
        border-color: #9ec5fe;
      }
      .lineage-tree-node:hover:not(.is-focus) {
        background: rgba(0, 113, 227, 0.04);
      }
      .lineage-tree-name {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
    `,
  ],
})
export class StrategyDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly strategiesService = inject(StrategiesService);
  private readonly feedbackService = inject(StrategyFeedbackService);
  private readonly signalsService = inject(TradeSignalsService);
  private readonly ordersService = inject(OrdersService);
  private readonly backtestsService = inject(BacktestsService);
  private readonly walkForwardService = inject(WalkForwardService);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly enumLabel = new EnumLabelPipe();
  private readonly relativeTime = new RelativeTimePipe();

  /**
   * Latest health snapshot for this strategy. One initial fetch on init,
   * then refreshed in-band when the realtime hub pushes
   * `strategyHealthSnapshotCreated` for this strategy id. The gauge above
   * the tabs reads from this signal.
   */
  readonly latestSnapshot = signal<StrategyPerformanceSnapshotDto | null>(null);

  /**
   * Snapshot from ~7 days ago — the closest historical row at-or-before that
   * point. Powers the delta arrow next to the gauge so operators see whether
   * the strategy is improving or decaying week-on-week. `null` until the
   * strategy has at least 7 days of history.
   */
  readonly weekAgoSnapshot = signal<StrategyPerformanceSnapshotDto | null>(null);

  /** 0..100 mapping of HealthScore for the gauge widget (gauge expects percent). */
  protected gaugePercent(): number {
    const s = this.latestSnapshot();
    return s ? Math.round(s.healthScore * 100) : 0;
  }

  /**
   * Week-over-week health-score delta in percentage points (e.g. +12 means
   * the score went from 0.50 → 0.62). Returns `null` when we lack a 7-day
   * baseline so the template can hide the chip rather than render zero.
   */
  protected weeklyDeltaPct(): number | null {
    const now = this.latestSnapshot();
    const then = this.weekAgoSnapshot();
    if (!now || !then) return null;
    return Math.round((now.healthScore - then.healthScore) * 100);
  }

  /** Direction class for the delta chip — drives colour + arrow glyph. */
  protected weeklyDeltaDir(): 'up' | 'down' | 'flat' {
    const d = this.weeklyDeltaPct();
    if (d === null || d === 0) return 'flat';
    return d > 0 ? 'up' : 'down';
  }

  /**
   * Inverted threshold palette: low score = bad (red), high = good (green).
   * The default Gauge palette assumes "low is good" (e.g. drawdown %), which
   * would colour a healthy strategy red — wrong signal entirely.
   */
  protected readonly healthThresholds = [
    { value: 30, color: '#FF3B30' },
    { value: 60, color: '#FF9500' },
    { value: 100, color: '#34C759' },
  ];

  @ViewChild('optimizationTable') optimizationTable?: DataTableComponent<OptimizationRunDto>;

  strategy = signal<StrategyDto | null>(null);
  loadError = signal(false);
  activeTab = signal('config');
  actionLoading = signal(false);
  showDeleteConfirm = signal(false);
  deleteLoading = signal(false);
  showEditForm = signal(false);
  showRejectionDrawer = signal(false);
  optimizationLoading = signal(false);

  // Config-tab roll-up signals: lifetime counters and last-N feeds.
  // null while loading; numeric value once the count comes back.
  totalSignals = signal<number | null>(null);
  totalOrders = signal<number | null>(null);
  totalOptimizations = signal<number | null>(null);
  totalBacktests = signal<number | null>(null);
  totalWalkForwards = signal<number | null>(null);
  recentSignals = signal<any[]>([]);
  recentOrders = signal<any[]>([]);

  // Lineage tab — lazily loaded the first time the tab is opened.
  // The effect runs at field-initializer time (an injection context), so the
  // first read is queued for the first activeTab() change after init.
  loadingLineage = signal(false);
  lineage = signal<StrategyLineageDto | null>(null);
  private readonly lineageLoader = effect(() => {
    if (
      this.activeTab() === 'lineage' &&
      this.lineage() === null &&
      !this.loadingLineage() &&
      this.strategyId
    ) {
      this.fetchLineage();
    }
  });

  ancestorCount = computed(
    () => this.lineage()?.nodes.filter((n) => n.depthOffset < 0).length ?? 0,
  );
  descendantCount = computed(
    () => this.lineage()?.nodes.filter((n) => n.depthOffset > 0).length ?? 0,
  );

  /**
   * Layered tree layout: depth → row, siblings spread evenly along x. Edges
   * connect each node to its `parentInTree` via a vertical-then-horizontal
   * elbow path. Box width is fixed (180px); height is computed from row count.
   * No external library — for shallow lineages (≤10 levels × ≤8 siblings) a
   * simple greedy layout is plenty.
   */
  lineageLayout = computed<{
    nodes: {
      id: number;
      x: number;
      y: number;
      width: number;
      name: string;
      symbol: string;
      timeframe: string;
      depthOffset: number;
      tooltip: string;
    }[];
    edges: { id: string; path: string; color: string }[];
    width: number;
    height: number;
  } | null>(() => {
    const lineage = this.lineage();
    if (!lineage || lineage.nodes.length === 0) return null;

    // Defaults sized for shallow trees. We compress NODE_W when a row gets
    // wide so 12+ siblings still fit on a typical 1200px viewport. Compression
    // floors at 96px (just enough for "EURUSD/H1 #12345"); past that we let
    // the container scroll horizontally.
    const NODE_W_MAX = 180;
    const NODE_W_MIN = 96;
    const ROW_H = 56;
    const X_GAP = 16;
    const TOP_PAD = 24;
    const VIEWPORT = 1200;

    // Bucket by depthOffset row.
    const rows = new Map<number, StrategyLineageNodeDto[]>();
    for (const n of lineage.nodes) {
      const arr = rows.get(n.depthOffset) ?? [];
      arr.push(n);
      rows.set(n.depthOffset, arr);
    }
    const sortedDepths = [...rows.keys()].sort((a, b) => a - b);

    let maxRow = 0;
    for (const arr of rows.values()) {
      if (arr.length > maxRow) maxRow = arr.length;
    }

    // Anti-collision: compute the largest NODE_W that still fits the widest
    // row inside VIEWPORT. Floor at NODE_W_MIN — past that the container
    // gets a horizontal scroll bar instead of forcing tiny boxes.
    const fitNodeW = Math.floor((VIEWPORT - (maxRow - 1) * X_GAP) / Math.max(maxRow, 1));
    const NODE_W = Math.max(NODE_W_MIN, Math.min(NODE_W_MAX, fitNodeW));

    const width = Math.max(NODE_W + 40, maxRow * (NODE_W + X_GAP));
    const height = sortedDepths.length * ROW_H + TOP_PAD;

    // Position each node centred within its row.
    const positioned: {
      id: number;
      x: number;
      y: number;
      width: number;
      name: string;
      symbol: string;
      timeframe: string;
      depthOffset: number;
      parentInTree: number | null;
      tooltip: string;
    }[] = [];
    for (const depth of sortedDepths) {
      const arr = rows.get(depth)!;
      // Stable sort by createdAt so re-renders don't shuffle.
      arr.sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
      );
      const rowWidth = arr.length * NODE_W + (arr.length - 1) * X_GAP;
      const xStart = (width - rowWidth) / 2 + NODE_W / 2;
      const y = TOP_PAD + sortedDepths.indexOf(depth) * ROW_H + 14;
      arr.forEach((n, i) => {
        positioned.push({
          id: n.id,
          x: xStart + i * (NODE_W + X_GAP),
          y,
          width: NODE_W,
          name: n.name ?? '(unnamed)',
          symbol: n.symbol ?? '?',
          timeframe: String(n.timeframe ?? ''),
          depthOffset: n.depthOffset,
          parentInTree: n.parentInTree ?? null,
          tooltip:
            `${n.strategyType} · ${n.status}` +
            (n.generationSource ? ` · via ${n.generationSource}` : ''),
        });
      });
    }

    // Build edges from parent → child via L-shape elbow at midpoint y.
    const byId = new Map(positioned.map((p) => [p.id, p]));
    const edges: { id: string; path: string; color: string }[] = [];
    for (const p of positioned) {
      if (p.parentInTree == null) continue;
      const parent = byId.get(p.parentInTree);
      if (!parent) continue;
      // Going from parent (which sits ABOVE if descendant, BELOW if ancestor) to p.
      // Top of p = p.y - 14, bottom of parent = parent.y + 14. Elbow at the
      // halfway point between them on y, vertical at parent.x then over to p.x.
      const px = parent.x;
      const py = parent.y + (p.depthOffset > parent.depthOffset ? 14 : -14);
      const cx = p.x;
      const cy = p.y + (p.depthOffset > parent.depthOffset ? -14 : 14);
      const my = (py + cy) / 2;
      const path = `M ${px} ${py} L ${px} ${my} L ${cx} ${my} L ${cx} ${cy}`;
      const color = p.depthOffset > 0 ? '#9ec5fe' : '#c5b3e6';
      edges.push({ id: `e${p.id}`, path, color });
    }

    return {
      nodes: positioned.map(
        ({ id, x, y, width, name, symbol, timeframe, depthOffset, tooltip }) => ({
          id,
          x,
          y,
          width,
          name,
          symbol,
          timeframe,
          depthOffset,
          tooltip,
        }),
      ),
      edges,
      width,
      height,
    };
  });

  // Exposed for template `[class.profit]="String(...)"` checks.
  readonly String = String;

  // Derived: how many days the strategy has existed.
  daysAlive = computed(() => {
    const s = this.strategy();
    if (!s?.createdAt) return 0;
    const created = new Date(s.createdAt).getTime();
    return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
  });

  protected strategyId!: number;

  readonly detailTabs: TabItem[] = [
    { label: 'Config', value: 'config' },
    { label: 'Promotion', value: 'promotion' },
    { label: 'Signals', value: 'signals' },
    { label: 'Orders', value: 'orders' },
    { label: 'Optimization', value: 'optimization' },
    { label: 'Backtests', value: 'backtests' },
    { label: 'Walk-Forward', value: 'walkforward' },
    { label: 'Variants', value: 'variants' },
    { label: 'Capacity', value: 'capacity' },
    { label: 'Reviews', value: 'reviews' },
    { label: 'Lineage', value: 'lineage' },
  ];

  readonly signalColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'symbol', headerName: 'Symbol', flex: 1 },
    { field: 'direction', headerName: 'Direction', width: 100 },
    {
      field: 'entryPrice',
      headerName: 'Entry Price',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'stopLoss',
      headerName: 'SL',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'takeProfit',
      headerName: 'TP',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'confidence',
      headerName: 'Confidence',
      width: 100,
      valueFormatter: (p: any) => `${(p.value * 100).toFixed(1)}%`,
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (p: any) => {
        const v = this.getSignalStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    {
      field: 'generatedAt',
      headerName: 'Generated',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly orderColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'symbol', headerName: 'Symbol', flex: 1 },
    { field: 'orderType', headerName: 'Side', width: 80 },
    { field: 'executionType', headerName: 'Exec Type', width: 100 },
    { field: 'quantity', headerName: 'Qty', width: 80 },
    {
      field: 'price',
      headerName: 'Price',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'filledPrice',
      headerName: 'Filled',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (p: any) => {
        const v = this.getOrderStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly optimizationColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    {
      field: 'triggerType',
      headerName: 'Trigger',
      flex: 1,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      cellRenderer: (p: any) => {
        const v = this.getOptStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    { field: 'iterations', headerName: 'Iterations', width: 100 },
    {
      field: 'bestHealthScore',
      headerName: 'Best Score',
      width: 110,
      valueFormatter: (p: any) => p.value?.toFixed(4) ?? '-',
    },
    {
      field: 'baselineHealthScore',
      headerName: 'Baseline',
      width: 110,
      valueFormatter: (p: any) => p.value?.toFixed(4) ?? '-',
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
    {
      field: 'completedAt',
      headerName: 'Completed',
      flex: 1,
      valueFormatter: (p: any) => (p.value ? this.relativeTime.transform(p.value) : '-'),
    },
    {
      headerName: 'Actions',
      width: 180,
      sortable: false,
      cellRenderer: (p: any) => {
        const run = p.data as OptimizationRunDto;
        if (run.status === 'Completed') {
          return `<div style="display:flex;gap:6px;padding-top:4px">
            <button class="opt-action-btn approve" data-action="approve" data-id="${run.id}" style="height:24px;padding:0 10px;border:none;border-radius:9999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">Approve</button>
            <button class="opt-action-btn reject" data-action="reject" data-id="${run.id}" style="height:24px;padding:0 10px;border:none;border-radius:9999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Reject</button>
          </div>`;
        }
        return '';
      },
      onCellClicked: (params: any) => {
        const target = params.event?.target as HTMLElement;
        if (target?.dataset?.['action'] === 'approve') {
          this.onApproveOptimization(+target.dataset['id']!);
        } else if (target?.dataset?.['action'] === 'reject') {
          this.onRejectOptimization(+target.dataset['id']!);
        }
      },
    },
  ];

  // Engine `PagerRequestWithFilterType<TFilter,...>` setters reject any
  // bare-string `filter` value with HTTP 400 (System.Text.Json can't bind a
  // string to TFilter). Pass an object that matches the per-controller
  // filter shape — `{ strategyId }` is a first-class field on the trade-
  // signal, optimization, and (post-engine-update) order filters.
  readonly fetchSignals = (params: PagerRequest) =>
    this.signalsService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId } })
      .pipe(map((res) => res.data!));

  readonly fetchOrders = (params: PagerRequest) =>
    this.ordersService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId } })
      .pipe(map((res) => res.data!));

  readonly fetchOptimizations = (params: PagerRequest) =>
    this.feedbackService
      .listOptimizationRuns({
        ...params,
        filter: { ...(params.filter ?? {}), strategyId: this.strategyId },
      })
      .pipe(map((res) => res.data!));

  readonly fetchBacktests = (params: PagerRequest) =>
    this.backtestsService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId } })
      .pipe(map((res) => res.data!));

  readonly fetchWalkForward = (params: PagerRequest) =>
    this.walkForwardService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId } })
      .pipe(map((res) => res.data!));

  readonly backtestColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    {
      field: 'timeframe',
      headerName: 'TF',
      width: 80,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value, 'timeframe'),
    },
    {
      field: 'fromDate',
      headerName: 'From',
      width: 120,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
    {
      field: 'toDate',
      headerName: 'To',
      width: 120,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
    { field: 'status', headerName: 'Status', width: 110 },
    {
      field: 'totalTrades',
      headerName: 'Trades',
      width: 90,
      valueFormatter: (p: any) => (p.value != null ? p.value : '—'),
    },
    {
      field: 'winRate',
      headerName: 'Win %',
      width: 90,
      valueFormatter: (p: any) => (p.value != null ? `${(p.value * 100).toFixed(1)}%` : '—'),
    },
    {
      field: 'profitFactor',
      headerName: 'PF',
      width: 80,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(2) : '—'),
    },
    {
      field: 'maxDrawdownPct',
      headerName: 'Max DD',
      width: 100,
      valueFormatter: (p: any) => (p.value != null ? `${p.value.toFixed(2)}%` : '—'),
    },
    {
      field: 'sharpeRatio',
      headerName: 'Sharpe',
      width: 90,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(2) : '—'),
    },
    {
      field: 'totalReturn',
      headerName: 'Return',
      width: 100,
      valueFormatter: (p: any) => (p.value != null ? `${(p.value * 100).toFixed(2)}%` : '—'),
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly walkForwardColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    {
      field: 'timeframe',
      headerName: 'TF',
      width: 80,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value, 'timeframe'),
    },
    {
      field: 'fromDate',
      headerName: 'From',
      width: 120,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
    {
      field: 'toDate',
      headerName: 'To',
      width: 120,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
    { field: 'inSampleDays', headerName: 'IS days', width: 90 },
    { field: 'outOfSampleDays', headerName: 'OOS days', width: 100 },
    { field: 'status', headerName: 'Status', width: 110 },
    {
      field: 'averageOutOfSampleScore',
      headerName: 'Avg OOS',
      width: 110,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(3) : '—'),
    },
    {
      field: 'scoreConsistency',
      headerName: 'Consistency',
      width: 120,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(3) : '—'),
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  onBacktestRowClick(run: BacktestRunDto): void {
    this.router.navigate(['/backtests', run.id]);
  }

  onWalkForwardRowClick(run: WalkForwardRunDto): void {
    this.router.navigate(['/walk-forward', run.id]);
  }

  ngOnInit(): void {
    this.strategyId = +this.route.snapshot.paramMap.get('id')!;
    this.loadStrategy();
    this.loadLatestSnapshot();
    this.loadWeekAgoSnapshot();
    this.loadConfigRollups();

    // Push refresh: filter to events for this strategy id, throttle to 5s so
    // a chatty 60s-cadence worker can't pile up if the page sits open. The
    // payload carries the new HealthScore so we don't need a follow-up GET in
    // most cases — but we re-fetch anyway for the trade counts the gauge view
    // doesn't expose, keeping the snapshot source of truth one round-trip away.
    this.realtime
      .on<{ strategyId: number }>('strategyHealthSnapshotCreated')
      .pipe(
        filter((evt) => evt?.strategyId === this.strategyId),
        throttleTime(5_000, undefined, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.loadLatestSnapshot());
  }

  private fetchLineage(): void {
    this.loadingLineage.set(true);
    this.strategiesService.getLineage(this.strategyId).subscribe({
      next: (res) => {
        this.loadingLineage.set(false);
        this.lineage.set(res?.data ?? null);
      },
      error: () => {
        this.loadingLineage.set(false);
        this.lineage.set(null);
        this.notifications.error('Failed to load lineage');
      },
    });
  }

  private loadLatestSnapshot(): void {
    this.feedbackService.getPerformance(this.strategyId).subscribe({
      next: (res) => {
        if (res?.status && res.data) this.latestSnapshot.set(res.data);
      },
      error: () => {
        /* No snapshot yet is the common case for fresh strategies — silent. */
      },
    });
  }

  /**
   * Pull the most recent snapshot at-or-before 7 days ago. The query orders
   * desc and we only need one row, so a `to: 7d-ago` filter + page-size-1
   * does the job in a single round-trip — no client-side scan.
   */
  private loadWeekAgoSnapshot(): void {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.feedbackService
      .getSnapshotHistory(this.strategyId, {
        currentPage: 1,
        itemCountPerPage: 1,
        filter: { to: sevenDaysAgo },
      })
      .subscribe({
        next: (res) => {
          const row = res?.data?.data?.[0] ?? null;
          this.weekAgoSnapshot.set(row);
        },
        error: () => {
          /* Insufficient history yet — leave the delta chip hidden. */
        },
      });
  }

  goBack(): void {
    this.router.navigate(['/strategies']);
  }

  openAnalytics(): void {
    this.router.navigate(['/strategies', this.strategyId, 'analytics']);
  }

  formatJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  onActivate(): void {
    this.actionLoading.set(true);
    this.strategiesService.activate(this.strategyId).subscribe({
      next: (res) => {
        if (res.data) this.strategy.set(res.data);
        this.notifications.success('Strategy activated');
        this.actionLoading.set(false);
      },
      error: () => {
        this.notifications.error('Failed to activate strategy');
        this.actionLoading.set(false);
      },
    });
  }

  /**
   * Fired by `<app-promotion-readiness-card>` after a successful activation
   * from inside the Promotion tab. Re-fetches the parent strategy so the
   * detail header (Status pill, lifecycle stage) reflects the new state.
   */
  onPromotionActivated(): void {
    this.loadStrategy();
  }

  onPause(): void {
    this.actionLoading.set(true);
    this.strategiesService.pause(this.strategyId).subscribe({
      next: (res) => {
        if (res.data) this.strategy.set(res.data);
        this.notifications.success('Strategy paused');
        this.actionLoading.set(false);
      },
      error: () => {
        this.notifications.error('Failed to pause strategy');
        this.actionLoading.set(false);
      },
    });
  }

  onDelete(): void {
    this.deleteLoading.set(true);
    this.strategiesService.delete(this.strategyId).subscribe({
      next: () => {
        this.notifications.success('Strategy deleted');
        this.deleteLoading.set(false);
        this.showDeleteConfirm.set(false);
        this.router.navigate(['/strategies']);
      },
      error: () => {
        this.notifications.error('Failed to delete strategy');
        this.deleteLoading.set(false);
      },
    });
  }

  onUpdate(data: any): void {
    this.strategiesService.update(this.strategyId, data as UpdateStrategyRequest).subscribe({
      next: (res) => {
        if (res.data) this.strategy.set(res.data);
        this.notifications.success('Strategy updated');
        this.showEditForm.set(false);
      },
      error: () => this.notifications.error('Failed to update strategy'),
    });
  }

  onTriggerOptimization(): void {
    this.optimizationLoading.set(true);
    this.feedbackService.triggerOptimization({ strategyId: this.strategyId }).subscribe({
      next: () => {
        this.notifications.success('Optimization triggered');
        this.optimizationLoading.set(false);
        this.optimizationTable?.loadData();
      },
      error: () => {
        this.notifications.error('Failed to trigger optimization');
        this.optimizationLoading.set(false);
      },
    });
  }

  onApproveOptimization(id: number): void {
    this.feedbackService.approveOptimization(id).subscribe({
      next: () => {
        this.notifications.success('Optimization approved');
        this.optimizationTable?.loadData();
      },
      error: () => this.notifications.error('Failed to approve optimization'),
    });
  }

  onRejectOptimization(id: number): void {
    this.feedbackService.rejectOptimization(id).subscribe({
      next: () => {
        this.notifications.success('Optimization rejected');
        this.optimizationTable?.loadData();
      },
      error: () => this.notifications.error('Failed to reject optimization'),
    });
  }

  private loadStrategy(): void {
    this.strategiesService.getById(this.strategyId).subscribe({
      next: (res) => {
        if (res.data) {
          this.strategy.set(res.data);
        } else {
          this.loadError.set(true);
        }
      },
      error: () => this.loadError.set(true),
    });
  }

  // Cheap parallel roll-ups for the Config-tab KPI strip + recent feeds.
  // Each call asks for at most 8 rows so we read both the row sample for
  // the mini-tables AND the pager total count from one round-trip per kind.
  private loadConfigRollups(): void {
    const baseFilter = { strategyId: this.strategyId };

    this.signalsService
      .list({ currentPage: 1, itemCountPerPage: 8, filter: baseFilter })
      .subscribe({
        next: (res) => {
          this.totalSignals.set(res?.data?.pager?.totalItemCount ?? 0);
          this.recentSignals.set(res?.data?.data ?? []);
        },
        error: () => {
          this.totalSignals.set(0);
        },
      });

    this.ordersService.list({ currentPage: 1, itemCountPerPage: 8, filter: baseFilter }).subscribe({
      next: (res) => {
        this.totalOrders.set(res?.data?.pager?.totalItemCount ?? 0);
        this.recentOrders.set(res?.data?.data ?? []);
      },
      error: () => {
        this.totalOrders.set(0);
      },
    });

    this.feedbackService
      .listOptimizationRuns({ currentPage: 1, itemCountPerPage: 1, filter: baseFilter })
      .subscribe({
        next: (res) => {
          this.totalOptimizations.set(res?.data?.pager?.totalItemCount ?? 0);
        },
        error: () => {
          this.totalOptimizations.set(0);
        },
      });

    this.backtestsService
      .list({ currentPage: 1, itemCountPerPage: 1, filter: baseFilter })
      .subscribe({
        next: (res) => {
          this.totalBacktests.set(res?.data?.pager?.totalItemCount ?? 0);
        },
        error: () => {
          this.totalBacktests.set(0);
        },
      });

    this.walkForwardService
      .list({ currentPage: 1, itemCountPerPage: 1, filter: baseFilter })
      .subscribe({
        next: (res) => {
          this.totalWalkForwards.set(res?.data?.pager?.totalItemCount ?? 0);
        },
        error: () => {
          this.totalWalkForwards.set(0);
        },
      });
  }

  private getSignalStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Approved: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Executed: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }

  private getOrderStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Submitted: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      PartialFill: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Filled: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Cancelled: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }

  private getOptStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Queued: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
      Running: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Completed: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Failed: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Approved: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }
}
