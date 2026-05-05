import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
// DatePipe + DecimalPipe instantiated directly in the class for column valueFormatters; no template pipes used.
import { Observable, map, merge, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { WalkForwardService } from '@core/services/walk-forward.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  CreateWalkForwardRequest,
  PagedData,
  PagerRequest,
  StrategyDto,
  Timeframe,
  WalkForwardRunDto,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';

@Component({
  selector: 'app-walk-forward-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    ChartCardComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
  ],
  template: `
    <div class="page">
      <app-page-header title="Walk-Forward" subtitle="Out-of-sample validation runs">
        <button type="button" class="btn btn-primary" (click)="togglePanel()">
          {{ showCreatePanel() ? 'Close' : 'Queue Run' }}
        </button>
      </app-page-header>

      @if (showCreatePanel()) {
        <form class="panel" [formGroup]="form" (ngSubmit)="submit()">
          <div class="panel-head">
            <h3>Queue Walk-Forward Run</h3>
            <button type="button" class="close" (click)="togglePanel()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field label="Strategy" [required]="true" [control]="form.controls.strategyId">
              <select appFormFieldControl formControlName="strategyId">
                <option [ngValue]="null">Select a strategy…</option>
                @for (s of strategies(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }} ({{ s.symbol }} {{ s.timeframe }})</option>
                }
              </select>
            </app-form-field>
            <app-form-field label="Symbol" [required]="true" [control]="form.controls.symbol">
              <input appFormFieldControl formControlName="symbol" placeholder="EURUSD" />
            </app-form-field>
            <app-form-field label="Timeframe" [required]="true" [control]="form.controls.timeframe">
              <select appFormFieldControl formControlName="timeframe">
                <option value="M1">M1</option>
                <option value="M5">M5</option>
                <option value="M15">M15</option>
                <option value="H1">H1</option>
                <option value="H4">H4</option>
                <option value="D1">D1</option>
              </select>
            </app-form-field>
            <app-form-field label="From" [required]="true" [control]="form.controls.fromDate">
              <input appFormFieldControl formControlName="fromDate" type="date" />
            </app-form-field>
            <app-form-field label="To" [required]="true" [control]="form.controls.toDate">
              <input appFormFieldControl formControlName="toDate" type="date" />
            </app-form-field>
            <app-form-field
              label="In-Sample Days"
              [required]="true"
              [control]="form.controls.inSampleDays"
            >
              <input appFormFieldControl formControlName="inSampleDays" type="number" min="1" />
            </app-form-field>
            <app-form-field
              label="OOS Days"
              [required]="true"
              [control]="form.controls.outOfSampleDays"
            >
              <input appFormFieldControl formControlName="outOfSampleDays" type="number" min="1" />
            </app-form-field>
            <app-form-field
              label="Initial Balance"
              [required]="true"
              [control]="form.controls.initialBalance"
            >
              <input
                appFormFieldControl
                formControlName="initialBalance"
                type="number"
                min="1"
                step="100"
              />
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="togglePanel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy() || form.invalid">
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Queue
                }
              </button>
            </div>
          </div>
        </form>
      }

      <!-- 8-card KPI strip — fleet-wide walk-forward posture -->
      <div class="wf-kpis">
        <div class="wf-kpi">
          <span class="kpi-label">Total runs</span>
          <span class="kpi-value">{{ wfStats().total }}</span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Completed</span>
          <span class="kpi-value good">{{ wfStats().completed }}</span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Failed</span>
          <span
            class="kpi-value"
            [class.bad]="wfStats().failed > 0"
            [class.good]="wfStats().failed === 0"
          >
            {{ wfStats().failed }}
          </span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Avg OOS score</span>
          <span class="kpi-value">
            {{ wfStats().avgOos !== null ? (wfStats().avgOos! * 100).toFixed(1) + '%' : '—' }}
          </span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Best OOS</span>
          <span class="kpi-value good">
            {{ wfStats().bestOos !== null ? (wfStats().bestOos! * 100).toFixed(1) + '%' : '—' }}
          </span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Avg consistency</span>
          <span class="kpi-value">
            {{ wfStats().avgConsistency !== null ? wfStats().avgConsistency!.toFixed(3) : '—' }}
          </span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Avg IS days</span>
          <span class="kpi-value">{{ wfStats().avgIs }}</span>
        </div>
        <div class="wf-kpi">
          <span class="kpi-label">Avg OOS days</span>
          <span class="kpi-value">{{ wfStats().avgOosDays }}</span>
        </div>
      </div>

      <!-- 3-col chart row -->
      <div class="wf-charts">
        <app-chart-card
          title="Status distribution"
          subtitle="Completed · Failed · Running · Pending"
          [options]="statusDonutOptions()"
          height="240px"
        />
        <app-chart-card
          title="OOS score distribution"
          subtitle="Histogram of avg out-of-sample scores"
          [options]="oosHistogramOptions()"
          height="240px"
        />
        <app-chart-card
          title="Runs by symbol"
          subtitle="Top 12 symbols by run count"
          [options]="bySymbolOptions()"
          height="240px"
        />
      </div>

      <!-- 2-col tables: top performers + per-strategy breakdown -->
      <div class="wf-board-row">
        <section class="wf-board">
          <header class="wf-board-head">
            <h3>Top performers</h3>
            <span class="muted">Highest avg OOS score across completed runs</span>
          </header>
          @if (topOos().length > 0) {
            <table class="wf-board-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Strategy</th>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th class="num">Avg OOS</th>
                  <th class="num">Consistency</th>
                  <th class="num">IS / OOS</th>
                </tr>
              </thead>
              <tbody>
                @for (r of topOos(); track r.id) {
                  <tr (click)="goToDetail(r)">
                    <td class="mono">#{{ r.id }}</td>
                    <td class="mono">#{{ r.strategyId }}</td>
                    <td class="mono">{{ r.symbol }}</td>
                    <td class="mono">{{ r.timeframe }}</td>
                    <td class="num mono profit">
                      {{
                        r.averageOutOfSampleScore !== null
                          ? (r.averageOutOfSampleScore * 100).toFixed(1) + '%'
                          : '—'
                      }}
                    </td>
                    <td class="num mono">
                      {{ r.scoreConsistency !== null ? r.scoreConsistency.toFixed(3) : '—' }}
                    </td>
                    <td class="num mono">{{ r.inSampleDays }} / {{ r.outOfSampleDays }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted" style="padding: var(--space-4)">
              No completed runs with OOS scores yet.
            </p>
          }
        </section>

        <section class="wf-board">
          <header class="wf-board-head">
            <h3>Per-strategy breakdown</h3>
            <span class="muted">
              Outcomes grouped by strategy id ·
              {{ perStrategyBreakdown().length }} total
            </span>
          </header>
          @if (perStrategyBreakdown().length > 0) {
            <div class="wf-scroll">
              <table class="wf-board-table sticky-head">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th class="num">Runs</th>
                    <th class="num">Completed</th>
                    <th class="num">Failed</th>
                    <th class="num">Avg OOS</th>
                    <th class="num">Best OOS</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of perStrategyBreakdown(); track row.strategyId) {
                    <tr>
                      <td class="mono">#{{ row.strategyId }}</td>
                      <td class="num mono">{{ row.runs }}</td>
                      <td class="num mono profit">{{ row.completed }}</td>
                      <td class="num mono" [class.bad]="row.failed > 0">{{ row.failed }}</td>
                      <td class="num mono">
                        {{ row.avgOos !== null ? (row.avgOos * 100).toFixed(1) + '%' : '—' }}
                      </td>
                      <td class="num mono profit">
                        {{ row.bestOos !== null ? (row.bestOos * 100).toFixed(1) + '%' : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      </div>

      <section class="wf-board">
        <header class="wf-board-head">
          <h3>All walk-forward runs</h3>
          <span class="muted">Server-paged — click any row for the detail page</span>
        </header>
        <app-data-table
          #runsTable
          [columnDefs]="columnDefs"
          [fetchData]="fetch"
          [searchable]="true"
          (rowClick)="goToDetail($event)"
        />
      </section>
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
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
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
        min-width: 180px;
        flex: 1 1 180px;
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

      /* Walk-Forward density additions */
      .wf-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .wf-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .wf-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .wf-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .kpi-value.good {
        color: var(--profit);
      }
      .kpi-value.bad {
        color: var(--loss);
      }

      .wf-charts {
        display: grid;
        grid-template-columns: 1fr 1.2fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .wf-charts {
          grid-template-columns: 1fr;
        }
      }

      .wf-board-row {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .wf-board-row {
          grid-template-columns: 1fr;
        }
      }

      .wf-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .wf-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .wf-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .wf-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .wf-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .wf-board-table th,
      .wf-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .wf-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .wf-board-table tbody tr {
        cursor: pointer;
        transition: background 0.1s;
      }
      .wf-board-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .wf-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .wf-board-table th.num,
      .wf-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .wf-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .wf-board-table .profit {
        color: var(--profit);
      }
      .wf-board-table .loss {
        color: var(--loss);
      }
      .wf-board-table .bad {
        color: var(--loss);
      }

      /* Cap tall breakdown tables; sticky header keeps the columns labelled
         while the operator scrolls through 100+ strategies. */
      .wf-scroll {
        max-height: 360px;
        overflow-y: auto;
      }
      .wf-board-table.sticky-head thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class WalkForwardPageComponent implements OnInit {
  private readonly service = inject(WalkForwardService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly realtime = inject(RealtimeService);
  private readonly decimalPipe = new DecimalPipe('en-US');
  private readonly datePipe = new DatePipe('en-US');

  private readonly runsTable = viewChild<DataTableComponent<WalkForwardRunDto>>('runsTable');

  readonly busy = signal(false);
  readonly showCreatePanel = signal(false);
  readonly strategies = signal<StrategyDto[]>([]);

  // Analytics sample — probe-and-fetch capped at 5000.
  readonly wfSample = signal<WalkForwardRunDto[]>([]);

  wfStats = computed(() => {
    const all = this.wfSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        avgOos: null as number | null,
        bestOos: null as number | null,
        avgConsistency: null as number | null,
        avgIs: 0,
        avgOosDays: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let oosSum = 0;
    let oosCount = 0;
    let bestOos = -Infinity;
    let consSum = 0;
    let consCount = 0;
    let isSum = 0;
    let oosDaysSum = 0;
    for (const r of all) {
      const status = String(r.status);
      if (status === 'Completed') completed++;
      else if (status === 'Failed') failed++;
      if (r.averageOutOfSampleScore != null) {
        oosSum += r.averageOutOfSampleScore;
        oosCount++;
        if (r.averageOutOfSampleScore > bestOos) bestOos = r.averageOutOfSampleScore;
      }
      if (r.scoreConsistency != null) {
        consSum += r.scoreConsistency;
        consCount++;
      }
      isSum += r.inSampleDays ?? 0;
      oosDaysSum += r.outOfSampleDays ?? 0;
    }
    return {
      total: all.length,
      completed,
      failed,
      avgOos: oosCount > 0 ? +(oosSum / oosCount).toFixed(4) : null,
      bestOos: bestOos === -Infinity ? null : +bestOos.toFixed(4),
      avgConsistency: consCount > 0 ? +(consSum / consCount).toFixed(3) : null,
      avgIs: Math.round(isSum / all.length),
      avgOosDays: Math.round(oosDaysSum / all.length),
    };
  });

  statusDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.wfSample()) {
      const k = String(r.status);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    if (Object.keys(counts).length === 0) return {};
    const colors: Record<string, string> = {
      Completed: '#34C759',
      Failed: '#FF3B30',
      Running: '#0071E3',
      Pending: '#5AC8FA',
    };
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
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

  oosHistogramOptions = computed<EChartsOption>(() => {
    const scores = this.wfSample()
      .filter((r) => r.averageOutOfSampleScore != null)
      .map((r) => (r.averageOutOfSampleScore ?? 0) * 100);
    if (scores.length === 0) return {};
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    if (max === min) {
      return {
        grid: { top: 10, right: 20, bottom: 30, left: 40 },
        xAxis: { type: 'category', data: [`${min.toFixed(0)}%`] },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'bar',
            data: [{ value: scores.length, itemStyle: { color: '#0071E3' } }],
            barWidth: '40%',
          },
        ],
      };
    }
    const bins = 12;
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    const labels: string[] = [];
    for (let i = 0; i < bins; i++) labels.push(`${(min + i * width).toFixed(0)}%`);
    for (const v of scores) {
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
          data: counts.map((c) => ({
            value: c,
            itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  bySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.wfSample()) {
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
              itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  topOos = computed(() =>
    [...this.wfSample()]
      .filter((r) => r.averageOutOfSampleScore != null)
      .sort((a, b) => (b.averageOutOfSampleScore ?? 0) - (a.averageOutOfSampleScore ?? 0))
      .slice(0, 8),
  );

  perStrategyBreakdown = computed(() => {
    type Row = {
      strategyId: number;
      runs: number;
      completed: number;
      failed: number;
      avgOos: number | null;
      bestOos: number | null;
      _oosSum: number;
      _oosCount: number;
    };
    const groups: Record<number, Row> = {};
    for (const r of this.wfSample()) {
      if (!groups[r.strategyId])
        groups[r.strategyId] = {
          strategyId: r.strategyId,
          runs: 0,
          completed: 0,
          failed: 0,
          avgOos: null,
          bestOos: null,
          _oosSum: 0,
          _oosCount: 0,
        };
      const g = groups[r.strategyId];
      g.runs++;
      const status = String(r.status);
      if (status === 'Completed') g.completed++;
      else if (status === 'Failed') g.failed++;
      if (r.averageOutOfSampleScore != null) {
        g._oosSum += r.averageOutOfSampleScore;
        g._oosCount++;
        if (g.bestOos == null || r.averageOutOfSampleScore > g.bestOos)
          g.bestOos = r.averageOutOfSampleScore;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        avgOos: g._oosCount > 0 ? +(g._oosSum / g._oosCount).toFixed(4) : null,
        bestOos: g.bestOos != null ? +g.bestOos.toFixed(4) : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  readonly form = this.fb.nonNullable.group({
    strategyId: [null as number | null, Validators.required],
    symbol: ['EURUSD', Validators.required],
    timeframe: ['H1' as Timeframe, Validators.required],
    fromDate: ['', Validators.required],
    toDate: ['', Validators.required],
    inSampleDays: [90, [Validators.required, Validators.min(1)]],
    outOfSampleDays: [30, [Validators.required, Validators.min(1)]],
    initialBalance: [10000, [Validators.required, Validators.min(1)]],
  });

  readonly columnDefs: ColDef<WalkForwardRunDto>[] = [
    { field: 'id', headerName: 'Run', width: 90 },
    { field: 'strategyId', headerName: 'Strategy', width: 100 },
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    {
      field: 'fromDate',
      headerName: 'From',
      width: 120,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, yyyy') ?? '-',
    },
    {
      field: 'toDate',
      headerName: 'To',
      width: 120,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, yyyy') ?? '-',
    },
    {
      field: 'averageOutOfSampleScore',
      headerName: 'Avg OOS',
      width: 110,
      valueFormatter: (p) => this.decimalPipe.transform(p.value as number, '1.2-2') ?? '-',
    },
    {
      field: 'scoreConsistency',
      headerName: 'Consistency',
      width: 120,
      valueFormatter: (p) => this.decimalPipe.transform(p.value as number, '1.2-2') ?? '-',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Walk-forward status' },
    },
    {
      field: 'startedAt',
      headerName: 'Started',
      width: 150,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm') ?? '-',
    },
  ];

  readonly fetch = (params: PagerRequest): Observable<PagedData<WalkForwardRunDto>> =>
    this.service.list(params).pipe(map((res) => res.data ?? { pager: emptyPager(), data: [] }));

  constructor() {
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe((res) => {
      this.strategies.set(res.data?.data ?? []);
    });

    // Walk-forward runs are fulfilled by a sequence of backtest windows under
    // the hood, so both `backtestCompleted` and `optimizationCompleted` events
    // indicate list-affecting progress (status flips, avg OOS score, etc.).
    // Throttle at 5s — a completed walk-forward fires many backtest events in
    // quick succession as each window finishes, and we only need one reload.
    merge(this.realtime.on('backtestCompleted'), this.realtime.on('optimizationCompleted'))
      .pipe(throttleTime(5_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.runsTable()?.loadData();
        this.loadAnalyticsSample();
      });
  }

  ngOnInit(): void {
    this.loadAnalyticsSample();
  }

  private loadAnalyticsSample(): void {
    this.service.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.wfSample.set([]);
          return;
        }
        this.service
          .list({ currentPage: 1, itemCountPerPage: Math.min(total, 5000), filter: null })
          .subscribe({
            next: (full) => this.wfSample.set(full?.data?.data ?? []),
          });
      },
    });
  }

  togglePanel(): void {
    this.showCreatePanel.update((v) => !v);
  }

  submit(): void {
    const v = this.form.getRawValue();
    if (v.strategyId == null) return;
    const request: CreateWalkForwardRequest = {
      strategyId: v.strategyId,
      symbol: v.symbol,
      timeframe: v.timeframe,
      fromDate: v.fromDate,
      toDate: v.toDate,
      inSampleDays: v.inSampleDays,
      outOfSampleDays: v.outOfSampleDays,
      initialBalance: v.initialBalance,
    };
    this.busy.set(true);
    this.service.create(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status && res.data) {
          this.notifications.success(`Walk-forward run #${res.data.id} queued`);
          this.showCreatePanel.set(false);
          this.loadAnalyticsSample();
          this.router.navigate(['/walk-forward', res.data.id]);
        } else {
          this.notifications.error(res.message ?? 'Failed to queue walk-forward run');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  goToDetail(row: WalkForwardRunDto): void {
    if (row?.id != null) this.router.navigate(['/walk-forward', row.id]);
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
