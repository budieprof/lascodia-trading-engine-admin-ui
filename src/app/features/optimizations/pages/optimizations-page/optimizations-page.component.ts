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
import { formatDistanceToNow, parseISO } from 'date-fns';

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

/** Status colours shared by the mix panel, the boards and the runs table. */
const STATUS_COLOR: Record<string, string> = {
  Completed: '#34C759',
  Approved: '#AF52DE',
  Running: '#0071E3',
  Pending: '#5AC8FA',
  Queued: '#8E8E93',
  Abandoned: '#FF9500',
  Rejected: '#8E8E93',
  Cancelled: '#8E8E93',
  Failed: '#FF3B30',
};
/** Display order wherever statuses are listed side by side; unknown statuses follow. */
const STATUS_ORDER = Object.keys(STATUS_COLOR);

const TRIGGER_COLOR: Record<string, string> = {
  Manual: '#0071E3',
  Scheduled: '#5AC8FA',
  AutoDegrading: '#AF52DE',
};

/** The per-strategy board shows this many rows until "Show all" is pressed. */
const COLLAPSED_ROWS = 10;

const numberFmt = new Intl.NumberFormat('en-US');
const fmt = (n: number): string => numberFmt.format(n);

function relative(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

/** Cell-renderer strings go straight into innerHTML; data-derived text must be escaped. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// AG Grid cells sit outside this component's style scope, so the renderers style inline.
function statusPillHtml(status: unknown): string {
  if (status == null || status === '') return '';
  const s = String(status);
  const c = STATUS_COLOR[s] ?? '#8E8E93';
  return (
    `<span style="display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:999px;` +
    `background:${c}1f;color:${c};font-size:12px;font-weight:600;line-height:22px">` +
    `<span style="width:6px;height:6px;border-radius:50%;background:${c}"></span>${esc(s)}</span>`
  );
}

function idHtml(v: unknown): string {
  return `<span style="color:var(--text-tertiary);font-variant-numeric:tabular-nums">#${esc(String(v ?? ''))}</span>`;
}

/** Absolute UTC date with the year, and the relative time beneath it. */
function dateHtml(iso: string | null | undefined, abs: string): string {
  if (!iso) return `<span style="color:var(--text-tertiary)">—</span>`;
  return (
    `<span style="display:inline-block;vertical-align:middle;line-height:1.3">` +
    `<span style="font-variant-numeric:tabular-nums">${esc(abs)}</span><br/>` +
    `<span style="font-size:11px;color:var(--text-tertiary)">${esc(relative(iso))}</span></span>`
  );
}

const NUM_CELL = { fontVariantNumeric: 'tabular-nums' };

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

      @if (failureLoop(); as loop) {
        <!-- A run of failures is the single most important fact on this
             page and used to be invisible: the tiles painted "Completed 0"
             green and the donut was silently all red. -->
        <div class="notice bad" role="alert">
          <strong>
            {{ loop.failed }} of the last {{ loop.window }} optimization runs failed
          </strong>
          — {{ loop.strategies }} strateg{{ loop.strategies === 1 ? 'y' : 'ies' }}, most recent
          {{ loop.latestAt | date: 'MMM d, HH:mm' }}.
          @if (loop.topError) {
            Most common error: <code class="mono">{{ loop.topError }}</code>
          } @else {
            The runs recorded no error message; check the optimisation worker logs.
          }
        </div>
      }

      <!-- KPI strip — roll-ups over the analytics sample. The first tile names
           the window honestly (the sample is capped at 5,000 most-recent runs). -->
      <div class="dr-kpis">
        <div class="dr-kpi">
          <span class="kpi-label" [title]="windowLabel()">{{ windowLabel() }}</span>
          <span class="kpi-value">{{ fmt(optStats().total) }}</span>
          <span class="kpi-hint">across {{ fmt(optStats().strategiesCovered) }} strategies</span>
        </div>
        <div class="dr-kpi" [class.tone-info]="optStats().running > 0">
          <span class="kpi-label">Running</span>
          <span class="kpi-value">{{ fmt(optStats().running) }}</span>
          <span class="kpi-hint" [title]="latestStartAbs()">
            {{ latestStartRel() ? 'last start ' + latestStartRel() : 'no runs started' }}
          </span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Completed</span>
          <span class="kpi-value">{{ fmt(optStats().completed) }}</span>
          <span class="kpi-hint">{{ pct(optStats().completed, optStats().total) }} of runs</span>
        </div>
        <div class="dr-kpi" [class.tone-bad]="optStats().failed > 0">
          <span class="kpi-label">Failed</span>
          <span class="kpi-value">{{ fmt(optStats().failed) }}</span>
          <span class="kpi-hint">{{ pct(optStats().failed, optStats().total) }} of runs</span>
        </div>
        <div class="dr-kpi" [class.tone-warn]="optStats().abandoned > 0">
          <span class="kpi-label">Abandoned</span>
          <span class="kpi-value">{{ fmt(optStats().abandoned) }}</span>
          <span class="kpi-hint">{{ pct(optStats().abandoned, optStats().total) }} of runs</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Approved</span>
          <span class="kpi-value">{{ fmt(optStats().approved) }}</span>
          <span class="kpi-hint">
            {{
              optStats().completed > 0
                ? pct(optStats().approved, optStats().completed) + ' of completed'
                : 'nothing completed to approve'
            }}
          </span>
        </div>
        <div
          class="dr-kpi"
          [class.tone-bad]="optStats().failureRate !== null && optStats().failureRate! >= 50"
          [class.tone-warn]="
            optStats().failureRate !== null &&
            optStats().failureRate! > 0 &&
            optStats().failureRate! < 50
          "
        >
          <span class="kpi-label">Failure rate</span>
          <span class="kpi-value">
            {{ optStats().failureRate !== null ? optStats().failureRate!.toFixed(1) + '%' : '—' }}
          </span>
          <span class="kpi-hint">
            of {{ fmt(optStats().completed + optStats().failed + optStats().abandoned) }} finished
            runs
          </span>
        </div>
        <div
          class="dr-kpi"
          [class.tone-good]="optStats().avgLift !== null && optStats().avgLift! > 0"
          [class.tone-bad]="optStats().avgLift !== null && optStats().avgLift! < 0"
        >
          <span class="kpi-label">Avg lift (completed)</span>
          <span class="kpi-value">
            @if (optStats().avgLift !== null) {
              {{ optStats().avgLift! >= 0 ? '+' : '' }}{{ optStats().avgLift! | number: '1.3-3' }}
            } @else {
              —
            }
          </span>
          <span class="kpi-hint">
            @if (topLifts()[0]; as best) {
              best: #{{ best.id }} ({{ signedLift(best) }})
            } @else {
              no completed runs with a score
            }
          </span>
        </div>
      </div>

      <!-- Chart row: status mix + trigger mix + daily activity. The two mixes are
           HTML breakdowns rather than charts: a 99%-one-colour donut and a bar
           chart with a 3-run bar beside a 4,997-run bar said nothing a row of
           counts doesn't say better. -->
      <div class="dr-charts">
        <section class="mix-panel">
          <header class="mix-head">
            <h3>Status distribution</h3>
            <p>Share of runs by status in the window</p>
          </header>
          @if (statusMix().length > 0) {
            <div class="mix-body">
              <div class="mix-headline">
                <span class="mix-big">{{ fmt(optStats().total) }}</span>
                <span class="mix-big-label">runs</span>
              </div>
              <div class="mix-stack" role="img" [attr.aria-label]="mixLabel(statusMix())">
                @for (r of statusMix(); track r.name) {
                  <span
                    [style.width.%]="r.pct"
                    [style.background]="r.color"
                    [title]="r.name + ': ' + fmt(r.count)"
                  ></span>
                }
              </div>
              <ul class="mix-rows">
                @for (r of statusMix(); track r.name) {
                  <li>
                    <span class="dot" [style.background]="r.color"></span>
                    <span class="mix-name">{{ r.name }}</span>
                    <span class="mix-track">
                      <i [style.width.%]="r.pct" [style.background]="r.color"></i>
                    </span>
                    <span class="mix-count">{{ fmt(r.count) }}</span>
                    <span class="mix-pct">{{ pct(r.count, optStats().total) }}</span>
                  </li>
                }
              </ul>
            </div>
          } @else {
            <p class="mix-empty">No optimization runs yet.</p>
          }
        </section>
        <section class="mix-panel">
          <header class="mix-head">
            <h3>By trigger type</h3>
            <p>What queued the runs, and how many of each failed</p>
          </header>
          @if (triggerMix().length > 0) {
            <div class="mix-body">
              <div class="mix-headline">
                <span class="mix-big">{{ fmt(triggerMix().length) }}</span>
                <span class="mix-big-label"
                  >trigger type{{ triggerMix().length === 1 ? '' : 's' }}</span
                >
              </div>
              <div class="mix-stack" role="img" [attr.aria-label]="mixLabel(triggerMix())">
                @for (r of triggerMix(); track r.name) {
                  <span
                    [style.width.%]="r.pct"
                    [style.background]="r.color"
                    [title]="r.name + ': ' + fmt(r.count)"
                  ></span>
                }
              </div>
              <ul class="mix-rows">
                @for (r of triggerMix(); track r.name) {
                  <li>
                    <span class="dot" [style.background]="r.color"></span>
                    <span class="mix-name">
                      {{ r.name }}
                      <span class="mix-sub" [class.bad]="r.failed > 0">
                        {{ r.failed > 0 ? fmt(r.failed) + ' failed' : 'none failed' }}
                      </span>
                    </span>
                    <span class="mix-track">
                      <i [style.width.%]="r.pct" [style.background]="r.color"></i>
                    </span>
                    <span class="mix-count">{{ fmt(r.count) }}</span>
                    <span class="mix-pct">{{ pct(r.count, optStats().total) }}</span>
                  </li>
                }
              </ul>
            </div>
          } @else {
            <p class="mix-empty">No optimization runs yet.</p>
          }
        </section>
        <app-chart-card
          title="Activity (last 14 days)"
          subtitle="Daily optimization-run starts"
          [options]="optActivityOptions()"
          [emptyMessage]="activityEmpty()?.message ?? null"
          [emptyHint]="activityEmpty()?.hint ?? null"
          height="240px"
        />
      </div>

      <!-- 2-col tables: biggest lifts + per-strategy breakdown. With no lifts to rank the left
           panel is one sentence, so the per-strategy table takes the full width instead of
           clipping its last two columns in half the page. -->
      <div class="dr-board-row" [class.single]="topLifts().length === 0">
        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Biggest health-score lifts</h3>
            <span class="muted">Completed runs where the search beat the baseline the most</span>
          </header>
          @if (topLifts().length > 0) {
            <div class="board-scroll">
              <table class="dr-board-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Strategy</th>
                    <th class="num">Iter.</th>
                    <th class="num">Baseline</th>
                    <th class="num">Best</th>
                    <th class="num">Δ</th>
                    <th>Trigger</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of topLifts(); track r.id) {
                    <tr class="clickable" (click)="select(r)">
                      <td class="id">#{{ r.id }}</td>
                      <td class="name-cell" [title]="'Strategy #' + r.strategyId">
                        {{ strategyName(r.strategyId) }}
                      </td>
                      <td class="num">{{ r.iterations | number }}</td>
                      <td class="num">
                        {{
                          r.baselineHealthScore !== null
                            ? (r.baselineHealthScore | number: '1.3-3')
                            : '—'
                        }}
                      </td>
                      <td class="num">
                        {{
                          r.bestHealthScore !== null ? (r.bestHealthScore | number: '1.3-3') : '—'
                        }}
                      </td>
                      <td
                        class="num strong"
                        [class.pos]="(r.bestHealthScore ?? 0) > (r.baselineHealthScore ?? 0)"
                        [class.neg]="(r.bestHealthScore ?? 0) < (r.baselineHealthScore ?? 0)"
                      >
                        {{ signedLift(r) }}
                      </td>
                      <td class="dim-cell">{{ r.triggerType }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="muted board-empty">No completed runs with measurable lift yet.</p>
          }
        </section>

        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Per-strategy breakdown</h3>
            <span class="count-chip">{{ fmt(perStrategyBreakdown().length) }}</span>
            <span class="muted">Runs and outcomes grouped by strategy, most runs first</span>
          </header>
          @if (perStrategyBreakdown().length > 0) {
            <div class="board-scroll" [class.capped]="showAllStrategies()">
              <table class="dr-board-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th class="num">Runs</th>
                    @if (topLifts().length === 0) {
                      <th class="mix-col">Outcome</th>
                    }
                    <th class="num"><span class="dot ok"></span>Completed</th>
                    <th class="num"><span class="dot fail"></span>Failed</th>
                    <th class="num"><span class="dot warn"></span>Abandoned</th>
                    <th class="num" title="Average iterations per completed run">Avg iter.</th>
                    <th class="num">Best lift</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of visibleStrategies(); track row.strategyId) {
                    <tr>
                      <td class="name-cell" [title]="'Strategy #' + row.strategyId">
                        {{ strategyName(row.strategyId) }}
                      </td>
                      <td class="num strong">{{ fmt(row.runs) }}</td>
                      @if (topLifts().length === 0) {
                        <td class="mix-col">
                          <span class="mix-bar">
                            @if (row.completed > 0) {
                              <i class="ok" [style.width.%]="(row.completed / row.runs) * 100"></i>
                            }
                            @if (row.failed > 0) {
                              <i class="fail" [style.width.%]="(row.failed / row.runs) * 100"></i>
                            }
                            @if (row.abandoned > 0) {
                              <i
                                class="warn"
                                [style.width.%]="(row.abandoned / row.runs) * 100"
                              ></i>
                            }
                          </span>
                        </td>
                      }
                      <td
                        class="num"
                        [class.zero]="row.completed === 0"
                        [class.pos]="row.completed > 0"
                      >
                        {{ row.completed > 0 ? fmt(row.completed) : '–' }}
                      </td>
                      <td class="num" [class.zero]="row.failed === 0" [class.neg]="row.failed > 0">
                        {{ row.failed > 0 ? fmt(row.failed) : '–' }}
                      </td>
                      <td
                        class="num"
                        [class.zero]="row.abandoned === 0"
                        [class.warn]="row.abandoned > 0"
                      >
                        {{ row.abandoned > 0 ? fmt(row.abandoned) : '–' }}
                      </td>
                      <td class="num" [class.zero]="row.avgIterations === null">
                        {{ row.avgIterations !== null ? row.avgIterations.toFixed(1) : '–' }}
                      </td>
                      <td
                        class="num"
                        [class.zero]="row.bestLift === null"
                        [class.pos]="row.bestLift !== null && row.bestLift > 0"
                        [class.neg]="row.bestLift !== null && row.bestLift < 0"
                      >
                        @if (row.bestLift !== null) {
                          {{ row.bestLift >= 0 ? '+' : '' }}{{ row.bestLift | number: '1.3-3' }}
                        } @else {
                          –
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (perStrategyBreakdown().length > collapsedRows) {
              <footer class="board-foot" [class.raised]="showAllStrategies()">
                <span class="muted">
                  {{
                    showAllStrategies()
                      ? 'All ' +
                        fmt(perStrategyBreakdown().length) +
                        ' strategies · scroll the table'
                      : 'Top ' +
                        collapsedRows +
                        ' of ' +
                        fmt(perStrategyBreakdown().length) +
                        ' by run count'
                  }}
                </span>
                <button
                  type="button"
                  class="link-btn"
                  (click)="showAllStrategies.set(!showAllStrategies())"
                >
                  {{ showAllStrategies() ? 'Show top ' + collapsedRows : 'Show all' }}
                </button>
              </footer>
            }
          } @else {
            <p class="muted board-empty">No runs to group yet.</p>
          }
        </section>
      </div>

      <section class="dr-board">
        <header class="dr-board-head">
          <h3>All optimization runs</h3>
          <span class="count-chip">{{ fmt(optsTotal()) }}</span>
          <span class="muted head-right"
            >Server-paged · click any row for params + lift detail · UTC</span
          >
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
                <h3>Run #{{ r.id }} — {{ strategyName(r.strategyId) }}</h3>
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
        gap: var(--space-4);
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
        grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr));
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
      .notice {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .notice.bad {
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.32);
        color: #d70015;
      }
      .notice code {
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(255, 59, 48, 0.1);
        color: var(--text-primary);
        word-break: break-word;
      }
      /* ── Shared list-page look (same as Drift Report) ───────────── */
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
      }
      .dot.ok {
        background: #34c759;
      }
      .dot.fail {
        background: #ff3b30;
      }
      .dot.warn {
        background: #ff9500;
      }
      th .dot {
        width: 6px;
        height: 6px;
        margin-right: 5px;
        vertical-align: 1px;
      }

      /* KPI strip: two rows of four keep every label on one line. */
      .dr-kpis {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
      }
      @media (max-width: 720px) {
        .dr-kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .dr-kpi {
        --tone: var(--text-tertiary);
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 2px);
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .dr-kpi::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--tone);
        opacity: 0.35;
      }
      .dr-kpi.tone-bad {
        --tone: #d70015;
      }
      .dr-kpi.tone-warn {
        --tone: var(--warning);
      }
      .dr-kpi.tone-info {
        --tone: var(--accent);
      }
      .dr-kpi.tone-good {
        --tone: var(--profit);
      }
      .dr-kpi[class*='tone-']::before {
        opacity: 1;
      }
      .kpi-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-value {
        font-size: 26px;
        line-height: 1.2;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
        white-space: nowrap;
      }
      .tone-bad .kpi-value {
        color: #d70015;
      }
      .tone-warn .kpi-value {
        color: var(--warning);
      }
      .tone-good .kpi-value {
        color: var(--profit);
      }
      .kpi-hint {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-hint.warn {
        color: var(--warning);
        cursor: help;
      }

      /* Chart row */
      .dr-charts {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .dr-charts {
          grid-template-columns: 1fr;
        }
      }
      .mix-panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        min-width: 0;
      }
      .mix-head {
        margin-bottom: var(--space-4);
      }
      .mix-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .mix-head p {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .mix-body {
        height: 240px;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .mix-headline {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .mix-big {
        font-size: 30px;
        font-weight: var(--font-semibold);
        line-height: 1;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      .mix-big-label {
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .mix-stack {
        display: flex;
        height: 14px;
        border-radius: 7px;
        overflow: hidden;
        gap: 2px;
        background: var(--bg-tertiary);
      }
      .mix-stack span {
        display: block;
        min-width: 3px;
      }
      .mix-rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        overflow-y: auto;
      }
      .mix-rows li {
        display: grid;
        grid-template-columns: 8px minmax(84px, auto) 1fr 52px 40px;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .mix-name {
        display: flex;
        flex-direction: column;
        line-height: 1.25;
        white-space: nowrap;
      }
      .mix-sub {
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .mix-sub.bad {
        color: #d70015;
      }
      .mix-track {
        display: block;
        height: 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .mix-track i {
        display: block;
        height: 100%;
        min-width: 2px;
        border-radius: 3px;
      }
      .mix-count {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
      }
      .mix-pct {
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mix-empty {
        height: 240px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
      }

      /* Boards: start-aligned so a short board never stretches to its neighbour's height. */
      .dr-board-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: var(--space-3);
        align-items: start;
      }
      .dr-board-row.single {
        grid-template-columns: minmax(0, 1fr);
      }
      @media (max-width: 1100px) {
        .dr-board-row {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .dr-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        box-shadow: var(--shadow-sm);
        min-width: 0;
      }
      .dr-board-head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .dr-board-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      .head-right {
        margin-left: auto;
      }
      .count-chip {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        padding: 1px 8px;
      }
      .board-empty {
        margin: 0;
        padding: var(--space-5) var(--space-4);
      }
      .board-scroll {
        overflow-x: auto;
      }
      /* Expanded long boards scroll inside exactly twelve rows (33px head + 12 × 36px rows), so
         the cut always falls on a row boundary; the sticky head keeps the columns labelled. */
      .board-scroll.capped {
        max-height: 465px;
        overflow-y: auto;
      }
      .board-scroll.capped thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .dr-board-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .dr-board-table th,
      .dr-board-table td {
        height: 36px;
        padding: 0 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .dr-board-table th {
        height: 33px;
        background: var(--bg-primary);
        color: var(--text-tertiary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .dr-board-table th:first-child,
      .dr-board-table td:first-child {
        padding-left: var(--space-4);
      }
      .dr-board-table th:last-child,
      .dr-board-table td:last-child {
        padding-right: var(--space-4);
      }
      .dr-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .dr-board-table tbody tr:hover {
        background: var(--bg-primary);
      }
      .dr-board-table tr.clickable {
        cursor: pointer;
      }
      .dr-board-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        width: 1%;
      }
      .dr-board-table .id {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
        width: 1%;
      }
      .dr-board-table .sym {
        font-weight: var(--font-semibold);
      }
      .dr-board-table .dim-cell {
        color: var(--text-secondary);
      }
      .dr-board-table .name-cell {
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dr-board-table .strong {
        font-weight: var(--font-semibold);
      }
      .dr-board-table .zero {
        color: var(--text-tertiary);
        opacity: 0.6;
      }
      .dr-board-table .pos {
        color: var(--profit);
      }
      .dr-board-table .neg {
        color: var(--loss);
      }
      .dr-board-table .warn {
        color: #c93400;
      }
      .mix-col {
        width: 130px;
      }
      .mix-bar {
        display: flex;
        width: 110px;
        height: 8px;
        border-radius: 4px;
        overflow: hidden;
        background: var(--bg-tertiary);
        gap: 1px;
      }
      .mix-bar i {
        display: block;
        height: 100%;
      }
      .mix-bar .ok {
        background: #34c759;
      }
      .mix-bar .fail {
        background: #ff3b30;
      }
      .mix-bar .warn {
        background: #ff9500;
      }
      .board-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        border-top: 1px solid var(--border);
      }
      .board-foot.raised {
        box-shadow: 0 -8px 10px -8px rgba(0, 0, 0, 0.18);
        position: relative;
      }
      .link-btn {
        border: none;
        background: none;
        color: var(--accent);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: var(--radius-sm);
      }
      .link-btn:hover {
        background: rgba(0, 113, 227, 0.08);
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
        grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr));
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
  // via probe-and-fetch; capped at 5000 rows, and the first KPI label says
  // so whenever the server total is larger.
  private static readonly SAMPLE_CAP = 5000;
  readonly optsSample = signal<OptimizationRunDto[]>([]);
  readonly optsTotal = signal(0);
  readonly windowLabel = computed(() => {
    const sample = this.optsSample().length;
    const total = this.optsTotal();
    return total > sample && sample > 0
      ? `Runs (latest ${sample.toLocaleString('en-US')} of ${total.toLocaleString('en-US')})`
      : 'Total runs';
  });

  /** Strategy name for an id, falling back to "#id" until the list loads. */
  strategyName(id: number): string {
    const s = this.strategies().find((x) => x.id === id);
    return s?.name ? s.name : `#${id}`;
  }

  optStats = computed(() => {
    const all = this.optsSample();
    if (all.length === 0) {
      return {
        total: 0,
        running: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        approved: 0,
        failureRate: null as number | null,
        avgLift: null as number | null,
        strategiesCovered: 0,
      };
    }
    let running = 0;
    let completed = 0;
    let failed = 0;
    let abandoned = 0;
    let approved = 0;
    let liftSum = 0;
    let liftCount = 0;
    const strategies = new Set<number>();
    for (const r of all) {
      const status = String(r.status);
      // "Approved" is its own status on the wire (a completed run whose
      // parameters were adopted) — it still counts as a completed search.
      if (status === 'Running') running++;
      else if (status === 'Completed' || status === 'Approved') completed++;
      else if (status === 'Failed') failed++;
      else if (status === 'Abandoned') abandoned++;
      if (status === 'Approved' || r.approvedAt) approved++;
      strategies.add(r.strategyId);
      if (
        (status === 'Completed' || status === 'Approved') &&
        r.bestHealthScore != null &&
        r.baselineHealthScore != null
      ) {
        liftSum += r.bestHealthScore - r.baselineHealthScore;
        liftCount++;
      }
    }
    const finished = completed + failed + abandoned;
    return {
      total: all.length,
      running,
      completed,
      failed,
      abandoned,
      approved,
      failureRate: finished > 0 ? +((failed / finished) * 100).toFixed(1) : null,
      avgLift: liftCount > 0 ? +(liftSum / liftCount).toFixed(3) : null,
      strategiesCovered: strategies.size,
    };
  });

  /**
   * Detects a failure loop in the most recent runs. The threshold is
   * deliberately high (80% of the last 10) so a single flaky run does not
   * shout, while the observed "every run fails, in batches" pattern does.
   */
  readonly failureLoop = computed(() => {
    const window = 10;
    const recent = [...this.optsSample()]
      .filter((r) => !!r.startedAt)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, window);
    if (recent.length < 5) return null;
    const failedRuns = recent.filter((r) => String(r.status) === 'Failed');
    if (failedRuns.length < Math.ceil(recent.length * 0.8)) return null;
    const errors = new Map<string, number>();
    for (const r of failedRuns) {
      const key = (r.errorMessage ?? '').trim().slice(0, 160);
      if (key) errors.set(key, (errors.get(key) ?? 0) + 1);
    }
    const topError = [...errors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      failed: failedRuns.length,
      window: recent.length,
      strategies: new Set(failedRuns.map((r) => r.strategyId)).size,
      latestAt: failedRuns[0].startedAt,
      topError,
    };
  });

  readonly fmt = fmt;
  readonly collapsedRows = COLLAPSED_ROWS;
  readonly showAllStrategies = signal(false);

  /** Runs per status, in display order — the "Status distribution" breakdown. */
  readonly statusMix = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.optsSample()) {
      const k = String(r.status);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const total = this.optsSample().length;
    const rank = (k: string) => {
      const i = STATUS_ORDER.indexOf(k);
      return i < 0 ? STATUS_ORDER.length : i;
    };
    return [...counts.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        pct: total > 0 ? (count / total) * 100 : 0,
        color: STATUS_COLOR[name] ?? '#8E8E93',
      }));
  });

  /** Runs per trigger type, most first, with how many of each failed. */
  readonly triggerMix = computed(() => {
    const groups = new Map<string, { count: number; failed: number }>();
    for (const r of this.optsSample()) {
      const k = String(r.triggerType ?? 'unknown');
      const g = groups.get(k) ?? { count: 0, failed: 0 };
      g.count++;
      if (String(r.status) === 'Failed') g.failed++;
      groups.set(k, g);
    }
    const total = this.optsSample().length;
    return [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, g]) => ({
        name,
        count: g.count,
        failed: g.failed,
        pct: total > 0 ? (g.count / total) * 100 : 0,
        color: TRIGGER_COLOR[name] ?? '#8E8E93',
      }));
  });

  private readonly latestStart = computed(() => {
    let latest: string | null = null;
    let latestMs = 0;
    for (const r of this.optsSample()) {
      const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
      if (Number.isFinite(t) && t > latestMs) {
        latestMs = t;
        latest = r.startedAt;
      }
    }
    return latest;
  });
  readonly latestStartRel = computed(() => relative(this.latestStart()));
  readonly latestStartAbs = computed(() => {
    const iso = this.latestStart();
    return iso ? `${this.datePipe.transform(iso, 'MMM d, yyyy HH:mm', 'UTC')} UTC` : '';
  });

  pct(n: number, total: number): string {
    if (total <= 0) return '0%';
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? '<1%' : p < 100 && p > 99 ? '>99%' : `${p.toFixed(0)}%`;
  }

  mixLabel(rows: { name: string; count: number }[]): string {
    return rows.map((r) => `${r.name} ${fmt(r.count)}`).join(' · ');
  }

  /** "+0.123" / "−0.045" / "—": best minus baseline health score. */
  signedLift(r: OptimizationRunDto): string {
    if (r.bestHealthScore == null || r.baselineHealthScore == null) return '—';
    const d = r.bestHealthScore - r.baselineHealthScore;
    return `${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
  }

  optActivityOptions = computed<EChartsOption>(() => {
    // UTC days on both sides: local midnight through toISOString() keyed east-of-UTC browsers one
    // day back, so a run started today (UTC) fell outside every bucket.
    const buckets: Record<string, number> = {};
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
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

  /** Why the activity chart is blank — an empty axis box read as "still loading". */
  readonly activityEmpty = computed<{ message: string; hint: string | null } | null>(() => {
    const opts = this.optActivityOptions();
    if (Object.keys(opts).length > 0) return null;
    const sample = this.optsSample();
    if (sample.length === 0) return null;
    let latest = 0;
    for (const r of sample) {
      const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
      if (Number.isFinite(t) && t > latest) latest = t;
    }
    return {
      message: 'No runs started in the last 14 days',
      hint: latest > 0 ? `Latest start: ${new Date(latest).toISOString().slice(0, 10)} UTC` : null,
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
      failed: number;
      abandoned: number;
      avgIterations: number | null;
      bestLift: number | null;
      _iterSum: number;
      _iterCount: number;
    };
    const groups: Record<number, Row> = {};
    for (const r of this.optsSample()) {
      if (!groups[r.strategyId])
        groups[r.strategyId] = {
          strategyId: r.strategyId,
          runs: 0,
          completed: 0,
          failed: 0,
          abandoned: 0,
          avgIterations: null,
          bestLift: null,
          _iterSum: 0,
          _iterCount: 0,
        };
      const g = groups[r.strategyId];
      const status = String(r.status);
      g.runs++;
      // Failed runs die at iteration 0 — averaging them in reports the crash
      // rate, not how long a search runs.
      if (status === 'Completed' || status === 'Approved') {
        g.completed++;
        g._iterSum += r.iterations ?? 0;
        g._iterCount++;
      } else if (status === 'Failed') g.failed++;
      else if (status === 'Abandoned') g.abandoned++;
      if (r.bestHealthScore != null && r.baselineHealthScore != null) {
        const lift = r.bestHealthScore - r.baselineHealthScore;
        if (g.bestLift == null || lift > g.bestLift) g.bestLift = lift;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        avgIterations: g._iterCount > 0 ? g._iterSum / g._iterCount : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  readonly visibleStrategies = computed(() => {
    const rows = this.perStrategyBreakdown();
    return this.showAllStrategies() ? rows : rows.slice(0, COLLAPSED_ROWS);
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
        this.optsTotal.set(total);
        if (total === 0) {
          this.optsSample.set([]);
          return;
        }
        this.service
          .listOptimizationRuns({
            currentPage: 1,
            itemCountPerPage: Math.min(total, OptimizationsPageComponent.SAMPLE_CAP),
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

  // Cell renderers return HTML strings rendered by AG Grid outside this component's style
  // scope, so they style inline. Strategy is the one flexible column; the rest are sized to
  // header + widest value so no column is left as a wide empty band.
  readonly columns: ColDef<OptimizationRunDto>[] = [
    {
      headerName: 'ID',
      field: 'id',
      width: 90,
      cellRenderer: (p: { value: number }) => idHtml(p.value),
    },
    {
      headerName: 'Strategy',
      field: 'strategyId',
      flex: 1,
      minWidth: 180,
      valueFormatter: (p) => this.strategyName(p.value as number),
      tooltipValueGetter: (p) => `Strategy #${p.value}`,
      cellStyle: { fontWeight: '600' },
    },
    {
      headerName: 'Trigger',
      field: 'triggerType',
      width: 140,
      cellStyle: { color: 'var(--text-secondary)' },
    },
    {
      headerName: 'Iterations',
      field: 'iterations',
      width: 110,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => (p.value as number).toLocaleString('en-US'),
    },
    {
      headerName: 'Baseline',
      field: 'baselineHealthScore',
      width: 110,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => (p.value as number | null)?.toFixed(2) ?? '—',
    },
    {
      headerName: 'Best',
      field: 'bestHealthScore',
      width: 110,
      type: 'rightAligned',
      // Green/red against the run's own baseline: the lift is the point of the search.
      cellStyle: (p) => {
        const best = p.value as number | null;
        const base = p.data?.baselineHealthScore ?? null;
        const color =
          best == null || base == null
            ? null
            : best > base
              ? 'var(--profit)'
              : best < base
                ? 'var(--loss)'
                : null;
        return color ? { ...NUM_CELL, color } : NUM_CELL;
      },
      valueFormatter: (p) => (p.value as number | null)?.toFixed(2) ?? '—',
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 140,
      cellRenderer: (p: { value: unknown }) => statusPillHtml(p.value),
    },
    {
      headerName: 'Started (UTC)',
      field: 'startedAt',
      width: 190,
      cellRenderer: (p: { value: string | null }) =>
        dateHtml(p.value, this.datePipe.transform(p.value, 'MMM d, yyyy HH:mm', 'UTC') ?? '—'),
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
