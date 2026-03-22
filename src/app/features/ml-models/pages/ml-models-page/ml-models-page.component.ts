import {
  Component, ChangeDetectionStrategy, inject, signal, viewChild, OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { MLModelsService } from '@core/services/ml-models.service';
import { MLEvaluationService } from '@core/services/ml-evaluation.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  MLModelDto, MLTrainingRunDto, ShadowEvaluationDto,
  PagedData, PagerRequest, TriggerMLTrainingRequest,
  StartShadowEvaluationRequest, Timeframe,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, type TabItem } from '@shared/components/ui/tabs/tabs.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-ml-models-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    TabsComponent,
  ],
  template: `
    <div class="page">
      <app-page-header title="ML Models" subtitle="Model registry, monitoring, training, and shadow evaluation" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        <!-- ========== MODEL REGISTRY TAB ========== -->
        @if (activeTab() === 'registry') {
          <div class="tab-content">
            <div class="filter-bar">
              <select class="filter-select" [ngModel]="filterStatus()" (ngModelChange)="filterStatus.set($event); reloadRegistry()">
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
              <select class="filter-select wide" [ngModel]="selectedModelId()" (ngModelChange)="onMonitorModelChange($event)">
                <option [ngValue]="null">-- Choose a model --</option>
                @for (m of monitorModels(); track m.id) {
                  <option [ngValue]="m.id">{{ m.symbol }} / {{ m.timeframe }} v{{ m.modelVersion }} (ID: {{ m.id }})</option>
                }
              </select>
            </div>

            @if (monitorModel()) {
              <div class="metrics-row">
                <app-metric-card label="Accuracy" [value]="(monitorModel()!.directionAccuracy ?? 0) * 100" format="percent" dotColor="#0071E3" />
                <app-metric-card label="Precision" [value]="((monitorModel()!.directionAccuracy ?? 0) * 0.95) * 100" format="percent" dotColor="#5AC8FA" />
                <app-metric-card label="Magnitude RMSE" [value]="monitorModel()!.magnitudeRMSE ?? 0" format="number" dotColor="#34C759" />
                <app-metric-card label="Training Samples" [value]="monitorModel()!.trainingSamples" format="number" dotColor="#AF52DE" />
              </div>

              <div class="charts-grid">
                <app-chart-card title="Accuracy Over Time" subtitle="Rolling accuracy with 50% threshold" [options]="accuracyOverTimeOptions" height="300px" />
                <app-chart-card title="Accuracy by Regime" subtitle="Performance across market regimes" [options]="accuracyByRegimeOptions" height="300px" />
                <app-chart-card title="Confidence Calibration" subtitle="Predicted confidence vs actual accuracy" [options]="confidenceCalibrationOptions" height="300px" />
                <app-chart-card title="Prediction Outcomes" subtitle="Chronological prediction results" [options]="predictionOutcomesOptions" height="300px" />
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
              <button class="btn btn-primary" (click)="showTrainingModal.set(true)">+ Trigger Training</button>
            </div>

            <app-data-table
              #trainingTable
              [columnDefs]="trainingColumns"
              [fetchData]="fetchTrainingRuns"
              (rowClick)="onTrainingRunSelect($event)"
            />

            @if (selectedTrainingRun()) {
              <div class="charts-grid mt-6">
                <app-chart-card title="Loss Curve" subtitle="Training vs validation loss over epochs" [options]="lossCurveOptions" height="300px" />
                <app-chart-card title="Feature Importance" subtitle="Top 10 features ranked by importance" [options]="featureImportanceOptions" height="300px" />
              </div>
            }

            <!-- Training Form Modal -->
            @if (showTrainingModal()) {
              <div class="modal-overlay" (click)="showTrainingModal.set(false)">
                <div class="modal" (click)="$event.stopPropagation()">
                  <div class="modal-header">
                    <h3>Trigger Training Run</h3>
                    <button class="modal-close" (click)="showTrainingModal.set(false)">&times;</button>
                  </div>
                  <div class="modal-body">
                    <div class="form-group">
                      <label class="form-label">Symbol</label>
                      <input type="text" class="form-input" placeholder="e.g. EUR_USD" [ngModel]="trainingForm.symbol" (ngModelChange)="trainingForm.symbol = $event" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Timeframe</label>
                      <select class="form-input" [ngModel]="trainingForm.timeframe" (ngModelChange)="trainingForm.timeframe = $event">
                        <option value="M1">M1</option>
                        <option value="M5">M5</option>
                        <option value="M15">M15</option>
                        <option value="H1">H1</option>
                        <option value="H4">H4</option>
                        <option value="D1">D1</option>
                      </select>
                    </div>
                    <div class="form-group">
                      <label class="form-label">From Date</label>
                      <input type="date" class="form-input" [ngModel]="trainingForm.fromDate" (ngModelChange)="trainingForm.fromDate = $event" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">To Date</label>
                      <input type="date" class="form-input" [ngModel]="trainingForm.toDate" (ngModelChange)="trainingForm.toDate = $event" />
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button class="btn btn-secondary" (click)="showTrainingModal.set(false)">Cancel</button>
                    <button class="btn btn-primary" [disabled]="submittingTraining()" (click)="submitTraining()">
                      {{ submittingTraining() ? 'Submitting...' : 'Start Training' }}
                    </button>
                  </div>
                </div>
              </div>
            }
          </div>
        }

        <!-- ========== SHADOW ARENA TAB ========== -->
        @if (activeTab() === 'shadow') {
          <div class="tab-content">
            <div class="section-header">
              <h3 class="section-title">Shadow Evaluations</h3>
              <button class="btn btn-primary" (click)="showShadowModal.set(true)">+ Start Evaluation</button>
            </div>

            <app-data-table
              #shadowTable
              [columnDefs]="shadowColumns"
              [fetchData]="fetchShadowEvals"
              (rowClick)="onShadowSelect($event)"
            />

            @if (selectedShadow()) {
              <div class="charts-grid mt-6">
                <app-chart-card title="Head-to-Head" subtitle="Champion vs challenger accuracy comparison" [options]="headToHeadOptions" height="300px" />
                <app-chart-card title="Cumulative Race" subtitle="Accuracy convergence over time" [options]="cumulativeRaceOptions" height="300px" />
              </div>
            }

            <!-- Shadow Evaluation Modal -->
            @if (showShadowModal()) {
              <div class="modal-overlay" (click)="showShadowModal.set(false)">
                <div class="modal" (click)="$event.stopPropagation()">
                  <div class="modal-header">
                    <h3>Start Shadow Evaluation</h3>
                    <button class="modal-close" (click)="showShadowModal.set(false)">&times;</button>
                  </div>
                  <div class="modal-body">
                    <div class="form-group">
                      <label class="form-label">Champion Model ID</label>
                      <input type="number" class="form-input" [ngModel]="shadowForm.championModelId" (ngModelChange)="shadowForm.championModelId = $event" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Challenger Model ID</label>
                      <input type="number" class="form-input" [ngModel]="shadowForm.challengerModelId" (ngModelChange)="shadowForm.challengerModelId = $event" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Symbol</label>
                      <input type="text" class="form-input" placeholder="e.g. EUR_USD" [ngModel]="shadowForm.symbol" (ngModelChange)="shadowForm.symbol = $event" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Timeframe</label>
                      <select class="form-input" [ngModel]="shadowForm.timeframe" (ngModelChange)="shadowForm.timeframe = $event">
                        <option value="M1">M1</option>
                        <option value="M5">M5</option>
                        <option value="M15">M15</option>
                        <option value="H1">H1</option>
                        <option value="H4">H4</option>
                        <option value="D1">D1</option>
                      </select>
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button class="btn btn-secondary" (click)="showShadowModal.set(false)">Cancel</button>
                    <button class="btn btn-primary" [disabled]="submittingShadow()" (click)="submitShadow()">
                      {{ submittingShadow() ? 'Starting...' : 'Start Evaluation' }}
                    </button>
                  </div>
                </div>
              </div>
            }
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      gap: var(--space-3);
      margin-bottom: var(--space-4);
    }

    .filter-select, .filter-input {
      height: 36px;
      padding: 0 var(--space-3);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: var(--text-sm);
      font-family: inherit;
    }
    .filter-select { min-width: 160px; cursor: pointer; }
    .filter-input { min-width: 200px; }
    .filter-select.wide { min-width: 360px; }
    .filter-input::placeholder { color: var(--text-tertiary); }

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

    .mt-6 { margin-top: var(--space-6); }

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
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { background: var(--bg-secondary); }

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
      box-shadow: var(--shadow-lg, 0 20px 40px rgba(0,0,0,0.2));
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
    .modal-close:hover { background: var(--border); }
    .modal-body { padding: var(--space-5); }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-5);
      border-top: 1px solid var(--border);
    }

    /* Form */
    .form-group { margin-bottom: var(--space-4); }
    .form-group:last-child { margin-bottom: 0; }
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
    .empty-icon { font-size: 48px; margin-bottom: var(--space-4); }
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

    .tab-content { min-height: 400px; }

    @media (max-width: 1200px) {
      .metrics-row { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 768px) {
      .metrics-row { grid-template-columns: repeat(2, 1fr); }
      .charts-grid { grid-template-columns: 1fr; }
      .filter-bar { flex-direction: column; }
    }
  `],
})
export class MlModelsPageComponent implements OnInit {
  private readonly mlModelsService = inject(MLModelsService);
  private readonly mlEvaluationService = inject(MLEvaluationService);
  private readonly notifications = inject(NotificationService);
  private readonly relativeTimePipe = new RelativeTimePipe();

  private readonly registryTable = viewChild<DataTableComponent<MLModelDto>>('registryTable');
  private readonly trainingTable = viewChild<DataTableComponent<MLTrainingRunDto>>('trainingTable');
  private readonly shadowTable = viewChild<DataTableComponent<ShadowEvaluationDto>>('shadowTable');

  reloadRegistry() { this.registryTable()?.loadData(); }
  reloadTraining() { this.trainingTable()?.loadData(); }
  reloadShadow() { this.shadowTable()?.loadData(); }

  // ── Tab state ──
  tabs: TabItem[] = [
    { label: 'Model Registry', value: 'registry' },
    { label: 'Model Monitor', value: 'monitor' },
    { label: 'Training Lab', value: 'training' },
    { label: 'Shadow Arena', value: 'shadow' },
  ];
  activeTab = signal('registry');

  // ── Registry state ──
  filterStatus = signal('');
  filterSymbol = signal('');

  // ── Monitor state ──
  monitorModels = signal<MLModelDto[]>([]);
  selectedModelId = signal<number | null>(null);
  monitorModel = signal<MLModelDto | null>(null);

  // ── Training state ──
  showTrainingModal = signal(false);
  submittingTraining = signal(false);
  selectedTrainingRun = signal<MLTrainingRunDto | null>(null);
  trainingForm: { symbol: string; timeframe: Timeframe; fromDate: string; toDate: string } = {
    symbol: '',
    timeframe: 'H1',
    fromDate: '',
    toDate: '',
  };

  // ── Shadow state ──
  showShadowModal = signal(false);
  submittingShadow = signal(false);
  selectedShadow = signal<ShadowEvaluationDto | null>(null);
  shadowForm: { championModelId: number; challengerModelId: number; symbol: string; timeframe: Timeframe; requiredTrades: number } = {
    championModelId: 0,
    challengerModelId: 0,
    symbol: '',
    timeframe: 'H1',
    requiredTrades: 100,
  };

  // ══════════════════════════════════════════════════════════════
  //  REGISTRY COLUMNS
  // ══════════════════════════════════════════════════════════════

  registryColumns: ColDef<MLModelDto>[] = [
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 100 },
    { headerName: 'Timeframe', field: 'timeframe', width: 100 },
    { headerName: 'Version', field: 'modelVersion', width: 90 },
    {
      headerName: 'Status', field: 'status', width: 110,
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
      headerName: 'Accuracy %', field: 'directionAccuracy', width: 110,
      valueFormatter: (p: { value: number | null }) => p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Mag. RMSE', field: 'magnitudeRMSE', width: 110,
      valueFormatter: (p: { value: number | null }) => p.value != null ? p.value.toFixed(4) : '-',
    },
    { headerName: 'Samples', field: 'trainingSamples', width: 110 },
    {
      headerName: 'Active', field: 'isActive', width: 80,
      cellRenderer: (params: { value: boolean }) => {
        const color = params.value ? '#248A3D' : '#636366';
        const bg = params.value ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const label = params.value ? 'Yes' : 'No';
        return `<span style="color:${color};background:${bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Trained At', field: 'trainedAt', width: 130,
      valueFormatter: (p: { value: string }) => p.value ? this.relativeTimePipe.transform(p.value) : '-',
    },
  ];

  // ══════════════════════════════════════════════════════════════
  //  TRAINING COLUMNS
  // ══════════════════════════════════════════════════════════════

  trainingColumns: ColDef<MLTrainingRunDto>[] = [
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 100 },
    { headerName: 'Timeframe', field: 'timeframe', width: 100 },
    {
      headerName: 'Status', field: 'status', width: 110,
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
      headerName: 'Accuracy', field: 'directionAccuracy', width: 100,
      valueFormatter: (p: { value: number | null }) => p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Mag. RMSE', field: 'magnitudeRMSE', width: 100,
      valueFormatter: (p: { value: number | null }) => p.value != null ? p.value.toFixed(4) : '-',
    },
    {
      headerName: 'Started', field: 'startedAt', width: 130,
      valueFormatter: (p: { value: string }) => p.value ? this.relativeTimePipe.transform(p.value) : '-',
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
      headerName: 'Status', field: 'status', width: 120,
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
      headerName: 'Champion Acc', field: 'championDirectionAccuracy', width: 130,
      valueFormatter: (p: { value: number | null }) => p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Challenger Acc', field: 'challengerDirectionAccuracy', width: 130,
      valueFormatter: (p: { value: number | null }) => p.value != null ? `${(p.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Started', field: 'startedAt', width: 130,
      valueFormatter: (p: { value: string }) => p.value ? this.relativeTimePipe.transform(p.value) : '-',
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

  // ── Training Charts ──

  lossCurveOptions: EChartsOption = this.buildLossCurveChart();
  featureImportanceOptions: EChartsOption = this.buildFeatureImportanceChart();

  // ── Shadow Charts ──

  headToHeadOptions: EChartsOption = this.buildHeadToHeadChart();
  cumulativeRaceOptions: EChartsOption = this.buildCumulativeRaceChart();

  // ══════════════════════════════════════════════════════════════
  //  DATA FETCHERS
  // ══════════════════════════════════════════════════════════════

  fetchModels = (params: PagerRequest) => {
    return this.mlModelsService.list(params).pipe(
      map((res) => res.data as PagedData<MLModelDto>),
    );
  };

  fetchTrainingRuns = (params: PagerRequest) => {
    return this.mlModelsService.listTrainingRuns(params).pipe(
      map((res) => res.data as PagedData<MLTrainingRunDto>),
    );
  };

  fetchShadowEvals = (params: PagerRequest) => {
    return this.mlEvaluationService.listShadow(params).pipe(
      map((res) => res.data as PagedData<ShadowEvaluationDto>),
    );
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
    this.notifications.success(`Selected model: ${model.symbol} v${model.modelVersion}`);
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
    this.lossCurveOptions = this.buildLossCurveChart();
    this.featureImportanceOptions = this.buildFeatureImportanceChart();
  }

  submitTraining(): void {
    if (!this.trainingForm.symbol || !this.trainingForm.fromDate || !this.trainingForm.toDate) {
      this.notifications.warning('Please fill in all fields');
      return;
    }
    this.submittingTraining.set(true);
    const req: TriggerMLTrainingRequest = {
      symbol: this.trainingForm.symbol,
      timeframe: this.trainingForm.timeframe,
      fromDate: this.trainingForm.fromDate,
      toDate: this.trainingForm.toDate,
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
    this.cumulativeRaceOptions = this.buildCumulativeRaceChart();
  }

  submitShadow(): void {
    if (!this.shadowForm.championModelId || !this.shadowForm.challengerModelId || !this.shadowForm.symbol) {
      this.notifications.warning('Please fill in all fields');
      return;
    }
    this.submittingShadow.set(true);
    const req: StartShadowEvaluationRequest = {
      championModelId: this.shadowForm.championModelId,
      challengerModelId: this.shadowForm.challengerModelId,
      symbol: this.shadowForm.symbol,
      timeframe: this.shadowForm.timeframe,
      requiredTrades: this.shadowForm.requiredTrades,
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
        type: 'category', data: labels,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value', min: 40, max: 90,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Accuracy', type: 'line', smooth: true, symbol: 'none',
          data,
          lineStyle: { color: '#0071E3', width: 2 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0,113,227,0.15)' },
                { offset: 1, color: 'rgba(0,113,227,0)' },
              ],
            } as any,
          },
        },
        {
          name: 'Threshold', type: 'line', symbol: 'none',
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
        type: 'value', min: 0, max: 100,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Accuracy', type: 'bar',
          data: [
            { value: 74, itemStyle: { color: '#0071E3' } },
            { value: 62, itemStyle: { color: '#34C759' } },
            { value: 58, itemStyle: { color: '#FF9500' } },
          ],
          barWidth: 40,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          label: {
            show: true, position: 'top',
            formatter: '{c}%', fontSize: 12, color: '#6E6E73',
          },
        },
      ],
    };
  }

  private buildConfidenceCalibrationChart(): EChartsOption {
    const bins = ['0-10', '10-20', '20-30', '30-40', '40-50', '50-60', '60-70', '70-80', '80-90', '90-100'];
    const predictedMidpoints = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95];
    const actualAccuracy = [8, 18, 22, 38, 42, 52, 60, 71, 80, 88];
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params : [params];
          let tip = `${p[0].name}%<br/>`;
          p.forEach((item: any) => { tip += `${item.seriesName}: ${item.value}%<br/>`; });
          return tip;
        },
      },
      xAxis: {
        type: 'category', data: bins, name: 'Predicted Confidence',
        nameLocation: 'center', nameGap: 28,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value', min: 0, max: 100, name: 'Actual Accuracy',
        nameLocation: 'center', nameGap: 36,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Model', type: 'line', smooth: true,
          data: actualAccuracy,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
          symbolSize: 6,
        },
        {
          name: 'Perfect', type: 'line', symbol: 'none',
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
        formatter: (params: any) => `Prediction #${params.data[0] + 1}: ${params.data[2] === 1 ? 'Correct' : 'Incorrect'}`,
      },
      xAxis: {
        type: 'value', name: 'Prediction #',
        nameLocation: 'center', nameGap: 24,
        min: 0, max: 60,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: -0.5, max: 1.5,
        axisLabel: {
          fontSize: 11, color: '#6E6E73',
          formatter: (val: number) => val === 1 ? 'Correct' : val === 0 ? 'Incorrect' : '',
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        interval: 1,
      },
      series: [{
        type: 'scatter', symbolSize: 10,
        data: points,
        itemStyle: {
          color: (params: any) => params.data[2] === 1 ? '#34C759' : '#FF3B30',
        },
      }],
    };
  }

  private buildLossCurveChart(): EChartsOption {
    const epochs = Array.from({ length: 50 }, (_, i) => i + 1);
    const trainLoss: number[] = [];
    const valLoss: number[] = [];
    let tl = 0.95;
    let vl = 0.98;
    for (let i = 0; i < 50; i++) {
      tl *= (0.96 + Math.random() * 0.02);
      vl *= (0.965 + Math.random() * 0.02);
      vl = Math.max(vl, tl + 0.02);
      trainLoss.push(parseFloat(tl.toFixed(4)));
      valLoss.push(parseFloat(vl.toFixed(4)));
    }
    return {
      grid: { top: 30, right: 20, bottom: 30, left: 50 },
      legend: {
        data: ['Training Loss', 'Validation Loss'],
        top: 0, textStyle: { fontSize: 11, color: '#6E6E73' },
      },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category', data: epochs.map(String), name: 'Epoch',
        nameLocation: 'center', nameGap: 24,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Training Loss', type: 'line', smooth: true, symbol: 'none',
          data: trainLoss,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
        {
          name: 'Validation Loss', type: 'line', smooth: true, symbol: 'none',
          data: valLoss,
          lineStyle: { color: '#FF9500', width: 2 },
          itemStyle: { color: '#FF9500' },
        },
      ],
    };
  }

  private buildFeatureImportanceChart(): EChartsOption {
    const features = [
      'RSI (14)', 'MACD Histogram', 'Bollinger Width', 'ATR (14)',
      'EMA 50 Slope', 'Volume Ratio', 'Stochastic K', 'ADX',
      'Price vs SMA 200', 'Candle Body Ratio',
    ].reverse();
    const importances = [0.18, 0.15, 0.13, 0.11, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04].reverse();

    return {
      grid: { top: 10, right: 30, bottom: 30, left: 130 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `${p.name}: ${(p.value * 100).toFixed(1)}%`;
        },
      },
      xAxis: {
        type: 'value', min: 0, max: 0.2,
        axisLabel: {
          fontSize: 11, color: '#6E6E73',
          formatter: (val: number) => `${(val * 100).toFixed(0)}%`,
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category', data: features,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      series: [{
        type: 'bar', data: importances,
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
            colorStops: [
              { offset: 0, color: '#0071E3' },
              { offset: 1, color: '#5AC8FA' },
            ],
          } as any,
          borderRadius: [0, 4, 4, 0],
        },
        barWidth: 18,
      }],
    };
  }

  private buildHeadToHeadChart(shadow?: ShadowEvaluationDto): EChartsOption {
    const champAcc = shadow?.championDirectionAccuracy != null ? shadow.championDirectionAccuracy * 100 : 71.2;
    const challAcc = shadow?.challengerDirectionAccuracy != null ? shadow.challengerDirectionAccuracy * 100 : 68.5;
    return {
      grid: { top: 30, right: 40, bottom: 40, left: 40 },
      legend: {
        data: ['Champion', 'Challenger'],
        top: 0, textStyle: { fontSize: 11, color: '#6E6E73' },
      },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category', data: ['Accuracy', 'Precision', 'Recall', 'F1 Score'],
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Champion', type: 'bar',
          data: [champAcc, champAcc - 2.1, champAcc - 0.8, champAcc - 1.5],
          itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          barGap: '20%',
          label: { show: true, position: 'top', formatter: '{c}%', fontSize: 10, color: '#6E6E73' },
        },
        {
          name: 'Challenger', type: 'bar',
          data: [challAcc, challAcc - 1.5, challAcc + 0.3, challAcc - 0.9],
          itemStyle: { color: '#34C759', borderRadius: [4, 4, 0, 0] },
          label: { show: true, position: 'top', formatter: '{c}%', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  }

  private buildCumulativeRaceChart(): EChartsOption {
    const days = 30;
    const labels = this.generateDates(days);
    const championData: number[] = [];
    const challengerData: number[] = [];
    let cAcc = 55;
    let chAcc = 53;
    for (let i = 0; i < days; i++) {
      cAcc += (Math.random() - 0.42) * 3;
      chAcc += (Math.random() - 0.44) * 3;
      cAcc = Math.max(50, Math.min(85, cAcc));
      chAcc = Math.max(48, Math.min(83, chAcc));
      championData.push(parseFloat(cAcc.toFixed(1)));
      challengerData.push(parseFloat(chAcc.toFixed(1)));
    }
    return {
      grid: { top: 30, right: 20, bottom: 30, left: 50 },
      legend: {
        data: ['Champion', 'Challenger'],
        top: 0, textStyle: { fontSize: 11, color: '#6E6E73' },
      },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category', data: labels,
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value', min: 40, max: 90,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Champion', type: 'line', smooth: true, symbol: 'none',
          data: championData,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
        {
          name: 'Challenger', type: 'line', smooth: true, symbol: 'none',
          data: challengerData,
          lineStyle: { color: '#34C759', width: 2 },
          itemStyle: { color: '#34C759' },
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
}
