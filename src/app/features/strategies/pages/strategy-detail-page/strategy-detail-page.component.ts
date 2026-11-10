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
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { distinctUntilChanged, filter, map, of, throttleTime } from 'rxjs';

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
  UpdateStrategyRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { readTabParam, tabQueryParam } from '../../util/tab-url';
import { fmtProfitFactor } from '@shared/utils/metric-format';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { PageContextService } from '@core/assistant/page-context.service';

import { StrategyFormComponent } from '../../components/strategy-form/strategy-form.component';
import { CloneStrategyDialogComponent } from '../../components/clone-strategy-dialog/clone-strategy-dialog.component';
import { SubmitForApprovalDialogComponent } from '../../components/submit-for-approval-dialog/submit-for-approval-dialog.component';
import { failureMessage } from '../../util/api-failure';
import { activationRefusalMessage, isDraftActivationRefusal } from '../../util/activation';
import { PromotionReadinessCardComponent } from '../../components/promotion-readiness-card/promotion-readiness-card.component';
import { PortfolioReadinessCardComponent } from '../../components/portfolio-readiness-card/portfolio-readiness-card.component';
import { PromotionGateHistoryCardComponent } from '../../components/promotion-gate-history-card/promotion-gate-history-card.component';
import { StrategyVariantsTabComponent } from '../../components/strategy-variants-tab/strategy-variants-tab.component';
import { StrategyCapacityCardComponent } from '../../components/strategy-capacity-card/strategy-capacity-card.component';
import { StrategyPromotionReviewsTabComponent } from '../../components/strategy-promotion-reviews-tab/strategy-promotion-reviews-tab.component';
import { RejectionDistributionDrawerComponent } from '../../components/rejection-distribution-drawer/rejection-distribution-drawer.component';
import { StrategyActivityContextComponent } from '../../components/strategy-activity-context/strategy-activity-context.component';
import { StrategyTabContextComponent } from '../../components/strategy-tab-context/strategy-tab-context.component';
import { isSentinelName } from '../../components/strategy-tab-context/strategy-tab-context.logic';
import { RationaleInlineComponent } from '@features/llm/components/rationale-inline/rationale-inline.component';
// ADR-0027 script strategies: execution (bindings + policy), live session, alerts, backtests.
import { StrategyExecutionPanelComponent } from '@features/scripting/execution/strategy-execution-panel.component';
import { ScriptLivePanelComponent } from '@features/scripting/live/script-live-panel.component';
import { ScriptAlertsTabComponent } from '@features/scripting/alerts/script-alerts-tab.component';
import { isPortfolioStrategy, isScriptStrategy } from '@features/scripting/shared/script-strategy';
import { StrategyExecutionCardComponent } from '@features/execution/components/strategy-execution-card.component';
import { isNewsBlackoutExempt } from '@features/scripting/execution/news-blackout-exemption.model';
import { OptimizationWorkbenchComponent } from '@features/scripting/research/optimization-workbench.component';
import { WalkForwardWorkbenchComponent } from '@features/scripting/research/walk-forward-workbench.component';
import { ResearchCockpitComponent } from '../../research-cockpit/research-cockpit.component';
import { StrategySignalsGridComponent } from '../../components/strategy-activity-tabs/strategy-signals-grid.component';
import { StrategyOrdersGridComponent } from '../../components/strategy-activity-tabs/strategy-orders-grid.component';
import { StrategyBacktestsTabComponent } from '../../components/strategy-backtests-tab/strategy-backtests-tab.component';
import { StrategyLineageTabComponent } from '../../components/strategy-lineage-tab/strategy-lineage-tab.component';
import { StrategyConfigTabComponent } from '../../components/strategy-config-tab/strategy-config-tab.component';
import type { ChecklistAction } from '@features/scripting/onboarding/first-strategy-checklist';
import { AuthService } from '@core/auth/auth.service';
import { OPERATOR_PERMISSION } from '@features/scripting/shared/permissions';
import {
  ScriptDialogService,
  confirmDiscard,
} from '@features/scripting/shared/script-dialog.service';
import {
  warnBeforeUnload,
  type HasUnsavedChanges,
} from '@features/scripting/shared/unsaved-changes';

@Component({
  selector: 'app-strategy-detail-page',
  standalone: true,
  imports: [
    StrategyExecutionCardComponent,
    PageHeaderComponent,
    PresenceBadgeComponent,
    StatusBadgeComponent,
    ConfirmDialogComponent,
    GaugeComponent,
    TabsComponent,
    RelativeTimePipe,
    StrategyFormComponent,
    CloneStrategyDialogComponent,
    SubmitForApprovalDialogComponent,
    PromotionReadinessCardComponent,
    PortfolioReadinessCardComponent,
    PromotionGateHistoryCardComponent,
    StrategyVariantsTabComponent,
    StrategyCapacityCardComponent,
    StrategyPromotionReviewsTabComponent,
    RejectionDistributionDrawerComponent,
    StrategyActivityContextComponent,
    StrategyTabContextComponent,
    RationaleInlineComponent,
    StrategyExecutionPanelComponent,
    ScriptLivePanelComponent,
    ScriptAlertsTabComponent,
    StrategyConfigTabComponent,
    OptimizationWorkbenchComponent,
    WalkForwardWorkbenchComponent,
    ResearchCockpitComponent,
    StrategyLineageTabComponent,
    StrategySignalsGridComponent,
    StrategyOrdersGridComponent,
    StrategyBacktestsTabComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (strategy()) {
        <app-page-header [title]="strategy()!.name ?? ''" [subtitle]="headerSubtitle()">
          <span slot="title-after" class="head-chips">
            <app-status-badge [status]="strategy()!.status" type="strategy" />
            @if (strategy()!.lifecycleStage; as stage) {
              <span class="stage-chip" title="Lifecycle stage">
                <app-status-badge [status]="stage" type="lifecycle" />
              </span>
            }
            @if (newsBlackoutExempt()) {
              <button
                type="button"
                class="exempt-chip"
                data-testid="news-blackout-exempt-badge"
                title="Exempt from the engine's high-impact news blackout: its live, paper and backtest entries are let through inside the window (an audited opt-out). Manage it on the Execution tab."
                (click)="openExecutionTab()"
              >
                News-blackout exempt
              </button>
            }
            <app-presence-badge [routeKey]="'strategy:' + strategyId" />
          </span>
          <!-- The shared header keeps its actions on one unshrinkable row; a script strategy's
               eight buttons pushed the page to 1,608px at a 1,440px window and squeezed the title
               and description into a 160px column. They wrap here instead. -->
          <div class="detail-actions">
            @if (canSubmitForApproval()) {
              <button
                type="button"
                class="btn btn-primary"
                (click)="openApproval()"
                title="Run the promotion gates; on a pass the strategy moves to Approved and paper-trades"
              >
                Submit for approval
              </button>
            }
            @if (canStartPaperTrading()) {
              <button
                type="button"
                class="btn btn-secondary"
                data-testid="start-paper-trading"
                (click)="onStartPaperTrading()"
                [disabled]="actionLoading()"
                title="Paper-trade this script before approval: its trades are recorded as paper executions and nothing is sent to an account"
              >
                Start paper trading
              </button>
            }
            @if (isPaperOnlyStage()) {
              <button
                type="button"
                class="btn btn-secondary"
                data-testid="stop-paper-trading"
                (click)="onStopPaperTrading()"
                [disabled]="actionLoading()"
                title="Stop paper trading: the strategy goes back to Draft; its paper executions are kept"
              >
                Stop paper trading
              </button>
            }
            @if (strategy()!.status === 'Paused' || strategy()!.status === 'Stopped') {
              <button class="btn btn-success" (click)="onActivate()" [disabled]="actionLoading()">
                Activate
              </button>
            }
            @if (strategy()!.status === 'Active') {
              <button class="btn btn-warning" (click)="onPause()" [disabled]="actionLoading()">
                Pause
              </button>
            }
            <!-- PE-I13: the engine refuses edits without operator access. -->
            <button
              class="btn btn-secondary"
              (click)="openEdit()"
              [disabled]="!canOperate()"
              [title]="canOperate() ? 'Edit this strategy' : 'Editing needs operator access'"
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              (click)="cloneTarget.set(strategy())"
              title="Copy this strategy onto another symbol or timeframe as a Paused draft"
            >
              Clone…
            </button>
            <button class="btn btn-secondary" (click)="openAnalytics()">Open analytics →</button>
            <button
              type="button"
              class="btn btn-secondary"
              (click)="showRejectionDrawer.set(true)"
              title="Show per-gate signal-rejection counts for this strategy"
            >
              Why no signals?
            </button>
            <button
              class="btn btn-secondary btn-danger-text"
              (click)="showDeleteConfirm.set(true)"
              title="Delete this strategy"
            >
              Delete
            </button>
            <button class="btn btn-ghost" (click)="goBack()">← Back</button>
          </div>
        </app-page-header>

        <!--
          LLM-authored rationale for the strategy's most recent activation
          event. Hides itself when no rationale is attached. Operators
          looking for older / different event-type rationales can click
          through to /llm/rationales filtered by EventId=strategyId.
        -->
        <app-rationale-inline eventType="StrategyActivated" [eventId]="strategyId" />

        @if (activationHint(); as hint) {
          <div class="activation-hint" role="alert">
            <span>{{ hint }}</span>
            @if (canSubmitForApproval()) {
              <button type="button" class="btn btn-primary" (click)="openApproval()">
                Submit for approval
              </button>
            }
            <button
              type="button"
              class="btn btn-ghost"
              (click)="activationHint.set(null)"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        }

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
                <dd>{{ fmtProfitFactor(s.profitFactor, 2, s.windowTrades > 0) }}</dd>
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

        <!-- PE-14: a tab switch asks first when the tab being left holds unsaved changes. -->
        <ui-tabs
          [tabs]="visibleDetailTabs()"
          [activeTab]="activeTab()"
          (tabChange)="requestTab($event)"
        >
          <!-- Config Tab -->
          @if (activeTab() === 'config' && strategy(); as s) {
            <!-- U13 (fu-ui): the Config tab is a lazy child; the page still loads its counts and recent rows. -->
            @defer (on immediate) {
              <app-strategy-config-tab
                [strategy]="s"
                [isScript]="isScript()"
                [totalSignals]="totalSignals()"
                [totalOrders]="totalOrders()"
                [totalOptimizations]="totalOptimizations()"
                [totalBacktests]="totalBacktests()"
                [totalWalkForwards]="totalWalkForwards()"
                [recentSignals]="recentSignals()"
                [recentOrders]="recentOrders()"
                [canOperate]="canOperate()"
                [canStartPaper]="canStartPaperTrading()"
                (openTab)="activeTab.set($event)"
                (checklistAction)="onChecklistAction($event)"
                (editRequested)="openEdit()"
                (executionRequested)="openExecutionTab()"
              />
            } @loading (minimum 150ms) {
              <p class="muted small"><span class="spinner"></span> Loading…</p>
            }
          }

          <!-- Promotion Tab — live evaluation of every PromotionGateValidator
               check (paper-trade duration, adversarial robustness, edge posterior,
               CPCV, TCA, correlation). Shows the breakdown the engine would emit
               on activation, with a paper-gate bypass toggle for hand-promoted
               strategies that have no PaperExecution history yet. -->
          @if (activeTab() === 'promotion' && strategy()) {
            @if (!isSentinel()) {
              <div class="promotion-stack">
                <!-- b11-portfolio-hardening: a //@lascodia-portfolio strategy's readiness to leave Paper / be activated. -->
                @if (isPortfolio()) {
                  <app-portfolio-readiness-card
                    [strategyId]="strategy()!.id"
                    [portfolioWalkForwardRunId]="portfolioWalkForwardRunId()"
                  />
                }
                <app-promotion-readiness-card
                  [strategyId]="strategy()!.id"
                  (activated)="onPromotionActivated()"
                />
                <!-- …and what the engine ACTUALLY decided, attempt by attempt. The card above
                   re-evaluates live, which cannot show a budget timeout or an evidence-unchanged
                   skip — the two outcomes that leave a Draft stuck with no verdict against it. -->
                <app-promotion-gate-history-card [strategyId]="strategy()!.id" />
              </div>
            }
            <app-strategy-tab-context
              [strategy]="strategy()!"
              tab="promotion"
              [embedded]="true"
              (openTab)="onContextTab($event)"
            />
          }

          <!-- Signals Tab -->
          @if (activeTab() === 'signals') {
            <!-- A strategy that never signalled gets the reasons, not an empty grid. -->
            @if (totalSignals() === 0 && strategy(); as s) {
              <app-strategy-activity-context
                [strategy]="s"
                lead="No signals generated yet"
                [embedded]="true"
                (openTab)="onContextTab($event)"
              />
            } @else {
              <app-strategy-signals-grid
                [strategyId]="strategyId"
                [currentHash]="$any(strategy())?.strategyConfigHash ?? null"
              />
            }
          }

          <!-- Orders Tab -->
          @if (activeTab() === 'orders') {
            @if (totalOrders() === 0 && strategy(); as s) {
              <app-strategy-activity-context
                [strategy]="s"
                [lead]="
                  (totalSignals() ?? 0) > 0
                    ? 'No orders placed yet — ' +
                      totalSignals() +
                      ' signal(s), none reached an account'
                    : 'No orders placed yet'
                "
                [embedded]="true"
                (openTab)="onContextTab($event)"
              />
            } @else {
              <app-strategy-orders-grid [strategyId]="strategyId" />
            }
          }

          <!-- Optimization Tab — PE-I4 workbench: search space, runs, results, heatmap, trial ledger. -->
          @if (activeTab() === 'optimization') {
            @if (!isSentinel()) {
              <app-optimization-workbench [strategy]="strategy()!" />
            }
            <app-strategy-tab-context
              [strategy]="strategy()!"
              tab="optimization"
              [embedded]="true"
              (openTab)="onContextTab($event)"
            />
          }

          <!-- Backtests Tab — runs filtered to this strategy. Click-through
               navigates to the backtest detail page (same view the global
               Backtests page links to). -->
          @if (activeTab() === 'backtests') {
            @if (!isSentinel()) {
              <app-strategy-backtests-tab [strategy]="strategy()!" [isScript]="isScript()" />
            }
            <app-strategy-tab-context
              [strategy]="strategy()!"
              tab="backtests"
              [embedded]="true"
              (openTab)="onContextTab($event)"
            />
          }

          <!-- Research Tab — U12 cockpit: validation pipeline, lineage holdout, stitched OOS, live evidence, lab import.
               Deferred: none of it loads until the tab opens. -->
          @if (activeTab() === 'research' && !isSentinel()) {
            @defer (on immediate) {
              <app-research-cockpit
                [strategyId]="strategyId"
                [symbol]="strategy()?.symbol ?? null"
                [currentHash]="$any(strategy())?.strategyConfigHash ?? null"
              />
            } @loading (minimum 150ms) {
              <p class="muted small"><span class="spinner"></span> Loading the research cockpit…</p>
            }
          }

          <!-- Walk-Forward Tab — BT-I5 workbench: launcher, runs, stitched OOS analysis, Monte Carlo. -->
          @if (activeTab() === 'walkforward') {
            @if (!isSentinel()) {
              <app-walk-forward-workbench [strategy]="strategy()!" />
            }
            <app-strategy-tab-context
              [strategy]="strategy()!"
              tab="walkforward"
              [embedded]="true"
              (openTab)="onContextTab($event)"
            />
          }

          <!-- Variants Tab — A/B shadow tests attached to this base strategy. -->
          @if (activeTab() === 'variants') {
            @if (!isSentinel()) {
              <app-strategy-variants-tab [strategyId]="strategyId" />
            }
            @if (strategy()) {
              <app-strategy-tab-context
                [strategy]="strategy()!"
                tab="variants"
                [embedded]="true"
                (openTab)="onContextTab($event)"
              />
            }
          }

          <!-- Capacity Profile Tab — AUM-vs-Sharpe sweep with sizing guidance. -->
          @if (activeTab() === 'capacity') {
            <app-strategy-capacity-card [strategyId]="strategyId" />
            <!-- Gaps program (execution): how this strategy's orders are executed. -->
            <app-strategy-execution-card
              [strategyId]="strategyId"
              [current]="$any(strategy())?.executionAlgorithm"
              [currentParamsJson]="$any(strategy())?.executionAlgoParamsJson"
              [isScript]="isScript()"
            />
            @if (strategy()) {
              <app-strategy-tab-context
                [strategy]="strategy()!"
                tab="capacity"
                [embedded]="true"
                (openTab)="onContextTab($event)"
              />
            }
          }

          <!-- Promotion Reviews Tab — bull/bear/judge advisory pipeline output. -->
          @if (activeTab() === 'reviews') {
            <app-strategy-promotion-reviews-tab [strategyId]="strategyId" />
            @if (strategy()) {
              <app-strategy-tab-context
                [strategy]="strategy()!"
                tab="reviews"
                [embedded]="true"
                (openTab)="onContextTab($event)"
              />
            }
          }

          <!-- Lineage Tab — parent/child tree centred on this strategy. -->
          @if (activeTab() === 'lineage') {
            @defer (on immediate) {
              <app-strategy-lineage-tab [strategyId]="strategyId" />
            } @loading (minimum 150ms) {
              <p class="muted">Loading lineage…</p>
            }
            @if (strategy()) {
              <app-strategy-tab-context
                [strategy]="strategy()!"
                tab="lineage"
                [embedded]="true"
                (openTab)="onContextTab($event)"
              />
            }
          }

          <!-- Execution Tab (every strategy type) — account bindings and execution policy
               (ADR-0027 DEC-05 / DEC-06). -->
          @if (activeTab() === 'execution') {
            <app-strategy-execution-panel
              [strategy]="strategy()"
              (changed)="onExecutionChanged()"
            />
          }

          <!-- Live Tab (script strategies) — the live session's emulator state, divergences
               from the bound accounts and the live Strategy report. Deferred: the panel and the
               report are fetched when the tab opens, not with the strategies route. -->
          @if (activeTab() === 'live' && isScript()) {
            @defer (on immediate) {
              <app-script-live-panel
                [strategyId]="strategyId"
                [symbol]="strategy()?.symbol ?? null"
                [timeframe]="strategy()?.timeframe ?? null"
                [lifecycleStage]="strategy()?.lifecycleStage ?? null"
                [lifecycleStageEnteredAt]="strategy()?.lifecycleStageEnteredAt ?? null"
              />
            } @loading (minimum 150ms) {
              <p class="muted small"><span class="spinner"></span> Loading the live session…</p>
            }
          }

          <!-- Alerts Tab (script strategies) — alertcondition / alert() / order-fill bindings. -->
          @if (activeTab() === 'alerts' && isScript()) {
            <app-script-alerts-tab [strategy]="strategy()!" />
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
        [saving]="updateSaving()"
        [submitError]="updateError()"
        (submitted)="onUpdate($event)"
        (cancelled)="closeEdit()"
        (strategyChanged)="loadStrategy()"
        (executionRequested)="openExecutionTab()"
        (pageRequested)="openEditPage()"
      />

      <!-- Always in the template: an evaluation keeps running (and reports back) after the
           operator closes the dialog. -->
      <app-submit-for-approval-dialog
        [strategy]="approvalTarget()"
        (closed)="approvalTarget.set(null)"
        (changed)="onApprovalChanged($event)"
        (historyRequested)="openPromotionHistory()"
      />

      <app-clone-strategy-dialog [strategy]="cloneTarget()" (closed)="cloneTarget.set(null)" />

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

      /* Readiness card then attempt history, as one column with consistent spacing. */
      .promotion-stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
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
        grid-template-columns: repeat(auto-fit, minmax(min(110px, 100%), 1fr));
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

      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-danger-text {
        color: var(--loss);
      }
      .head-chips {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .detail-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        align-items: center;
        gap: var(--space-2);
        max-width: min(640px, 55vw);
      }
      .stage-chip {
        display: inline-flex;
      }
      .exempt-chip {
        display: inline-flex;
        align-items: center;
        height: 22px;
        padding: 0 10px;
        border-radius: var(--radius-full);
        border: 1px solid rgba(255, 149, 0, 0.55);
        background: rgba(255, 149, 0, 0.12);
        color: var(--warning);
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
        cursor: pointer;
      }
      .exempt-chip:hover {
        background: rgba(255, 149, 0, 0.2);
      }
      .exempt-chip:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .activation-hint {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin: 0 0 var(--space-4);
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        border: 1px solid rgba(255, 149, 0, 0.4);
        background: rgba(255, 149, 0, 0.08);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .activation-hint > span {
        flex: 1;
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

      .action-bar {
        display: flex;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }

      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 0;
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
    `,
  ],
})
export class StrategyDetailPageComponent implements OnInit, HasUnsavedChanges {
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

  /** Refreshed when the script launcher queues a run, so the new row shows at once. */

  private readonly pageContext = inject(PageContextService);

  constructor() {
    this.pageContext.publish(() => {
      const st = this.strategy();
      return {
        headline: st
          ? `Strategy #${st.id} — ${st.name} (${st.symbol} ${st.timeframe}), ${st.status}`
          : 'Strategy detail (loading)',
        record: { kind: 'strategy', id: st?.id ?? 0, label: st?.name ?? undefined },
        filters: { tab: this.activeTab() },
        figures: {
          status: st?.status ?? null,
          symbol: st?.symbol ?? null,
          timeframe: st?.timeframe ?? null,
          strategyType: st?.strategyType ?? null,
          riskProfileId: st?.riskProfileId ?? null,
        },
      };
    });
  }

  strategy = signal<StrategyDto | null>(null);
  loadError = signal(false);
  activeTab = signal('config');
  actionLoading = signal(false);
  showDeleteConfirm = signal(false);
  deleteLoading = signal(false);
  showEditForm = signal(false);
  /** The edit form's update request is in flight. */
  updateSaving = signal(false);
  /** Why the engine refused the last update; shown inside the still-open form. */
  updateError = signal<string | null>(null);
  /** Strategy whose clone dialog is open (this one); null when closed. */
  cloneTarget = signal<StrategyDto | null>(null);
  /** The Draft whose "Submit for approval" dialog is open. */
  readonly approvalTarget = signal<StrategyDto | null>(null);
  /** Why the last activation was refused, shown under the header until dismissed. */
  readonly activationHint = signal<string | null>(null);
  showRejectionDrawer = signal(false);

  // Config-tab roll-up signals: lifetime counters and last-N feeds.
  // null while loading; numeric value once the count comes back.
  totalSignals = signal<number | null>(null);
  totalOrders = signal<number | null>(null);
  totalOptimizations = signal<number | null>(null);
  totalBacktests = signal<number | null>(null);
  totalWalkForwards = signal<number | null>(null);
  recentSignals = signal<any[]>([]);
  recentOrders = signal<any[]>([]);

  /**
   * U06: the tab on show is written back to `?tab=` (replaceUrl — one history entry per page, not
   * per click), so a reload or a shared link reopens it. The default tab is the bare URL.
   */
  private readonly tabUrlSync = effect(() => {
    const tab = this.activeTab();
    untracked(() => this.writeTabToUrl(tab));
  });

  private writeTabToUrl(tab: string): void {
    const want = tabQueryParam(tab);
    const current = this.route.snapshot?.queryParamMap?.get('tab') ?? null;
    if (current === want) return;
    try {
      void this.router
        .navigate([], {
          relativeTo: this.route,
          queryParams: { tab: want },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        })
        .catch(() => undefined);
    } catch {
      /* a router without this route (tests) — the URL simply is not updated */
    }
  }

  // Exposed for template `[class.profit]="String(...)"` checks.
  readonly String = String;

  protected strategyId!: number;

  /** PF 9999 = no losing trades → "∞" (U04). */
  protected readonly fmtProfitFactor = fmtProfitFactor;

  readonly detailTabs: TabItem[] = [
    { label: 'Config', value: 'config' },
    { label: 'Promotion', value: 'promotion' },
    { label: 'Signals', value: 'signals' },
    { label: 'Orders', value: 'orders' },
    { label: 'Execution', value: 'execution' },
    { label: 'Live', value: 'live' },
    { label: 'Alerts', value: 'alerts' },
    { label: 'Optimization', value: 'optimization' },
    { label: 'Backtests', value: 'backtests' },
    { label: 'Walk-Forward', value: 'walkforward' },
    { label: 'Research', value: 'research' },
    { label: 'Variants', value: 'variants' },
    { label: 'Capacity', value: 'capacity' },
    { label: 'Reviews', value: 'reviews' },
    { label: 'Lineage', value: 'lineage' },
  ];

  // ── ADR-0027 script strategies ─────────────────────────────────────────
  /** Pine-script strategy (authoringMode Script): shows the Live and Alerts tabs. */
  readonly isScript = computed(() => isScriptStrategy(this.strategy()));
  /** b11-portfolio-hardening: a `//@lascodia-portfolio` script listing more than one symbol. */
  readonly isPortfolio = computed(() => isPortfolioStrategy(this.strategy()));
  /** `portfolioWalkForwardRunId` as the engine sent it: undefined when this build does not send the field. */
  readonly portfolioWalkForwardRunId = computed<number | null | undefined>(() => {
    const s = this.strategy();
    return s && 'portfolioWalkForwardRunId' in s ? (s.portfolioWalkForwardRunId ?? null) : undefined;
  });
  /** A script strategy holding the audited news-blackout exemption: badged in the header. */
  readonly newsBlackoutExempt = computed(() => isNewsBlackoutExempt(this.strategy()));
  private static readonly SCRIPT_ONLY_TABS: readonly string[] = ['live', 'alerts'];
  readonly visibleDetailTabs = computed<TabItem[]>(() =>
    this.isScript()
      ? this.detailTabs
      : this.detailTabs.filter(
          (t) => !StrategyDetailPageComponent.SCRIPT_ONLY_TABS.includes(t.value),
        ),
  );

  /** Bindings or execution policy changed: re-read the strategy. */
  onExecutionChanged(): void {
    this.loadStrategy();
  }

  /** The execution policy and the account bindings are changed on the Execution tab. */
  /** Sentinel strategies (LLM Spot Analysis, Manual Trades, …) have no rules: their evidence tabs do not apply. */
  readonly isSentinel = computed(() => isSentinelName(this.strategy()?.name));

  /** A reason in the activity context asked for a tab; "rejections" is the per-gate drawer here. */
  onContextTab(tab: string): void {
    if (tab === 'rejections') this.showRejectionDrawer.set(true);
    else this.requestTab(tab);
  }

  openExecutionTab(): void {
    this.showEditForm.set(false);
    this.updateError.set(null);
    this.requestTab('execution');
  }

  // ── PE-14: unsaved changes on a tab / PE-I13: operator access ───────────
  private readonly auth = inject(AuthService);
  private readonly dialogs = inject(ScriptDialogService);
  /** The engine requires operator access to edit a strategy (and to change its execution). */
  readonly canOperate = computed(() => this.auth.hasPermission(OPERATOR_PERMISSION));

  @ViewChild(TabsComponent) private tabsBar?: TabsComponent;
  @ViewChild(StrategyFormComponent) private editForm?: StrategyFormComponent;
  @ViewChild(StrategyExecutionPanelComponent)
  private executionPanel?: StrategyExecutionPanelComponent;
  @ViewChild(ScriptAlertsTabComponent) private alertsTab?: ScriptAlertsTabComponent;

  /** A tab switch is waiting for the operator's answer. */
  private tabQuestionOpen = false;

  // Closing or reloading the browser tab with a tab's edit unsaved asks the browser's question
  // (the edit form registers its own).
  private readonly unloadGuard = warnBeforeUnload(() => this.tabUnsavedNote() !== null);

  /** What the tab on show holds unsaved, in the operator's words; null when nothing. */
  tabUnsavedNote(): string | null {
    switch (this.activeTab()) {
      case 'execution':
        return this.executionPanel?.hasUnsavedChanges()
          ? 'The account-binding or news-blackout changes on the Execution tab are not saved'
          : null;
      case 'alerts':
        return this.alertsTab?.dirty() ? 'The alert changes on the Alerts tab are not saved' : null;
      default:
        return null;
    }
  }

  /**
   * Show another tab. Leaving one with unsaved changes asks first; "Keep editing" stays put (and
   * puts the tab bar back on the tab being kept).
   */
  requestTab(tab: string): void {
    if (tab === this.activeTab()) return;
    const unsaved = this.tabUnsavedNote();
    if (!unsaved) {
      this.activeTab.set(tab);
      return;
    }
    void this.confirmTabSwitch(tab, unsaved);
  }

  private async confirmTabSwitch(tab: string, unsaved: string): Promise<void> {
    // The tab bar already shows the clicked tab; it shows the kept one again unless discarded.
    this.tabsBar?.activeTab.set(this.activeTab());
    if (this.tabQuestionOpen) return;
    this.tabQuestionOpen = true;
    try {
      if (await confirmDiscard(this.dialogs, unsaved)) this.activeTab.set(tab);
      // Kept: a `?tab=` change that asked must not leave the URL naming the other tab.
      else this.writeTabToUrl(this.activeTab());
    } finally {
      this.tabQuestionOpen = false;
    }
  }

  /** PE-I9: a checklist step's action — the editor, a tab, or starting paper trading. */
  onChecklistAction(action: ChecklistAction): void {
    switch (action) {
      case 'edit':
        this.openEdit();
        break;
      case 'backtests':
        this.requestTab('backtests');
        break;
      case 'execution':
        this.openExecutionTab();
        break;
      case 'paper':
        if (this.canStartPaperTrading()) this.onStartPaperTrading();
        break;
    }
  }

  /** The route guard asks before leaving with an unsaved edit (the edit form, or a tab's). */
  hasUnsavedChanges(): boolean {
    return (this.editForm?.hasUnsavedChanges() ?? false) || this.tabUnsavedNote() !== null;
  }

  unsavedChangesNote(): string {
    if (this.editForm?.hasUnsavedChanges()) return this.editForm.unsavedChangesNote();
    return this.tabUnsavedNote() ?? 'This page has unsaved changes';
  }

  // ── Submit for approval (ADR-0027 DEC-10) ────────────────────────────────
  /** A Draft, or a script in its paper-only stage (submitted from there the same way). */
  readonly canSubmitForApproval = computed(() => {
    const stage = this.strategy()?.lifecycleStage;
    return stage === 'Draft' || (stage === 'PaperTrading' && this.isScript());
  });

  // ── Paper-only stage for script strategies ───────────────────────────────
  /** A Paused Draft script can paper-trade before approval (no gates: nothing reaches an account). */
  readonly canStartPaperTrading = computed(() => {
    const s = this.strategy();
    return !!s && this.isScript() && s.lifecycleStage === 'Draft' && s.status === 'Paused';
  });

  /** The script is in its paper-only stage (PaperTrading). */
  readonly isPaperOnlyStage = computed(
    () => this.isScript() && this.strategy()?.lifecycleStage === 'PaperTrading',
  );

  /** `PUT strategy/{id}/start-paper-trading`: Draft → PaperTrading. */
  onStartPaperTrading(): void {
    this.setPaperTrading(true);
  }

  /** `PUT strategy/{id}/stop-paper-trading`: PaperTrading → Draft. */
  onStopPaperTrading(): void {
    this.setPaperTrading(false);
  }

  /** The engine answers the new stage's name, not the strategy, and refuses with `status: false` — re-read on success. */
  private setPaperTrading(start: boolean): void {
    this.actionLoading.set(true);
    this.activationHint.set(null);
    const call = start
      ? this.strategiesService.startPaperTrading(this.strategyId, { silent: true })
      : this.strategiesService.stopPaperTrading(this.strategyId, { silent: true });
    call.subscribe({
      next: (res) => {
        this.actionLoading.set(false);
        if (!res?.status) {
          this.notifications.error(
            failureMessage(
              res,
              start
                ? 'The engine did not start paper trading.'
                : 'The engine did not stop paper trading.',
            ),
          );
          return;
        }
        this.notifications.success(
          start
            ? 'Paper trading — the script’s trades are recorded as paper executions; nothing is sent to an account'
            : 'Paper trading stopped — the strategy is a Draft again',
        );
        this.loadStrategy();
      },
      error: (err) => {
        this.actionLoading.set(false);
        this.notifications.error(
          failureMessage(
            err,
            start ? 'Starting paper trading failed.' : 'Stopping paper trading failed.',
          ),
        );
      },
    });
  }

  openApproval(): void {
    this.activationHint.set(null);
    this.approvalTarget.set(this.strategy());
  }

  /** A verdict landed: the lifecycle stage may have moved (Draft → Approved). */
  onApprovalChanged(strategyId: number): void {
    if (strategyId === this.strategyId) this.loadStrategy();
  }

  /** The Promotion tab's gate history records every evaluation, including a lost response's. */
  openPromotionHistory(): void {
    this.approvalTarget.set(null);
    this.requestTab('promotion');
  }

  // Engine `PagerRequestWithFilterType<TFilter,...>` setters reject any
  // bare-string `filter` value with HTTP 400 (System.Text.Json can't bind a
  // string to TFilter). Pass an object that matches the per-controller
  // filter shape — `{ strategyId }` is a first-class field on the trade-
  // signal, optimization, and (post-engine-update) order filters.

  ngOnInit(): void {
    // Follow the route, not just its first snapshot: Angular reuses this
    // component when only :id changes (a clone opening, a lineage link), and
    // reading the snapshot once left the page showing the previous strategy.
    (this.route.paramMap ?? of(this.route.snapshot.paramMap))
      .pipe(
        map((p) => Number(p.get('id'))),
        filter((id) => Number.isFinite(id) && id > 0),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => this.showStrategy(id));

    // `?tab=` opens a tab directly — the full-page editor sends the operator to Execution — and
    // follows later changes to it (a link to another tab of this page reuses the component).
    const known = this.detailTabs.map((t) => t.value);
    const tab = readTabParam(this.route.snapshot?.queryParamMap?.get('tab'), known);
    if (tab) this.activeTab.set(tab);
    this.route.queryParamMap
      ?.pipe(
        map((q) => readTabParam(q.get('tab'), known) ?? 'config'),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((t) => {
        if (t !== this.activeTab()) this.requestTab(t);
      });

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

  /** Loads the page for strategy `id` — first visit, or a move to another strategy. */
  private showStrategy(id: number): void {
    const switching = this.strategyId !== undefined && this.strategyId !== id;
    this.strategyId = id;
    if (switching) {
      // Clearing the strategy tears down the tabbed body, so every table and
      // card in it re-initialises against the new id.
      this.strategy.set(null);
      this.loadError.set(false);
      this.latestSnapshot.set(null);
      this.weekAgoSnapshot.set(null);
      this.totalSignals.set(null);
      this.totalOrders.set(null);
      this.totalOptimizations.set(null);
      this.totalBacktests.set(null);
      this.totalWalkForwards.set(null);
      this.recentSignals.set([]);
      this.recentOrders.set([]);
      this.showEditForm.set(false);
      this.showDeleteConfirm.set(false);
      this.showRejectionDrawer.set(false);
      this.cloneTarget.set(null);
      this.approvalTarget.set(null);
      this.activationHint.set(null);
      this.updateError.set(null);
      this.activeTab.set('config');
    }
    this.loadStrategy();
    this.loadLatestSnapshot();
    this.loadWeekAgoSnapshot();
    this.loadConfigRollups();
  }

  openEdit(): void {
    if (!this.canOperate()) return;
    this.updateError.set(null);
    this.showEditForm.set(true);
  }

  /** Continue editing on the full page (/strategies/:id/edit). */
  openEditPage(): void {
    this.showEditForm.set(false);
    this.router.navigate(['/strategies', this.strategyId, 'edit']);
  }

  closeEdit(): void {
    if (this.updateSaving()) return;
    this.showEditForm.set(false);
    this.updateError.set(null);
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

  /** Header sub-line: symbol · timeframe · description, skipping whatever is blank. */
  readonly headerSubtitle = computed(() => {
    const s = this.strategy();
    if (!s) return '';
    return [
      s.symbol,
      s.timeframe ? this.enumLabel.transform(s.timeframe, 'timeframe') : null,
      s.description,
    ]
      .filter((v): v is string => !!v && v.trim().length > 0)
      .join(' · ');
  });


  /**
   * `PUT strategy/{id}/activate`. The engine answers `data: "Activated"` (not the strategy), and
   * refuses with HTTP 200 + `status: false` — a Draft's refusal points at Submit for approval.
   */
  onActivate(): void {
    this.actionLoading.set(true);
    this.activationHint.set(null);
    this.strategiesService.activate(this.strategyId, false, { silent: true }).subscribe({
      next: (res) => {
        this.actionLoading.set(false);
        if (!res?.status) {
          this.refuseActivation(failureMessage(res, 'The engine did not activate the strategy.'));
          return;
        }
        this.notifications.success('Strategy activated');
        this.loadStrategy();
      },
      error: (err) => {
        this.actionLoading.set(false);
        this.refuseActivation(failureMessage(err, 'Activating the strategy failed.'));
      },
    });
  }

  /** Says why activation was refused; a Draft also gets the banner with "Submit for approval". */
  private refuseActivation(reason: string): void {
    const stage = this.strategy()?.lifecycleStage ?? null;
    const message = activationRefusalMessage(reason, stage);
    this.notifications.error(message);
    if (isDraftActivationRefusal(reason, stage)) {
      this.activationHint.set(message);
    }
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
        this.actionLoading.set(false);
        if (!res?.status) {
          this.notifications.error(failureMessage(res, 'The engine did not pause the strategy.'));
          return;
        }
        // The engine answers `data: "Paused"`, not the strategy — re-read it.
        this.notifications.success('Strategy paused');
        this.loadStrategy();
      },
      error: () => {
        this.notifications.error('Failed to pause strategy');
        this.actionLoading.set(false);
      },
    });
  }

  /**
   * The engine refuses with HTTP 200 + `status: false` — e.g. a script strategy that still holds
   * positions its live session manages (D131) — so the answer is read, not just the transport.
   */
  onDelete(): void {
    this.deleteLoading.set(true);
    this.strategiesService.delete(this.strategyId, { silent: true }).subscribe({
      next: (res) => {
        this.deleteLoading.set(false);
        if (!res?.status) {
          this.showDeleteConfirm.set(false);
          this.notifications.error(failureMessage(res, 'The engine did not delete the strategy.'));
          return;
        }
        this.notifications.success('Strategy deleted');
        this.showDeleteConfirm.set(false);
        this.router.navigate(['/strategies']);
      },
      error: (err) => {
        this.notifications.error(failureMessage(err, 'Failed to delete strategy'));
        this.deleteLoading.set(false);
      },
    });
  }

  /**
   * Saves the edit form. A refusal — HTTP 200 with `status: false` (an
   * immutable field, invalid rules) or an HTTP 400 — keeps the form open with
   * the engine's reason; it used to report success and close.
   */
  onUpdate(data: any): void {
    this.updateSaving.set(true);
    this.updateError.set(null);
    this.strategiesService
      .update(this.strategyId, data as UpdateStrategyRequest, { silent: true })
      .subscribe({
        next: (res) => {
          this.updateSaving.set(false);
          if (!res?.status) {
            this.updateError.set(failureMessage(res, 'The engine did not apply the update.'));
            return;
          }
          this.notifications.success('Strategy updated');
          this.showEditForm.set(false);
          // The engine answers `data: true`, not the strategy — re-read it.
          this.loadStrategy();
        },
        error: (err) => {
          this.updateSaving.set(false);
          this.updateError.set(failureMessage(err, 'The update failed.'));
        },
      });
  }

  protected loadStrategy(): void {
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
}
