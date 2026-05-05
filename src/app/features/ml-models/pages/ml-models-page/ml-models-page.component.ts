import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
  viewChild,
  ElementRef,
  DestroyRef,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  FormsModule,
  ReactiveFormsModule,
  FormBuilder,
  Validators,
  type AbstractControl,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ColDef } from 'ag-grid-community';
import { catchError, map, of, switchMap, throttleTime } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { createPolledResource } from '@core/polling/polled-resource';

import { MLModelsService } from '@core/services/ml-models.service';
import { MLEvaluationService } from '@core/services/ml-evaluation.service';
import { MarketDataService } from '@core/services/market-data.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  CandleCoverageDto,
  MLModelDto,
  MLTrainingRunDto,
  MLTrainingRunDiagnosticsDto,
  ShadowEvaluationDto,
  MLSignalAbTestResultDto,
  PagedData,
  PagerRequest,
  RunStatus,
  TriggerMLTrainingRequest,
  StartShadowEvaluationRequest,
  Timeframe,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, type TabItem } from '@shared/components/ui/tabs/tabs.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-ml-models-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
    FormFieldComponent,
    FormFieldControlDirective,
    DatePipe,
    DecimalPipe,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="ML Models"
        subtitle="Model registry, monitoring, training, and shadow evaluation"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        <!-- ========== MODEL REGISTRY TAB ========== -->
        @if (activeTab() === 'registry') {
          <div class="tab-content">
            <!-- 8-card KPI strip — fleet-wide model registry roll-ups -->
            <div class="ml-kpis">
              <div class="ml-kpi">
                <span class="ml-kpi-label">Total models</span>
                <span class="ml-kpi-value">{{ modelStats().total }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Active</span>
                <span class="ml-kpi-value good">{{ modelStats().active }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Training</span>
                <span class="ml-kpi-value info">{{ modelStats().training }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Superseded</span>
                <span class="ml-kpi-value muted-val">{{ modelStats().superseded }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Failed</span>
                <span
                  class="ml-kpi-value"
                  [class.bad]="modelStats().failed > 0"
                  [class.good]="modelStats().failed === 0"
                >
                  {{ modelStats().failed }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Avg accuracy</span>
                <span class="ml-kpi-value">
                  {{
                    modelStats().avgAccuracy !== null
                      ? modelStats().avgAccuracy!.toFixed(1) + '%'
                      : '—'
                  }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Best accuracy</span>
                <span class="ml-kpi-value good">
                  {{
                    modelStats().bestAccuracy !== null
                      ? modelStats().bestAccuracy!.toFixed(1) + '%'
                      : '—'
                  }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Symbols × TF</span>
                <span class="ml-kpi-value">
                  {{ modelStats().symbolCount }} × {{ modelStats().timeframeCount }}
                </span>
              </div>
            </div>

            <!-- 3-col chart row: status donut + accuracy histogram + models by symbol -->
            <div class="ml-charts">
              <app-chart-card
                title="Status distribution"
                subtitle="Active · Training · Superseded · Failed"
                [options]="statusDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="Accuracy distribution"
                subtitle="Histogram of direction accuracy across the fleet"
                [options]="accuracyHistogramOptions()"
                height="240px"
              />
              <app-chart-card
                title="Models by symbol"
                subtitle="Top 12 symbols by model count"
                [options]="bySymbolOptions()"
                height="240px"
              />
            </div>

            <!-- 2-col rows: top performers + underperformers -->
            <div class="ml-board-row">
              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Top performers</h3>
                  <span class="muted">Highest direction accuracy across all models</span>
                </header>
                @if (topPerformers().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>TF</th>
                        <th>Version</th>
                        <th class="num">Accuracy</th>
                        <th class="num">RMSE</th>
                        <th class="num">Samples</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (m of topPerformers(); track m.id) {
                        <tr (click)="onModelSelect(m)">
                          <td class="mono">{{ m.symbol }}</td>
                          <td class="mono">{{ m.timeframe }}</td>
                          <td class="mono trunc">{{ m.modelVersion }}</td>
                          <td class="num mono profit">
                            {{ (m.directionAccuracy ?? 0).toFixed(1) }}%
                          </td>
                          <td class="num mono">
                            {{ m.magnitudeRMSE !== null ? m.magnitudeRMSE.toFixed(2) : '—' }}
                          </td>
                          <td class="num mono">{{ m.trainingSamples }}</td>
                          <td>
                            <span class="ml-pill" [attr.data-status]="m.status">{{
                              m.status
                            }}</span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="muted" style="padding: var(--space-4)">Loading model analytics…</p>
                }
              </section>

              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Underperformers</h3>
                  <span class="muted">Lowest direction accuracy — candidates for retraining</span>
                </header>
                @if (underperformers().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>TF</th>
                        <th>Version</th>
                        <th class="num">Accuracy</th>
                        <th class="num">RMSE</th>
                        <th class="num">Samples</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (m of underperformers(); track m.id) {
                        <tr (click)="onModelSelect(m)">
                          <td class="mono">{{ m.symbol }}</td>
                          <td class="mono">{{ m.timeframe }}</td>
                          <td class="mono trunc">{{ m.modelVersion }}</td>
                          <td class="num mono loss">
                            {{ (m.directionAccuracy ?? 0).toFixed(1) }}%
                          </td>
                          <td class="num mono">
                            {{ m.magnitudeRMSE !== null ? m.magnitudeRMSE.toFixed(2) : '—' }}
                          </td>
                          <td class="num mono">{{ m.trainingSamples }}</td>
                          <td>
                            <span class="ml-pill" [attr.data-status]="m.status">{{
                              m.status
                            }}</span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>
            </div>

            <!-- Per-symbol/TF summary table -->
            <section class="ml-board">
              <header class="ml-board-head">
                <h3>Per-symbol coverage</h3>
                <span class="muted">
                  Has-active flag tells you which symbol/TF combos are missing a serving model
                </span>
              </header>
              @if (perSymbolBreakdown().length > 0) {
                <table class="ml-board-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="num">Models</th>
                      <th class="num">Active</th>
                      <th class="num">Failed</th>
                      <th class="num">Best accuracy</th>
                      <th class="num">Avg accuracy</th>
                      <th class="num">Total samples</th>
                      <th>Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of perSymbolBreakdown(); track row.symbol) {
                      <tr>
                        <td class="mono">{{ row.symbol }}</td>
                        <td class="num mono">{{ row.count }}</td>
                        <td class="num mono">{{ row.active }}</td>
                        <td class="num mono" [class.loss]="row.failed > 0">{{ row.failed }}</td>
                        <td class="num mono profit">
                          {{ row.bestAccuracy !== null ? row.bestAccuracy.toFixed(1) + '%' : '—' }}
                        </td>
                        <td class="num mono">
                          {{ row.avgAccuracy !== null ? row.avgAccuracy.toFixed(1) + '%' : '—' }}
                        </td>
                        <td class="num mono">{{ row.totalSamples }}</td>
                        <td>
                          <span
                            class="ml-pill"
                            [class.on]="row.active > 0"
                            [class.warn]="row.active === 0"
                          >
                            {{ row.active > 0 ? 'Has active' : 'No active' }}
                          </span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </section>

            <!-- Browse all models — server-paged table with its own filter
                 chrome so it visually owns the inputs that drive it. -->
            <section class="ml-board">
              <header class="ml-board-head">
                <h3>All models</h3>
                <span class="muted">Server-paged registry — filters apply to this table only</span>
              </header>
              <div class="filter-bar">
                <label class="fb-field">
                  <span class="fb-label">Status</span>
                  <select
                    class="filter-select"
                    [ngModel]="filterStatus()"
                    (ngModelChange)="filterStatus.set($event); reloadRegistry()"
                  >
                    <option value="">All</option>
                    <option value="Training">Training</option>
                    <option value="Active">Active</option>
                    <option value="Superseded">Superseded</option>
                    <option value="Failed">Failed</option>
                  </select>
                </label>
                <label class="fb-field">
                  <span class="fb-label">Symbol</span>
                  <input
                    type="text"
                    class="filter-input"
                    placeholder="e.g. EURUSD"
                    [ngModel]="filterSymbol()"
                    (ngModelChange)="filterSymbol.set($event); reloadRegistry()"
                  />
                </label>
                @if (filterStatus() || filterSymbol()) {
                  <button
                    class="btn btn-ghost fb-clear"
                    (click)="filterStatus.set(''); filterSymbol.set(''); reloadRegistry()"
                  >
                    Clear filters
                  </button>
                }
              </div>
              <app-data-table
                #registryTable
                [columnDefs]="registryColumns"
                [fetchData]="fetchModels"
                (rowClick)="onModelSelect($event)"
              />
            </section>
          </div>
        }

        <!-- ========== MODEL MONITOR TAB ========== -->
        @if (activeTab() === 'monitor') {
          <div class="tab-content">
            <div class="monitor-selector">
              <label class="selector-label">Select Model</label>
              <select
                class="filter-select wide"
                [ngModel]="selectedModelId()"
                (ngModelChange)="onMonitorModelChange($event)"
              >
                <option [ngValue]="null">-- Choose a model --</option>
                @for (m of monitorModels(); track m.id) {
                  <option [ngValue]="m.id">
                    {{ m.symbol }} / {{ m.timeframe }} v{{ m.modelVersion }} (ID: {{ m.id }})
                  </option>
                }
              </select>
            </div>

            @if (monitorModel(); as m) {
              <!-- 8-card KPI strip — full model snapshot -->
              <div class="ml-kpis">
                <app-metric-card
                  label="Direction accuracy"
                  [value]="(m.directionAccuracy ?? 0) * 100"
                  format="percent"
                  dotColor="#0071E3"
                />
                <app-metric-card
                  label="Precision (est.)"
                  [value]="(m.directionAccuracy ?? 0) * 0.95 * 100"
                  format="percent"
                  dotColor="#5AC8FA"
                />
                <app-metric-card
                  label="Magnitude RMSE"
                  [value]="m.magnitudeRMSE ?? 0"
                  format="number"
                  dotColor="#34C759"
                />
                <app-metric-card
                  label="Training samples"
                  [value]="m.trainingSamples"
                  format="number"
                  dotColor="#AF52DE"
                />
                <app-metric-card
                  label="Model age (days)"
                  [value]="modelAgeDays()"
                  format="number"
                  [dotColor]="
                    modelAgeDays() !== null && modelAgeDays()! > 30 ? '#FF9500' : '#34C759'
                  "
                />
                <app-metric-card
                  label="Days serving"
                  [value]="daysServing()"
                  format="number"
                  dotColor="#FF2D55"
                />
                <app-metric-card
                  label="Coin-flip lift"
                  [value]="((m.directionAccuracy ?? 0) - 0.5) * 100"
                  format="percent"
                  [dotColor]="(m.directionAccuracy ?? 0) > 0.5 ? '#34C759' : '#FF3B30'"
                  [colorByValue]="true"
                />
                <app-metric-card
                  label="Samples / day"
                  [value]="samplesPerDay()"
                  format="number"
                  dotColor="#5AC8FA"
                />
              </div>

              <!-- Metadata + status strip -->
              <section class="model-meta">
                <div class="mm-cell">
                  <span class="mm-label">Symbol</span>
                  <span class="mm-value mono">{{ m.symbol }}</span>
                </div>
                <div class="mm-cell">
                  <span class="mm-label">Timeframe</span>
                  <span class="mm-value mono">{{ m.timeframe }}</span>
                </div>
                <div class="mm-cell">
                  <span class="mm-label">Version</span>
                  <span class="mm-value mono trunc">{{ m.modelVersion ?? '—' }}</span>
                </div>
                <div class="mm-cell">
                  <span class="mm-label">Status</span>
                  <span class="mm-value">
                    <span class="ml-pill" [attr.data-status]="m.status">{{ m.status }}</span>
                  </span>
                </div>
                <div class="mm-cell">
                  <span class="mm-label">Active</span>
                  <span class="mm-value">
                    <span class="ml-pill" [class.on]="m.isActive" [class.warn]="!m.isActive">
                      {{ m.isActive ? 'Serving' : 'Inactive' }}
                    </span>
                  </span>
                </div>
                <div class="mm-cell">
                  <span class="mm-label">Trained at</span>
                  <span class="mm-value mono">
                    {{ m.trainedAt ? (m.trainedAt | date: 'dd MMM yy HH:mm') : '—' }}
                  </span>
                </div>
                <div class="mm-cell">
                  <span class="mm-label">Activated at</span>
                  <span class="mm-value mono">
                    {{ m.activatedAt ? (m.activatedAt | date: 'dd MMM yy HH:mm') : '—' }}
                  </span>
                </div>
                <div class="mm-cell wide">
                  <span class="mm-label">File path</span>
                  <span class="mm-value mono trunc">{{ m.filePath ?? '—' }}</span>
                </div>
              </section>

              <div class="charts-grid">
                <app-chart-card
                  title="Accuracy Over Time"
                  subtitle="Rolling accuracy with 50% threshold"
                  [options]="accuracyOverTimeOptions"
                  height="300px"
                />
                <app-chart-card
                  title="Accuracy by Regime"
                  subtitle="Performance across market regimes"
                  [options]="accuracyByRegimeOptions"
                  height="300px"
                />
                <app-chart-card
                  title="Confidence Calibration"
                  subtitle="Predicted confidence vs actual accuracy"
                  [options]="confidenceCalibrationOptions"
                  height="300px"
                />
                <app-chart-card
                  title="Prediction Outcomes"
                  subtitle="Chronological prediction results"
                  [options]="predictionOutcomesOptions"
                  height="300px"
                />
              </div>

              <!-- Confusion-style outcome panel + comparison vs sibling models -->
              <div class="ml-charts">
                <app-chart-card
                  title="Outcome breakdown"
                  subtitle="Estimated wins / losses from direction accuracy × samples"
                  [options]="outcomeBreakdownOptions()"
                  height="280px"
                />
                <app-chart-card
                  title="Versions for {{ m.symbol }} / {{ m.timeframe }}"
                  subtitle="Direction accuracy across every version trained for this slot"
                  [options]="versionLineageOptions()"
                  height="280px"
                />
                <app-chart-card
                  title="Sample-size leverage"
                  subtitle="Confidence interval width shrinks with √n — peers ranked by sample size"
                  [options]="sampleLeverageOptions()"
                  height="280px"
                />
              </div>

              <!-- Sibling versions table — what came before, what's serving now -->
              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Lineage for {{ m.symbol }} / {{ m.timeframe }}</h3>
                  <span class="muted">
                    Every version ever trained for this symbol/timeframe pair — sorted by trained-at
                    desc
                  </span>
                </header>
                @if (lineage().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th class="num">Accuracy</th>
                        <th class="num">RMSE</th>
                        <th class="num">Samples</th>
                        <th>Status</th>
                        <th>Active</th>
                        <th>Trained</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (v of lineage(); track v.id) {
                        <tr
                          (click)="onMonitorModelChange(v.id)"
                          [class.current-row]="v.id === m.id"
                        >
                          <td class="mono trunc">{{ v.modelVersion }}</td>
                          <td
                            class="num mono"
                            [class.profit]="(v.directionAccuracy ?? 0) > 0.55"
                            [class.loss]="(v.directionAccuracy ?? 0) < 0.5"
                          >
                            {{ ((v.directionAccuracy ?? 0) * 100).toFixed(1) }}%
                          </td>
                          <td class="num mono">
                            {{ v.magnitudeRMSE !== null ? v.magnitudeRMSE.toFixed(2) : '—' }}
                          </td>
                          <td class="num mono">{{ v.trainingSamples }}</td>
                          <td>
                            <span class="ml-pill" [attr.data-status]="v.status">{{
                              v.status
                            }}</span>
                          </td>
                          <td>
                            <span
                              class="ml-pill"
                              [class.on]="v.isActive"
                              [class.warn]="!v.isActive"
                            >
                              {{ v.isActive ? 'Yes' : 'No' }}
                            </span>
                          </td>
                          <td class="mono">{{ v.trainedAt | date: 'dd MMM yy HH:mm' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>
            } @else {
              <div class="empty-state">
                <div class="empty-icon">&#x1F9E0;</div>
                <h3>Select a Model</h3>
                <p>Choose a model from the dropdown above to view monitoring data.</p>
              </div>
            }
          </div>
        }

        <!-- ========== TRAINING LAB TAB ========== -->
        @if (activeTab() === 'training') {
          <div class="tab-content">
            <div class="section-header">
              <h3 class="section-title">Training Runs</h3>
              <button class="btn btn-primary" (click)="openTrainingModal()">
                + Trigger Training
              </button>
            </div>

            <!-- 8-card KPI strip — fleet-wide training-run roll-ups -->
            <div class="ml-kpis">
              <div class="ml-kpi">
                <span class="ml-kpi-label">Total runs</span>
                <span class="ml-kpi-value">{{ trainingStats().total }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Completed</span>
                <span class="ml-kpi-value good">{{ trainingStats().completed }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Failed</span>
                <span
                  class="ml-kpi-value"
                  [class.bad]="trainingStats().failed > 0"
                  [class.good]="trainingStats().failed === 0"
                >
                  {{ trainingStats().failed }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">In flight</span>
                <span class="ml-kpi-value info">{{ trainingStats().inFlight }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Success rate</span>
                <span
                  class="ml-kpi-value"
                  [class.good]="
                    trainingStats().successRate !== null && trainingStats().successRate! >= 50
                  "
                  [class.bad]="
                    trainingStats().successRate !== null && trainingStats().successRate! < 50
                  "
                >
                  {{
                    trainingStats().successRate !== null
                      ? trainingStats().successRate!.toFixed(1) + '%'
                      : '—'
                  }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Avg accuracy</span>
                <span class="ml-kpi-value">
                  {{
                    trainingStats().avgAccuracy !== null
                      ? trainingStats().avgAccuracy!.toFixed(1) + '%'
                      : '—'
                  }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Avg duration</span>
                <span class="ml-kpi-value">
                  {{
                    trainingStats().avgDurationMin !== null
                      ? trainingStats().avgDurationMin!.toFixed(1) + 'm'
                      : '—'
                  }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Last 24h</span>
                <span class="ml-kpi-value">{{ trainingStats().last24h }}</span>
              </div>
            </div>

            <!-- 3-col chart row -->
            <div class="ml-charts">
              <app-chart-card
                title="Status distribution"
                subtitle="Completed · Failed · Pending · Running"
                [options]="trainingStatusDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="Runs by symbol"
                subtitle="Top 12 symbols by training-run count"
                [options]="trainingBySymbolOptions()"
                height="240px"
              />
              <app-chart-card
                title="Activity (last 14 days)"
                subtitle="Daily training-run starts"
                [options]="trainingActivityOptions()"
                height="240px"
              />
            </div>

            <!-- 2-col: trigger types + recent runs -->
            <div class="ml-board-row">
              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>By trigger type</h3>
                  <span class="muted"
                    >Who fires these runs — manual ops vs automated drift / scheduled</span
                  >
                </header>
                @if (perTriggerBreakdown().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Trigger</th>
                        <th class="num">Runs</th>
                        <th class="num">Completed</th>
                        <th class="num">Failed</th>
                        <th class="num">Success %</th>
                        <th class="num">Avg accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of perTriggerBreakdown(); track row.trigger) {
                        <tr>
                          <td class="mono">{{ row.trigger }}</td>
                          <td class="num mono">{{ row.runs }}</td>
                          <td class="num mono">{{ row.completed }}</td>
                          <td class="num mono" [class.loss]="row.failed > 0">{{ row.failed }}</td>
                          <td
                            class="num mono"
                            [class.profit]="row.successPct >= 50"
                            [class.loss]="row.successPct < 50"
                          >
                            {{ row.successPct.toFixed(1) }}%
                          </td>
                          <td class="num mono">
                            {{ row.avgAccuracy !== null ? row.avgAccuracy.toFixed(1) + '%' : '—' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>

              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Recent runs</h3>
                  <span class="muted">Last 8 starts — newest first</span>
                </header>
                @if (recentTrainingRuns().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>TF</th>
                        <th>Status</th>
                        <th class="num">Accuracy</th>
                        <th>Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of recentTrainingRuns(); track r.id) {
                        <tr (click)="onTrainingRunSelect(r)">
                          <td class="mono">{{ r.symbol }}</td>
                          <td class="mono">{{ r.timeframe }}</td>
                          <td>
                            <span class="ml-pill" [attr.data-status]="r.status">{{
                              r.status
                            }}</span>
                          </td>
                          <td class="num mono">
                            {{
                              r.directionAccuracy !== null
                                ? (r.directionAccuracy * 100).toFixed(1) + '%'
                                : '—'
                            }}
                          </td>
                          <td class="mono">{{ r.startedAt | date: 'dd MMM HH:mm' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>
            </div>

            <!-- All training runs — paged grid in its own card -->
            <section class="ml-board">
              <header class="ml-board-head">
                <h3>All training runs</h3>
                <span class="muted">Server-paged — click any row for diagnostics</span>
              </header>
              <app-data-table
                #trainingTable
                [columnDefs]="trainingColumns"
                [fetchData]="fetchTrainingRuns"
                (rowClick)="onTrainingRunSelect($event)"
              />
            </section>

            @if (selectedTrainingRun(); as run) {
              <div #runDetail class="run-detail mt-6">
                <header class="run-head">
                  <h3>Run #{{ run.id }} — {{ run.symbol }} / {{ run.timeframe }}</h3>
                  <div class="run-head-actions">
                    <span class="pill" [attr.data-status]="run.status">{{ run.status }}</span>
                    @if (isPolling()) {
                      <span class="live-pill" title="Auto-refreshing every 5s">
                        <span class="live-dot"></span> Live
                      </span>
                    }
                    <button
                      type="button"
                      class="btn btn-secondary btn-xs"
                      (click)="refreshSelectedRun()"
                      [disabled]="loadingDiagnostics()"
                    >
                      {{ loadingDiagnostics() ? 'Refreshing…' : 'Refresh' }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-link btn-xs"
                      (click)="onTrainingRunDeselect()"
                      title="Close detail panel"
                    >
                      Close
                    </button>
                  </div>
                </header>

                @if (isInFlight()) {
                  <section class="run-progress" aria-live="polite">
                    <div class="run-progress-stats">
                      <div class="run-progress-stat">
                        <span class="run-progress-label">{{ phaseLabel() }}</span>
                        <span class="run-progress-value">{{ formatDuration(elapsedMs()) }}</span>
                      </div>
                      @if (queueWaitMs() !== null) {
                        <div class="run-progress-stat">
                          <span class="run-progress-label">Queue wait</span>
                          <span class="run-progress-value">{{
                            formatDuration(queueWaitMs() ?? 0)
                          }}</span>
                        </div>
                      }
                      <div class="run-progress-stat">
                        <span class="run-progress-label">Attempt</span>
                        <span class="run-progress-value">{{
                          diagnostics()?.attemptCount ?? 1
                        }}</span>
                      </div>
                      @if (run.totalSamples > 0) {
                        <div class="run-progress-stat">
                          <span class="run-progress-label">Samples</span>
                          <span class="run-progress-value">{{ run.totalSamples | number }}</span>
                        </div>
                      }
                    </div>
                    <div
                      class="progress-indeterminate"
                      [attr.aria-label]="phaseLabel() + ' — ' + formatDuration(elapsedMs())"
                    >
                      <div class="progress-indeterminate-bar"></div>
                    </div>
                  </section>
                }

                <dl class="run-info">
                  <div>
                    <dt>Status</dt>
                    <dd>{{ run.status }}</dd>
                  </div>
                  <div>
                    <dt>Trigger</dt>
                    <dd>{{ run.triggerType }}</dd>
                  </div>
                  <div>
                    <dt>Samples</dt>
                    <dd>{{ run.totalSamples | number }}</dd>
                  </div>
                  <div>
                    <dt>Direction Acc</dt>
                    <dd>
                      {{
                        run.directionAccuracy !== null
                          ? (run.directionAccuracy * 100).toFixed(2) + '%'
                          : '—'
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>Magnitude RMSE</dt>
                    <dd>{{ run.magnitudeRMSE !== null ? run.magnitudeRMSE.toFixed(4) : '—' }}</dd>
                  </div>
                  <div>
                    <dt>From</dt>
                    <dd>{{ run.fromDate | date: 'MMM d, yyyy' }}</dd>
                  </div>
                  <div>
                    <dt>To</dt>
                    <dd>{{ run.toDate | date: 'MMM d, yyyy' }}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{{ run.startedAt | date: 'MMM d, HH:mm' }}</dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>{{ run.completedAt ? (run.completedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
                  </div>
                  @if (run.mlModelId) {
                    <div>
                      <dt>Produced Model</dt>
                      <dd>#{{ run.mlModelId }}</dd>
                    </div>
                  }
                </dl>
                @if (run.errorMessage) {
                  <div class="run-error"><strong>Error:</strong> {{ run.errorMessage }}</div>
                }
                @if (loadingDiagnostics()) {
                  <p class="muted small mt-4">Loading diagnostics…</p>
                } @else if (diagnostics()) {
                  @if (diagnostics(); as d) {
                    <section class="diagnostics mt-6">
                      <h4>Diagnostics</h4>

                      <div class="diag-grid">
                        <div class="diag-card">
                          <h5>Evaluation metrics</h5>
                          <dl>
                            <div>
                              <dt>F1 score</dt>
                              <dd>
                                {{ d.f1Score !== null ? (d.f1Score | number: '1.4-4') : '—' }}
                              </dd>
                            </div>
                            <div>
                              <dt>Brier score</dt>
                              <dd>
                                {{ d.brierScore !== null ? (d.brierScore | number: '1.4-4') : '—' }}
                              </dd>
                            </div>
                            <div>
                              <dt>Sharpe ratio</dt>
                              <dd>
                                {{
                                  d.sharpeRatio !== null ? (d.sharpeRatio | number: '1.3-3') : '—'
                                }}
                              </dd>
                            </div>
                            <div>
                              <dt>Expected value</dt>
                              <dd>
                                {{
                                  d.expectedValue !== null
                                    ? (d.expectedValue | number: '1.4-4')
                                    : '—'
                                }}
                              </dd>
                            </div>
                            <div>
                              <dt>Abstention rate</dt>
                              <dd>
                                {{
                                  d.abstentionRate !== null
                                    ? (d.abstentionRate * 100 | number: '1.1-1') + '%'
                                    : '—'
                                }}
                              </dd>
                            </div>
                            <div>
                              <dt>Abstention precision</dt>
                              <dd>
                                {{
                                  d.abstentionPrecision !== null
                                    ? (d.abstentionPrecision * 100 | number: '1.1-1') + '%'
                                    : '—'
                                }}
                              </dd>
                            </div>
                          </dl>
                        </div>

                        <div class="diag-card">
                          <h5>Architecture &amp; budget</h5>
                          <dl>
                            <div>
                              <dt>Architecture</dt>
                              <dd>{{ d.learnerArchitecture }}</dd>
                            </div>
                            <div>
                              <dt>Priority</dt>
                              <dd>{{ d.priority }}</dd>
                            </div>
                            <div>
                              <dt>Training time</dt>
                              <dd>
                                {{
                                  d.trainingDurationMs !== null
                                    ? (d.trainingDurationMs | number) + ' ms'
                                    : '—'
                                }}
                              </dd>
                            </div>
                            <div>
                              <dt>Attempt</dt>
                              <dd>{{ d.attemptCount }}</dd>
                            </div>
                            <div>
                              <dt>Picked up</dt>
                              <dd>
                                {{ d.pickedUpAt ? (d.pickedUpAt | date: 'MMM d, HH:mm:ss') : '—' }}
                              </dd>
                            </div>
                            <div>
                              <dt>Label imbalance</dt>
                              <dd>
                                {{
                                  d.labelImbalanceRatio !== null
                                    ? (d.labelImbalanceRatio * 100 | number: '1.1-1') + '%'
                                    : '—'
                                }}
                              </dd>
                            </div>
                          </dl>
                        </div>

                        <div class="diag-card">
                          <h5>Drift trigger</h5>
                          @if (d.driftTriggerType) {
                            <dl>
                              <div>
                                <dt>Trigger</dt>
                                <dd>{{ d.driftTriggerType }}</dd>
                              </div>
                            </dl>
                            @if (d.driftMetadataJson) {
                              <pre class="json">{{ formatJson(d.driftMetadataJson) }}</pre>
                            }
                          } @else {
                            <p class="muted small">
                              Run was scheduled or manual — no drift trigger.
                            </p>
                          }
                        </div>

                        <div class="diag-card">
                          <h5>Reproducibility</h5>
                          <dl>
                            <div>
                              <dt>Dataset hash</dt>
                              <dd class="mono">{{ d.datasetHash || '—' }}</dd>
                            </div>
                            <div>
                              <dt>Candle range</dt>
                              <dd>
                                {{
                                  d.candleIdRangeStart !== null
                                    ? d.candleIdRangeStart + ' → ' + d.candleIdRangeEnd
                                    : '—'
                                }}
                              </dd>
                            </div>
                          </dl>
                        </div>
                      </div>

                      @if (trainingFlagBadges(d).length > 0) {
                        <div class="flag-row">
                          <span class="flag-label">Training techniques applied:</span>
                          @for (flag of trainingFlagBadges(d); track flag) {
                            <span class="flag-pill">{{ flag }}</span>
                          }
                        </div>
                      }

                      <details class="diag-details">
                        <summary>Hyperparameter config</summary>
                        <pre class="json">{{
                          d.hyperparamConfigJson
                            ? formatJson(d.hyperparamConfigJson)
                            : '— not provided —'
                        }}</pre>
                      </details>
                      <details class="diag-details">
                        <summary>Training-dataset stats</summary>
                        <pre class="json">{{
                          d.trainingDatasetStatsJson
                            ? formatJson(d.trainingDatasetStatsJson)
                            : '— not provided —'
                        }}</pre>
                      </details>
                      <details class="diag-details">
                        <summary>Cross-validation fold scores</summary>
                        <pre class="json">{{
                          d.cvFoldScoresJson ? formatJson(d.cvFoldScoresJson) : '— not provided —'
                        }}</pre>
                      </details>
                    </section>
                  }
                } @else {
                  <p class="muted small mt-4">Diagnostics could not be loaded for this run.</p>
                }
              </div>
            }

            <!-- Training Form Modal -->
            @if (showTrainingModal()) {
              <div
                class="modal-overlay"
                role="presentation"
                tabindex="-1"
                (click)="showTrainingModal.set(false)"
                (keydown.escape)="showTrainingModal.set(false)"
              >
                <form
                  class="modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Trigger training run"
                  tabindex="-1"
                  [formGroup]="trainingForm"
                  (ngSubmit)="submitTraining()"
                  (click)="$event.stopPropagation()"
                  (keydown)="$event.stopPropagation()"
                >
                  <div class="modal-header">
                    <h3>Trigger Training Run</h3>
                    <button
                      type="button"
                      class="modal-close"
                      aria-label="Close"
                      (click)="showTrainingModal.set(false)"
                    >
                      &times;
                    </button>
                  </div>
                  <div class="modal-body">
                    <app-form-field
                      label="Symbol"
                      [required]="true"
                      [control]="trainingForm.controls.symbol"
                      hint="Type a pair or pick from the list — both work."
                    >
                      <input
                        appFormFieldControl
                        formControlName="symbol"
                        type="text"
                        placeholder="e.g. EURUSD"
                        list="trigger-training-symbols"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <datalist id="trigger-training-symbols">
                        @for (s of symbolOptions(); track s) {
                          <option [value]="s"></option>
                        }
                      </datalist>
                    </app-form-field>
                    <app-form-field
                      label="Timeframe"
                      [required]="true"
                      [control]="trainingForm.controls.timeframe"
                    >
                      <select appFormFieldControl formControlName="timeframe">
                        <option value="M1">M1</option>
                        <option value="M5">M5</option>
                        <option value="M15">M15</option>
                        <option value="H1">H1</option>
                        <option value="H4">H4</option>
                        <option value="D1">D1</option>
                      </select>
                    </app-form-field>
                    <app-form-field
                      label="From Date"
                      [required]="true"
                      [control]="trainingForm.controls.fromDate"
                    >
                      <input
                        appFormFieldControl
                        formControlName="fromDate"
                        type="date"
                        [max]="todayIso"
                      />
                    </app-form-field>
                    <app-form-field
                      label="To Date"
                      [required]="true"
                      [control]="trainingForm.controls.toDate"
                    >
                      <input
                        appFormFieldControl
                        formControlName="toDate"
                        type="date"
                        [max]="todayIso"
                      />
                    </app-form-field>
                    @if ((trainingForm.touched || trainingForm.dirty) && trainingForm.errors) {
                      <div class="form-banner form-banner-error" role="alert">
                        <ul>
                          @if (trainingDateError('dateOrder')) {
                            <li>
                              <strong>From Date</strong> must be earlier than
                              <strong>To Date</strong>.
                            </li>
                          }
                          @if (trainingDateError('fromDateInFuture')) {
                            <li>
                              <strong>From Date</strong> cannot be in the future — no candles exist
                              for that range.
                            </li>
                          }
                          @if (trainingDateError('toDateInFuture')) {
                            <li>
                              <strong>To Date</strong> cannot be in the future — no candles exist
                              for that range.
                            </li>
                          }
                        </ul>
                      </div>
                    }
                    @if (trainingWindowYears(); as years) {
                      <div class="form-banner form-banner-warning" role="status">
                        Window of {{ years }}y is unusually large — most candle history may be
                        missing. Submit anyway if intended.
                      </div>
                    }

                    <!-- Candle coverage preview — surfaces the actual sample-count the
                         trainer will see for the (symbol, timeframe, window) before submit -->
                    <div class="coverage-preview">
                      <div class="coverage-preview-head">
                        <span class="coverage-preview-title">Candle availability</span>
                        @if (coverageLoading()) {
                          <span class="muted small">checking…</span>
                        }
                      </div>
                      @if (coverageError(); as err) {
                        <p class="muted small">{{ err }}</p>
                      } @else if (coveragePreview(); as cov) {
                        @if (cov.totalCandles === 0) {
                          <div class="form-banner form-banner-error" role="alert">
                            No candles exist for {{ cov.symbol }}/{{ cov.timeframe }} in the engine
                            database — training will fail. Run the EA to ingest history for this
                            pair first.
                          </div>
                        } @else {
                          <dl class="coverage-stats">
                            <div>
                              <dt>In selected window</dt>
                              <dd
                                [class.warn]="cov.candlesInWindow < 500"
                                [class.danger]="cov.candlesInWindow === 0"
                              >
                                {{ cov.candlesInWindow | number }} candles
                              </dd>
                            </div>
                            <div>
                              <dt>Largest contiguous</dt>
                              <dd
                                [class.warn]="cov.largestSegmentCandles < 530"
                                [class.danger]="cov.largestSegmentCandles === 0"
                              >
                                {{ cov.largestSegmentCandles | number }} bars
                              </dd>
                            </div>
                            <div>
                              <dt>Segments in window</dt>
                              <dd [class.warn]="cov.segmentCount > 1">
                                {{ cov.segmentCount }}
                              </dd>
                            </div>
                            <div>
                              <dt>Total on file</dt>
                              <dd>{{ cov.totalCandles | number }}</dd>
                            </div>
                            <div>
                              <dt>Earliest on file</dt>
                              <dd>
                                {{
                                  cov.earliestTimestamp
                                    ? (cov.earliestTimestamp | date: 'MMM d, yyyy')
                                    : '—'
                                }}
                              </dd>
                            </div>
                            <div>
                              <dt>Latest on file</dt>
                              <dd>
                                {{
                                  cov.latestTimestamp
                                    ? (cov.latestTimestamp | date: 'MMM d, yyyy')
                                    : '—'
                                }}
                              </dd>
                            </div>
                          </dl>
                          @if (cov.segmentCount > 1) {
                            <div class="form-banner form-banner-warning" role="status">
                              Window contains {{ cov.segmentCount }} non-contiguous segments
                              (ingestion gap). Trainer will use only the largest contiguous block:
                              {{ cov.largestSegmentCandles | number }} bars from
                              {{ cov.largestSegmentFrom | date: 'MMM d, yyyy' }} to
                              {{ cov.largestSegmentTo | date: 'MMM d, yyyy' }}.
                            </div>
                          }
                          @if (cov.largestSegmentCandles > 0 && cov.largestSegmentCandles < 530) {
                            <div class="form-banner form-banner-error" role="alert">
                              Largest contiguous block is only
                              {{ cov.largestSegmentCandles }} bars — below the trainer's 530-bar
                              minimum (lookback + min samples). The trigger will be rejected
                              pre-flight.
                            </div>
                          }
                          @if (
                            cov.segmentCount === 1 &&
                            cov.candlesInWindow > 0 &&
                            cov.totalCandles > 0 &&
                            cov.candlesInWindow < cov.totalCandles * 0.1
                          ) {
                            <div class="form-banner form-banner-warning" role="status">
                              Only
                              {{ ((cov.candlesInWindow / cov.totalCandles) * 100).toFixed(1) }}% of
                              available history falls in your window. Consider widening the date
                              range.
                            </div>
                          }
                        }
                      }
                    </div>
                    <app-form-field
                      label="Architecture"
                      [required]="true"
                      [control]="trainingForm.controls.learnerArchitecture"
                    >
                      <select appFormFieldControl formControlName="learnerArchitecture">
                        @for (arch of learnerArchitectures; track arch.value) {
                          <option [ngValue]="arch.value">{{ arch.label }}</option>
                        }
                      </select>
                    </app-form-field>
                  </div>
                  <div class="modal-footer">
                    <button
                      type="button"
                      class="btn btn-secondary"
                      (click)="showTrainingModal.set(false)"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="btn btn-primary"
                      [disabled]="submittingTraining() || trainingForm.invalid"
                    >
                      {{ submittingTraining() ? 'Submitting…' : 'Start Training' }}
                    </button>
                  </div>
                </form>
              </div>
            }
          </div>
        }

        <!-- ========== ARCHITECTURE TAB ========== -->
        @if (activeTab() === 'architecture') {
          <div class="tab-content">
            <div class="section-header">
              <h3 class="section-title">Model architecture analytics</h3>
              <span class="muted small">
                Comprehensive per-architecture metric + visual evaluation across the
                {{ archAnalyticsRows().length }}-model fleet
                @if (archAnalyticsTotal() > archAnalyticsRows().length) {
                  (sample of latest {{ archAnalyticsRows().length }} of {{ archAnalyticsTotal() }})
                }
              </span>
            </div>

            <!-- 8-card KPI strip -->
            <div class="arch-kpis">
              <app-metric-card
                label="Architectures"
                [value]="archLeaderboard().length"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Models in fleet"
                [value]="archAnalyticsRows().length"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Active models"
                [value]="archActiveTotal()"
                format="number"
                [dotColor]="archActiveTotal() > 0 ? '#34C759' : '#FF9500'"
              />
              <app-metric-card
                [label]="'Top by count: ' + (archTopByCount()?.architecture ?? '—')"
                [value]="archTopByCount()?.count ?? 0"
                format="number"
                dotColor="#AF52DE"
              />
              <app-metric-card
                [label]="'Best accuracy: ' + (archTopByAccuracy()?.architecture ?? '—')"
                [value]="(archTopByAccuracy()?.avgAccuracy ?? 0) * 100"
                format="percent"
                [dotColor]="(archTopByAccuracy()?.avgAccuracy ?? 0) > 0.55 ? '#34C759' : '#FF9500'"
              />
              <app-metric-card
                [label]="'Best activation: ' + (archTopByActivation()?.architecture ?? '—')"
                [value]="(archTopByActivation()?.activationRate ?? 0) * 100"
                format="percent"
                dotColor="#34C759"
              />
              <app-metric-card
                [label]="'Lowest RMSE: ' + (archTopByRmse()?.architecture ?? '—')"
                [value]="archTopByRmse()?.avgRMSE ?? 0"
                format="number"
                dotColor="#5AC8FA"
              />
              <app-metric-card
                label="Failed (fleet)"
                [value]="archFailedTotal()"
                format="number"
                [dotColor]="archFailedTotal() > 0 ? '#FF3B30' : '#34C759'"
              />
            </div>

            <!-- 2-col chart row: status stack + activation rate -->
            <div class="arch-chart-row">
              <app-chart-card
                title="Models per architecture by status"
                subtitle="Active · Training · Superseded · Failed"
                [options]="archStatusStackOptions()"
                height="320px"
              />
              <app-chart-card
                title="Activation rate per architecture"
                subtitle="Active models / total models — promotion success"
                [options]="archActivationRateOptions()"
                height="320px"
              />
            </div>

            <!-- 2-col chart row: accuracy distribution + scatter -->
            <div class="arch-chart-row">
              <app-chart-card
                title="Accuracy distribution per architecture"
                subtitle="Box plot: min / Q1 / median / Q3 / max of training accuracy"
                [options]="archAccuracyBoxOptions()"
                height="340px"
              />
              <app-chart-card
                title="RMSE × Accuracy scatter"
                subtitle="Each model is one point — colored by architecture"
                [options]="archScatterOptions()"
                height="340px"
              />
            </div>

            <!-- Per-architecture leaderboard -->
            <section class="arch-board">
              <header class="arch-board-head">
                <h3>Per-architecture leaderboard</h3>
                <span class="muted small">
                  Sortable by total models · default order: most models first
                </span>
              </header>
              <div class="arch-board-scroll">
                <table class="arch-table sticky">
                  <thead>
                    <tr>
                      <th>Architecture</th>
                      <th class="num">Total</th>
                      <th class="num">Active</th>
                      <th class="num">Training</th>
                      <th class="num">Superseded</th>
                      <th class="num">Failed</th>
                      <th class="num">Activation %</th>
                      <th class="num">Avg accuracy</th>
                      <th class="num">Median accuracy</th>
                      <th class="num">Best accuracy</th>
                      <th class="num">Avg RMSE</th>
                      <th class="num">Total samples</th>
                      <th class="num">Latest trained</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of archLeaderboard(); track row.architecture) {
                      <tr>
                        <td class="mono">
                          <span class="arch-dot" [style.background]="row.color"></span>
                          {{ row.architecture }}
                        </td>
                        <td class="num mono">{{ row.count }}</td>
                        <td class="num mono good">{{ row.active }}</td>
                        <td class="num mono">{{ row.training }}</td>
                        <td class="num mono muted">{{ row.superseded }}</td>
                        <td class="num mono" [class.bad]="row.failed > 0">
                          {{ row.failed }}
                        </td>
                        <td
                          class="num mono"
                          [class.good]="row.activationRate >= 0.05"
                          [class.bad]="row.activationRate === 0 && row.count > 0"
                        >
                          {{ formatPct(row.activationRate) }}
                        </td>
                        <td
                          class="num mono"
                          [class.good]="row.avgAccuracy >= 0.55"
                          [class.warn]="row.avgAccuracy < 0.52 && row.avgAccuracy > 0"
                        >
                          {{ formatPct(row.avgAccuracy) }}
                        </td>
                        <td class="num mono">
                          {{ formatPct(row.medianAccuracy) }}
                        </td>
                        <td class="num mono good">
                          {{ formatPct(row.bestAccuracy) }}
                        </td>
                        <td class="num mono">
                          {{ row.avgRMSE > 0 ? row.avgRMSE.toFixed(3) : '—' }}
                        </td>
                        <td class="num mono muted">
                          {{ row.totalSamples.toLocaleString() }}
                        </td>
                        <td class="muted">
                          {{ row.latestTrainedAt ? (row.latestTrainedAt | relativeTime) : '—' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>

            @if (archAnalyticsRows().length === 0) {
              <div class="empty-arch">
                Loading model fleet… (probe-and-fetch in progress, polled every 2 minutes)
              </div>
            }
          </div>
        }

        <!-- ========== SHADOW ARENA TAB ========== -->
        @if (activeTab() === 'shadow') {
          <div class="tab-content">
            <div class="section-header">
              <h3 class="section-title">Shadow Evaluations</h3>
              <button class="btn btn-primary" (click)="showShadowModal.set(true)">
                + Start Evaluation
              </button>
            </div>

            <!-- 8-card KPI strip — fleet-wide shadow-arena posture -->
            <div class="ml-kpis">
              <div class="ml-kpi">
                <span class="ml-kpi-label">Total evals</span>
                <span class="ml-kpi-value">{{ shadowStats().total }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Running</span>
                <span class="ml-kpi-value info">{{ shadowStats().running }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Processing</span>
                <span class="ml-kpi-value">{{ shadowStats().processing }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Completed</span>
                <span class="ml-kpi-value good">{{ shadowStats().completed }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Promotions</span>
                <span class="ml-kpi-value good">{{ shadowStats().promoted }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Rejections</span>
                <span class="ml-kpi-value bad">{{ shadowStats().rejected }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Promotion rate</span>
                <span
                  class="ml-kpi-value"
                  [class.good]="
                    shadowStats().promotionRate !== null && shadowStats().promotionRate! >= 50
                  "
                  [class.bad]="
                    shadowStats().promotionRate !== null && shadowStats().promotionRate! < 50
                  "
                >
                  {{
                    shadowStats().promotionRate !== null
                      ? shadowStats().promotionRate!.toFixed(1) + '%'
                      : '—'
                  }}
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Avg lift</span>
                <span
                  class="ml-kpi-value"
                  [class.good]="shadowStats().avgLift !== null && shadowStats().avgLift! > 0"
                  [class.bad]="shadowStats().avgLift !== null && shadowStats().avgLift! < 0"
                >
                  @if (shadowStats().avgLift !== null) {
                    {{ shadowStats().avgLift! >= 0 ? '+' : ''
                    }}{{ shadowStats().avgLift!.toFixed(2) }}%
                  } @else {
                    —
                  }
                </span>
              </div>
            </div>

            <!-- 3-col chart row -->
            <div class="ml-charts">
              <app-chart-card
                title="Status distribution"
                subtitle="Running · Processing · Completed · Cancelled"
                [options]="shadowStatusDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="Promotion outcomes"
                subtitle="Promoted · Rejected · Pending"
                [options]="shadowDecisionDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="Trade progress"
                subtitle="Completed vs required trades — top 12 in-flight evals"
                [options]="shadowProgressOptions()"
                height="240px"
              />
            </div>

            <!-- 2-col tables: biggest lifts + per-symbol breakdown -->
            <div class="ml-board-row">
              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Biggest challenger lifts</h3>
                  <span class="muted">Completed evals where challenger beat champion the most</span>
                </header>
                @if (topLifts().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>TF</th>
                        <th class="num">Champion</th>
                        <th class="num">Challenger</th>
                        <th class="num">Δ</th>
                        <th>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (e of topLifts(); track e.id) {
                        <tr (click)="onShadowSelect(e)">
                          <td class="mono">{{ e.symbol }}</td>
                          <td class="mono">{{ e.timeframe }}</td>
                          <td class="num mono">
                            {{ (e.championDirectionAccuracy * 100).toFixed(1) }}%
                          </td>
                          <td class="num mono">
                            {{ (e.challengerDirectionAccuracy * 100).toFixed(1) }}%
                          </td>
                          <td
                            class="num mono"
                            [class.profit]="
                              e.challengerDirectionAccuracy > e.championDirectionAccuracy
                            "
                            [class.loss]="
                              e.challengerDirectionAccuracy < e.championDirectionAccuracy
                            "
                          >
                            {{
                              (e.challengerDirectionAccuracy - e.championDirectionAccuracy) * 100 >=
                              0
                                ? '+'
                                : ''
                            }}{{
                              (
                                (e.challengerDirectionAccuracy - e.championDirectionAccuracy) *
                                100
                              ).toFixed(1)
                            }}%
                          </td>
                          <td>
                            <span class="ml-pill" [attr.data-decision]="e.promotionDecision">
                              {{ e.promotionDecision }}
                            </span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>

              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Per-symbol breakdown</h3>
                  <span class="muted">Promotion outcomes per symbol</span>
                </header>
                @if (shadowPerSymbol().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th class="num">Evals</th>
                        <th class="num">Promoted</th>
                        <th class="num">Rejected</th>
                        <th class="num">In flight</th>
                        <th class="num">Promote %</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of shadowPerSymbol(); track row.symbol) {
                        <tr>
                          <td class="mono">{{ row.symbol }}</td>
                          <td class="num mono">{{ row.evals }}</td>
                          <td class="num mono profit">{{ row.promoted }}</td>
                          <td class="num mono loss">{{ row.rejected }}</td>
                          <td class="num mono">{{ row.inFlight }}</td>
                          <td
                            class="num mono"
                            [class.profit]="row.promotePct >= 50"
                            [class.loss]="row.promotePct < 50 && row.promotePct > 0"
                          >
                            {{ row.promotePct.toFixed(0) }}%
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>
            </div>

            <section class="ml-board">
              <header class="ml-board-head">
                <h3>All shadow evaluations</h3>
                <span class="muted">Server-paged — click any row for head-to-head charts</span>
              </header>
              <app-data-table
                #shadowTable
                [columnDefs]="shadowColumns"
                [fetchData]="fetchShadowEvals"
                (rowClick)="onShadowSelect($event)"
              />
            </section>

            @if (selectedShadow()) {
              <div class="charts-grid mt-6">
                <app-chart-card
                  title="Head-to-Head"
                  subtitle="Champion vs challenger accuracy comparison"
                  [options]="headToHeadOptions"
                  height="300px"
                />
                <app-chart-card
                  title="SPRT Progress"
                  subtitle="Completed trades vs required for decision"
                  [options]="cumulativeRaceOptions"
                  height="300px"
                />
              </div>
            }

            <!-- Shadow Evaluation Modal --><!-- A -->
            @if (showShadowModal()) {
              <div
                class="modal-overlay"
                role="presentation"
                tabindex="-1"
                (click)="showShadowModal.set(false)"
                (keydown.escape)="showShadowModal.set(false)"
              >
                <form
                  class="modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Start shadow evaluation"
                  tabindex="-1"
                  [formGroup]="shadowForm"
                  (ngSubmit)="submitShadow()"
                  (click)="$event.stopPropagation()"
                  (keydown)="$event.stopPropagation()"
                >
                  <div class="modal-header">
                    <h3>Start Shadow Evaluation</h3>
                    <button
                      type="button"
                      class="modal-close"
                      aria-label="Close"
                      (click)="showShadowModal.set(false)"
                    >
                      &times;
                    </button>
                  </div>
                  <div class="modal-body">
                    <app-form-field
                      label="Champion Model ID"
                      [required]="true"
                      [control]="shadowForm.controls.championModelId"
                    >
                      <input
                        appFormFieldControl
                        formControlName="championModelId"
                        type="number"
                        min="1"
                      />
                    </app-form-field>
                    <app-form-field
                      label="Challenger Model ID"
                      [required]="true"
                      [control]="shadowForm.controls.challengerModelId"
                    >
                      <input
                        appFormFieldControl
                        formControlName="challengerModelId"
                        type="number"
                        min="1"
                      />
                    </app-form-field>
                    <app-form-field
                      label="Symbol"
                      [required]="true"
                      [control]="shadowForm.controls.symbol"
                    >
                      <input
                        appFormFieldControl
                        formControlName="symbol"
                        type="text"
                        placeholder="e.g. EURUSD"
                      />
                    </app-form-field>
                    <app-form-field
                      label="Timeframe"
                      [required]="true"
                      [control]="shadowForm.controls.timeframe"
                    >
                      <select appFormFieldControl formControlName="timeframe">
                        <option value="M1">M1</option>
                        <option value="M5">M5</option>
                        <option value="M15">M15</option>
                        <option value="H1">H1</option>
                        <option value="H4">H4</option>
                        <option value="D1">D1</option>
                      </select>
                    </app-form-field>
                    <app-form-field
                      label="Required Trades"
                      [required]="true"
                      [control]="shadowForm.controls.requiredTrades"
                    >
                      <input
                        appFormFieldControl
                        formControlName="requiredTrades"
                        type="number"
                        min="1"
                      />
                    </app-form-field>
                  </div>
                  <div class="modal-footer">
                    <button
                      type="button"
                      class="btn btn-secondary"
                      (click)="showShadowModal.set(false)"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="btn btn-primary"
                      [disabled]="submittingShadow() || shadowForm.invalid"
                    >
                      {{ submittingShadow() ? 'Starting…' : 'Start Evaluation' }}
                    </button>
                  </div>
                </form>
              </div>
            }
          </div>
        }

        <!-- ========== SIGNAL A/B TAB ========== -->
        @if (activeTab() === 'signal-ab') {
          <div class="tab-content">
            <div class="section-header">
              <h3 class="section-title">Signal-Level A/B Tests</h3>
            </div>

            <!-- 8-card KPI strip — fleet-wide A/B test posture -->
            <div class="ml-kpis">
              <div class="ml-kpi">
                <span class="ml-kpi-label">Total tests</span>
                <span class="ml-kpi-value">{{ abStats().total }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Running</span>
                <span class="ml-kpi-value info">{{ abStats().running }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Completed</span>
                <span class="ml-kpi-value good">{{ abStats().completed }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Champion wins</span>
                <span class="ml-kpi-value">{{ abStats().championWins }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Challenger wins</span>
                <span class="ml-kpi-value good">{{ abStats().challengerWins }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Inconclusive</span>
                <span class="ml-kpi-value muted-val">{{ abStats().inconclusive }}</span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Avg P&L lift</span>
                <span
                  class="ml-kpi-value"
                  [class.good]="abStats().avgLift !== null && abStats().avgLift! > 0"
                  [class.bad]="abStats().avgLift !== null && abStats().avgLift! < 0"
                >
                  @if (abStats().avgLift !== null) {
                    {{ abStats().avgLift! >= 0 ? '+' : ''
                    }}{{ abStats().avgLift! | number: '1.2-2' }}
                  } @else {
                    —
                  }
                </span>
              </div>
              <div class="ml-kpi">
                <span class="ml-kpi-label">Total samples</span>
                <span class="ml-kpi-value">{{ abStats().totalSamples }}</span>
              </div>
            </div>

            <!-- 3-col chart row -->
            <div class="ml-charts">
              <app-chart-card
                title="Status distribution"
                subtitle="Test lifecycle states across the fleet"
                [options]="abStatusDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="Outcome distribution"
                subtitle="Champion vs challenger decisions"
                [options]="abDecisionDonutOptions()"
                height="240px"
              />
              <app-chart-card
                title="P&L lift histogram"
                subtitle="Distribution of (challenger − champion) P&L across completed tests"
                [options]="abLiftHistogramOptions()"
                height="240px"
              />
            </div>

            <!-- 2-col tables: top lifts + per-symbol breakdown -->
            <div class="ml-board-row">
              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Biggest P&L lifts</h3>
                  <span class="muted">Tests where the challenger beat the champion the most</span>
                </header>
                @if (abTopLifts().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>TF</th>
                        <th class="num">Champion P&L</th>
                        <th class="num">Challenger P&L</th>
                        <th class="num">Δ</th>
                        <th class="num">p-value</th>
                        <th>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (t of abTopLifts(); track t.id) {
                        <tr (click)="onAbSelect(t)">
                          <td class="mono">{{ t.symbol }}</td>
                          <td class="mono">{{ t.timeframe }}</td>
                          <td
                            class="num mono"
                            [class.profit]="t.championPnl > 0"
                            [class.loss]="t.championPnl < 0"
                          >
                            {{ t.championPnl | number: '1.2-2' }}
                          </td>
                          <td
                            class="num mono"
                            [class.profit]="t.challengerPnl > 0"
                            [class.loss]="t.challengerPnl < 0"
                          >
                            {{ t.challengerPnl | number: '1.2-2' }}
                          </td>
                          <td
                            class="num mono"
                            [class.profit]="t.challengerPnl > t.championPnl"
                            [class.loss]="t.challengerPnl < t.championPnl"
                          >
                            {{ t.challengerPnl - t.championPnl >= 0 ? '+' : ''
                            }}{{ t.challengerPnl - t.championPnl | number: '1.2-2' }}
                          </td>
                          <td class="num mono">
                            {{ t.pValue !== null ? (t.pValue | number: '1.4-4') : '—' }}
                          </td>
                          <td>
                            <span class="ml-pill" [attr.data-decision]="t.decision">
                              {{ t.decision ?? '—' }}
                            </span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="muted" style="padding: var(--space-4)">
                    No completed A/B tests yet — start one to see results here.
                  </p>
                }
              </section>

              <section class="ml-board">
                <header class="ml-board-head">
                  <h3>Per-symbol breakdown</h3>
                  <span class="muted">Test outcomes grouped by symbol</span>
                </header>
                @if (abPerSymbol().length > 0) {
                  <table class="ml-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th class="num">Tests</th>
                        <th class="num">Champion wins</th>
                        <th class="num">Challenger wins</th>
                        <th class="num">Inconclusive</th>
                        <th class="num">Avg lift</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of abPerSymbol(); track row.symbol) {
                        <tr>
                          <td class="mono">{{ row.symbol }}</td>
                          <td class="num mono">{{ row.tests }}</td>
                          <td class="num mono">{{ row.championWins }}</td>
                          <td class="num mono profit">{{ row.challengerWins }}</td>
                          <td class="num mono muted-val">{{ row.inconclusive }}</td>
                          <td
                            class="num mono"
                            [class.profit]="row.avgLift > 0"
                            [class.loss]="row.avgLift < 0"
                          >
                            {{ row.avgLift >= 0 ? '+' : '' }}{{ row.avgLift | number: '1.2-2' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="muted" style="padding: var(--space-4)">
                    No A/B test data available yet.
                  </p>
                }
              </section>
            </div>

            <section class="ml-board">
              <header class="ml-board-head">
                <h3>All A/B tests</h3>
                <span class="muted">
                  Server-paged — click a row for SPRT progress and side-by-side stats
                </span>
              </header>
              <app-data-table
                [columnDefs]="abColumns"
                [fetchData]="fetchAbTests"
                (rowClick)="onAbSelect($event)"
              />
            </section>

            @if (selectedAb(); as t) {
              <div class="ab-detail mt-6">
                <header class="ab-head">
                  <h4>Test #{{ t.id }} — {{ t.symbol }} / {{ t.timeframe }}</h4>
                  <span class="pill" [attr.data-status]="t.status">{{ t.status }}</span>
                </header>
                <div class="ab-grid">
                  <div class="ab-side champion">
                    <h5>Champion (#{{ t.championModelId }})</h5>
                    <dl>
                      <div>
                        <dt>P&L</dt>
                        <dd
                          class="mono"
                          [class.profit]="t.championPnl > 0"
                          [class.loss]="t.championPnl < 0"
                        >
                          {{ t.championPnl | number: '1.2-2' }}
                        </dd>
                      </div>
                      <div>
                        <dt>Win Rate</dt>
                        <dd class="mono">{{ t.championWinRate * 100 | number: '1.1-1' }}%</dd>
                      </div>
                    </dl>
                  </div>
                  <div class="ab-side challenger">
                    <h5>Challenger (#{{ t.challengerModelId }})</h5>
                    <dl>
                      <div>
                        <dt>P&L</dt>
                        <dd
                          class="mono"
                          [class.profit]="t.challengerPnl > 0"
                          [class.loss]="t.challengerPnl < 0"
                        >
                          {{ t.challengerPnl | number: '1.2-2' }}
                        </dd>
                      </div>
                      <div>
                        <dt>Win Rate</dt>
                        <dd class="mono">{{ t.challengerWinRate * 100 | number: '1.1-1' }}%</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <dl class="ab-stats">
                  <div>
                    <dt>Samples</dt>
                    <dd class="mono">{{ t.sampleSize | number }}</dd>
                  </div>
                  <div>
                    <dt>SPRT LLR</dt>
                    <dd class="mono">
                      {{
                        t.sprtLogLikelihoodRatio !== null
                          ? (t.sprtLogLikelihoodRatio | number: '1.3-3')
                          : '—'
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>p-value</dt>
                    <dd class="mono">
                      {{ t.pValue !== null ? (t.pValue | number: '1.4-4') : '—' }}
                    </dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{{ t.startedAt | date: 'MMM d, HH:mm' }}</dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>{{ t.completedAt ? (t.completedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
                  </div>
                  @if (t.decision) {
                    <div class="full">
                      <dt>Decision</dt>
                      <dd>{{ t.decision }}</dd>
                    </div>
                  }
                </dl>
              </div>
            }
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      /* Filter Bar */
      .filter-bar {
        display: flex;
        gap: var(--space-3);
        align-items: flex-end;
        flex-wrap: wrap;
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .fb-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .fb-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .fb-clear {
        margin-left: auto;
        height: 32px;
        padding: 0 var(--space-3);
        font-size: 12px;
      }
      .ml-board > .filter-bar + app-data-table {
        display: block;
      }

      .filter-select,
      .filter-input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
      }
      .filter-select {
        min-width: 160px;
        cursor: pointer;
      }
      .filter-input {
        min-width: 200px;
      }
      .filter-select.wide {
        min-width: 360px;
      }
      .filter-input::placeholder {
        color: var(--text-tertiary);
      }

      /* Monitor */
      .monitor-selector {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        margin-bottom: var(--space-6);
      }
      .selector-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        white-space: nowrap;
      }

      .metrics-row {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }

      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
      }

      .mt-6 {
        margin-top: var(--space-6);
      }

      /* Section Header */
      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--space-4);
      }
      .section-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      /* Buttons */
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
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover {
        background: var(--bg-secondary);
      }

      /* Modal */
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        backdrop-filter: blur(4px);
      }
      .modal {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg, 12px);
        width: 480px;
        max-width: 90vw;
        box-shadow: var(--shadow-lg, 0 20px 40px rgba(0, 0, 0, 0.2));
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .modal-header h3 {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }
      .modal-close {
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 50%;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .modal-close:hover {
        background: var(--border);
      }
      .modal-body {
        padding: var(--space-5);
      }
      .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
        border-top: 1px solid var(--border);
      }

      /* Form */
      .form-group {
        margin-bottom: var(--space-4);
      }
      .form-group:last-child {
        margin-bottom: 0;
      }
      .form-label {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
      }
      .form-input {
        width: 100%;
        height: 38px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        box-sizing: border-box;
      }
      .form-input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
      }

      /* Empty State */
      .empty-state {
        text-align: center;
        padding: var(--space-16, 64px) var(--space-8);
      }
      .empty-icon {
        font-size: 48px;
        margin-bottom: var(--space-4);
      }
      .empty-state h3 {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-2);
      }
      .empty-state p {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }

      .tab-content {
        min-height: 400px;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      /* ── Architecture tab ───────────────────────────────────────── */
      .arch-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .arch-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .arch-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .arch-chart-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .arch-chart-row {
          grid-template-columns: 1fr;
        }
      }
      .arch-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .arch-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .arch-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .arch-board-scroll {
        max-height: 540px;
        overflow: auto;
      }
      table.arch-table {
        width: 100%;
        border-collapse: collapse;
      }
      table.arch-table th,
      table.arch-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        white-space: nowrap;
      }
      table.arch-table thead th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      table.arch-table.sticky thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      table.arch-table tbody tr:last-child td {
        border-bottom: none;
      }
      table.arch-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      table.arch-table th.num,
      table.arch-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      table.arch-table td.mono {
        font-family: 'SF Mono', 'Menlo', monospace;
      }
      table.arch-table td.muted {
        color: var(--text-tertiary);
      }
      table.arch-table td.good {
        color: var(--profit);
      }
      table.arch-table td.warn {
        color: #c93400;
      }
      table.arch-table td.bad {
        color: var(--loss);
      }
      .arch-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
      }
      .empty-arch {
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        text-align: center;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }

      /* ML Models density additions — registry tab */
      .ml-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .ml-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .ml-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .ml-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ml-kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ml-kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .ml-kpi-value.good {
        color: var(--profit);
      }
      .ml-kpi-value.bad {
        color: var(--loss);
      }
      .ml-kpi-value.info {
        color: var(--accent);
      }
      .ml-kpi-value.muted-val {
        color: var(--text-tertiary);
      }

      .ml-charts {
        display: grid;
        grid-template-columns: 1fr 1.4fr 1.2fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .ml-charts {
          grid-template-columns: 1fr;
        }
      }

      .ml-board-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .ml-board-row {
          grid-template-columns: 1fr;
        }
      }

      .ml-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .ml-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .ml-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .ml-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .ml-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .ml-board-table th,
      .ml-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .ml-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .ml-board-table tbody tr {
        cursor: pointer;
        transition: background 0.1s;
      }
      .ml-board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .ml-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ml-board-table th.num,
      .ml-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .ml-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .ml-board-table .trunc {
        max-width: 110px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ml-board-table .profit {
        color: var(--profit);
      }
      .ml-board-table .loss {
        color: var(--loss);
      }

      .ml-pill {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .ml-pill[data-status='Active'],
      .ml-pill.on {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .ml-pill[data-status='Training'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .ml-pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.14);
        color: #d70015;
      }
      .ml-pill[data-status='Superseded'] {
        background: rgba(142, 142, 147, 0.14);
        color: #636366;
      }
      .ml-pill[data-status='Running'],
      .ml-pill[data-status='Processing'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .ml-pill[data-status='Completed'] {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .ml-pill[data-decision='Promoted'] {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .ml-pill[data-decision='Rejected'] {
        background: rgba(255, 59, 48, 0.14);
        color: #d70015;
      }
      .ml-pill[data-decision='Pending'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .ml-pill.warn {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }

      /* Model metadata strip on the Monitor tab */
      .model-meta {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      @media (max-width: 1100px) {
        .model-meta {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .model-meta {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .mm-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .mm-cell.wide {
        grid-column: span 2;
      }
      .mm-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mm-value {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .mm-value.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .mm-value.trunc {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Highlight the row corresponding to the currently-monitored model */
      .ml-board-table .current-row {
        background: rgba(0, 113, 227, 0.06);
      }
      .ml-board-table .current-row:hover {
        background: rgba(0, 113, 227, 0.1);
      }

      /* Training run detail */
      .run-detail,
      .ab-detail {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .run-head,
      .ab-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
      }
      .run-head h3,
      .ab-head h4 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .pill {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill[data-status='Completed'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Running'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .pill[data-status='ChampionWon'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='ChallengerWon'] {
        background: rgba(175, 82, 222, 0.12);
        color: #8944ab;
      }
      .pill[data-status='Inconclusive'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .run-head-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .live-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .live-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #34c759;
        box-shadow: 0 0 0 0 rgba(52, 199, 89, 0.6);
        animation: live-pulse 1.6s ease-out infinite;
      }
      @keyframes live-pulse {
        0% {
          box-shadow: 0 0 0 0 rgba(52, 199, 89, 0.55);
        }
        70% {
          box-shadow: 0 0 0 8px rgba(52, 199, 89, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(52, 199, 89, 0);
        }
      }
      .btn-xs {
        padding: 4px 10px;
        font-size: var(--text-xs);
        line-height: 1;
      }
      .run-progress {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-tertiary);
        border-radius: var(--radius-md);
      }
      .run-progress-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: var(--space-3);
      }
      .run-progress-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .run-progress-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .run-progress-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .progress-indeterminate {
        position: relative;
        width: 100%;
        height: 4px;
        background: rgba(0, 113, 227, 0.12);
        border-radius: 2px;
        overflow: hidden;
      }
      .progress-indeterminate-bar {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        width: 35%;
        background: linear-gradient(90deg, transparent, #0071e3, transparent);
        animation: progress-slide 1.6s ease-in-out infinite;
        border-radius: 2px;
      }
      @keyframes progress-slide {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(285%);
        }
      }
      .form-banner {
        margin-top: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        line-height: 1.4;
      }
      .form-banner ul {
        margin: 0;
        padding-left: var(--space-4);
      }
      .form-banner li + li {
        margin-top: var(--space-1);
      }
      .form-banner-error {
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.32);
        color: #d70015;
      }
      .form-banner-warning {
        background: rgba(255, 149, 0, 0.1);
        border: 1px solid rgba(255, 149, 0, 0.36);
        color: #c93400;
      }
      .coverage-preview {
        margin-top: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .coverage-preview-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .coverage-preview-title {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      .coverage-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .coverage-stats dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: 2px;
      }
      .coverage-stats dd {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .coverage-stats dd.warn {
        color: #c93400;
      }
      .coverage-stats dd.danger {
        color: #d70015;
      }
      .run-info,
      .ab-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-4);
        margin: 0;
      }
      .run-info dt,
      .ab-stats dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .run-info dd,
      .ab-stats dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .ab-stats .full {
        grid-column: 1 / -1;
      }
      .run-error {
        background: rgba(255, 59, 48, 0.06);
        border: 1px solid rgba(255, 59, 48, 0.2);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .engine-gap {
        background: var(--bg-primary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .engine-gap code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      /* Diagnostics panel */
      .diagnostics h4 {
        margin: 0 0 var(--space-4);
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .diag-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: var(--space-3);
      }
      .diag-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .diag-card h5 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .diag-card dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--space-1) var(--space-3);
        margin: 0;
      }
      .diag-card dl > div {
        display: contents;
      }
      .diag-card dt {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .diag-card dd {
        margin: 0;
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .diag-card .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        word-break: break-all;
      }
      .flag-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: center;
        margin-top: var(--space-4);
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .flag-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .flag-pill {
        display: inline-flex;
        align-items: center;
        padding: 2px var(--space-2);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        background: rgba(10, 132, 255, 0.12);
        color: #0a84ff;
      }
      .diag-details {
        margin-top: var(--space-3);
      }
      .diag-details summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: var(--space-2) 0;
      }
      .json {
        margin: var(--space-2) 0 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        max-height: 280px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .small {
        font-size: var(--text-xs);
      }

      /* Signal A/B detail */
      .ab-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      .ab-side {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .ab-side.champion {
        border-left: 3px solid #0071e3;
      }
      .ab-side.challenger {
        border-left: 3px solid #34c759;
      }
      .ab-side h5 {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .ab-side dl {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .ab-side dl > div {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .ab-side dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ab-side dd {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }

      @media (max-width: 768px) {
        .ab-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 1200px) {
        .metrics-row {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 768px) {
        .metrics-row {
          grid-template-columns: repeat(2, 1fr);
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
        .filter-bar {
          flex-direction: column;
        }
      }
    `,
  ],
})
export class MlModelsPageComponent implements OnInit {
  private readonly mlModelsService = inject(MLModelsService);
  private readonly mlEvaluationService = inject(MLEvaluationService);
  private readonly marketDataService = inject(MarketDataService);
  private readonly currencyPairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);
  private readonly relativeTimePipe = new RelativeTimePipe();

  private readonly registryTable = viewChild<DataTableComponent<MLModelDto>>('registryTable');
  private readonly trainingTable = viewChild<DataTableComponent<MLTrainingRunDto>>('trainingTable');
  private readonly shadowTable = viewChild<DataTableComponent<ShadowEvaluationDto>>('shadowTable');

  constructor() {
    // Model activation is a relatively rare event but it flips which model
    // scores live signals — refresh the registry grid so the operator sees
    // the new Active badge without manual F5. Throttle 2s in case the server
    // emits multiple activation events in quick succession (shadow promotion).
    this.realtime
      .on('mlModelActivated')
      .pipe(throttleTime(2_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.reloadRegistry());
  }

  reloadRegistry() {
    this.registryTable()?.loadData();
    this.loadModelAnalyticsSample();
  }
  reloadTraining() {
    this.trainingTable()?.loadData();
    this.loadTrainingAnalyticsSample();
  }
  reloadShadow() {
    this.shadowTable()?.loadData();
    this.loadShadowAnalyticsSample();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Registry analytics — fleet-wide sample fed to the KPI strip,
  // distribution charts, top/under-performer tables, and per-symbol
  // coverage table. Loaded once on init via ngAfterViewInit; refreshed
  // alongside the data table on every reloadRegistry() call.
  // ─────────────────────────────────────────────────────────────────────
  readonly modelsSample = signal<MLModelDto[]>([]);

  modelStats = computed(() => {
    const all = this.modelsSample();
    if (all.length === 0) {
      return {
        total: 0,
        active: 0,
        training: 0,
        superseded: 0,
        failed: 0,
        avgAccuracy: null as number | null,
        bestAccuracy: null as number | null,
        symbolCount: 0,
        timeframeCount: 0,
      };
    }
    let active = 0;
    let training = 0;
    let superseded = 0;
    let failed = 0;
    let accSum = 0;
    let accCount = 0;
    let bestAccuracy = 0;
    const symbols = new Set<string>();
    const timeframes = new Set<string>();
    for (const m of all) {
      if (m.symbol) symbols.add(m.symbol);
      if (m.timeframe) timeframes.add(String(m.timeframe));
      const status = String(m.status);
      if (status === 'Active') active++;
      else if (status === 'Training') training++;
      else if (status === 'Superseded') superseded++;
      else if (status === 'Failed') failed++;
      if (m.directionAccuracy != null) {
        accSum += m.directionAccuracy;
        accCount++;
        if (m.directionAccuracy > bestAccuracy) bestAccuracy = m.directionAccuracy;
      }
    }
    return {
      total: all.length,
      active,
      training,
      superseded,
      failed,
      avgAccuracy: accCount > 0 ? +(accSum / accCount).toFixed(2) : null,
      bestAccuracy: accCount > 0 ? +bestAccuracy.toFixed(2) : null,
      symbolCount: symbols.size,
      timeframeCount: timeframes.size,
    };
  });

  statusDonutOptions = computed<EChartsOption>(() => {
    const s = this.modelStats();
    if (s.total === 0) return {};
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
            { value: s.active, name: 'Active', itemStyle: { color: '#34C759' } },
            { value: s.training, name: 'Training', itemStyle: { color: '#5AC8FA' } },
            { value: s.superseded, name: 'Superseded', itemStyle: { color: '#8E8E93' } },
            { value: s.failed, name: 'Failed', itemStyle: { color: '#FF3B30' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  accuracyHistogramOptions = computed<EChartsOption>(() => {
    const accuracies = this.modelsSample()
      .map((m) => m.directionAccuracy)
      .filter((v): v is number => v != null);
    if (accuracies.length === 0) return {};
    const bins = 10;
    const counts = new Array(bins).fill(0);
    const labels: string[] = [];
    for (let i = 0; i < bins; i++) labels.push(`${i * 10}–${(i + 1) * 10}%`);
    for (const a of accuracies) {
      const idx = Math.min(Math.floor(a / 10), bins - 1);
      counts[idx]++;
    }
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            // 50% direction accuracy is coin-flip — anything below trends red.
            itemStyle: { color: i < 5 ? '#FF3B30' : '#34C759', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  bySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const m of this.modelsSample()) {
      const k = m.symbol ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 90 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
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

  topPerformers = computed(() =>
    [...this.modelsSample()]
      .filter((m) => m.directionAccuracy != null)
      .sort((a, b) => (b.directionAccuracy ?? 0) - (a.directionAccuracy ?? 0))
      .slice(0, 8),
  );

  underperformers = computed(() =>
    [...this.modelsSample()]
      .filter((m) => m.directionAccuracy != null)
      .sort((a, b) => (a.directionAccuracy ?? 0) - (b.directionAccuracy ?? 0))
      .slice(0, 8),
  );

  perSymbolBreakdown = computed(() => {
    type Row = {
      symbol: string;
      count: number;
      active: number;
      failed: number;
      bestAccuracy: number | null;
      avgAccuracy: number | null;
      totalSamples: number;
    };
    const groups: Record<string, Row & { _sum: number; _count: number }> = {};
    for (const m of this.modelsSample()) {
      const k = m.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = {
          symbol: k,
          count: 0,
          active: 0,
          failed: 0,
          bestAccuracy: null,
          avgAccuracy: null,
          totalSamples: 0,
          _sum: 0,
          _count: 0,
        };
      const g = groups[k];
      g.count++;
      g.totalSamples += m.trainingSamples ?? 0;
      const status = String(m.status);
      if (status === 'Active') g.active++;
      if (status === 'Failed') g.failed++;
      if (m.directionAccuracy != null) {
        g._sum += m.directionAccuracy;
        g._count++;
        if (g.bestAccuracy == null || m.directionAccuracy > g.bestAccuracy)
          g.bestAccuracy = m.directionAccuracy;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        symbol: g.symbol,
        count: g.count,
        active: g.active,
        failed: g.failed,
        bestAccuracy: g.bestAccuracy != null ? +g.bestAccuracy.toFixed(2) : null,
        avgAccuracy: g._count > 0 ? +(g._sum / g._count).toFixed(2) : null,
        totalSamples: g.totalSamples,
      }))
      .sort((a, b) => b.count - a.count);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Training-run analytics — same probe-and-fetch pattern as the registry
  // so KPIs reflect every run in the system, not just the visible page.
  // ─────────────────────────────────────────────────────────────────────
  readonly trainingsSample = signal<MLTrainingRunDto[]>([]);

  trainingStats = computed(() => {
    const all = this.trainingsSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        inFlight: 0,
        successRate: null as number | null,
        avgAccuracy: null as number | null,
        avgDurationMin: null as number | null,
        last24h: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let inFlight = 0;
    let accSum = 0;
    let accCount = 0;
    let durSum = 0;
    let durCount = 0;
    let last24h = 0;
    const dayAgo = Date.now() - 86400000;
    for (const r of all) {
      const status = String(r.status);
      if (status === 'Completed') completed++;
      else if (status === 'Failed') failed++;
      else inFlight++;
      if (r.directionAccuracy != null) {
        accSum += r.directionAccuracy;
        accCount++;
      }
      if (r.completedAt && r.startedAt) {
        durSum += (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 60000;
        durCount++;
      }
      if (r.startedAt && new Date(r.startedAt).getTime() >= dayAgo) last24h++;
    }
    return {
      total: all.length,
      completed,
      failed,
      inFlight,
      successRate:
        completed + failed > 0 ? +((completed / (completed + failed)) * 100).toFixed(1) : null,
      avgAccuracy: accCount > 0 ? +((accSum / accCount) * 100).toFixed(2) : null,
      avgDurationMin: durCount > 0 ? +(durSum / durCount).toFixed(1) : null,
      last24h,
    };
  });

  trainingStatusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.trainingsSample()) {
      const k = String(r.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Completed: '#34C759',
      Failed: '#FF3B30',
      Pending: '#5AC8FA',
      Running: '#0071E3',
      Cancelled: '#8E8E93',
    };
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
          data: Object.entries(counts).map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  trainingBySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.trainingsSample()) {
      const k = r.symbol ?? 'unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 90 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
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

  trainingActivityOptions = computed<EChartsOption>(() => {
    const buckets: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const r of this.trainingsSample()) {
      if (!r.startedAt) continue;
      const day = r.startedAt.slice(0, 10);
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
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
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

  perTriggerBreakdown = computed(() => {
    type Row = {
      trigger: string;
      runs: number;
      completed: number;
      failed: number;
      successPct: number;
      avgAccuracy: number | null;
      _accSum: number;
      _accCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const r of this.trainingsSample()) {
      const k = String(r.triggerType ?? 'unknown');
      if (!groups[k])
        groups[k] = {
          trigger: k,
          runs: 0,
          completed: 0,
          failed: 0,
          successPct: 0,
          avgAccuracy: null,
          _accSum: 0,
          _accCount: 0,
        };
      const g = groups[k];
      g.runs++;
      if (String(r.status) === 'Completed') g.completed++;
      else if (String(r.status) === 'Failed') g.failed++;
      if (r.directionAccuracy != null) {
        g._accSum += r.directionAccuracy;
        g._accCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        trigger: g.trigger,
        runs: g.runs,
        completed: g.completed,
        failed: g.failed,
        successPct: g.completed + g.failed > 0 ? (g.completed / (g.completed + g.failed)) * 100 : 0,
        avgAccuracy: g._accCount > 0 ? +((g._accSum / g._accCount) * 100).toFixed(2) : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  recentTrainingRuns = computed(() =>
    [...this.trainingsSample()]
      .filter((r) => !!r.startedAt)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 8),
  );

  // ─────────────────────────────────────────────────────────────────────
  // Signal-A/B analytics — same probe-and-fetch pattern.
  // ─────────────────────────────────────────────────────────────────────
  readonly abSample = signal<MLSignalAbTestResultDto[]>([]);

  abStats = computed(() => {
    const all = this.abSample();
    if (all.length === 0) {
      return {
        total: 0,
        running: 0,
        completed: 0,
        championWins: 0,
        challengerWins: 0,
        inconclusive: 0,
        avgLift: null as number | null,
        totalSamples: 0,
      };
    }
    let running = 0;
    let completed = 0;
    let championWins = 0;
    let challengerWins = 0;
    let inconclusive = 0;
    let liftSum = 0;
    let liftCount = 0;
    let totalSamples = 0;
    for (const t of all) {
      const status = String(t.status);
      if (status === 'Running') running++;
      else if (status === 'Completed') completed++;
      const decision = String(t.decision ?? '');
      if (decision === 'ChampionWon') championWins++;
      else if (decision === 'ChallengerWon') challengerWins++;
      else if (decision === 'Inconclusive') inconclusive++;
      if (status === 'Completed') {
        liftSum += t.challengerPnl - t.championPnl;
        liftCount++;
      }
      totalSamples += t.sampleSize ?? 0;
    }
    return {
      total: all.length,
      running,
      completed,
      championWins,
      challengerWins,
      inconclusive,
      avgLift: liftCount > 0 ? +(liftSum / liftCount).toFixed(2) : null,
      totalSamples,
    };
  });

  abStatusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const t of this.abSample()) {
      const k = String(t.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Running: '#0071E3',
      Completed: '#34C759',
      Cancelled: '#8E8E93',
    };
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
          data: Object.entries(counts).map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  abDecisionDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const t of this.abSample()) {
      const k = String(t.decision ?? 'Pending');
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      ChampionWon: '#0071E3',
      ChallengerWon: '#34C759',
      Inconclusive: '#FF9500',
      Pending: '#8E8E93',
    };
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
          data: Object.entries(counts).map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  abLiftHistogramOptions = computed<EChartsOption>(() => {
    const lifts = this.abSample()
      .filter((t) => String(t.status) === 'Completed')
      .map((t) => t.challengerPnl - t.championPnl);
    if (lifts.length === 0) return {};
    const min = Math.min(...lifts);
    const max = Math.max(...lifts);
    if (max === min) {
      return {
        grid: { top: 10, right: 20, bottom: 30, left: 40 },
        xAxis: { type: 'category', data: [`${min.toFixed(1)}`] },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'bar',
            data: [{ value: lifts.length, itemStyle: { color: '#0071E3' } }],
            barWidth: '40%',
          },
        ],
      };
    }
    const bins = 12;
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    const labels: string[] = [];
    for (let i = 0; i < bins; i++) {
      labels.push(`${(min + i * width).toFixed(1)}`);
    }
    for (const v of lifts) {
      const idx = Math.min(Math.floor((v - min) / width), bins - 1);
      counts[idx]++;
    }
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            // Negative lift bins (left half) red, positive green; threshold
            // depends on whether 0 is in the range.
            itemStyle: {
              color: min + (i + 0.5) * width >= 0 ? '#34C759' : '#FF3B30',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  abTopLifts = computed(() =>
    [...this.abSample()]
      .filter((t) => String(t.status) === 'Completed')
      .sort((a, b) => b.challengerPnl - b.championPnl - (a.challengerPnl - a.championPnl))
      .slice(0, 8),
  );

  abPerSymbol = computed(() => {
    type Row = {
      symbol: string;
      tests: number;
      championWins: number;
      challengerWins: number;
      inconclusive: number;
      avgLift: number;
      _liftSum: number;
      _liftCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const t of this.abSample()) {
      const k = t.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = {
          symbol: k,
          tests: 0,
          championWins: 0,
          challengerWins: 0,
          inconclusive: 0,
          avgLift: 0,
          _liftSum: 0,
          _liftCount: 0,
        };
      const g = groups[k];
      g.tests++;
      const decision = String(t.decision ?? '');
      if (decision === 'ChampionWon') g.championWins++;
      else if (decision === 'ChallengerWon') g.challengerWins++;
      else if (decision === 'Inconclusive') g.inconclusive++;
      if (String(t.status) === 'Completed') {
        g._liftSum += t.challengerPnl - t.championPnl;
        g._liftCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        symbol: g.symbol,
        tests: g.tests,
        championWins: g.championWins,
        challengerWins: g.challengerWins,
        inconclusive: g.inconclusive,
        avgLift: g._liftCount > 0 ? +(g._liftSum / g._liftCount).toFixed(2) : 0,
      }))
      .sort((a, b) => b.tests - a.tests);
  });

  private abAnalyticsLoaded = false;
  private loadAbAnalyticsSample(): void {
    this.mlModelsService
      .listSignalAbTests({ currentPage: 1, itemCountPerPage: 1, filter: null })
      .subscribe({
        next: (probe) => {
          const total = probe?.data?.pager?.totalItemCount ?? 0;
          if (total === 0) {
            this.abSample.set([]);
            this.abAnalyticsLoaded = true;
            return;
          }
          this.mlModelsService
            .listSignalAbTests({
              currentPage: 1,
              itemCountPerPage: Math.min(total, 5000),
              filter: null,
            })
            .subscribe({
              next: (full) => {
                this.abSample.set(full?.data?.data ?? []);
                this.abAnalyticsLoaded = true;
              },
              error: () => {
                this.abAnalyticsLoaded = false;
              },
            });
        },
        error: () => {
          this.abAnalyticsLoaded = false;
        },
      });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Shadow-arena analytics — same probe-and-fetch pattern.
  // ─────────────────────────────────────────────────────────────────────
  readonly shadowSample = signal<ShadowEvaluationDto[]>([]);

  shadowStats = computed(() => {
    const all = this.shadowSample();
    if (all.length === 0) {
      return {
        total: 0,
        running: 0,
        processing: 0,
        completed: 0,
        promoted: 0,
        rejected: 0,
        promotionRate: null as number | null,
        avgLift: null as number | null,
      };
    }
    let running = 0;
    let processing = 0;
    let completed = 0;
    let promoted = 0;
    let rejected = 0;
    let liftSum = 0;
    let liftCount = 0;
    for (const e of all) {
      const status = String(e.status);
      if (status === 'Running') running++;
      else if (status === 'Processing') processing++;
      else if (status === 'Completed') completed++;
      const decision = String(e.promotionDecision);
      if (decision === 'Promoted') promoted++;
      else if (decision === 'Rejected') rejected++;
      if (status === 'Completed') {
        liftSum += e.challengerDirectionAccuracy - e.championDirectionAccuracy;
        liftCount++;
      }
    }
    return {
      total: all.length,
      running,
      processing,
      completed,
      promoted,
      rejected,
      promotionRate:
        promoted + rejected > 0 ? +((promoted / (promoted + rejected)) * 100).toFixed(1) : null,
      avgLift: liftCount > 0 ? +((liftSum / liftCount) * 100).toFixed(2) : null,
    };
  });

  shadowStatusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const e of this.shadowSample()) {
      const k = String(e.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Running: '#0071E3',
      Processing: '#FF9500',
      Completed: '#34C759',
      Cancelled: '#8E8E93',
    };
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
          data: Object.entries(counts).map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  shadowDecisionDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const e of this.shadowSample()) {
      const k = String(e.promotionDecision);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Promoted: '#34C759',
      Rejected: '#FF3B30',
      Pending: '#5AC8FA',
      None: '#8E8E93',
    };
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
          data: Object.entries(counts).map(([name, value]) => ({
            name,
            value,
            itemStyle: { color: colors[name] ?? '#8E8E93' },
          })),
        },
      ],
    };
  });

  shadowProgressOptions = computed<EChartsOption>(() => {
    const inflight = this.shadowSample()
      .filter((e) => String(e.status) === 'Running' || String(e.status) === 'Processing')
      .filter((e) => (e.requiredTrades ?? 0) > 0)
      .sort((a, b) => b.completedTrades / b.requiredTrades - a.completedTrades / a.requiredTrades)
      .slice(0, 12);
    if (inflight.length === 0) return {};
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) =>
          params.map((p: any) => `${p.seriesName}: ${p.value}`).join('<br/>'),
      },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 25, right: 30, bottom: 30, left: 100 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: inflight.map((e) => `${e.symbol} #${e.id}`).reverse(),
        axisLabel: { fontSize: 9, color: '#6E6E73' },
      },
      series: [
        {
          name: 'Completed',
          type: 'bar',
          stack: 'progress',
          data: inflight.map((e) => e.completedTrades).reverse(),
          itemStyle: { color: '#34C759' },
          barWidth: 12,
        },
        {
          name: 'Remaining',
          type: 'bar',
          stack: 'progress',
          data: inflight.map((e) => Math.max(0, e.requiredTrades - e.completedTrades)).reverse(),
          itemStyle: { color: '#FF9500' },
          barWidth: 12,
        },
      ],
    };
  });

  topLifts = computed(() =>
    [...this.shadowSample()]
      .filter((e) => String(e.status) === 'Completed')
      .sort(
        (a, b) =>
          b.challengerDirectionAccuracy -
          b.championDirectionAccuracy -
          (a.challengerDirectionAccuracy - a.championDirectionAccuracy),
      )
      .slice(0, 8),
  );

  shadowPerSymbol = computed(() => {
    type Row = {
      symbol: string;
      evals: number;
      promoted: number;
      rejected: number;
      inFlight: number;
      promotePct: number;
    };
    const groups: Record<string, Row> = {};
    for (const e of this.shadowSample()) {
      const k = e.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = { symbol: k, evals: 0, promoted: 0, rejected: 0, inFlight: 0, promotePct: 0 };
      const g = groups[k];
      g.evals++;
      const decision = String(e.promotionDecision);
      if (decision === 'Promoted') g.promoted++;
      else if (decision === 'Rejected') g.rejected++;
      else g.inFlight++;
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        promotePct:
          g.promoted + g.rejected > 0 ? (g.promoted / (g.promoted + g.rejected)) * 100 : 0,
      }))
      .sort((a, b) => b.evals - a.evals);
  });

  private shadowAnalyticsLoaded = false;
  private loadShadowAnalyticsSample(): void {
    this.mlEvaluationService
      .listShadow({ currentPage: 1, itemCountPerPage: 1, filter: null })
      .subscribe({
        next: (probe) => {
          const total = probe?.data?.pager?.totalItemCount ?? 0;
          if (total === 0) {
            this.shadowSample.set([]);
            this.shadowAnalyticsLoaded = true;
            return;
          }
          this.mlEvaluationService
            .listShadow({
              currentPage: 1,
              itemCountPerPage: Math.min(total, 5000),
              filter: null,
            })
            .subscribe({
              next: (full) => {
                this.shadowSample.set(full?.data?.data ?? []);
                this.shadowAnalyticsLoaded = true;
              },
              error: () => {
                this.shadowAnalyticsLoaded = false;
              },
            });
        },
        error: () => {
          this.shadowAnalyticsLoaded = false;
        },
      });
  }

  private trainingAnalyticsLoaded = false;
  private loadTrainingAnalyticsSample(): void {
    this.mlModelsService
      .listTrainingRuns({ currentPage: 1, itemCountPerPage: 1, filter: null })
      .subscribe({
        next: (probe) => {
          const total = probe?.data?.pager?.totalItemCount ?? 0;
          if (total === 0) {
            this.trainingsSample.set([]);
            this.trainingAnalyticsLoaded = true;
            return;
          }
          // Cap large fleets at 5000 — pulling 50,000 training runs into the
          // browser would tank the page. KPIs over the most-recent 5k stays
          // representative, and the paged table below still shows everything.
          this.mlModelsService
            .listTrainingRuns({
              currentPage: 1,
              itemCountPerPage: Math.min(total, 5000),
              filter: null,
            })
            .subscribe({
              next: (full) => {
                this.trainingsSample.set(full?.data?.data ?? []);
                this.trainingAnalyticsLoaded = true;
              },
              error: () => {
                this.trainingAnalyticsLoaded = false;
              },
            });
        },
        error: () => {
          this.trainingAnalyticsLoaded = false;
        },
      });
  }

  private analyticsLoaded = false;
  private loadModelAnalyticsSample(): void {
    // Adaptive probe-and-fetch: a 1-row request reveals the true server total
    // via pager.totalItemCount, then we fetch exactly that many rows so the
    // KPI strip + distribution charts reflect every model in the registry
    // instead of an arbitrary cap. Pagination on the data-table below stays
    // server-side and unaffected.
    this.mlModelsService.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.modelsSample.set([]);
          this.analyticsLoaded = true;
          return;
        }
        this.mlModelsService
          .list({ currentPage: 1, itemCountPerPage: total, filter: null })
          .subscribe({
            next: (full) => {
              this.modelsSample.set(full?.data?.data ?? []);
              this.analyticsLoaded = true;
            },
            error: () => {
              this.analyticsLoaded = false;
            },
          });
      },
      error: () => {
        this.analyticsLoaded = false;
      },
    });
  }

  // ── Tab state ──
  tabs: TabItem[] = [
    { label: 'Model Registry', value: 'registry' },
    { label: 'Model Monitor', value: 'monitor' },
    { label: 'Training Lab', value: 'training' },
    { label: 'Architecture', value: 'architecture' },
    { label: 'Shadow Arena', value: 'shadow' },
    { label: 'Signal A/B', value: 'signal-ab' },
  ];
  activeTab = signal('registry');

  // ── Registry state ──
  filterStatus = signal('');
  filterSymbol = signal('');

  // ── Monitor state ──
  monitorModels = signal<MLModelDto[]>([]);
  selectedModelId = signal<number | null>(null);
  monitorModel = signal<MLModelDto | null>(null);

  // ── Monitor-tab derived metrics ─────────────────────────────────────
  modelAgeDays = computed<number | null>(() => {
    const m = this.monitorModel();
    if (!m?.trainedAt) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(m.trainedAt).getTime()) / 86400000));
  });

  daysServing = computed<number | null>(() => {
    const m = this.monitorModel();
    if (!m?.activatedAt) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(m.activatedAt).getTime()) / 86400000));
  });

  samplesPerDay = computed<number | null>(() => {
    const m = this.monitorModel();
    if (!m?.trainedAt) return null;
    const days = (Date.now() - new Date(m.trainedAt).getTime()) / 86400000;
    if (days <= 0) return null;
    return +(m.trainingSamples / days).toFixed(0);
  });

  outcomeBreakdownOptions = computed<EChartsOption>(() => {
    const m = this.monitorModel();
    if (!m) return {};
    const samples = m.trainingSamples ?? 0;
    const acc = m.directionAccuracy ?? 0;
    const wins = Math.round(samples * acc);
    const losses = samples - wins;
    if (samples === 0) return {};
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
            { value: wins, name: 'Correct', itemStyle: { color: '#34C759' } },
            { value: losses, name: 'Incorrect', itemStyle: { color: '#FF3B30' } },
          ],
        },
      ],
    };
  });

  // Lineage: every model registered for the same symbol/timeframe slot.
  lineage = computed(() => {
    const m = this.monitorModel();
    if (!m) return [];
    return [...this.modelsSample()]
      .filter((x) => x.symbol === m.symbol && x.timeframe === m.timeframe)
      .sort((a, b) => new Date(b.trainedAt).getTime() - new Date(a.trainedAt).getTime());
  });

  versionLineageOptions = computed<EChartsOption>(() => {
    const versions = this.lineage();
    if (versions.length === 0) return {};
    // Render oldest-first for left-to-right time progression on the chart.
    const ordered = [...versions].reverse();
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 20, right: 20, bottom: 35, left: 50 },
      xAxis: {
        type: 'category',
        data: ordered.map((v) => v.modelVersion?.slice(0, 14) ?? `#${v.id}`),
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35, interval: 0 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value}%', fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'line',
          data: ordered.map((v) => +((v.directionAccuracy ?? 0) * 100).toFixed(1)),
          smooth: false,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
          markLine: {
            silent: true,
            data: [
              {
                yAxis: 50,
                lineStyle: { color: '#FF3B30', type: 'dashed' },
                label: { formatter: 'coin-flip' },
              },
            ],
          },
        },
      ],
    };
  });

  sampleLeverageOptions = computed<EChartsOption>(() => {
    const versions = this.lineage();
    if (versions.length === 0) return {};
    const sorted = [...versions]
      .sort((a, b) => (b.trainingSamples ?? 0) - (a.trainingSamples ?? 0))
      .slice(0, 8);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 30, bottom: 30, left: 100 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((v) => v.modelVersion?.slice(0, 14) ?? `#${v.id}`).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: sorted
            .map((v) => ({
              value: v.trainingSamples ?? 0,
              itemStyle: {
                color:
                  (v.directionAccuracy ?? 0) > 0.55
                    ? '#34C759'
                    : (v.directionAccuracy ?? 0) < 0.5
                      ? '#FF3B30'
                      : '#FF9500',
                borderRadius: [0, 4, 4, 0],
              },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  private readonly fb = inject(FormBuilder);

  // ── Training state ──
  showTrainingModal = signal(false);
  submittingTraining = signal(false);
  selectedTrainingRun = signal<MLTrainingRunDto | null>(null);
  diagnostics = signal<MLTrainingRunDiagnosticsDto | null>(null);
  loadingDiagnostics = signal(false);
  isPolling = signal(false);
  // Wall-clock signal that ticks every second while a non-terminal run is open. Drives
  // the live elapsed-time / queue-wait readouts; updating a signal at 1Hz is far cheaper
  // than re-computing from `new Date()` in every change-detection cycle, since change
  // detection is OnPush and won't refresh those values otherwise.
  nowTick = signal(Date.now());
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private nowTickTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 5_000;
  private readonly runDetailRef = viewChild<ElementRef<HTMLDivElement>>('runDetail');
  private readonly destroyRef = inject(DestroyRef);

  // ── Live progress computeds ─────────────────────────────────────────────
  isInFlight = computed(() => {
    const s = this.selectedTrainingRun()?.status;
    return s === 'Queued' || s === 'Running';
  });

  // Reads pickedUpAt from diagnostics (when available) — that's when the trainer actually
  // started work, distinct from queueing time. Falls back to startedAt for runs whose
  // diagnostics haven't loaded yet or that lack a pickup timestamp.
  elapsedMs = computed<number>(() => {
    const run = this.selectedTrainingRun();
    if (!run) return 0;
    const diag = this.diagnostics();
    const startIso = diag?.pickedUpAt ?? run.startedAt;
    const start = new Date(startIso).getTime();
    if (Number.isNaN(start)) return 0;
    const end = run.completedAt ? new Date(run.completedAt).getTime() : this.nowTick();
    return Math.max(0, end - start);
  });

  queueWaitMs = computed<number | null>(() => {
    const diag = this.diagnostics();
    const run = this.selectedTrainingRun();
    if (!diag?.pickedUpAt || !run) return null;
    const queued = new Date(run.startedAt).getTime();
    const picked = new Date(diag.pickedUpAt).getTime();
    if (Number.isNaN(queued) || Number.isNaN(picked)) return null;
    return Math.max(0, picked - queued);
  });

  phaseLabel = computed<string>(() => {
    const status = this.selectedTrainingRun()?.status;
    const pickedUp = this.diagnostics()?.pickedUpAt;
    if (status === 'Queued') return 'Queued — waiting for worker';
    if (status === 'Running') return pickedUp ? 'Training — elapsed' : 'Running — elapsed';
    return 'Elapsed';
  });
  trainingForm = this.fb.nonNullable.group(
    {
      symbol: ['', Validators.required],
      timeframe: ['H1' as Timeframe, Validators.required],
      fromDate: ['', Validators.required],
      toDate: ['', Validators.required],
      learnerArchitecture: [0, Validators.required],
    },
    { validators: [trainingDateRangeValidator] },
  );

  // Cached today-as-ISO so the [max] attribute on date inputs renders deterministically
  // and stays consistent through change detection cycles.
  readonly todayIso = new Date().toISOString().slice(0, 10);

  // Live candle-coverage preview for the trigger modal — lets operators see how much
  // data their requested window will actually contain BEFORE submitting, instead of
  // discovering post-hoc that a 7-year request collapsed to 10 months because of a
  // gap in the candle table.
  coveragePreview = signal<CandleCoverageDto | null>(null);
  coverageLoading = signal(false);
  coverageError = signal<string | null>(null);
  private coverageFetchTimer: ReturnType<typeof setTimeout> | null = null;

  // Symbol suggestions for the trigger modal's combobox (HTML5 <datalist>).
  // Native datalist behaviour: free typing AND autocomplete from the suggestions —
  // operators can type "EUR" and see EURUSD/EURGBP/EURJPY filter live, or paste a
  // pair the engine doesn't track yet (the server-side coverage probe will then
  // surface "no candles for this pair" as the rejection reason).
  symbolOptions = signal<string[]>([]);
  private symbolOptionsLoaded = false;

  // Typed accessor for cross-field hard errors so the strict template checker is happy.
  trainingDateError(key: 'dateOrder' | 'fromDateInFuture' | 'toDateInFuture'): boolean {
    const errors = this.trainingForm.errors;
    if (!errors) return false;
    return Boolean((errors as Record<string, boolean>)[key]);
  }

  // Soft warning — doesn't invalidate the form, just flags an unusual choice. >20y is
  // typically larger than EA-ingested candle history, so most of the window is empty.
  trainingWindowYears(): number | null {
    const from = this.trainingForm.controls.fromDate.value;
    const to = this.trainingForm.controls.toDate.value;
    if (!from || !to) return null;
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) return null;
    const years = (toMs - fromMs) / (365.25 * 24 * 60 * 60 * 1000);
    return years > 20 ? Math.round(years) : null;
  }

  // Mirror of LascodiaTradingEngine.Domain.Enums.LearnerArchitecture — keep in sync
  // with the engine enum. Operator picks one when manually triggering a training run;
  // the value is sent as the integer enum value (defaults to BaggedLogistic = 0).
  readonly learnerArchitectures: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0, label: 'BaggedLogistic (default)' },
    { value: 1, label: 'TemporalConvNet' },
    { value: 3, label: 'Gbm' },
    { value: 6, label: 'AdaBoost' },
    { value: 30, label: 'Svgp' },
    { value: 32, label: 'Elm' },
    { value: 69, label: 'Dann' },
    { value: 74, label: 'Rocket' },
    { value: 75, label: 'TabNet' },
    { value: 76, label: 'FtTransformer' },
    { value: 81, label: 'Smote' },
    { value: 90, label: 'QuantileRf' },
    { value: 92, label: 'Stacked' },
  ];

  // ── Shadow state ──
  showShadowModal = signal(false);
  submittingShadow = signal(false);
  selectedShadow = signal<ShadowEvaluationDto | null>(null);
  shadowForm = this.fb.nonNullable.group({
    championModelId: [0, [Validators.required, Validators.min(1)]],
    challengerModelId: [0, [Validators.required, Validators.min(1)]],
    symbol: ['', Validators.required],
    timeframe: ['H1' as Timeframe, Validators.required],
    requiredTrades: [100, [Validators.required, Validators.min(1)]],
  });

  // ══════════════════════════════════════════════════════════════
  //  REGISTRY COLUMNS
  // ══════════════════════════════════════════════════════════════

  registryColumns: ColDef<MLModelDto>[] = [
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 100 },
    { headerName: 'Timeframe', field: 'timeframe', width: 100 },
    { headerName: 'Version', field: 'modelVersion', width: 90 },
    {
      headerName: 'Status',
      field: 'status',
      width: 110,
      cellRenderer: (params: { value: string }) => {
        const colorMap: Record<string, { bg: string; color: string }> = {
          Training: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Active: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Superseded: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          Failed: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
        };
        const s = colorMap[params.value] ?? colorMap['Failed'];
        return `<span style="color:${s.color};background:${s.bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'Architecture',
      field: 'learnerArchitecture',
      width: 150,
      valueFormatter: (p: { value: string | null }) => p.value ?? '—',
      cellStyle: { fontFamily: "'SF Mono', 'Menlo', monospace", fontSize: '12px' },
    },
    {
      headerName: 'Accuracy %',
      field: 'directionAccuracy',
      width: 110,
      valueFormatter: (p: { value: number | null }) =>
        p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Mag. RMSE',
      field: 'magnitudeRMSE',
      width: 110,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? p.value.toFixed(4) : '-'),
    },
    { headerName: 'Samples', field: 'trainingSamples', width: 110 },
    {
      headerName: 'Active',
      field: 'isActive',
      width: 80,
      cellRenderer: (params: { value: boolean }) => {
        const color = params.value ? '#248A3D' : '#636366';
        const bg = params.value ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const label = params.value ? 'Yes' : 'No';
        return `<span style="color:${color};background:${bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Trained At',
      field: 'trainedAt',
      width: 130,
      valueFormatter: (p: { value: string }) =>
        p.value ? this.relativeTimePipe.transform(p.value) : '-',
    },
  ];

  // ══════════════════════════════════════════════════════════════
  //  TRAINING COLUMNS
  // ══════════════════════════════════════════════════════════════

  trainingColumns: ColDef<MLTrainingRunDto>[] = [
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 100 },
    { headerName: 'Timeframe', field: 'timeframe', width: 100 },
    {
      headerName: 'Status',
      field: 'status',
      width: 110,
      cellRenderer: (params: { value: string }) => {
        const colorMap: Record<string, { bg: string; color: string }> = {
          Queued: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          Running: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Completed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Failed: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
        };
        const s = colorMap[params.value] ?? colorMap['Failed'];
        return `<span style="color:${s.color};background:${s.bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'Trigger',
      field: 'triggerType',
      width: 150,
      cellRenderer: (params: { value: string | null }) => {
        const value = params.value ?? '—';
        // Operator-initiated runs get the prominent purple highlight to make them
        // easy to spot against the wall of automated retrains.
        const colorMap: Record<string, { bg: string; color: string; label?: string }> = {
          Manual: { bg: 'rgba(175,82,222,0.14)', color: '#8944AB' },
          Scheduled: { bg: 'rgba(0,113,227,0.10)', color: '#0040DD' },
          AutoDegrading: {
            bg: 'rgba(255,149,0,0.12)',
            color: '#C93400',
            label: 'Auto · Degrading',
          },
          AutoDeferred: {
            bg: 'rgba(52,199,89,0.10)',
            color: '#248A3D',
            label: 'Auto · Deferred',
          },
          SymbolicCatalogueShift: {
            bg: 'rgba(0,113,227,0.10)',
            color: '#0040DD',
            label: 'Symbolic shift',
          },
        };
        const s = colorMap[value] ?? { bg: 'rgba(142,142,147,0.12)', color: '#636366' };
        const label = s.label ?? value;
        return `<span title="${value}" style="color:${s.color};background:${s.bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap">${label}</span>`;
      },
    },
    {
      headerName: 'Architecture',
      field: 'learnerArchitecture',
      width: 150,
      valueFormatter: (p: { value: string | null }) => p.value ?? '—',
      cellStyle: { fontFamily: "'SF Mono', 'Menlo', monospace", fontSize: '12px' },
    },
    {
      headerName: 'Accuracy',
      field: 'directionAccuracy',
      width: 100,
      valueFormatter: (p: { value: number | null }) =>
        p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Mag. RMSE',
      field: 'magnitudeRMSE',
      width: 100,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? p.value.toFixed(4) : '-'),
    },
    {
      headerName: 'Started',
      field: 'startedAt',
      width: 130,
      valueFormatter: (p: { value: string }) =>
        p.value ? this.relativeTimePipe.transform(p.value) : '-',
    },
  ];

  // ══════════════════════════════════════════════════════════════
  //  SHADOW COLUMNS
  // ══════════════════════════════════════════════════════════════

  shadowColumns: ColDef<ShadowEvaluationDto>[] = [
    { headerName: 'Champion Model', field: 'championModelId', width: 140 },
    { headerName: 'Challenger Model', field: 'challengerModelId', width: 150 },
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 100 },
    {
      headerName: 'Status',
      field: 'status',
      width: 120,
      cellRenderer: (params: { value: string }) => {
        const colorMap: Record<string, { bg: string; color: string }> = {
          Running: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Completed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Promoted: { bg: 'rgba(175,82,222,0.12)', color: '#8944AB' },
          Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Processing: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
        };
        const s = colorMap[params.value] ?? { bg: 'rgba(142,142,147,0.12)', color: '#636366' };
        return `<span style="color:${s.color};background:${s.bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'Champion Acc',
      field: 'championDirectionAccuracy',
      width: 130,
      valueFormatter: (p: { value: number | null }) =>
        p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Challenger Acc',
      field: 'challengerDirectionAccuracy',
      width: 130,
      valueFormatter: (p: { value: number | null }) =>
        p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Started',
      field: 'startedAt',
      width: 130,
      valueFormatter: (p: { value: string }) =>
        p.value ? this.relativeTimePipe.transform(p.value) : '-',
    },
  ];

  // ══════════════════════════════════════════════════════════════
  //  ARCHITECTURE-TAB ANALYTICS
  // ══════════════════════════════════════════════════════════════

  /**
   * Probe-and-fetch the entire model fleet (capped at 5000) for the
   * Architecture tab's analytics. Polled every 2 minutes — model fleet
   * changes slowly. The cost is one round-trip: probe with size=1 to read
   * `pager.totalItemCount`, then fetch min(total, 5000) models.
   */
  private readonly archAnalyticsResource = createPolledResource(
    () =>
      this.mlModelsService.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).pipe(
        switchMap((probe) => {
          const total = probe.data?.pager?.totalItemCount ?? 0;
          const limit = Math.min(total, 5000);
          if (limit === 0) return of({ rows: [] as MLModelDto[], total });
          return this.mlModelsService
            .list({ currentPage: 1, itemCountPerPage: limit, filter: null })
            .pipe(map((r) => ({ rows: r.data?.data ?? [], total })));
        }),
        catchError(() => of({ rows: [] as MLModelDto[], total: 0 })),
      ),
    { intervalMs: 120_000 },
  );

  readonly archAnalyticsRows = computed(() => this.archAnalyticsResource.value()?.rows ?? []);
  readonly archAnalyticsTotal = computed(() => this.archAnalyticsResource.value()?.total ?? 0);

  /**
   * Stable per-architecture colour assignment so every chart and pill agrees
   * on what colour each architecture is. Sorted alphabetically so order is
   * deterministic across renders, then mapped onto the Apple-style palette.
   */
  private readonly archPalette = [
    '#0071E3',
    '#34C759',
    '#FF9500',
    '#FF3B30',
    '#AF52DE',
    '#5AC8FA',
    '#FFCC00',
    '#8E8E93',
    '#FF6482',
    '#30B0C7',
    '#A2845E',
    '#BF5AF2',
  ];

  readonly archColorMap = computed<Record<string, string>>(() => {
    const set = new Set<string>();
    for (const m of this.archAnalyticsRows()) {
      if (m.learnerArchitecture) set.add(m.learnerArchitecture);
    }
    const sorted = Array.from(set).sort();
    const map: Record<string, string> = {};
    for (let i = 0; i < sorted.length; i++) {
      map[sorted[i]] = this.archPalette[i % this.archPalette.length];
    }
    return map;
  });

  /**
   * Per-architecture aggregate row. One entry per distinct architecture in
   * the fleet sample, sorted by model count desc.
   */
  readonly archLeaderboard = computed(() => {
    const groups = new Map<string, MLModelDto[]>();
    for (const m of this.archAnalyticsRows()) {
      const arch = m.learnerArchitecture || 'Unknown';
      const list = groups.get(arch) ?? [];
      list.push(m);
      groups.set(arch, list);
    }
    const colors = this.archColorMap();
    return Array.from(groups.entries())
      .map(([arch, models]) => {
        const accuracies = models
          .map((m) => m.directionAccuracy)
          .filter((v): v is number => v !== null && Number.isFinite(v));
        const rmses = models
          .map((m) => m.magnitudeRMSE)
          .filter((v): v is number => v !== null && Number.isFinite(v));
        const active = models.filter((m) => m.isActive).length;
        const training = models.filter((m) => m.status === 'Training').length;
        const superseded = models.filter((m) => m.status === 'Superseded').length;
        const failed = models.filter((m) => m.status === 'Failed').length;
        // Latest training timestamp gives operators a "is this arch still
        // being trained?" signal — stale arches drop to the bottom.
        const trainedAtTimes = models
          .map((m) => (m.trainedAt ? new Date(m.trainedAt).getTime() : 0))
          .filter((t) => t > 0);
        const latestTrainedAt =
          trainedAtTimes.length > 0 ? new Date(Math.max(...trainedAtTimes)).toISOString() : null;
        return {
          architecture: arch,
          color: colors[arch] ?? '#8E8E93',
          count: models.length,
          active,
          training,
          superseded,
          failed,
          activationRate: models.length > 0 ? active / models.length : 0,
          avgAccuracy: avg(accuracies),
          medianAccuracy: median(accuracies),
          bestAccuracy: accuracies.length > 0 ? Math.max(...accuracies) : 0,
          worstAccuracy: accuracies.length > 0 ? Math.min(...accuracies) : 0,
          accuracies,
          avgRMSE: avg(rmses),
          totalSamples: models.reduce((s, m) => s + (m.trainingSamples ?? 0), 0),
          latestTrainedAt,
        };
      })
      .sort((a, b) => b.count - a.count);
  });

  // Top-by-X helpers for the KPI strip.
  readonly archTopByCount = computed(() => this.archLeaderboard()[0] ?? null);
  readonly archTopByAccuracy = computed(() => {
    const rows = this.archLeaderboard().filter((r) => r.avgAccuracy > 0);
    return rows.length > 0
      ? rows.reduce((best, r) => (r.avgAccuracy > best.avgAccuracy ? r : best))
      : null;
  });
  readonly archTopByActivation = computed(() => {
    const rows = this.archLeaderboard().filter((r) => r.count > 0);
    return rows.length > 0
      ? rows.reduce((best, r) => (r.activationRate > best.activationRate ? r : best))
      : null;
  });
  readonly archTopByRmse = computed(() => {
    const rows = this.archLeaderboard().filter((r) => r.avgRMSE > 0);
    return rows.length > 0 ? rows.reduce((best, r) => (r.avgRMSE < best.avgRMSE ? r : best)) : null;
  });

  readonly archActiveTotal = computed(() =>
    this.archLeaderboard().reduce((s, r) => s + r.active, 0),
  );
  readonly archFailedTotal = computed(() =>
    this.archLeaderboard().reduce((s, r) => s + r.failed, 0),
  );

  // ── Architecture chart options ──

  // Stacked horizontal bar — one row per arch, segments by status. Limited
  // to the top 12 arches by count so the chart doesn't get crowded if the
  // fleet has many tiny architectures.
  readonly archStatusStackOptions = computed<EChartsOption>(() => {
    const rows = this.archLeaderboard().slice(0, 12).reverse();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 10, right: 30, bottom: 36, left: 130 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.architecture),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          name: 'Active',
          type: 'bar',
          stack: 'status',
          data: rows.map((r) => r.active),
          itemStyle: { color: '#34C759' },
          barWidth: 14,
        },
        {
          name: 'Training',
          type: 'bar',
          stack: 'status',
          data: rows.map((r) => r.training),
          itemStyle: { color: '#0071E3' },
        },
        {
          name: 'Superseded',
          type: 'bar',
          stack: 'status',
          data: rows.map((r) => r.superseded),
          itemStyle: { color: '#8E8E93' },
        },
        {
          name: 'Failed',
          type: 'bar',
          stack: 'status',
          data: rows.map((r) => r.failed),
          itemStyle: { color: '#FF3B30' },
        },
      ],
    };
  });

  readonly archActivationRateOptions = computed<EChartsOption>(() => {
    const rows = [...this.archLeaderboard()]
      .sort((a, b) => b.activationRate - a.activationRate)
      .slice(0, 12)
      .reverse();
    if (rows.length === 0) return {};
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}<br/>Activation rate: ${p.value.toFixed(1)}%`;
        },
      },
      grid: { top: 10, right: 60, bottom: 30, left: 130 },
      xAxis: {
        type: 'value',
        max: 100,
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.architecture),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: Number((r.activationRate * 100).toFixed(2)),
            itemStyle: {
              color:
                r.activationRate >= 0.05 ? '#34C759' : r.activationRate > 0 ? '#FF9500' : '#FF3B30',
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => `${p.value.toFixed(1)}%`,
          },
        },
      ],
    };
  });

  // Box plot — accuracy distribution per architecture. ECharts boxplot
  // expects [min, Q1, median, Q3, max] per series item. Architectures with
  // fewer than 5 accuracy points fall back to min/max only (still useful).
  readonly archAccuracyBoxOptions = computed<EChartsOption>(() => {
    const rows = this.archLeaderboard().filter((r) => r.accuracies.length > 0);
    if (rows.length === 0) {
      return {
        title: {
          text: 'No accuracy samples in fleet',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    const data = rows.map((r) => {
      const sorted = [...r.accuracies].sort((a, b) => a - b);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      const q1 = quantile(sorted, 0.25);
      const md = quantile(sorted, 0.5);
      const q3 = quantile(sorted, 0.75);
      return [lo * 100, q1 * 100, md * 100, q3 * 100, hi * 100];
    });
    return {
      tooltip: {
        trigger: 'item',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const v = params.value;
          // ECharts prepends an item-index at v[0]; the actual stats start at v[1].
          if (!Array.isArray(v)) return '';
          const [_idx, lo, q1, md, q3, hi] = v;
          return (
            `${params.name}<br/>` +
            `min: ${lo.toFixed(2)}%<br/>` +
            `Q1: ${q1.toFixed(2)}%<br/>` +
            `median: ${md.toFixed(2)}%<br/>` +
            `Q3: ${q3.toFixed(2)}%<br/>` +
            `max: ${hi.toFixed(2)}%`
          );
        },
      },
      grid: { top: 20, right: 20, bottom: 60, left: 50 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.architecture),
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 35 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Accuracy',
          type: 'boxplot',
          data: data.map((d, i) => ({
            value: d,
            itemStyle: { color: rows[i].color, borderColor: rows[i].color },
          })),
        },
      ],
    };
  });

  // RMSE × Accuracy scatter, one point per model, coloured by architecture.
  // Each architecture gets its own series so the legend works as a filter.
  readonly archScatterOptions = computed<EChartsOption>(() => {
    const groups = new Map<string, [number, number][]>();
    for (const m of this.archAnalyticsRows()) {
      if (m.directionAccuracy === null || m.magnitudeRMSE === null) continue;
      if (!Number.isFinite(m.directionAccuracy) || !Number.isFinite(m.magnitudeRMSE)) continue;
      const arch = m.learnerArchitecture || 'Unknown';
      const list = groups.get(arch) ?? [];
      list.push([m.directionAccuracy * 100, m.magnitudeRMSE]);
      groups.set(arch, list);
    }
    if (groups.size === 0) {
      return {
        title: {
          text: 'No models with both accuracy + RMSE',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    const colors = this.archColorMap();
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) => {
          const [acc, rmse] = p.value;
          return `${p.seriesName}<br/>accuracy: ${acc.toFixed(2)}%<br/>RMSE: ${rmse.toFixed(3)}`;
        },
      },
      legend: {
        bottom: 0,
        type: 'scroll',
        textStyle: { fontSize: 10, color: '#6E6E73' },
      },
      grid: { top: 20, right: 20, bottom: 56, left: 60 },
      xAxis: {
        type: 'value',
        name: 'Accuracy %',
        nameLocation: 'middle',
        nameGap: 28,
        nameTextStyle: { fontSize: 10, color: '#6E6E73' },
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'value',
        name: 'RMSE',
        nameLocation: 'middle',
        nameGap: 40,
        nameTextStyle: { fontSize: 10, color: '#6E6E73' },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: Array.from(groups.entries()).map(([arch, points]) => ({
        name: arch,
        type: 'scatter',
        data: points,
        symbolSize: 6,
        itemStyle: { color: colors[arch] ?? '#8E8E93', opacity: 0.7 },
      })),
    };
  });

  formatPct(v: number): string {
    if (!Number.isFinite(v) || v === 0) return '—';
    return `${(v * 100).toFixed(1)}%`;
  }

  // ══════════════════════════════════════════════════════════════
  //  CHART OPTIONS
  // ══════════════════════════════════════════════════════════════

  // ── Monitor Charts ──

  accuracyOverTimeOptions: EChartsOption = this.buildAccuracyOverTimeChart();
  accuracyByRegimeOptions: EChartsOption = this.buildAccuracyByRegimeChart();
  confidenceCalibrationOptions: EChartsOption = this.buildConfidenceCalibrationChart();
  predictionOutcomesOptions: EChartsOption = this.buildPredictionOutcomesChart();

  // ── Shadow Charts ──

  headToHeadOptions: EChartsOption = this.buildHeadToHeadChart();
  cumulativeRaceOptions: EChartsOption = this.buildSprtProgressChart();

  // ══════════════════════════════════════════════════════════════
  //  DATA FETCHERS
  // ══════════════════════════════════════════════════════════════

  fetchModels = (params: PagerRequest) => {
    return this.mlModelsService.list(params).pipe(map((res) => res.data as PagedData<MLModelDto>));
  };

  fetchTrainingRuns = (params: PagerRequest) => {
    return this.mlModelsService
      .listTrainingRuns(params)
      .pipe(map((res) => res.data as PagedData<MLTrainingRunDto>));
  };

  fetchShadowEvals = (params: PagerRequest) => {
    return this.mlEvaluationService
      .listShadow(params)
      .pipe(map((res) => res.data as PagedData<ShadowEvaluationDto>));
  };

  // ══════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ══════════════════════════════════════════════════════════════

  ngOnInit(): void {
    this.loadMonitorModels();
    this.loadModelAnalyticsSample();
    this.loadTrainingAnalyticsSample();
    this.loadShadowAnalyticsSample();
    this.loadAbAnalyticsSample();

    // Coverage preview: trail the form by 350ms so we don't fire a request on every
    // keystroke. The watcher only fires when symbol+timeframe are populated; date
    // bounds are optional (omitted = total-history coverage).
    this.trainingForm.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.scheduleCoverageFetch());
  }

  private scheduleCoverageFetch(): void {
    if (this.coverageFetchTimer !== null) clearTimeout(this.coverageFetchTimer);
    this.coverageFetchTimer = setTimeout(() => {
      this.coverageFetchTimer = null;
      this.fetchCoverage();
    }, 350);
  }

  openTrainingModal(): void {
    this.showTrainingModal.set(true);
    // Lazy-load symbol suggestions on first open and cache for the session — pairs
    // change rarely so we don't need a fresh fetch each time.
    if (!this.symbolOptionsLoaded) {
      this.currencyPairsService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
        next: (res) => {
          const symbols = (res?.data?.data ?? [])
            .map((p) => p.symbol)
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .sort((a, b) => a.localeCompare(b));
          this.symbolOptions.set(symbols);
          this.symbolOptionsLoaded = true;
        },
        error: () => {
          // Combobox still works for free typing; just no autocomplete suggestions.
          this.symbolOptionsLoaded = false;
        },
      });
    }
    // Fire coverage probe immediately for whatever's already populated in the form
    // (default symbol/timeframe combo) so the operator sees data on first open.
    this.scheduleCoverageFetch();
  }

  private fetchCoverage(): void {
    const v = this.trainingForm.getRawValue();
    const symbol = (v.symbol ?? '').trim();
    const timeframe = v.timeframe;
    if (!symbol || !timeframe) {
      this.coveragePreview.set(null);
      this.coverageError.set(null);
      return;
    }
    this.coverageLoading.set(true);
    this.coverageError.set(null);
    this.marketDataService
      .getCandleCoverage(symbol, timeframe, v.fromDate || undefined, v.toDate || undefined)
      .subscribe({
        next: (res) => {
          this.coverageLoading.set(false);
          this.coveragePreview.set(res?.data ?? null);
          if (!res?.status) this.coverageError.set(res?.message ?? 'Coverage probe failed');
        },
        error: () => {
          this.coverageLoading.set(false);
          this.coveragePreview.set(null);
          this.coverageError.set('Coverage probe failed');
        },
      });
  }

  // ══════════════════════════════════════════════════════════════
  //  ACTIONS
  // ══════════════════════════════════════════════════════════════

  onModelSelect(model: MLModelDto): void {
    if (model?.id != null) this.router.navigate(['/ml-models', model.id]);
  }

  loadMonitorModels(): void {
    this.mlModelsService.list({ currentPage: 1, itemCountPerPage: 100 }).subscribe({
      next: (res) => {
        if (res.data) {
          this.monitorModels.set(res.data.data);
        }
      },
    });
  }

  onMonitorModelChange(id: number | null): void {
    this.selectedModelId.set(id);
    if (id == null) {
      this.monitorModel.set(null);
      return;
    }
    this.mlModelsService.getById(id).subscribe({
      next: (res) => {
        if (res.data) {
          this.monitorModel.set(res.data);
          this.accuracyOverTimeOptions = this.buildAccuracyOverTimeChart();
          this.accuracyByRegimeOptions = this.buildAccuracyByRegimeChart();
          this.confidenceCalibrationOptions = this.buildConfidenceCalibrationChart();
          this.predictionOutcomesOptions = this.buildPredictionOutcomesChart();
        }
      },
      error: () => this.notifications.error('Failed to load model details'),
    });
  }

  onTrainingRunSelect(run: MLTrainingRunDto): void {
    this.selectedTrainingRun.set(run);
    this.loadDiagnostics(run.id);
    this.maybeStartPolling(run.status);
    // Defer scroll until template renders the detail panel
    queueMicrotask(() =>
      this.runDetailRef()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  onTrainingRunDeselect(): void {
    this.stopPolling();
    this.selectedTrainingRun.set(null);
    this.diagnostics.set(null);
  }

  refreshSelectedRun(): void {
    const run = this.selectedTrainingRun();
    if (!run) return;
    this.refetchRunAndDiagnostics(run.id);
  }

  private loadDiagnostics(id: number): void {
    this.diagnostics.set(null);
    this.loadingDiagnostics.set(true);
    this.mlModelsService.getTrainingRunDiagnostics(id).subscribe({
      next: (res) => {
        this.diagnostics.set(res?.data ?? null);
        this.loadingDiagnostics.set(false);
      },
      error: () => {
        this.diagnostics.set(null);
        this.loadingDiagnostics.set(false);
      },
    });
  }

  // Polled refresh: re-pulls both the run row (for status / completedAt / errorMessage
  // transitions) and diagnostics (for evolving metrics). Stops polling when the run
  // reaches a terminal state so we don't keep hammering completed-run endpoints.
  private refetchRunAndDiagnostics(id: number): void {
    this.mlModelsService.getTrainingRun(id).subscribe({
      next: (res) => {
        const updated = res?.data;
        if (updated && this.selectedTrainingRun()?.id === updated.id) {
          this.selectedTrainingRun.set(updated);
          if (this.isTerminalStatus(updated.status)) {
            this.stopPolling();
          }
        }
      },
    });
    this.mlModelsService.getTrainingRunDiagnostics(id).subscribe({
      next: (res) => this.diagnostics.set(res?.data ?? null),
    });
  }

  private maybeStartPolling(status: RunStatus): void {
    this.stopPolling();
    if (this.isTerminalStatus(status)) return;
    this.isPolling.set(true);
    this.pollingTimer = setInterval(() => {
      const run = this.selectedTrainingRun();
      if (!run) {
        this.stopPolling();
        return;
      }
      this.refetchRunAndDiagnostics(run.id);
    }, MlModelsPageComponent.POLL_INTERVAL_MS);
    // 1Hz wall-clock tick drives the elapsed-time readout independently of the
    // 5s server poll so the duration counter stays smooth.
    this.nowTick.set(Date.now());
    this.nowTickTimer = setInterval(() => this.nowTick.set(Date.now()), 1_000);
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  private stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.nowTickTimer !== null) {
      clearInterval(this.nowTickTimer);
      this.nowTickTimer = null;
    }
    this.isPolling.set(false);
  }

  private isTerminalStatus(status: RunStatus): boolean {
    return status === 'Completed' || status === 'Failed';
  }

  formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  formatJson(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  trainingFlagBadges(d: MLTrainingRunDiagnosticsDto): string[] {
    const flags: Array<[boolean, string]> = [
      [d.smoteApplied, 'SMOTE'],
      [d.adversarialAugmentApplied, 'Adversarial'],
      [d.mixupApplied, 'Mixup'],
      [d.curriculumApplied, 'Curriculum'],
      [d.nceLossUsed, 'NCE loss'],
      [d.rareEventWeightingApplied, 'Rare-event weighting'],
      [d.isPretrainingRun, 'Pre-training'],
      [d.isDistillationRun, 'Distillation'],
      [d.isEmergencyRetrain, 'Emergency'],
      [d.isMamlRun, 'MAML'],
    ];
    return flags.filter(([on]) => on).map(([, label]) => label);
  }

  submitTraining(): void {
    if (this.trainingForm.invalid) {
      this.trainingForm.markAllAsTouched();
      return;
    }
    const v = this.trainingForm.getRawValue();
    this.submittingTraining.set(true);
    const req: TriggerMLTrainingRequest = {
      symbol: v.symbol,
      timeframe: v.timeframe,
      fromDate: v.fromDate,
      toDate: v.toDate,
      learnerArchitecture: v.learnerArchitecture,
    };
    this.mlModelsService.triggerTraining(req).subscribe({
      next: () => {
        this.notifications.success('Training run triggered successfully');
        this.showTrainingModal.set(false);
        this.submittingTraining.set(false);
        this.trainingTable()?.loadData();
      },
      error: () => {
        this.notifications.error('Failed to trigger training');
        this.submittingTraining.set(false);
      },
    });
  }

  onShadowSelect(shadow: ShadowEvaluationDto): void {
    this.selectedShadow.set(shadow);
    this.headToHeadOptions = this.buildHeadToHeadChart(shadow);
    this.cumulativeRaceOptions = this.buildSprtProgressChart(shadow);
  }

  submitShadow(): void {
    if (this.shadowForm.invalid) {
      this.shadowForm.markAllAsTouched();
      return;
    }
    const v = this.shadowForm.getRawValue();
    this.submittingShadow.set(true);
    const req: StartShadowEvaluationRequest = {
      championModelId: v.championModelId,
      challengerModelId: v.challengerModelId,
      symbol: v.symbol,
      timeframe: v.timeframe,
      requiredTrades: v.requiredTrades,
    };
    this.mlEvaluationService.startShadow(req).subscribe({
      next: () => {
        this.notifications.success('Shadow evaluation started');
        this.showShadowModal.set(false);
        this.submittingShadow.set(false);
        this.shadowTable()?.loadData();
      },
      error: () => {
        this.notifications.error('Failed to start shadow evaluation');
        this.submittingShadow.set(false);
      },
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  CHART BUILDERS
  // ══════════════════════════════════════════════════════════════

  private buildAccuracyOverTimeChart(): EChartsOption {
    const days = 30;
    const labels = this.generateDates(days);
    const data: number[] = [];
    let val = 68;
    for (let i = 0; i < days; i++) {
      val += (Math.random() - 0.48) * 5;
      val = Math.max(55, Math.min(82, val));
      data.push(parseFloat(val.toFixed(1)));
    }
    return {
      grid: { top: 20, right: 20, bottom: 30, left: 50 },
      tooltip: { trigger: 'axis', formatter: '{b}<br/>Accuracy: {c}%' },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        min: 40,
        max: 90,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Accuracy',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data,
          lineStyle: { color: '#0071E3', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0,113,227,0.15)' },
                { offset: 1, color: 'rgba(0,113,227,0)' },
              ],
            } as any,
          },
        },
        {
          name: 'Threshold',
          type: 'line',
          symbol: 'none',
          data: Array(days).fill(50),
          lineStyle: { color: '#FF3B30', width: 1, type: 'dashed' },
          itemStyle: { color: '#FF3B30' },
        },
      ],
    };
  }

  private buildAccuracyByRegimeChart(): EChartsOption {
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: ['Trending', 'Ranging', 'High Volatility'],
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Accuracy',
          type: 'bar',
          data: [
            { value: 74, itemStyle: { color: '#0071E3' } },
            { value: 62, itemStyle: { color: '#34C759' } },
            { value: 58, itemStyle: { color: '#FF9500' } },
          ],
          barWidth: 40,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          label: {
            show: true,
            position: 'top',
            formatter: '{c}%',
            fontSize: 12,
            color: '#6E6E73',
          },
        },
      ],
    };
  }

  private buildConfidenceCalibrationChart(): EChartsOption {
    const bins = [
      '0-10',
      '10-20',
      '20-30',
      '30-40',
      '40-50',
      '50-60',
      '60-70',
      '70-80',
      '80-90',
      '90-100',
    ];
    const predictedMidpoints = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95];
    const actualAccuracy = [8, 18, 22, 38, 42, 52, 60, 71, 80, 88];
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params : [params];
          let tip = `${p[0].name}%<br/>`;
          p.forEach((item: any) => {
            tip += `${item.seriesName}: ${item.value}%<br/>`;
          });
          return tip;
        },
      },
      xAxis: {
        type: 'category',
        data: bins,
        name: 'Predicted Confidence',
        nameLocation: 'center',
        nameGap: 28,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        name: 'Actual Accuracy',
        nameLocation: 'center',
        nameGap: 36,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Model',
          type: 'line',
          smooth: true,
          data: actualAccuracy,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
          symbolSize: 6,
        },
        {
          name: 'Perfect',
          type: 'line',
          symbol: 'none',
          data: predictedMidpoints,
          lineStyle: { color: '#8E8E93', width: 1, type: 'dashed' },
          itemStyle: { color: '#8E8E93' },
        },
      ],
    };
  }

  private buildPredictionOutcomesChart(): EChartsOption {
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i < 60; i++) {
      const correct = Math.random() > 0.35 ? 1 : 0;
      points.push([i, correct ? 1 : 0, correct]);
    }
    return {
      grid: { top: 20, right: 20, bottom: 30, left: 50 },
      tooltip: {
        trigger: 'item',
        formatter: (params: any) =>
          `Prediction #${params.data[0] + 1}: ${params.data[2] === 1 ? 'Correct' : 'Incorrect'}`,
      },
      xAxis: {
        type: 'value',
        name: 'Prediction #',
        nameLocation: 'center',
        nameGap: 24,
        min: 0,
        max: 60,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: -0.5,
        max: 1.5,
        axisLabel: {
          fontSize: 11,
          color: '#6E6E73',
          formatter: (val: number) => (val === 1 ? 'Correct' : val === 0 ? 'Incorrect' : ''),
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        interval: 1,
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 10,
          data: points,
          itemStyle: {
            color: (params: any) => (params.data[2] === 1 ? '#34C759' : '#FF3B30'),
          },
        },
      ],
    };
  }

  private buildHeadToHeadChart(shadow?: ShadowEvaluationDto): EChartsOption {
    if (!shadow) return emptyChart('Select a shadow evaluation');
    const champAcc = (shadow.championDirectionAccuracy ?? 0) * 100;
    const challAcc = (shadow.challengerDirectionAccuracy ?? 0) * 100;
    const champCorr = (shadow.championMagnitudeCorrelation ?? 0) * 100;
    const challCorr = (shadow.challengerMagnitudeCorrelation ?? 0) * 100;
    // Brier is a loss: lower is better. Convert to a score so higher is better on the chart.
    const champBrier = Math.max(0, 1 - (shadow.championBrierScore ?? 0)) * 100;
    const challBrier = Math.max(0, 1 - (shadow.challengerBrierScore ?? 0)) * 100;
    return {
      grid: { top: 30, right: 40, bottom: 40, left: 40 },
      legend: {
        data: ['Champion', 'Challenger'],
        top: 0,
        textStyle: { fontSize: 11, color: '#6E6E73' },
      },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: ['Direction Acc', 'Magnitude Corr', 'Brier Score (1−loss)'],
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
      },
      series: [
        {
          name: 'Champion',
          type: 'bar',
          data: [+champAcc.toFixed(2), +champCorr.toFixed(2), +champBrier.toFixed(2)],
          itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          barGap: '20%',
          label: { show: true, position: 'top', formatter: '{c}%', fontSize: 10, color: '#6E6E73' },
        },
        {
          name: 'Challenger',
          type: 'bar',
          data: [+challAcc.toFixed(2), +challCorr.toFixed(2), +challBrier.toFixed(2)],
          itemStyle: { color: '#34C759', borderRadius: [4, 4, 0, 0] },
          label: { show: true, position: 'top', formatter: '{c}%', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  }

  private buildSprtProgressChart(shadow?: ShadowEvaluationDto): EChartsOption {
    if (!shadow) return emptyChart('Select a shadow evaluation');
    const completed = shadow.completedTrades ?? 0;
    const required = shadow.requiredTrades ?? 0;
    const remaining = Math.max(0, required - completed);
    return {
      title: {
        text: `${completed} / ${required} trades`,
        subtext: `Decision: ${shadow.promotionDecision}`,
        left: 'center',
        top: 10,
        textStyle: { fontSize: 14, color: '#1D1D1F' },
        subtextStyle: { fontSize: 11, color: '#6E6E73' },
      },
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'pie',
          radius: ['60%', '80%'],
          center: ['50%', '60%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
          label: { show: false },
          data: [
            { value: completed, name: 'Completed', itemStyle: { color: '#34C759' } },
            { value: remaining, name: 'Remaining', itemStyle: { color: '#E5E5EA' } },
          ],
        },
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════════

  private generateDates(days: number): string[] {
    const dates: string[] = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    return dates;
  }

  // ══════════════════════════════════════════════════════════════
  //  SIGNAL A/B TESTS
  // ══════════════════════════════════════════════════════════════

  readonly abTests = signal<MLSignalAbTestResultDto[]>([]);
  readonly abLoading = signal(false);
  readonly selectedAb = signal<MLSignalAbTestResultDto | null>(null);

  readonly abColumns: ColDef<MLSignalAbTestResultDto>[] = [
    { headerName: 'ID', field: 'id', width: 90 },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    { headerName: 'TF', field: 'timeframe', width: 80 },
    { headerName: 'Champion', field: 'championModelId', width: 120 },
    { headerName: 'Challenger', field: 'challengerModelId', width: 120 },
    { headerName: 'Samples', field: 'sampleSize', width: 110 },
    {
      headerName: 'Champion P&L',
      field: 'championPnl',
      width: 140,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? p.value.toFixed(2) : '-'),
    },
    {
      headerName: 'Challenger P&L',
      field: 'challengerPnl',
      width: 140,
      valueFormatter: (p: { value: number | null }) => (p.value != null ? p.value.toFixed(2) : '-'),
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 140,
      cellRenderer: (params: { value: string }) => {
        const palette: Record<string, { bg: string; color: string }> = {
          Running: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Completed: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          ChampionWon: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          ChallengerWon: { bg: 'rgba(175,82,222,0.12)', color: '#8944AB' },
          Inconclusive: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
        };
        const s = palette[params.value] ?? palette['Running'];
        return `<span style="color:${s.color};background:${s.bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
  ];

  readonly fetchAbTests = (params: PagerRequest) =>
    this.mlModelsService
      .listSignalAbTests(params)
      .pipe(map((res) => res.data as PagedData<MLSignalAbTestResultDto>));

  onAbSelect(row: MLSignalAbTestResultDto): void {
    this.selectedAb.set(row);
  }
}

// Cross-field validator — hard-blocks submission for swapped/future dates so the
// trainer never sees the silent "0 candles" failure mode again. Window-size sanity
// is reported separately as a soft warning (computed in the component) so an operator
// can deliberately backfill a long window if they really mean to.
const trainingDateRangeValidator: ValidatorFn = (
  group: AbstractControl,
): ValidationErrors | null => {
  const fromRaw = group.get('fromDate')?.value as string | undefined;
  const toRaw = group.get('toDate')?.value as string | undefined;
  if (!fromRaw || !toRaw) return null;

  const from = new Date(fromRaw).getTime();
  const to = new Date(toRaw).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  const errors: Record<string, boolean> = {};
  // Date inputs are date-only — "future" means strictly after today (UTC).
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );

  if (from > todayUtc) errors['fromDateInFuture'] = true;
  if (to > todayUtc) errors['toDateInFuture'] = true;
  if (from >= to) errors['dateOrder'] = true;

  return Object.keys(errors).length > 0 ? errors : null;
};

function emptyChart(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'center',
      textStyle: { color: '#8E8E93', fontSize: 14, fontWeight: 'normal' as const },
    },
  };
}

// ── Per-architecture analytics helpers ──

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Linear-interpolation quantile (matches numpy default). Caller passes a
 * pre-sorted array; tail of the box-plot pipeline uses this for Q1/median/Q3.
 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
