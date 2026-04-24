import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  viewChild,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { MLModelsService } from '@core/services/ml-models.service';
import { MLEvaluationService } from '@core/services/ml-evaluation.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  MLModelDto,
  MLTrainingRunDto,
  MLTrainingRunDiagnosticsDto,
  ShadowEvaluationDto,
  MLSignalAbTestResultDto,
  PagedData,
  PagerRequest,
  TriggerMLTrainingRequest,
  StartShadowEvaluationRequest,
  Timeframe,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
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
            <div class="filter-bar">
              <select
                class="filter-select"
                [ngModel]="filterStatus()"
                (ngModelChange)="filterStatus.set($event); reloadRegistry()"
              >
                <option value="">All Statuses</option>
                <option value="Training">Training</option>
                <option value="Active">Active</option>
                <option value="Superseded">Superseded</option>
                <option value="Failed">Failed</option>
              </select>
              <input
                type="text"
                class="filter-input"
                placeholder="Filter by symbol..."
                [ngModel]="filterSymbol()"
                (ngModelChange)="filterSymbol.set($event); reloadRegistry()"
              />
            </div>

            <app-data-table
              #registryTable
              [columnDefs]="registryColumns"
              [fetchData]="fetchModels"
              (rowClick)="onModelSelect($event)"
            />
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

            @if (monitorModel()) {
              <div class="metrics-row">
                <app-metric-card
                  label="Accuracy"
                  [value]="(monitorModel()!.directionAccuracy ?? 0) * 100"
                  format="percent"
                  dotColor="#0071E3"
                />
                <app-metric-card
                  label="Precision"
                  [value]="(monitorModel()!.directionAccuracy ?? 0) * 0.95 * 100"
                  format="percent"
                  dotColor="#5AC8FA"
                />
                <app-metric-card
                  label="Magnitude RMSE"
                  [value]="monitorModel()!.magnitudeRMSE ?? 0"
                  format="number"
                  dotColor="#34C759"
                />
                <app-metric-card
                  label="Training Samples"
                  [value]="monitorModel()!.trainingSamples"
                  format="number"
                  dotColor="#AF52DE"
                />
              </div>

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
              <button class="btn btn-primary" (click)="showTrainingModal.set(true)">
                + Trigger Training
              </button>
            </div>

            <app-data-table
              #trainingTable
              [columnDefs]="trainingColumns"
              [fetchData]="fetchTrainingRuns"
              (rowClick)="onTrainingRunSelect($event)"
            />

            @if (selectedTrainingRun(); as run) {
              <div class="run-detail mt-6">
                <header class="run-head">
                  <h3>Run #{{ run.id }} — {{ run.symbol }} / {{ run.timeframe }}</h3>
                  <span class="pill" [attr.data-status]="run.status">{{ run.status }}</span>
                </header>
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
              <div class="modal-overlay" (click)="showTrainingModal.set(false)">
                <form
                  class="modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Trigger training run"
                  [formGroup]="trainingForm"
                  (ngSubmit)="submitTraining()"
                  (click)="$event.stopPropagation()"
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
                      <input appFormFieldControl formControlName="fromDate" type="date" />
                    </app-form-field>
                    <app-form-field
                      label="To Date"
                      [required]="true"
                      [control]="trainingForm.controls.toDate"
                    >
                      <input appFormFieldControl formControlName="toDate" type="date" />
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

        <!-- ========== SHADOW ARENA TAB ========== -->
        @if (activeTab() === 'shadow') {
          <div class="tab-content">
            <div class="section-header">
              <h3 class="section-title">Shadow Evaluations</h3>
              <button class="btn btn-primary" (click)="showShadowModal.set(true)">
                + Start Evaluation
              </button>
            </div>

            <app-data-table
              #shadowTable
              [columnDefs]="shadowColumns"
              [fetchData]="fetchShadowEvals"
              (rowClick)="onShadowSelect($event)"
            />

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
              <div class="modal-overlay" (click)="showShadowModal.set(false)">
                <form
                  class="modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Start shadow evaluation"
                  [formGroup]="shadowForm"
                  (ngSubmit)="submitShadow()"
                  (click)="$event.stopPropagation()"
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
            <app-data-table
              [columnDefs]="abColumns"
              [fetchData]="fetchAbTests"
              (rowClick)="onAbSelect($event)"
            />

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
        margin-bottom: var(--space-4);
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
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly relativeTimePipe = new RelativeTimePipe();

  private readonly registryTable = viewChild<DataTableComponent<MLModelDto>>('registryTable');
  private readonly trainingTable = viewChild<DataTableComponent<MLTrainingRunDto>>('trainingTable');
  private readonly shadowTable = viewChild<DataTableComponent<ShadowEvaluationDto>>('shadowTable');

  reloadRegistry() {
    this.registryTable()?.loadData();
  }
  reloadTraining() {
    this.trainingTable()?.loadData();
  }
  reloadShadow() {
    this.shadowTable()?.loadData();
  }

  // ── Tab state ──
  tabs: TabItem[] = [
    { label: 'Model Registry', value: 'registry' },
    { label: 'Model Monitor', value: 'monitor' },
    { label: 'Training Lab', value: 'training' },
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

  private readonly fb = inject(FormBuilder);

  // ── Training state ──
  showTrainingModal = signal(false);
  submittingTraining = signal(false);
  selectedTrainingRun = signal<MLTrainingRunDto | null>(null);
  diagnostics = signal<MLTrainingRunDiagnosticsDto | null>(null);
  loadingDiagnostics = signal(false);
  trainingForm = this.fb.nonNullable.group({
    symbol: ['', Validators.required],
    timeframe: ['H1' as Timeframe, Validators.required],
    fromDate: ['', Validators.required],
    toDate: ['', Validators.required],
  });

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
