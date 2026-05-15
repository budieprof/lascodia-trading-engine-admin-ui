import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  effect,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { BacktestsService } from '@core/services/backtests.service';
import { BacktestRunDto } from '@core/api/api.types';
import type { EChartsOption } from 'echarts';
import {
  TradeReplayDialogComponent,
  type ReplayTrade,
} from '../../components/trade-replay-dialog/trade-replay-dialog.component';

// ── Result shape ──────────────────────────────────────────────────────────
// Mirrors LascodiaTradingEngine.Application.Backtesting.Models.BacktestResult.
// Engine serializes with default PascalCase property names so the fields here
// match the wire format directly.

interface BacktestTrade {
  Direction: number; // 0 = Buy / Long, 1 = Sell / Short
  EntryPrice: number;
  ExitPrice: number;
  LotSize: number;
  PnL: number;
  Commission: number;
  Swap: number;
  Slippage: number;
  TcaCost: number;
  GrossPnL: number;
  EntryTime: string;
  ExitTime: string;
  ExitReason: number; // 0 = StopLoss, 1 = TakeProfit, 2 = EndOfData
  // Optional — populated by engine builds that record the entry-time levels.
  // Older runs serialised before the engine change land here as undefined and
  // the trade-replay dialog skips the SL/TP horizontals for those rows.
  StopLoss?: number | null;
  TakeProfit?: number | null;
}

interface BacktestResultData {
  InitialBalance: number;
  FinalBalance: number;
  TotalReturn: number;
  TotalTrades: number;
  WinningTrades: number;
  LosingTrades: number;
  WinRate: number; // 0..1
  ProfitFactor: number;
  MaxDrawdownPct: number;
  SharpeRatio: number;
  SortinoRatio: number;
  CalmarRatio: number;
  AverageWin: number;
  AverageLoss: number;
  LargestWin: number;
  LargestLoss: number;
  Expectancy: number;
  MaxConsecutiveWins: number;
  MaxConsecutiveLosses: number;
  ExposurePct: number;
  AverageTradeDurationHours: number;
  TotalCommission: number;
  TotalSwap: number;
  TotalSlippage: number;
  TotalTcaCost: number;
  RecoveryFactor: number;
  Trades: BacktestTrade[];
}

const EXIT_REASON_LABELS: Record<number, string> = {
  0: 'Stop Loss',
  1: 'Take Profit',
  2: 'End of Data',
};

@Component({
  selector: 'app-backtest-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    StatusBadgeComponent,
    TradeReplayDialogComponent,
    DatePipe,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Backtest #' + (backtest()?.id ?? '')"
        subtitle="Trade-level analysis derived from the run's full execution log"
      >
        <app-status-badge [status]="backtest()?.status ?? 'Queued'" type="run" />
        <button type="button" class="btn-back" (click)="goBack()">← Back to list</button>
      </app-page-header>

      @if (backtest(); as bt) {
        @if (parseError()) {
          <div class="note warning">
            Couldn't parse result payload — showing denormalised fields only. ({{ parseError() }})
          </div>
        }

        <!-- ── Primary KPI strip ──────────────────────────────────────── -->
        <div class="kpi-strip">
          <app-metric-card
            label="Total Return"
            [value]="primary().totalReturn"
            format="percent"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Win Rate"
            [value]="primary().winRate"
            format="percent"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Profit Factor"
            [value]="primary().profitFactor"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Sharpe Ratio"
            [value]="primary().sharpe"
            format="number"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Max Drawdown"
            [value]="primary().maxDrawdown"
            format="percent"
            dotColor="#FF3B30"
          />
          <app-metric-card
            label="Total Trades"
            [value]="primary().totalTrades"
            format="number"
            dotColor="#5AC8FA"
          />
        </div>

        @if (parsed(); as p) {
          <!-- ── Secondary metrics strip ─────────────────────────────── -->
          <div class="kpi-strip">
            <app-metric-card
              label="Sortino"
              [value]="p.SortinoRatio"
              format="number"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Calmar"
              [value]="p.CalmarRatio"
              format="number"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Expectancy"
              [value]="p.Expectancy"
              format="currency"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Recovery Factor"
              [value]="p.RecoveryFactor"
              format="number"
              [colorByValue]="true"
            />
            <app-metric-card
              label="Exposure"
              [value]="p.ExposurePct"
              format="percent"
              dotColor="#AF52DE"
            />
            <app-metric-card
              label="Avg Duration (h)"
              [value]="p.AverageTradeDurationHours"
              format="number"
              dotColor="#FF9500"
            />
          </div>
        }

        <!-- ── Equity + Drawdown row ───────────────────────────────────── -->
        <div class="charts-grid">
          <app-chart-card
            title="Equity Curve"
            subtitle="Account balance and high-water mark over trade timeline"
            [options]="equityCurveOptions()"
            height="340px"
          />
          <app-chart-card
            title="Drawdown"
            subtitle="Underwater equity — distance below the high-water mark"
            [options]="drawdownOptions()"
            height="340px"
          />
        </div>

        <!-- ── Distribution row ────────────────────────────────────────── -->
        <div class="charts-grid">
          <app-chart-card
            title="Trade P&L Distribution"
            subtitle="Histogram of per-trade realised P&L (net of costs)"
            [options]="pnlDistOptions()"
            height="300px"
          />
          <app-chart-card
            title="Monthly Returns"
            subtitle="Realised P&L grouped by trade exit month"
            [options]="monthlyOptions()"
            height="300px"
          />
        </div>

        <!-- ── Behaviour row ───────────────────────────────────────────── -->
        <div class="charts-grid">
          <app-chart-card
            title="Day-of-Week P&L"
            subtitle="Average and total realised P&L by weekday"
            [options]="dowOptions()"
            height="280px"
          />
          <app-chart-card
            title="Exit Reason Mix"
            subtitle="How each trade closed — SL / TP / end-of-data"
            [options]="exitReasonOptions()"
            height="280px"
          />
        </div>

        <div class="charts-grid">
          <app-chart-card
            title="Long vs Short"
            subtitle="Trade count and realised P&L by direction"
            [options]="longShortOptions()"
            height="280px"
          />
          <app-chart-card
            title="Trade Duration"
            subtitle="Distribution of holding times in hours"
            [options]="durationOptions()"
            height="280px"
          />
        </div>

        <!-- ── Cost breakdown ──────────────────────────────────────────── -->
        @if (parsed(); as p) {
          <div class="cost-card">
            <header class="cost-head">
              <h3>Cost Breakdown</h3>
              <span class="muted"
                >Sum of slippage, commission, swap and TCA across all
                {{ p.Trades.length }} trades</span
              >
            </header>
            <div class="cost-grid">
              <div class="cost-item">
                <span class="cost-label">Slippage</span>
                <span class="cost-value">{{ p.TotalSlippage | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Commission</span>
                <span class="cost-value">{{ p.TotalCommission | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Swap</span>
                <span class="cost-value">{{ p.TotalSwap | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">TCA Cost</span>
                <span class="cost-value">{{ p.TotalTcaCost | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Largest Win</span>
                <span class="cost-value gain">+{{ p.LargestWin | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Largest Loss</span>
                <span class="cost-value loss">−{{ p.LargestLoss | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Avg Win</span>
                <span class="cost-value gain">+{{ p.AverageWin | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Avg Loss</span>
                <span class="cost-value loss">−{{ p.AverageLoss | number: '1.2-2' }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Max Win Streak</span>
                <span class="cost-value">{{ p.MaxConsecutiveWins }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Max Loss Streak</span>
                <span class="cost-value">{{ p.MaxConsecutiveLosses }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Winning Trades</span>
                <span class="cost-value gain">{{ p.WinningTrades }}</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Losing Trades</span>
                <span class="cost-value loss">{{ p.LosingTrades }}</span>
              </div>
            </div>
          </div>
        }

        <!-- ── Trade log ───────────────────────────────────────────────── -->
        @if (sortedTrades().length > 0) {
          <section class="info-card">
            <header class="info-head">
              <h3>Trade Log</h3>
              <div class="trade-log-controls">
                <span class="muted">{{ sortedTrades().length }} trades</span>
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
              </div>
            </header>
            <div class="trade-table-wrap">
              <table class="trade-table">
                <thead>
                  <tr>
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
                    <tr class="trade-row" (click)="openReplay(t.trade, t.idx)">
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
                        {{ t.trade.StopLoss !== null ? (t.trade.StopLoss | number: '1.5-5') : '—' }}
                      </td>
                      <td class="num mono">
                        {{
                          t.trade.TakeProfit !== null ? (t.trade.TakeProfit | number: '1.5-5') : '—'
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
                          (click)="openReplay(t.trade, t.idx); $event.stopPropagation()"
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
                >Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredTrades().length }}</span
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
                  [disabled]="pageEnd() >= filteredTrades().length"
                  (click)="tradePage.set(tradePage() + 1)"
                >
                  Next →
                </button>
              </div>
            </footer>
          </section>
        }

        <!-- ── Run config ──────────────────────────────────────────────── -->
        <div class="info-card">
          <header class="info-head">
            <h3>Run Configuration</h3>
          </header>
          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">Strategy</span>
              <span class="info-value">#{{ bt.strategyId }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Symbol</span>
              <span class="info-value">{{ bt.symbol ?? '—' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Timeframe</span>
              <span class="info-value">{{ bt.timeframe }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Initial Balance</span>
              <span class="info-value">\${{ bt.initialBalance | number: '1.2-2' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Final Balance</span>
              <span class="info-value"
                >\${{ parsed()?.FinalBalance ?? bt.finalBalance | number: '1.2-2' }}</span
              >
            </div>
            <div class="info-item">
              <span class="info-label">Period</span>
              <span class="info-value"
                >{{ bt.fromDate | date: 'mediumDate' }} — {{ bt.toDate | date: 'mediumDate' }}</span
              >
            </div>
            <div class="info-item">
              <span class="info-label">Started</span>
              <span class="info-value">{{ bt.startedAt | date: 'medium' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Completed</span>
              <span class="info-value">{{
                bt.completedAt ? (bt.completedAt | date: 'medium') : '—'
              }}</span>
            </div>
          </div>
        </div>
      } @else {
        <div class="note">Loading backtest #{{ id() }}…</div>
      }

      <!-- Trade-replay dialog (mounted once; input drives the open/close cycle). -->
      <app-trade-replay-dialog
        [trade]="replayTrade()"
        [symbol]="backtest()?.symbol ?? ''"
        [timeframe]="backtest()?.timeframe ?? 'H1'"
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
      .btn-back {
        margin-left: auto;
        height: 32px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-back:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
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
      .cost-card,
      .info-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .cost-head,
      .info-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .cost-head h3,
      .info-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .cost-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
      }
      .cost-item {
        padding: var(--space-3) var(--space-5);
        border-right: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cost-item:nth-child(6n) {
        border-right: none;
      }
      .cost-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cost-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .cost-value.gain {
        color: var(--color-success, #34c759);
      }
      .cost-value.loss {
        color: var(--color-danger, #ff3b30);
      }
      .info-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
      }
      .info-item {
        padding: var(--space-3) var(--space-5);
        border-right: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .info-item:nth-child(4n) {
        border-right: none;
      }
      .info-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .info-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
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
      }
      @media (max-width: 1200px) {
        .kpi-strip,
        .cost-grid {
          grid-template-columns: repeat(3, 1fr);
        }
        .info-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .cost-item:nth-child(6n),
        .info-item:nth-child(4n) {
          border-right: 1px solid var(--border);
        }
      }
      @media (max-width: 768px) {
        .kpi-strip,
        .cost-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
        .info-grid {
          grid-template-columns: 1fr;
        }
      }
      /* ── Trade log ───────────────────────────────────────────────── */
      .trade-log-controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
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
export class BacktestDetailPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private backtestsService = inject(BacktestsService);

  readonly id = signal<number | null>(null);
  readonly backtest = signal<BacktestRunDto | null>(null);
  readonly parsed = signal<BacktestResultData | null>(null);
  readonly parseError = signal<string | null>(null);

  // ── Trade log state ────────────────────────────────────────────────────
  readonly tradeFilter = signal<'all' | 'wins' | 'losses' | 'long' | 'short'>('all');
  readonly tradePage = signal(1);
  readonly tradesPerPage = 25;
  /** Trade currently mounted in the replay dialog. `null` keeps the dialog
   *  closed; setting a value drives the dialog's open effect. */
  readonly replayTrade = signal<ReplayTrade | null>(null);

  constructor() {
    // Reset to page 1 whenever the filter chip changes — otherwise switching
    // from "All" page 12 to "Wins" leaves the operator past the last page.
    effect(() => {
      this.tradeFilter();
      this.tradePage.set(1);
    });
  }

  /** Top-row KPI source. Prefers parsed payload (full precision), falls back
   *  to the row's denormalised fields when ResultJson isn't there yet. */
  readonly primary = computed(() => {
    const bt = this.backtest();
    const p = this.parsed();
    return {
      totalReturn: p?.TotalReturn ?? bt?.totalReturn ?? 0,
      winRate: (p?.WinRate ?? bt?.winRate ?? 0) * 100,
      profitFactor: p?.ProfitFactor ?? bt?.profitFactor ?? 0,
      sharpe: p?.SharpeRatio ?? bt?.sharpeRatio ?? 0,
      maxDrawdown: p?.MaxDrawdownPct ?? bt?.maxDrawdownPct ?? 0,
      totalTrades: p?.TotalTrades ?? bt?.totalTrades ?? 0,
    };
  });

  // ── Derived series (computed once per parsed payload) ──────────────────

  /** Sort once, ascending by ExitTime, so all subsequent walks (equity,
   *  drawdown, streaks) see chronological order even if the engine wrote
   *  trades out of order. Public so the trade-log section can iterate it
   *  directly with stable 1-based indices that survive filter changes. */
  readonly sortedTrades = computed<BacktestTrade[]>(() => {
    const p = this.parsed();
    if (!p?.Trades?.length) return [];
    return [...p.Trades].sort(
      (a, b) => new Date(a.ExitTime).getTime() - new Date(b.ExitTime).getTime(),
    );
  });

  /** Filtered + index-annotated trades for the trade log table. The 1-based
   *  index is captured BEFORE the filter so wins/losses/etc. retain their
   *  original chronological position (Trade #142 stays #142 in the wins-only
   *  view). */
  readonly filteredTrades = computed<{ trade: BacktestTrade; idx: number }[]>(() => {
    const all = this.sortedTrades().map((trade, i) => ({ trade, idx: i + 1 }));
    const filter = this.tradeFilter();
    switch (filter) {
      case 'wins':
        return all.filter((x) => x.trade.PnL > 0);
      case 'losses':
        return all.filter((x) => x.trade.PnL <= 0);
      case 'long':
        return all.filter((x) => x.trade.Direction === 0);
      case 'short':
        return all.filter((x) => x.trade.Direction === 1);
      default:
        return all;
    }
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

  openReplay(trade: BacktestTrade, idx: number): void {
    this.replayTrade.set({ ...trade, index: idx });
  }

  exitReasonShort(reason: number): string {
    return reason === 0 ? 'SL' : reason === 1 ? 'TP' : 'EOD';
  }

  exitReasonClass(reason: number): string {
    return reason === 0 ? 'sl' : reason === 1 ? 'tp' : 'eod';
  }

  /** Equity curve: timestamp-indexed running balance, plus the
   *  high-water-mark series for the same axis. Drawdown uses the same
   *  trade walk so its X axis aligns with equity. */
  private equityWalk = computed(() => {
    const trades = this.sortedTrades();
    const p = this.parsed();
    if (!p || !trades.length) {
      return {
        dates: [] as string[],
        equity: [] as number[],
        hwm: [] as number[],
        dd: [] as number[],
      };
    }
    const dates: string[] = [];
    const equity: number[] = [];
    const hwm: number[] = [];
    const dd: number[] = [];
    let bal = Number(p.InitialBalance);
    let peak = bal;
    // Seed the chart with the opening balance at the time of the first
    // entry so the operator can see the equity line start at the
    // initial-balance baseline rather than jumping in mid-air.
    const firstEntry = trades[0].EntryTime;
    dates.push(firstEntry);
    equity.push(+bal.toFixed(2));
    hwm.push(+peak.toFixed(2));
    dd.push(0);
    for (const t of trades) {
      bal += Number(t.PnL);
      if (bal > peak) peak = bal;
      const ddPct = peak > 0 ? ((bal - peak) / peak) * 100 : 0;
      dates.push(t.ExitTime);
      equity.push(+bal.toFixed(2));
      hwm.push(+peak.toFixed(2));
      dd.push(+ddPct.toFixed(3));
    }
    return { dates, equity, hwm, dd };
  });

  equityCurveOptions = computed<EChartsOption>(() => {
    const w = this.equityWalk();
    return {
      grid: { top: 20, right: 30, bottom: 40, left: 70 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) =>
          typeof v === 'number'
            ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : '—',
      },
      legend: { data: ['Equity', 'High-Water Mark'], bottom: 0, fontSize: 11 },
      xAxis: {
        type: 'time',
        data: w.dates,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          fontSize: 11,
          color: '#6E6E73',
          formatter: (v: number) => `$${v.toLocaleString()}`,
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'Equity',
          type: 'line',
          data: w.dates.map((d, i) => [d, w.equity[i]]),
          smooth: false,
          symbol: 'none',
          lineStyle: { color: '#0071E3', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0,113,227,0.18)' },
                { offset: 1, color: 'rgba(0,113,227,0)' },
              ],
            },
          },
          z: 2,
        },
        {
          name: 'High-Water Mark',
          type: 'line',
          data: w.dates.map((d, i) => [d, w.hwm[i]]),
          smooth: false,
          symbol: 'none',
          lineStyle: { color: '#8E8E93', width: 1, type: 'dashed' },
          z: 1,
        },
      ],
    };
  });

  drawdownOptions = computed<EChartsOption>(() => {
    const w = this.equityWalk();
    return {
      grid: { top: 20, right: 30, bottom: 30, left: 60 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(2)}%` : '—'),
      },
      xAxis: {
        type: 'time',
        data: w.dates,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        max: 0,
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'line',
          data: w.dates.map((d, i) => [d, w.dd[i]]),
          smooth: false,
          symbol: 'none',
          lineStyle: { color: '#FF3B30', width: 1.4 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(255,59,48,0.05)' },
                { offset: 1, color: 'rgba(255,59,48,0.25)' },
              ],
            },
          },
        },
      ],
    };
  });

  pnlDistOptions = computed<EChartsOption>(() => {
    const trades = this.parsed()?.Trades ?? [];
    if (!trades.length) return emptyChart();
    const pnls = trades.map((t) => Number(t.PnL));
    const { bins, labels } = histogram(pnls, 20);
    const center = bins.findIndex((b) => b.from <= 0 && b.to > 0);
    const data = bins.map((b, i) => ({
      value: b.count,
      itemStyle: {
        color: b.from < 0 ? '#FF3B30' : i === center ? '#FFCC00' : '#34C759',
        borderRadius: [4, 4, 0, 0],
      },
    }));
    return {
      grid: { top: 10, right: 20, bottom: 40, left: 50 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const idx = Array.isArray(params) ? (params[0]?.dataIndex ?? 0) : 0;
          const b = bins[idx];
          return `${formatRange(b.from, b.to)}<br/>${b.count} trades`;
        },
      },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          interval: Math.max(0, Math.floor(labels.length / 10)),
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [{ type: 'bar', data, barCategoryGap: '20%' }],
    };
  });

  monthlyOptions = computed<EChartsOption>(() => {
    const trades = this.parsed()?.Trades ?? [];
    if (!trades.length) return emptyChart();
    const byMonth = new Map<string, number>();
    for (const t of trades) {
      const key = t.ExitTime.slice(0, 7); // YYYY-MM
      byMonth.set(key, (byMonth.get(key) ?? 0) + Number(t.PnL));
    }
    const keys = [...byMonth.keys()].sort();
    return {
      grid: { top: 10, right: 20, bottom: 50, left: 60 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) =>
          typeof v === 'number' ? `${v >= 0 ? '+' : ''}$${v.toFixed(2)}` : '—',
      },
      xAxis: {
        type: 'category',
        data: keys,
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          interval: Math.max(0, Math.floor(keys.length / 12)),
          rotate: keys.length > 8 ? 30 : 0,
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73', formatter: '${value}' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: keys.map((k) => {
            const v = byMonth.get(k) ?? 0;
            return {
              value: +v.toFixed(2),
              itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4, 4, 0, 0] },
            };
          }),
        },
      ],
    };
  });

  dowOptions = computed<EChartsOption>(() => {
    const trades = this.parsed()?.Trades ?? [];
    if (!trades.length) return emptyChart();
    const sums = [0, 0, 0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const t of trades) {
      const d = new Date(t.ExitTime).getUTCDay(); // 0 = Sun, 6 = Sat
      sums[d] += Number(t.PnL);
      counts[d]++;
    }
    // Re-order Mon..Sun for the trading week (Mon=1..Fri=5, then Sat=6, Sun=0).
    const order = [1, 2, 3, 4, 5, 6, 0];
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const data = order.map((i) => ({
      total: sums[i],
      count: counts[i],
      avg: counts[i] > 0 ? sums[i] / counts[i] : 0,
    }));
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 60 },
      legend: { data: ['Total P&L', 'Avg per trade'], bottom: 0, fontSize: 11 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) =>
          typeof v === 'number' ? `${v >= 0 ? '+' : ''}$${v.toFixed(2)}` : '—',
      },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 11, color: '#6E6E73' } },
      yAxis: [
        {
          type: 'value',
          axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '${value}' },
          splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        },
        {
          type: 'value',
          axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '${value}' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Total P&L',
          type: 'bar',
          yAxisIndex: 0,
          data: data.map((d) => ({
            value: +d.total.toFixed(2),
            itemStyle: { color: d.total >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: 22,
        },
        {
          name: 'Avg per trade',
          type: 'line',
          yAxisIndex: 1,
          data: data.map((d) => +d.avg.toFixed(2)),
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
      ],
    };
  });

  exitReasonOptions = computed<EChartsOption>(() => {
    const trades = this.parsed()?.Trades ?? [];
    if (!trades.length) return emptyChart();
    const buckets = new Map<number, { count: number; pnl: number }>();
    for (const t of trades) {
      const entry = buckets.get(t.ExitReason) ?? { count: 0, pnl: 0 };
      entry.count++;
      entry.pnl += Number(t.PnL);
      buckets.set(t.ExitReason, entry);
    }
    const palette: Record<number, string> = { 0: '#FF3B30', 1: '#34C759', 2: '#8E8E93' };
    const data = [...buckets.entries()].map(([reason, v]) => ({
      name: EXIT_REASON_LABELS[reason] ?? `Reason ${reason}`,
      value: v.count,
      itemStyle: { color: palette[reason] ?? '#0071E3' },
      pnl: v.pnl,
    }));
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) => {
          const pnl = p?.data?.pnl ?? 0;
          return `${p.name}<br/>${p.value} trades (${p.percent}%)<br/>P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
        },
      },
      legend: { bottom: 0, fontSize: 11 },
      series: [
        {
          type: 'pie',
          radius: ['45%', '75%'],
          center: ['50%', '46%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: 'var(--bg-secondary)', borderWidth: 2 },
          label: { fontSize: 11, formatter: '{b}\n{d}%' },
          data,
        },
      ],
    };
  });

  longShortOptions = computed<EChartsOption>(() => {
    const trades = this.parsed()?.Trades ?? [];
    if (!trades.length) return emptyChart();
    const longs = trades.filter((t) => t.Direction === 0);
    const shorts = trades.filter((t) => t.Direction === 1);
    const sum = (arr: BacktestTrade[]) => arr.reduce((acc, t) => acc + Number(t.PnL), 0);
    const wins = (arr: BacktestTrade[]) => arr.filter((t) => Number(t.PnL) > 0).length;
    const longTotal = sum(longs);
    const shortTotal = sum(shorts);
    const longWr = longs.length > 0 ? (wins(longs) / longs.length) * 100 : 0;
    const shortWr = shorts.length > 0 ? (wins(shorts) / shorts.length) * 100 : 0;
    return {
      grid: { top: 20, right: 20, bottom: 50, left: 60 },
      legend: { data: ['Total P&L', 'Win Rate'], bottom: 0, fontSize: 11 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: [`Long (${longs.length})`, `Short (${shorts.length})`],
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: [
        {
          type: 'value',
          axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '${value}' },
          splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        },
        {
          type: 'value',
          max: 100,
          axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Total P&L',
          type: 'bar',
          yAxisIndex: 0,
          data: [longTotal, shortTotal].map((v) => ({
            value: +v.toFixed(2),
            itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: 40,
        },
        {
          name: 'Win Rate',
          type: 'line',
          yAxisIndex: 1,
          data: [+longWr.toFixed(2), +shortWr.toFixed(2)],
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { color: '#0071E3', width: 2 },
          itemStyle: { color: '#0071E3' },
        },
      ],
    };
  });

  durationOptions = computed<EChartsOption>(() => {
    const trades = this.parsed()?.Trades ?? [];
    if (!trades.length) return emptyChart();
    const hours = trades.map(
      (t) => (new Date(t.ExitTime).getTime() - new Date(t.EntryTime).getTime()) / 3_600_000,
    );
    const { bins, labels } = histogram(hours, 18);
    return {
      grid: { top: 10, right: 20, bottom: 40, left: 50 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const idx = Array.isArray(params) ? (params[0]?.dataIndex ?? 0) : 0;
          const b = bins[idx];
          return `${b.from.toFixed(1)}–${b.to.toFixed(1)}h<br/>${b.count} trades`;
        },
      },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          interval: Math.max(0, Math.floor(labels.length / 10)),
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: bins.map((b) => ({
            value: b.count,
            itemStyle: { color: '#AF52DE', borderRadius: [4, 4, 0, 0] },
          })),
          barCategoryGap: '20%',
        },
      ],
    };
  });

  ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) return;
    this.id.set(id);
    this.backtestsService.getById(id).subscribe({
      next: (res) => {
        if (!res?.data) return;
        const data = res.data as BacktestRunDto;
        this.backtest.set(data);
        if (data.resultJson) {
          try {
            const parsed = JSON.parse(data.resultJson) as BacktestResultData;
            if (Array.isArray(parsed.Trades)) {
              this.parsed.set(parsed);
            } else {
              this.parseError.set('resultJson has no Trades[] array');
            }
          } catch (e) {
            this.parseError.set(e instanceof Error ? e.message : 'unknown parse error');
          }
        }
      },
      error: () => {
        this.parseError.set('Failed to load backtest run');
      },
    });
  }

  goBack(): void {
    this.router.navigate(['/backtests']);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function emptyChart(): EChartsOption {
  return {
    grid: { top: 10, right: 20, bottom: 30, left: 50 },
    xAxis: { type: 'category', data: [] },
    yAxis: { type: 'value' },
    series: [],
  };
}

function histogram(
  values: number[],
  binCount: number,
): {
  bins: { from: number; to: number; count: number }[];
  labels: string[];
} {
  if (!values.length) return { bins: [], labels: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return {
      bins: [{ from: min, to: max, count: values.length }],
      labels: [formatNumber(min)],
    };
  }
  const width = (max - min) / binCount;
  const bins: { from: number; to: number; count: number }[] = Array.from(
    { length: binCount },
    (_, i) => ({
      from: min + i * width,
      to: min + (i + 1) * width,
      count: 0,
    }),
  );
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= binCount) idx = binCount - 1; // catch the max value
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  const labels = bins.map((b) => formatNumber((b.from + b.to) / 2));
  return { bins, labels };
}

function formatNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatRange(from: number, to: number): string {
  return `${formatNumber(from)} → ${formatNumber(to)}`;
}
