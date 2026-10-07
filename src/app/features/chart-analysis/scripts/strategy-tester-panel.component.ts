import { tradeDetail, tradeTimeLabel, type TradeDetail } from './trade-detail';
import { ChartIconComponent } from '../icons/chart-icon.component';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  AreaSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

import { ThemeService } from '@core/theme/theme.service';
import type {
  ScriptInputDto,
  ScriptInputValue,
  ScriptInputValues,
} from '@core/api/scripting.types';
import {
  formatMoney,
  formatNumber,
  formatPercent,
  formatRatio,
} from '@features/scripting/report/report-format';
import type { ReportSplit } from '@features/scripting/report/strategy-report.model';
import type { ChartScriptResult, ChartTrade } from './chart-script.model';

type TesterTab = 'overview' | 'performance' | 'trades' | 'inputs';

interface SummaryRow {
  label: string;
  all: string;
  long: string;
  short: string;
}

/**
 * Bottom "Strategy Tester" panel of the chart-analysis page.
 *
 * <p>Units: the engine report's `…Percent` fields — including percent profitable — are already
 * percentages (41.67 = 41.67 %); they go to `formatPercent` unscaled. Money is in the report's
 * account currency.</p>
 */
@Component({
  selector: 'app-strategy-tester-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
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
            </button>
          }
        </nav>
        <span class="tester__spacer"></span>
        @if (running()) {
          <span class="tester__muted">Running…</span>
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

      <div class="tester__body">
        @switch (tab()) {
          @case ('overview') {
            @if (metrics(); as m) {
              <div class="tester__kpis">
                <div class="kpi">
                  <span>Net profit</span>
                  <b [class]="tone(m.netProfit)">{{ money(m.netProfit, true) }}</b>
                  <small [class]="tone(m.netProfitPercent)">{{
                    pct(m.netProfitPercent, true)
                  }}</small>
                </div>
                <div class="kpi">
                  <span>Total closed trades</span><b>{{ num(m.totalClosedTrades, 0) }}</b>
                </div>
                <div class="kpi">
                  <span>Percent profitable</span><b>{{ pct(m.winRatePercent) }}</b>
                  <small>{{ num(m.winningTrades, 0) }}/{{ num(m.totalClosedTrades, 0) }}</small>
                </div>
                <div class="kpi">
                  <span>Profit factor</span><b>{{ ratio(m.profitFactor) }}</b>
                </div>
                <div class="kpi">
                  <span>Max drawdown</span><b class="neg">{{ money(m.maxDrawdown) }}</b>
                  <small>{{ pct(m.maxDrawdownPercent) }}</small>
                </div>
                <div class="kpi">
                  <span>Avg trade</span
                  ><b [class]="tone(m.avgTrade)">{{ money(m.avgTrade, true) }}</b>
                </div>
              </div>
              <div #equity class="tester__equity" aria-label="Equity curve"></div>
            } @else {
              <p class="tester__muted">
                No strategy report — run a strategy() script to see results.
              </p>
            }
          }
          @case ('performance') {
            <table class="tester__table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>All</th>
                  <th>Long</th>
                  <th>Short</th>
                </tr>
              </thead>
              <tbody>
                @for (r of summary(); track r.label) {
                  <tr>
                    <td>{{ r.label }}</td>
                    <td>{{ r.all }}</td>
                    <td>{{ r.long }}</td>
                    <td>{{ r.short }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          @case ('trades') {
            <table class="tester__table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>Signal</th>
                  <th>Entry</th>
                  <th>Price</th>
                  <th>Exit</th>
                  <th>Price</th>
                  <th>Qty</th>
                  <th>Profit</th>
                  <th>Cum. profit</th>
                </tr>
              </thead>
              <tbody>
                @for (t of trades(); track t.number) {
                  <tr
                    class="tester__trade"
                    tabindex="0"
                    [class.selected]="selected() === t.number"
                    [attr.aria-label]="'Trade ' + t.number + ': click to show on chart, long-press for details'"
                    title="Click: show on chart · Long-press or right-click: trade details"
                    (pointerdown)="pressStart(t, $event)"
                    (pointerup)="pressEnd(t, $event)"
                    (pointerleave)="pressCancel()"
                    (pointercancel)="pressCancel()"
                    (contextmenu)="$event.preventDefault(); openDetail(t)"
                    (keydown.enter)="focusTrade(t)"
                    (keydown.shift.enter)="$event.preventDefault(); openDetail(t)"
                  >
                    <td>{{ t.number }}</td>
                    <td [class]="t.side === 'long' ? 'pos' : 'neg'">
                      {{ t.side === 'long' ? 'Long' : 'Short' }}{{ t.isOpen ? ' (open)' : '' }}
                    </td>
                    <td>{{ t.entrySignal }}{{ t.exitSignal ? ' → ' + t.exitSignal : '' }}</td>
                    <td>{{ tradeTime(t.entryTime) }}</td>
                    <td>{{ t.entryPrice }}</td>
                    <td>{{ tradeTime(t.exitTime) }}</td>
                    <td>{{ t.exitPrice ?? '—' }}</td>
                    <td>{{ num(t.qty, 0) }}</td>
                    <td [class]="tone(t.profit)">
                      {{ money(t.profit, true) }} <small>{{ pct(t.profitPercent, true) }}</small>
                    </td>
                    <td [class]="tone(t.cumulativeProfit)">
                      {{ money(t.cumulativeProfit, true) }}
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="10" class="tester__muted">No trades.</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          @case ('inputs') {
            <form class="tester__inputs" (submit)="$event.preventDefault(); emitRerun()">
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
                        <select (change)="set(i, i.options![$any($event.target).selectedIndex])">
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
      </div>
    </section>
  
    @if (detail(); as d) {
      <div class="td-backdrop" (click)="detail.set(null)"></div>
      <section class="td" role="dialog" aria-modal="true" [attr.aria-label]="d.title + ' details'" (keydown.escape)="detail.set(null)" tabindex="-1">
        <header class="td__head">
          <strong>{{ d.title }}</strong>
          <span class="td__side" [class.pos]="d.side === 'long'" [class.neg]="d.side === 'short'">{{ d.side === 'long' ? 'Long' : 'Short' }}</span>
          <span class="td__spacer"></span>
          <button type="button" class="td__btn" (click)="focusTrade(detailTrade()!); detail.set(null)">Show on chart</button>
          <button type="button" class="td__x" aria-label="Close" (click)="detail.set(null)">×</button>
        </header>
        <div class="td__body">
          <div class="td__cols">
            <div>
              <h4>Trade</h4>
              <dl>
                @for (r of d.trade; track r.label) {
                  <dt>{{ r.label }}</dt><dd [class]="r.tone ?? ''">{{ r.value }}</dd>
                }
              </dl>
            </div>
            <div>
              <h4>Outcome</h4>
              <dl>
                @for (r of d.outcome; track r.label) {
                  <dt>{{ r.label }}</dt><dd [class]="r.tone ?? ''">{{ r.value }}</dd>
                }
              </dl>
            </div>
          </div>
          <h4>Strategy values at entry and exit</h4>
          @if (d.series.length) {
            <table class="td__table">
              <thead><tr><th>Series</th><th>At entry</th><th>At exit</th></tr></thead>
              <tbody>
                @for (s of d.series; track s.title) {
                  <tr>
                    <td><span class="td__dot" [style.background]="s.color"></span>{{ s.title }}</td>
                    <td>{{ s.entry === null ? '—' : s.entry.toFixed(5) }}</td>
                    <td>{{ s.exit === null ? '—' : s.exit.toFixed(5) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="td__muted">This strategy plots nothing, so there are no indicator values to show.</p>
          }
          <h4>Bar at entry and exit</h4>
          <table class="td__table">
            <thead><tr><th></th><th>Entry bar</th><th>Exit bar</th></tr></thead>
            <tbody>
              @for (b of d.bars; track b.label) {
                <tr><td>{{ b.label }}</td><td>{{ b.entry ?? '—' }}</td><td>{{ b.exit ?? '—' }}</td></tr>
              }
            </tbody>
          </table>
          @if (d.inputs.length) {
            <h4>Inputs used</h4>
            <dl class="td__inputs">
              @for (r of d.inputs; track r.label) {
                <dt>{{ r.label }}</dt><dd>{{ r.value }}</dd>
              }
            </dl>
          }
        </div>
      </section>
    }
`,
  styles: [
    `
      .tester__trade { cursor: pointer; user-select: none; }
      .tester__trade:hover td { background: var(--tv-hover, rgba(0, 0, 0, 0.04)); }
      .tester__trade.selected td { background: var(--tv-active-bg, #e3effd); }
      .tester__trade:focus-visible { outline: 2px solid var(--accent, #2962ff); outline-offset: -2px; }
      .td-backdrop { position: fixed; inset: 0; z-index: 300; background: rgba(10, 12, 18, 0.4); }
      .td {
        position: fixed; z-index: 301; left: 50%; top: 50%; transform: translate(-50%, -50%);
        width: min(760px, calc(100vw - 32px)); max-height: min(80vh, 760px); display: flex; flex-direction: column;
        background: var(--tv-bg, var(--surface, #fff)); color: var(--tv-ink, inherit); border-radius: 8px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); font-size: 13px;
      }
      .td__head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--tv-line, #e0e3eb); }
      .td__head strong { font-size: 15px; }
      .td__side { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
      .td__side.pos { background: rgba(8, 153, 129, 0.12); color: #089981; }
      .td__side.neg { background: rgba(242, 54, 69, 0.12); color: #f23645; }
      .td__spacer { flex: 1; }
      .td__btn { font: inherit; padding: 4px 10px; border: 1px solid var(--tv-line, #e0e3eb); border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
      .td__btn:hover { background: var(--tv-hover, rgba(0, 0, 0, 0.05)); }
      .td__x { font-size: 20px; line-height: 1; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 4px; }
      .td__body { overflow-y: auto; padding: 4px 16px 16px; }
      .td h4 { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--tv-muted, #787b86); }
      .td__cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 24px; }
      .td dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
      .td dt { color: var(--tv-muted, #787b86); }
      .td dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .td dd.pos { color: #089981; }
      .td dd.neg { color: #f23645; }
      .td__table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
      .td__table th, .td__table td { padding: 4px 8px; text-align: right; border-bottom: 1px solid var(--tv-line, #e0e3eb); }
      .td__table th:first-child, .td__table td:first-child { text-align: left; }
      .td__table th { font-weight: 500; color: var(--tv-muted, #787b86); font-size: 12px; }
      .td__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
      .td__muted { color: var(--tv-muted, #787b86); margin: 0; }
      .td__inputs { grid-template-columns: 1fr auto; }

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
      .tester__actions button:hover {
        background: var(--surface-hover);
      }
      .tester__tabs button.active {
        color: var(--accent);
        background: var(--accent-soft);
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
      .tester__error {
        padding: 6px 10px;
        color: var(--loss);
        border-bottom: 1px solid var(--border);
      }
      .tester__muted {
        color: var(--text-muted);
      }
      .tester__kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px;
        margin-bottom: 8px;
      }
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .kpi span,
      .kpi small {
        color: var(--text-muted);
      }
      .kpi b {
        font-size: 14px;
      }
      .tester__equity {
        height: 180px;
      }
      .tester__table {
        width: 100%;
        border-collapse: collapse;
      }
      .tester__table th,
      .tester__table td {
        text-align: right;
        padding: 3px 8px;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .tester__table th:first-child,
      .tester__table td:first-child {
        text-align: left;
      }
      .tester__table th {
        color: var(--text-muted);
        font-weight: 500;
        position: sticky;
        top: 0;
        background: var(--surface);
      }
      .pos {
        color: var(--profit);
      }
      .neg {
        color: var(--loss);
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
      .tester__actions .primary {
        background: var(--accent);
        color: #fff;
      }
    `,
  ],
})
export class StrategyTesterPanelComponent implements OnDestroy {
  private readonly theme = inject(ThemeService);

  /** The run to show (null while the first run is in flight). */
  readonly result = input<ChartScriptResult | null>(null);
  /** Input definitions (from compile); defaults to the result's own. */
  readonly inputs = input<readonly ScriptInputDto[] | null>(null);
  /** Override values the current result was run with. */
  readonly values = input<ScriptInputValues>({});
  readonly running = input(false);
  /** The resolution the run is on: on 1D/1W/1M a trade's bar is named by its trading date. */
  readonly resolution = input<string>('');

  /** Re-run with these input overrides. */
  readonly rerun = output<ScriptInputValues>();
  readonly closed = output<void>();
  /** A trade row was clicked: the page frames that trade on the chart. */
  readonly tradeFocus = output<ChartTrade>();

  protected readonly selected = signal<number | null>(null);
  protected readonly detail = signal<TradeDetail | null>(null);
  protected readonly detailTrade = signal<ChartTrade | null>(null);
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

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
    this.selected.set(t.number);
    this.tradeFocus.emit(t);
  }

  protected openDetail(t: ChartTrade): void {
    const r = this.result();
    if (!r) return;
    this.selected.set(t.number);
    this.detailTrade.set(t);
    this.detail.set(tradeDetail(r, t, this.values(), undefined, this.resolution()));
  }

  /** A trade's entry or exit time (Lightweight Charts seconds) as the list prints it. */
  protected tradeTime(sec: number | null): string {
    return tradeTimeLabel(sec, this.resolution());
  }

  protected readonly tabs: { id: TesterTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'performance', label: 'Performance summary' },
    { id: 'trades', label: 'List of trades' },
    { id: 'inputs', label: 'Inputs' },
  ];
  protected readonly tab = signal<TesterTab>('overview');

  private readonly equityEl = viewChild<ElementRef<HTMLElement>>('equity');
  private equityChart: IChartApi | null = null;
  private equitySeries: ISeriesApi<'Area'> | null = null;

  protected readonly metrics = computed(() => this.result()?.strategy?.metrics ?? null);
  private readonly currency = computed(() => this.metrics()?.currency ?? '');
  protected readonly trades = computed<ChartTrade[]>(() => this.result()?.strategy?.trades ?? []);

  protected readonly editableInputs = computed(() =>
    (this.inputs() ?? this.result()?.inputs ?? []).filter((i) => i.display !== 'none'),
  );
  private readonly draft = signal<ScriptInputValues>({});

  protected readonly summary = computed<SummaryRow[]>(() => {
    const report = this.result()?.strategy?.report;
    if (!report) return [];
    const { all, long, short } = report.performance;
    const cur = this.currency();
    const row = (label: string, f: (s: ReportSplit) => string): SummaryRow => ({
      label,
      all: f(all),
      long: f(long),
      short: f(short),
    });
    const money = (k: keyof ReportSplit) => (s: ReportSplit) =>
      formatMoney(s[k] as number | null, cur, { signed: true });
    const pct = (k: keyof ReportSplit) => (s: ReportSplit) => formatPercent(s[k] as number | null);
    const int = (k: keyof ReportSplit) => (s: ReportSplit) =>
      formatNumber(s[k] as number | null, 0);
    return [
      row('Net profit', money('netProfit')),
      row('Net profit %', pct('netProfitPercent')),
      row('Gross profit', money('grossProfit')),
      row('Gross loss', (s) => formatMoney(s.grossLoss, cur)),
      row('Profit factor', (s) => formatRatio(s.profitFactor)),
      row('Commission paid', (s) => formatMoney(s.commissionPaid, cur)),
      row('Total closed trades', int('totalClosedTrades')),
      row('Winning trades', int('winningTrades')),
      row('Losing trades', int('losingTrades')),
      row('Percent profitable', pct('percentProfitable')),
      row('Avg trade', money('avgTrade')),
      row('Avg winning trade', money('avgWinningTrade')),
      row('Avg losing trade', (s) => formatMoney(s.avgLosingTrade, cur)),
      row('Ratio avg win / avg loss', (s) => formatRatio(s.ratioAvgWinAvgLoss)),
      row('Largest winning trade', money('largestWinningTrade')),
      row('Largest losing trade', (s) => formatMoney(s.largestLosingTrade, cur)),
      row('Avg # bars in trades', (s) => formatNumber(s.avgBarsInTrades, 0)),
      row('Max contracts held', int('maxContractsHeld')),
      {
        label: 'Max drawdown',
        all: `${formatMoney(report.equity.maxDrawdown, cur)} (${formatPercent(report.equity.maxDrawdownPercent)})`,
        long: '',
        short: '',
      },
      { label: 'Sharpe ratio', all: formatRatio(report.returns.sharpeRatio), long: '', short: '' },
      {
        label: 'Sortino ratio',
        all: formatRatio(report.returns.sortinoRatio),
        long: '',
        short: '',
      },
    ];
  });

  constructor() {
    // Reset the draft to the values the result ran with whenever a new result/values arrive.
    effect(() => {
      const v = this.values();
      untracked(() => this.draft.set({ ...v }));
    });

    // Equity curve: (re)create when the Overview container appears, update on new results.
    effect(() => {
      const el = this.equityEl()?.nativeElement ?? null;
      const curve = this.result()?.strategy?.equity ?? [];
      const dark = this.theme.theme() === 'dark';
      untracked(() => this.drawEquity(el, curve, dark));
    });
  }

  ngOnDestroy(): void {
    this.disposeEquity();
  }

  // ── formatting helpers (template) ──
  protected money(v: number | null | undefined, signed = false): string {
    return formatMoney(v ?? null, this.currency(), { signed });
  }
  protected pct(v: number | null | undefined, signed = false): string {
    return formatPercent(v ?? null, { signed });
  }
  protected num(v: number | null | undefined, decimals = 2): string {
    return formatNumber(v ?? null, decimals);
  }
  protected ratio(v: number | null | undefined): string {
    return formatRatio(v ?? null);
  }
  protected tone(v: number | null | undefined): string {
    return v === null || v === undefined || v === 0 ? '' : v > 0 ? 'pos' : 'neg';
  }

  // ── inputs editor ──
  protected value(i: ScriptInputDto): ScriptInputValue | null {
    const d = this.draft();
    return i.id in d ? d[i.id] : i.defaultValue;
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
  protected emitRerun(): void {
    // Only send overrides that differ from the defaults.
    const out: ScriptInputValues = {};
    for (const i of this.editableInputs()) {
      const v = this.draft()[i.id];
      if (v !== undefined && v !== i.defaultValue) out[i.id] = v;
    }
    this.rerun.emit(out);
  }

  // ── equity chart ──
  private drawEquity(
    el: HTMLElement | null,
    curve: { time: number; value: number }[],
    dark: boolean,
  ): void {
    if (!el) {
      this.disposeEquity();
      return;
    }
    if (!this.equityChart || this.equityChart.chartElement().parentElement !== el) {
      this.disposeEquity();
      this.equityChart = createChart(el, {
        autoSize: true,
        layout: {
          attributionLogo: false,
          fontSize: 11,
          background: { type: ColorType.Solid, color: 'transparent' },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true },
        handleScroll: false,
        handleScale: false,
      });
      this.equitySeries = this.equityChart.addSeries(AreaSeries, {
        lineWidth: 2,
        priceLineVisible: false,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
    }
    const text = dark ? '#D1D4DC' : '#131722';
    const grid = dark ? '#1E222D' : '#F0F3FA';
    this.equityChart.applyOptions({
      layout: { textColor: text },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    });
    const first = curve[0]?.value ?? 0;
    const last = curve[curve.length - 1]?.value ?? 0;
    const up = last >= first;
    const line = up ? '#089981' : '#F23645';
    this.equitySeries!.applyOptions({
      lineColor: line,
      topColor: up ? 'rgba(8,153,129,0.28)' : 'rgba(242,54,69,0.28)',
      bottomColor: 'rgba(0,0,0,0)',
    });
    this.equitySeries!.setData(curve.map((p) => ({ time: p.time as Time, value: p.value })));
    this.equityChart.timeScale().fitContent();
  }

  private disposeEquity(): void {
    try {
      this.equityChart?.remove();
    } catch {
      /* already detached */
    }
    this.equityChart = null;
    this.equitySeries = null;
  }
}
