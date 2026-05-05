import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { StrategiesService } from '@core/services/strategies.service';
import { PositionsService } from '@core/services/positions.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CreateRiskProfileRequest,
  PagedData,
  PagerRequest,
  PositionDto,
  RiskProfileDto,
  StrategyDto,
  UpdateRiskProfileRequest,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-risk-profiles-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    TabsComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
    MetricCardComponent,
    ChartCardComponent,
    DecimalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Risk Profiles" subtitle="Per-strategy sizing and drawdown limits">
        <button type="button" class="btn btn-primary" (click)="openCreate()">New Profile</button>
      </app-page-header>

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'profiles') {
          @if (editing()) {
            <form class="panel" [formGroup]="form" (ngSubmit)="submit()">
              <div class="panel-head">
                <h3>
                  {{ editing()?.id ? 'Edit Risk Profile #' + editing()!.id : 'New Risk Profile' }}
                </h3>
                <button type="button" class="close" (click)="cancel()" aria-label="Close">
                  &times;
                </button>
              </div>
              <div class="panel-body">
                <app-form-field label="Name" [required]="true" [control]="form.controls.name">
                  <input
                    appFormFieldControl
                    formControlName="name"
                    placeholder="e.g. Conservative"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Lot / Trade"
                  [required]="true"
                  [control]="form.controls.maxLotSizePerTrade"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxLotSizePerTrade"
                    type="number"
                    step="0.01"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Open Positions"
                  [required]="true"
                  [control]="form.controls.maxOpenPositions"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxOpenPositions"
                    type="number"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Daily Trades"
                  [required]="true"
                  [control]="form.controls.maxDailyTrades"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxDailyTrades"
                    type="number"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Daily Drawdown %"
                  [required]="true"
                  [control]="form.controls.maxDailyDrawdownPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxDailyDrawdownPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Total Drawdown %"
                  [required]="true"
                  [control]="form.controls.maxTotalDrawdownPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxTotalDrawdownPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Risk / Trade %"
                  [required]="true"
                  [control]="form.controls.maxRiskPerTradePct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxRiskPerTradePct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Symbol Exposure %"
                  [required]="true"
                  [control]="form.controls.maxSymbolExposurePct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxSymbolExposurePct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Recovery Threshold %"
                  [required]="true"
                  [control]="form.controls.drawdownRecoveryThresholdPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="drawdownRecoveryThresholdPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Recovery Lot Multiplier"
                  [required]="true"
                  [control]="form.controls.recoveryLotSizeMultiplier"
                >
                  <input
                    appFormFieldControl
                    formControlName="recoveryLotSizeMultiplier"
                    type="number"
                    step="0.05"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Recovery Exit Threshold %"
                  [required]="true"
                  [control]="form.controls.recoveryExitThresholdPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="recoveryExitThresholdPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <div class="field checkbox">
                  <label>
                    <input formControlName="isDefault" type="checkbox" />
                    <span>Set as default profile</span>
                  </label>
                </div>

                <div class="section-divider">Signal protection</div>
                <div class="field checkbox">
                  <label>
                    <input formControlName="requireStopLoss" type="checkbox" />
                    <span>Require stop-loss on every signal</span>
                  </label>
                </div>
                <div class="field checkbox">
                  <label>
                    <input formControlName="requireTakeProfit" type="checkbox" />
                    <span>Require take-profit on every signal</span>
                  </label>
                </div>
                <app-form-field
                  label="Min SL distance (pips)"
                  hint="0 disables. Stops tighter than this are likely eaten by spread/slippage."
                  [control]="form.controls.minStopLossDistancePips"
                >
                  <input
                    appFormFieldControl
                    formControlName="minStopLossDistancePips"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Min TP distance (pips)"
                  hint="0 disables. Targets closer than this are eaten by spread/commission."
                  [control]="form.controls.minTakeProfitDistancePips"
                >
                  <input
                    appFormFieldControl
                    formControlName="minTakeProfitDistancePips"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Min risk-reward ratio"
                  hint="0 disables. Calculated as |TP-Entry| / |SL-Entry| when both are set."
                  [control]="form.controls.minRiskRewardRatio"
                >
                  <input
                    appFormFieldControl
                    formControlName="minRiskRewardRatio"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <div class="actions">
                  @if (editing()?.id) {
                    <button
                      type="button"
                      class="btn btn-destructive"
                      (click)="showDeleteDialog.set(true)"
                      [disabled]="busy()"
                    >
                      Delete
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="cancel()"
                    [disabled]="busy()"
                  >
                    Cancel
                  </button>
                  <button type="submit" class="btn btn-primary" [disabled]="busy() || form.invalid">
                    @if (busy()) {
                      <span class="spin"></span>
                    } @else {
                      Save
                    }
                  </button>
                </div>
              </div>
            </form>
          }

          <!-- 8-card KPI strip — fleet-wide risk roll-ups -->
          <div class="rp-kpis">
            <app-metric-card
              label="Total profiles"
              [value]="rpStats().total"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Tightest total DD"
              [value]="rpStats().minTotalDD"
              format="percent"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Loosest total DD"
              [value]="rpStats().maxTotalDD"
              format="percent"
              dotColor="#FF3B30"
            />
            <app-metric-card
              label="Avg risk / trade"
              [value]="rpStats().avgRiskPerTrade"
              format="percent"
              dotColor="#FF9500"
            />
            <app-metric-card
              label="Avg max positions"
              [value]="rpStats().avgMaxPositions"
              format="number"
              dotColor="#AF52DE"
            />
            <app-metric-card
              label="SL required"
              [value]="rpStats().requireSL"
              format="number"
              [dotColor]="rpStats().requireSL === rpStats().total ? '#34C759' : '#FF9500'"
            />
            <app-metric-card
              label="TP required"
              [value]="rpStats().requireTP"
              format="number"
              [dotColor]="rpStats().requireTP === rpStats().total ? '#34C759' : '#FF9500'"
            />
            <app-metric-card
              label="With min RR"
              [value]="rpStats().withMinRR"
              format="number"
              dotColor="#5AC8FA"
            />
          </div>

          <!-- Comparison charts -->
          <div class="rp-charts">
            <app-chart-card
              title="Drawdown limits by profile"
              subtitle="Daily DD vs total DD — green = today's cap, red = lifetime cap"
              [options]="drawdownChartOptions()"
              height="280px"
            />
            <app-chart-card
              title="Sizing parameters by profile"
              subtitle="Risk per trade · max symbol exposure · max lot · positions"
              [options]="sizingChartOptions()"
              height="280px"
            />
          </div>

          <!-- Feature / protection matrix -->
          @if (profilesSample().length > 0) {
            <section class="rp-matrix">
              <header class="rp-matrix-head">
                <h3>Protection feature matrix</h3>
                <span class="muted">
                  Required guards on signal validation — green ✓, gray inactive
                </span>
              </header>
              <table class="rp-matrix-table">
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th class="num">Risk/Trade</th>
                    <th class="num">Symbol exp.</th>
                    <th>SL required</th>
                    <th>TP required</th>
                    <th class="num">Min SL pips</th>
                    <th class="num">Min TP pips</th>
                    <th class="num">Min RR</th>
                    <th class="num">Recovery thr.</th>
                    <th class="num">Recov. mult.</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of profilesSample(); track p.id) {
                    <tr>
                      <td class="mono">{{ p.name }}</td>
                      <td class="num mono">{{ p.maxRiskPerTradePct.toFixed(1) }}%</td>
                      <td class="num mono">{{ p.maxSymbolExposurePct.toFixed(1) }}%</td>
                      <td>
                        <span class="rp-pill" [class.on]="p.requireStopLoss">
                          {{ p.requireStopLoss ? '✓' : '—' }}
                        </span>
                      </td>
                      <td>
                        <span class="rp-pill" [class.on]="p.requireTakeProfit">
                          {{ p.requireTakeProfit ? '✓' : '—' }}
                        </span>
                      </td>
                      <td class="num mono">
                        {{ p.minStopLossDistancePips > 0 ? p.minStopLossDistancePips : '—' }}
                      </td>
                      <td class="num mono">
                        {{ p.minTakeProfitDistancePips > 0 ? p.minTakeProfitDistancePips : '—' }}
                      </td>
                      <td class="num mono">
                        {{ p.minRiskRewardRatio > 0 ? p.minRiskRewardRatio.toFixed(2) : '—' }}
                      </td>
                      <td class="num mono">{{ p.drawdownRecoveryThresholdPct.toFixed(1) }}%</td>
                      <td class="num mono">{{ p.recoveryLotSizeMultiplier.toFixed(2) }}×</td>
                      <td>
                        @if (p.isDefault) {
                          <span class="rp-pill default">Default</span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }

          <app-data-table
            #table
            [columnDefs]="columns"
            [fetchData]="fetchData"
            (rowClick)="openEdit($event)"
          />
        }

        @if (activeTab() === 'monitor') {
          <!-- 8-card portfolio-risk KPI strip -->
          <div class="rp-kpis">
            <app-metric-card
              label="Profiles in use"
              [value]="monitorKpis().profilesInUse"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Profiles unused"
              [value]="monitorKpis().profilesUnused"
              format="number"
              dotColor="#8E8E93"
            />
            <app-metric-card
              label="Strategies bound"
              [value]="monitorKpis().strategiesBound"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Strategies orphaned"
              [value]="monitorKpis().strategiesOrphaned"
              format="number"
              [dotColor]="monitorKpis().strategiesOrphaned > 0 ? '#FF9500' : '#34C759'"
            />
            <app-metric-card
              label="Open positions"
              [value]="monitorKpis().openPositions"
              format="number"
              dotColor="#5AC8FA"
            />
            <app-metric-card
              label="Long positions"
              [value]="monitorKpis().longPositions"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Short positions"
              [value]="monitorKpis().shortPositions"
              format="number"
              dotColor="#FF3B30"
            />
            <app-metric-card
              label="Unrealized P&L"
              [value]="monitorKpis().totalUnrealized"
              format="currency"
              [colorByValue]="true"
              dotColor="#30D158"
            />
          </div>

          <!-- 2-col chart row: positions by symbol + profile binding donut -->
          <div class="rp-charts">
            <app-chart-card
              title="Open positions by symbol"
              subtitle="Total open lots aggregated per symbol — concentration risk view"
              [options]="positionsBySymbolOptions()"
              height="280px"
            />
            <app-chart-card
              title="Strategy → profile binding"
              subtitle="How many strategies use each risk profile"
              [options]="profileBindingDonutOptions()"
              height="280px"
            />
          </div>

          <!-- Per-profile utilization board -->
          <section class="rp-matrix">
            <header class="rp-matrix-head">
              <h3>Profile utilization</h3>
              <span class="muted">
                Strategy + position counts per profile · "Used" highlights profiles with bound
                strategies
              </span>
            </header>
            @if (profileUtilization().length > 0) {
              <table class="rp-matrix-table">
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th class="num">Strategies</th>
                    <th class="num">Active</th>
                    <th class="num">Open positions*</th>
                    <th class="num">Risk/trade</th>
                    <th class="num">Daily DD cap</th>
                    <th class="num">Total DD cap</th>
                    <th>Usage</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of profileUtilization(); track row.id) {
                    <tr>
                      <td class="mono">
                        {{ row.name }}
                        @if (row.isDefault) {
                          <span class="rp-pill default" style="margin-left:6px">Default</span>
                        }
                      </td>
                      <td class="num mono">{{ row.strategies }}</td>
                      <td class="num mono">{{ row.activeStrategies }}</td>
                      <td class="num mono">{{ row.openPositions }}</td>
                      <td class="num mono">{{ row.maxRiskPerTradePct.toFixed(1) }}%</td>
                      <td class="num mono">{{ row.maxDailyDrawdownPct.toFixed(1) }}%</td>
                      <td class="num mono">{{ row.maxTotalDrawdownPct.toFixed(1) }}%</td>
                      <td>
                        <span class="rp-pill" [class.on]="row.strategies > 0">
                          {{ row.strategies > 0 ? 'Used' : 'Unused' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
              <p class="footnote">
                * Open-position counts are fleet-wide because positions don't carry a strategy
                attribution in the API yet — when that lands, this column resolves to per-profile
                exposure.
              </p>
            } @else {
              <p class="muted" style="padding: var(--space-4)">Loading risk profiles…</p>
            }
          </section>

          <!-- Strategy ↔ profile assignment table -->
          <section class="rp-matrix">
            <header class="rp-matrix-head">
              <h3>Strategy assignment</h3>
              <span class="muted">
                Showing first {{ assignmentRows().length }} strategies · orphans (no profile) row to
                top
              </span>
            </header>
            @if (assignmentRows().length > 0) {
              <table class="rp-matrix-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th>Status</th>
                    <th>Risk profile</th>
                    <th class="num">Risk/trade</th>
                    <th class="num">Max pos</th>
                    <th class="num">Daily DD</th>
                    <th class="num">Total DD</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of assignmentRows(); track row.strategyId) {
                    <tr>
                      <td class="mono">{{ row.strategyName }}</td>
                      <td class="mono">{{ row.symbol ?? '—' }}</td>
                      <td>
                        <span
                          class="rp-pill"
                          [class.on]="row.status === 'Active'"
                          [class.warn]="row.status === 'Paused'"
                        >
                          {{ row.status }}
                        </span>
                      </td>
                      <td class="mono">
                        @if (row.profileName) {
                          {{ row.profileName }}
                        } @else {
                          <span class="rp-pill warn">Orphan</span>
                        }
                      </td>
                      <td class="num mono">
                        {{
                          row.maxRiskPerTradePct !== null
                            ? row.maxRiskPerTradePct.toFixed(1) + '%'
                            : '—'
                        }}
                      </td>
                      <td class="num mono">
                        {{ row.maxOpenPositions ?? '—' }}
                      </td>
                      <td class="num mono">
                        {{
                          row.maxDailyDrawdownPct !== null
                            ? row.maxDailyDrawdownPct.toFixed(1) + '%'
                            : '—'
                        }}
                      </td>
                      <td class="num mono">
                        {{
                          row.maxTotalDrawdownPct !== null
                            ? row.maxTotalDrawdownPct.toFixed(1) + '%'
                            : '—'
                        }}
                      </td>
                      <td>
                        <span class="rp-pill" [class.on]="row.guarded" [class.warn]="!row.guarded">
                          {{ row.guarded ? 'Guarded' : 'Unguarded' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted" style="padding: var(--space-4)">Loading strategies…</p>
            }
          </section>

          <!-- Open positions feed — live exposure list -->
          <section class="rp-matrix">
            <header class="rp-matrix-head">
              <h3>Open positions</h3>
              <span class="muted"> Live exposure — sorted by absolute unrealized P&L </span>
            </header>
            @if (sortedOpenPositions().length > 0) {
              <table class="rp-matrix-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Direction</th>
                    <th class="num">Lots</th>
                    <th class="num">Entry</th>
                    <th class="num">Current</th>
                    <th class="num">Unrealized P&L</th>
                    <th class="num">SL</th>
                    <th class="num">TP</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of sortedOpenPositions(); track p.id) {
                    <tr>
                      <td class="mono">{{ p.symbol }}</td>
                      <td
                        class="mono"
                        [class.profit]="String(p.direction) === 'Long'"
                        [class.loss]="String(p.direction) === 'Short'"
                      >
                        {{ p.direction }}
                      </td>
                      <td class="num mono">{{ p.openLots | number: '1.2-2' }}</td>
                      <td class="num mono">{{ p.averageEntryPrice | number: '1.5-5' }}</td>
                      <td class="num mono">
                        {{ p.currentPrice !== null ? (p.currentPrice | number: '1.5-5') : '—' }}
                      </td>
                      <td
                        class="num mono"
                        [class.profit]="p.unrealizedPnL > 0"
                        [class.loss]="p.unrealizedPnL < 0"
                      >
                        {{ p.unrealizedPnL >= 0 ? '+' : '' }}{{ p.unrealizedPnL | number: '1.2-2' }}
                      </td>
                      <td class="num mono">
                        {{ p.stopLoss !== null ? (p.stopLoss | number: '1.5-5') : '—' }}
                      </td>
                      <td class="num mono">
                        {{ p.takeProfit !== null ? (p.takeProfit | number: '1.5-5') : '—' }}
                      </td>
                      <td class="mono">
                        {{ p.openedAt ? p.openedAt.slice(0, 16).replace('T', ' ') : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted" style="padding: var(--space-4)">
                No open positions across the fleet right now.
              </p>
            }
          </section>
        }
      </ui-tabs>

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Risk Profile"
        [message]="
          'Delete ' +
          (editing()?.name ?? 'this profile') +
          '? Strategies using it will lose their risk binding.'
        "
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="onDelete()"
        (cancelled)="showDeleteDialog.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
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
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-destructive {
        background: var(--loss);
        color: white;
        margin-right: auto;
      }
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
      }
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .close {
        background: transparent;
        border: none;
        font-size: 20px;
        color: var(--text-secondary);
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
      }
      .close:hover {
        background: var(--bg-tertiary);
      }
      .panel-body {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--space-4);
        padding: var(--space-5);
      }
      .field {
        display: flex;
        flex-direction: column;
      }
      .field.checkbox {
        flex-direction: row;
        align-items: center;
        justify-content: flex-start;
      }
      .section-divider {
        margin-top: var(--space-3);
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .field.checkbox label {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .field label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .actions {
        grid-column: 1 / -1;
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
        margin-top: var(--space-2);
      }
      .spin {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      /* Risk-profiles density additions */
      .rp-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1400px) {
        .rp-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .rp-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .rp-charts {
        display: grid;
        grid-template-columns: 1fr 1.4fr;
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1100px) {
        .rp-charts {
          grid-template-columns: 1fr;
        }
      }

      .rp-matrix {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-4);
      }
      /* Form panel inside the tab — keep its own breathing room. */
      .panel {
        margin-bottom: var(--space-4);
      }
      .rp-matrix-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .rp-matrix-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .rp-matrix-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .rp-matrix-table {
        width: 100%;
        border-collapse: collapse;
      }
      .rp-matrix-table th,
      .rp-matrix-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .rp-matrix-table tbody tr:last-child td {
        border-bottom: none;
      }
      .rp-matrix-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .rp-matrix-table th.num,
      .rp-matrix-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .rp-matrix-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .rp-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px 8px;
        min-width: 28px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        font-size: 11px;
        font-weight: var(--font-semibold);
      }
      .rp-pill.on {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .rp-pill.warn {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .rp-pill.default {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .footnote {
        margin: var(--space-2) var(--space-4);
        font-size: 10.5px;
        color: var(--text-tertiary);
      }
      .rp-matrix-table .profit {
        color: var(--profit);
      }
      .rp-matrix-table .loss {
        color: var(--loss);
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class RiskProfilesPageComponent implements OnInit {
  private readonly service = inject(RiskProfilesService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly positionsService = inject(PositionsService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  // Exposed for template `[class.profit]="String(...) === 'Long'"` checks.
  readonly String = String;

  constructor() {
    // Lazy-load monitor data the first time the user opens the Risk Monitor
    // tab. Refresh on every revisit is overkill — guarded by `monitorLoaded`.
    effect(() => {
      if (this.activeTab() === 'monitor') this.loadMonitorData();
    });
  }

  @ViewChild('table') table?: DataTableComponent<RiskProfileDto>;

  readonly tabs: TabItem[] = [
    { label: 'Risk Profiles', value: 'profiles' },
    { label: 'Risk Monitor', value: 'monitor' },
  ];
  readonly activeTab = signal('profiles');

  readonly editing = signal<RiskProfileDto | Partial<RiskProfileDto> | null>(null);
  readonly busy = signal(false);
  readonly showDeleteDialog = signal(false);

  // Analytics sample — separate from the paged data-table source so the KPI
  // strip + chart row stay stable as the user pages or filters the grid.
  readonly profilesSample = signal<RiskProfileDto[]>([]);

  rpStats = computed(() => {
    const rows = this.profilesSample();
    if (rows.length === 0) {
      return {
        total: 0,
        minTotalDD: null as number | null,
        maxTotalDD: null as number | null,
        avgRiskPerTrade: null as number | null,
        avgMaxPositions: null as number | null,
        requireSL: 0,
        requireTP: 0,
        withMinRR: 0,
      };
    }
    const totalDDs = rows.map((r) => r.maxTotalDrawdownPct);
    const risks = rows.map((r) => r.maxRiskPerTradePct);
    const positions = rows.map((r) => r.maxOpenPositions);
    return {
      total: rows.length,
      minTotalDD: +Math.min(...totalDDs).toFixed(2),
      maxTotalDD: +Math.max(...totalDDs).toFixed(2),
      avgRiskPerTrade: +(risks.reduce((a, b) => a + b, 0) / rows.length).toFixed(2),
      avgMaxPositions: +(positions.reduce((a, b) => a + b, 0) / rows.length).toFixed(1),
      requireSL: rows.filter((r) => r.requireStopLoss).length,
      requireTP: rows.filter((r) => r.requireTakeProfit).length,
      withMinRR: rows.filter((r) => r.minRiskRewardRatio > 0).length,
    };
  });

  drawdownChartOptions = computed<EChartsOption>(() => {
    const rows = this.profilesSample();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 30, right: 30, bottom: 30, left: 110 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.name ?? `#${r.id}`).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          name: 'Daily DD',
          type: 'bar',
          data: rows.map((r) => +r.maxDailyDrawdownPct.toFixed(2)).reverse(),
          itemStyle: { color: '#34C759', borderRadius: [0, 4, 4, 0] },
          barWidth: 9,
          barGap: '20%',
        },
        {
          name: 'Total DD',
          type: 'bar',
          data: rows.map((r) => +r.maxTotalDrawdownPct.toFixed(2)).reverse(),
          itemStyle: { color: '#FF3B30', borderRadius: [0, 4, 4, 0] },
          barWidth: 9,
        },
      ],
    };
  });

  sizingChartOptions = computed<EChartsOption>(() => {
    const rows = this.profilesSample();
    if (rows.length === 0) return {};
    const names = rows.map((r) => r.name ?? `#${r.id}`);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 30, right: 30, bottom: 30, left: 60 },
      xAxis: {
        type: 'category',
        data: names,
        axisLabel: { fontSize: 10, color: '#6E6E73', interval: 0, rotate: 20 },
      },
      yAxis: [
        {
          type: 'value',
          name: '%',
          nameTextStyle: { fontSize: 10, color: '#6E6E73' },
          axisLabel: { fontSize: 10, color: '#6E6E73' },
          splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        },
        {
          type: 'value',
          name: 'count',
          position: 'right',
          nameTextStyle: { fontSize: 10, color: '#6E6E73' },
          axisLabel: { fontSize: 10, color: '#6E6E73' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Risk / trade %',
          type: 'bar',
          data: rows.map((r) => +r.maxRiskPerTradePct.toFixed(2)),
          itemStyle: { color: '#FF9500', borderRadius: [4, 4, 0, 0] },
          barWidth: 12,
        },
        {
          name: 'Max symbol exp. %',
          type: 'bar',
          data: rows.map((r) => +r.maxSymbolExposurePct.toFixed(2)),
          itemStyle: { color: '#AF52DE', borderRadius: [4, 4, 0, 0] },
          barWidth: 12,
        },
        {
          name: 'Max positions',
          type: 'line',
          yAxisIndex: 1,
          data: rows.map((r) => r.maxOpenPositions),
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
        {
          name: 'Max lot',
          type: 'line',
          yAxisIndex: 1,
          data: rows.map((r) => r.maxLotSizePerTrade),
          symbol: 'rect',
          symbolSize: 8,
          lineStyle: { color: '#5AC8FA', width: 2, type: 'dashed' },
          itemStyle: { color: '#5AC8FA' },
        },
      ],
    };
  });

  // Risk Monitor tab — lazy-loaded fleet snapshots.
  readonly monitorStrategies = signal<StrategyDto[]>([]);
  readonly monitorPositions = signal<PositionDto[]>([]);
  private monitorLoaded = false;

  monitorKpis = computed(() => {
    const profiles = this.profilesSample();
    const strategies = this.monitorStrategies();
    const positions = this.monitorPositions();
    const profileIdsBound = new Set(
      strategies.filter((s) => s.riskProfileId != null).map((s) => s.riskProfileId as number),
    );
    let longPositions = 0;
    let shortPositions = 0;
    let totalUnrealized = 0;
    for (const p of positions) {
      if (String(p.direction) === 'Long') longPositions++;
      else if (String(p.direction) === 'Short') shortPositions++;
      totalUnrealized += p.unrealizedPnL ?? 0;
    }
    return {
      profilesInUse: profileIdsBound.size,
      profilesUnused: Math.max(0, profiles.length - profileIdsBound.size),
      strategiesBound: strategies.filter((s) => s.riskProfileId != null).length,
      strategiesOrphaned: strategies.filter((s) => s.riskProfileId == null).length,
      openPositions: positions.length,
      longPositions,
      shortPositions,
      totalUnrealized: +totalUnrealized.toFixed(2),
    };
  });

  positionsBySymbolOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const p of this.monitorPositions()) {
      const k = p.symbol ?? 'unknown';
      map[k] = (map[k] ?? 0) + (p.openLots ?? 0);
    }
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
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
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: +v.toFixed(2),
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => p.value.toFixed(2),
          },
        },
      ],
    };
  });

  profileBindingDonutOptions = computed<EChartsOption>(() => {
    const profiles = this.profilesSample();
    const strategies = this.monitorStrategies();
    if (profiles.length === 0) return {};
    const counts: Record<number, number> = {};
    let orphans = 0;
    for (const s of strategies) {
      if (s.riskProfileId == null) orphans++;
      else counts[s.riskProfileId] = (counts[s.riskProfileId] ?? 0) + 1;
    }
    const palette = ['#0071E3', '#34C759', '#FF9500', '#AF52DE', '#5AC8FA', '#FF2D55', '#30D158'];
    const data: { name: string; value: number; itemStyle: { color: string } }[] = profiles.map(
      (p, i) => ({
        name: p.name ?? `#${p.id}`,
        value: counts[p.id] ?? 0,
        itemStyle: { color: palette[i % palette.length] },
      }),
    );
    if (orphans > 0) {
      data.push({ name: 'Orphan', value: orphans, itemStyle: { color: '#8E8E93' } });
    }
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
          data: data.filter((d) => d.value > 0),
        },
      ],
    };
  });

  profileUtilization = computed(() => {
    const strategies = this.monitorStrategies();
    const openPositionsTotal = this.monitorPositions().length;
    return this.profilesSample().map((p) => {
      const bound = strategies.filter((s) => s.riskProfileId === p.id);
      return {
        id: p.id,
        name: p.name ?? `#${p.id}`,
        isDefault: p.isDefault,
        strategies: bound.length,
        activeStrategies: bound.filter((s) => String(s.status) === 'Active').length,
        openPositions: openPositionsTotal, // fleet-wide until positions carry strategyId
        maxRiskPerTradePct: p.maxRiskPerTradePct,
        maxDailyDrawdownPct: p.maxDailyDrawdownPct,
        maxTotalDrawdownPct: p.maxTotalDrawdownPct,
      };
    });
  });

  assignmentRows = computed(() => {
    const profiles = this.profilesSample();
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const rows = this.monitorStrategies().map((s) => {
      const profile = s.riskProfileId != null ? profileById.get(s.riskProfileId) : undefined;
      return {
        strategyId: s.id,
        strategyName: s.name ?? `Strategy #${s.id}`,
        symbol: s.symbol,
        status: String(s.status),
        profileName: profile?.name ?? null,
        maxRiskPerTradePct: profile?.maxRiskPerTradePct ?? null,
        maxOpenPositions: profile?.maxOpenPositions ?? null,
        maxDailyDrawdownPct: profile?.maxDailyDrawdownPct ?? null,
        maxTotalDrawdownPct: profile?.maxTotalDrawdownPct ?? null,
        guarded: !!profile && (profile.requireStopLoss || profile.requireTakeProfit),
      };
    });
    // Float orphans to the top so missing risk-profile bindings are obvious.
    return rows
      .sort((a, b) => {
        if (!a.profileName && b.profileName) return -1;
        if (a.profileName && !b.profileName) return 1;
        return a.strategyName.localeCompare(b.strategyName);
      })
      .slice(0, 50);
  });

  sortedOpenPositions = computed(() =>
    [...this.monitorPositions()].sort(
      (a, b) => Math.abs(b.unrealizedPnL ?? 0) - Math.abs(a.unrealizedPnL ?? 0),
    ),
  );

  ngOnInit(): void {
    this.loadProfilesSample();
  }

  private loadProfilesSample(): void {
    this.service.list({ currentPage: 1, itemCountPerPage: 100, filter: null }).subscribe({
      next: (res) => {
        if (res?.data?.data) this.profilesSample.set(res.data.data);
      },
    });
  }

  private loadMonitorData(): void {
    if (this.monitorLoaded) return;
    this.monitorLoaded = true;

    // Profiles already loaded on mount; only fetch the strategy + position
    // snapshots the monitor needs. Both calls are independent and forgiving.
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200, filter: null }).subscribe({
      next: (res) => {
        this.monitorStrategies.set(res?.data?.data ?? []);
      },
      error: () => {
        this.monitorLoaded = false;
      },
    });

    this.positionsService
      .list({ currentPage: 1, itemCountPerPage: 200, filter: { status: 'Open' } })
      .subscribe({
        next: (res) => {
          this.monitorPositions.set(res?.data?.data ?? []);
        },
        error: () => {
          this.monitorLoaded = false;
        },
      });
  }

  readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    maxLotSizePerTrade: [1, [Validators.required, Validators.min(0)]],
    maxOpenPositions: [5, [Validators.required, Validators.min(0)]],
    maxDailyTrades: [20, [Validators.required, Validators.min(0)]],
    maxDailyDrawdownPct: [2.0, [Validators.required, Validators.min(0)]],
    maxTotalDrawdownPct: [10.0, [Validators.required, Validators.min(0)]],
    maxRiskPerTradePct: [1.0, [Validators.required, Validators.min(0)]],
    maxSymbolExposurePct: [25.0, [Validators.required, Validators.min(0)]],
    drawdownRecoveryThresholdPct: [5.0, [Validators.required, Validators.min(0)]],
    recoveryLotSizeMultiplier: [0.5, [Validators.required, Validators.min(0)]],
    recoveryExitThresholdPct: [2.0, [Validators.required, Validators.min(0)]],
    isDefault: [false],
    requireStopLoss: [true],
    requireTakeProfit: [true],
    minStopLossDistancePips: [0, [Validators.min(0)]],
    minTakeProfitDistancePips: [0, [Validators.min(0)]],
    minRiskRewardRatio: [0, [Validators.min(0)]],
  });

  readonly columns: ColDef<RiskProfileDto>[] = [
    { headerName: 'Name', field: 'name', flex: 1, minWidth: 160 },
    {
      headerName: 'Max Lot',
      field: 'maxLotSizePerTrade',
      width: 100,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    { headerName: 'Max Pos', field: 'maxOpenPositions', width: 100 },
    { headerName: 'Daily Trd', field: 'maxDailyTrades', width: 100 },
    {
      headerName: 'Risk/Trd',
      field: 'maxRiskPerTradePct',
      width: 100,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'Daily DD',
      field: 'maxDailyDrawdownPct',
      width: 100,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'Total DD',
      field: 'maxTotalDrawdownPct',
      width: 100,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'Sym exp.',
      field: 'maxSymbolExposurePct',
      width: 100,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'Recov. thr.',
      field: 'drawdownRecoveryThresholdPct',
      width: 110,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'Recov. mult.',
      field: 'recoveryLotSizeMultiplier',
      width: 110,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(2)}×` : '-'),
    },
    {
      headerName: 'Recov. exit',
      field: 'recoveryExitThresholdPct',
      width: 110,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'SL',
      field: 'requireStopLoss',
      width: 70,
      cellRenderer: (p: { value: unknown }) =>
        p.value
          ? `<span style="color:#248A3D;font-weight:700">✓</span>`
          : `<span style="color:#8E8E93">—</span>`,
    },
    {
      headerName: 'TP',
      field: 'requireTakeProfit',
      width: 70,
      cellRenderer: (p: { value: unknown }) =>
        p.value
          ? `<span style="color:#248A3D;font-weight:700">✓</span>`
          : `<span style="color:#8E8E93">—</span>`,
    },
    {
      headerName: 'Min RR',
      field: 'minRiskRewardRatio',
      width: 90,
      valueFormatter: (p) =>
        p.value != null && (p.value as number) > 0 ? (p.value as number).toFixed(2) : '—',
    },
    {
      headerName: 'Default',
      field: 'isDefault',
      width: 100,
      cellRenderer: (p: { value: unknown }) =>
        p.value
          ? `<span style="background:rgba(0,113,227,0.12);color:#0040DD;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">Default</span>`
          : '',
    },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<RiskProfileDto>> =>
    this.service.list(params).pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  openCreate(): void {
    this.form.reset({
      name: '',
      maxLotSizePerTrade: 1,
      maxOpenPositions: 5,
      maxDailyTrades: 20,
      maxDailyDrawdownPct: 2.0,
      maxTotalDrawdownPct: 10.0,
      maxRiskPerTradePct: 1.0,
      maxSymbolExposurePct: 25.0,
      drawdownRecoveryThresholdPct: 5.0,
      recoveryLotSizeMultiplier: 0.5,
      recoveryExitThresholdPct: 2.0,
      isDefault: false,
      requireStopLoss: true,
      requireTakeProfit: true,
      minStopLossDistancePips: 0,
      minTakeProfitDistancePips: 0,
      minRiskRewardRatio: 0,
    });
    this.editing.set({});
  }

  openEdit(row: RiskProfileDto): void {
    this.form.reset({
      name: row.name ?? '',
      maxLotSizePerTrade: row.maxLotSizePerTrade,
      maxOpenPositions: row.maxOpenPositions,
      maxDailyTrades: row.maxDailyTrades,
      maxDailyDrawdownPct: row.maxDailyDrawdownPct,
      maxTotalDrawdownPct: row.maxTotalDrawdownPct,
      maxRiskPerTradePct: row.maxRiskPerTradePct,
      maxSymbolExposurePct: row.maxSymbolExposurePct,
      drawdownRecoveryThresholdPct: row.drawdownRecoveryThresholdPct,
      recoveryLotSizeMultiplier: row.recoveryLotSizeMultiplier,
      recoveryExitThresholdPct: row.recoveryExitThresholdPct,
      isDefault: row.isDefault,
      requireStopLoss: row.requireStopLoss,
      requireTakeProfit: row.requireTakeProfit,
      minStopLossDistancePips: row.minStopLossDistancePips,
      minTakeProfitDistancePips: row.minTakeProfitDistancePips,
      minRiskRewardRatio: row.minRiskRewardRatio,
    });
    this.editing.set(row);
  }

  cancel(): void {
    this.editing.set(null);
  }

  submit(): void {
    const v = this.form.getRawValue();
    const editing = this.editing();
    this.busy.set(true);
    const payload = {
      name: v.name,
      maxLotSizePerTrade: v.maxLotSizePerTrade,
      maxDailyDrawdownPct: v.maxDailyDrawdownPct,
      maxTotalDrawdownPct: v.maxTotalDrawdownPct,
      maxOpenPositions: v.maxOpenPositions,
      maxDailyTrades: v.maxDailyTrades,
      maxRiskPerTradePct: v.maxRiskPerTradePct,
      maxSymbolExposurePct: v.maxSymbolExposurePct,
      drawdownRecoveryThresholdPct: v.drawdownRecoveryThresholdPct,
      recoveryLotSizeMultiplier: v.recoveryLotSizeMultiplier,
      recoveryExitThresholdPct: v.recoveryExitThresholdPct,
      isDefault: v.isDefault,
      requireStopLoss: v.requireStopLoss,
      requireTakeProfit: v.requireTakeProfit,
      minStopLossDistancePips: v.minStopLossDistancePips,
      minTakeProfitDistancePips: v.minTakeProfitDistancePips,
      minRiskRewardRatio: v.minRiskRewardRatio,
    };
    const op =
      editing && 'id' in editing && editing.id != null
        ? this.service.update(editing.id, payload as UpdateRiskProfileRequest)
        : this.service.create(payload as CreateRiskProfileRequest);
    op.subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(
            editing && 'id' in editing ? 'Profile updated' : 'Profile created',
          );
          this.editing.set(null);
          this.table?.loadData();
          this.loadProfilesSample();
        } else {
          this.notifications.error(res.message ?? 'Save failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  onDelete(): void {
    const editing = this.editing();
    if (!editing || !('id' in editing) || editing.id == null) return;
    this.busy.set(true);
    this.service.delete(editing.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success('Profile deleted');
          this.editing.set(null);
          this.table?.loadData();
          this.loadProfilesSample();
        } else {
          this.notifications.error(res.message ?? 'Delete failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.showDeleteDialog.set(false);
      },
    });
  }
}

function emptyPager() {
  return {
    totalItemCount: 0,
    filter: null,
    currentPage: 1,
    itemCountPerPage: 25,
    pageNo: 1,
    pageSize: 25,
  };
}
