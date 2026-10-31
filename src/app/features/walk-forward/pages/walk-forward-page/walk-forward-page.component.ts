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
import { formatDistanceToNow, parseISO } from 'date-fns';

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
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';
import { analyticsSampleSize, newestRowsRequest } from '@features/backtests/analytics-sample';

/** Status colours shared by the mix panel and the runs table. */
const STATUS_COLOR: Record<string, string> = {
  Completed: '#34C759',
  Running: '#0071E3',
  Pending: '#5AC8FA',
  Queued: '#8E8E93',
  Cancelled: '#8E8E93',
  Abandoned: '#FF9500',
  Failed: '#FF3B30',
};
/** Display order wherever statuses are listed side by side; unknown statuses follow. */
const STATUS_ORDER = Object.keys(STATUS_COLOR);

/** The per-strategy board shows this many rows (the leaderboard's height) until "Show all". */
const COLLAPSED_ROWS = 8;

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

/** Tabular number cell, green/red by sign — for the OOS Sharpe column. */
function signedStyle(v: unknown): Record<string, string> {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return n > 0
    ? { ...NUM_CELL, color: 'var(--profit)' }
    : n < 0
      ? { ...NUM_CELL, color: 'var(--loss)' }
      : NUM_CELL;
}

@Component({
  selector: 'app-walk-forward-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    ChartCardComponent,
    ErrorStateComponent,
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

      @if (sampleFailed()) {
        <app-error-state
          title="Could not load walk-forward analytics"
          message="The walk-forward list endpoint returned an error — the tiles and charts below are unknown, not zero."
          (retry)="loadAnalyticsSample()"
        />
      }
      @if (wfStats().wipedOut > 0) {
        <p class="wiped-note">
          {{ wfStats().wipedOut }} run{{ wfStats().wipedOut === 1 ? '' : 's' }} with a corrupt OOS
          Sharpe (not a finite number, or beyond ±100) are excluded from the OOS averages, best
          scores and histogram below. They still count toward run totals.
        </p>
      }
      @if (ready() && sampleTotal() > wfSample().length) {
        <p class="wiped-note">
          Tiles, charts and breakdowns cover the newest {{ fmtInt(wfSample().length) }} of
          {{ fmtInt(sampleTotal()) }} runs — a full sample would be too large to fetch. The table
          below pages through all of them.
        </p>
      }
      <!-- KPI strip — fleet-wide walk-forward posture. "—" until the sample lands: a row of
           zeros beside a table of 2,973 runs read as "no runs". Tones carry meaning only:
           failures red, Sharpe by sign. -->
      <div class="dr-kpis">
        <div class="dr-kpi">
          <span class="kpi-label">Total runs</span>
          <span class="kpi-value">{{ ready() ? fmtInt(sampleTotal()) : '—' }}</span>
          <span class="kpi-hint" [title]="latestStart().abs">
            {{ latestStart().rel ? 'latest started ' + latestStart().rel : 'none started yet' }}
          </span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Completed</span>
          <span class="kpi-value">{{ ready() ? fmtInt(wfStats().completed) : '—' }}</span>
          <span class="kpi-hint">{{ pct(wfStats().completed, wfStats().total) }} of runs</span>
        </div>
        <div class="dr-kpi" [class.tone-bad]="ready() && wfStats().failed > 0">
          <span class="kpi-label">Failed</span>
          <span class="kpi-value">{{ ready() ? fmtInt(wfStats().failed) : '—' }}</span>
          <span class="kpi-hint">{{ pct(wfStats().failed, wfStats().total) }} of runs</span>
        </div>
        <div
          class="dr-kpi"
          [class.tone-good]="wfStats().avgOos !== null && wfStats().avgOos! > 0"
          [class.tone-bad]="wfStats().avgOos !== null && wfStats().avgOos! < 0"
        >
          <span class="kpi-label" title="Mean out-of-sample Sharpe ratio across each run's windows"
            >Avg OOS Sharpe</span
          >
          <span class="kpi-value">{{ sharpe(wfStats().avgOos) }}</span>
          <span class="kpi-hint">over {{ fmtInt(scoredRuns()) }} scored completed runs</span>
        </div>
        <div
          class="dr-kpi"
          [class.tone-good]="wfStats().bestOos !== null && wfStats().bestOos! > 0"
          [class.tone-bad]="wfStats().bestOos !== null && wfStats().bestOos! < 0"
        >
          <span class="kpi-label">Best OOS Sharpe</span>
          <span class="kpi-value">{{ sharpe(wfStats().bestOos) }}</span>
          <span class="kpi-hint">
            @if (topOos()[0]; as b) {
              best: #{{ b.id }} · {{ b.symbol ?? '—' }} {{ b.timeframe }}
            } @else {
              no scored runs yet
            }
          </span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Avg consistency</span>
          <span class="kpi-value">
            {{ wfStats().avgConsistency !== null ? wfStats().avgConsistency!.toFixed(3) : '—' }}
          </span>
          <span class="kpi-hint">σ of window Sharpes · lower = steadier</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Avg IS days</span>
          <span class="kpi-value">{{ ready() ? fmtInt(wfStats().avgIs) : '—' }}</span>
          <span class="kpi-hint">in-sample window length</span>
        </div>
        <div class="dr-kpi">
          <span class="kpi-label">Avg OOS days</span>
          <span class="kpi-value">{{ ready() ? fmtInt(wfStats().avgOosDays) : '—' }}</span>
          <span class="kpi-hint">out-of-sample window length</span>
        </div>
      </div>

      <!-- 3-col chart row: status breakdown + OOS Sharpe histogram + runs by symbol -->
      <div class="dr-charts">
        <section class="mix-panel">
          <header class="mix-head">
            <h3>Status distribution</h3>
            <p>Share of sampled runs by status</p>
          </header>
          @if (statusMix().length > 0) {
            <div class="mix-body">
              <div class="mix-headline">
                <span class="mix-big">{{ fmtInt(wfStats().total) }}</span>
                <span class="mix-big-label">runs</span>
              </div>
              <div class="mix-stack" role="img" [attr.aria-label]="mixLabel()">
                @for (r of statusMix(); track r.name) {
                  <span
                    [style.width.%]="r.pct"
                    [style.background]="r.color"
                    [title]="r.name + ': ' + fmtInt(r.count)"
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
                    <span class="mix-count">{{ fmtInt(r.count) }}</span>
                    <span class="mix-pct">{{ pct(r.count, wfStats().total) }}</span>
                  </li>
                }
              </ul>
            </div>
          } @else {
            <p class="mix-empty">{{ ready() ? 'No walk-forward runs yet.' : 'Loading…' }}</p>
          }
        </section>
        <app-chart-card
          title="OOS Sharpe distribution"
          subtitle="Completed runs · mean out-of-sample Sharpe, bins from −10 to +5, outliers pooled at the edges"
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

      <!-- 2-col boards: top performers + per-strategy breakdown. Start-aligned so the
           eight-row leaderboard never stretches to the breakdown's height. -->
      <div class="dr-board-row">
        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Top performers</h3>
            <span class="muted">Highest mean OOS Sharpe across completed runs</span>
          </header>
          @if (topOos().length > 0) {
            <div class="board-scroll">
              <table class="dr-board-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Strategy</th>
                    <th>Market</th>
                    <th class="num" title="Mean out-of-sample Sharpe across the run's windows">
                      Avg OOS
                    </th>
                    <th class="num">Consistency</th>
                    <th class="num" title="In-sample / out-of-sample window days">IS / OOS</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of topOos(); track r.id) {
                    <tr class="clickable" (click)="goToDetail(r)">
                      <td class="id">#{{ r.id }}</td>
                      <td class="id">#{{ r.strategyId }}</td>
                      <td>
                        <span class="sym-strong">{{ r.symbol }}</span>
                        <span class="tf">{{ r.timeframe }}</span>
                      </td>
                      <td
                        class="num strong"
                        [class.pos]="(r.averageOutOfSampleScore ?? 0) > 0"
                        [class.neg]="(r.averageOutOfSampleScore ?? 0) < 0"
                      >
                        {{ sharpe(r.averageOutOfSampleScore) }}
                      </td>
                      <td class="num">
                        {{ r.scoreConsistency !== null ? r.scoreConsistency.toFixed(3) : '—' }}
                      </td>
                      <td class="num dim-cell">{{ r.inSampleDays }} / {{ r.outOfSampleDays }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="muted board-empty">No completed runs with OOS scores yet.</p>
          }
        </section>

        <section class="dr-board">
          <header class="dr-board-head">
            <h3>Per-strategy breakdown</h3>
            <span class="count-chip">{{ fmtInt(perStrategyBreakdown().length) }}</span>
            <span class="muted">Outcomes by strategy id · OOS = mean out-of-sample Sharpe</span>
          </header>
          @if (perStrategyBreakdown().length > 0) {
            <div class="board-scroll" [class.capped]="showAllStrategies()">
              <table class="dr-board-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th class="num">Runs</th>
                    <th class="num"><span class="dot ok"></span>Completed</th>
                    <th class="num"><span class="dot fail"></span>Failed</th>
                    <th class="num" title="Mean out-of-sample Sharpe over completed runs">
                      Avg OOS
                    </th>
                    <th class="num" title="Best mean out-of-sample Sharpe">Best OOS</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of visibleStrategies(); track row.strategyId) {
                    <tr>
                      <td class="sym">#{{ row.strategyId }}</td>
                      <td class="num strong">{{ fmtInt(row.runs) }}</td>
                      <td
                        class="num"
                        [class.zero]="row.completed === 0"
                        [class.pos]="row.completed > 0"
                      >
                        {{ row.completed > 0 ? fmtInt(row.completed) : '–' }}
                      </td>
                      <td class="num" [class.zero]="row.failed === 0" [class.neg]="row.failed > 0">
                        {{ row.failed > 0 ? fmtInt(row.failed) : '–' }}
                      </td>
                      <td
                        class="num"
                        [class.zero]="row.avgOos === null"
                        [class.pos]="(row.avgOos ?? 0) > 0"
                        [class.neg]="(row.avgOos ?? 0) < 0"
                      >
                        {{ row.avgOos !== null ? sharpe(row.avgOos) : '–' }}
                      </td>
                      <td
                        class="num"
                        [class.zero]="row.bestOos === null && row.wipedOut === 0"
                        [class.pos]="(row.bestOos ?? 0) > 0"
                        [class.neg]="(row.bestOos ?? 0) < 0"
                      >
                        {{ row.bestOos !== null ? sharpe(row.bestOos) : '–' }}
                        @if (row.wipedOut > 0) {
                          <span
                            class="wiped-pill"
                            title="Runs whose OOS Sharpe is not a real number (non-finite or beyond ±100), excluded from the averages"
                            >{{ row.wipedOut }} corrupt</span
                          >
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (perStrategyBreakdown().length > collapsedRows) {
              <footer class="board-foot" [class.raised]="showAllStrategies()">
                <span class="muted">{{
                  showAllStrategies()
                    ? 'All ' +
                      fmtInt(perStrategyBreakdown().length) +
                      ' strategies · scroll the table'
                    : 'Top ' +
                      collapsedRows +
                      ' of ' +
                      fmtInt(perStrategyBreakdown().length) +
                      ' by run count'
                }}</span>
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
            <p class="muted board-empty">{{ ready() ? 'No runs to group yet.' : 'Loading…' }}</p>
          }
        </section>
      </div>

      <section class="dr-board">
        <header class="dr-board-head">
          <h3>All walk-forward runs</h3>
          @if (ready()) {
            <span class="count-chip">{{ fmtInt(sampleTotal()) }}</span>
          }
          <span class="muted head-right"
            >Server-paged · click any row for the detail page · UTC</span
          >
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
        gap: var(--space-4);
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
      .wiped-note {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border: 1px solid rgba(255, 149, 0, 0.35);
        border-left: 3px solid var(--warning);
        border-radius: var(--radius-sm);
        background: rgba(255, 149, 0, 0.08);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .wiped-pill {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
        font-size: 10px;
        font-weight: var(--font-semibold);
      }
      .sym-strong {
        font-weight: var(--font-semibold);
      }
      .tf {
        margin-left: 6px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
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

  // Analytics sample — probe-and-fetch, sized by analyticsSampleSize.
  readonly wfSample = signal<WalkForwardRunDto[]>([]);
  /** The list's true size (from the probe) — "Total runs" is this, not the sample's length. */
  readonly sampleTotal = signal(0);
  /** False until the first sample lands: the tiles read "—", not a row of zeros. */
  readonly sampleLoaded = signal(false);

  readonly sampleFailed = signal(false);
  readonly ready = computed(() => this.sampleLoaded() && !this.sampleFailed());

  fmtInt(n: number): string {
    return this.decimalPipe.transform(n, '1.0-0') ?? String(n);
  }

  wfStats = computed(() => {
    const all = this.wfSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        wipedOut: 0,
        avgOos: null as number | null,
        bestOos: null as number | null,
        avgConsistency: null as number | null,
        avgIs: 0,
        avgOosDays: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let wipedOut = 0;
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
      if (isWipedOut(r)) wipedOut++;
      if (hasUsableScore(r)) {
        oosSum += r.averageOutOfSampleScore!;
        oosCount++;
        if (r.averageOutOfSampleScore! > bestOos) bestOos = r.averageOutOfSampleScore!;
      }
      if (r.scoreConsistency != null && hasUsableScore(r)) {
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
      wipedOut,
      avgOos: oosCount > 0 ? +(oosSum / oosCount).toFixed(4) : null,
      bestOos: bestOos === -Infinity ? null : +bestOos.toFixed(4),
      avgConsistency: consCount > 0 ? +(consSum / consCount).toFixed(3) : null,
      avgIs: Math.round(isSum / all.length),
      avgOosDays: Math.round(oosDaysSum / all.length),
    };
  });

  readonly collapsedRows = COLLAPSED_ROWS;
  readonly showAllStrategies = signal(false);

  /** Runs per status, in display order — the "Status distribution" breakdown. */
  readonly statusMix = computed(() => {
    const rows = this.wfSample();
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = String(r.status);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const rank = (k: string) => {
      const i = STATUS_ORDER.indexOf(k);
      return i < 0 ? STATUS_ORDER.length : i;
    };
    return [...counts.entries()]
      .sort((x, y) => rank(x[0]) - rank(y[0]) || y[1] - x[1])
      .map(([name, count]) => ({
        name,
        count,
        pct: rows.length > 0 ? (count / rows.length) * 100 : 0,
        color: STATUS_COLOR[name] ?? '#8E8E93',
      }));
  });

  /** How many runs the OOS averages are taken over (completed, finite, not corrupt). */
  readonly scoredRuns = computed(() => this.wfSample().filter((r) => hasUsableScore(r)).length);

  readonly latestStart = computed(() => {
    let best: string | null = null;
    let bestMs = 0;
    for (const r of this.wfSample()) {
      const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
      if (Number.isFinite(t) && t > bestMs) {
        bestMs = t;
        best = r.startedAt;
      }
    }
    if (!best) return { rel: '', abs: '' };
    return {
      rel: relative(best),
      abs: `${this.datePipe.transform(best, 'MMM d, yyyy HH:mm', 'UTC')} UTC`,
    };
  });

  readonly visibleStrategies = computed(() => {
    const rows = this.perStrategyBreakdown();
    return this.showAllStrategies() ? rows : rows.slice(0, COLLAPSED_ROWS);
  });

  pct(n: number, total: number): string {
    if (total <= 0) return '–';
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? '<1%' : p < 100 && p > 99 ? '>99%' : `${p.toFixed(0)}%`;
  }

  mixLabel(): string {
    return this.statusMix()
      .map((r) => `${r.name} ${this.fmtInt(r.count)}`)
      .join(' · ');
  }

  oosHistogramOptions = computed<EChartsOption>(() => {
    // Completed runs only (a failed run's score is whatever the engine
    // wrote before it died). The score is a mean out-of-sample SHARPE, not
    // a percentage: fixed bins from −10 to +5 so one −18 outlier cannot
    // stretch the axis into a single bar; anything beyond the range pools
    // into the edge buckets.
    const scores = this.wfSample()
      .filter((r) => hasUsableScore(r))
      .map((r) => r.averageOutOfSampleScore ?? 0);
    if (scores.length === 0) {
      return {
        title: {
          text: 'No completed runs with an OOS score',
          left: 'center',
          top: 'center',
          textStyle: { fontSize: 12, color: '#8E8E93' },
        },
      };
    }
    const lo = -10;
    const hi = 5;
    const step = 1;
    const inner = (hi - lo) / step; // 15 bins
    const labels: string[] = [`< ${lo}`];
    for (let i = 0; i < inner; i++) labels.push(`${lo + i * step}`);
    labels.push(`> ${hi}`);
    const counts = new Array(labels.length).fill(0);
    for (const v of scores) {
      if (v < lo) counts[0]++;
      else if (v >= hi) counts[counts.length - 1]++;
      else counts[1 + Math.floor((v - lo) / step)]++;
    }
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            itemStyle: {
              color: i === 0 ? '#FF3B30' : labels[i].startsWith('-') ? '#FF9500' : '#0071E3',
              borderRadius: [4, 4, 0, 0],
            },
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
              // Same series colour as the Backtesting page's runs-by-symbol chart.
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
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
      .filter((r) => hasUsableScore(r))
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
      wipedOut: number;
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
          wipedOut: 0,
          _oosSum: 0,
          _oosCount: 0,
        };
      const g = groups[r.strategyId];
      g.runs++;
      const status = String(r.status);
      if (status === 'Completed') g.completed++;
      else if (status === 'Failed') g.failed++;
      if (isWipedOut(r)) g.wipedOut++;
      if (hasUsableScore(r)) {
        g._oosSum += r.averageOutOfSampleScore!;
        g._oosCount++;
        if (g.bestOos == null || r.averageOutOfSampleScore! > g.bestOos)
          g.bestOos = r.averageOutOfSampleScore!;
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

  // Widths sized to header + value so nothing wraps mid-word ("CONSISTENC Y"); dates in UTC — a
  // window ending 2026-09-30T23:00Z printed "Oct 1" in the browser's zone. Symbol is the one
  // flexible column, so spare width never pools in an empty last column. Cell renderers return
  // HTML strings rendered by AG Grid outside this component's style scope, so they style inline.
  private readonly utcDay = (p: { value: unknown }) =>
    this.datePipe.transform(p.value as string, 'MMM d, yyyy', 'UTC') ?? '-';

  readonly columnDefs: ColDef<WalkForwardRunDto>[] = [
    {
      field: 'id',
      headerName: 'Run',
      width: 80,
      minWidth: 72,
      cellRenderer: (p: { value: number }) => idHtml(p.value),
    },
    {
      field: 'strategyId',
      headerName: 'Strategy',
      width: 110,
      minWidth: 108,
      cellRenderer: (p: { value: number }) => idHtml(p.value),
    },
    {
      field: 'symbol',
      headerName: 'Symbol',
      flex: 1,
      minWidth: 88,
      cellStyle: { fontWeight: '600' },
    },
    {
      field: 'timeframe',
      headerName: 'TF',
      width: 60,
      minWidth: 56,
      cellStyle: { color: 'var(--text-secondary)' },
    },
    {
      field: 'fromDate',
      headerName: 'From (UTC)',
      width: 120,
      minWidth: 112,
      cellStyle: NUM_CELL,
      valueFormatter: this.utcDay,
    },
    {
      field: 'toDate',
      headerName: 'To (UTC)',
      width: 120,
      minWidth: 112,
      cellStyle: NUM_CELL,
      valueFormatter: this.utcDay,
    },
    {
      field: 'averageOutOfSampleScore',
      headerName: 'Avg OOS',
      width: 100,
      minWidth: 92,
      type: 'rightAligned',
      cellStyle: (p) => signedStyle(p.value),
      valueFormatter: (p) => this.decimalPipe.transform(p.value as number, '1.2-2') ?? '-',
    },
    {
      field: 'scoreConsistency',
      headerName: 'Consistency',
      width: 132,
      minWidth: 128,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => this.decimalPipe.transform(p.value as number, '1.2-2') ?? '-',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 124,
      minWidth: 118,
      cellRenderer: (p: { value: unknown }) => statusPillHtml(p.value),
    },
    {
      field: 'startedAt',
      headerName: 'Started (UTC)',
      width: 156,
      minWidth: 148,
      cellRenderer: (p: { value: string | null }) =>
        dateHtml(p.value, this.datePipe.transform(p.value, 'MMM d, yyyy HH:mm', 'UTC') ?? '-'),
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
    const progress$ = merge(
      this.realtime.on('backtestCompleted'),
      this.realtime.on('optimizationCompleted'),
    );
    progress$
      .pipe(throttleTime(5_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.runsTable()?.loadData());
    // The analytics sample is megabytes, and every backtest completing anywhere in the fleet
    // fires backtestCompleted — re-fetching it every 5 s kept the page downloading forever.
    // A minute is fresh enough for fleet-level tiles; the table above stays at 5 s.
    progress$
      .pipe(
        throttleTime(60_000, undefined, { leading: false, trailing: true }),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.loadAnalyticsSample());
  }

  ngOnInit(): void {
    this.loadAnalyticsSample();
  }

  protected loadAnalyticsSample(): void {
    this.sampleFailed.set(false);
    this.service.list(newestRowsRequest(1)).subscribe({
      next: (probe) => {
        if (!probe?.status) {
          this.sampleFailed.set(true);
          return;
        }
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        this.sampleTotal.set(total);
        if (total === 0) {
          this.wfSample.set([]);
          this.sampleLoaded.set(true);
          return;
        }
        // List rows used to carry windowResultsJson (~64 KB each; 117 MB for 2,973 runs). The
        // engine now leaves it to the detail GET; the probe row's size still bounds the download.
        const size = analyticsSampleSize(total, probe?.data?.data?.[0]);
        this.service.list(newestRowsRequest(size)).subscribe({
          next: (full) => {
            this.sampleFailed.set(!full?.status);
            this.wfSample.set(full?.data?.data ?? []);
            this.sampleLoaded.set(true);
          },
          error: () => this.sampleFailed.set(true),
        });
      },
      error: () => this.sampleFailed.set(true),
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
        // `POST walk-forward` answers with the new run's id (ResponseData<long>), not the run —
        // reading `.id` off the number queued "#undefined" and opened /walk-forward/undefined.
        const data = res.data as unknown;
        const id = typeof data === 'number' ? data : ((data as { id?: number } | null)?.id ?? null);
        if (res.status && id != null) {
          this.notifications.success(`Walk-forward run #${id} queued`);
          this.showCreatePanel.set(false);
          this.loadAnalyticsSample();
          this.router.navigate(['/walk-forward', id]);
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

  /** "+1.23" / "−1.23" / "—" — the OOS score is a Sharpe ratio, not a percentage. */
  sharpe(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
  }
}

/**
 * The engine's "average out-of-sample score" is the mean OOS Sharpe ratio
 * across a run's windows (WalkForwardWorker: OosHealthScore =
 * oosResult.SharpeRatio). A Sharpe of −18 is a bad strategy, not a broken
 * run; only a non-finite value or an absurd magnitude (beyond ±100) marks
 * the score corrupt. Same exclusion rule the backtests page applies: such
 * runs stay in the counts but never enter an average, a "best" or a histogram.
 */
function isWipedOut(r: WalkForwardRunDto): boolean {
  const s = r.averageOutOfSampleScore;
  return s != null && (!Number.isFinite(s) || Math.abs(s) > 100);
}

function hasUsableScore(r: WalkForwardRunDto): boolean {
  return (
    String(r.status) === 'Completed' &&
    r.averageOutOfSampleScore != null &&
    Number.isFinite(r.averageOutOfSampleScore) &&
    !isWipedOut(r)
  );
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
