import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  signal,
  ViewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { catchError, forkJoin, map, merge, of, switchMap, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { BacktestsService } from '@core/services/backtests.service';
import { WalkForwardService } from '@core/services/walk-forward.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import {
  StrategyDto,
  StrategyPerformanceSnapshotDto,
  PagerRequest,
  CreateStrategyRequest,
  StrategyTemplateDto,
  ApplyStrategyTemplateRequest,
  StrategyRejectionSummaryDto,
  RiskProfileDto,
  BacktestRunDto,
  WalkForwardRunDto,
  OptimizationRunDto,
} from '@core/api/api.types';
import { RiskProfilesService } from '@core/services/risk-profiles.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  SparklineCellComponent,
  type SparklineCellRendererParams,
} from '@shared/components/data-table/cell-renderers/sparkline-cell.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { DecimalPipe } from '@angular/common';
import { StrategyFormComponent } from '../../components/strategy-form/strategy-form.component';

@Component({
  selector: 'app-strategies-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    StrategyFormComponent,
    DecimalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <ui-tabs [tabs]="pageTabs" [(activeTab)]="activeTab">
        <!-- Strategy List Tab -->
        @if (activeTab() === 'list') {
          <app-page-header title="Strategies" subtitle="Manage trading strategies">
            <button
              class="btn btn-secondary"
              (click)="openTemplatePanel()"
              title="Apply a saved template across multiple symbols at once"
              style="margin-right: 8px;"
            >
              From Template
            </button>
            <button class="btn btn-primary" (click)="showCreateForm.set(true)">
              + Create Strategy
            </button>
          </app-page-header>

          <!-- Bulk-apply template panel — TradingView "apply to portfolio" analogue -->
          @if (showTemplatePanel()) {
            <div
              class="overlay"
              role="presentation"
              tabindex="-1"
              (click)="closeTemplatePanel()"
              (keydown.escape)="closeTemplatePanel()"
              style="position:fixed;inset:0;background:rgba(0,0,0,0.32);z-index:50;display:flex;align-items:center;justify-content:center;"
            >
              <div
                class="dialog"
                role="dialog"
                aria-modal="true"
                tabindex="-1"
                (click)="$event.stopPropagation()"
                (keydown)="$event.stopPropagation()"
                style="background:var(--bg-primary,#fff);border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,0.18);min-width:440px;max-width:560px;padding:24px;"
              >
                <h3 style="margin:0 0 12px;font-size:16px;font-weight:600;">Apply Template</h3>
                <p class="muted small" style="margin:0 0 16px;">
                  Spawn one strategy per symbol from a saved configuration. Fastest way to roll out
                  the same setup across a basket of pairs.
                </p>

                <div class="form-group" style="margin-bottom:12px;">
                  <label class="form-label">Template <span class="required">*</span></label>
                  <select
                    class="form-input"
                    [value]="bulkTemplateId() ?? ''"
                    (change)="onBulkTemplateSelect($any($event.target).value)"
                  >
                    <option value="">Select a template…</option>
                    @for (t of templates(); track t.id) {
                      <option [value]="t.id">{{ t.name }} · {{ t.strategyType }}</option>
                    }
                  </select>
                </div>

                <div class="form-group" style="margin-bottom:12px;">
                  <label class="form-label">Symbols <span class="required">*</span></label>
                  <input
                    type="text"
                    class="form-input"
                    [value]="bulkSymbols()"
                    (input)="bulkSymbols.set($any($event.target).value)"
                    placeholder="EURUSD, GBPUSD, USDJPY, AUDUSD"
                  />
                  <span
                    class="form-hint"
                    style="font-size:11px;color:var(--text-tertiary,#8e8e93);"
                  >
                    Comma-separated. Each symbol gets its own strategy named
                    <code>"&lt;Template&gt; &lt;Symbol&gt; &lt;Timeframe&gt;"</code>.
                  </span>
                </div>

                <div class="form-group" style="margin-bottom:16px;">
                  <label class="form-label">Timeframe</label>
                  <select
                    class="form-input"
                    [value]="bulkTimeframe()"
                    (change)="bulkTimeframe.set($any($event.target).value)"
                  >
                    @for (tf of bulkTimeframes; track tf) {
                      <option [value]="tf">{{ tf }}</option>
                    }
                  </select>
                </div>

                <div style="display:flex;justify-content:flex-end;gap:8px;">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="closeTemplatePanel()"
                    [disabled]="applyingTemplate()"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="submitTemplateApply()"
                    [disabled]="applyingTemplate() || !bulkTemplateId() || !bulkSymbols().trim()"
                  >
                    @if (applyingTemplate()) {
                      Applying…
                    } @else {
                      Apply
                    }
                  </button>
                </div>
              </div>
            </div>
          }

          <!-- Risk-profile picker for bulk SetRiskProfile -->
          @if (showRiskPicker()) {
            <div
              class="overlay"
              role="presentation"
              (click)="closeRiskPicker()"
              (keydown.escape)="closeRiskPicker()"
              tabindex="-1"
              style="position:fixed;inset:0;background:rgba(0,0,0,0.32);z-index:50;display:flex;align-items:center;justify-content:center;"
            >
              <div
                class="dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="risk-picker-title"
                (click)="$event.stopPropagation()"
                style="background:#fff;border-radius:8px;max-width:560px;width:92%;padding:18px 20px;max-height:80vh;overflow:auto;"
              >
                <h3 id="risk-picker-title" style="margin:0 0 12px;">Select risk profile</h3>
                <p class="muted small" style="margin-bottom:12px;">
                  Apply to {{ pickerSelectedRows().length }} strateg{{
                    pickerSelectedRows().length === 1 ? 'y' : 'ies'
                  }}.
                </p>
                @if (riskProfilesLoading()) {
                  <p class="muted">Loading…</p>
                } @else if (riskProfilesList().length === 0) {
                  <p class="muted">No risk profiles configured.</p>
                } @else {
                  <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                      <tr style="border-bottom:1px solid var(--border,#eef0f3);">
                        <th style="text-align:left;padding:6px 8px;">Name</th>
                        <th style="text-align:right;padding:6px 8px;">Max DD</th>
                        <th style="text-align:right;padding:6px 8px;">Max risk/trade</th>
                        <th style="text-align:right;padding:6px 8px;">Max positions</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (p of riskProfilesList(); track p.id) {
                        <tr style="border-bottom:1px solid var(--border-subtle,#eef0f3);">
                          <td style="padding:6px 8px;">
                            {{ p.name ?? '(unnamed)' }}
                            @if (p.isDefault) {
                              <span class="muted small"> · default</span>
                            }
                          </td>
                          <td
                            style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;"
                          >
                            {{ p.maxTotalDrawdownPct.toFixed(1) }}%
                          </td>
                          <td
                            style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;"
                          >
                            {{ p.maxRiskPerTradePct.toFixed(2) }}%
                          </td>
                          <td
                            style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;"
                          >
                            {{ p.maxOpenPositions }}
                          </td>
                          <td style="padding:6px 8px;text-align:right;">
                            <button
                              type="button"
                              class="btn btn-link"
                              (click)="onRiskPickerSelect(p.id)"
                            >
                              Apply
                            </button>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
                <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;">
                  <button type="button" class="btn btn-secondary" (click)="closeRiskPicker()">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          }

          <!-- 8-card KPI strip — derived from a fleet-wide analytics sample -->
          <div class="strat-kpis">
            <app-metric-card
              label="Total"
              [value]="strategyAnalytics().total"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Active"
              [value]="strategyAnalytics().active"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Paused"
              [value]="strategyAnalytics().paused"
              format="number"
              dotColor="#FF9500"
            />
            <app-metric-card
              label="Stopped"
              [value]="strategyAnalytics().stopped"
              format="number"
              dotColor="#8E8E93"
            />
            <app-metric-card
              label="Backtesting"
              [value]="strategyAnalytics().backtesting"
              format="number"
              dotColor="#5AC8FA"
            />
            <app-metric-card
              label="Symbols"
              [value]="strategyAnalytics().symbols"
              format="number"
              dotColor="#AF52DE"
            />
            <app-metric-card
              label="Types"
              [value]="strategyAnalytics().types"
              format="number"
              dotColor="#FF2D55"
            />
            <app-metric-card
              label="Risk-mapped"
              [value]="strategyAnalytics().withRiskProfile"
              format="number"
              dotColor="#30D158"
            />
          </div>

          <!-- Filter chips: status quick-filter for the table below -->
          <div class="filter-chips">
            <button
              class="chip"
              [class.active]="statusFilter() === 'all'"
              (click)="setStatusFilter('all')"
            >
              All <span class="chip-count">{{ strategyAnalytics().total }}</span>
            </button>
            <button
              class="chip"
              [class.active]="statusFilter() === 'Active'"
              (click)="setStatusFilter('Active')"
            >
              Active <span class="chip-count">{{ strategyAnalytics().active }}</span>
            </button>
            <button
              class="chip"
              [class.active]="statusFilter() === 'Paused'"
              (click)="setStatusFilter('Paused')"
            >
              Paused <span class="chip-count">{{ strategyAnalytics().paused }}</span>
            </button>
            <button
              class="chip"
              [class.active]="statusFilter() === 'Stopped'"
              (click)="setStatusFilter('Stopped')"
            >
              Stopped <span class="chip-count">{{ strategyAnalytics().stopped }}</span>
            </button>
            <button
              class="chip"
              [class.active]="statusFilter() === 'Backtesting'"
              (click)="setStatusFilter('Backtesting')"
            >
              Backtesting <span class="chip-count">{{ strategyAnalytics().backtesting }}</span>
            </button>
          </div>

          <!-- 3-col chart row: status donut + by symbol + by type -->
          <div class="strat-chart-row three">
            <app-chart-card
              title="Status distribution"
              subtitle="Active vs paused vs stopped"
              [options]="statusDonutOptions()"
              height="240px"
            />
            <app-chart-card
              title="Strategies by symbol"
              subtitle="Top 12 symbols by strategy count"
              [options]="bySymbolOptions()"
              height="240px"
            />
            <app-chart-card
              title="Strategies by type"
              subtitle="Distribution of strategy types in the fleet"
              [options]="byTypeOptions()"
              height="240px"
            />
          </div>

          <!-- 2-col chart row: by timeframe + creation activity -->
          <div class="strat-chart-row two">
            <app-chart-card
              title="Strategies by timeframe"
              subtitle="Coverage across chart resolutions"
              [options]="byTimeframeOptions()"
              height="240px"
            />
            <app-chart-card
              title="Creation activity"
              subtitle="Strategies added over the last 30 days"
              [options]="creationActivityOptions()"
              height="240px"
            />
          </div>

          <!-- Filtered Signals diagnostics — top rejection (strategy, stage, reason) tuples
               over the last 24h. Surfaces which gates are dropping the most signals so
               operators know where to tune thresholds. -->
          @if (rejectionSummary().length > 0) {
            <section
              class="rejection-card"
              style="background:var(--bg-secondary,#fff);border:1px solid var(--border,#e5e5ea);border-radius:12px;padding:16px;margin-bottom:16px;"
            >
              <header
                style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"
              >
                <div>
                  <h3 style="margin:0;font-size:14px;font-weight:600;">
                    Filtered Signals (last 24h)
                  </h3>
                  <span style="font-size:11px;color:var(--text-tertiary,#8e8e93);">
                    Top rejection tuples — high counts mean a gate is over-strict or a strategy is
                    consistently misaligned with the gate.
                  </span>
                </div>
                <button
                  type="button"
                  class="btn btn-link"
                  (click)="loadRejectionSummary()"
                  style="font-size:12px;"
                >
                  Refresh
                </button>
              </header>
              <div style="overflow-x:auto;">
                <table style="width:100%;font-size:12px;border-collapse:collapse;">
                  <thead>
                    <tr style="text-align:left;color:var(--text-secondary,#636366);">
                      <th style="padding:6px 8px;font-weight:500;">Strategy</th>
                      <th style="padding:6px 8px;font-weight:500;">Symbol</th>
                      <th style="padding:6px 8px;font-weight:500;">Stage</th>
                      <th style="padding:6px 8px;font-weight:500;">Reason</th>
                      <th style="padding:6px 8px;font-weight:500;text-align:right;">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of rejectionSummary(); track $index) {
                      <tr style="border-top:1px solid var(--border,#f0f0f0);">
                        <td style="padding:6px 8px;">
                          {{ r.strategyId === 0 ? '—' : '#' + r.strategyId }}
                        </td>
                        <td style="padding:6px 8px;font-family:'SF Mono',Menlo,monospace;">
                          {{ r.symbol }}
                        </td>
                        <td style="padding:6px 8px;">
                          <span
                            style="background:rgba(0,113,227,0.10);color:#0040DD;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;"
                            >{{ r.stage }}</span
                          >
                        </td>
                        <td
                          style="padding:6px 8px;font-family:'SF Mono',Menlo,monospace;color:var(--text-secondary,#636366);"
                        >
                          {{ r.reason }}
                        </td>
                        <td
                          style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;font-weight:500;"
                        >
                          {{ r.count | number }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <app-data-table
            [columnDefs]="columns"
            [fetchData]="fetchStrategies"
            [selectable]="true"
            (rowClick)="onRowClick($event)"
          >
            <ng-template #bulkActions let-rows let-clear="clear">
              <button
                type="button"
                class="btn btn-link"
                [disabled]="bulkBusy()"
                (click)="bulkApply('Activate', rows, clear)"
                title="Activate every selected strategy"
              >
                Activate
              </button>
              <button
                type="button"
                class="btn btn-link"
                [disabled]="bulkBusy()"
                (click)="bulkApply('Pause', rows, clear)"
                title="Pause every selected strategy"
              >
                Pause
              </button>
              <button
                type="button"
                class="btn btn-link"
                [disabled]="bulkBusy()"
                (click)="bulkApplyRiskProfile(rows, clear)"
                title="Set the same risk profile on every selected strategy"
              >
                Set risk profile…
              </button>
              <button
                type="button"
                class="btn btn-link"
                [disabled]="bulkBusy()"
                (click)="bulkApply('ClearRiskProfile', rows, clear)"
                title="Detach the risk profile from every selected strategy"
              >
                Clear risk profile
              </button>
              <button
                type="button"
                class="btn btn-link"
                [disabled]="bulkBusy()"
                (click)="bulkRunOptimization(rows, clear)"
                title="Queue a Manual optimization run for every selected strategy. The OptimizationWorker picks up queued runs and searches for improved parameters."
              >
                🔧 Run optimization
              </button>
              @if (bulkBusy()) {
                <span class="muted small">Applying…</span>
              }
            </ng-template>
          </app-data-table>
        }

        <!-- Strategy Monitor Tab -->
        @if (activeTab() === 'monitor') {
          <app-page-header title="Strategy Monitor" subtitle="Real-time performance monitoring" />

          <div class="selector-bar">
            <label class="selector-label">Strategy</label>
            <select
              class="selector-input"
              [value]="selectedStrategyId()"
              (change)="onStrategySelect($event)"
            >
              <option value="">-- Select a strategy --</option>
              @for (s of monitorStrategyOptions(); track s.id) {
                <option [value]="s.id">{{ s.name }} ({{ s.symbol }})</option>
              }
            </select>
            @if (selectedStrategy(); as s) {
              <span class="meta-pill" [class.active]="String(s.status) === 'Active'">
                {{ s.status }}
              </span>
              <span class="meta-pill subtle"
                >{{ s.symbol }} · {{ enumLabel.transform(s.timeframe, 'timeframe') }}</span
              >
              <span class="meta-pill subtle">{{ enumLabel.transform(s.strategyType) }}</span>
              @if (s.riskProfileId !== null && s.riskProfileId !== undefined) {
                <span class="meta-pill subtle">Risk #{{ s.riskProfileId }}</span>
              }
            }
          </div>

          @if (performance(); as perf) {
            <!-- 12-card KPI grid with derived metrics -->
            <div class="monitor-kpis">
              <app-metric-card
                label="Win Rate"
                [value]="perf.winRate"
                format="percent"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Profit Factor"
                [value]="perf.profitFactor"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Sharpe Ratio"
                [value]="perf.sharpeRatio"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                label="Max Drawdown"
                [value]="perf.maxDrawdownPct"
                format="percent"
                dotColor="#FF3B30"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Total Trades"
                [value]="perf.windowTrades"
                format="number"
                dotColor="#FF9500"
              />
              <app-metric-card
                label="Total P&L"
                [value]="perf.totalPnL"
                format="currency"
                [colorByValue]="true"
                dotColor="#30D158"
              />
              <app-metric-card
                label="Winning trades"
                [value]="perf.winningTrades"
                format="number"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Losing trades"
                [value]="perf.losingTrades"
                format="number"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Avg P&L / trade"
                [value]="avgPnLPerTrade()"
                format="currency"
                [colorByValue]="true"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Win/Loss ratio"
                [value]="winLossRatio()"
                format="number"
                dotColor="#FF2D55"
              />
              <app-metric-card
                label="Health score"
                [value]="perf.healthScore"
                format="number"
                [dotColor]="healthDotColor()"
              />
              <app-metric-card
                label="Loss rate"
                [value]="lossRatePct()"
                format="percent"
                dotColor="#FF9500"
              />
            </div>

            <!-- Health + status meta strip -->
            <div class="health-strip">
              <div class="health-cell">
                <span class="hc-label">Health status</span>
                <span
                  class="hc-value pill"
                  [class]="'hc-' + (perf.healthStatus ?? 'unknown').toLowerCase()"
                >
                  {{ perf.healthStatus ?? 'Unknown' }}
                </span>
              </div>
              <div class="health-cell">
                <span class="hc-label">Market regime</span>
                <span class="hc-value">{{ perf.marketRegime ?? '—' }}</span>
              </div>
              <div class="health-cell">
                <span class="hc-label">Window trades</span>
                <span class="hc-value mono">{{ perf.windowTrades }}</span>
              </div>
              <div class="health-cell">
                <span class="hc-label">Last evaluation</span>
                <span class="hc-value mono">
                  {{ relativeTime.transform(perf.evaluatedAt) }}
                </span>
              </div>
              <div class="health-cell">
                <span class="hc-label">Snapshot id</span>
                <span class="hc-value mono">#{{ perf.id }}</span>
              </div>
            </div>

            <!-- 3-col chart row: outcome donut + health gauge + recent health line -->
            <div class="strat-chart-row three">
              <app-chart-card
                title="Trade outcomes"
                subtitle="Winning vs losing in current window"
                [options]="outcomeDonutOptions()"
                height="280px"
              />
              <app-chart-card
                title="Health gauge"
                subtitle="0–1 composite health score"
                [options]="healthGaugeOptions()"
                height="280px"
              />
              <app-chart-card
                title="Health trend"
                subtitle="Last 24 health snapshots"
                [options]="healthTrendOptions()"
                height="280px"
              />
            </div>

            <div class="chart-grid">
              <app-chart-card
                title="Equity Curve"
                subtitle="Cumulative P&L over time · sample series"
                [options]="equityCurveOptions"
                height="320px"
              />
              <app-chart-card
                title="Win Rate Over Time"
                subtitle="Rolling 20-trade win rate · sample series"
                [options]="winRateOptions"
                height="320px"
              />
              <app-chart-card
                title="Profit Factor Trend"
                subtitle="Rolling profit factor with quality bands · sample series"
                [options]="profitFactorOptions"
                height="320px"
              />
              <app-chart-card
                title="Monthly Returns"
                subtitle="Return distribution by month · sample series"
                [options]="monthlyReturnsOptions"
                height="320px"
              />
            </div>
          } @else if (loadingPerformance()) {
            <div class="empty-monitor">
              <div class="spinner"></div>
              <p>Loading performance data…</p>
            </div>
          } @else if (selectedStrategyId()) {
            <div class="empty-monitor">
              <p><strong>No performance snapshot available</strong></p>
              <p class="muted">
                This strategy has no performance window evaluation yet. Snapshots are produced once
                the strategy has accumulated trade history.
              </p>
            </div>
          } @else {
            <div class="empty-monitor">
              <p>Select a strategy to view performance metrics</p>
            </div>
          }
        }
      </ui-tabs>

      <app-strategy-form
        [open]="showCreateForm()"
        [strategy]="null"
        (submitted)="onCreate($event)"
        (cancelled)="showCreateForm.set(false)"
      />
    </div>
  `,
  styles: [
    `
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
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }

      .selector-bar {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-6);
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }

      .selector-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        white-space: nowrap;
      }

      .selector-input {
        flex: 1;
        max-width: 400px;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }

      .chart-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }

      .empty-monitor {
        text-align: center;
        padding: var(--space-16);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }

      @media (max-width: 900px) {
        .chart-grid {
          grid-template-columns: 1fr;
        }
        .kpi-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* List-tab analytics: KPI strip, filter chips, chart rows */
      .strat-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin: var(--space-2) 0 var(--space-3);
      }
      @media (max-width: 1400px) {
        .strat-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .strat-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .filter-chips {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        margin-bottom: var(--space-3);
      }
      .chip {
        padding: 6px 14px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all 0.15s ease;
      }
      .chip:hover {
        color: var(--text-primary);
        border-color: var(--text-tertiary);
      }
      .chip.active {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .chip-count {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: rgba(0, 0, 0, 0.06);
      }
      .chip.active .chip-count {
        background: rgba(255, 255, 255, 0.22);
        color: #fff;
      }

      .strat-chart-row {
        display: grid;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .strat-chart-row.three {
        grid-template-columns: 1fr 1fr 1fr;
      }
      .strat-chart-row.two {
        grid-template-columns: 1fr 1fr;
      }
      @media (max-width: 1100px) {
        .strat-chart-row.three,
        .strat-chart-row.two {
          grid-template-columns: 1fr;
        }
      }

      /* Monitor-tab dense KPI grid (12 cards) + health strip */
      .monitor-kpis {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .monitor-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .monitor-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .meta-pill {
        padding: 3px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .meta-pill.active {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .meta-pill.subtle {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }

      .health-strip {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .health-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .health-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .hc-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .hc-value {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .hc-value.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .hc-value.pill {
        align-self: flex-start;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: 11px;
      }
      .hc-healthy {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .hc-warning,
      .hc-degraded {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .hc-critical,
      .hc-failed {
        background: rgba(255, 59, 48, 0.14);
        color: #d70015;
      }
      .hc-unknown {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      .empty-monitor .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        max-width: 480px;
        margin: var(--space-2) auto 0;
      }
      .spinner {
        width: 28px;
        height: 28px;
        border: 2.5px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        margin: 0 auto var(--space-3);
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class StrategiesPageComponent {
  private readonly strategiesService = inject(StrategiesService);
  private readonly feedbackService = inject(StrategyFeedbackService);
  private readonly backtestsService = inject(BacktestsService);
  private readonly walkForwardService = inject(WalkForwardService);
  private readonly riskProfilesService = inject(RiskProfilesService);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  // Exposed (not private) so the inline template can call them on the
  // selected strategy meta pills + health-strip "evaluated" cell.
  readonly enumLabel = new EnumLabelPipe();
  readonly relativeTime = new RelativeTimePipe();
  readonly String = String;

  @ViewChild(DataTableComponent) dataTable?: DataTableComponent<StrategyDto>;

  constructor() {
    // Lazy-load the analytics sample the first time the user lands on the
    // list tab. Re-firing is cheap (guarded by `analyticsLoaded`).
    effect(() => {
      if (this.activeTab() === 'list') {
        this.loadStrategyAnalyticsSample();
        this.loadRejectionSummary();
      }
    });

    // Any of these means the row set or its derived signals (badge state,
    // allocation column) just changed server-side. Throttle so a burst of
    // optimization completions or a chatty allocation cycle collapses to a
    // single grid refresh.
    merge(
      this.realtime.on('strategyActivated'),
      this.realtime.on('optimizationCompleted'),
      this.realtime.on('strategyAllocationRebalanced'),
    )
      .pipe(throttleTime(2_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.dataTable?.loadData();
        // KPIs / charts also drift when allocations or activations land.
        this.analyticsLoaded = false;
        if (this.activeTab() === 'list') this.loadStrategyAnalyticsSample();
      });

    // Per-row sparkline refresh: append the new health-score point to the
    // matching row's series and re-render only that cell. Cheaper than a full
    // grid reload at 60s cadence × N strategies. Off-screen rows (filtered
    // out, paginated past) are silently skipped — they'll catch up on the
    // next page change.
    this.realtime
      .on<{ strategyId: number; healthScore: number }>('strategyHealthSnapshotCreated')
      .pipe(throttleTime(1_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe((evt) => {
        if (!evt) return;
        this.dataTable?.updateRowInPlace(
          (row) => row.id === evt.strategyId,
          (row) => {
            const r = row as StrategyDto & { healthSeries?: number[] };
            const series = (r.healthSeries ?? []).slice();
            series.push(evt.healthScore);
            // Cap matches the bulk-fetch count so the chart doesn't drift wider
            // than what the initial load shows.
            if (series.length > 24) series.shift();
            r.healthSeries = series;
          },
          ['healthSeries'],
        );
      });
  }

  activeTab = signal('list');
  showCreateForm = signal(false);
  selectedStrategyId = signal<number | null>(null);
  strategiesList = signal<StrategyDto[]>([]);
  performance = signal<StrategyPerformanceSnapshotDto | null>(null);

  // ── Bulk-apply template panel state ─────────────────────────────────────
  showTemplatePanel = signal(false);
  templates = signal<StrategyTemplateDto[]>([]);
  bulkTemplateId = signal<number | null>(null);
  bulkSymbols = signal<string>('');
  bulkTimeframe = signal<string>('H1');
  applyingTemplate = signal(false);
  readonly bulkTimeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

  // ── Bulk row-action state ───────────────────────────────────────────────
  // Multi-select on the table → fan a uniform action out to every selected
  // strategy in a single round-trip via /strategy/bulk-update.
  bulkBusy = signal(false);

  // Risk-profile picker dialog state. Opened when the operator clicks the
  // "Set risk profile…" bulk action; lists actual risk profiles from the
  // engine instead of forcing operators to memorise numeric ids.
  showRiskPicker = signal(false);
  riskProfilesLoading = signal(false);
  riskProfilesList = signal<RiskProfileDto[]>([]);
  pickerSelectedRows = signal<StrategyDto[]>([]);
  private pickerClearFn: (() => void) | null = null;

  // ── Filtered-signals diagnostics ────────────────────────────────────────
  rejectionSummary = signal<StrategyRejectionSummaryDto[]>([]);
  rejectionLookbackHours = signal<number>(24);

  // Fleet-wide sample for analytics roll-ups (KPI strip + distribution
  // charts). Loaded once when the list tab is first activated; refreshed
  // when realtime events fire that could change the counts.
  analyticsSample = signal<StrategyDto[]>([]);
  statusFilter = signal<string>('all');

  // Monitor-tab loading state — distinguishes "actively fetching" from
  // "fetched but no snapshot exists yet" so the empty-state copy can be
  // accurate instead of pretending to load forever.
  loadingPerformance = signal(false);

  // Last 24 health-score snapshots for the selected strategy. Pulled via
  // the bulk endpoint that already powers the list-tab sparklines, so we
  // get a real time-series with no extra round-trips when the user has
  // already seen this row in the table.
  healthSeries = signal<number[]>([]);

  // Strategy dropdown options — prefer the broader analytics sample (up to
  // 500 rows) over the per-page list because the user lands on Monitor
  // without necessarily having paged through the table first.
  monitorStrategyOptions = computed<StrategyDto[]>(() => {
    const broad = this.analyticsSample();
    if (broad.length > 0) return broad;
    return this.strategiesList();
  });

  selectedStrategy = computed<StrategyDto | undefined>(() => {
    const id = this.selectedStrategyId();
    if (id == null) return undefined;
    return (
      this.monitorStrategyOptions().find((s) => s.id === id) ??
      this.strategiesList().find((s) => s.id === id)
    );
  });

  // ── Derived KPIs over the current performance snapshot ──────────────
  avgPnLPerTrade = computed(() => {
    const p = this.performance();
    if (!p || p.windowTrades === 0) return null;
    return +(p.totalPnL / p.windowTrades).toFixed(2);
  });

  winLossRatio = computed(() => {
    const p = this.performance();
    if (!p || p.losingTrades === 0) return null;
    return +(p.winningTrades / p.losingTrades).toFixed(2);
  });

  lossRatePct = computed(() => {
    const p = this.performance();
    if (!p || p.windowTrades === 0) return null;
    return +((p.losingTrades / p.windowTrades) * 100).toFixed(2);
  });

  healthDotColor = computed(() => {
    const p = this.performance();
    if (!p) return '#8E8E93';
    if (p.healthScore >= 0.75) return '#34C759';
    if (p.healthScore >= 0.5) return '#FF9500';
    return '#FF3B30';
  });

  outcomeDonutOptions = computed<EChartsOption>(() => {
    const p = this.performance();
    if (!p) return {};
    const total = p.windowTrades;
    if (total === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: [
            { value: p.winningTrades, name: 'Wins', itemStyle: { color: '#34C759' } },
            { value: p.losingTrades, name: 'Losses', itemStyle: { color: '#FF3B30' } },
            {
              value: Math.max(0, total - p.winningTrades - p.losingTrades),
              name: 'Other',
              itemStyle: { color: '#8E8E93' },
            },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  healthGaugeOptions = computed<EChartsOption>(() => {
    const p = this.performance();
    if (!p) return {};
    return {
      series: [
        {
          type: 'gauge',
          radius: '95%',
          center: ['50%', '60%'],
          startAngle: 220,
          endAngle: -40,
          min: 0,
          max: 1,
          splitNumber: 4,
          progress: { show: true, width: 18, itemStyle: { color: this.healthDotColor() } },
          axisLine: {
            lineStyle: {
              width: 18,
              color: [
                [0.5, 'rgba(255,59,48,0.18)'],
                [0.75, 'rgba(255,149,0,0.18)'],
                [1, 'rgba(52,199,89,0.18)'],
              ],
            },
          },
          axisTick: { show: false },
          splitLine: { length: 8, lineStyle: { color: 'rgba(0,0,0,0.18)', width: 1 } },
          axisLabel: { fontSize: 9, color: '#6E6E73', distance: 16 },
          pointer: { length: '60%', width: 5, itemStyle: { color: this.healthDotColor() } },
          detail: {
            valueAnimation: false,
            offsetCenter: [0, '40%'],
            fontSize: 22,
            fontWeight: 600,
            color: this.healthDotColor(),
            formatter: (v: number) => v.toFixed(2),
          },
          data: [{ value: p.healthScore }],
        },
      ],
    };
  });

  healthTrendOptions = computed<EChartsOption>(() => {
    const series = this.healthSeries();
    if (series.length < 2) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: series.map((_, i) => `${i + 1}`),
        axisLabel: { fontSize: 9, color: '#6E6E73' },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'line',
          data: series,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { color: this.healthDotColor(), width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0, 113, 227, 0.18)' },
                { offset: 1, color: 'rgba(0, 113, 227, 0.02)' },
              ],
            },
          },
        },
      ],
    };
  });

  readonly pageTabs: TabItem[] = [
    { label: 'Strategy List', value: 'list' },
    { label: 'Strategy Monitor', value: 'monitor' },
  ];

  strategyAnalytics = computed(() => {
    const all = this.analyticsSample();
    const symbols = new Set<string>();
    const types = new Set<string>();
    let active = 0;
    let paused = 0;
    let stopped = 0;
    let backtesting = 0;
    let withRiskProfile = 0;
    for (const s of all) {
      if (s.symbol) symbols.add(s.symbol);
      if (s.strategyType) types.add(String(s.strategyType));
      const status = String(s.status);
      if (status === 'Active') active++;
      else if (status === 'Paused') paused++;
      else if (status === 'Stopped') stopped++;
      else if (status === 'Backtesting') backtesting++;
      if (s.riskProfileId != null) withRiskProfile++;
    }
    return {
      total: all.length,
      active,
      paused,
      stopped,
      backtesting,
      symbols: symbols.size,
      types: types.size,
      withRiskProfile,
    };
  });

  statusDonutOptions = computed<EChartsOption>(() => {
    const a = this.strategyAnalytics();
    if (a.total === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: [
            { value: a.active, name: 'Active', itemStyle: { color: '#34C759' } },
            { value: a.paused, name: 'Paused', itemStyle: { color: '#FF9500' } },
            { value: a.stopped, name: 'Stopped', itemStyle: { color: '#8E8E93' } },
            { value: a.backtesting, name: 'Backtesting', itemStyle: { color: '#5AC8FA' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  bySymbolOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const s of this.analyticsSample()) {
      const key = s.symbol ?? 'unknown';
      map[key] = (map[key] ?? 0) + 1;
    }
    const entries = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([s]) => s).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  byTypeOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const s of this.analyticsSample()) {
      const key = String(s.strategyType ?? 'unknown');
      map[key] = (map[key] ?? 0) + 1;
    }
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 140 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([s]) => this.enumLabel.transform(s)).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  byTimeframeOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const s of this.analyticsSample()) {
      const key = String(s.timeframe ?? 'unknown');
      map[key] = (map[key] ?? 0) + 1;
    }
    const order = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'];
    const entries = Object.entries(map).sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      if (ai !== -1 && bi !== -1) return ai - bi;
      return a[0].localeCompare(b[0]);
    });
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: entries.map(([s]) => this.enumLabel.transform(s, 'timeframe')),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color: '#FF9500', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  creationActivityOptions = computed<EChartsOption>(() => {
    const buckets: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const s of this.analyticsSample()) {
      if (!s.createdAt) continue;
      const day = s.createdAt.slice(0, 10);
      if (day in buckets) buckets[day]++;
    }
    const dates = Object.keys(buckets);
    const counts = Object.values(buckets);
    if (counts.every((c) => c === 0)) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: dates.map((d) => d.slice(5)),
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 45 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c) => ({
            value: c,
            itemStyle: { color: '#5AC8FA', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  setStatusFilter(value: string) {
    this.statusFilter.set(value);
    this.dataTable?.loadData();
  }

  private analyticsLoaded = false;
  private loadStrategyAnalyticsSample() {
    if (this.analyticsLoaded) return;
    this.analyticsLoaded = true;
    // One-shot HTTP — completes on its own, no teardown subscription needed.
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 500, filter: null }).subscribe({
      next: (res) => {
        const rows = res?.data?.data ?? [];
        this.analyticsSample.set(rows);
      },
      error: () => {
        // Leave sample empty — KPIs and charts will render empty cards.
        this.analyticsLoaded = false;
      },
    });
  }

  readonly columns: ColDef[] = [
    { field: 'name', headerName: 'Name', flex: 2, minWidth: 160 },
    { field: 'symbol', headerName: 'Symbol', flex: 1, minWidth: 100 },
    {
      field: 'timeframe',
      headerName: 'Timeframe',
      flex: 1,
      minWidth: 90,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value, 'timeframe'),
    },
    {
      field: 'strategyType',
      headerName: 'Type',
      flex: 1.5,
      minWidth: 140,
      valueFormatter: (p: any) => this.enumLabel.transform(p.value),
    },
    {
      field: 'status',
      headerName: 'Status',
      flex: 1,
      minWidth: 100,
      cellRenderer: (p: any) => {
        const variant = this.getStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${variant.bg};color:${variant.color}">${p.value}</span>`;
      },
    },
    {
      // Sparkline of the latest 24 health-snapshot scores (oldest left,
      // newest right). Per-row series is back-filled by `fetchStrategies`
      // via the bulk `/strategy/health/recent` endpoint, so this column
      // costs one extra round-trip per page (not per row).
      field: 'healthSeries',
      headerName: 'Health (24m)',
      width: 140,
      sortable: false,
      filter: false,
      // SparklineCellComponent owns the visual; suppresses AG Grid warning
      // #48 about object-typed cells lacking a value formatter for
      // copy/export fallback. We expose a CSV-ish fallback so a copied
      // cell stays meaningful.
      cellDataType: false,
      valueFormatter: (p) => {
        const v = p.value as number[] | undefined;
        return Array.isArray(v) && v.length > 0 ? v.map((n) => n.toFixed(2)).join(',') : '';
      },
      cellRenderer: SparklineCellComponent,
      cellRendererParams: {
        domain: [0, 1],
        color: '#34C759',
        label: 'Health score',
      } satisfies SparklineCellRendererParams,
    },
    {
      field: 'lifecycleStage',
      headerName: 'Lifecycle',
      flex: 1,
      minWidth: 110,
      cellRenderer: (p: any) => {
        const stage = (p.value as string | undefined) ?? '—';
        const variant = lifecycleVariant(stage);
        return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:${variant.bg};color:${variant.color}">${stage}</span>`;
      },
    },
    {
      colId: 'btReturn',
      headerName: 'Last BT %',
      flex: 1,
      minWidth: 90,
      sortable: false,
      filter: false,
      valueGetter: (p: any) => {
        const ret = parseTotalReturn(p.data?.latestBt?.resultJson);
        return ret != null ? ret * 100 : null;
      },
      cellRenderer: (p: any) => {
        const v = p.value as number | null;
        if (v == null) return '<span style="color:var(--text-tertiary,#999)">—</span>';
        const color = v >= 0 ? 'var(--profit,#1f8a4c)' : 'var(--loss,#c0392b)';
        const sign = v >= 0 ? '+' : '';
        return `<span style="color:${color};font-variant-numeric:tabular-nums">${sign}${v.toFixed(2)}%</span>`;
      },
    },
    {
      colId: 'wfOos',
      headerName: 'Last WF avgOOS',
      flex: 1,
      minWidth: 110,
      sortable: false,
      filter: false,
      valueGetter: (p: any) =>
        (p.data?.latestWf as WalkForwardRunDto | null | undefined)?.averageOutOfSampleScore ?? null,
      cellRenderer: (p: any) => {
        const v = p.value as number | null;
        if (v == null) return '<span style="color:var(--text-tertiary,#999)">—</span>';
        const color = v >= 0 ? 'var(--profit,#1f8a4c)' : 'var(--loss,#c0392b)';
        const sign = v >= 0 ? '+' : '';
        return `<span style="color:${color};font-variant-numeric:tabular-nums">${sign}${v.toFixed(3)}</span>`;
      },
    },
    {
      colId: 'optUplift',
      headerName: 'Opt uplift',
      flex: 1,
      minWidth: 90,
      sortable: false,
      filter: false,
      valueGetter: (p: any) => {
        const o = p.data?.latestOpt as OptimizationRunDto | null | undefined;
        if (!o || o.bestHealthScore == null || o.baselineHealthScore == null) return null;
        return o.bestHealthScore - o.baselineHealthScore;
      },
      cellRenderer: (p: any) => {
        const v = p.value as number | null;
        if (v == null) return '<span style="color:var(--text-tertiary,#999)">—</span>';
        const color = v >= 0 ? 'var(--profit,#1f8a4c)' : 'var(--loss,#c0392b)';
        const sign = v >= 0 ? '+' : '';
        return `<span style="color:${color};font-variant-numeric:tabular-nums">${sign}${v.toFixed(3)}</span>`;
      },
    },
    {
      colId: 'eligibility',
      headerName: 'Eligible',
      flex: 1.4,
      minWidth: 140,
      sortable: false,
      filter: false,
      cellRenderer: (p: any) => {
        const e = (p.data?.eligibility as ActivationEligibility | undefined) ?? { kind: 'unknown' };
        const variant = eligibilityVariant(e.kind);
        const label = eligibilityLabel(e);
        const tooltip = eligibilityTooltip(e);
        return `<span title="${tooltip}" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:${variant.bg};color:${variant.color}">${label}</span>`;
      },
    },
    {
      field: 'rolloutPct',
      headerName: 'Rollout',
      flex: 0.8,
      minWidth: 80,
      valueFormatter: (p: any) => (p.value != null ? `${p.value}%` : '—'),
    },
    {
      field: 'lastSignalAt',
      headerName: 'Last signal',
      flex: 1,
      minWidth: 100,
      valueFormatter: (p: any) => (p.value ? this.relativeTime.transform(p.value) : 'never'),
    },
    {
      field: 'riskProfileId',
      headerName: 'Risk Profile',
      flex: 1,
      minWidth: 100,
      valueFormatter: (p: any) => (p.value != null ? `#${p.value}` : '-'),
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      flex: 1.2,
      minWidth: 120,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly fetchStrategies = (params: PagerRequest) => {
    // Merge the status chip filter into whatever the data-table already
    // sends. `all` clears it; otherwise we add a `status` field that the
    // backend's strategy-list query understands.
    const status = this.statusFilter();
    const filter =
      status !== 'all'
        ? { ...((params.filter as Record<string, unknown>) ?? {}), status }
        : params.filter;
    return this.strategiesService.list({ ...params, filter }).pipe(
      switchMap((res) => {
        const page = res.data;
        if (page?.data) this.strategiesList.set(page.data);

        const ids = page?.data?.map((s) => s.id).filter((id): id is number => id != null) ?? [];
        if (ids.length === 0) return of(page!);

        // Bulk fan-out per page (NOT per row). Pulls the most-recent 500 of
        // each so the active-strategy slice (~200 today) is comfortably covered;
        // grouping is client-side. Failures degrade gracefully — empty cells,
        // not a blank table.
        const wide = { currentPage: 1, itemCountPerPage: 500, filter: null } as PagerRequest;
        return forkJoin({
          snaps: this.strategiesService
            .getRecentSnapshots({ strategyIds: ids, count: 24 })
            .pipe(catchError(() => of(null))),
          backtests: this.backtestsService.list(wide).pipe(catchError(() => of(null))),
          walkForwards: this.walkForwardService.list(wide).pipe(catchError(() => of(null))),
          opts: this.feedbackService.listOptimizationRuns(wide).pipe(catchError(() => of(null))),
        }).pipe(
          map(({ snaps, backtests, walkForwards, opts }) => {
            // ── Health sparkline (existing behavior) ────────────────────
            const grouped = new Map<number, number[]>();
            for (const s of snaps?.data ?? []) {
              if (!grouped.has(s.strategyId)) grouped.set(s.strategyId, []);
              grouped.get(s.strategyId)!.push(s.healthScore);
            }
            // ── Latest-per-strategy lookups ─────────────────────────────
            const latestBt = pickLatestPerStrategy(
              backtests?.data?.data ?? [],
              (b) => b.strategyId,
              (b) => b.completedAt ?? b.startedAt,
            );
            const latestWf = pickLatestPerStrategy(
              walkForwards?.data?.data ?? [],
              (w) => w.strategyId,
              (w) => w.completedAt ?? w.startedAt,
            );
            const latestOpt = pickLatestPerStrategy(
              opts?.data?.data ?? [],
              (o) => o.strategyId,
              (o) => o.completedAt ?? o.startedAt,
            );
            for (const row of page!.data) {
              const decorated = row as StrategyRowAugment;
              decorated.healthSeries = (grouped.get(row.id) ?? []).slice().reverse();
              decorated.latestBt = latestBt.get(row.id) ?? null;
              decorated.latestWf = latestWf.get(row.id) ?? null;
              decorated.latestOpt = latestOpt.get(row.id) ?? null;
              decorated.eligibility = computeEligibility(row, decorated);
            }
            return page!;
          }),
          catchError(() => of(page!)),
        );
      }),
    );
  };

  onRowClick(strategy: StrategyDto): void {
    this.router.navigate(['/strategies', strategy.id]);
  }

  onStrategySelect(event: Event): void {
    const id = +(event.target as HTMLSelectElement).value;
    if (!id) {
      this.selectedStrategyId.set(null);
      this.performance.set(null);
      this.healthSeries.set([]);
      this.loadingPerformance.set(false);
      return;
    }
    this.selectedStrategyId.set(id);
    this.performance.set(null);
    this.healthSeries.set([]);
    this.loadingPerformance.set(true);

    // Fetch perf snapshot. The empty-state branch differentiates "we asked
    // and there's just no snapshot yet" from "still in flight" via the
    // loading flag — previously this rendered "Loading…" forever when the
    // backend returned null data.
    this.feedbackService.getPerformance(id).subscribe({
      next: (res) => {
        this.loadingPerformance.set(false);
        if (res?.data) this.performance.set(res.data);
      },
      error: () => {
        this.loadingPerformance.set(false);
        this.notifications.error('Failed to load performance data');
      },
    });

    // Pull the last 24 health snapshots so the trend chart has a real
    // time-series. Quietly swallow errors — chart just won't render.
    this.strategiesService
      .getRecentSnapshots({ strategyIds: [id], count: 24 })
      .pipe(catchError(() => of(null)))
      .subscribe((snapRes) => {
        if (!snapRes) return;
        // Server returns newest-first; charts read left→right chronologically.
        const series = (snapRes.data ?? []).map((s) => s.healthScore).reverse();
        this.healthSeries.set(series);
      });
  }

  onCreate(data: any): void {
    // Multi-symbol fan-out: when the modal's Symbol field contained multiple
    // comma-separated values, fire one create per symbol in parallel. Single-
    // symbol path stays a single round-trip. Each spawned strategy gets a
    // disambiguating name suffix when the operator's Name doesn't already
    // contain the symbol so the unique-name constraint isn't tripped.
    const symbols: string[] =
      Array.isArray(data?.symbols) && data.symbols.length > 0
        ? (data.symbols as string[])
        : [data?.symbol].filter((s): s is string => !!s);

    if (symbols.length <= 1) {
      const single = { ...data } as CreateStrategyRequest;
      delete (single as any).symbols;
      this.strategiesService.create(single).subscribe({
        next: () => {
          this.notifications.success('Strategy created successfully');
          this.showCreateForm.set(false);
          this.dataTable?.loadData();
        },
        error: () => this.notifications.error('Failed to create strategy'),
      });
      return;
    }

    // Bulk fan-out path — one round-trip per symbol, sequential (Observable
    // chain) so name-collision errors are reported in order.
    let created = 0;
    let failed = 0;
    const baseName = (data?.name as string) ?? 'Strategy';
    const submitOne = (idx: number): void => {
      if (idx >= symbols.length) {
        const summary =
          `Created ${created} strateg${created === 1 ? 'y' : 'ies'}` +
          (failed > 0 ? ` (${failed} failed)` : '');
        if (created > 0) this.notifications.success(summary);
        else this.notifications.error('Failed to create any strategies');
        if (created > 0) {
          this.showCreateForm.set(false);
          this.dataTable?.loadData();
        }
        return;
      }
      const symbol = symbols[idx];
      // If the operator's name doesn't already contain the symbol, append it
      // so each spawned strategy ends up with a unique, recognisable name.
      const includesSymbol = baseName.toUpperCase().includes(symbol);
      const name = includesSymbol ? baseName : `${baseName} ${symbol}`;
      const req: CreateStrategyRequest = {
        ...data,
        name,
        symbol,
      };
      delete (req as any).symbols;
      this.strategiesService.create(req).subscribe({
        next: () => {
          created++;
          submitOne(idx + 1);
        },
        error: () => {
          failed++;
          submitOne(idx + 1);
        },
      });
    };
    submitOne(0);
  }

  // ── Bulk-apply template handlers ────────────────────────────────────────

  /**
   * Pulls the last-N-hours rejection summary so the diagnostics card on the
   * strategies list shows which gates are filtering the most signals. Cheap
   * (one aggregated query) so we re-fire on tab activation without a guard.
   */
  loadRejectionSummary(): void {
    this.strategiesService.getRejectionSummary(this.rejectionLookbackHours(), 50).subscribe({
      next: (res) => this.rejectionSummary.set(res?.data ?? []),
      error: () => this.rejectionSummary.set([]),
    });
  }

  openTemplatePanel(): void {
    this.showTemplatePanel.set(true);
    // Refresh template list every time the panel opens — operators may have
    // saved a new template from the create-strategy modal between opens.
    this.strategiesService.listTemplates().subscribe({
      next: (res) => this.templates.set(res?.data ?? []),
      error: () => this.templates.set([]),
    });
  }

  closeTemplatePanel(): void {
    this.showTemplatePanel.set(false);
    this.bulkTemplateId.set(null);
    this.bulkSymbols.set('');
    this.bulkTimeframe.set('H1');
  }

  onBulkTemplateSelect(rawId: string): void {
    if (!rawId) {
      this.bulkTemplateId.set(null);
      return;
    }
    const id = Number(rawId);
    if (Number.isFinite(id)) this.bulkTemplateId.set(id);
  }

  submitTemplateApply(): void {
    const id = this.bulkTemplateId();
    if (!id) return;

    // Parse comma-separated symbols. Drops empties so trailing commas are tolerated.
    const symbols = this.bulkSymbols()
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (symbols.length === 0) {
      this.notifications.error('Enter at least one symbol');
      return;
    }

    const req: ApplyStrategyTemplateRequest = {
      templateId: id,
      symbols,
      timeframe: this.bulkTimeframe(),
    };

    this.applyingTemplate.set(true);
    this.strategiesService.applyTemplate(req).subscribe({
      next: (res) => {
        this.applyingTemplate.set(false);
        if (res?.status && res.data) {
          const created = res.data.createdCount;
          const skipped = res.data.skippedCount;
          this.notifications.success(
            `Created ${created} strateg${created === 1 ? 'y' : 'ies'}` +
              (skipped > 0 ? ` (${skipped} skipped — name conflicts)` : ''),
          );
          this.closeTemplatePanel();
          this.dataTable?.loadData();
        } else {
          this.notifications.error(res?.message ?? 'Failed to apply template');
        }
      },
      error: () => {
        this.applyingTemplate.set(false);
        this.notifications.error('Failed to apply template');
      },
    });
  }

  /**
   * Apply Activate / Pause / ClearRiskProfile to every selected row in one
   * bulk-update call. SetRiskProfile uses {@link bulkApplyRiskProfile} since
   * it needs an extra prompt for the profile id.
   */
  bulkApply(
    action: 'Activate' | 'Pause' | 'ClearRiskProfile',
    rows: StrategyDto[],
    clear: () => void,
  ): void {
    if (this.bulkBusy() || rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const verb =
      action === 'Activate'
        ? 'activate'
        : action === 'Pause'
          ? 'pause'
          : 'clear the risk profile on';
    if (
      !confirm(
        `Are you sure you want to ${verb} ${ids.length} strateg${ids.length === 1 ? 'y' : 'ies'}?`,
      )
    )
      return;

    this.bulkBusy.set(true);
    this.strategiesService.bulkUpdate({ strategyIds: ids, action }).subscribe({
      next: (res) => {
        this.bulkBusy.set(false);
        if (res?.status && res.data) {
          this.notifications.success(res.message ?? `Updated ${res.data.updatedCount}`);
          clear();
          this.dataTable?.loadData();
        } else {
          this.notifications.error(res?.message ?? 'Bulk update failed');
        }
      },
      error: () => {
        this.bulkBusy.set(false);
        this.notifications.error('Bulk update failed');
      },
    });
  }

  /**
   * Open the risk-profile picker dialog so the operator can pick a profile
   * by name. Replaces the v1 numeric-id prompt() — operators don't memorise
   * profile ids, and the dialog also surfaces profile metadata (max DD, max
   * positions, etc.) that helps pick the right one.
   */
  bulkApplyRiskProfile(rows: StrategyDto[], clear: () => void): void {
    if (this.bulkBusy() || rows.length === 0) return;
    this.pickerSelectedRows.set(rows);
    this.pickerClearFn = clear;
    this.showRiskPicker.set(true);
    if (this.riskProfilesList().length === 0 && !this.riskProfilesLoading()) {
      this.riskProfilesLoading.set(true);
      this.riskProfilesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
        next: (res) => {
          this.riskProfilesLoading.set(false);
          this.riskProfilesList.set(res?.data?.data ?? []);
        },
        error: () => {
          this.riskProfilesLoading.set(false);
          this.notifications.error('Failed to load risk profiles');
        },
      });
    }
  }

  /** Apply the chosen profile to the rows captured when the picker opened. */
  onRiskPickerSelect(profileId: number): void {
    const rows = this.pickerSelectedRows();
    const clear = this.pickerClearFn;
    this.closeRiskPicker();
    if (rows.length === 0) return;

    this.bulkBusy.set(true);
    this.strategiesService
      .bulkUpdate({
        strategyIds: rows.map((r) => r.id),
        action: 'SetRiskProfile',
        riskProfileId: profileId,
      })
      .subscribe({
        next: (res) => {
          this.bulkBusy.set(false);
          if (res?.status && res.data) {
            this.notifications.success(res.message ?? `Updated ${res.data.updatedCount}`);
            clear?.();
            this.dataTable?.loadData();
          } else {
            this.notifications.error(res?.message ?? 'Bulk update failed');
          }
        },
        error: () => {
          this.bulkBusy.set(false);
          this.notifications.error('Bulk update failed');
        },
      });
  }

  closeRiskPicker(): void {
    this.showRiskPicker.set(false);
    this.pickerSelectedRows.set([]);
    this.pickerClearFn = null;
  }

  /**
   * Queue a Manual-trigger optimization run for every selected strategy.
   * The {@link StrategyFeedbackService.triggerOptimization} call is idempotent
   * — re-triggering a strategy that already has a Queued/Running run returns
   * the existing run id with a 200, so confirming the action only needs the
   * count of rows we'll dispatch to. Each call returns its run id; we tally
   * successes and surface skipped/duplicates in the notification.
   */
  bulkRunOptimization(rows: StrategyDto[], clear: () => void): void {
    if (this.bulkBusy() || rows.length === 0) return;
    const n = rows.length;
    if (
      !confirm(
        `Queue an optimization run for ${n} strateg${n === 1 ? 'y' : 'ies'}? ` +
          `Strategies that already have a Queued or Running optimization will be skipped (idempotent).`,
      )
    )
      return;

    this.bulkBusy.set(true);
    let succeeded = 0;
    let failed = 0;
    let remaining = rows.length;
    const finish = () => {
      this.bulkBusy.set(false);
      const msg =
        `Optimization queued for ${succeeded} strateg${succeeded === 1 ? 'y' : 'ies'}` +
        (failed > 0 ? ` (${failed} failed)` : '');
      if (failed > 0 && succeeded === 0) this.notifications.error(msg);
      else this.notifications.success(msg);
      clear();
    };

    for (const row of rows) {
      this.feedbackService
        .triggerOptimization({ strategyId: row.id, triggerType: 'Manual' })
        .subscribe({
          next: (res) => {
            if (res?.status) succeeded++;
            else failed++;
            if (--remaining === 0) finish();
          },
          error: () => {
            failed++;
            if (--remaining === 0) finish();
          },
        });
    }
  }

  private getStatusVariant(status: string): { bg: string; color: string } {
    const map: Record<string, { bg: string; color: string }> = {
      Active: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Paused: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Backtesting: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Stopped: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return map[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }

  // ---- Chart Options ----

  readonly equityCurveOptions: EChartsOption = (() => {
    const dates: string[] = [];
    const values: number[] = [];
    let cumulative = 0;
    const base = new Date('2025-01-02');
    for (let i = 0; i < 120; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
      cumulative += (Math.random() - 0.42) * 150;
      values.push(Math.round(cumulative * 100) / 100);
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 60, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { formatter: '${value}' } },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#0071E3', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0, 113, 227, 0.25)' },
                { offset: 1, color: 'rgba(0, 113, 227, 0.02)' },
              ],
            },
          },
        },
      ],
    } as EChartsOption;
  })();

  readonly winRateOptions: EChartsOption = (() => {
    const dates: string[] = [];
    const values: number[] = [];
    const base = new Date('2025-01-02');
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i * 2);
      dates.push(d.toISOString().slice(0, 10));
      values.push(Math.round((45 + Math.random() * 25) * 100) / 100);
    }
    return {
      tooltip: { trigger: 'axis', formatter: '{b}<br/>Win Rate: {c}%' },
      grid: { left: 50, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', min: 30, max: 80, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#34C759', width: 2 },
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 50,
                lineStyle: { color: '#FF9500', type: 'dashed' },
                label: { formatter: '50%' },
              },
            ],
          },
        },
      ],
    } as EChartsOption;
  })();

  readonly profitFactorOptions: EChartsOption = (() => {
    const dates: string[] = [];
    const values: number[] = [];
    const base = new Date('2025-01-02');
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i * 2);
      dates.push(d.toISOString().slice(0, 10));
      values.push(Math.round((0.8 + Math.random() * 1.4) * 100) / 100);
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', min: 0, max: 3, axisLabel: { formatter: '{value}' } },
      visualMap: {
        show: false,
        pieces: [
          { lt: 1.0, color: '#FF3B30' },
          { gte: 1.0, lt: 1.5, color: '#FF9500' },
          { gte: 1.5, color: '#34C759' },
        ],
      },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2 },
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 1.0,
                lineStyle: { color: '#FF3B30', type: 'dashed' },
                label: { formatter: '1.0' },
              },
              {
                yAxis: 1.5,
                lineStyle: { color: '#34C759', type: 'dashed' },
                label: { formatter: '1.5' },
              },
            ],
          },
          markArea: {
            silent: true,
            data: [
              [{ yAxis: 0, itemStyle: { color: 'rgba(255, 59, 48, 0.06)' } }, { yAxis: 1.0 }],
              [{ yAxis: 1.0, itemStyle: { color: 'rgba(255, 149, 0, 0.06)' } }, { yAxis: 1.5 }],
              [{ yAxis: 1.5, itemStyle: { color: 'rgba(52, 199, 89, 0.06)' } }, { yAxis: 3.0 }],
            ],
          },
        },
      ],
    } as EChartsOption;
  })();

  readonly monthlyReturnsOptions: EChartsOption = (() => {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const years = ['2024', '2025'];
    const data: [number, number, number][] = [];
    for (let yi = 0; yi < years.length; yi++) {
      for (let mi = 0; mi < 12; mi++) {
        const val = Math.round((Math.random() - 0.35) * 12 * 100) / 100;
        data.push([mi, yi, val]);
      }
    }
    return {
      tooltip: {
        formatter: (p: any) => {
          const d = p.data;
          return `${months[d[0]]} ${years[d[1]]}<br/>Return: ${d[2] >= 0 ? '+' : ''}${d[2]}%`;
        },
      },
      grid: { left: 60, right: 40, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: months, splitArea: { show: true } },
      yAxis: { type: 'category', data: years, splitArea: { show: true } },
      visualMap: {
        min: -10,
        max: 10,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: {
          color: ['#FF3B30', '#FF6961', '#FFD4D1', '#FFFFFF', '#D1F2D9', '#69D97A', '#34C759'],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: data,
          label: {
            show: true,
            formatter: (p: any) => {
              const v = p.data[2];
              return `${v >= 0 ? '+' : ''}${v}%`;
            },
            fontSize: 10,
          },
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.3)' },
          },
        },
      ],
    } as EChartsOption;
  })();
}

// ── Helpers for the strategy-list inline metrics ──────────────────────────

/** Augmented row shape — fields appended client-side per page. */
type StrategyRowAugment = StrategyDto & {
  healthSeries?: number[];
  latestBt?: BacktestRunDto | null;
  latestWf?: WalkForwardRunDto | null;
  latestOpt?: OptimizationRunDto | null;
  eligibility?: ActivationEligibility;
};

/**
 * Three-tier eligibility verdict shown in the strategies list. The exact
 * thresholds match the project memory's "all 3 legs positive" rule. `Active`
 * isn't a verdict per se — strategies already in flight are tagged separately.
 */
type ActivationEligibility =
  | { kind: 'live'; label: string } // already active / rolling out
  | { kind: 'ready'; reasons: string[] } // all-three-legs green
  | { kind: 'partial'; reasons: string[] } // mixed evidence
  | { kind: 'blocked'; reasons: string[] } // failing or no evidence
  | { kind: 'unknown' };

function pickLatestPerStrategy<T>(
  rows: T[],
  getStrategyId: (r: T) => number,
  getTimestamp: (r: T) => string | null,
): Map<number, T> {
  const out = new Map<number, T>();
  for (const r of rows) {
    const sid = getStrategyId(r);
    if (sid == null) continue;
    const tsStr = getTimestamp(r);
    const ts = tsStr ? Date.parse(tsStr) : 0;
    const prev = out.get(sid);
    if (!prev) {
      out.set(sid, r);
      continue;
    }
    const prevTs = Date.parse(getTimestamp(prev) ?? '');
    if (ts > (Number.isFinite(prevTs) ? prevTs : 0)) out.set(sid, r);
  }
  return out;
}

function computeEligibility(row: StrategyDto, aug: StrategyRowAugment): ActivationEligibility {
  // 1. Already running / rolling out — short-circuit.
  if (row.status === 'Active') {
    const pct = row.rolloutPct;
    return {
      kind: 'live',
      label: pct != null && pct < 100 ? `Rolling out (${pct}%)` : 'Active',
    };
  }
  if (row.lifecycleStage === 'Active' || row.lifecycleStage === 'Approved') {
    return {
      kind: 'live',
      label: row.lifecycleStage === 'Active' ? 'Active' : 'Approved',
    };
  }

  // 2. Three-leg evidence check.
  const reasonsGreen: string[] = [];
  const reasonsRed: string[] = [];

  const opt = aug.latestOpt;
  if (opt) {
    if (
      opt.status === 'Completed' &&
      opt.bestHealthScore != null &&
      opt.baselineHealthScore != null &&
      opt.bestHealthScore > opt.baselineHealthScore
    ) {
      reasonsGreen.push('opt+');
    } else if (opt.status === 'Failed') {
      reasonsRed.push('opt fail');
    } else if (opt.status === 'Completed') {
      reasonsRed.push('opt flat');
    }
  }

  const bt = aug.latestBt;
  if (bt) {
    if (bt.status === 'Completed') {
      const ret = parseTotalReturn(bt.resultJson);
      if (ret != null) {
        if (ret > 0) reasonsGreen.push(`BT +${(ret * 100).toFixed(1)}%`);
        else reasonsRed.push(`BT ${(ret * 100).toFixed(1)}%`);
      } else {
        reasonsRed.push('BT no result');
      }
    } else if (bt.status === 'Failed') {
      reasonsRed.push('BT fail');
    }
  }

  const wf = aug.latestWf;
  if (wf) {
    if (wf.status === 'Completed' && wf.averageOutOfSampleScore != null) {
      if (wf.averageOutOfSampleScore > 0) {
        reasonsGreen.push(`WF +${wf.averageOutOfSampleScore.toFixed(2)}`);
      } else {
        reasonsRed.push(`WF ${wf.averageOutOfSampleScore.toFixed(2)}`);
      }
    } else if (wf.status === 'Failed') {
      reasonsRed.push('WF fail');
    }
  }

  if (reasonsGreen.length === 0 && reasonsRed.length === 0) {
    return { kind: 'unknown' };
  }
  if (reasonsGreen.length === 3 && reasonsRed.length === 0) {
    return { kind: 'ready', reasons: reasonsGreen };
  }
  if (reasonsRed.length === 3 || (reasonsRed.length > 0 && reasonsGreen.length === 0)) {
    return { kind: 'blocked', reasons: reasonsRed };
  }
  return {
    kind: 'partial',
    reasons: [...reasonsGreen, ...reasonsRed],
  };
}

function parseTotalReturn(resultJson: string | null | undefined): number | null {
  if (!resultJson) return null;
  try {
    const v = JSON.parse(resultJson)?.TotalReturn;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

function lifecycleVariant(stage: string): { bg: string; color: string } {
  switch (stage) {
    case 'Active':
      return { bg: 'rgba(31,138,76,0.15)', color: '#1f8a4c' };
    case 'Approved':
      return { bg: 'rgba(34,197,94,0.15)', color: '#15803d' };
    case 'ShadowLive':
      return { bg: 'rgba(59,130,246,0.15)', color: '#1d4ed8' };
    case 'BacktestQualified':
      return { bg: 'rgba(245,158,11,0.15)', color: '#b45309' };
    case 'PaperTrading':
      return { bg: 'rgba(139,92,246,0.15)', color: '#6d28d9' };
    case 'Draft':
      return { bg: 'rgba(120,120,128,0.15)', color: '#52525b' };
    default:
      return { bg: 'rgba(120,120,128,0.10)', color: '#71717a' };
  }
}

function eligibilityVariant(kind: ActivationEligibility['kind']): { bg: string; color: string } {
  switch (kind) {
    case 'live':
      return { bg: 'rgba(31,138,76,0.18)', color: '#0e7c3a' };
    case 'ready':
      return { bg: 'rgba(34,197,94,0.18)', color: '#15803d' };
    case 'partial':
      return { bg: 'rgba(245,158,11,0.18)', color: '#b45309' };
    case 'blocked':
      return { bg: 'rgba(239,68,68,0.15)', color: '#b91c1c' };
    default:
      return { bg: 'rgba(120,120,128,0.10)', color: '#71717a' };
  }
}

function eligibilityLabel(e: ActivationEligibility): string {
  switch (e.kind) {
    case 'live':
      return e.label;
    case 'ready':
      return '✓ Ready';
    case 'partial':
      return 'Partial';
    case 'blocked':
      return 'Blocked';
    default:
      return '—';
  }
}

function eligibilityTooltip(e: ActivationEligibility): string {
  switch (e.kind) {
    case 'live':
      return e.label;
    case 'ready':
      return `All three legs positive: ${e.reasons.join(' · ')}. Promote via the lifecycle ladder.`;
    case 'partial':
      return `Mixed evidence: ${e.reasons.join(' · ')}.`;
    case 'blocked':
      return `Negative evidence: ${e.reasons.join(' · ')}.`;
    default:
      return 'No optimization / backtest / walk-forward results yet.';
  }
}
