import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';

import { SpotAnalysisService } from '@core/services/spot-analysis.service';
import {
  SpotAnalysisListItemDto,
  SpotAnalysisSummaryDto,
  SpotAnalysisDetailDto,
  SpotAnalysisTimePointDto,
} from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

/** Rolling-window options. */
const WINDOWS: { label: string; hours: number }[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: 'All', hours: 0 },
];

/** Page-size options for the table. */
const PAGE_SIZES = [25, 50, 100];

const EMPTY_SUMMARY: SpotAnalysisSummaryDto = {
  analyses: 0,
  totalCostUsd: 0,
  avgLatencyMs: 0,
  signalsCreated: 0,
  positionsOpened: 0,
  positionsClosed: 0,
  profitableAnalyses: 0,
  realizedPnl: 0,
  unrealizedPnl: 0,
  totalPnl: 0,
};

/**
 * Spot Analysis Report — server-paginated ledger of every `market_analysis.spot`
 * run with the trade outcomes attributed to it. KPIs come from the server-side
 * window-wide summary so they stay stable across pages; the table renders one
 * page at a time; the cumulative-P&L chart is computed from the per-analysis
 * time series the server returns. The drawer fetches full detail (prose +
 * recommendations + linked signals/positions + exit instructions) on row click.
 */
@Component({
  selector: 'app-spot-analysis-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Spot Analysis Report"
        subtitle="Every LLM spot analysis with its recommendations, generated signals, and attributed trade P&L"
      >
        <div class="header-controls">
          <div class="chip-group" role="tablist" aria-label="Time window">
            @for (w of windows; track w.hours) {
              <button
                type="button"
                class="chip"
                [class.active]="windowHours() === w.hours"
                (click)="setWindow(w.hours)"
              >
                {{ w.label }}
              </button>
            }
          </div>
          <input
            type="search"
            class="input"
            placeholder="Symbol filter…"
            [ngModel]="symbolFilter()"
            (ngModelChange)="onSymbolFilter($event)"
          />
          <button class="btn" type="button" (click)="load()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </app-page-header>

      <!-- Funnel: where setups die. Counts + conversion % between stages. -->
      <div class="funnel" role="group" aria-label="Analysis funnel">
        @for (s of funnelStages(); track s.label; let last = $last) {
          <div class="funnel-stage">
            <div class="funnel-label">{{ s.label }}</div>
            <div class="funnel-value mono">{{ s.value | number }}</div>
            @if (s.pct !== null) {
              <div class="funnel-pct muted">{{ s.pct | number: '1.0-1' }}% of {{ s.pctOf }}</div>
            }
          </div>
          @if (!last) {
            <div class="funnel-arrow" aria-hidden="true">→</div>
          }
        }
      </div>

      <!-- KPI strip — driven by the server's window-wide summary -->
      <div class="kpi-grid">
        <app-metric-card
          label="LLM spend"
          [value]="summary().totalCostUsd"
          format="currency"
          dotColor="#FF9500"
        />
        <app-metric-card
          label="Avg latency (s)"
          [value]="summary().avgLatencyMs / 1000"
          format="number"
          dotColor="#8E8E93"
        />
        <app-metric-card
          label="Win rate"
          [value]="kpiWinRatePct()"
          format="percent"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Avg P&L / analysis"
          [value]="kpiAvgPnlPerAnalysis()"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Cost / signal"
          [value]="kpiCostPerSignal()"
          format="currency"
          dotColor="#5856D6"
        />
        <app-metric-card
          label="Cost / profitable trade"
          [value]="kpiCostPerProfitable()"
          format="currency"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Realized P&L"
          [value]="summary().realizedPnl"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Total P&L"
          [value]="summary().totalPnl"
          format="currency"
          [colorByValue]="true"
        />
      </div>

      <!-- Cumulative P&L over the window -->
      <app-chart-card
        title="Cumulative P&L"
        subtitle="Each tick is one analysis; the line accumulates attributed P&L over the window"
        [options]="pnlChart()"
        height="240px"
        [loading]="loading()"
      />

      @if (error(); as e) {
        <div class="error-banner">{{ e }}</div>
      }

      <!-- Dense ledger — current page only -->
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>TF</th>
              <th>Bar</th>
              <th>Model</th>
              <th class="num">Latency</th>
              <th class="num">Cost</th>
              <th class="num">Tokens</th>
              <th>Outcome</th>
              <th class="num">Recs</th>
              <th class="num">Signals</th>
              <th class="num">Positions</th>
              <th class="num">Realized</th>
              <th class="num">Unrealized</th>
              <th class="num">Total P&L</th>
              <th class="num">Exits</th>
            </tr>
          </thead>
          <tbody>
            @for (r of items(); track r.id) {
              <tr (click)="openDetail(r)" class="row">
                <td class="mono">{{ r.invokedAt | date: 'MMM d, HH:mm' }}</td>
                <td class="strong">{{ r.symbol }}</td>
                <td>{{ r.timeframe }}</td>
                <td class="muted">{{ r.barPosition }}</td>
                <td class="muted ellipsis">{{ r.model }}</td>
                <td class="num mono">{{ r.latencyMs / 1000 | number: '1.0-1' }}s</td>
                <td class="num mono">{{ r.costUsd | currency: 'USD' : 'symbol' : '1.4-4' }}</td>
                <td class="num mono muted">{{ r.tokensInput }}/{{ r.tokensOutput }}</td>
                <td>
                  <span class="chip-outcome" [class.bad]="r.outcome !== 'Ok'">{{ r.outcome }}</span>
                </td>
                <td class="num mono">{{ r.recommendationCount }}</td>
                <td class="num mono">
                  {{ r.signalsCreated }}
                  @if (r.signalsRejected > 0) {
                    <span class="sub loss">({{ r.signalsRejected }} rej)</span>
                  }
                </td>
                <td class="num mono">
                  {{ r.positionsOpened }}
                  @if (r.positionsClosed > 0) {
                    <span class="sub muted">({{ r.positionsClosed }} closed)</span>
                  }
                </td>
                <td
                  class="num mono"
                  [class.profit]="r.realizedPnl > 0"
                  [class.loss]="r.realizedPnl < 0"
                >
                  {{ r.realizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td
                  class="num mono"
                  [class.profit]="r.unrealizedPnl > 0"
                  [class.loss]="r.unrealizedPnl < 0"
                >
                  {{ r.unrealizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td
                  class="num mono strong"
                  [class.profit]="r.totalPnl > 0"
                  [class.loss]="r.totalPnl < 0"
                >
                  {{ r.totalPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td class="num mono muted">
                  {{ r.exitInstructionsExecuted }}/{{ r.exitInstructionCount }}
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="16" class="empty">
                  {{ loading() ? 'Loading…' : 'No spot analyses in this window.' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="pager">
        <div class="pager-info muted">{{ rangeLabel() }} of {{ totalItems() }} analyses</div>
        <div class="pager-controls">
          <label class="size-label muted">Page size</label>
          <select
            class="size-select"
            [ngModel]="pageSize()"
            (ngModelChange)="setPageSize($any($event))"
          >
            @for (s of pageSizes; track s) {
              <option [ngValue]="s">{{ s }}</option>
            }
          </select>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(1)"
            [disabled]="currentPage() === 1 || loading()"
          >
            «
          </button>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(currentPage() - 1)"
            [disabled]="currentPage() === 1 || loading()"
          >
            ‹ Prev
          </button>
          <span class="pager-page">Page {{ currentPage() }} of {{ totalPages() }}</span>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(currentPage() + 1)"
            [disabled]="currentPage() >= totalPages() || loading()"
          >
            Next ›
          </button>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(totalPages())"
            [disabled]="currentPage() >= totalPages() || loading()"
          >
            »
          </button>
        </div>
      </div>
    </div>

    <!-- Detail drawer — drill-down -->
    @if (selectedRow(); as r) {
      <div class="drawer-backdrop" (click)="closeDetail()">
        <aside class="drawer" (click)="$event.stopPropagation()" aria-label="Analysis detail">
          <header class="drawer-head">
            <div>
              <h3>{{ r.symbol }} · {{ r.timeframe }}</h3>
              <span class="muted">
                {{ r.invokedAt | date: 'MMM d, y HH:mm:ss' }} · audit #{{ r.id }}
              </span>
            </div>
            <button class="btn-close" (click)="closeDetail()" aria-label="Close">×</button>
          </header>

          @if (detailLoading()) {
            <p class="muted">Loading detail…</p>
          }
          @if (detailError(); as e) {
            <div class="error-banner">{{ e }}</div>
          }

          <!-- Quick facts always available from the row -->
          <section class="drawer-section">
            <h4>At a glance</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Bar position</dt>
                <dd>{{ r.barPosition }}</dd>
              </div>
              <div>
                <dt>Provider / model</dt>
                <dd class="mono">{{ r.provider }} / {{ r.model }}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd class="mono">{{ r.latencyMs | number }} ms</dd>
              </div>
              <div>
                <dt>LLM cost</dt>
                <dd class="mono">{{ r.costUsd | currency: 'USD' : 'symbol' : '1.4-4' }}</dd>
              </div>
              <div>
                <dt>Recommendations</dt>
                <dd class="mono">{{ r.recommendationCount }}</dd>
              </div>
              <div>
                <dt>Signals created</dt>
                <dd class="mono">{{ r.signalsCreated }}</dd>
              </div>
              <div>
                <dt>Positions opened</dt>
                <dd class="mono">{{ r.positionsOpened }}</dd>
              </div>
              <div>
                <dt>Total P&L</dt>
                <dd
                  class="mono strong"
                  [class.profit]="r.totalPnl > 0"
                  [class.loss]="r.totalPnl < 0"
                >
                  {{ r.totalPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
            </dl>
          </section>

          <!-- Replayed prose -->
          @if (detail(); as d) {
            @if (d.analysis) {
              <section class="drawer-section">
                <h4>Analysis brief</h4>
                <div class="prose">{{ d.analysis }}</div>
              </section>
            }

            @if (d.recommendations.length > 0) {
              <section class="drawer-section">
                <h4>Recommendations ({{ d.recommendations.length }})</h4>
                @for (rec of d.recommendations; track $index) {
                  <div
                    class="rec-card"
                    [class.rec-buy]="rec.action === 'Buy'"
                    [class.rec-sell]="rec.action === 'Sell'"
                    [class.rec-hold]="rec.action === 'Hold'"
                  >
                    <div class="rec-row">
                      <span class="rec-action">{{ rec.action }}</span>
                      <span class="rec-confidence muted">
                        {{ rec.confidence * 100 | number: '1.0-0' }}% conf
                      </span>
                    </div>
                    @if (rec.action !== 'Hold' && rec.entryPrice !== null) {
                      <div class="rec-levels">
                        <div>
                          <span class="muted">Entry</span>
                          <span class="mono">{{ rec.entryPrice }}</span>
                        </div>
                        <div>
                          <span class="muted">Stop</span>
                          <span class="mono">{{ rec.stopLoss }}</span>
                        </div>
                        <div>
                          <span class="muted">Target</span>
                          <span class="mono">{{ rec.takeProfit }}</span>
                          @if (
                            rec.originalTakeProfit && rec.originalTakeProfit !== rec.takeProfit
                          ) {
                            <span class="tp-orig muted">(LLM: {{ rec.originalTakeProfit }})</span>
                          }
                        </div>
                      </div>
                    }
                    @if (rec.rationale) {
                      <p class="rec-rationale">{{ rec.rationale }}</p>
                    }
                  </div>
                }
              </section>
            }

            @if (d.signals.length > 0) {
              <section class="drawer-section">
                <h4>Signals ({{ d.signals.length }})</h4>
                <table class="sub-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Sym</th>
                      <th>Dir</th>
                      <th>Status</th>
                      <th class="num">Entry</th>
                      <th class="num">Conf</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of d.signals; track s.id) {
                      <tr>
                        <td class="mono muted">{{ s.id }}</td>
                        <td>{{ s.symbol }}</td>
                        <td>{{ s.direction }}</td>
                        <td>
                          <span
                            class="status-chip"
                            [class.ok]="s.status === 'Approved'"
                            [class.bad]="s.status === 'Rejected'"
                          >
                            {{ s.status }}
                          </span>
                        </td>
                        <td class="num mono">{{ s.entryPrice }}</td>
                        <td class="num mono">{{ s.confidence * 100 | number: '1.0-0' }}%</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }

            @if (d.positions.length > 0) {
              <section class="drawer-section">
                <h4>Positions ({{ d.positions.length }})</h4>
                <table class="sub-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Sym</th>
                      <th>Dir</th>
                      <th>Status</th>
                      <th class="num">Lots</th>
                      <th class="num">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of d.positions; track p.id) {
                      @let pnl = p.realizedPnL + (p.status === 'Open' ? p.unrealizedPnL : 0);
                      <tr>
                        <td class="mono muted">{{ p.id }}</td>
                        <td>{{ p.symbol }}</td>
                        <td>{{ p.direction }}</td>
                        <td>{{ p.status }}</td>
                        <td class="num mono">{{ p.openLots | number: '1.2-2' }}</td>
                        <td class="num mono" [class.profit]="pnl > 0" [class.loss]="pnl < 0">
                          {{ pnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }

            @if (d.exitInstructions.length > 0) {
              <section class="drawer-section">
                <h4>Exit instructions ({{ d.exitInstructions.length }})</h4>
                @for (e of d.exitInstructions; track e.id) {
                  <div class="exit-card">
                    <div class="exit-row">
                      <span class="strong">{{ e.decisionType }}</span>
                      <span
                        class="status-chip"
                        [class.ok]="e.status === 'Executed'"
                        [class.bad]="e.status === 'Failed'"
                      >
                        {{ e.status }}
                      </span>
                      <span class="muted">{{ e.confidence * 100 | number: '1.0-0' }}% conf</span>
                    </div>
                    <div class="muted sub">
                      pos #{{ e.positionId }}
                      @if (e.closeFractionPct !== null) {
                        · {{ e.closeFractionPct }}%
                      }
                      @if (e.newStopLoss !== null) {
                        · newSL {{ e.newStopLoss }}
                      }
                    </div>
                    <p class="rec-rationale">{{ e.reason }}</p>
                    @if (e.failureMessage) {
                      <p class="loss sub">« {{ e.failureMessage }} »</p>
                    }
                  </div>
                }
              </section>
            }
          }
        </aside>
      </div>
    }
  `,
  styles: [
    `
      .page {
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .header-controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .chip-group {
        display: inline-flex;
        gap: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        padding: 2px;
      }
      .chip {
        border: 0;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .chip.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .input,
      .size-select {
        padding: 5px 10px;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn {
        padding: 5px 12px;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      /* Funnel — horizontal 4-stage strip */
      .funnel {
        display: flex;
        align-items: stretch;
        gap: var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        background: var(--bg-tertiary);
      }
      .funnel-stage {
        flex: 1 1 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .funnel-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .funnel-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .funnel-pct {
        font-size: 10px;
      }
      .funnel-arrow {
        display: flex;
        align-items: center;
        font-size: var(--text-base);
        color: var(--text-tertiary);
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: var(--space-3);
      }
      .error-banner {
        padding: var(--space-3);
        border: 1px solid #ff3b30;
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: #ff3b30;
        font-size: var(--text-sm);
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      table.dense {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      table.dense thead th {
        position: sticky;
        top: 0;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        text-align: left;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
        padding: 6px 10px;
        white-space: nowrap;
        border-bottom: 1px solid var(--border);
      }
      table.dense th.num,
      table.dense td.num {
        text-align: right;
      }
      table.dense td {
        padding: 5px 10px;
        border-bottom: 1px solid var(--border);
        color: var(--text-primary);
        white-space: nowrap;
      }
      tr.row {
        cursor: pointer;
      }
      tr.row:hover td {
        background: var(--bg-tertiary);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .ellipsis {
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .profit {
        color: var(--profit, #16a34a);
      }
      .loss {
        color: var(--loss, #dc2626);
      }
      .sub {
        font-size: 10px;
        margin-left: 3px;
      }
      .chip-outcome {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: rgba(52, 199, 89, 0.14);
        color: #16a34a;
      }
      .chip-outcome.bad {
        background: rgba(255, 59, 48, 0.14);
        color: #dc2626;
      }
      .empty {
        text-align: center;
        padding: var(--space-5);
        color: var(--text-tertiary);
      }
      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .pager-info {
        font-size: var(--text-xs);
      }
      .pager-controls {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .size-label {
        font-size: var(--text-xs);
      }
      .pager-page {
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
        min-width: 100px;
        text-align: center;
      }
      /* Drawer */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        justify-content: flex-end;
        z-index: 1000;
      }
      .drawer {
        width: 480px;
        max-width: 95vw;
        height: 100%;
        background: var(--bg-primary);
        border-left: 1px solid var(--border);
        overflow-y: auto;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .drawer-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .drawer-head .muted {
        font-size: var(--text-xs);
      }
      .btn-close {
        border: 0;
        background: transparent;
        font-size: 22px;
        line-height: 1;
        color: var(--text-tertiary);
        cursor: pointer;
      }
      .drawer-section h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .drawer-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .drawer-grid dt {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .drawer-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .prose {
        white-space: pre-wrap;
        font-size: var(--text-xs);
        line-height: 1.5;
        color: var(--text-primary);
        max-height: 280px;
        overflow-y: auto;
        background: var(--bg-tertiary);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
      }
      .rec-card {
        margin-top: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .rec-card.rec-buy {
        border-left-color: #16a34a;
      }
      .rec-card.rec-sell {
        border-left-color: #dc2626;
      }
      .rec-card.rec-hold {
        border-left-color: var(--text-tertiary);
      }
      .rec-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .rec-action {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .rec-confidence {
        font-size: var(--text-xs);
      }
      .rec-levels {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
        margin-top: var(--space-2);
        font-size: var(--text-xs);
      }
      .tp-orig {
        font-size: 10px;
        margin-left: 4px;
      }
      .rec-rationale {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-style: italic;
        line-height: 1.5;
      }
      .sub-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .sub-table th,
      .sub-table td {
        padding: 4px 8px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .sub-table th {
        text-transform: uppercase;
        font-size: 10px;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .sub-table th.num,
      .sub-table td.num {
        text-align: right;
      }
      .status-chip {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .status-chip.ok {
        background: rgba(52, 199, 89, 0.14);
        color: #16a34a;
      }
      .status-chip.bad {
        background: rgba(255, 59, 48, 0.14);
        color: #dc2626;
      }
      .exit-card {
        margin-top: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .exit-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class SpotAnalysisReportPageComponent implements OnInit {
  private readonly service = inject(SpotAnalysisService);

  readonly windows = WINDOWS;
  readonly pageSizes = PAGE_SIZES;

  // ── Filter state ─────────────────────────────────────────────────────
  readonly windowHours = signal(168); // 7d default
  readonly symbolFilter = signal('');

  // ── Server-side paging ───────────────────────────────────────────────
  readonly currentPage = signal(1);
  readonly pageSize = signal(25);
  readonly totalItems = signal(0);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalItems() / Math.max(1, this.pageSize()))),
  );

  // ── Server response ──────────────────────────────────────────────────
  readonly items = signal<SpotAnalysisListItemDto[]>([]);
  readonly summary = signal<SpotAnalysisSummaryDto>(EMPTY_SUMMARY);
  readonly timeSeries = signal<SpotAnalysisTimePointDto[]>([]);

  // ── UI state ─────────────────────────────────────────────────────────
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // ── Drawer state ─────────────────────────────────────────────────────
  readonly selectedRow = signal<SpotAnalysisListItemDto | null>(null);
  readonly detail = signal<SpotAnalysisDetailDto | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);

  // ── KPI derivations ──────────────────────────────────────────────────
  readonly kpiWinRatePct = computed(() => {
    const s = this.summary();
    if (s.positionsClosed === 0) return 0;
    return (s.profitableAnalyses / s.positionsClosed) * 100;
  });
  readonly kpiAvgPnlPerAnalysis = computed(() => {
    const s = this.summary();
    return s.analyses > 0 ? s.totalPnl / s.analyses : 0;
  });
  readonly kpiCostPerSignal = computed(() => {
    const s = this.summary();
    return s.signalsCreated > 0 ? s.totalCostUsd / s.signalsCreated : 0;
  });
  readonly kpiCostPerProfitable = computed(() => {
    const s = this.summary();
    return s.profitableAnalyses > 0 ? s.totalCostUsd / s.profitableAnalyses : 0;
  });

  /** Funnel stages — counts + conversion-% relative to the prior stage. */
  readonly funnelStages = computed(() => {
    const s = this.summary();
    const stages = [
      { label: 'Analyses', value: s.analyses, base: 0, pctOf: '' },
      { label: 'Signals created', value: s.signalsCreated, base: s.analyses, pctOf: 'analyses' },
      {
        label: 'Positions opened',
        value: s.positionsOpened,
        base: s.signalsCreated,
        pctOf: 'signals',
      },
      {
        label: 'Profitable',
        value: s.profitableAnalyses,
        base: s.positionsClosed,
        pctOf: 'closed',
      },
    ];
    return stages.map((st) => ({
      ...st,
      pct: st.base > 0 ? (st.value / st.base) * 100 : null,
    }));
  });

  /** Cumulative-P&L ECharts options. */
  readonly pnlChart = computed<EChartsOption>(() => {
    const series = this.timeSeries();
    let cum = 0;
    const points = series.map((p) => {
      cum += p.totalPnl ?? 0;
      return [p.invokedAt, cum] as [string, number];
    });
    const endPnl = cum;

    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'time' },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (v: number) => `$${v.toFixed(0)}` },
      },
      series: [
        {
          name: 'Cumulative P&L',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: points,
          lineStyle: { color: endPnl >= 0 ? '#16a34a' : '#dc2626' },
          areaStyle: {
            color: endPnl >= 0 ? 'rgba(22, 163, 74, 0.12)' : 'rgba(220, 38, 38, 0.12)',
          },
        },
      ],
    };
  });

  readonly rangeLabel = computed(() => {
    const n = this.items().length;
    if (n === 0) return 'Showing 0';
    const start = (this.currentPage() - 1) * this.pageSize() + 1;
    return `Showing ${start}–${start + n - 1}`;
  });

  private symbolDebounce: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.load();
  }

  setWindow(hours: number): void {
    if (this.windowHours() === hours) return;
    this.windowHours.set(hours);
    this.currentPage.set(1);
    this.load();
  }

  onSymbolFilter(value: string): void {
    this.symbolFilter.set(value);
    if (this.symbolDebounce !== null) clearTimeout(this.symbolDebounce);
    this.symbolDebounce = setTimeout(() => {
      this.currentPage.set(1);
      this.load();
    }, 350);
  }

  setPageSize(size: number): void {
    if (this.pageSize() === size) return;
    this.pageSize.set(size);
    this.currentPage.set(1);
    this.load();
  }

  goTo(page: number): void {
    const target = Math.max(1, Math.min(page, this.totalPages()));
    if (target === this.currentPage()) return;
    this.currentPage.set(target);
    this.load();
  }

  openDetail(row: SpotAnalysisListItemDto): void {
    this.selectedRow.set(row);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(true);
    this.service
      .getDetail(row.id)
      .pipe(
        catchError((err) => {
          this.detailError.set(
            err?.error?.message ?? err?.message ?? 'Failed to load analysis detail.',
          );
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.detailLoading.set(false);
        if (res?.status && res.data) {
          this.detail.set(res.data);
        } else if (res && !res.status) {
          this.detailError.set(res.message ?? 'Failed to load analysis detail.');
        }
      });
  }

  closeDetail(): void {
    this.selectedRow.set(null);
    this.detail.set(null);
    this.detailError.set(null);
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);

    const hours = this.windowHours();
    const filter: Record<string, unknown> = {};
    if (hours > 0) {
      filter['from'] = new Date(Date.now() - hours * 3_600_000).toISOString();
    }
    const sym = this.symbolFilter().trim();
    if (sym.length > 0) filter['symbol'] = sym.toUpperCase();

    this.service
      .list({
        currentPage: this.currentPage(),
        itemCountPerPage: this.pageSize(),
        filter,
      })
      .pipe(
        catchError((err) => {
          this.error.set(err?.error?.message ?? err?.message ?? 'Failed to load spot analyses.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.items.set(res.data.items ?? []);
          this.summary.set(res.data.summary ?? EMPTY_SUMMARY);
          this.timeSeries.set(res.data.timeSeries ?? []);
          this.totalItems.set(res.data.totalItems ?? 0);
        } else if (res && !res.status) {
          this.error.set(res.message ?? 'Failed to load spot analyses.');
          this.items.set([]);
          this.summary.set(EMPTY_SUMMARY);
          this.timeSeries.set([]);
          this.totalItems.set(0);
        }
      });
  }
}
