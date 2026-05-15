import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, merge, of, throttleTime } from 'rxjs';

import { WalkForwardService } from '@core/services/walk-forward.service';
import type { WalkForwardRunDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RealtimeService } from '@core/realtime/realtime.service';

import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
// Re-used straight from the backtest feature — same dialog, same payload
// shape. The walk-forward report just needs to surface trades-per-fold and
// hand them to the same drilldown.
import {
  TradeReplayDialogComponent,
  type ReplayTrade,
} from '../../../backtests/components/trade-replay-dialog/trade-replay-dialog.component';
import type { EChartsOption } from 'echarts';

// ── Window record ─────────────────────────────────────────────────────────
// Mirrors WalkForwardWorker.WindowResult. PascalCase to match wire format.
// There is no in-sample score field — the engine only reports OOS metrics
// per window; in-sample is the period the optimisation parameters were fit
// against, not separately scored against a benchmark.
interface WindowTrade {
  Direction: number; // 0 = Buy / Long, 1 = Sell / Short
  EntryPrice: number;
  ExitPrice: number;
  LotSize: number;
  PnL: number;
  EntryTime: string;
  ExitTime: string;
  ExitReason: number; // 0 = SL, 1 = TP, 2 = EndOfData
  StopLoss?: number | null;
  TakeProfit?: number | null;
}

interface WindowResult {
  WindowIndex: number;
  InSampleFrom: string;
  InSampleTo: string;
  OutOfSampleFrom: string;
  OutOfSampleTo: string;
  OosHealthScore: number;
  OosTotalTrades: number;
  OosWinRate: number; // 0..1
  OosProfitFactor: number;
  UsedParametersJson?: string | null;
  Trades?: WindowTrade[] | null;
}

interface WindowDerived extends WindowResult {
  params: Record<string, number>;
  oosStartMs: number;
  oosEndMs: number;
  isStartMs: number;
  isEndMs: number;
  trades: WindowTrade[];
}

@Component({
  selector: 'app-walk-forward-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    StatusBadgeComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    ChartCardComponent,
    MetricCardComponent,
    TradeReplayDialogComponent,
  ],
  template: `
    <div class="page">
      <!-- Title row renders as soon as we know the id, even before the API
           returns. Keeps the page from looking broken during the first
           fetch. The status badge fills in when run() resolves. -->
      <div class="title-row">
        <div class="title-left">
          <button type="button" class="btn-back" (click)="goBack()" aria-label="Back">←</button>
          <h1 class="title">Walk-Forward Run #{{ id() ?? '—' }}</h1>
          @if (run(); as r) {
            <app-status-badge [status]="r.status" type="run" />
          }
        </div>
        @if (run(); as r) {
          <div class="title-right muted">
            {{ r.symbol ?? '—' }} · {{ r.timeframe }} · {{ r.inSampleDays }}d IS /
            {{ r.outOfSampleDays }}d OOS
          </div>
        }
      </div>

      @if (loading() && !run()) {
        <app-card-skeleton [lines]="10" />
      } @else if (run(); as r) {
        @if (r.errorMessage) {
          <div class="error"><strong>Error:</strong> {{ r.errorMessage }}</div>
        }

        <!-- ── KPI strip ───────────────────────────────────────────────── -->
        <div class="kpi-strip">
          <app-metric-card
            label="Windows"
            [value]="windows().length"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Avg OOS Score"
            [value]="r.averageOutOfSampleScore"
            format="number"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Consistency"
            [value]="r.scoreConsistency"
            format="number"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Avg OOS Win Rate"
            [value]="aggregates().avgWr"
            format="percent"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Avg OOS PF"
            [value]="aggregates().avgPf"
            format="number"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Total OOS Trades"
            [value]="aggregates().totalTrades"
            format="number"
            dotColor="#AF52DE"
          />
        </div>

        @if (windows().length > 0) {
          <!-- ── Score timeline ───────────────────────────────────────── -->
          <div class="charts-grid">
            <app-chart-card
              title="OOS Health Score per Window"
              subtitle="Annualised Sharpe over each out-of-sample slice — sign indicates bias"
              [options]="scoreOptions()"
              height="320px"
            />
            <app-chart-card
              title="OOS Profit Factor per Window"
              subtitle="Gross profit ÷ gross loss, by fold (1.0 break-even)"
              [options]="pfOptions()"
              height="320px"
            />
          </div>

          <div class="charts-grid">
            <app-chart-card
              title="OOS Win Rate per Window"
              subtitle="Hit rate by fold — flat line = consistent regime fit"
              [options]="wrOptions()"
              height="280px"
            />
            <app-chart-card
              title="OOS Trade Count per Window"
              subtitle="Number of trades the strategy fired in each OOS slice"
              [options]="tradesOptions()"
              height="280px"
            />
          </div>

          <!-- ── IS/OOS timeline ─────────────────────────────────────── -->
          <app-chart-card
            title="In-Sample / Out-of-Sample Timeline"
            subtitle="Calendar layout of training and evaluation windows — overlap = anchored walk-forward"
            [options]="timelineOptions()"
            height="280px"
          />

          <!-- ── Parameter stability ─────────────────────────────────── -->
          @if (parameterKeys().length > 0) {
            <app-chart-card
              title="Parameter Stability Across Windows"
              subtitle="Each line is one parameter, min-max normalised across folds — flat = stable, jagged = re-tuning per fold"
              [options]="paramStabilityOptions()"
              height="320px"
            />
          }

          <!-- ── Trade log (cross-window) ────────────────────────────── -->
          @if (totalTradeCount() > 0) {
            <section class="card">
              <header class="card-head">
                <h3>Trade Log</h3>
                <div class="trade-log-controls">
                  <span class="muted">
                    {{ tradeFilteredCount() }} of {{ totalTradeCount() }} trades
                  </span>
                  <div class="filter-pills">
                    <button
                      type="button"
                      class="filter-pill"
                      [class.active]="tradeFilter() === 'all'"
                      (click)="tradeFilter.set('all')"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      class="filter-pill"
                      [class.active]="tradeFilter() === 'wins'"
                      (click)="tradeFilter.set('wins')"
                    >
                      Wins
                    </button>
                    <button
                      type="button"
                      class="filter-pill"
                      [class.active]="tradeFilter() === 'losses'"
                      (click)="tradeFilter.set('losses')"
                    >
                      Losses
                    </button>
                    <button
                      type="button"
                      class="filter-pill"
                      [class.active]="tradeFilter() === 'long'"
                      (click)="tradeFilter.set('long')"
                    >
                      Long
                    </button>
                    <button
                      type="button"
                      class="filter-pill"
                      [class.active]="tradeFilter() === 'short'"
                      (click)="tradeFilter.set('short')"
                    >
                      Short
                    </button>
                  </div>
                  <select
                    class="window-select"
                    [value]="tradeWindowFilter()"
                    (change)="tradeWindowFilter.set(asNumber($any($event.target).value))"
                  >
                    <option [value]="-1">All windows</option>
                    @for (w of windows(); track w.WindowIndex) {
                      <option [value]="w.WindowIndex">W{{ w.WindowIndex + 1 }}</option>
                    }
                  </select>
                </div>
              </header>
              <div class="trade-table-wrap">
                <table class="trade-table">
                  <thead>
                    <tr>
                      <th>Fold</th>
                      <th>#</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Side</th>
                      <th class="num">Entry Px</th>
                      <th class="num">Exit Px</th>
                      <th class="num">SL</th>
                      <th class="num">TP</th>
                      <th class="num">Lots</th>
                      <th class="num">P&L</th>
                      <th>Exit</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (t of pagedTrades(); track $index) {
                      <tr class="trade-row" (click)="openReplay(t.trade, t.window, t.idx)">
                        <td class="mono">W{{ t.window + 1 }}</td>
                        <td class="mono">#{{ t.idx }}</td>
                        <td class="nowrap">{{ t.trade.EntryTime | date: 'MMM d HH:mm' }}</td>
                        <td class="nowrap">{{ t.trade.ExitTime | date: 'MMM d HH:mm' }}</td>
                        <td>
                          <span
                            class="dir-pill"
                            [class.long]="t.trade.Direction === 0"
                            [class.short]="t.trade.Direction === 1"
                            >{{ t.trade.Direction === 0 ? 'LONG' : 'SHORT' }}</span
                          >
                        </td>
                        <td class="num mono">{{ t.trade.EntryPrice | number: '1.5-5' }}</td>
                        <td class="num mono">{{ t.trade.ExitPrice | number: '1.5-5' }}</td>
                        <td class="num mono">
                          {{
                            t.trade.StopLoss !== null ? (t.trade.StopLoss | number: '1.5-5') : '—'
                          }}
                        </td>
                        <td class="num mono">
                          {{
                            t.trade.TakeProfit !== null
                              ? (t.trade.TakeProfit | number: '1.5-5')
                              : '—'
                          }}
                        </td>
                        <td class="num mono">{{ t.trade.LotSize | number: '1.2-2' }}</td>
                        <td
                          class="num mono"
                          [class.gain]="t.trade.PnL > 0"
                          [class.loss]="t.trade.PnL < 0"
                        >
                          {{ t.trade.PnL >= 0 ? '+' : '' }}{{ t.trade.PnL | number: '1.2-2' }}
                        </td>
                        <td>
                          <span class="reason-pill" [class]="exitReasonClass(t.trade.ExitReason)">{{
                            exitReasonShort(t.trade.ExitReason)
                          }}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            class="view-btn"
                            (click)="openReplay(t.trade, t.window, t.idx); $event.stopPropagation()"
                          >
                            View chart
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <footer class="trade-pager">
                <span class="muted"
                  >Showing {{ pageStart() }}–{{ pageEnd() }} of {{ tradeFilteredCount() }}</span
                >
                <div class="pager-buttons">
                  <button
                    type="button"
                    class="pager-btn"
                    [disabled]="tradePage() === 1"
                    (click)="tradePage.set(tradePage() - 1)"
                  >
                    ← Prev
                  </button>
                  <button
                    type="button"
                    class="pager-btn"
                    [disabled]="pageEnd() >= tradeFilteredCount()"
                    (click)="tradePage.set(tradePage() + 1)"
                  >
                    Next →
                  </button>
                </div>
              </footer>
            </section>
          } @else if (r.status === 'Completed') {
            <div class="note">
              Per-window trade log isn't available on this run. It was either produced by an older
              engine build (before the trade payload was persisted per fold) or every fold was
              skipped by the
              <code>MinTradesPerFold</code> gate. Re-run to populate.
            </div>
          }

          <!-- ── Window detail table ─────────────────────────────────── -->
          <section class="card">
            <header class="card-head">
              <h3>Window Detail</h3>
              <span class="muted"
                >{{ windows().length }} fold{{ windows().length === 1 ? '' : 's' }}</span
              >
            </header>
            <div class="table-wrap">
              <table class="windows">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>In-Sample</th>
                    <th>Out-of-Sample</th>
                    <th class="num">Score</th>
                    <th class="num">PF</th>
                    <th class="num">Win Rate</th>
                    <th class="num">Trades</th>
                  </tr>
                </thead>
                <tbody>
                  @for (w of windows(); track w.WindowIndex) {
                    <tr>
                      <td class="mono">{{ w.WindowIndex + 1 }}</td>
                      <td>
                        {{ w.InSampleFrom | date: 'MMM d' }} —
                        {{ w.InSampleTo | date: 'MMM d, yyyy' }}
                      </td>
                      <td>
                        {{ w.OutOfSampleFrom | date: 'MMM d' }} —
                        {{ w.OutOfSampleTo | date: 'MMM d, yyyy' }}
                      </td>
                      <td
                        class="num mono"
                        [class.gain]="w.OosHealthScore > 0"
                        [class.loss]="w.OosHealthScore < 0"
                      >
                        {{ w.OosHealthScore | number: '1.2-2' }}
                      </td>
                      <td class="num mono">{{ w.OosProfitFactor | number: '1.2-2' }}</td>
                      <td class="num mono">{{ w.OosWinRate * 100 | number: '1.1-1' }}%</td>
                      <td class="num mono">{{ w.OosTotalTrades }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        } @else {
          <!-- Status-aware banner replaces the silent empty state. Failed
               and pending runs reach this branch — show what's going on
               instead of a blank page. -->
          @if (r.status === 'Completed') {
            <div class="note warning">
              Run completed but no per-window results are attached. The engine usually populates
              this when there's enough history to fit at least one in-sample / out-of-sample pair —
              check the strategy date range vs the IS/OOS day budget.
            </div>
          } @else if (r.status === 'Failed') {
            <div class="note danger">
              Run failed before producing any windows.
              @if (r.errorMessage) {
                Reason: <strong>{{ r.errorMessage }}</strong>
              } @else {
                No error message captured.
              }
            </div>
          } @else {
            <div class="note">
              Run is <strong>{{ r.status }}</strong> — windows will appear here as each fold
              completes. This page polls every 30 s.
            </div>
          }
        }

        <!-- ── Run config card (always rendered) ───────────────────── -->
        <section class="card">
          <header class="card-head"><h3>Run Configuration</h3></header>
          <dl class="cfg-grid">
            <div class="cfg-item">
              <dt>Strategy</dt>
              <dd>#{{ r.strategyId }}</dd>
            </div>
            <div class="cfg-item">
              <dt>Initial Balance</dt>
              <dd class="mono">{{ r.initialBalance | number: '1.2-2' }}</dd>
            </div>
            <div class="cfg-item">
              <dt>Period</dt>
              <dd>
                {{ r.fromDate | date: 'MMM d, yyyy' }} —
                {{ r.toDate | date: 'MMM d, yyyy' }}
              </dd>
            </div>
            <div class="cfg-item">
              <dt>Started</dt>
              <dd>{{ r.startedAt | date: 'medium' }}</dd>
            </div>
            <div class="cfg-item">
              <dt>Completed</dt>
              <dd>{{ r.completedAt ? (r.completedAt | date: 'medium') : '—' }}</dd>
            </div>
            <div class="cfg-item">
              <dt>IS / OOS Days</dt>
              <dd>{{ r.inSampleDays }} d / {{ r.outOfSampleDays }} d</dd>
            </div>
          </dl>
        </section>
      } @else {
        <app-error-state
          title="Walk-forward run not found"
          [message]="errorMessage()"
          retryLabel="Back"
          (retry)="goBack()"
        />
      }

      <!-- Trade-replay dialog (mounted once; input drives open/close). -->
      <app-trade-replay-dialog
        [trade]="replayTrade()"
        [symbol]="run()?.symbol ?? ''"
        [timeframe]="run()?.timeframe ?? 'H1'"
        (closed)="replayTrade.set(null)"
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
      .title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
      }
      .title-left {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .title-right {
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .btn-back {
        width: 32px;
        height: 32px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        cursor: pointer;
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
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-4);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
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
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .cfg-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        margin: 0;
      }
      .cfg-item {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cfg-item:nth-child(3n) {
        border-right: none;
      }
      .cfg-item dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .cfg-item dd {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
        margin: 0;
      }
      .table-wrap {
        max-height: 480px;
        overflow: auto;
      }
      .windows {
        width: 100%;
        border-collapse: collapse;
      }
      .windows th,
      .windows td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .windows th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
      }
      .windows th.num,
      .windows td.num {
        text-align: right;
      }
      .windows td.mono,
      .cfg-item dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .windows td.gain {
        color: var(--color-success, #34c759);
      }
      .windows td.loss {
        color: var(--color-danger, #ff3b30);
      }
      .error {
        padding: var(--space-4) var(--space-5);
        background: rgba(255, 59, 48, 0.06);
        border: 1px solid rgba(255, 59, 48, 0.2);
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .note {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .note.warning {
        background: rgba(255, 149, 0, 0.06);
        border-color: rgba(255, 149, 0, 0.3);
        border-style: solid;
      }
      .note.danger {
        background: rgba(255, 59, 48, 0.06);
        border-color: rgba(255, 59, 48, 0.3);
        border-style: solid;
        color: var(--text-primary);
      }
      @media (max-width: 1200px) {
        .kpi-strip {
          grid-template-columns: repeat(3, 1fr);
        }
        .cfg-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .cfg-item:nth-child(3n) {
          border-right: 1px solid var(--border);
        }
      }
      @media (max-width: 768px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
        .cfg-grid {
          grid-template-columns: 1fr;
        }
        .cfg-item {
          border-right: none;
        }
      }
      /* ── Trade log ───────────────────────────────────────────────── */
      .trade-log-controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .filter-pills {
        display: flex;
        gap: var(--space-1);
      }
      .filter-pill {
        padding: 4px 10px;
        font-size: var(--text-xs);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .filter-pill:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .filter-pill.active {
        background: #0071e3;
        color: #fff;
        border-color: #0071e3;
      }
      .window-select {
        padding: 4px 10px;
        font-size: var(--text-xs);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .trade-table-wrap {
        max-height: 520px;
        overflow: auto;
      }
      .trade-table {
        width: 100%;
        border-collapse: collapse;
      }
      .trade-table th,
      .trade-table td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
        white-space: nowrap;
      }
      .trade-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .trade-table th.num,
      .trade-table td.num {
        text-align: right;
      }
      .trade-table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .trade-table td.gain {
        color: var(--color-success, #34c759);
      }
      .trade-table td.loss {
        color: var(--color-danger, #ff3b30);
      }
      .trade-row {
        cursor: pointer;
      }
      .trade-row:hover {
        background: var(--bg-tertiary);
      }
      .dir-pill {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .dir-pill.long {
        background: rgba(0, 113, 227, 0.12);
        color: #0071e3;
      }
      .dir-pill.short {
        background: rgba(255, 107, 53, 0.14);
        color: #ff6b35;
      }
      .reason-pill {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .reason-pill.sl {
        background: rgba(255, 59, 48, 0.12);
        color: #ff3b30;
      }
      .reason-pill.tp {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .reason-pill.eod {
        background: rgba(142, 142, 147, 0.18);
        color: #6e6e73;
      }
      .view-btn {
        padding: 4px 10px;
        font-size: var(--text-xs);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .view-btn:hover {
        background: #0071e3;
        color: #fff;
        border-color: #0071e3;
      }
      .trade-pager {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-5);
        border-top: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .pager-buttons {
        display: flex;
        gap: var(--space-2);
      }
      .pager-btn {
        padding: 4px 10px;
        font-size: var(--text-sm);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .pager-btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .nowrap {
        white-space: nowrap;
      }
    `,
  ],
})
export class WalkForwardDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(WalkForwardService);
  private readonly realtime = inject(RealtimeService);

  readonly errorMessage = signal<string | null>(null);
  readonly id = signal<number | null>(null);

  private readonly resource = createPolledResource(
    () => {
      const id = this.id();
      if (!id) return of(null as WalkForwardRunDto | null);
      return this.service.getById(id).pipe(
        map((res) => res.data ?? null),
        catchError(() => of(null as WalkForwardRunDto | null)),
      );
    },
    { intervalMs: 30_000 },
  );

  constructor() {
    // Each finished window emits `backtestCompleted`; whole run completion
    // emits `optimizationCompleted`. Push-refresh so live folds tick in.
    merge(this.realtime.on('backtestCompleted'), this.realtime.on('optimizationCompleted'))
      .pipe(throttleTime(5_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.resource.refresh());

    // Reset the table to page 1 whenever the filter or the window selector
    // changes — otherwise switching from "All" page 5 to a fold with 12
    // trades leaves the operator past the last page.
    effect(() => {
      this.tradeFilter();
      this.tradeWindowFilter();
      this.tradePage.set(1);
    });
  }

  readonly run = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  readonly windows = computed<WindowDerived[]>(() => {
    const r = this.run();
    if (!r?.windowResultsJson) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(r.windowResultsJson);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: WindowDerived[] = [];
    for (const item of raw as Record<string, unknown>[]) {
      const tradesRaw = item['Trades'];
      const trades = Array.isArray(tradesRaw) ? (tradesRaw as WindowTrade[]) : [];
      const w: WindowResult = {
        WindowIndex: numberOr(item['WindowIndex'], out.length),
        InSampleFrom: stringOr(item['InSampleFrom'], ''),
        InSampleTo: stringOr(item['InSampleTo'], ''),
        OutOfSampleFrom: stringOr(item['OutOfSampleFrom'], ''),
        OutOfSampleTo: stringOr(item['OutOfSampleTo'], ''),
        OosHealthScore: numberOr(item['OosHealthScore'], 0),
        OosTotalTrades: numberOr(item['OosTotalTrades'], 0),
        OosWinRate: numberOr(item['OosWinRate'], 0),
        OosProfitFactor: numberOr(item['OosProfitFactor'], 0),
        UsedParametersJson: (item['UsedParametersJson'] as string | null | undefined) ?? null,
        Trades: trades,
      };
      const params = parseParams(w.UsedParametersJson);
      out.push({
        ...w,
        params,
        oosStartMs: parseTime(w.OutOfSampleFrom),
        oosEndMs: parseTime(w.OutOfSampleTo),
        isStartMs: parseTime(w.InSampleFrom),
        isEndMs: parseTime(w.InSampleTo),
        trades,
      });
    }
    return out.sort((a, b) => a.WindowIndex - b.WindowIndex);
  });

  // ── Trade log state ──────────────────────────────────────────────────
  /** Filter chip selection for the cross-window trade log. */
  readonly tradeFilter = signal<'all' | 'wins' | 'losses' | 'long' | 'short'>('all');
  /** -1 = all windows; otherwise the WindowIndex to scope the table to. */
  readonly tradeWindowFilter = signal<number>(-1);
  readonly tradePage = signal(1);
  readonly tradesPerPage = 25;
  readonly replayTrade = signal<ReplayTrade | null>(null);

  /** Flattened cross-window trade list with stable 1-based numbering per
   *  fold ("W3 #12"). Numbering is scoped to each window so a trade can be
   *  unambiguously identified even after filtering or sorting. */
  readonly allTrades = computed<{ trade: WindowTrade; window: number; idx: number }[]>(() => {
    const out: { trade: WindowTrade; window: number; idx: number }[] = [];
    for (const w of this.windows()) {
      const sorted = [...w.trades].sort((a, b) => Date.parse(a.ExitTime) - Date.parse(b.ExitTime));
      sorted.forEach((t, i) => {
        out.push({ trade: t, window: w.WindowIndex, idx: i + 1 });
      });
    }
    return out;
  });

  readonly tradeFilteredCount = computed(() => this.filteredTrades().length);
  readonly totalTradeCount = computed(() => this.allTrades().length);

  readonly filteredTrades = computed(() => {
    const all = this.allTrades();
    const fw = this.tradeWindowFilter();
    const filter = this.tradeFilter();
    let list = fw === -1 ? all : all.filter((x) => x.window === fw);
    switch (filter) {
      case 'wins':
        list = list.filter((x) => x.trade.PnL > 0);
        break;
      case 'losses':
        list = list.filter((x) => x.trade.PnL <= 0);
        break;
      case 'long':
        list = list.filter((x) => x.trade.Direction === 0);
        break;
      case 'short':
        list = list.filter((x) => x.trade.Direction === 1);
        break;
    }
    return list;
  });

  readonly pagedTrades = computed(() => {
    const list = this.filteredTrades();
    const page = this.tradePage();
    const start = (page - 1) * this.tradesPerPage;
    return list.slice(start, start + this.tradesPerPage);
  });

  readonly pageStart = computed(() =>
    this.filteredTrades().length === 0 ? 0 : (this.tradePage() - 1) * this.tradesPerPage + 1,
  );
  readonly pageEnd = computed(() =>
    Math.min(this.tradePage() * this.tradesPerPage, this.filteredTrades().length),
  );

  openReplay(trade: WindowTrade, window: number, idx: number): void {
    this.replayTrade.set({
      ...trade,
      // Carry the fold + per-fold index into the dialog header.
      index: idx,
    } as ReplayTrade);
    // Store the fold context for the dialog header via the symbol prefix —
    // dialog already shows symbol + tf so we don't need a separate output.
    this.replayTradeWindow.set(window);
  }

  /** Window id of the trade currently being replayed (for the dialog header label). */
  readonly replayTradeWindow = signal<number>(-1);

  exitReasonShort(reason: number): string {
    return reason === 0 ? 'SL' : reason === 1 ? 'TP' : 'EOD';
  }

  exitReasonClass(reason: number): string {
    return reason === 0 ? 'sl' : reason === 1 ? 'tp' : 'eod';
  }

  /** <select> values come through as string — coerce to number for the
   *  window filter signal which stores a numeric WindowIndex (or -1). */
  asNumber(raw: string): number {
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }

  readonly aggregates = computed(() => {
    const w = this.windows();
    if (!w.length) return { avgWr: 0, avgPf: 0, totalTrades: 0 };
    const totalTrades = w.reduce((acc, x) => acc + x.OosTotalTrades, 0);
    const wrSum = w.reduce((acc, x) => acc + x.OosWinRate, 0);
    const pfSum = w.reduce((acc, x) => acc + x.OosProfitFactor, 0);
    return {
      avgWr: +((wrSum / w.length) * 100).toFixed(2),
      avgPf: +(pfSum / w.length).toFixed(2),
      totalTrades,
    };
  });

  readonly parameterKeys = computed<string[]>(() => {
    const w = this.windows();
    const set = new Set<string>();
    for (const x of w) for (const k of Object.keys(x.params)) set.add(k);
    return [...set];
  });

  // ── Charts ──────────────────────────────────────────────────────────

  private windowLabels = computed(() => this.windows().map((w) => `W${w.WindowIndex + 1}`));

  scoreOptions = computed<EChartsOption>(() => {
    const w = this.windows();
    if (!w.length) return emptyChart();
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: this.windowLabels(), axisLabel: { fontSize: 11 } },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: w.map((x) => ({
            value: +x.OosHealthScore.toFixed(3),
            itemStyle: {
              color: x.OosHealthScore >= 0 ? '#34C759' : '#FF3B30',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            data: [{ yAxis: 0, lineStyle: { color: 'rgba(0,0,0,0.2)', type: 'dashed' } }],
          },
          barWidth: '60%',
        },
      ],
    };
  });

  pfOptions = computed<EChartsOption>(() => {
    const w = this.windows();
    if (!w.length) return emptyChart();
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: this.windowLabels(), axisLabel: { fontSize: 11 } },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: w.map((x) => ({
            value: +x.OosProfitFactor.toFixed(2),
            itemStyle: {
              color: x.OosProfitFactor >= 1 ? '#34C759' : '#FF3B30',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          markLine: {
            silent: true,
            symbol: 'none',
            label: {
              show: true,
              position: 'middle',
              formatter: 'break-even',
              fontSize: 10,
              color: '#8E8E93',
            },
            data: [{ yAxis: 1, lineStyle: { color: 'rgba(0,0,0,0.2)', type: 'dashed' } }],
          },
          barWidth: '60%',
        },
      ],
    };
  });

  wrOptions = computed<EChartsOption>(() => {
    const w = this.windows();
    if (!w.length) return emptyChart();
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '—'),
      },
      xAxis: { type: 'category', data: this.windowLabels(), axisLabel: { fontSize: 11 } },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'line',
          data: w.map((x) => +(x.OosWinRate * 100).toFixed(2)),
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: { color: '#34C759', width: 2 },
          itemStyle: { color: '#34C759' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(52,199,89,0.18)' },
                { offset: 1, color: 'rgba(52,199,89,0)' },
              ],
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            data: [{ yAxis: 50, lineStyle: { color: 'rgba(0,0,0,0.2)', type: 'dashed' } }],
          },
        },
      ],
    };
  });

  tradesOptions = computed<EChartsOption>(() => {
    const w = this.windows();
    if (!w.length) return emptyChart();
    return {
      grid: { top: 20, right: 20, bottom: 40, left: 50 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: this.windowLabels(), axisLabel: { fontSize: 11 } },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: w.map((x) => ({
            value: x.OosTotalTrades,
            itemStyle: { color: '#5AC8FA', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
        },
      ],
    };
  });

  timelineOptions = computed<EChartsOption>(() => {
    const w = this.windows();
    if (!w.length) return emptyChart();
    // Each fold contributes two horizontal segments: blue for IS, green for
    // OOS, on a y-row matching the window index. We render with custom bars
    // (renderItem) to draw arbitrary [startMs, endMs] segments.
    const data: any[] = [];
    w.forEach((x, i) => {
      data.push({ value: [i, x.isStartMs, x.isEndMs, 'IS'], itemStyle: { color: '#0071E3' } });
      data.push({ value: [i, x.oosStartMs, x.oosEndMs, 'OOS'], itemStyle: { color: '#34C759' } });
    });
    return {
      grid: { top: 20, right: 30, bottom: 40, left: 70 },
      tooltip: {
        formatter: (p: any) => {
          const v = p?.value as [number, number, number, string] | undefined;
          if (!v) return '';
          return `W${v[0] + 1} · ${v[3]}<br/>${new Date(v[1]).toISOString().slice(0, 10)} → ${new Date(
            v[2],
          )
            .toISOString()
            .slice(0, 10)}`;
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: this.windowLabels(),
        inverse: true,
        axisLabel: { fontSize: 11 },
      },
      series: [
        {
          type: 'custom',
          renderItem: (_params: any, api: any) => {
            const yIdx = api.value(0);
            const start = api.coord([api.value(1), yIdx]);
            const end = api.coord([api.value(2), yIdx]);
            const height = api.size([0, 1])[1] * 0.5;
            return {
              type: 'rect',
              shape: {
                x: start[0],
                y: start[1] - height / 2,
                width: end[0] - start[0],
                height,
              },
              style: api.style(),
            };
          },
          encode: { x: [1, 2], y: 0 },
          data,
        },
      ],
    };
  });

  paramStabilityOptions = computed<EChartsOption>(() => {
    const w = this.windows();
    const keys = this.parameterKeys();
    if (!w.length || !keys.length) return emptyChart();
    const palette = ['#0071E3', '#34C759', '#FF9500', '#AF52DE', '#FF3B30', '#5AC8FA', '#FFCC00'];
    const series = keys.map((key, i) => {
      const raw = w.map((x) => x.params[key] ?? NaN);
      const valid = raw.filter((v) => Number.isFinite(v));
      const min = valid.length ? Math.min(...valid) : 0;
      const max = valid.length ? Math.max(...valid) : 1;
      const range = max - min || 1;
      const data = raw.map((v) =>
        Number.isFinite(v) ? +(((v - min) / range) * 100).toFixed(2) : null,
      );
      return {
        name: key,
        type: 'line' as const,
        data,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: palette[i % palette.length], width: 1.6 },
        itemStyle: { color: palette[i % palette.length] },
        connectNulls: true,
      };
    });
    return {
      grid: { top: 20, right: 20, bottom: 60, left: 50 },
      legend: { bottom: 0, fontSize: 11, type: 'scroll' },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!Array.isArray(params)) return '';
          const idx = params[0]?.dataIndex ?? 0;
          const window = w[idx];
          const lines = [`<strong>W${(window?.WindowIndex ?? idx) + 1}</strong>`];
          for (const p of params) {
            const key = p?.seriesName as string;
            const realValue = key && window ? window.params[key] : undefined;
            const norm = p?.value;
            const realFmt = typeof realValue === 'number' ? realValue.toFixed(3) : '—';
            lines.push(
              `<span style="color:${p.color}">●</span> ${key}: ${realFmt}` +
                (typeof norm === 'number'
                  ? ` <span style="color:#8E8E93">(${norm.toFixed(0)}%)</span>`
                  : ''),
            );
          }
          return lines.join('<br/>');
        },
      },
      xAxis: { type: 'category', data: this.windowLabels(), axisLabel: { fontSize: 11 } },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series,
    };
  });

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || Number.isNaN(id)) {
      this.errorMessage.set('Invalid run id');
      return;
    }
    this.id.set(id);
    // createPolledResource fires its initial fetch at field-init time —
    // which runs before ngOnInit, so `this.id()` was null and the first
    // call returned `of(null)`. Kick a manual refresh now that the id is
    // known; without this the page sits empty for up to 30s until the
    // polling interval fires.
    this.resource.refresh();
  }

  goBack(): void {
    this.router.navigate(['/walk-forward']);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Parameters land as a nested JSON string under UsedParametersJson; pull
 *  out every numeric leaf so the stability chart can plot them. Non-number
 *  parameter values (booleans, strings) are skipped — they aren't trend-able. */
function parseParams(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function emptyChart(): EChartsOption {
  return {
    grid: { top: 10, right: 20, bottom: 30, left: 50 },
    xAxis: { type: 'category', data: [] },
    yAxis: { type: 'value' },
    series: [],
  };
}
