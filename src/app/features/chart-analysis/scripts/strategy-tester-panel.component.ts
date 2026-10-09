import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  ScriptInputDto,
  ScriptInputValue,
  ScriptInputValues,
  ScriptStrategyPropertyOverrides,
} from '@core/api/scripting.types';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import { formatMoney, formatNumber, formatPercent } from '@features/scripting/report/report-format';
import { StrategyReportComponent } from '@features/scripting/report/strategy-report.component';
import { describeFailure, isOk } from '@features/scripting/shared/api-error';
import {
  inputDefault,
  inputOverrides,
  resolveInputValues,
} from '@features/scripting/pine/pine-inputs';
import { ChartIconComponent } from '../icons/chart-icon.component';
import type { ChartScriptResult, ChartTrade } from './chart-script.model';
import {
  COMMISSION_TYPES,
  QTY_TYPES,
  draftFromReport,
  draftProblems,
  overriddenLabel,
  overridesFrom,
  type PropertyDraft,
} from './strategy-properties';
import { tradeDetail, tradeTimeLabel, type TradeDetail } from './trade-detail';
import {
  deepBacktestRequest,
  formatPrice,
  orderTrades,
  rowWindow,
  type DeepBacktestTarget,
} from './tester-trades';

type TesterTab = 'report' | 'trades' | 'inputs' | 'properties';

/** Trades the chart asked the tester to show (a fill arrow clicked, PC-I5): `seq` re-asks for the same. */
export interface TradeReveal {
  numbers: readonly number[];
  seq: number;
}

/** List of trades row height (px) and the rows rendered beyond the view either side. */
const ROW_H = 30;
const OVERSCAN = 10;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The chart's Strategy Tester (TradingView's bottom panel), PC-I5 / PC-12:
 *
 * - **Report** — the console's strategy report (`app-strategy-report`): overview with the equity
 *   curve, performance, trades analysis, risk and returns, R, capital, monthly returns, properties,
 *   and the report's warnings (margin calls, a risk halt, trimmed trades, engine notes).
 * - **List of trades** — virtualised (thousands of trades render a few dozen rows), prices at the
 *   symbol's precision; a click frames the trade on the chart, a long-press, right-click or
 *   Shift+Enter opens its detail; a fill arrow clicked on the chart selects its rows here.
 * - **Inputs** — re-run with other inputs, measured against the defaults the strategy runs on.
 *
 * An engine strategy can be sent to a deep backtest (`POST backtest`, deep mode) as the chart runs
 * it: the chart's market, timeframe and inputs over a date range.
 *
 * <p>Units: the engine report's `…Percent` fields — including percent profitable — are already
 * percentages (41.67 = 41.67 %); money is in the report's account currency.</p>
 */
@Component({
  selector: 'app-strategy-tester-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent, StrategyReportComponent, RouterLink],
  template: `
    <section class="tester" aria-label="Strategy tester">
      <header class="tester__bar">
        <strong class="tester__title">{{ result()?.title ?? 'Strategy tester' }}</strong>
        <nav class="tester__tabs" role="tablist">
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              [class.active]="tab() === t.id"
              [attr.aria-selected]="tab() === t.id"
              (click)="tab.set(t.id)"
            >
              {{ t.label }}
              @if (t.id === 'trades') {
                <span class="tester__count">{{ trades().length }}</span>
              }
            </button>
          }
        </nav>
        @if (warnings().length && !suspended()) {
          <button
            type="button"
            class="tester__warn"
            data-testid="tester-warnings"
            [title]="warnings().join('\\n')"
            (click)="tab.set('report')"
          >
            <app-chart-icon name="warning" [size]="14" />
            {{ warnings().length }} warning{{ warnings().length === 1 ? '' : 's' }}
          </button>
        }
        <span class="tester__spacer"></span>
        @if (running()) {
          <span class="tester__muted" role="status">Running…</span>
        }
        @if (deep()) {
          <button
            type="button"
            class="tester__btn"
            data-testid="tester-deep"
            title="Queue a deep backtest of this strategy as the chart runs it"
            (click)="openDeep()"
          >
            Deep backtest…
          </button>
        }
        <button
          type="button"
          class="tester__icon"
          aria-label="Close strategy tester"
          (click)="closed.emit()"
        >
          <app-chart-icon name="close" [size]="18" />
        </button>
      </header>

      @if (result()?.error; as err) {
        <div class="tester__error" role="alert">{{ err }}</div>
      }

      <div class="tester__body" [class.tester__body--list]="tab() === 'trades' && !suspended()">
        @if (suspended() && tab() !== 'inputs') {
          <!-- Bar Replay (PC-08): the run's trades reach past the head — not shown until the run to the head lands. -->
          <p class="tester__muted" role="status" data-testid="tester-suspended">
            {{ suspended() }}
          </p>
        } @else {
          @switch (tab()) {
            @case ('report') {
              @if (result()?.strategy?.report; as report) {
                <app-strategy-report
                  [report]="report"
                  heading="Strategy report"
                  [hideTabs]="hiddenReportTabs"
                />
              } @else {
                <p class="tester__muted">
                  No strategy report — run a strategy() script to see results.
                </p>
              }
            }
            @case ('trades') {
              <!-- One scroller: the header row sticks, the rows are rendered in a window. -->
              <div #viewport class="tl__viewport" (scroll)="onScroll()">
                <div
                  class="tl"
                  role="table"
                  aria-label="List of trades"
                  [attr.aria-rowcount]="ordered().length + 1"
                >
                  <div class="tl__row tl__head" role="row">
                    <button
                      type="button"
                      role="columnheader"
                      class="tl__sort"
                      [attr.aria-sort]="newestFirst() ? 'descending' : 'ascending'"
                      title="Order by trade number"
                      (click)="newestFirst.set(!newestFirst())"
                    >
                      # {{ newestFirst() ? '↓' : '↑' }}
                    </button>
                    <span role="columnheader">Type</span>
                    <span role="columnheader">Signal</span>
                    <span role="columnheader">Entry</span>
                    <span role="columnheader" class="num">Price</span>
                    <span role="columnheader">Exit</span>
                    <span role="columnheader" class="num">Price</span>
                    <span role="columnheader" class="num">Qty</span>
                    <span role="columnheader" class="num">Profit</span>
                    <span role="columnheader" class="num">Cum. profit</span>
                  </div>
                  @if (ordered().length === 0) {
                    <p class="tester__muted tl__empty">No trades.</p>
                  }
                  <div class="tl__spacer" [style.height.px]="rows().total">
                    <div class="tl__rows" [style.transform]="'translateY(' + rows().offset + 'px)'">
                      @for (t of visible(); track t.number) {
                        <div
                          class="tl__row tl__trade"
                          role="row"
                          tabindex="0"
                          [attr.data-trade]="t.number"
                          [class.selected]="selected().has(t.number)"
                          [attr.aria-selected]="selected().has(t.number)"
                          [attr.aria-label]="
                            'Trade ' + t.number + ': click to show on chart, long-press for details'
                          "
                          title="Click: show on chart · Long-press or right-click: trade details"
                          (pointerdown)="pressStart(t, $event)"
                          (pointerup)="pressEnd(t, $event)"
                          (pointerleave)="pressCancel()"
                          (pointercancel)="pressCancel()"
                          (contextmenu)="$event.preventDefault(); openDetail(t)"
                          (keydown.enter)="focusTrade(t)"
                          (keydown.shift.enter)="$event.preventDefault(); openDetail(t)"
                        >
                          <span role="cell">{{ t.number }}</span>
                          <span role="cell" [class]="t.side === 'long' ? 'pos' : 'neg'">
                            {{ t.side === 'long' ? 'Long' : 'Short'
                            }}{{ t.isOpen ? ' (open)' : '' }}
                          </span>
                          <span role="cell" class="tl__signal" [title]="signalOf(t)">{{
                            signalOf(t)
                          }}</span>
                          <span role="cell">{{ tradeTime(t.entryTime) }}</span>
                          <span role="cell" class="num">{{ price(t.entryPrice) }}</span>
                          <span role="cell">{{ t.isOpen ? 'Open' : tradeTime(t.exitTime) }}</span>
                          <span role="cell" class="num">{{ price(t.exitPrice) }}</span>
                          <span role="cell" class="num">{{ num(t.qty, 0) }}</span>
                          <span role="cell" class="num" [class]="tone(t.profit)">
                            {{ money(t.profit, true) }}
                            <small>{{ pct(t.profitPercent, true) }}</small>
                          </span>
                          <span role="cell" class="num" [class]="tone(t.cumulativeProfit)">
                            {{ money(t.cumulativeProfit, true) }}
                          </span>
                        </div>
                      }
                    </div>
                  </div>
                </div>
              </div>
            }
            @case ('inputs') {
              @if (inputs() === null) {
                <p class="tester__muted" role="status">Loading the strategy's saved inputs…</p>
              } @else {
                <!-- novalidate: Pine's step is a spinner increment, not a constraint — the browser
                     read input.float(1.0, minval = 0.05)'s step 1 as one and silently refused every
                     Re-run. Values are coerced on the way out (emitRerun). -->
                <form
                  class="tester__inputs"
                  novalidate
                  (submit)="$event.preventDefault(); emitRerun()"
                >
                  @for (i of editableInputs(); track i.id) {
                    <label class="field">
                      <span>{{ i.title }}</span>
                      @switch (i.kind) {
                        @case ('bool') {
                          <input
                            type="checkbox"
                            [checked]="value(i) === true"
                            (change)="set(i, $any($event.target).checked)"
                          />
                        }
                        @case ('int') {
                          <input
                            type="number"
                            step="1"
                            [min]="i.minValue ?? null"
                            [max]="i.maxValue ?? null"
                            [value]="value(i)"
                            (change)="set(i, toNumber($any($event.target).value, true))"
                          />
                        }
                        @case ('float') {
                          <input
                            type="number"
                            [step]="i.step ?? 'any'"
                            [min]="i.minValue ?? null"
                            [max]="i.maxValue ?? null"
                            [value]="value(i)"
                            (change)="set(i, toNumber($any($event.target).value, false))"
                          />
                        }
                        @default {
                          @if (i.options?.length) {
                            <select
                              (change)="set(i, i.options![$any($event.target).selectedIndex])"
                            >
                              @for (o of i.options; track $index) {
                                <option [selected]="o === value(i)">
                                  {{ i.optionTexts?.[$index] ?? o }}
                                </option>
                              }
                            </select>
                          } @else {
                            <input
                              type="text"
                              [value]="value(i)"
                              (change)="set(i, $any($event.target).value)"
                            />
                          }
                        }
                      }
                    </label>
                  } @empty {
                    <p class="tester__muted">This script has no inputs.</p>
                  }
                  <div class="tester__actions">
                    <button type="button" (click)="reset()">Defaults</button>
                    <button type="submit" class="primary" [disabled]="running()">Re-run</button>
                  </div>
                </form>
              }
            }
            @case ('properties') {
              @if (propertyDraft(); as p) {
                <!-- PC-I5: TradingView's Properties dialog. novalidate: values are checked by
                     draftProblems (the engine's own limits) and named in plain words. -->
                <form
                  class="tester__inputs tester__props"
                  novalidate
                  data-testid="tester-properties"
                  (submit)="$event.preventDefault(); emitProperties()"
                >
                  <label class="field">
                    <span>Initial capital</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      [value]="p.initialCapital"
                      (change)="
                        setProp('initialCapital', toNumber($any($event.target).value, false))
                      "
                    />
                  </label>
                  <label class="field">
                    <span>Base currency</span>
                    <input
                      type="text"
                      maxlength="4"
                      [value]="p.currency"
                      (change)="setProp('currency', $any($event.target).value)"
                    />
                  </label>
                  <label class="field">
                    <span>Order size</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      [value]="p.defaultQtyValue"
                      (change)="
                        setProp('defaultQtyValue', toNumber($any($event.target).value, false))
                      "
                    />
                  </label>
                  <label class="field">
                    <span>Order size type</span>
                    <select
                      (change)="
                        setProp('defaultQtyType', qtyTypes[$any($event.target).selectedIndex].value)
                      "
                    >
                      @for (o of qtyTypes; track o.value) {
                        <option [selected]="o.value === p.defaultQtyType">{{ o.label }}</option>
                      }
                    </select>
                  </label>
                  <label class="field">
                    <span>Pyramiding (orders)</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      [value]="p.pyramiding"
                      (change)="setProp('pyramiding', toNumber($any($event.target).value, true))"
                    />
                  </label>
                  <label class="field">
                    <span>Commission</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      [value]="p.commissionValue"
                      (change)="
                        setProp('commissionValue', toNumber($any($event.target).value, false))
                      "
                    />
                  </label>
                  <label class="field">
                    <span>Commission type</span>
                    <select
                      (change)="
                        setProp(
                          'commissionType',
                          commissionTypes[$any($event.target).selectedIndex].value
                        )
                      "
                    >
                      @for (o of commissionTypes; track o.value) {
                        <option [selected]="o.value === p.commissionType">{{ o.label }}</option>
                      }
                    </select>
                  </label>
                  <label class="field">
                    <span>Verify price for limit orders (ticks)</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      [value]="p.backtestFillLimitsAssumption"
                      (change)="
                        setProp(
                          'backtestFillLimitsAssumption',
                          toNumber($any($event.target).value, true)
                        )
                      "
                    />
                  </label>
                  <label class="field">
                    <span>Slippage (ticks)</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      [value]="p.slippage"
                      (change)="setProp('slippage', toNumber($any($event.target).value, true))"
                    />
                  </label>
                  <label class="field">
                    <span>Margin for long positions (%)</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="any"
                      [value]="p.marginLong"
                      (change)="setProp('marginLong', toNumber($any($event.target).value, false))"
                    />
                  </label>
                  <label class="field">
                    <span>Margin for short positions (%)</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="any"
                      [value]="p.marginShort"
                      (change)="setProp('marginShort', toNumber($any($event.target).value, false))"
                    />
                  </label>
                  <label class="field">
                    <span>Close entries rule</span>
                    <select (change)="setProp('closeEntriesRule', $any($event.target).value)">
                      <option value="FIFO" [selected]="p.closeEntriesRule === 'FIFO'">FIFO</option>
                      <option value="ANY" [selected]="p.closeEntriesRule === 'ANY'">Any</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Risk-free rate (%)</span>
                    <input
                      type="number"
                      step="any"
                      [value]="p.riskFreeRate"
                      (change)="setProp('riskFreeRate', toNumber($any($event.target).value, false))"
                    />
                  </label>
                  <label class="field check">
                    <input
                      type="checkbox"
                      [checked]="p.calcOnOrderFills"
                      (change)="setProp('calcOnOrderFills', $any($event.target).checked)"
                    />
                    <span>Recalculate after an order fills</span>
                  </label>
                  <label class="field check">
                    <input
                      type="checkbox"
                      [checked]="p.calcOnEveryTick"
                      (change)="setProp('calcOnEveryTick', $any($event.target).checked)"
                    />
                    <span>Recalculate on every tick (live only differs)</span>
                  </label>
                  <label class="field check">
                    <input
                      type="checkbox"
                      [checked]="p.processOrdersOnClose"
                      (change)="setProp('processOrdersOnClose', $any($event.target).checked)"
                    />
                    <span>Fill orders on bar close</span>
                  </label>
                  <label class="field check">
                    <input
                      type="checkbox"
                      [checked]="p.useBarMagnifier"
                      (change)="setProp('useBarMagnifier', $any($event.target).checked)"
                    />
                    <span>Use bar magnifier</span>
                  </label>
                  <label class="field check">
                    <input
                      type="checkbox"
                      [checked]="p.fillOrdersOnStandardOhlc"
                      (change)="setProp('fillOrdersOnStandardOhlc', $any($event.target).checked)"
                    />
                    <span>Fill orders on standard OHLC</span>
                  </label>
                  @if (propertyProblems().length) {
                    <ul class="tester__problems" role="alert">
                      @for (m of propertyProblems(); track m) {
                        <li>{{ m }}</li>
                      }
                    </ul>
                  }
                  <p class="tester__muted tester__props-note">
                    @if (overridden()) {
                      Overridden for this chart: {{ overridden() }}. Deep backtests queued from here
                      use them too; such a backtest never counts as evidence for the strategy.
                    } @else {
                      The run uses the script's own strategy() properties.
                    }
                  </p>
                  <div class="tester__actions">
                    <button
                      type="button"
                      (click)="resetProperties()"
                      [disabled]="!overridden() || running()"
                    >
                      Script's own
                    </button>
                    <button
                      type="submit"
                      class="primary"
                      [disabled]="running() || propertyProblems().length > 0"
                    >
                      Re-run
                    </button>
                  </div>
                </form>
              } @else {
                <p class="tester__muted">Run a strategy() script to edit its properties.</p>
              }
            }
          }
        }
      </div>
    </section>

    <!-- A trade's detail: a native modal (the top layer — no ancestor transform can misplace it). -->
    <dialog
      #detailBox
      class="td"
      [attr.aria-label]="(detail()?.title ?? 'Trade') + ' details'"
      (close)="detail.set(null)"
    >
      @if (detail(); as d) {
        <header class="td__head">
          <strong>{{ d.title }}</strong>
          <span class="td__side" [class.pos]="d.side === 'long'" [class.neg]="d.side === 'short'">{{
            d.side === 'long' ? 'Long' : 'Short'
          }}</span>
          <span class="td__spacer"></span>
          <button type="button" class="td__btn" (click)="focusTrade(detailTrade()!); closeDetail()">
            Show on chart
          </button>
          <button type="button" class="td__x" aria-label="Close" (click)="closeDetail()">×</button>
        </header>
        <div class="td__body">
          <div class="td__cols">
            <div>
              <h4>Trade</h4>
              <dl>
                @for (r of d.trade; track r.label) {
                  <dt>{{ r.label }}</dt>
                  <dd [class]="r.tone ?? ''">{{ r.value }}</dd>
                }
              </dl>
            </div>
            <div>
              <h4>Outcome</h4>
              <dl>
                @for (r of d.outcome; track r.label) {
                  <dt>{{ r.label }}</dt>
                  <dd [class]="r.tone ?? ''">{{ r.value }}</dd>
                }
              </dl>
            </div>
          </div>
          <h4>Strategy values at entry and exit</h4>
          @if (d.series.length) {
            <table class="td__table">
              <thead>
                <tr>
                  <th>Series</th>
                  <th>At entry</th>
                  <th>At exit</th>
                </tr>
              </thead>
              <tbody>
                @for (s of d.series; track s.title) {
                  <tr>
                    <td><span class="td__dot" [style.background]="s.color"></span>{{ s.title }}</td>
                    <td>{{ s.entryText }}</td>
                    <td>{{ s.exitText }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="td__muted">
              This strategy plots nothing, so there are no indicator values to show.
            </p>
          }
          <h4>Bar at entry and exit</h4>
          <table class="td__table">
            <thead>
              <tr>
                <th></th>
                <th>Entry bar</th>
                <th>Exit bar</th>
              </tr>
            </thead>
            <tbody>
              @for (b of d.bars; track b.label) {
                <tr>
                  <td>{{ b.label }}</td>
                  <td>{{ b.entry ?? '—' }}</td>
                  <td>{{ b.exit ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
          @if (d.inputs.length) {
            <h4>Inputs used</h4>
            <dl class="td__inputs">
              @for (r of d.inputs; track r.label) {
                <dt>{{ r.label }}</dt>
                <dd>{{ r.value }}</dd>
              }
            </dl>
          }
        </div>
      }
    </dialog>

    <!-- Deep backtest (engine strategies): the chart's market, timeframe and inputs over a range. -->
    <dialog #deepBox class="db" aria-label="Deep backtest" (close)="deepOpen.set(false)">
      @if (deepOpen() && deep(); as d) {
        <form class="db__form" novalidate (submit)="$event.preventDefault(); queueDeep()">
          <header class="td__head">
            <strong>Deep backtest</strong>
            <span class="td__spacer"></span>
            <button type="button" class="td__x" aria-label="Close" (click)="closeDeep()">×</button>
          </header>
          <div class="db__body">
            <p class="td__muted">
              {{ d.chartSymbol }} · {{ d.chartTimeframe ?? d.strategyTimeframe }} with the chart's
              inputs, through the engine's backtester in deep mode (up to 2M bars).
              @if (!d.chartTimeframe) {
                This chart's timeframe is not a backtest timeframe: it runs on the strategy's own
                {{ d.strategyTimeframe }}.
              }
            </p>
            <label class="field">
              <span>From</span>
              <input
                type="date"
                [value]="deepFrom()"
                (change)="deepFrom.set($any($event.target).value)"
                aria-label="From"
              />
            </label>
            <label class="field">
              <span>To</span>
              <input
                type="date"
                [value]="deepTo()"
                (change)="deepTo.set($any($event.target).value)"
                aria-label="To"
              />
            </label>
            @if (deepError(); as e) {
              <p class="tester__error" role="alert">{{ e }}</p>
            }
            @if (deepRunId(); as id) {
              <p class="db__done" role="status" data-testid="tester-deep-queued">
                Backtest #{{ id }} queued.
                <a [routerLink]="['/backtests', id]">Open the run</a>
              </p>
            }
          </div>
          <footer class="db__foot">
            <button type="button" class="td__btn" (click)="closeDeep()">Close</button>
            <button type="submit" class="td__btn primary" [disabled]="deepQueuing()">
              {{ deepQueuing() ? 'Queuing…' : 'Queue' }}
            </button>
          </footer>
        </form>
      }
    </dialog>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 0;
      }
      .tester {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--surface);
        border-top: 1px solid var(--border);
        font-size: 12px;
      }
      .tester__bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 4px 10px;
        border-bottom: 1px solid var(--border);
      }
      .tester__title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 240px;
      }
      .tester__tabs {
        display: flex;
        gap: 2px;
      }
      .tester__tabs button,
      .tester__icon,
      .tester__btn,
      .tester__warn,
      .tester__actions button {
        background: none;
        border: 0;
        color: var(--text-muted);
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
      }
      .tester__tabs button:hover,
      .tester__icon:hover,
      .tester__btn:hover,
      .tester__actions button:hover {
        background: var(--surface-hover);
      }
      .tester__tabs button.active {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .tester__count {
        margin-left: 4px;
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
      }
      .tester__btn {
        border: 1px solid var(--border);
        color: inherit;
      }
      .tester__warn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--warning, #f59e0b);
      }
      .tester__spacer {
        flex: 1;
      }
      .tester__icon {
        font-size: 16px;
        line-height: 1;
      }
      .tester__body {
        flex: 1;
        overflow: auto;
        padding: 8px 10px;
        min-height: 0;
      }
      .tester__body--list {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .tester__error {
        padding: 6px 10px;
        color: var(--loss);
        border-bottom: 1px solid var(--border);
      }
      .tester__muted {
        color: var(--text-muted);
      }
      .pos {
        color: var(--profit);
      }
      .neg {
        color: var(--loss);
      }
      /* List of trades: one grid for the header and every row, rows rendered in a window. The
         row height is ROW_H. */
      .tl__viewport {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      .tl {
        min-width: 1000px;
      }
      .tl__row {
        display: grid;
        grid-template-columns:
          48px 92px minmax(120px, 1.4fr) minmax(120px, 1fr) 84px minmax(120px, 1fr) 84px
          56px minmax(130px, 1fr) minmax(100px, 0.8fr);
        align-items: center;
        gap: 0 8px;
        height: 30px;
        padding: 0 8px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .tl__head {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--surface);
        color: var(--text-muted);
        font-weight: 500;
      }
      .tl__sort {
        border: 0;
        background: none;
        padding: 0;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .tl__spacer {
        position: relative;
      }
      .tl__rows {
        will-change: transform;
      }
      .tl__trade {
        cursor: pointer;
        user-select: none;
      }
      .tl__trade:hover {
        background: var(--tv-hover, rgba(0, 0, 0, 0.04));
      }
      .tl__trade.selected {
        background: var(--tv-active-bg, #e3effd);
      }
      .tl__trade:focus-visible {
        outline: 2px solid var(--accent, #2962ff);
        outline-offset: -2px;
      }
      .tl__signal {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tl__empty {
        padding: 8px;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .tester__props .check {
        flex-direction: row;
        align-items: center;
        gap: 6px;
      }
      .tester__problems {
        grid-column: 1 / -1;
        margin: 0;
        padding-left: 18px;
        color: var(--loss);
      }
      .tester__props-note {
        grid-column: 1 / -1;
        margin: 0;
      }
      .tester__inputs {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 8px 16px;
        align-items: end;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .field span {
        color: var(--text-muted);
      }
      .field input,
      .field select {
        background: var(--surface);
        color: inherit;
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 4px 6px;
        font: inherit;
      }
      .tester__actions {
        display: flex;
        gap: 8px;
        grid-column: 1 / -1;
      }
      .tester__actions .primary,
      .td__btn.primary {
        background: var(--accent);
        color: #fff;
      }
      dialog.td,
      dialog.db {
        width: min(760px, calc(100vw - 32px));
        max-height: min(80vh, 760px);
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: var(--tv-bg, var(--surface, #fff));
        color: var(--tv-ink, inherit);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
        font-size: 13px;
      }
      dialog.db {
        width: min(420px, calc(100vw - 32px));
      }
      dialog::backdrop {
        background: rgba(10, 12, 18, 0.4);
      }
      .td__head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
      }
      .td__head strong {
        font-size: 15px;
      }
      .td__side {
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 4px;
      }
      .td__side.pos {
        background: rgba(8, 153, 129, 0.12);
        color: #089981;
      }
      .td__side.neg {
        background: rgba(242, 54, 69, 0.12);
        color: #f23645;
      }
      .td__spacer {
        flex: 1;
      }
      .td__btn {
        font: inherit;
        padding: 4px 10px;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 4px;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .td__btn:hover {
        background: var(--tv-hover, rgba(0, 0, 0, 0.05));
      }
      .td__x {
        font-size: 20px;
        line-height: 1;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0 4px;
      }
      .td__body,
      .db__body {
        overflow-y: auto;
        padding: 4px 16px 16px;
      }
      .db__body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding-top: 12px;
      }
      .db__foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid var(--tv-line, #e0e3eb);
      }
      .db__done {
        margin: 0;
      }
      .td h4 {
        margin: 14px 0 6px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--tv-muted, #787b86);
      }
      .td__cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 0 24px;
      }
      .td dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px 12px;
        margin: 0;
      }
      .td dt {
        color: var(--tv-muted, #787b86);
      }
      .td dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .td dd.pos {
        color: #089981;
      }
      .td dd.neg {
        color: #f23645;
      }
      .td__table {
        width: 100%;
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
      }
      .td__table th,
      .td__table td {
        padding: 4px 8px;
        text-align: right;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
      }
      .td__table th:first-child,
      .td__table td:first-child {
        text-align: left;
      }
      .td__table th {
        font-weight: 500;
        color: var(--tv-muted, #787b86);
        font-size: 12px;
      }
      .td__dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
      }
      .td__muted {
        color: var(--tv-muted, #787b86);
        margin: 0;
      }
      .td__inputs {
        grid-template-columns: 1fr auto;
      }
      @media (pointer: coarse) {
        .tester__tabs button,
        .tester__btn,
        .tester__icon {
          min-height: 40px;
        }
      }
    `,
  ],
})
export class StrategyTesterPanelComponent implements OnDestroy {
  private readonly api = inject(ScriptStrategyService);

  /** The run to show (null while the first run is in flight). */
  readonly result = input<ChartScriptResult | null>(null);
  /**
   * The strategy's inputs with the defaults it runs on (`ScriptSettings.inputsOf`, as its Settings
   * dialog shows them): an engine strategy's stored inputs in place of its source's. Null while
   * those are read.
   */
  readonly inputs = input<readonly ScriptInputDto[] | null>(null);
  /** Override values the current result was run with. */
  readonly values = input<ScriptInputValues>({});
  readonly running = input(false);
  /** The resolution the run is on: on 1D/1W/1M a trade's bar is named by its trading date. */
  readonly resolution = input<string>('');
  /**
   * Why the run's report is not shown — in Bar Replay its trades reach past the head, bars the
   * chart has not reached (PC-08); its run to the head is on the way. Null: shown.
   */
  readonly suspended = input<string | null>(null);
  /** The symbol's price precision: prices in the list and the trade detail (PC-12). */
  readonly precision = input(5);
  /** An engine strategy as the chart runs it: "Deep backtest…" queues it. Null: not offered. */
  readonly deep = input<DeepBacktestTarget | null>(null);
  /** Trades to show — a fill arrow clicked on the chart (PC-I5). */
  readonly reveal = input<TradeReveal | null>(null);
  /** The `strategy()` property overrides the strategy runs with on this chart (PC-I5); null = its own. */
  readonly properties = input<ScriptStrategyPropertyOverrides | null>(null);

  /** Re-run with these input overrides. */
  readonly rerun = output<ScriptInputValues>();
  /** Re-run with these `strategy()` property overrides (`{}` = the script's own). */
  readonly rerunProperties = output<ScriptStrategyPropertyOverrides>();
  readonly closed = output<void>();
  /** A trade row was clicked: the page frames that trade on the chart. */
  readonly tradeFocus = output<ChartTrade>();

  protected readonly tabs: { id: TesterTab; label: string }[] = [
    { id: 'report', label: 'Report' },
    { id: 'trades', label: 'List of trades' },
    { id: 'inputs', label: 'Inputs' },
    { id: 'properties', label: 'Properties' },
  ];
  readonly tab = signal<TesterTab>('report');
  /** The report's own List of trades: this panel has its own. */
  protected readonly hiddenReportTabs = ['trades'] as const;

  protected readonly trades = computed<ChartTrade[]>(() => this.result()?.strategy?.trades ?? []);
  protected readonly warnings = computed(() => this.result()?.strategy?.warnings ?? []);
  private readonly currency = computed(() => this.result()?.strategy?.metrics.currency ?? '');

  // ── List of trades ──
  readonly newestFirst = signal(false);
  readonly ordered = computed(() => orderTrades(this.trades(), this.newestFirst()));
  readonly selected = signal<ReadonlySet<number>>(new Set());
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(240);
  private readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  protected readonly rows = computed(() =>
    rowWindow(this.ordered().length, this.scrollTop(), this.viewportHeight(), ROW_H, OVERSCAN),
  );
  protected readonly visible = computed(() => {
    const w = this.rows();
    return this.ordered().slice(w.start, w.end);
  });
  private resizeObserver: ResizeObserver | null = null;
  private observed: HTMLElement | null = null;

  protected readonly detail = signal<TradeDetail | null>(null);
  protected readonly detailTrade = signal<ChartTrade | null>(null);
  private readonly detailBox = viewChild<ElementRef<HTMLDialogElement>>('detailBox');
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

  // ── Inputs ──
  protected readonly editableInputs = computed(() =>
    (this.inputs() ?? []).filter((i) => i.display !== 'none'),
  );
  private readonly draft = signal<ScriptInputValues>({});

  // ── Properties (PC-I5) ──
  protected readonly qtyTypes = QTY_TYPES;
  protected readonly commissionTypes = COMMISSION_TYPES;
  /** What the shown run used: the form's starting point. */
  private readonly propertyStart = computed<PropertyDraft | null>(() => {
    const p = this.result()?.strategy?.report?.meta.properties;
    return p ? draftFromReport(p) : null;
  });
  protected readonly propertyDraft = signal<PropertyDraft | null>(null);
  protected readonly propertyProblems = computed(() => {
    const d = this.propertyDraft();
    return d ? draftProblems(d) : [];
  });
  protected readonly overridden = computed(() => overriddenLabel(this.properties()));

  // ── Deep backtest ──
  readonly deepOpen = signal(false);
  readonly deepFrom = signal(isoDate(Date.now() - 365 * 86_400_000));
  readonly deepTo = signal(isoDate(Date.now()));
  readonly deepQueuing = signal(false);
  readonly deepError = signal<string | null>(null);
  readonly deepRunId = signal<number | null>(null);
  private readonly deepBox = viewChild<ElementRef<HTMLDialogElement>>('deepBox');

  constructor() {
    // Reset the draft to the values the result ran with whenever a new result/values arrive.
    effect(() => {
      const v = this.values();
      untracked(() => this.draft.set({ ...v }));
    });
    // The Properties form follows the run on screen.
    effect(() => {
      const start = this.propertyStart();
      untracked(() => this.propertyDraft.set(start ? { ...start } : null));
    });
    // The list's viewport comes and goes with its tab: follow its height while it is there.
    effect(() => {
      const el = this.viewport()?.nativeElement ?? null;
      untracked(() => this.observeViewport(el));
    });
    // A fill arrow clicked on the chart: its trades, selected and scrolled to, on their tab.
    effect(() => {
      const r = this.reveal();
      untracked(() => {
        if (r && r.numbers.length) this.showTrades(r.numbers);
      });
    });
    afterNextRender(() => this.observeViewport(this.viewport()?.nativeElement ?? null));
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.pressCancel();
  }

  /** Select these trades on the List of trades and bring the first into view. */
  showTrades(numbers: readonly number[]): void {
    this.tab.set('trades');
    this.selected.set(new Set(numbers));
    const index = this.ordered().findIndex((t) => t.number === numbers[0]);
    if (index < 0) return;
    // Once the list is laid out (its tab may just have opened). The header row sticks over the
    // top ROW_H px of the scroller; rows start below it.
    setTimeout(() => {
      const el = this.viewport()?.nativeElement;
      if (!el) return;
      const top = index * ROW_H;
      const below = el.clientHeight - ROW_H;
      if (top < el.scrollTop || top + ROW_H > el.scrollTop + below)
        el.scrollTop = Math.max(0, top - Math.max(0, (below - ROW_H) / 2));
      this.scrollTop.set(el.scrollTop);
    });
  }

  protected onScroll(): void {
    this.scrollTop.set(this.viewport()?.nativeElement.scrollTop ?? 0);
  }

  private observeViewport(el: HTMLElement | null): void {
    if (el === this.observed) return;
    this.resizeObserver?.disconnect();
    this.observed = el;
    if (!el) return;
    this.viewportHeight.set(el.clientHeight || 240);
    this.scrollTop.set(el.scrollTop);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver ??= new ResizeObserver(() => {
        const cur = this.observed;
        if (cur) this.viewportHeight.set(cur.clientHeight || 240);
      });
      this.resizeObserver.observe(el);
    }
  }

  /** Long-press (500 ms, like a touch long-press) opens the detail popup; a short click frames the trade. */
  protected pressStart(t: ChartTrade, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    this.longPressed = false;
    this.pressCancel();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.longPressed = true;
      this.openDetail(t);
    }, 500);
  }

  protected pressEnd(t: ChartTrade, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const wasLong = this.longPressed;
    this.pressCancel();
    if (!wasLong) this.focusTrade(t);
  }

  protected pressCancel(): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  protected focusTrade(t: ChartTrade): void {
    this.selected.set(new Set([t.number]));
    this.tradeFocus.emit(t);
  }

  openDetail(t: ChartTrade): void {
    const r = this.result();
    if (!r) return;
    this.selected.set(new Set([t.number]));
    this.detailTrade.set(t);
    this.detail.set(tradeDetail(r, t, this.values(), this.precision(), this.resolution()));
    showModal(this.detailBox()?.nativeElement);
  }

  protected closeDetail(): void {
    closeModal(this.detailBox()?.nativeElement);
    this.detail.set(null);
  }

  /** A trade's entry or exit time (Lightweight Charts seconds) as the list prints it. */
  protected tradeTime(sec: number | null): string {
    return tradeTimeLabel(sec, this.resolution());
  }

  protected signalOf(t: ChartTrade): string {
    return `${t.entrySignal}${t.exitSignal ? ' → ' + t.exitSignal : ''}`;
  }

  // ── formatting helpers (template) ──
  protected price(v: number | null | undefined): string {
    return formatPrice(v, this.precision());
  }
  protected money(v: number | null | undefined, signed = false): string {
    return formatMoney(v ?? null, this.currency(), { signed });
  }
  protected pct(v: number | null | undefined, signed = false): string {
    return formatPercent(v ?? null, { signed });
  }
  protected num(v: number | null | undefined, decimals = 2): string {
    return formatNumber(v ?? null, decimals);
  }
  protected tone(v: number | null | undefined): string {
    return v === null || v === undefined || v === 0 ? '' : v > 0 ? 'pos' : 'neg';
  }

  // ── inputs editor ──
  /** What an input's field shows: its value on the chart (or edited here), else its default. */
  protected value(i: ScriptInputDto): ScriptInputValue | null {
    const d = this.draft();
    return i.id in d ? d[i.id] : inputDefault(i);
  }
  protected set(i: ScriptInputDto, v: ScriptInputValue | null): void {
    if (v === null) return;
    this.draft.update((d) => ({ ...d, [i.id]: v }));
  }
  protected toNumber(raw: string, integer: boolean): number | null {
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return null;
    return integer ? Math.round(n) : n;
  }
  protected reset(): void {
    this.draft.set({});
  }
  /**
   * Re-run with the inputs that differ from the defaults the strategy runs on — the Settings
   * dialog's rule (`inputOverrides` over `inputs`). For an engine strategy those are its stored
   * inputs, so a value back at its SOURCE's default goes as an explicit override while the stored
   * one differs: left out, the stored one would win and the input could never return to it. Every
   * input counts, those the form hides (`display.none`) included, so a value set in Settings stays.
   */
  protected emitRerun(): void {
    const list = this.inputs();
    if (!list) return;
    this.rerun.emit(inputOverrides(list, resolveInputValues(list, this.draft())));
  }

  // ── properties ──
  protected setProp<K extends keyof PropertyDraft>(key: K, value: PropertyDraft[K] | null): void {
    this.propertyDraft.update((d) => (d ? { ...d, [key]: value } : d));
  }

  /** Re-run with the overrides already applied plus every property changed here. */
  protected emitProperties(): void {
    const start = this.propertyStart();
    const edited = this.propertyDraft();
    if (!start || !edited || draftProblems(edited).length) return;
    this.rerunProperties.emit(overridesFrom(this.properties() ?? {}, start, edited));
  }

  protected resetProperties(): void {
    this.rerunProperties.emit({});
  }

  // ── deep backtest ──
  openDeep(): void {
    if (!this.deep()) return;
    this.deepError.set(null);
    this.deepRunId.set(null);
    this.deepOpen.set(true);
    // Rendered with the open flag: shown once its contents are there.
    setTimeout(() => showModal(this.deepBox()?.nativeElement));
  }

  protected closeDeep(): void {
    closeModal(this.deepBox()?.nativeElement);
    this.deepOpen.set(false);
  }

  /** Queue the deep backtest (`POST backtest`), and say which run it is. */
  queueDeep(): void {
    const target = this.deep();
    if (!target || this.deepQueuing()) return;
    const req = deepBacktestRequest(
      target,
      { fromDate: this.deepFrom(), toDate: this.deepTo() },
      this.values(),
      this.properties(),
    );
    if (typeof req === 'string') {
      this.deepError.set(req);
      return;
    }
    this.deepError.set(null);
    this.deepQueuing.set(true);
    this.api.queueBacktest(req).subscribe({
      next: (res) => {
        this.deepQueuing.set(false);
        if (!isOk(res) || !res.data) {
          this.deepError.set(describeFailure(res, 'The engine did not queue the backtest.'));
          return;
        }
        this.deepRunId.set(res.data);
      },
      error: (err: unknown) => {
        this.deepQueuing.set(false);
        this.deepError.set(describeFailure(err, 'Queuing the backtest failed.'));
      },
    });
  }
}

/** Open a native dialog as a modal — or, where the browser has none (jsdom), just open it. */
function showModal(el: HTMLDialogElement | undefined): void {
  if (!el || el.open) return;
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');
}

function closeModal(el: HTMLDialogElement | undefined): void {
  if (!el) return;
  if (typeof el.close === 'function') el.close();
  else el.removeAttribute('open');
}
