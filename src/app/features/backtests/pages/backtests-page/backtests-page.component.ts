import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
  effect,
  viewChild,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { DecimalPipe, NgTemplateOutlet, formatDate } from '@angular/common';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { Observable, map } from 'rxjs';
import type { EChartsOption } from 'echarts';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { TabsComponent } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { BacktestsService } from '@core/services/backtests.service';
import { WalkForwardService } from '@core/services/walk-forward.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ColDef } from 'ag-grid-community';
import {
  PagedData,
  PagerRequest,
  BacktestRunDto,
  WalkForwardRunDto,
  ResponseData,
  CreateBacktestRequest,
} from '@core/api/api.types';
import { FormsModule } from '@angular/forms';
import { analyticsSampleSize, newestRowsRequest } from '../../analytics-sample';

type SampleState = 'loading' | 'ready' | 'error';

/** A run that closed no trade has no win rate, profit factor or Sharpe — the engine stores 0.0 for all three. */
function hasTrades(r: { totalTrades: number | null }): boolean {
  return r.totalTrades != null && r.totalTrades > 0;
}

/** Status colours shared by the mix panel and the runs tables. */
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

/** Long per-symbol boards show this many rows (the leaderboard's height) until "Show all". */
const COLLAPSED_ROWS = 8;

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

/** Tabular number cell, green/red by sign — for return / score columns. */
function signedStyle(v: unknown): Record<string, string> {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return n > 0
    ? { ...NUM_CELL, color: 'var(--profit)' }
    : n < 0
      ? { ...NUM_CELL, color: 'var(--loss)' }
      : NUM_CELL;
}

function statusMixRows(rows: { status: unknown }[]) {
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
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      pct: rows.length > 0 ? (count / rows.length) * 100 : 0,
      color: STATUS_COLOR[name] ?? '#8E8E93',
    }));
}

/** Newest timestamp among `isos`, as a relative phrase plus its absolute UTC form for the tooltip. */
function latestOf(isos: (string | null | undefined)[]): { rel: string; abs: string } {
  let best: string | null = null;
  let bestMs = 0;
  for (const iso of isos) {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t) && t > bestMs) {
      bestMs = t;
      best = iso!;
    }
  }
  if (!best) return { rel: '', abs: '' };
  return {
    rel: relative(best),
    abs: `${formatDate(best, 'MMM d, yyyy HH:mm', 'en-US', 'UTC')} UTC`,
  };
}

@Component({
  selector: 'app-backtests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    TabsComponent,
    ChartCardComponent,
    FormsModule,
    DecimalPipe,
    NgTemplateOutlet,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Backtesting"
        subtitle="Run and review historical strategy simulations"
      >
        <button class="btn-primary" (click)="showForm.set(!showForm())">
          {{ showForm() ? 'Cancel' : 'Queue Backtest' }}
        </button>
      </app-page-header>

      @if (showForm()) {
        <div class="form-card">
          <h3 class="form-title">Queue New Backtest</h3>
          <div class="form-grid">
            <div class="field">
              <label>Strategy ID</label>
              <input
                type="number"
                [(ngModel)]="formData.strategyId"
                (ngModelChange)="onStrategyIdChange($event)"
                placeholder="1"
              />
            </div>
            <div class="field">
              <label>Symbol</label>
              <input type="text" [(ngModel)]="formData.symbol" placeholder="EURUSD" />
            </div>
            <div class="field">
              <label>Timeframe</label>
              <select [(ngModel)]="formData.timeframe">
                <option value="M1">1 Min</option>
                <option value="M5">5 Min</option>
                <option value="M15">15 Min</option>
                <option value="H1">1 Hour</option>
                <option value="H4">4 Hours</option>
                <option value="D1">Daily</option>
              </select>
            </div>
            <div class="field">
              <label>Initial Balance</label>
              <input type="number" [(ngModel)]="formData.initialBalance" placeholder="10000" />
            </div>
            <div class="field">
              <label>From Date</label>
              <input type="date" [(ngModel)]="formData.fromDate" />
            </div>
            <div class="field">
              <label>To Date</label>
              <input type="date" [(ngModel)]="formData.toDate" />
            </div>
          </div>
          @if (strategyInfo(); as s) {
            <p class="form-hint">
              #{{ s.id }} {{ s.name }} — trades {{ s.symbol }} {{ s.timeframe }}.
              @if (isOverride()) {
                <strong>Override run</strong> on {{ normalizedSymbol() || s.symbol }}
                {{ formData.timeframe }}: the strategy's rules on another market — never promotion
                evidence.
              }
            </p>
          } @else if (strategyLookupError()) {
            <p class="form-hint form-hint-error">{{ strategyLookupError() }}</p>
          }
          @if (queueError()) {
            <p class="form-hint form-hint-error">{{ queueError() }}</p>
          }
          <div class="form-actions">
            <button class="btn-secondary" (click)="showForm.set(false)">Cancel</button>
            <button class="btn-primary" [disabled]="queueing()" (click)="queueBacktest()">
              {{ queueing() ? 'Queueing…' : 'Queue' }}
            </button>
          </div>
        </div>
      }

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      <!-- Status breakdown panel shared by both tabs: total, stacked strip, one row per status. -->
      <ng-template #statusMixTpl let-rows let-total="total">
        <section class="mix-panel">
          <header class="mix-head">
            <h3>Status distribution</h3>
            <p>Share of sampled runs by status</p>
          </header>
          @if (total > 0) {
            <div class="mix-body">
              <div class="mix-headline">
                <span class="mix-big">{{ fmt(total) }}</span>
                <span class="mix-big-label">runs</span>
              </div>
              <div class="mix-stack" role="img" [attr.aria-label]="mixLabel(rows)">
                @for (r of rows; track r.name) {
                  <span
                    [style.width.%]="r.pct"
                    [style.background]="r.color"
                    [title]="r.name + ': ' + fmt(r.count)"
                  ></span>
                }
              </div>
              <ul class="mix-rows">
                @for (r of rows; track r.name) {
                  <li>
                    <span class="dot" [style.background]="r.color"></span>
                    <span class="mix-name">{{ r.name }}</span>
                    <span class="mix-track">
                      <i [style.width.%]="r.pct" [style.background]="r.color"></i>
                    </span>
                    <span class="mix-count">{{ fmt(r.count) }}</span>
                    <span class="mix-pct">{{ pct(r.count, total) }}</span>
                  </li>
                }
              </ul>
            </div>
          } @else {
            <p class="mix-empty">No runs yet.</p>
          }
        </section>
      </ng-template>

      @if (activeTab() === 'backtests') {
        @if (btSampleState() !== 'ready') {
          <p class="sample-note" [class.sample-note-error]="btSampleState() === 'error'">
            {{
              btSampleState() === 'error'
                ? 'The run analytics could not be loaded — the table below still pages through every run.'
                : 'Loading run analytics…'
            }}
          </p>
        } @else {
          @if (btSampleTotal() > btSample().length) {
            <p class="sample-note">
              Tiles, charts and leaderboards cover the newest {{ btSample().length | number }} of
              {{ btSampleTotal() | number }} runs; the table below pages through all of them.
            </p>
          }
          <!-- 8-tile KPI strip. Tones carry meaning only: failures red, returns by sign. -->
          <div class="dr-kpis">
            <div class="dr-kpi">
              <span class="kpi-label">Total runs</span>
              <span class="kpi-value">{{ btSampleTotal() | number }}</span>
              <span class="kpi-hint" [title]="btLatest().abs">
                {{ btLatest().rel ? 'latest completed ' + btLatest().rel : 'none completed yet' }}
              </span>
            </div>
            <div class="dr-kpi">
              <span class="kpi-label">Completed</span>
              <span class="kpi-value">{{ fmt(btStats().completed) }}</span>
              <span class="kpi-hint">{{ pct(btStats().completed, btStats().total) }} of runs</span>
            </div>
            <div class="dr-kpi" [class.tone-bad]="btStats().failed > 0">
              <span class="kpi-label">Failed</span>
              <span class="kpi-value">{{ fmt(btStats().failed) }}</span>
              <span class="kpi-hint">{{ pct(btStats().failed, btStats().total) }} of runs</span>
            </div>
            <div
              class="dr-kpi"
              [class.tone-good]="btStats().avgReturn !== null && btStats().avgReturn! > 0"
              [class.tone-bad]="btStats().avgReturn !== null && btStats().avgReturn! < 0"
            >
              <span class="kpi-label">Avg total return</span>
              <span class="kpi-value">{{ signedPct(btStats().avgReturn) }}</span>
              @if (btStats().wipedOut > 0) {
                <span
                  class="kpi-hint warn"
                  title="Runs whose simulated balance went to or below zero. They are counted in the totals but excluded from every average and from the histogram, because one wiped-out run swamps hundreds of real ones."
                >
                  {{ btStats().wipedOut }} wiped-out run{{ btStats().wipedOut === 1 ? '' : 's' }}
                  excluded
                </span>
              } @else {
                <span class="kpi-hint">mean of every run with a return</span>
              }
            </div>
            <div
              class="dr-kpi"
              [class.tone-good]="btStats().bestReturn !== null && btStats().bestReturn! > 0"
              [class.tone-bad]="btStats().bestReturn !== null && btStats().bestReturn! < 0"
            >
              <span class="kpi-label">Best return</span>
              <span class="kpi-value">{{ signedPct(btStats().bestReturn) }}</span>
              <span class="kpi-hint">
                @if (btBestRun(); as b) {
                  best: #{{ b.id }} · {{ b.symbol ?? '—' }} {{ b.timeframe }}
                } @else {
                  no returns yet
                }
              </span>
            </div>
            <div class="dr-kpi">
              <span class="kpi-label">Avg win rate</span>
              <span class="kpi-value">
                {{
                  btStats().avgWinRate !== null
                    ? (btStats().avgWinRate! * 100).toFixed(1) + '%'
                    : '—'
                }}
              </span>
              <span class="kpi-hint">over runs that closed a trade</span>
            </div>
            <div class="dr-kpi">
              <span class="kpi-label">Avg trades</span>
              <span class="kpi-value">{{
                btStats().avgTrades !== null ? fmt(btStats().avgTrades!) : '—'
              }}</span>
              <span class="kpi-hint">closed trades per run</span>
            </div>
            <div class="dr-kpi">
              <span class="kpi-label">Symbols × strategies</span>
              <span class="kpi-value"
                >{{ fmt(btStats().symbolCount) }} × {{ fmt(btStats().strategyCount) }}</span
              >
              <span class="kpi-hint">
                @if (btPerSymbol()[0]; as top) {
                  most runs: {{ top.symbol }} ({{ fmt(top.runs) }})
                } @else {
                  no runs yet
                }
              </span>
            </div>
          </div>

          <!-- 3-col chart row -->
          <div class="dr-charts">
            <ng-container
              *ngTemplateOutlet="
                statusMixTpl;
                context: { $implicit: btStatusMix(), total: btStats().total }
              "
            />
            <app-chart-card
              title="Return distribution"
              [subtitle]="btReturnHistogram().subtitle"
              [options]="btReturnHistogram().options"
              height="240px"
            />
            <app-chart-card
              title="Runs by symbol"
              subtitle="Top 12 symbols by run count"
              [options]="btBySymbolOptions()"
              height="240px"
            />
          </div>

          <!-- 2-col boards: top performers + per-symbol -->
          <div class="dr-board-row">
            <section class="dr-board">
              <header class="dr-board-head">
                <h3>Top performers</h3>
                <span class="muted">Highest total return across completed runs</span>
              </header>
              @if (btTopReturns().length > 0) {
                <div class="board-scroll">
                  <table class="dr-board-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Strategy</th>
                        <th>Symbol</th>
                        <th class="num">Return</th>
                        <th class="num">PF</th>
                        <th class="num">Sharpe</th>
                        <th class="num">Max DD</th>
                        <th class="num">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of btTopReturns(); track r.id) {
                        <tr class="clickable" (click)="onBacktestClick(r)">
                          <td class="id">#{{ r.id }}</td>
                          <td class="id">#{{ r.strategyId }}</td>
                          <td class="sym">{{ r.symbol }}</td>
                          <td
                            class="num strong"
                            [class.pos]="(r.totalReturn ?? 0) > 0"
                            [class.neg]="(r.totalReturn ?? 0) < 0"
                          >
                            {{ signedPct(r.totalReturn) }}
                          </td>
                          <td class="num">{{ fmtProfitFactor(r.profitFactor) }}</td>
                          <td class="num">
                            {{ r.sharpeRatio !== null ? r.sharpeRatio.toFixed(2) : '—' }}
                          </td>
                          <td class="num dim-cell">
                            {{
                              r.maxDrawdownPct !== null ? r.maxDrawdownPct.toFixed(2) + '%' : '—'
                            }}
                          </td>
                          <td class="num">{{ r.totalTrades ?? '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p class="muted board-empty">No completed runs with measurable returns yet.</p>
              }
            </section>

            <section class="dr-board">
              <header class="dr-board-head">
                <h3>Per-symbol breakdown</h3>
                <span class="count-chip">{{ fmt(btPerSymbol().length) }}</span>
                <span class="muted">Averages grouped by symbol</span>
              </header>
              @if (btPerSymbol().length > 0) {
                <div class="board-scroll" [class.capped]="showAllBtSymbols()">
                  <table class="dr-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th class="num">Runs</th>
                        <th class="num">Avg return</th>
                        <th class="num">Best return</th>
                        <th class="num">Avg Sharpe</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of visible(btPerSymbol(), showAllBtSymbols()); track row.symbol) {
                        <tr>
                          <td class="sym">{{ row.symbol }}</td>
                          <td class="num strong">{{ fmt(row.runs) }}</td>
                          <td
                            class="num"
                            [class.pos]="row.avgReturn !== null && row.avgReturn > 0"
                            [class.neg]="row.avgReturn !== null && row.avgReturn < 0"
                          >
                            {{ signedPct(row.avgReturn) }}
                          </td>
                          <td
                            class="num"
                            [class.pos]="row.bestReturn !== null && row.bestReturn > 0"
                            [class.neg]="row.bestReturn !== null && row.bestReturn < 0"
                          >
                            {{ signedPct(row.bestReturn) }}
                          </td>
                          <td class="num" [class.zero]="row.avgSharpe === null">
                            {{ row.avgSharpe !== null ? row.avgSharpe.toFixed(2) : '–' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (btPerSymbol().length > collapsedRows) {
                  <footer class="board-foot" [class.raised]="showAllBtSymbols()">
                    <span class="muted">{{
                      showAllBtSymbols()
                        ? 'All ' + fmt(btPerSymbol().length) + ' symbols · scroll the table'
                        : 'Top ' +
                          collapsedRows +
                          ' of ' +
                          fmt(btPerSymbol().length) +
                          ' by run count'
                    }}</span>
                    <button
                      type="button"
                      class="link-btn"
                      (click)="showAllBtSymbols.set(!showAllBtSymbols())"
                    >
                      {{ showAllBtSymbols() ? 'Show top ' + collapsedRows : 'Show all' }}
                    </button>
                  </footer>
                }
              }
            </section>
          </div>
        }

        <section class="dr-board bt-runs">
          <header class="dr-board-head">
            <h3>All backtest runs</h3>
            @if (btSampleState() === 'ready') {
              <span class="count-chip">{{ fmt(btSampleTotal()) }}</span>
            }
            <span class="muted head-right"
              >Server-paged · click any row for the detail page · UTC</span
            >
          </header>
          <app-data-table
            #btTable
            [columnDefs]="backtestColumns"
            [fetchData]="fetchBacktests"
            (rowClick)="onBacktestClick($event)"
          />
        </section>
      } @else {
        <!-- Walk-Forward analytics. Zeros while the sample was still downloading read as "no runs"
             beside a table of 2,973 — the tiles wait for the sample instead. -->
        @if (wfSampleState() !== 'ready') {
          <p class="sample-note" [class.sample-note-error]="wfSampleState() === 'error'">
            {{
              wfSampleState() === 'error'
                ? 'The walk-forward analytics could not be loaded — the table below still pages through every run.'
                : 'Loading walk-forward analytics…'
            }}
          </p>
        } @else {
          @if (wfSampleTotal() > wfSample().length) {
            <p class="sample-note">
              Tiles, charts and leaderboards cover the newest {{ wfSample().length | number }} of
              {{ wfSampleTotal() | number }} runs — a full sample would be too large to fetch. The
              table below pages through all of them.
            </p>
          }
          <div class="dr-kpis">
            <div class="dr-kpi">
              <span class="kpi-label">Total runs</span>
              <span class="kpi-value">{{ wfSampleTotal() | number }}</span>
              <span class="kpi-hint" [title]="wfLatest().abs">
                {{ wfLatest().rel ? 'latest started ' + wfLatest().rel : 'none started yet' }}
              </span>
            </div>
            <div class="dr-kpi">
              <span class="kpi-label">Completed</span>
              <span class="kpi-value">{{ fmt(wfStats().completed) }}</span>
              <span class="kpi-hint">{{ pct(wfStats().completed, wfStats().total) }} of runs</span>
            </div>
            <div class="dr-kpi" [class.tone-bad]="wfStats().failed > 0">
              <span class="kpi-label">Failed</span>
              <span class="kpi-value">{{ fmt(wfStats().failed) }}</span>
              <span class="kpi-hint">{{ pct(wfStats().failed, wfStats().total) }} of runs</span>
            </div>
            <div
              class="dr-kpi"
              [class.tone-good]="wfStats().avgOosScore !== null && wfStats().avgOosScore! > 0"
              [class.tone-bad]="wfStats().avgOosScore !== null && wfStats().avgOosScore! < 0"
            >
              <span
                class="kpi-label"
                title="Mean out-of-sample Sharpe ratio across each run's windows"
                >Avg OOS Sharpe</span
              >
              <span class="kpi-value">{{ signedRatio(wfStats().avgOosScore) }}</span>
              @if (wfStats().corrupt > 0) {
                <span
                  class="kpi-hint warn"
                  title="Runs whose OOS Sharpe or consistency is not a real number (non-finite, a Sharpe beyond ±100, or a negative deviation). They are counted in the totals but excluded from every average, the histogram and the leaderboards."
                >
                  {{ wfStats().corrupt }} corrupt run{{ wfStats().corrupt === 1 ? '' : 's' }}
                  excluded
                </span>
              } @else {
                <span class="kpi-hint">mean across each run's windows</span>
              }
            </div>
            <div
              class="dr-kpi"
              [class.tone-good]="wfStats().bestOosScore !== null && wfStats().bestOosScore! > 0"
              [class.tone-bad]="wfStats().bestOosScore !== null && wfStats().bestOosScore! < 0"
            >
              <span class="kpi-label">Best OOS Sharpe</span>
              <span class="kpi-value">{{ signedRatio(wfStats().bestOosScore) }}</span>
              <span class="kpi-hint">
                @if (wfTopOos()[0]; as b) {
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
              <span class="kpi-value">{{ fmt(wfStats().avgIsDays) }}</span>
              <span class="kpi-hint">in-sample window length</span>
            </div>
            <div class="dr-kpi">
              <span class="kpi-label">Avg OOS days</span>
              <span class="kpi-value">{{ fmt(wfStats().avgOosDays) }}</span>
              <span class="kpi-hint">out-of-sample window length</span>
            </div>
          </div>

          <div class="dr-charts">
            <ng-container
              *ngTemplateOutlet="
                statusMixTpl;
                context: { $implicit: wfStatusMix(), total: wfStats().total }
              "
            />
            <app-chart-card
              title="OOS score distribution"
              [subtitle]="wfOosHistogram().subtitle"
              [options]="wfOosHistogram().options"
              height="240px"
            />
            <app-chart-card
              title="Runs by symbol"
              subtitle="Top 12 symbols by run count"
              [options]="wfBySymbolOptions()"
              height="240px"
            />
          </div>

          <div class="dr-board-row">
            <section class="dr-board">
              <header class="dr-board-head">
                <h3>Top performers</h3>
                <span class="muted">Highest avg OOS score across completed runs</span>
              </header>
              @if (wfTopOos().length > 0) {
                <div class="board-scroll">
                  <table class="dr-board-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Strategy</th>
                        <th>Symbol</th>
                        <th class="num">Avg OOS</th>
                        <th class="num">Consistency</th>
                        <th class="num">IS days</th>
                        <th class="num">OOS days</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of wfTopOos(); track r.id) {
                        <tr class="clickable" (click)="onWalkForwardClick(r)">
                          <td class="id">#{{ r.id }}</td>
                          <td class="id">#{{ r.strategyId }}</td>
                          <td class="sym">{{ r.symbol }}</td>
                          <td
                            class="num strong"
                            [class.pos]="(r.averageOutOfSampleScore ?? 0) > 0"
                            [class.neg]="(r.averageOutOfSampleScore ?? 0) < 0"
                          >
                            {{ signedRatio(r.averageOutOfSampleScore) }}
                          </td>
                          <td class="num">
                            {{ r.scoreConsistency !== null ? r.scoreConsistency.toFixed(3) : '—' }}
                          </td>
                          <td class="num">{{ r.inSampleDays }}</td>
                          <td class="num">{{ r.outOfSampleDays }}</td>
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
                <h3>Per-symbol breakdown</h3>
                <span class="count-chip">{{ fmt(wfPerSymbol().length) }}</span>
                <span class="muted">Averages grouped by symbol</span>
              </header>
              @if (wfPerSymbol().length > 0) {
                <div class="board-scroll" [class.capped]="showAllWfSymbols()">
                  <table class="dr-board-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th class="num">Runs</th>
                        <th class="num">Avg OOS</th>
                        <th class="num">Best OOS</th>
                        <th class="num">Avg consist.</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of visible(wfPerSymbol(), showAllWfSymbols()); track row.symbol) {
                        <tr>
                          <td class="sym">{{ row.symbol }}</td>
                          <td class="num strong">{{ fmt(row.runs) }}</td>
                          <td
                            class="num"
                            [class.pos]="row.avgOos !== null && row.avgOos > 0"
                            [class.neg]="row.avgOos !== null && row.avgOos < 0"
                          >
                            {{ signedRatio(row.avgOos) }}
                          </td>
                          <td
                            class="num"
                            [class.pos]="row.bestOos !== null && row.bestOos > 0"
                            [class.neg]="row.bestOos !== null && row.bestOos < 0"
                          >
                            {{ signedRatio(row.bestOos) }}
                          </td>
                          <td class="num" [class.zero]="row.avgConsistency === null">
                            {{ row.avgConsistency !== null ? row.avgConsistency.toFixed(3) : '–' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (wfPerSymbol().length > collapsedRows) {
                  <footer class="board-foot" [class.raised]="showAllWfSymbols()">
                    <span class="muted">{{
                      showAllWfSymbols()
                        ? 'All ' + fmt(wfPerSymbol().length) + ' symbols · scroll the table'
                        : 'Top ' +
                          collapsedRows +
                          ' of ' +
                          fmt(wfPerSymbol().length) +
                          ' by run count'
                    }}</span>
                    <button
                      type="button"
                      class="link-btn"
                      (click)="showAllWfSymbols.set(!showAllWfSymbols())"
                    >
                      {{ showAllWfSymbols() ? 'Show top ' + collapsedRows : 'Show all' }}
                    </button>
                  </footer>
                }
              }
            </section>
          </div>
        }

        <section class="dr-board bt-runs">
          <header class="dr-board-head">
            <h3>All walk-forward runs</h3>
            @if (wfSampleState() === 'ready') {
              <span class="count-chip">{{ fmt(wfSampleTotal()) }}</span>
            }
            <span class="muted head-right"
              >Server-paged · click any row for the detail page · UTC</span
            >
          </header>
          <app-data-table
            [columnDefs]="walkForwardColumns"
            [fetchData]="fetchWalkForward"
            (rowClick)="onWalkForwardClick($event)"
          />
        </section>
      }
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
      .btn-primary {
        height: 36px;
        padding: 0 var(--space-5);
        background: var(--accent);
        color: white;
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s ease;
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }
      .btn-primary:active {
        transform: scale(0.97);
      }
      .btn-secondary {
        height: 36px;
        padding: 0 var(--space-5);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
      }

      .form-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .form-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        margin: 0 0 var(--space-4);
        color: var(--text-primary);
      }
      .form-hint {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .form-hint-error {
        color: var(--loss);
      }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .field label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input,
      .field select {
        height: 40px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-base);
        font-family: inherit;
        outline: none;
      }
      .field input:focus,
      .field select:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3);
      }
      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
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
      /* Twelve columns in a ~1,110px card: at the grid's 18px cell padding the single-word
         headers still broke mid-word ("STRATEG Y", "TRADE S", "SHARP E") at their minimums.
         12px leaves every header and value on its line without widening the minimums. */
      .bt-runs ::ng-deep .ag-theme-alpine {
        --ag-cell-horizontal-padding: 12px;
      }
      .sample-note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .sample-note-error {
        color: var(--loss);
      }
    `,
  ],
})
export class BacktestsPageComponent implements OnInit {
  private backtestsService = inject(BacktestsService);
  private walkForwardService = inject(WalkForwardService);
  private notifications = inject(NotificationService);
  private strategiesService = inject(StrategiesService);
  private router = inject(Router);
  private readonly btTable = viewChild<DataTableComponent<BacktestRunDto>>('btTable');

  tabs = [
    { label: 'Backtest Runs', value: 'backtests' },
    { label: 'Walk-Forward Runs', value: 'walkforward' },
  ];
  activeTab = signal('backtests');
  showForm = signal(false);

  formData = {
    strategyId: 1,
    symbol: 'EURUSD',
    timeframe: 'H1',
    initialBalance: 10000,
    fromDate: '2025-01-01',
    toDate: '2025-12-31',
  };

  /** The strategy the form points at; its own symbol/timeframe are what a normal run must send. */
  readonly strategyInfo = signal<{
    id: number;
    name: string;
    symbol: string;
    timeframe: string;
  } | null>(null);
  readonly strategyLookupError = signal<string | null>(null);
  readonly queueing = signal(false);
  readonly queueError = signal<string | null>(null);
  private strategyLookupSeq = 0;

  /** "EUR/USD" / "eurusd " → "EURUSD": the engine's symbols carry no separators. */
  normalizedSymbol(): string {
    return (this.formData.symbol ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
  }

  isOverride(): boolean {
    const s = this.strategyInfo();
    if (!s) return false;
    const sym = this.normalizedSymbol();
    return (!!sym && sym !== s.symbol) || this.formData.timeframe !== s.timeframe;
  }

  /** Looks the strategy up and fills its own symbol/timeframe, so a normal run never trips the engine's market check. */
  onStrategyIdChange(id: number | null): void {
    const seq = ++this.strategyLookupSeq;
    this.strategyInfo.set(null);
    this.strategyLookupError.set(null);
    this.queueError.set(null);
    if (!id || id <= 0) return;
    this.strategiesService.getById(id).subscribe({
      next: (res) => {
        if (seq !== this.strategyLookupSeq) return;
        const s = res?.status ? res.data : null;
        if (!s || !s.symbol) {
          this.strategyLookupError.set(res?.message || `Strategy ${id} not found`);
          return;
        }
        this.strategyInfo.set({
          id: s.id,
          name: s.name ?? `Strategy ${s.id}`,
          symbol: s.symbol,
          timeframe: s.timeframe,
        });
        this.formData.symbol = s.symbol;
        this.formData.timeframe = s.timeframe;
      },
      error: () => {
        if (seq === this.strategyLookupSeq)
          this.strategyLookupError.set(`Strategy ${id} could not be loaded`);
      },
    });
  }

  // ── Analytics samples (probe-and-fetch, sized by analyticsSampleSize) ─────
  readonly btSample = signal<BacktestRunDto[]>([]);
  readonly wfSample = signal<WalkForwardRunDto[]>([]);
  /** The list's true size from the probe — "Total runs" is this, not the sample's length. */
  readonly btSampleTotal = signal(0);
  readonly wfSampleTotal = signal(0);
  readonly btSampleState = signal<SampleState>('loading');
  readonly wfSampleState = signal<SampleState>('loading');
  private wfLoaded = false;

  constructor() {
    // Lazy-load walk-forward analytics the first time the user opens that tab.
    effect(() => {
      if (this.activeTab() === 'walkforward' && !this.wfLoaded) {
        this.loadWfAnalyticsSample();
      }
    });
  }

  ngOnInit(): void {
    this.loadBtAnalyticsSample();
    this.onStrategyIdChange(this.formData.strategyId);
  }

  // ── Presentation helpers ──────────────────────────────────────────
  readonly fmt = fmt;
  readonly collapsedRows = COLLAPSED_ROWS;
  readonly showAllBtSymbols = signal(false);
  readonly showAllWfSymbols = signal(false);

  readonly btStatusMix = computed(() => statusMixRows(this.btSample()));
  readonly wfStatusMix = computed(() => statusMixRows(this.wfSample()));
  readonly btLatest = computed(() => latestOf(this.btSample().map((r) => r.completedAt)));
  readonly wfLatest = computed(() => latestOf(this.wfSample().map((r) => r.startedAt)));

  /** The run behind "Best return" — the same wiped-out exclusion the tile applies. */
  readonly btBestRun = computed(() => {
    let best: BacktestRunDto | null = null;
    for (const r of this.btSample()) {
      if (r.totalReturn == null || BacktestsPageComponent.isWipedOut(r)) continue;
      if (!best || r.totalReturn > (best.totalReturn ?? -Infinity)) best = r;
    }
    return best;
  });

  /** A long board's rows: the first COLLAPSED_ROWS, or all of them once expanded. */
  visible<T>(rows: T[], all: boolean): T[] {
    return all ? rows : rows.slice(0, COLLAPSED_ROWS);
  }

  pct(n: number, total: number): string {
    if (total <= 0) return '0%';
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? '<1%' : p < 100 && p > 99 ? '>99%' : `${p.toFixed(0)}%`;
  }

  mixLabel(rows: { name: string; count: number }[]): string {
    return rows.map((r) => `${r.name} ${fmt(r.count)}`).join(' · ');
  }

  // ── Backtest analytics ─────────────────────────────────────────────

  /**
   * A run whose simulated account was WIPED OUT — total return at or below −100% — or whose
   * return is not a real result at all (beyond ±1000%). The backtester does not stop at ruin,
   * so a run can carry its balance to −237,000,000 on 10,000 of starting equity; 282 such rows
   * existed on 2026-09-05. Averaging them in produced an "Avg total return" of −675,257% and a
   * return histogram whose twelve bins spanned −237,828,521% to +324%, with every real run in
   * the last bin. They are counted and reported, never averaged.
   */
  static isWipedOut(r: { totalReturn: number | null }): boolean {
    // TotalReturn is already a percentage on the wire (BacktestEngine
    // multiplies by 100; run 844 carries 0.1089 for +0.1089%). Treating it
    // as a fraction printed 10.89% on the list beside 0.11% on the detail
    // page, and counted every run below −1% as "wiped out".
    return r.totalReturn != null && (r.totalReturn <= -100 || Math.abs(r.totalReturn) > 1000);
  }

  /** "+12.34%" / "−12.34%" — a signed percentage from a value already in percent. */
  signedPct(pct: number | null | undefined, digits = 2): string {
    if (pct == null || !Number.isFinite(pct)) return '—';
    return `${pct > 0 ? '+' : ''}${pct.toFixed(digits)}%`;
  }

  /** "+1.23" / "−1.23" — a signed ratio (Sharpe), no unit. */
  signedRatio(value: number | null | undefined, digits = 2): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
  }

  /**
   * Profit factor, with the engine's "undefined ratio" sentinel (9999 = profit and no losses)
   * shown as ∞ rather than as if it were a measured 9999.00.
   */
  fmtProfitFactor(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 9999) return '∞';
    return v.toFixed(2);
  }

  btStats = computed(() => {
    const all = this.btSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        wipedOut: 0,
        avgReturn: null as number | null,
        bestReturn: null as number | null,
        avgWinRate: null as number | null,
        avgTrades: null as number | null,
        symbolCount: 0,
        strategyCount: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let wipedOut = 0;
    let returnSum = 0;
    let returnCount = 0;
    let bestReturn = -Infinity;
    let winRateSum = 0;
    let winRateCount = 0;
    let tradesSum = 0;
    let tradesCount = 0;
    const symbols = new Set<string>();
    const strategies = new Set<number>();
    for (const r of all) {
      const status = String(r.status);
      if (status === 'Completed') completed++;
      else if (status === 'Failed') failed++;
      if (r.symbol) symbols.add(r.symbol);
      strategies.add(r.strategyId);
      if (BacktestsPageComponent.isWipedOut(r)) {
        wipedOut++;
      } else if (r.totalReturn != null) {
        returnSum += r.totalReturn;
        returnCount++;
        if (r.totalReturn > bestReturn) bestReturn = r.totalReturn;
      }
      // A no-trade run's 0.0 win rate is "not measured", not 0% — it dragged the average down.
      if (r.winRate != null && hasTrades(r)) {
        winRateSum += r.winRate;
        winRateCount++;
      }
      if (r.totalTrades != null) {
        tradesSum += r.totalTrades;
        tradesCount++;
      }
    }
    return {
      total: all.length,
      completed,
      failed,
      wipedOut,
      avgReturn: returnCount > 0 ? +(returnSum / returnCount).toFixed(4) : null,
      bestReturn: bestReturn === -Infinity ? null : +bestReturn.toFixed(4),
      avgWinRate: winRateCount > 0 ? +(winRateSum / winRateCount).toFixed(4) : null,
      avgTrades: tradesCount > 0 ? Math.round(tradesSum / tradesCount) : null,
      symbolCount: symbols.size,
      strategyCount: strategies.size,
    };
  });

  /**
   * A 12-bin histogram over the P1–P99 range of `values` (already in percent). Even with the
   * wiped-out runs gone, a handful of runs at +300% against a body sitting between −5% and
   * +10% still put every real run in one bar. Values outside the clipped range are counted
   * into the edge bins and reported in the subtitle so nothing is silently dropped.
   * `signColour` paints bins by sign (returns); otherwise a single series colour is used.
   * `unit` suffixes the bin labels: "%" for returns, "" for a ratio such as Sharpe.
   */
  private buildHistogram(
    values: number[],
    signColour: boolean,
    unit = '%',
  ): { options: EChartsOption; outliers: number } {
    if (values.length === 0) return { options: {}, outliers: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const lo = sorted.length >= 20 ? pct(0.01) : sorted[0];
    const hi = sorted.length >= 20 ? pct(0.99) : sorted[sorted.length - 1];
    const outliers = sorted.filter((v) => v < lo || v > hi).length;
    const colourFor = (mid: number) =>
      signColour ? (mid >= 0 ? '#34C759' : '#FF3B30') : '#0071E3';
    const axis = {
      yAxis: {
        type: 'value' as const,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    };
    if (hi === lo) {
      return {
        outliers,
        options: {
          ...axis,
          grid: { top: 10, right: 20, bottom: 30, left: 40 },
          xAxis: { type: 'category', data: [`${lo.toFixed(1)}${unit}`] },
          series: [
            {
              type: 'bar',
              data: [{ value: values.length, itemStyle: { color: colourFor(lo) } }],
              barWidth: '40%',
            },
          ],
        },
      };
    }
    const bins = 12;
    const width = (hi - lo) / bins;
    const counts = new Array<number>(bins).fill(0);
    const labels: string[] = [];
    const fmt = (v: number) => `${v.toFixed(width < 1 ? 1 : 0)}${unit}`;
    for (let i = 0; i < bins; i++) labels.push(fmt(lo + i * width));
    for (const v of values) {
      const idx = Math.max(0, Math.min(Math.floor((v - lo) / width), bins - 1));
      counts[idx]++;
    }
    return {
      outliers,
      options: {
        ...axis,
        grid: { top: 10, right: 20, bottom: 30, left: 40 },
        xAxis: {
          type: 'category',
          data: labels,
          axisLabel: { fontSize: 9, color: '#6E6E73', hideOverlap: true },
        },
        series: [
          {
            type: 'bar',
            data: counts.map((c, i) => ({
              value: c,
              itemStyle: { color: colourFor(lo + (i + 0.5) * width), borderRadius: [4, 4, 0, 0] },
            })),
            barWidth: '80%',
          },
        ],
      },
    };
  }

  btReturnHistogram = computed<{ options: EChartsOption; subtitle: string }>(() => {
    // Wiped-out runs are excluded for the reason given on isWipedOut: one −237,828,521% row
    // stretches the bin width so every real run lands in a single bar.
    const returns = this.btSample()
      .filter((r) => r.totalReturn != null && !BacktestsPageComponent.isWipedOut(r))
      .map((r) => r.totalReturn ?? 0);
    const { options, outliers } = this.buildHistogram(returns, true);
    const wiped = this.btStats().wipedOut;
    const notes: string[] = [];
    if (outliers > 0) notes.push(`${outliers} outside P1–P99 counted in the edge bins`);
    if (wiped > 0) notes.push(`${wiped} wiped-out excluded`);
    return {
      options,
      subtitle: `Total return % across ${returns.length} runs${notes.length ? ' · ' + notes.join(' · ') : ''}`,
    };
  });

  btBySymbolOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    for (const r of this.btSample()) {
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

  btTopReturns = computed(() =>
    [...this.btSample()]
      .filter((r) => r.totalReturn != null)
      .sort((a, b) => (b.totalReturn ?? 0) - (a.totalReturn ?? 0))
      .slice(0, 8),
  );

  btPerSymbol = computed(() => {
    type Row = {
      symbol: string;
      runs: number;
      avgReturn: number | null;
      bestReturn: number | null;
      avgSharpe: number | null;
      _retSum: number;
      _retCount: number;
      _shSum: number;
      _shCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const r of this.btSample()) {
      const k = r.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = {
          symbol: k,
          runs: 0,
          avgReturn: null,
          bestReturn: null,
          avgSharpe: null,
          _retSum: 0,
          _retCount: 0,
          _shSum: 0,
          _shCount: 0,
        };
      const g = groups[k];
      g.runs++;
      if (r.totalReturn != null && !BacktestsPageComponent.isWipedOut(r)) {
        g._retSum += r.totalReturn;
        g._retCount++;
        if (g.bestReturn == null || r.totalReturn > g.bestReturn) g.bestReturn = r.totalReturn;
      }
      if (r.sharpeRatio != null && hasTrades(r)) {
        g._shSum += r.sharpeRatio;
        g._shCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        symbol: g.symbol,
        runs: g.runs,
        avgReturn: g._retCount > 0 ? +(g._retSum / g._retCount).toFixed(4) : null,
        bestReturn: g.bestReturn != null ? +g.bestReturn.toFixed(4) : null,
        avgSharpe: g._shCount > 0 ? +(g._shSum / g._shCount).toFixed(2) : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  // ── Walk-forward analytics ────────────────────────────────────────────

  /**
   * A walk-forward run whose scores are not real results. The engine's
   * "average out-of-sample score" is the mean OOS SHARPE RATIO across
   * windows (WalkForwardWorker: OosHealthScore = oosResult.SharpeRatio) and
   * "consistency" is the standard deviation of those Sharpes — neither is a
   * percentage, and consistency has no upper bound. A Sharpe of −18 is a
   * bad strategy, not a broken window; only a non-finite or absurd magnitude
   * (beyond ±100) or a negative deviation marks the run corrupt. Counted and
   * reported, never averaged or ranked.
   */
  static isWfCorrupt(r: {
    averageOutOfSampleScore: number | null;
    scoreConsistency: number | null;
  }): boolean {
    const s = r.averageOutOfSampleScore;
    const c = r.scoreConsistency;
    if (s != null && (!Number.isFinite(s) || Math.abs(s) > 100)) return true;
    if (c != null && (!Number.isFinite(c) || c < 0)) return true;
    return false;
  }

  wfStats = computed(() => {
    const all = this.wfSample();
    if (all.length === 0) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        corrupt: 0,
        avgOosScore: null as number | null,
        bestOosScore: null as number | null,
        avgConsistency: null as number | null,
        avgIsDays: 0,
        avgOosDays: 0,
      };
    }
    let completed = 0;
    let failed = 0;
    let corrupt = 0;
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
      isSum += r.inSampleDays ?? 0;
      oosDaysSum += r.outOfSampleDays ?? 0;
      if (BacktestsPageComponent.isWfCorrupt(r)) {
        corrupt++;
        continue;
      }
      if (r.averageOutOfSampleScore != null) {
        oosSum += r.averageOutOfSampleScore;
        oosCount++;
        if (r.averageOutOfSampleScore > bestOos) bestOos = r.averageOutOfSampleScore;
      }
      if (r.scoreConsistency != null) {
        consSum += r.scoreConsistency;
        consCount++;
      }
    }
    return {
      total: all.length,
      completed,
      failed,
      corrupt,
      avgOosScore: oosCount > 0 ? +(oosSum / oosCount).toFixed(4) : null,
      bestOosScore: bestOos === -Infinity ? null : +bestOos.toFixed(4),
      avgConsistency: consCount > 0 ? +(consSum / consCount).toFixed(3) : null,
      avgIsDays: Math.round(isSum / all.length),
      avgOosDays: Math.round(oosDaysSum / all.length),
    };
  });

  wfOosHistogram = computed<{ options: EChartsOption; subtitle: string }>(() => {
    const scores = this.wfSample()
      .filter((r) => r.averageOutOfSampleScore != null && !BacktestsPageComponent.isWfCorrupt(r))
      .map((r) => r.averageOutOfSampleScore ?? 0);
    const { options, outliers } = this.buildHistogram(scores, true, '');
    const corrupt = this.wfStats().corrupt;
    const notes: string[] = [];
    if (outliers > 0) notes.push(`${outliers} outside P1–P99 counted in the edge bins`);
    if (corrupt > 0) notes.push(`${corrupt} corrupt excluded`);
    return {
      options,
      subtitle: `Mean out-of-sample Sharpe across ${scores.length} runs${notes.length ? ' · ' + notes.join(' · ') : ''}`,
    };
  });

  wfBySymbolOptions = computed<EChartsOption>(() => {
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
              // Same series colour as the backtests tab — the two tabs are one page.
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  wfTopOos = computed(() =>
    [...this.wfSample()]
      .filter((r) => r.averageOutOfSampleScore != null && !BacktestsPageComponent.isWfCorrupt(r))
      .sort((a, b) => (b.averageOutOfSampleScore ?? 0) - (a.averageOutOfSampleScore ?? 0))
      .slice(0, 8),
  );

  wfPerSymbol = computed(() => {
    type Row = {
      symbol: string;
      runs: number;
      avgOos: number | null;
      bestOos: number | null;
      avgConsistency: number | null;
      _oosSum: number;
      _oosCount: number;
      _consSum: number;
      _consCount: number;
    };
    const groups: Record<string, Row> = {};
    for (const r of this.wfSample()) {
      const k = r.symbol ?? 'unknown';
      if (!groups[k])
        groups[k] = {
          symbol: k,
          runs: 0,
          avgOos: null,
          bestOos: null,
          avgConsistency: null,
          _oosSum: 0,
          _oosCount: 0,
          _consSum: 0,
          _consCount: 0,
        };
      const g = groups[k];
      g.runs++;
      if (BacktestsPageComponent.isWfCorrupt(r)) continue;
      if (r.averageOutOfSampleScore != null) {
        g._oosSum += r.averageOutOfSampleScore;
        g._oosCount++;
        if (g.bestOos == null || r.averageOutOfSampleScore > g.bestOos)
          g.bestOos = r.averageOutOfSampleScore;
      }
      if (r.scoreConsistency != null) {
        g._consSum += r.scoreConsistency;
        g._consCount++;
      }
    }
    return Object.values(groups)
      .map((g) => ({
        symbol: g.symbol,
        runs: g.runs,
        avgOos: g._oosCount > 0 ? +(g._oosSum / g._oosCount).toFixed(4) : null,
        bestOos: g.bestOos != null ? +g.bestOos.toFixed(4) : null,
        avgConsistency: g._consCount > 0 ? +(g._consSum / g._consCount).toFixed(3) : null,
      }))
      .sort((a, b) => b.runs - a.runs);
  });

  private loadBtAnalyticsSample(): void {
    this.btSampleState.set('loading');
    this.backtestsService.list(newestRowsRequest(1)).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        this.btSampleTotal.set(total);
        if (total === 0) {
          this.btSample.set([]);
          this.btSampleState.set('ready');
          return;
        }
        const size = analyticsSampleSize(total, probe?.data?.data?.[0]);
        this.backtestsService.list(newestRowsRequest(size)).subscribe({
          next: (full) => {
            this.btSample.set(full?.data?.data ?? []);
            this.btSampleState.set('ready');
          },
          error: () => this.btSampleState.set('error'),
        });
      },
      error: () => this.btSampleState.set('error'),
    });
  }

  private loadWfAnalyticsSample(): void {
    if (this.wfLoaded) return;
    this.wfLoaded = true;
    this.wfSampleState.set('loading');
    const failed = () => {
      this.wfLoaded = false;
      this.wfSampleState.set('error');
    };
    this.walkForwardService.list(newestRowsRequest(1)).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        this.wfSampleTotal.set(total);
        if (total === 0) {
          this.wfSample.set([]);
          this.wfSampleState.set('ready');
          return;
        }
        // The probe row's size bounds the download (walk-forward rows once carried ~64 KB each).
        const size = analyticsSampleSize(total, probe?.data?.data?.[0]);
        this.walkForwardService.list(newestRowsRequest(size)).subscribe({
          next: (full) => {
            this.wfSample.set(full?.data?.data ?? []);
            this.wfSampleState.set('ready');
          },
          error: failed,
        });
      },
      error: failed,
    });
  }

  /** "$10,003.01" — always two decimals with separators, never "$10,000" beside "$9,981.7". */
  private fmtMoney(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  }

  /**
   * One date format for the whole page: "Sep 5, 2026 14:07", in UTC like the run's detail page —
   * the list printed browser time, so a run "Completed Oct 18 23:05" opened as "22:05 (UTC)".
   */
  private fmtDate(v: string | null | undefined): string {
    if (!v) return '—';
    try {
      return formatDate(v, 'MMM d, yyyy HH:mm', 'en-US', 'UTC');
    } catch {
      return '—';
    }
  }

  /**
   * "$981.7M" for balances of a million and up — the backtester does not stop at ruin or riches,
   * so "$981,724,811.27" pushed the column wide. Below a million the full "$10,003.01" stays.
   * The full value is always on the cell's tooltip.
   */
  private fmtMoneyCompact(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    if (Math.abs(v) < 1_000_000) return this.fmtMoney(v);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(v);
  }

  private dateCell = (p: { value: string | null }) =>
    dateHtml(p.value, p.value ? this.fmtDate(p.value) : '—');

  // Thirteen columns at the table's 88px default minimum overflowed the ~1,110px card: the grid
  // scrolled sideways, "Final" printed "$10,000.0(" and "Completed" sat off the edge, and
  // STRATEGY wrapped mid-word. Symbol and timeframe now share one column, and every column carries
  // its own minimum (sized to its header and widest value) so sizeColumnsToFit lands inside the card.
  // Market is the one flexible column, so spare width never pools in an empty last column.
  // Cell renderers return HTML strings rendered by AG Grid outside this component's style
  // scope, so they style inline.
  backtestColumns: ColDef[] = [
    {
      field: 'id',
      headerName: 'ID',
      width: 76,
      minWidth: 70,
      cellRenderer: (p: any) => idHtml(p.value),
    },
    {
      field: 'strategyId',
      headerName: 'Strategy',
      width: 100,
      minWidth: 96,
      cellRenderer: (p: any) => idHtml(p.value),
    },
    {
      field: 'symbol',
      headerName: 'Market',
      flex: 1,
      minWidth: 120,
      cellStyle: { fontWeight: '600' },
      valueFormatter: (p: any) =>
        p.data ? `${p.data.symbol ?? '—'} · ${p.data.timeframe ?? '—'}` : (p.value ?? '—'),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 124,
      minWidth: 118,
      cellRenderer: (p: any) => statusPillHtml(p.value),
    },
    {
      field: 'totalTrades',
      headerName: 'Trades',
      width: 82,
      minWidth: 76,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p: any) => (p.value != null ? p.value : '—'),
    },
    // Win rate, PF and Sharpe of a run that closed no trade are not measured (the engine stores
    // 0.0): they read "—", not "0.0%" / "0.00".
    {
      field: 'winRate',
      headerName: 'Win %',
      width: 78,
      minWidth: 72,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p: any) =>
        p.value != null && (!p.data || hasTrades(p.data)) ? `${(p.value * 100).toFixed(1)}%` : '—',
    },
    {
      field: 'profitFactor',
      headerName: 'PF',
      width: 68,
      minWidth: 62,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p: any) =>
        !p.data || hasTrades(p.data) ? this.fmtProfitFactor(p.value) : '—',
    },
    {
      field: 'sharpeRatio',
      headerName: 'Sharpe',
      width: 82,
      minWidth: 76,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p: any) =>
        p.value != null && (!p.data || hasTrades(p.data)) ? p.value.toFixed(2) : '—',
    },
    {
      field: 'maxDrawdownPct',
      headerName: 'Max DD',
      width: 86,
      minWidth: 80,
      type: 'rightAligned',
      cellStyle: { ...NUM_CELL, color: 'var(--text-secondary)' },
      valueFormatter: (p: any) => (p.value != null ? `${p.value.toFixed(2)}%` : '—'),
    },
    {
      field: 'totalReturn',
      headerName: 'Return',
      width: 96,
      minWidth: 90,
      type: 'rightAligned',
      cellStyle: (p: any) => signedStyle(p.value),
      valueFormatter: (p: any) => this.signedPct(p.value),
    },
    {
      field: 'finalBalance',
      headerName: 'Final',
      width: 112,
      minWidth: 104,
      type: 'rightAligned',
      cellRenderer: (p: any) =>
        `<span title="${esc(this.fmtMoney(p.value))}" style="font-variant-numeric:tabular-nums">` +
        `${esc(this.fmtMoneyCompact(p.value))}</span>`,
    },
    {
      field: 'completedAt',
      headerName: 'Completed (UTC)',
      width: 170,
      minWidth: 160,
      cellRenderer: this.dateCell,
    },
  ];

  walkForwardColumns: ColDef[] = [
    {
      field: 'id',
      headerName: 'ID',
      width: 76,
      minWidth: 70,
      cellRenderer: (p: any) => idHtml(p.value),
    },
    {
      field: 'strategyId',
      headerName: 'Strategy',
      width: 100,
      minWidth: 96,
      cellRenderer: (p: any) => idHtml(p.value),
    },
    {
      field: 'symbol',
      headerName: 'Symbol',
      flex: 1,
      minWidth: 100,
      cellStyle: { fontWeight: '600' },
    },
    { field: 'timeframe', headerName: 'TF', width: 70, minWidth: 64 },
    {
      field: 'status',
      headerName: 'Status',
      width: 124,
      minWidth: 118,
      // Same pill as the backtests tab — Failed was plain text here.
      cellRenderer: (p: any) => statusPillHtml(p.value),
    },
    {
      field: 'inSampleDays',
      headerName: 'IS days',
      width: 95,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
    },
    {
      field: 'outOfSampleDays',
      headerName: 'OOS days',
      width: 105,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
    },
    {
      field: 'averageOutOfSampleScore',
      headerName: 'Avg OOS Sharpe',
      width: 130,
      type: 'rightAligned',
      cellStyle: (p: any) => signedStyle(p.value),
      valueFormatter: (p: any) => this.signedRatio(p.value),
    },
    {
      field: 'scoreConsistency',
      headerName: 'Consistency',
      width: 125,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p: any) => (p.value != null ? p.value.toFixed(3) : '—'),
    },
    {
      field: 'startedAt',
      headerName: 'Started (UTC)',
      width: 170,
      minWidth: 160,
      cellRenderer: this.dateCell,
    },
  ];

  fetchBacktests = (params: PagerRequest): Observable<PagedData<BacktestRunDto>> => {
    return this.backtestsService.list(params).pipe(
      map(
        (res: ResponseData<PagedData<BacktestRunDto>>) =>
          res.data ?? {
            pager: {
              totalItemCount: 0,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 0,
              pageSize: 25,
              filter: null,
            },
            data: [],
          },
      ),
    );
  };

  fetchWalkForward = (params: PagerRequest): Observable<PagedData<WalkForwardRunDto>> => {
    return this.walkForwardService.list(params).pipe(
      map(
        (res: ResponseData<PagedData<WalkForwardRunDto>>) =>
          res.data ?? {
            pager: {
              totalItemCount: 0,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 0,
              pageSize: 25,
              filter: null,
            },
            data: [],
          },
      ),
    );
  };

  onBacktestClick(row: BacktestRunDto) {
    this.router.navigate(['/backtests', row.id]);
  }

  onWalkForwardClick(row: WalkForwardRunDto) {
    this.router.navigate(['/walk-forward', row.id]);
  }

  /**
   * Queues the run and reports the ENGINE's verdict: a refusal arrives as `status: false` with its reason (unknown
   * strategy, a symbol/timeframe that is not the strategy's own, a script that no longer compiles…) and used to be
   * shown as "queued successfully". A run on another market is sent as an explicit override.
   */
  queueBacktest() {
    const symbol = this.normalizedSymbol();
    const own = this.strategyInfo();
    const req: CreateBacktestRequest = {
      strategyId: this.formData.strategyId,
      symbol,
      timeframe: this.formData.timeframe,
      initialBalance: this.formData.initialBalance,
      fromDate: this.formData.fromDate,
      toDate: this.formData.toDate,
    };
    if (own && own.id === this.formData.strategyId) {
      req.symbol = own.symbol;
      req.timeframe = own.timeframe;
      if (symbol && symbol !== own.symbol) req.symbolOverride = symbol;
      if (this.formData.timeframe !== own.timeframe)
        req.timeframeOverride = this.formData.timeframe;
    }
    this.queueing.set(true);
    this.queueError.set(null);
    this.backtestsService.create(req).subscribe({
      next: (res) => {
        this.queueing.set(false);
        if (!res?.status) {
          const msg = res?.message || 'The engine refused the backtest';
          this.queueError.set(msg);
          this.notifications.error(msg);
          return;
        }
        this.notifications.success(res.data ? `Backtest #${res.data} queued` : 'Backtest queued');
        this.showForm.set(false);
        this.btTable()?.loadData();
      },
      error: (err: unknown) => {
        this.queueing.set(false);
        const msg = (err as { message?: string })?.message || 'Failed to queue backtest';
        this.queueError.set(msg);
        this.notifications.error(msg);
      },
    });
  }
}
