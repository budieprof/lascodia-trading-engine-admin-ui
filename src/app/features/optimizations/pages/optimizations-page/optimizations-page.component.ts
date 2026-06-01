import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, of, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  OptimizationDryRunDto,
  OptimizationRunDto,
  PagedData,
  PagerRequest,
  StrategyDto,
  TriggerOptimizationRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';

@Component({
  selector: 'app-optimizations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    ConfirmDialogComponent,
    CardSkeletonComponent,
    ChartCardComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
    DatePipe,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Optimizations"
        subtitle="Bayesian strategy-parameter search (TPE / GP-UCB / EHVI + Hyperband)"
      >
        <button type="button" class="btn btn-primary" (click)="openCreate()">
          + Trigger Optimization
        </button>
      </app-page-header>

      @if (showCreate()) {
        <form class="panel" [formGroup]="triggerForm" (ngSubmit)="submitTrigger()">
          <div class="panel-head">
            <h3>Trigger Optimization</h3>
            <button type="button" class="close" (click)="cancelCreate()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field
              label="Strategy"
              [required]="true"
              [control]="triggerForm.controls.strategyId"
            >
              <select appFormFieldControl formControlName="strategyId" (change)="loadDryRun()">
                <option [ngValue]="null">Select a strategy…</option>
                @for (s of strategies(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }} ({{ s.symbol }} {{ s.timeframe }})</option>
                }
              </select>
            </app-form-field>
            <app-form-field
              label="Trigger Type"
              [required]="true"
              [control]="triggerForm.controls.triggerType"
            >
              <select appFormFieldControl formControlName="triggerType">
                <option value="Manual">Manual</option>
                <option value="Scheduled">Scheduled</option>
                <option value="AutoDegrading">AutoDegrading</option>
              </select>
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancelCreate()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || triggerForm.invalid"
              >
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Queue
                }
              </button>
            </div>
          </div>

          @if (dryRunLoading()) {
            <app-card-skeleton [lines]="4" [showHeader]="false" />
          } @else if (dryRun()) {
            @if (dryRun(); as d) {
              <div class="dry-run">
                <h4>Dry Run Estimate</h4>
                <dl>
                  <div>
                    <dt>Grid Size</dt>
                    <dd class="mono">{{ d.estimatedGridSize }}</dd>
                  </div>
                  <div>
                    <dt>Candle Count</dt>
                    <dd class="mono">{{ d.candleCount | number }}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd class="mono">~{{ d.estimatedDurationMinutes }} min</dd>
                  </div>
                  <div>
                    <dt>CPU Cores</dt>
                    <dd class="mono">{{ d.estimatedCpuCores }}</dd>
                  </div>
                </dl>
                @if (d.notes) {
                  <p class="notes">{{ d.notes }}</p>
                }
              </div>
            }
          }
        </form>
      }

      <!-- 8-card KPI strip — fleet-wide optimization-run posture -->
      <div class="op-kpis">
        <div class="op-kpi">
          <span class="kpi-label">Total runs</span>
          <span class="kpi-value">{{ optStats().total }}</span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Running</span>
          <span class="kpi-value info">{{ optStats().running }}</span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Completed</span>
          <span class="kpi-value good">{{ optStats().completed }}</span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Abandoned</span>
          <span
            class="kpi-value"
            [class.warn]="optStats().abandoned > 0"
            [class.good]="optStats().abandoned === 0"
          >
            {{ optStats().abandoned }}
          </span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Approved</span>
          <span class="kpi-value good">{{ optStats().approved }}</span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Avg iterations</span>
          <span class="kpi-value">
            {{ optStats().avgIterations !== null ? optStats().avgIterations!.toFixed(1) : '—' }}
          </span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Avg lift</span>
          <span
            class="kpi-value"
            [class.good]="optStats().avgLift !== null && optStats().avgLift! > 0"
            [class.bad]="optStats().avgLift !== null && optStats().avgLift! < 0"
          >
            @if (optStats().avgLift !== null) {
              {{ optStats().avgLift! >= 0 ? '+' : '' }}{{ optStats().avgLift! | number: '1.3-3' }}
            } @else {
              —
            }
          </span>
        </div>
        <div class="op-kpi">
          <span class="kpi-label">Strategies covered</span>
          <span class="kpi-value">{{ optStats().strategiesCovered }}</span>
        </div>
      </div>

      <!-- 3-col chart row -->
      <div class="op-charts">
        <app-chart-card
          title="Status distribution"
          subtitle="Run lifecycle states across the fleet"
          [options]="optStatusDonutOptions()"
          height="240px"
        />
        <app-chart-card
          title="By trigger type"
          subtitle="Manual · Scheduled · AutoDegrading"
          [options]="optByTriggerOptions()"
          height="240px"
        />
        <app-chart-card
          title="Activity (last 14 days)"
          subtitle="Daily optimization-run starts"
          [options]="optActivityOptions()"
          height="240px"
        />
      </div>

      <!-- 2-col tables: biggest lifts + per-strategy breakdown -->
      <div class="op-board-row">
        <section class="op-board">
          <header class="op-board-head">
            <h3>Biggest health-score lifts</h3>
            <span class="muted">Completed runs where the search beat the baseline the most</span>
          </header>
          @if (topLifts().length > 0) {
            <div class="op-table-scroll">
              <table class="op-board-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th class="num">Strategy</th>
                    <th class="num">Iterations</th>
                    <th class="num">Baseline</th>
                    <th class="num">Best</th>
                    <th class="num">Δ</th>
                    <th>Trigger</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of topLifts(); track r.id) {
                    <tr (click)="select(r)">
                      <td class="mono">#{{ r.id }}</td>
                      <td class="num mono">#{{ r.strategyId }}</td>
                      <td class="num mono">{{ r.iterations }}</td>
                      <td class="num mono">
                        {{
                          r.baselineHealthScore !== null
                            ? (r.baselineHealthScore | number: '1.3-3')
                            : '—'
                        }}
                      </td>
                      <td class="num mono">
                        {{
                          r.bestHealthScore !== null ? (r.bestHealthScore | number: '1.3-3') : '—'
                        }}
                      </td>
                      <td
                        class="num mono"
                        [class.profit]="(r.bestHealthScore ?? 0) > (r.baselineHealthScore ?? 0)"
                        [class.loss]="(r.bestHealthScore ?? 0) < (r.baselineHealthScore ?? 0)"
                      >
                        @if (r.bestHealthScore !== null && r.baselineHealthScore !== null) {
                          {{ r.bestHealthScore - r.baselineHealthScore >= 0 ? '+' : ''
                          }}{{ r.bestHealthScore - r.baselineHealthScore | number: '1.3-3' }}
                        } @else {
                          —
                        }
                      </td>
                      <td class="mono">{{ r.triggerType }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="muted" style="padding: var(--space-4)">
              No completed runs with measurable lift yet.
            </p>
          }
        </section>

        <section class="op-board">
          <header class="op-board-head">
            <h3>Per-strategy breakdown</h3>
            <span class="muted">Runs and outcomes grouped by strategy</span>
          </header>
          @if (perStrategyBreakdown().length > 0) {
            <div class="op-table-scroll">
              <table class="op-board-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th class="num">Runs</th>
                    <th class="num">Completed</th>
                    <th class="num">Abandoned</th>
                    <th class="num">Avg iter</th>
                    <th class="num">Best lift</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perStrategyBreakdown(); track row.strategyId) {
                    <tr>
                      <td class="mono">#{{ row.strategyId }}</td>
                      <td class="num mono">{{ row.runs }}</td>
                      <td class="num mono profit">{{ row.completed }}</td>
                      <td class="num mono" [class.warn]="row.abandoned > 0">{{ row.abandoned }}</td>
                      <td class="num mono">{{ row.avgIterations.toFixed(1) }}</td>
                      <td
                        class="num mono"
                        [class.profit]="row.bestLift !== null && row.bestLift > 0"
                        [class.loss]="row.bestLift !== null && row.bestLift < 0"
                      >
                        @if (row.bestLift !== null) {
                          {{ row.bestLift >= 0 ? '+' : '' }}{{ row.bestLift | number: '1.3-3' }}
                        } @else {
                          —
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      </div>

      <section class="op-board">
        <header class="op-board-head">
          <h3>All optimization runs</h3>
          <span class="muted">Server-paged — click any row for params + lift detail</span>
        </header>
        <app-data-table
          #table
          [columnDefs]="columns"
          [fetchData]="fetchData"
          [searchable]="true"
          (rowClick)="select($event)"
        />
      </section>

      @if (selected()) {
        @if (selected(); as r) {
          <section class="detail">
            <header class="detail-head">
              <div class="title">
                <h3>Run #{{ r.id }} — Strategy {{ r.strategyId }}</h3>
                <span class="pill" [attr.data-status]="r.status">{{ r.status }}</span>
              </div>
              <div class="actions">
                @if (r.status === 'Completed') {
                  <button
                    type="button"
                    class="btn btn-primary"
                    (click)="showApprove.set(true)"
                    [disabled]="detailBusy()"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    class="btn btn-destructive"
                    (click)="showReject.set(true)"
                    [disabled]="detailBusy()"
                  >
                    Reject
                  </button>
                }
                <button type="button" class="btn btn-secondary" (click)="selected.set(null)">
                  Close
                </button>
              </div>
            </header>

            <dl class="stats">
              <div>
                <dt>Trigger</dt>
                <dd>{{ r.triggerType }}</dd>
              </div>
              <div>
                <dt>Iterations</dt>
                <dd class="mono">{{ r.iterations }}</dd>
              </div>
              <div>
                <dt>Baseline Score</dt>
                <dd class="mono">
                  {{ r.baselineHealthScore !== null ? r.baselineHealthScore.toFixed(2) : '—' }}
                </dd>
              </div>
              <div>
                <dt>Best Score</dt>
                <dd class="mono">
                  {{ r.bestHealthScore !== null ? r.bestHealthScore.toFixed(2) : '—' }}
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{{ r.startedAt | date: 'MMM d, HH:mm' }}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{{ r.completedAt ? (r.completedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd>{{ r.approvedAt ? (r.approvedAt | date: 'MMM d, HH:mm') : '—' }}</dd>
              </div>
            </dl>

            @if (r.bestParametersJson) {
              <div class="block">
                <h4>Best Parameters</h4>
                <pre>{{ formatJson(r.bestParametersJson) }}</pre>
              </div>
            }
            @if (r.baselineParametersJson) {
              <div class="block">
                <h4>Baseline Parameters</h4>
                <pre>{{ formatJson(r.baselineParametersJson) }}</pre>
              </div>
            }
            @if (r.errorMessage) {
              <div class="block error">
                <h4>Error</h4>
                <pre>{{ r.errorMessage }}</pre>
              </div>
            }
          </section>
        }
      }

      <app-confirm-dialog
        [open]="showApprove()"
        title="Approve Optimization"
        message="Apply the best parameters to the strategy. A 25/50/75/100% gradual rollout will be scheduled."
        confirmLabel="Approve"
        confirmVariant="primary"
        [loading]="detailBusy()"
        (confirm)="approve()"
        (cancelled)="showApprove.set(false)"
      />
      <app-confirm-dialog
        [open]="showReject()"
        title="Reject Optimization"
        message="Discard the best parameters. The strategy keeps its current configuration."
        confirmLabel="Reject"
        confirmVariant="destructive"
        [loading]="detailBusy()"
        (confirm)="reject()"
        (cancelled)="showReject.set(false)"
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
        display: flex;
        gap: var(--space-4);
        flex-wrap: wrap;
        padding: var(--space-5);
        align-items: flex-end;
      }
      .field {
        display: flex;
        flex-direction: column;
        min-width: 240px;
        flex: 1 1 240px;
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
        display: flex;
        gap: var(--space-2);
        margin-left: auto;
      }
      .dry-run {
        background: var(--bg-primary);
        border-top: 1px solid var(--border);
        padding: var(--space-4) var(--space-5);
      }
      .dry-run h4 {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .dry-run dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-4);
        margin: 0;
      }
      .dry-run dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .dry-run dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .dry-run dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .dry-run .notes {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }

      /* Optimizations density additions */
      .op-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .op-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .op-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .op-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .op-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .op-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .op-kpi .kpi-value.good {
        color: var(--profit);
      }
      .op-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .op-kpi .kpi-value.warn {
        color: #c93400;
      }
      .op-kpi .kpi-value.info {
        color: var(--accent);
      }

      .op-charts {
        display: grid;
        grid-template-columns: 1fr 1fr 1.4fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .op-charts {
          grid-template-columns: 1fr;
        }
      }

      .op-board-row {
        display: grid;
        grid-template-columns: 1.5fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .op-board-row {
          grid-template-columns: 1fr;
        }
      }

      .op-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .op-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .op-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .op-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .op-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .op-board-table th,
      .op-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .op-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .op-board-table tbody tr {
        cursor: pointer;
        transition: background 0.1s;
      }
      .op-board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .op-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      /* Bound the Biggest-lifts + Per-strategy panels — these used to
         render every row inline, so the page stretched to ~12k px tall
         when the per-strategy breakdown had hundreds of rows. Each
         table becomes a scroll surface; the sticky thead above keeps
         the column labels pinned while the operator scrolls inside the
         panel. The third "All optimization runs" section is server-
         paged via app-data-table and stays uncapped. */
      .op-table-scroll {
        max-height: 420px;
        overflow: auto;
      }
      .op-board-table th.num,
      .op-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .op-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .op-board-table .profit {
        color: var(--profit);
      }
      .op-board-table .loss {
        color: var(--loss);
      }
      .op-board-table .warn {
        color: #c93400;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      .detail {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .detail-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .title {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .title h3 {
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
      .pill[data-status='Running'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .pill[data-status='Completed'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-status='Approved'] {
        background: rgba(175, 82, 222, 0.12);
        color: #8944ab;
      }
      .pill[data-status='Rejected'] {
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .pill[data-status='Failed'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-4);
        margin: 0;
      }
      .stats dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .stats dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .stats dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .block h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .block pre {
        margin: 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
      }
      .block.error pre {
        border-color: rgba(255, 59, 48, 0.3);
        color: var(--loss);
      }
      .spin {
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
export class OptimizationsPageComponent implements OnInit {
  private readonly service = inject(StrategyFeedbackService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('table') table?: DataTableComponent<OptimizationRunDto>;

  readonly strategies = signal<StrategyDto[]>([]);
  readonly showCreate = signal(false);
  readonly busy = signal(false);
  readonly selected = signal<OptimizationRunDto | null>(null);
  readonly detailBusy = signal(false);
  readonly showApprove = signal(false);
  readonly showReject = signal(false);
  readonly dryRun = signal<OptimizationDryRunDto | null>(null);
  readonly dryRunLoading = signal(false);

  // Analytics sample — drives KPI strip, charts, breakdown tables. Loaded
  // via probe-and-fetch so totals reflect the whole DB; capped at 5000 rows.
  readonly optsSample = signal<OptimizationRunDto[]>([]);

  optStats = computed(() => {
    const all = this.optsSample();
    if (all.length === 0) {
      return {
        total: 0,
        running: 0,
        completed: 0,
        abandoned: 0,
        approved: 0,
        avgIterations: null as number | null,
        avgLift: null as number | null,
        strategiesCovered: 0,
      };
    }
    let running = 0;
    let completed = 0;
    let abandoned = 0;
    let approved = 0;
    let iterSum = 0;
    let liftSum = 0;
    let liftCount = 0;
    const strategies = new Set<number>();
    for (const r of all) {
      const status = String(r.status);
      if (status === 'Running') running++;
      else if (status === 'Completed') completed++;
      else if (status === 'Abandoned') abandoned++;
      if (r.approvedAt) approved++;
      iterSum += r.iterations ?? 0;
      strategies.add(r.strategyId);
      if (r.bestHealthScore != null && r.baselineHealthScore != null) {
        liftSum += r.bestHealthScore - r.baselineHealthScore;
        liftCount++;
      }
    }
    return {
      total: all.length,
      running,
      completed,
      abandoned,
      approved,
      avgIterations: +(iterSum / all.length).toFixed(1),
      avgLift: liftCount > 0 ? +(liftSum / liftCount).toFixed(3) : null,
      strategiesCovered: strategies.size,
    };
  });

  optStatusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.optsSample()) {
      const k = String(r.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Running: '#0071E3',
      Completed: '#34C759',
      Abandoned: '#FF9500',
      Failed: '#FF3B30',
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

  optByTriggerOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.optsSample()) {
      const k = String(r.triggerType ?? 'unknown');
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 100 },
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
              itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  optActivityOptions = computed<EChartsOption>(() => {
    const buckets: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const r of this.optsSample()) {
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

  topLifts = computed(() =>
    [...this.optsSample()]
      .filter((r) => r.bestHealthScore != null && r.baselineHealthScore != null)
      .sort(
        (a, b) =>
          (b.bestHealthScore ?? 0) -
          (b.baselineHealthScore ?? 0) -
          ((a.bestHealthScore ?? 0) - (a.baselineHealthScore ?? 0)),
      )
      .slice(0, 8),
  );

  perStrategyBreakdown = computed(() => {
    type Row = {
      strategyId: number;
      runs: number;
      completed: number;
      abandoned: number;
      avgIterations: number;
      bestLift: number | null;
      _iterSum: number;
    };
    const groups: Record<number, Row> = {};
    for (const r of this.optsSample()) {
      if (!groups[r.strategyId])
        groups[r.strategyId] = {
          strategyId: r.strategyId,
          runs: 0,
          completed: 0,
          abandoned: 0,
          avgIterations: 0,
          bestLift: null,
          _iterSum: 0,
        };
      const g = groups[r.strategyId];
      g.runs++;
      g._iterSum += r.iterations ?? 0;
      if (String(r.status) === 'Completed') g.completed++;
      else if (String(r.status) === 'Abandoned') g.abandoned++;
      if (r.bestHealthScore != null && r.baselineHealthScore != null) {
        const lift = r.bestHealthScore - r.baselineHealthScore;
        if (g.bestLift == null || lift > g.bestLift) g.bestLift = lift;
      }
    }
    return Object.values(groups)
      .map((g) => ({ ...g, avgIterations: g.runs > 0 ? g._iterSum / g.runs : 0 }))
      .sort((a, b) => b.runs - a.runs);
  });

  ngOnInit(): void {
    this.loadOptimizationsAnalyticsSample();
  }

  private loadOptimizationsAnalyticsSample(): void {
    this.service
      .listOptimizationRuns({ currentPage: 1, itemCountPerPage: 1, filter: null })
      .pipe(catchError(() => of(null)))
      .subscribe((probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.optsSample.set([]);
          return;
        }
        this.service
          .listOptimizationRuns({
            currentPage: 1,
            itemCountPerPage: Math.min(total, 5000),
            filter: null,
          })
          .pipe(catchError(() => of(null)))
          .subscribe((full) => {
            this.optsSample.set(full?.data?.data ?? []);
          });
      });
  }

  readonly triggerForm = this.fb.nonNullable.group({
    strategyId: [null as number | null, Validators.required],
    triggerType: ['Manual', Validators.required],
  });

  readonly columns: ColDef<OptimizationRunDto>[] = [
    { headerName: 'ID', field: 'id', width: 90 },
    { headerName: 'Strategy', field: 'strategyId', width: 110 },
    { headerName: 'Trigger', field: 'triggerType', width: 130 },
    { headerName: 'Iterations', field: 'iterations', width: 120 },
    {
      headerName: 'Baseline',
      field: 'baselineHealthScore',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Best',
      field: 'bestHealthScore',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 140,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Optimization status' },
    },
    {
      headerName: 'Started',
      field: 'startedAt',
      width: 170,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm') ?? '-',
    },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<OptimizationRunDto>> =>
    this.service
      .listOptimizationRuns(params)
      .pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  constructor() {
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe((res) => {
      this.strategies.set(res.data?.data ?? []);
    });
  }

  openCreate(): void {
    this.triggerForm.reset({ strategyId: null, triggerType: 'Manual' });
    this.dryRun.set(null);
    this.showCreate.set(true);
  }

  cancelCreate(): void {
    this.showCreate.set(false);
    this.dryRun.set(null);
  }

  loadDryRun(): void {
    const id = this.triggerForm.getRawValue().strategyId;
    if (id == null) {
      this.dryRun.set(null);
      return;
    }
    this.dryRunLoading.set(true);
    this.service
      .getOptimizationDryRun(id)
      .pipe(
        map((r) => r.data ?? null),
        catchError(() => of(null as OptimizationDryRunDto | null)),
      )
      .subscribe((data) => {
        this.dryRun.set(data);
        this.dryRunLoading.set(false);
      });
  }

  submitTrigger(): void {
    const v = this.triggerForm.getRawValue();
    if (v.strategyId == null) return;
    this.busy.set(true);
    const request: TriggerOptimizationRequest = {
      strategyId: v.strategyId,
      triggerType: v.triggerType,
    };
    this.service.triggerOptimization(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success('Optimization run queued');
          this.cancelCreate();
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to queue optimization');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  select(row: OptimizationRunDto): void {
    this.selected.set(row);
  }

  approve(): void {
    const run = this.selected();
    if (!run) return;
    this.detailBusy.set(true);
    this.service.approveOptimization(run.id).subscribe({
      next: (res) => {
        this.detailBusy.set(false);
        this.showApprove.set(false);
        if (res.status) {
          this.notifications.success(`Run #${run.id} approved — gradual rollout scheduled`);
          if (res.data) this.selected.set(res.data);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Approve failed');
        }
      },
      error: () => {
        this.detailBusy.set(false);
        this.showApprove.set(false);
      },
    });
  }

  reject(): void {
    const run = this.selected();
    if (!run) return;
    this.detailBusy.set(true);
    this.service.rejectOptimization(run.id).subscribe({
      next: (res) => {
        this.detailBusy.set(false);
        this.showReject.set(false);
        if (res.status) {
          this.notifications.success(`Run #${run.id} rejected`);
          if (res.data) this.selected.set(res.data);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Reject failed');
        }
      },
      error: () => {
        this.detailBusy.set(false);
        this.showReject.set(false);
      },
    });
  }

  formatJson(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
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
