import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';

import { MLModelsService } from '@core/services/ml-models.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  DriftAlertDto,
  MLModelDto,
  MLModelFeatureImportanceDto,
  MLTrainingRunDiagnosticsDto,
  MLTrainingRunDto,
  RollbackMLModelRequest,
} from '@core/api/api.types';

import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'app-ml-model-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    StatusBadgeComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ConfirmDialogComponent,
  ],
  template: `
    <div class="page">
      @if (loading()) {
        <app-card-skeleton [lines]="10" />
      } @else if (model()) {
        @if (model(); as m) {
          <div class="title-row">
            <div class="title-left">
              <button type="button" class="btn-back" (click)="goBack()" aria-label="Back">
                &larr;
              </button>
              <h1 class="title">ML Model #{{ m.id }}</h1>
              @if (m.isActive) {
                <span class="active-pill">Active</span>
              } @else {
                <app-status-badge [status]="m.status" type="default" />
              }
            </div>
            <div class="title-actions">
              @if (!m.isActive) {
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="onActivate()"
                  [disabled]="busy()"
                >
                  Activate
                </button>
              }
              <button
                type="button"
                class="btn btn-warning"
                (click)="showRollback.set(true)"
                [disabled]="busy()"
              >
                Rollback to Prior
              </button>
            </div>
          </div>

          @if (m.status === 'Failed' && failureMessage(); as msg) {
            <div class="failure-banner" role="alert">
              <div class="failure-title">Training failed</div>
              <pre class="failure-msg">{{ msg }}</pre>
              @if (linkedTrainingRun(); as run) {
                <div class="failure-meta">
                  Run #{{ run.id }} · started {{ run.startedAt | date: 'MMM d, yyyy HH:mm' }}
                  @if (run.completedAt) {
                    · failed {{ run.completedAt | date: 'MMM d, yyyy HH:mm' }}
                  }
                </div>
              }
            </div>
          }

          <section class="card">
            <header class="card-head"><h3>Model Information</h3></header>
            <dl class="grid">
              <div class="item">
                <dt>Symbol</dt>
                <dd>{{ m.symbol ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Timeframe</dt>
                <dd>{{ m.timeframe }}</dd>
              </div>
              <div class="item">
                <dt>Version</dt>
                <dd class="mono">{{ m.modelVersion ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Status</dt>
                <dd>{{ m.status }}</dd>
              </div>
              <div class="item">
                <dt>Active</dt>
                <dd>{{ m.isActive ? 'Yes' : 'No' }}</dd>
              </div>
              <div class="item">
                <dt>File Path</dt>
                <dd class="mono">{{ m.filePath || '—' }}</dd>
              </div>
              <div class="item">
                <dt>Direction Accuracy</dt>
                <dd class="mono">
                  {{
                    m.directionAccuracy !== null
                      ? (m.directionAccuracy * 100 | number: '1.2-2') + '%'
                      : '—'
                  }}
                </dd>
              </div>
              <div class="item">
                <dt>Magnitude RMSE</dt>
                <dd class="mono">
                  {{ m.magnitudeRMSE !== null ? (m.magnitudeRMSE | number: '1.4-4') : '—' }}
                </dd>
              </div>
              <div class="item">
                <dt>Training Samples</dt>
                <dd class="mono">{{ m.trainingSamples | number }}</dd>
              </div>
              <div class="item">
                <dt>Trained At</dt>
                <dd>{{ m.trainedAt | date: 'MMM d, yyyy HH:mm' }}</dd>
              </div>
              <div class="item">
                <dt>Activated At</dt>
                <dd>{{ m.activatedAt ? (m.activatedAt | date: 'MMM d, yyyy HH:mm') : '—' }}</dd>
              </div>
            </dl>
          </section>

          <section class="card">
            <header class="card-head">
              <h3>Recent Training Runs</h3>
              <span class="card-sub">{{ m.symbol }} · {{ m.timeframe }}</span>
            </header>
            @if (trainingRunsLoading()) {
              <app-card-skeleton [lines]="4" />
            } @else if (trainingRuns().length > 0) {
              <table class="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th class="num">Dir Acc</th>
                    <th class="num">Mag RMSE</th>
                    <th class="num">Samples</th>
                    <th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  @for (run of trainingRuns(); track run.id) {
                    <tr
                      [class.row-current]="run.mlModelId === m.id"
                      [class.row-clickable]="true"
                      [class.row-expanded]="expandedRunId() === run.id"
                      (click)="toggleRun(run.id)"
                      [attr.aria-expanded]="expandedRunId() === run.id"
                    >
                      <td class="mono">
                        <span
                          class="caret"
                          [class.caret-open]="expandedRunId() === run.id"
                          aria-hidden="true"
                        >
                          ›
                        </span>
                        #{{ run.id }}
                      </td>
                      <td>
                        <app-status-badge [status]="run.status" type="default" />
                      </td>
                      <td>{{ run.startedAt | date: 'MMM d, HH:mm' }}</td>
                      <td class="mono">{{ runDuration(run) }}</td>
                      <td class="num mono">
                        {{
                          run.directionAccuracy !== null
                            ? (run.directionAccuracy * 100 | number: '1.2-2') + '%'
                            : '—'
                        }}
                      </td>
                      <td class="num mono">
                        {{
                          run.magnitudeRMSE !== null ? (run.magnitudeRMSE | number: '1.4-4') : '—'
                        }}
                      </td>
                      <td class="num mono">{{ run.totalSamples | number }}</td>
                      <td class="mono">
                        @if (run.mlModelId; as mid) {
                          @if (mid === m.id) {
                            <span class="self-tag">this model</span>
                          } @else {
                            <a [routerLink]="['/ml-models', mid]" (click)="$event.stopPropagation()"
                              >#{{ mid }}</a
                            >
                          }
                        } @else {
                          —
                        }
                      </td>
                    </tr>
                    @if (expandedRunId() === run.id) {
                      <tr class="row-detail">
                        <td colspan="8">
                          @if (diagnosticsLoading()) {
                            <app-card-skeleton [lines]="3" />
                          } @else if (diagnostics(); as d) {
                            <div class="diag-grid">
                              @if (run.errorMessage) {
                                <div class="diag-item diag-error">
                                  <dt>Error message</dt>
                                  <dd class="mono">{{ run.errorMessage }}</dd>
                                </div>
                              }
                              <div class="diag-item">
                                <dt>Architecture</dt>
                                <dd class="mono">{{ d.learnerArchitecture }}</dd>
                              </div>
                              <div class="diag-item">
                                <dt>Trigger</dt>
                                <dd>{{ d.triggerType }}</dd>
                              </div>
                              <div class="diag-item">
                                <dt>Priority</dt>
                                <dd class="mono">{{ d.priority }}</dd>
                              </div>
                              <div class="diag-item">
                                <dt>Attempts</dt>
                                <dd class="mono">{{ d.attemptCount }}</dd>
                              </div>
                              @if (d.f1Score !== null) {
                                <div class="diag-item">
                                  <dt>F1</dt>
                                  <dd class="mono">{{ d.f1Score | number: '1.4-4' }}</dd>
                                </div>
                              }
                              @if (d.brierScore !== null) {
                                <div class="diag-item">
                                  <dt>Brier</dt>
                                  <dd class="mono">{{ d.brierScore | number: '1.4-4' }}</dd>
                                </div>
                              }
                              @if (d.sharpeRatio !== null) {
                                <div class="diag-item">
                                  <dt>Sharpe</dt>
                                  <dd class="mono">{{ d.sharpeRatio | number: '1.2-2' }}</dd>
                                </div>
                              }
                              @if (d.expectedValue !== null) {
                                <div class="diag-item">
                                  <dt>Expected Value</dt>
                                  <dd class="mono">{{ d.expectedValue | number: '1.4-4' }}</dd>
                                </div>
                              }
                              @if (d.abstentionRate !== null) {
                                <div class="diag-item">
                                  <dt>Abstention</dt>
                                  <dd class="mono">
                                    {{ (d.abstentionRate * 100 | number: '1.1-1') + '%' }}
                                  </dd>
                                </div>
                              }
                              @if (d.labelImbalanceRatio !== null) {
                                <div class="diag-item">
                                  <dt>Label imbalance</dt>
                                  <dd class="mono">
                                    {{ d.labelImbalanceRatio | number: '1.2-2' }}
                                  </dd>
                                </div>
                              }
                              @if (d.datasetHash) {
                                <div class="diag-item">
                                  <dt>Dataset hash</dt>
                                  <dd class="mono trunc">{{ d.datasetHash }}</dd>
                                </div>
                              }
                              @if (trainingFlagSummary(d); as flags) {
                                <div class="diag-item diag-wide">
                                  <dt>Flags</dt>
                                  <dd>{{ flags }}</dd>
                                </div>
                              }
                              @if (d.hyperparamConfigJson) {
                                <div class="diag-item diag-wide">
                                  <dt>Hyperparameters</dt>
                                  <dd>
                                    <pre class="json">{{ prettyJson(d.hyperparamConfigJson) }}</pre>
                                  </dd>
                                </div>
                              }
                            </div>
                          } @else {
                            <p class="muted">Diagnostics unavailable for this run.</p>
                          }
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            } @else {
              <app-empty-state
                title="No training runs found"
                [description]="
                  'No recent training runs match ' + m.symbol + ' / ' + m.timeframe + '.'
                "
              />
            }
          </section>

          <section class="card">
            <header class="card-head">
              <h3>Feature Importance</h3>
              <span class="card-sub">
                {{ m.symbol ?? 'all symbols' }} · {{ m.timeframe }} · cross-architecture consensus
              </span>
            </header>
            @if (featureImportanceLoading()) {
              <app-card-skeleton [lines]="6" />
            } @else if (featureImportance(); as fi) {
              @if (fi.features.length > 0) {
                <div class="feature-meta">
                  <span>
                    {{ fi.contributingModelCount }}
                    {{ fi.contributingModelCount === 1 ? 'model' : 'models' }} contributed
                  </span>
                  <span>·</span>
                  <span>
                    Kendall τ {{ fi.meanKendallTau | number: '1.2-2' }}
                    <em class="muted-inline">(rank-correlation across architectures)</em>
                  </span>
                  @if (fi.consensusComputedAt) {
                    <span>·</span>
                    <span> Computed {{ fi.consensusComputedAt | date: 'MMM d, HH:mm' }} </span>
                  }
                </div>
                <div class="fi-bars">
                  @for (f of topFeatures(); track f.feature) {
                    <div class="fi-row" [title]="featureTooltip(f)">
                      <div class="fi-name mono">{{ f.feature }}</div>
                      <div class="fi-bar-track">
                        <div
                          class="fi-bar-fill"
                          [style.width.%]="(f.meanImportance / topFeatureMax()) * 100"
                          [class.fi-low-agreement]="f.agreementScore < 0.5"
                        ></div>
                      </div>
                      <div class="fi-value mono">{{ f.meanImportance | number: '1.4-4' }}</div>
                      <div class="fi-agree mono" [class.muted]="f.agreementScore < 0.5">
                        {{ (f.agreementScore * 100 | number: '1.0-0') + '%' }}
                      </div>
                    </div>
                  }
                </div>
              } @else if (fi.mrmrFallback.length > 0) {
                <div class="feature-meta">
                  <span>
                    Cross-architecture consensus not yet computed for this pair — falling back to
                    MRMR ranking.
                  </span>
                </div>
                <div class="fi-bars">
                  @for (f of fi.mrmrFallback; track f.featureName) {
                    <div class="fi-row" [title]="mrmrTooltip(f)">
                      <div class="fi-name mono">{{ f.featureName }}</div>
                      <div class="fi-bar-track">
                        <div
                          class="fi-bar-fill"
                          [style.width.%]="(Math.max(f.mrmrScore, 0) / mrmrFallbackMax()) * 100"
                        ></div>
                      </div>
                      <div class="fi-value mono">{{ f.mrmrScore | number: '1.4-4' }}</div>
                      <div class="fi-agree mono">#{{ f.mrmrRank + 1 }}</div>
                    </div>
                  }
                </div>
              } @else {
                <app-empty-state
                  title="No feature-importance data yet"
                  description="MLFeatureConsensusWorker hasn't produced a snapshot for this symbol/timeframe, and no MRMR ranking has been computed."
                />
              }
            } @else {
              <app-empty-state
                title="Feature importance unavailable"
                description="Failed to load consensus snapshot."
              />
            }
          </section>

          <section class="card">
            <header class="card-head">
              <h3>Drift Alerts</h3>
              <span class="card-sub">{{ m.symbol ?? 'all symbols' }}</span>
            </header>
            @if (driftAlertsLoading()) {
              <app-card-skeleton [lines]="3" />
            } @else if (groupedDriftAlerts().length > 0) {
              <table class="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Severity</th>
                    <th>Detector</th>
                    <th>Last Triggered</th>
                    <th class="num">Count</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (a of groupedDriftAlerts(); track a.key) {
                    <tr>
                      <td>{{ a.alertType }}</td>
                      <td>
                        <span class="pill" [attr.data-sev]="a.severity">{{ a.severity }}</span>
                      </td>
                      <td class="mono">{{ a.detectorType ?? '—' }}</td>
                      <td>
                        {{ a.lastTriggeredAt ? (a.lastTriggeredAt | date: 'MMM d, HH:mm') : '—' }}
                      </td>
                      <td class="num mono">{{ a.count }}</td>
                      <td>
                        @if (a.activeCount > 0) {
                          <span class="pill pill-active"
                            >Active{{ a.activeCount > 1 ? ' (' + a.activeCount + ')' : '' }}</span
                          >
                        } @else if (a.autoResolvedCount > 0) {
                          <span class="pill pill-resolved">Auto-resolved</span>
                        } @else {
                          <span class="pill">Inactive</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <app-empty-state
                title="No drift alerts"
                [description]="
                  'No active or recent drift alerts on ' + (m.symbol ?? 'this symbol') + '.'
                "
              />
            }
          </section>

          <section class="card">
            <header class="card-head"><h3>Related</h3></header>
            <div class="related">
              <button type="button" class="related-link" (click)="goBack()">
                Back to model registry <span aria-hidden="true">&rarr;</span>
              </button>
              <a class="related-link" [routerLink]="['/drift-report']"
                >Drift report <span aria-hidden="true">&rarr;</span></a
              >
            </div>
          </section>
        }
      } @else {
        <app-error-state
          title="Model not found"
          [message]="errorMessage()"
          retryLabel="Back"
          (retry)="goBack()"
        />
      }

      <app-confirm-dialog
        [open]="showRollback()"
        title="Rollback to Prior Model"
        [message]="
          'Rollback to the most recent superseded model for ' +
          (model()?.symbol ?? '—') +
          ' / ' +
          (model()?.timeframe ?? '—') +
          '? The current active model will be deactivated.'
        "
        confirmLabel="Rollback"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="onRollback()"
        (cancelled)="showRollback.set(false)"
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
      .title-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .title-left {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .btn-back {
        width: 36px;
        height: 36px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }
      .btn-back:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        margin: 0;
      }
      .active-pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .title-actions {
        display: flex;
        gap: var(--space-2);
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
      .btn-warning {
        background: rgba(255, 149, 0, 0.15);
        color: #c93400;
      }
      .btn-warning:hover:not(:disabled) {
        background: rgba(255, 149, 0, 0.25);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        margin: 0;
      }
      .item {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .item:nth-child(3n) {
        border-right: none;
      }
      .item dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .item dd {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        margin: 0;
      }
      .item dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .related {
        padding: var(--space-4) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .related-link {
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .related-link:hover {
        text-decoration: underline;
      }
      .note {
        padding: var(--space-4);
        background: var(--bg-primary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin: 0;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
      }
      .card-sub {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .failure-banner {
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.3);
        border-radius: var(--radius-md);
        padding: var(--space-4) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .failure-title {
        font-weight: var(--font-semibold);
        color: #d70015;
        font-size: var(--text-sm);
      }
      .failure-msg {
        margin: 0;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
        overflow: auto;
      }
      .failure-meta {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .table tbody tr:last-child td {
        border-bottom: none;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
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
        font-size: var(--text-xs);
      }
      .row-current {
        background: rgba(0, 113, 227, 0.06);
      }
      .self-tag {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .pill[data-sev='Critical'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .pill[data-sev='Warning'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill[data-sev='Info'] {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .pill-active {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill-resolved {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .row-clickable {
        cursor: pointer;
      }
      .row-clickable:hover {
        background: var(--bg-tertiary);
      }
      .row-expanded {
        background: var(--bg-tertiary);
      }
      .caret {
        display: inline-block;
        width: 12px;
        margin-right: var(--space-1);
        color: var(--text-tertiary);
        transition: transform 0.15s ease;
      }
      .caret-open {
        transform: rotate(90deg);
      }
      .row-detail > td {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-primary);
      }
      .diag-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-3) var(--space-5);
      }
      .diag-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .diag-item dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .diag-item dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .diag-item dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .diag-item dd.trunc {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .diag-wide {
        grid-column: 1 / -1;
      }
      .diag-error dd {
        color: #d70015;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .json {
        margin: 0;
        padding: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 240px;
        overflow: auto;
      }
      .muted {
        margin: 0;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      @media (max-width: 768px) {
        .diag-grid {
          grid-template-columns: 1fr;
        }
      }
      .feature-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        padding: var(--space-3) var(--space-5);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border);
      }
      .muted-inline {
        color: var(--text-tertiary);
        font-style: normal;
      }
      .fi-bars {
        padding: var(--space-3) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .fi-row {
        display: grid;
        grid-template-columns: 200px 1fr 80px 50px;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-sm);
      }
      .fi-name {
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fi-bar-track {
        height: 8px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .fi-bar-fill {
        height: 100%;
        background: var(--accent);
        border-radius: var(--radius-full);
        transition: width 0.2s ease;
      }
      .fi-bar-fill.fi-low-agreement {
        background: rgba(255, 149, 0, 0.7);
      }
      .fi-value {
        text-align: right;
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .fi-agree {
        text-align: right;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .fi-agree.muted {
        color: var(--text-tertiary);
      }
      @media (max-width: 768px) {
        .fi-row {
          grid-template-columns: 120px 1fr 70px 40px;
          font-size: var(--text-xs);
        }
      }
      @media (max-width: 768px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .item {
          border-right: none;
        }
      }
    `,
  ],
})
export class MLModelDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(MLModelsService);
  private readonly notifications = inject(NotificationService);

  readonly model = signal<MLModelDto | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly showRollback = signal(false);

  readonly trainingRuns = signal<MLTrainingRunDto[]>([]);
  readonly trainingRunsLoading = signal(false);
  readonly driftAlerts = signal<DriftAlertDto[]>([]);
  readonly driftAlertsLoading = signal(false);

  readonly expandedRunId = signal<number | null>(null);
  readonly diagnostics = signal<MLTrainingRunDiagnosticsDto | null>(null);
  readonly diagnosticsLoading = signal(false);

  readonly featureImportance = signal<MLModelFeatureImportanceDto | null>(null);
  readonly featureImportanceLoading = signal(false);

  // Top-15 features keep the chart legible — beyond that, feature names crowd
  // the y-axis and the long tail is mostly low-signal noise.
  readonly topFeatures = computed(() => this.featureImportance()?.features.slice(0, 15) ?? []);

  // Bar widths are normalised to the max of the *visible* slice (not the full
  // distribution), so the operator's eye is drawn to relative differences
  // among the features they can actually see.
  readonly topFeatureMax = computed(() => {
    const top = this.topFeatures();
    if (top.length === 0) return 1;
    return Math.max(...top.map((f) => f.meanImportance), 1e-9);
  });

  readonly mrmrFallbackMax = computed(() => {
    const fb = this.featureImportance()?.mrmrFallback ?? [];
    if (fb.length === 0) return 1;
    return Math.max(...fb.map((f) => Math.max(f.mrmrScore, 0)), 1e-9);
  });

  // Exposed for templates so we don't need a `Math` pipe — Angular's strict
  // template checker can't see globals.
  readonly Math = Math;
  // Cache so re-expanding the same row doesn't re-fetch.
  private readonly diagCache = new Map<number, MLTrainingRunDiagnosticsDto>();

  // Drift alerts come back unfiltered by detector signature — for a degraded
  // model we routinely see 8+ identical (alertType, severity, detector) rows
  // that are just retriggers of the same condition. Group them so the table
  // shows one row per distinct alert with a count + a single "most recent
  // triggered" timestamp.
  readonly groupedDriftAlerts = computed(() => {
    const buckets = new Map<
      string,
      {
        key: string;
        alertType: string;
        severity: string;
        detectorType: string | null;
        lastTriggeredAt: string | null;
        count: number;
        activeCount: number;
        autoResolvedCount: number;
      }
    >();
    for (const a of this.driftAlerts()) {
      const key = `${a.alertType}|${a.severity}|${a.detectorType ?? ''}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        if (a.isActive) existing.activeCount += 1;
        if (a.autoResolvedAt) existing.autoResolvedCount += 1;
        if (a.lastTriggeredAt) {
          if (!existing.lastTriggeredAt || a.lastTriggeredAt > existing.lastTriggeredAt) {
            existing.lastTriggeredAt = a.lastTriggeredAt;
          }
        }
      } else {
        buckets.set(key, {
          key,
          alertType: a.alertType,
          severity: a.severity,
          detectorType: a.detectorType,
          lastTriggeredAt: a.lastTriggeredAt,
          count: 1,
          activeCount: a.isActive ? 1 : 0,
          autoResolvedCount: a.autoResolvedAt ? 1 : 0,
        });
      }
    }
    return Array.from(buckets.values()).sort((x, y) => {
      // Active first, then by recency.
      if (x.activeCount !== y.activeCount) return y.activeCount - x.activeCount;
      const xt = x.lastTriggeredAt ?? '';
      const yt = y.lastTriggeredAt ?? '';
      return yt.localeCompare(xt);
    });
  });

  // The training run that produced this model (matched by mlModelId). For
  // Failed models this carries the operator-actionable error message; for
  // Completed models it lets the table mark "this model" inline.
  readonly linkedTrainingRun = computed<MLTrainingRunDto | null>(() => {
    const m = this.model();
    if (!m) return null;
    const direct = this.trainingRuns().find((r) => r.mlModelId === m.id);
    if (direct) return direct;
    // Fallback for Failed models that never linked back: surface the most
    // recent Failed run on the same symbol/timeframe so the operator at least
    // sees *some* failure context. Better than the previous static placeholder.
    if (m.status === 'Failed') {
      return this.trainingRuns().find((r) => r.status === 'Failed') ?? null;
    }
    return null;
  });

  readonly failureMessage = computed(() => this.linkedTrainingRun()?.errorMessage ?? null);

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || Number.isNaN(id)) {
      this.loading.set(false);
      this.errorMessage.set('Invalid model id');
      return;
    }
    this.load(id);
  }

  goBack(): void {
    this.router.navigate(['/ml-models']);
  }

  onActivate(): void {
    const m = this.model();
    if (!m) return;
    this.busy.set(true);
    this.service.activate(m.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(`Model ${m.symbol} ${m.timeframe} activated`);
          this.load(m.id);
        } else {
          this.notifications.error(res.message ?? 'Activation failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  onRollback(): void {
    const m = this.model();
    if (!m) return;
    const request: RollbackMLModelRequest = {
      symbol: m.symbol ?? undefined,
      timeframe: m.timeframe,
    };
    this.busy.set(true);
    this.service.rollback(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showRollback.set(false);
        if (res.status) {
          this.notifications.success('Rolled back to prior model');
          if (res.data) {
            this.router.navigate(['/ml-models', res.data.id]);
          } else {
            this.goBack();
          }
        } else {
          this.notifications.error(res.message ?? 'Rollback failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.showRollback.set(false);
      },
    });
  }

  toggleRun(runId: number): void {
    if (this.expandedRunId() === runId) {
      this.expandedRunId.set(null);
      this.diagnostics.set(null);
      return;
    }
    this.expandedRunId.set(runId);
    const cached = this.diagCache.get(runId);
    if (cached) {
      this.diagnostics.set(cached);
      return;
    }
    this.diagnostics.set(null);
    this.diagnosticsLoading.set(true);
    this.service.getTrainingRunDiagnostics(runId).subscribe({
      next: (res) => {
        this.diagnosticsLoading.set(false);
        if (this.expandedRunId() !== runId) return; // user collapsed mid-flight
        if (res.data) {
          this.diagCache.set(runId, res.data);
          this.diagnostics.set(res.data);
        } else {
          this.diagnostics.set(null);
        }
      },
      error: () => {
        this.diagnosticsLoading.set(false);
        if (this.expandedRunId() === runId) this.diagnostics.set(null);
      },
    });
  }

  prettyJson(json: string | null | undefined): string {
    if (!json) return '';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  // Compact summary of the bool feature-flag fields so we don't render eight
  // separate rows for "smoteApplied: false". Only flips that are *on* show up,
  // mirroring how an operator scans a config diff.
  trainingFlagSummary(d: MLTrainingRunDiagnosticsDto): string | null {
    const flags = [
      d.isPretrainingRun && 'pretraining',
      d.isDistillationRun && 'distillation',
      d.isEmergencyRetrain && 'emergency-retrain',
      d.isMamlRun && `MAML(${d.mamlInnerSteps ?? '?'})`,
      d.smoteApplied && 'SMOTE',
      d.adversarialAugmentApplied && 'adversarial',
      d.mixupApplied && 'mixup',
      d.curriculumApplied && `curriculum(${d.curriculumFinalDifficulty?.toFixed?.(2) ?? '?'})`,
      d.nceLossUsed && 'NCE-loss',
      d.rareEventWeightingApplied && 'rare-event-weighting',
    ].filter(Boolean);
    return flags.length ? flags.join(' · ') : null;
  }

  runDuration(run: MLTrainingRunDto): string {
    if (!run.completedAt) return '—';
    const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  private load(id: number): void {
    this.loading.set(true);
    this.service.getById(id).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.data) {
          this.model.set(res.data);
          this.errorMessage.set(null);
          // Side-cars: training-run history (used to render the table AND to
          // resolve the linked run for the failure banner) + drift alerts.
          // Both are bounded fetches so a misbehaving symbol can't blow up
          // this page.
          this.loadTrainingRuns(res.data);
          this.loadDriftAlerts(res.data);
          this.loadFeatureImportance(res.data.id);
        } else {
          this.model.set(null);
          this.errorMessage.set(res.message ?? 'Model not found');
        }
      },
      error: () => {
        this.loading.set(false);
        this.model.set(null);
        this.errorMessage.set('Failed to load model');
      },
    });
  }

  private loadTrainingRuns(m: MLModelDto): void {
    this.trainingRunsLoading.set(true);
    this.service
      .listTrainingRuns({
        currentPage: 1,
        itemCountPerPage: 10,
        filter: { symbol: m.symbol ?? undefined, timeframe: m.timeframe },
      })
      .subscribe({
        next: (res) => {
          this.trainingRunsLoading.set(false);
          this.trainingRuns.set(res.data?.data ?? []);
        },
        error: () => {
          this.trainingRunsLoading.set(false);
          this.trainingRuns.set([]);
        },
      });
  }

  private loadFeatureImportance(id: number): void {
    this.featureImportanceLoading.set(true);
    this.service.getFeatureImportance(id).subscribe({
      next: (res) => {
        this.featureImportanceLoading.set(false);
        this.featureImportance.set(res.data ?? null);
      },
      error: () => {
        this.featureImportanceLoading.set(false);
        this.featureImportance.set(null);
      },
    });
  }

  featureTooltip(f: {
    feature: string;
    meanImportance: number;
    stdImportance: number;
    agreementScore: number;
  }): string {
    return (
      `${f.feature}\n` +
      `mean importance: ${f.meanImportance.toFixed(4)}\n` +
      `std across architectures: ${f.stdImportance.toFixed(4)}\n` +
      `agreement: ${(f.agreementScore * 100).toFixed(0)}%`
    );
  }

  mrmrTooltip(f: {
    featureName: string;
    mrmrRank: number;
    mrmrScore: number;
    mutualInfoWithTarget: number;
    redundancyScore: number;
  }): string {
    return (
      `${f.featureName}\n` +
      `rank: ${f.mrmrRank + 1}\n` +
      `MRMR score: ${f.mrmrScore.toFixed(4)}\n` +
      `MI with target: ${f.mutualInfoWithTarget.toFixed(4)}\n` +
      `redundancy: ${f.redundancyScore.toFixed(4)}`
    );
  }

  private loadDriftAlerts(m: MLModelDto): void {
    if (!m.symbol) {
      this.driftAlerts.set([]);
      return;
    }
    this.driftAlertsLoading.set(true);
    this.service
      .listDriftReport({
        currentPage: 1,
        itemCountPerPage: 10,
        filter: { symbol: m.symbol },
      })
      .subscribe({
        next: (res) => {
          this.driftAlertsLoading.set(false);
          this.driftAlerts.set(res.data?.data ?? []);
        },
        error: () => {
          this.driftAlertsLoading.set(false);
          this.driftAlerts.set([]);
        },
      });
  }
}
