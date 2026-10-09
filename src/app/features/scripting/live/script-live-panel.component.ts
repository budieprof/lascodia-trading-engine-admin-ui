import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { catchError, of } from 'rxjs';

import { createPolledResource } from '@core/polling/polled-resource';
import {
  EATradeChartModalComponent,
  type TradeChartSelection,
} from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';

import { ScriptStrategyService } from '../api/script-strategy.service';
import { StrategyExecutionService } from '../api/strategy-execution.service';
import type { ScriptDivergence } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { StrategyReportComponent } from '../report/strategy-report.component';
import {
  normalizeStrategyReport,
  reportCurrency,
  type ReportTrade,
} from '../report/strategy-report.model';
import type { TradeOriginOf } from '../report/report-trades-columns';
import {
  TRADE_ORIGIN_BADGES,
  parseTradeOrigin,
  tradeOriginHint,
  tradeOriginTitle,
  type TradeOrigin,
} from '../report/trade-origin';
import {
  NA,
  formatDateTime,
  formatMoney,
  formatPrice,
  inferPriceDecimals,
} from '../report/report-format';
import {
  hasTradeOrigins,
  liveChartContext,
  liveOpenTradeChart,
  liveReportTradeChart,
  liveTradeBook,
  matchLiveFill,
  type LiveChartContext,
} from './live-trade-chart';
import {
  OPEN_TRADE_COLUMNS,
  PENDING_ORDER_COLUMNS,
  barAgeMinutes,
  deriveColumns,
  formatBrokerLots,
  formatAge,
  formatLiveValue,
  heartbeatLate,
  humanize,
  liveModeInfo,
  liveStatusTone,
  liveWarningHint,
  normalizeLiveStatus,
  originStats,
  positionHeadline,
  sortLiveWarnings,
  type OriginStats,
} from './live.model';
import { liveClosedTradesCsv } from '../report/report-csv';
import { fileStamp, saveBlob } from '../shared/download';

/** Fallback cadence; a live session advances on bar closes, so 15 s is plenty. */
const POLL_MS = 15_000;

/** A bar older than this (minutes) on a running session is called out as stale. */
const STALE_MINUTES = 240;

/**
 * Live status of a script strategy's session (`GET strategy/{id}/script/live`): session state,
 * the emulator's position, open trades and pending orders, equity, account positions a previous
 * script version left open, the divergences between the emulator and the bound accounts, and the
 * live emulator's Strategy report. Emulator quantities read in units, account positions in lots.
 *
 * Every trade — a row of the report's List of trades or of the Open trades table — opens on the
 * position chart a backtest trade opens, with its origin (warm-up replay, paper, live) in the
 * title: the session's warm-up replays history through the same emulator, so its trades sit in
 * the same lists as the real ones.
 */
@Component({
  selector: 'app-script-live-panel',
  standalone: true,
  imports: [StrategyReportComponent, EATradeChartModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack">
      <header class="head">
        <div class="head-left">
          <h3 class="title">Live session</h3>
          @if (live(); as l) {
            <span class="status" [attr.data-tone]="tone()">{{ l.status || 'Unknown' }}</span>
            <span
              class="mode"
              [attr.data-sends]="modeInfo().sendsOrders"
              [title]="modeInfo().explanation"
              >{{ modeInfo().label }}</span
            >
          }
        </div>
        <div class="head-right">
          @if (updatedText()) {
            <span class="muted" aria-live="polite">{{ updatedText() }}</span>
          }
          <button type="button" class="btn" (click)="refresh()" [disabled]="resource.refreshing()">
            {{ resource.refreshing() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </header>

      @if (resource.loading()) {
        <p class="muted" role="status">Loading the live session…</p>
      } @else if (notFound()) {
        <div class="empty" role="status">
          <p class="empty-title">No live session</p>
          <p>{{ notFound() }}</p>
          <p class="muted">
            A script strategy runs live once it is Active; it trades on bound accounts only.
          </p>
        </div>
      } @else if (errorText() && !live()) {
        <div class="error" role="alert">
          <span>{{ errorText() }}</span>
          <button type="button" class="btn" (click)="refresh()">Retry</button>
        </div>
      } @else if (live(); as l) {
        @if (errorText()) {
          <p class="warn" role="status">
            The last refresh failed ({{ errorText() }}); showing the previous state.
          </p>
        }
        <!-- PE-08: what the session does and why, as the engine reports it. -->
        <p class="session-line">
          <strong>{{ modeInfo().label }}.</strong> {{ modeInfo().explanation }}
          @if (l.reason) {
            <span class="reason">{{ l.reason }}</span>
          }
        </p>
        @if (sortedWarnings().length > 0) {
          <section class="block warnings" aria-labelledby="live-warnings">
            <h4 class="block-title" id="live-warnings">
              Compile findings of the running session
              <span class="count">{{ sortedWarnings().length }}</span>
            </h4>
            <ul class="warning-list">
              @for (w of sortedWarnings(); track $index) {
                <li [attr.data-code]="w.code" [class.applied-input]="w.code === 'PS9301'">
                  <span class="code">{{ w.code }}</span>
                  <span class="warning-text">
                    {{ w.message }}
                    @if (w.line > 0) {
                      <span class="muted">(line {{ w.line }})</span>
                    }
                    @if (warningHint(w.code); as hint) {
                      <span class="hint-line">{{ hint }}</span>
                    }
                  </span>
                </li>
              }
            </ul>
          </section>
        }
        <section class="facts" aria-label="Session">
          <div class="fact">
            <span class="fact-label">Last bar</span>
            <span class="fact-value">{{ lastBarText() }}</span>
            @if (stale()) {
              <span class="fact-note warn-text">No new bar for {{ ageText() }}</span>
            } @else if (ageText()) {
              <span class="fact-note">{{ ageText() }}</span>
            }
          </div>
          <div class="fact">
            <span class="fact-label">Heartbeat</span>
            <span class="fact-value">{{ heartbeatText() }}</span>
            @if (heartbeatIsLate()) {
              <span class="fact-note warn-text"
                >The live worker has not advanced the session lately</span
              >
            } @else if (l.lastHeartbeatMs !== null) {
              <span class="fact-note">last advanced by the live worker</span>
            }
          </div>
          <div class="fact">
            <span class="fact-label">Equity (emulator)</span>
            <span class="fact-value">{{ equityText() }}</span>
          </div>
          <div class="fact">
            <span class="fact-label">Position (emulator)</span>
            <span class="fact-value" [attr.data-side]="headline().side">{{ headline().text }}</span>
            @if (headline().pnl !== null) {
              <span
                class="fact-note"
                [class.gain]="headline().pnl! > 0"
                [class.loss]="headline().pnl! < 0"
                >Open P&L {{ pnlText() }}</span
              >
            }
          </div>
          <div class="fact">
            <span class="fact-label">Divergences</span>
            <span class="fact-value" [class.loss]="l.divergences.length > 0">{{
              l.divergences.length
            }}</span>
            <span class="fact-note">emulator vs bound accounts</span>
          </div>
        </section>

        @if (positionFields().length > 0) {
          <details class="fold">
            <summary>Position details</summary>
            <dl class="kv">
              @for (f of positionFields(); track f.key) {
                <div>
                  <dt>{{ f.label }}</dt>
                  <dd>{{ f.value }}</dd>
                </div>
              }
            </dl>
          </details>
        }

        @if (l.orphanedPositions.length > 0) {
          <section class="block" aria-labelledby="live-orphaned">
            <h4 class="block-title" id="live-orphaned">
              Account positions from an earlier script version
              <span class="count">{{ l.orphanedPositions.length }}</span>
            </h4>
            <p class="hint">
              Opened on a bound account under a previous version of the script. The running script
              never closes or manages them — the operator decides. Their sizes are broker lots; the
              emulator's are units of the underlying.
            </p>
            <div class="table-wrap" tabindex="0" role="region" aria-labelledby="live-orphaned">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Position</th>
                    <th scope="col">Side</th>
                    <th scope="col">Size</th>
                    <th scope="col">Stop loss</th>
                    <th scope="col">Take profit</th>
                    <th scope="col">Status</th>
                    <th scope="col">Since (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of l.orphanedPositions; track p.positionId ?? $index) {
                    <tr>
                      <td>{{ accountLabel(p.accountId) }}</td>
                      <td class="nowrap">
                        {{ p.positionId !== null ? '#' + p.positionId : '—' }} ·
                        {{ p.symbol || '—' }}
                      </td>
                      <td>{{ p.direction === 'short' ? 'Short' : 'Long' }}</td>
                      <td class="nowrap">{{ lotsText(p.lots) }}</td>
                      <td>{{ priceText(p.stopLoss) }}</td>
                      <td>{{ priceText(p.takeProfit) }}</td>
                      <td>{{ p.status || '—' }}</td>
                      <td class="nowrap">{{ utcText(p.orphanedAtUtc) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <section class="block" aria-labelledby="live-open-trades">
          <h4 class="block-title" id="live-open-trades">
            Open trades <span class="count">{{ l.openTrades.length }}</span>
          </h4>
          @if (l.openTrades.length === 0) {
            <p class="muted">None.</p>
          } @else {
            <p class="hint">Select a trade to chart its entry and current stop / target.</p>
            <div class="table-wrap" tabindex="0" role="region" aria-labelledby="live-open-trades">
              <table>
                <thead>
                  <tr>
                    @for (c of tradeColumns(); track c.key) {
                      <th scope="col">{{ c.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of l.openTrades; track $index) {
                    <tr
                      class="trade-row"
                      tabindex="0"
                      role="button"
                      [attr.aria-label]="openTradeAriaLabel(row)"
                      (click)="onOpenTradeClick(row)"
                      (keydown.enter)="$event.preventDefault(); openOpenTrade(row)"
                      (keydown.space)="$event.preventDefault(); openOpenTrade(row)"
                    >
                      @for (c of tradeColumns(); track c.key) {
                        @if (c.key === 'origin') {
                          <td>
                            <span
                              class="origin"
                              [attr.data-origin]="rowOrigin(row) ?? 'unknown'"
                              [title]="originHint(rowOrigin(row))"
                              >{{ originBadge(rowOrigin(row)) }}</span
                            >
                          </td>
                        } @else {
                          <td>{{ cell(c.key, row) }}</td>
                        }
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="block" aria-labelledby="live-pending-orders">
          <h4 class="block-title" id="live-pending-orders">
            Pending orders <span class="count">{{ l.pendingOrders.length }}</span>
          </h4>
          @if (l.pendingOrders.length === 0) {
            <p class="muted">None.</p>
          } @else {
            <div
              class="table-wrap"
              tabindex="0"
              role="region"
              aria-labelledby="live-pending-orders"
            >
              <table>
                <thead>
                  <tr>
                    @for (c of orderColumns(); track c.key) {
                      <th scope="col">{{ c.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of l.pendingOrders; track $index) {
                    <tr>
                      @for (c of orderColumns(); track c.key) {
                        <td>{{ cell(c.key, row) }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="block" aria-labelledby="live-divergences">
          <h4 class="block-title" id="live-divergences">
            Divergences <span class="count">{{ l.divergences.length }}</span>
          </h4>
          <p class="hint">
            Where a bound account did not follow the emulator (a rejected order, slippage, a
            broker-side stop-out). The mirror records these; it never catches up by opening
            positions on its own.
          </p>
          @if (l.divergences.length === 0) {
            <p class="muted">None — every bound account matches the emulator.</p>
          } @else {
            <div class="table-wrap" tabindex="0" role="region" aria-labelledby="live-divergences">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time (UTC)</th>
                    <th scope="col">Account</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of sortedDivergences(); track $index) {
                    <tr>
                      <td class="nowrap">{{ divergenceTime(d) }}</td>
                      <td>{{ accountLabel(d.accountId) }}</td>
                      <td>
                        <span class="kind">{{ d.kind || '—' }}</span>
                      </td>
                      <td class="detail">{{ d.detail || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- PE-I2 (part): what the session did for real, without the warm-up replay. -->
        <section class="block" aria-labelledby="live-real-trades">
          <div class="block-head">
            <h4 class="block-title" id="live-real-trades">Paper and live trades</h4>
            @if (l.closedTrades.length > 0) {
              <button type="button" class="btn" (click)="downloadClosedTrades()">
                Download closed trades (CSV)
              </button>
            }
          </div>
          <p class="hint">
            Closed trades the session took after it went live — paper and live separately. The
            warm-up replay (history run before the session went live) is left out here; the report
            below counts it.
          </p>
          @if (!hasOrigins() && l.closedTrades.length > 0) {
            <p class="muted">This engine build does not mark where each trade came from.</p>
          } @else if (realStats().length === 0) {
            <p class="muted">No paper or live trade has closed yet.</p>
          } @else {
            <div class="table-wrap" tabindex="0" role="region" aria-labelledby="live-real-trades">
              <table class="stats">
                <thead>
                  <tr>
                    <th scope="col"></th>
                    @for (s of realStats(); track s.origin) {
                      <th scope="col">{{ originTitle(s.origin) }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Closed trades</th>
                    @for (s of realStats(); track s.origin) {
                      <td>{{ s.trades }} ({{ s.wins }} won · {{ s.losses }} lost)</td>
                    }
                  </tr>
                  <tr>
                    <th scope="row">Net profit</th>
                    @for (s of realStats(); track s.origin) {
                      <td
                        [class.gain]="(s.netProfit ?? 0) > 0"
                        [class.loss]="(s.netProfit ?? 0) < 0"
                      >
                        {{ money(s.netProfit, true) }}
                      </td>
                    }
                  </tr>
                  <tr>
                    <th scope="row">Win rate</th>
                    @for (s of realStats(); track s.origin) {
                      <td>{{ pct(s.winRate) }}</td>
                    }
                  </tr>
                  <tr>
                    <th scope="row">Profit factor</th>
                    @for (s of realStats(); track s.origin) {
                      <td>{{ ratio(s.profitFactor) }}</td>
                    }
                  </tr>
                  <tr>
                    <th scope="row">Expectancy</th>
                    @for (s of realStats(); track s.origin) {
                      <td>
                        {{ rText(s.expectancyR) }}
                        @if (s.rTrades < s.trades) {
                          <span class="muted">({{ s.rTrades }} with a stop)</span>
                        }
                      </td>
                    }
                  </tr>
                  <tr>
                    <th scope="row">Max drawdown</th>
                    @for (s of realStats(); track s.origin) {
                      <td>{{ money(s.maxDrawdown, false) }}</td>
                    }
                  </tr>
                  <tr>
                    <th scope="row">Since</th>
                    @for (s of realStats(); track s.origin) {
                      <td class="nowrap">{{ dateText(s.firstEntryMs) }}</td>
                    }
                  </tr>
                </tbody>
              </table>
            </div>
          }
        </section>

        @if (hasReport()) {
          <app-strategy-report
            [report]="l.report"
            heading="Live emulator report"
            [headingNote]="warmupNote()"
            [tradesClickable]="true"
            [tradeOrigin]="reportTradeOrigin()"
            (tradeClick)="openReportTrade($event)"
          />
        } @else {
          <p class="muted">The live session has not produced a report yet.</p>
        }
      }
    </div>

    <!-- Trade chart: mounted once, outside the polled blocks, and driven by a selection that only
         a click sets — a refresh never closes, reloads or re-frames an open chart. -->
    <app-ea-trade-chart-modal
      [selection]="chartSelection()"
      [open]="chartOpen()"
      (openChange)="chartOpen.set($event)"
    />
  `,
  styles: [
    `
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .head-left,
      .head-right {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .status {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status[data-tone='success'] {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .status[data-tone='info'] {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .status[data-tone='error'] {
        background: rgba(255, 59, 48, 0.12);
        color: var(--loss);
      }
      .mode {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .mode[data-sends='true'] {
        border-color: rgba(255, 149, 0, 0.6);
        color: #b25e00;
      }
      .session-line {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-secondary);
      }
      .session-line .reason {
        display: block;
        color: var(--text-primary);
      }
      .warning-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .warning-list li {
        display: flex;
        gap: var(--space-3);
        align-items: baseline;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid rgba(255, 149, 0, 0.35);
        background: rgba(255, 149, 0, 0.07);
        font-size: var(--text-sm);
      }
      .warning-list li.applied-input {
        border-color: rgba(255, 59, 48, 0.45);
        background: rgba(255, 59, 48, 0.08);
      }
      .warning-list .code {
        flex-shrink: 0;
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .hint-line {
        display: block;
        margin-top: 2px;
        color: var(--text-secondary);
      }
      .block-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      table.stats th[scope='row'] {
        text-align: left;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: var(--space-3);
      }
      .fact {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .fact-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .fact-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        overflow-wrap: anywhere;
      }
      .fact-value[data-side='long'] {
        color: var(--accent);
      }
      .fact-value[data-side='short'] {
        color: #b25000;
      }
      .fact-note {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .warn-text {
        color: #b25000;
      }
      .gain {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .fold summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .kv {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-2) var(--space-5);
        margin: var(--space-2) 0 0;
      }
      .kv div {
        display: flex;
        justify-content: space-between;
        gap: var(--space-3);
        border-bottom: 1px solid var(--border);
        padding: 4px 0;
        font-size: var(--text-sm);
      }
      .kv dt {
        color: var(--text-secondary);
      }
      .kv dd {
        margin: 0;
        font-weight: var(--font-medium);
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .block-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .count {
        margin-left: 4px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .table-wrap:focus-visible,
      .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        white-space: nowrap;
      }
      .trade-row {
        cursor: pointer;
      }
      .trade-row:hover td {
        background: var(--bg-tertiary);
      }
      .trade-row:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .origin {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .origin[data-origin='warmup'] {
        border: 1px dashed currentColor;
        color: #b25000;
      }
      .origin[data-origin='paper'] {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .origin[data-origin='live'] {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .nowrap {
        white-space: nowrap;
      }
      .detail {
        min-width: 240px;
      }
      .kind {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: progress;
      }
      .muted {
        margin: 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .empty p {
        margin: 0 0 var(--space-1);
      }
      .empty-title {
        font-weight: var(--font-semibold);
      }
      .warn {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 149, 0, 0.1);
        font-size: var(--text-sm);
      }
      .error {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class ScriptLivePanelComponent {
  private readonly api = inject(ScriptStrategyService);
  private readonly executionApi = inject(StrategyExecutionService);

  readonly strategyId = input.required<number>();
  /** The strategy's engine symbol / timeframe, for the trade chart; the live report's are the fallback. */
  readonly symbol = input<string | null>(null);
  readonly timeframe = input<string | null>(null);

  /**
   * The trade chart's selection. Set on a click only — never derived from the polled payload — so
   * a refresh cannot swap it under an open chart (a new selection reloads the candles).
   */
  readonly chartSelection = signal<TradeChartSelection | null>(null);
  readonly chartOpen = signal(false);

  /** Account names for the divergence table, from the strategy's bindings. */
  private readonly accountNames = signal<ReadonlyMap<string, string>>(new Map());
  private readonly now = signal(Date.now());

  /**
   * The engine's envelope, polled. A failed refresh keeps the last good envelope on screen
   * (`resource.error()` carries the failure); a "not found" envelope replaces it, because then
   * the session really is gone.
   */
  readonly resource = createPolledResource(() => this.api.getLiveStatus(this.strategyId()), {
    intervalMs: POLL_MS,
    runImmediately: false,
  });

  private readonly envelope = computed(() => this.resource.value());

  readonly live = computed(() => {
    const env = this.envelope();
    return env && isOk(env) ? normalizeLiveStatus(env.data) : null;
  });

  /** The engine answered "no live session" (not an outage). */
  readonly notFound = computed(() => {
    const env = this.envelope();
    if (!env || isOk(env)) return null;
    return env.responseCode === '-14'
      ? describeFailure(env, 'This strategy has no live session.')
      : null;
  });

  readonly errorText = computed(() => {
    const err = this.resource.error();
    if (err) return describeFailure(err, 'The live status could not be loaded.');
    const env = this.envelope();
    if (env && !isOk(env) && env.responseCode !== '-14') {
      return describeFailure(env, 'The live status could not be loaded.');
    }
    return null;
  });

  readonly tone = computed(() => liveStatusTone(this.live()?.status ?? ''));

  private readonly report = computed(() => normalizeStrategyReport(this.live()?.report ?? null));
  readonly hasReport = computed(() => this.report() !== null);
  private readonly currency = computed(() => {
    const r = this.report();
    return r ? reportCurrency(r) : '';
  });

  private readonly priceDecimals = computed(() => {
    const l = this.live();
    if (!l) return 5;
    const prices: (number | null)[] = [];
    for (const row of [...l.openTrades, ...l.pendingOrders, l.position ?? {}]) {
      for (const [k, v] of Object.entries(row)) {
        if (/price|limit|stop/i.test(k) && typeof v === 'number') prices.push(v);
      }
    }
    for (const p of l.orphanedPositions) prices.push(p.stopLoss, p.takeProfit);
    // The live report's trades carry the most quotes; they settle the symbol's precision.
    for (const t of this.report()?.trades ?? []) prices.push(t.entryPrice, t.exitPrice);
    return prices.some((p) => p !== null) ? inferPriceDecimals(prices) : 5;
  });

  readonly headline = computed(() =>
    positionHeadline(this.live()?.position ?? null, this.priceDecimals()),
  );
  readonly pnlText = computed(() =>
    formatMoney(this.headline().pnl, this.currency(), { signed: true }),
  );

  readonly positionFields = computed(() => {
    const p = this.live()?.position;
    if (!p) return [];
    return Object.entries(p)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .map(([key, v]) => ({
        key,
        label: humanize(key),
        value: formatLiveValue(key, v, this.currency(), this.priceDecimals()),
      }));
  });

  readonly tradeColumns = computed(() =>
    deriveColumns(this.live()?.openTrades ?? [], OPEN_TRADE_COLUMNS),
  );

  readonly orderColumns = computed(() =>
    deriveColumns(this.live()?.pendingOrders ?? [], PENDING_ORDER_COLUMNS),
  );

  /** The session's closed and open trades as the chart reads them (SL/TP, origin). */
  private readonly tradeBook = computed(() => liveTradeBook(this.live()));
  /** False on an engine build that tags no trade with its origin. */
  readonly hasOrigins = computed(() => hasTradeOrigins(this.tradeBook()));

  /** Per-row origin lookups, cached until the next payload (the grid asks per render). */
  private readonly originCache = computed(() => {
    this.tradeBook();
    return new WeakMap<ReportTrade, TradeOrigin | null>();
  });

  /**
   * The report's Origin column source. One function for the component's lifetime — the grid
   * rebuilds its columns when this reference changes — reading the latest payload when called.
   */
  private readonly originOfReportTrade: TradeOriginOf = (trade) =>
    untracked(() => {
      const cache = this.originCache();
      if (cache.has(trade)) return cache.get(trade) ?? null;
      const origin = matchLiveFill(trade, this.tradeBook())?.origin ?? null;
      cache.set(trade, origin);
      return origin;
    });

  /** Null on an older engine: the report then lists no Origin column of unknowns. */
  readonly reportTradeOrigin = computed<TradeOriginOf | null>(() =>
    this.hasOrigins() ? this.originOfReportTrade : null,
  );

  readonly warmupNote = computed(
    () =>
      'Warm-up trades are a historical replay run before the session went live — not paper ' +
      'evidence, though this report’s statistics include them (the "Paper and live trades" table ' +
      'above leaves them out). ' +
      (this.hasOrigins()
        ? 'The Origin column marks them; select a trade to chart it.'
        : 'This engine build does not mark which trades they are; select a trade to chart it.'),
  );

  readonly sortedDivergences = computed(() =>
    [...(this.live()?.divergences ?? [])].sort((a, b) =>
      (b.timeUtc || '').localeCompare(a.timeUtc || ''),
    ),
  );

  readonly equityText = computed(() => {
    const e = this.live()?.equity;
    if (typeof e === 'number') return formatMoney(e, this.currency());
    if (e && typeof e === 'object') {
      const v = (e as Record<string, unknown>)['equity'];
      return typeof v === 'number' ? formatMoney(v, this.currency()) : NA;
    }
    return NA;
  });

  readonly lastBarText = computed(() => {
    const t = this.live()?.lastBarTimeMs ?? null;
    return t === null ? NA : `${formatDateTime(t)} UTC`;
  });

  private readonly ageMinutes = computed(() =>
    barAgeMinutes(this.live()?.lastBarTimeMs ?? null, this.now()),
  );
  readonly ageText = computed(() => formatAge(this.ageMinutes()));
  readonly stale = computed(() => {
    const age = this.ageMinutes();
    return age !== null && age > STALE_MINUTES && this.tone() === 'success';
  });

  readonly updatedText = computed(() => {
    const at = this.resource.lastUpdated();
    if (!at) return '';
    const s = Math.max(0, Math.round((this.now() - at) / 1000));
    return s < 5 ? 'Updated just now' : `Updated ${s}s ago`;
  });

  // ── PE-08: mode, reason, heartbeat, compile findings ──────────────────────

  readonly modeInfo = computed(() => liveModeInfo(this.live()?.mode));

  readonly heartbeatText = computed(() => {
    const t = this.live()?.lastHeartbeatMs ?? null;
    if (t === null) return NA;
    return `${formatAge(Math.max(0, Math.round((this.now() - t) / 60_000)))} · ${formatDateTime(t)} UTC`;
  });

  readonly heartbeatIsLate = computed(() => {
    const l = this.live();
    return (
      !!l &&
      this.tone() === 'success' &&
      heartbeatLate(l.lastHeartbeatMs, this.timeframe(), this.now())
    );
  });

  readonly sortedWarnings = computed(() => sortLiveWarnings(this.live()?.warnings ?? []));

  warningHint(code: string): string | null {
    return liveWarningHint(code);
  }

  // ── PE-I2 (part): paper / live statistics without the warm-up replay ───────

  readonly realStats = computed<OriginStats[]>(() => {
    const trades = this.live()?.closedTrades ?? [];
    return (['paper', 'live'] as const)
      .map((o) => originStats(trades, o))
      .filter((s) => s.trades > 0);
  });

  originTitle(origin: TradeOrigin): string {
    return tradeOriginTitle(origin);
  }

  money(v: number | null, signed: boolean): string {
    return formatMoney(v, this.currency(), { signed });
  }

  pct(v: number | null): string {
    return v === null ? NA : `${(v * 100).toFixed(1)}%`;
  }

  ratio(v: number | null): string {
    return v === null ? NA : v.toFixed(2);
  }

  rText(v: number | null): string {
    return v === null ? NA : `${v >= 0 ? '+' : ''}${v.toFixed(2)} R per trade`;
  }

  dateText(ms: number | null): string {
    return ms === null ? NA : `${formatDateTime(ms)} UTC`;
  }

  /** PE-I14: the closed trades (with their origin) as CSV. */
  downloadClosedTrades(): void {
    const trades = this.live()?.closedTrades ?? [];
    if (trades.length === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    saveBlob(
      new Blob([liveClosedTradesCsv(trades)], { type: 'text/csv;charset=utf-8' }),
      `${fileStamp('live-trades', this.symbol(), this.timeframe(), day)}.csv`,
    );
  }

  constructor() {
    effect(() => {
      this.strategyId();
      untracked(() => {
        this.resource.refresh();
        this.loadAccountNames();
      });
    });
    // Keeps the relative times honest between polls.
    const tick = setInterval(() => this.now.set(Date.now()), 10_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  refresh(): void {
    this.now.set(Date.now());
    this.resource.refresh();
  }

  cell(key: string, row: Record<string, unknown>): string {
    return formatLiveValue(key, row[key], this.currency(), this.priceDecimals());
  }

  /** A List-of-trades row of the live report → the trade chart. */
  openReportTrade(row: ReportTrade): void {
    this.showChart(liveReportTradeChart(row, this.tradeBook(), this.chartContext())?.selection);
  }

  /** A row of the Open trades table → the trade chart (entry, current SL/TP, runs to now). */
  openOpenTrade(row: Record<string, unknown>): void {
    const chart = liveOpenTradeChart(row, this.report()?.trades ?? [], this.chartContext());
    this.showChart(chart?.selection);
  }

  onOpenTradeClick(row: Record<string, unknown>): void {
    // Cells are text-selectable; a drag to copy a price must not open the chart.
    if ((globalThis.getSelection?.()?.toString() ?? '').length > 0) return;
    this.openOpenTrade(row);
  }

  rowOrigin(row: Record<string, unknown>): TradeOrigin | null {
    return parseTradeOrigin(row['origin']);
  }

  originBadge(origin: TradeOrigin | null): string {
    return origin ? TRADE_ORIGIN_BADGES[origin] : NA;
  }

  originHint(origin: TradeOrigin | null): string {
    return tradeOriginHint(origin);
  }

  openTradeAriaLabel(row: Record<string, unknown>): string {
    const side = String(row['direction'] ?? '')
      .toLowerCase()
      .startsWith('s')
      ? 'short'
      : 'long';
    const id = typeof row['entryId'] === 'string' && row['entryId'] ? ` ${row['entryId']}` : '';
    const origin = 'origin' in row ? `, ${tradeOriginTitle(this.rowOrigin(row))}` : '';
    return `Chart open ${side} trade${id}${origin}`;
  }

  private chartContext(): LiveChartContext {
    return liveChartContext(
      { symbol: this.symbol(), timeframe: this.timeframe() },
      this.report()?.meta,
    );
  }

  private showChart(selection: TradeChartSelection | null | undefined): void {
    if (!selection) return;
    this.chartSelection.set(selection);
    this.chartOpen.set(true);
  }

  divergenceTime(d: ScriptDivergence): string {
    return this.utcText(d.timeUtc);
  }

  /** An ISO time as "2026-01-07 09:30" (UTC), or the text as sent when it does not parse. */
  utcText(iso: string): string {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? formatDateTime(t) : iso || NA;
  }

  /** An account position's size — broker lots, never units. */
  lotsText(lots: number | null): string {
    return formatBrokerLots(lots);
  }

  priceText(price: number | null): string {
    return formatPrice(price, this.priceDecimals());
  }

  accountLabel(id: number | string | null): string {
    if (id === null || id === '') return NA;
    const name = this.accountNames().get(String(id));
    return name ? `${name} (#${id})` : `Account #${id}`;
  }

  private loadAccountNames(): void {
    this.executionApi
      .getAccountBindings(this.strategyId())
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (!res || !isOk(res)) return;
        const map = new Map<string, string>();
        for (const b of res.data ?? []) {
          if (b.accountName) map.set(String(b.tradingAccountId), b.accountName);
        }
        this.accountNames.set(map);
      });
  }
}
