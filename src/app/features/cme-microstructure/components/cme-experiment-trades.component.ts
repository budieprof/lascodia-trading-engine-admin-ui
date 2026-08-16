import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import { ThemeService } from '@core/theme/theme.service';
import { CmeMicrostructureService } from '@core/services/cme-microstructure.service';
import type {
  CmeExperimentTradeDto,
  CmeExperimentTradesDto,
  CmeTradeContextDto,
} from '@features/cme-microstructure/cme-microstructure.types';

/**
 * Trade-level view of one real-vs-proxy experiment run.
 *
 * <p>The verdict card above reports six numbers per arm. They summarise but cannot explain: they
 * cannot show whether a result came from a handful of outliers or a broad distribution, whether the
 * path to it was survivable, or whether the two arms diverged everywhere or in a few sessions. That
 * matters here more than usual — this experiment's headline once favoured real on net PnL while
 * per-trade expectancy favoured the proxy, and only the distribution behind the totals settles which
 * reading is right.</p>
 *
 * <p><b>Chart discipline.</b> Three panels, one measure each, never a dual axis — equity is money,
 * the histogram is counts, the session panel is money per fold; overlaying any two invents a
 * relationship. Arm colours are the page's validated categorical pair (real / proxy), identical to
 * the verdict-history charts, so an arm keeps its colour everywhere on the page.</p>
 */
@Component({
  selector: 'app-cme-experiment-trades',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgxEchartsDirective],
  template: `
    <section class="trades" aria-labelledby="trades-h">
      <header class="trades-head">
        <div>
          <h3 id="trades-h">Trades behind the verdict</h3>
          <p class="muted small">
            Every round-trip both arms took, and the distribution the summary numbers came from.
            <strong>Win rate</strong> here counts strictly-profitable trades; the verdict card above
            counts break-even trades as wins, so its figure is the <strong>non-losing</strong> rate.
            Both are shown so they reconcile.
          </p>
        </div>
        <button type="button" class="btn" (click)="load()" [disabled]="loading() || !runId()">
          {{ loading() ? 'Loading…' : data() ? 'Refresh' : 'Load trades' }}
        </button>
      </header>

      @if (!runId()) {
        <p class="muted small">Run the experiment, or pick a run from the history below.</p>
      }

      @if (error(); as e) {
        <p class="err small" role="alert">{{ e }}</p>
      }

      @if (data(); as d) {
        @if (!d.hasTrades) {
          <p class="muted small">{{ note() }}</p>
        } @else {
          <!-- ── Arm comparison tiles ─────────────────────────────────────── -->
          <div class="arms">
            @for (arm of armRows(); track arm.key) {
              <div class="arm" [attr.data-arm]="arm.key">
                <header>
                  <span class="swatch" [style.background]="arm.colour"></span>
                  <strong>{{ arm.label }}</strong>
                  <span class="muted small">{{ arm.tradeCount | number }} trades</span>
                </header>
                <dl>
                  <div>
                    <dt>Net P&amp;L</dt>
                    <dd [class.neg]="arm.netPnl < 0">
                      {{ arm.netPnl | number: '1.2-2' }}
                    </dd>
                  </div>
                  <div>
                    <dt>Per trade</dt>
                    <dd [class.neg]="arm.avgPnl < 0">
                      {{ arm.avgPnl | number: '1.4-4' }}
                    </dd>
                  </div>
                  <div>
                    <dt>Median</dt>
                    <dd [class.neg]="arm.medianPnl < 0">
                      {{ arm.medianPnl | number: '1.2-2' }}
                    </dd>
                  </div>
                  <div>
                    <dt>Win rate</dt>
                    <dd>{{ arm.winRatePct | number: '1.1-1' }}%</dd>
                  </div>
                  <div>
                    <dt title="Wins + scratches, the definition the verdict card above uses">
                      Non-losing
                    </dt>
                    <dd>{{ arm.nonLosingRatePct | number: '1.1-1' }}%</dd>
                  </div>
                  <div>
                    <dt>Win / scratch / loss</dt>
                    <dd>{{ arm.winCount }} / {{ arm.scratchCount }} / {{ arm.lossCount }}</dd>
                  </div>
                  <div>
                    <dt>Max drawdown</dt>
                    <dd>{{ arm.maxDrawdown | number: '1.2-2' }}</dd>
                  </div>
                  <div>
                    <dt>Best / worst</dt>
                    <dd>
                      {{ arm.bestTrade | number: '1.2-2' }} / {{ arm.worstTrade | number: '1.2-2' }}
                    </dd>
                  </div>
                  <div>
                    <dt>Avg hold</dt>
                    <dd>{{ holdLabel(arm.avgHoldSeconds) }}</dd>
                  </div>
                  <div>
                    <dt>Long / short</dt>
                    <dd>{{ arm.longCount }} / {{ arm.shortCount }}</dd>
                  </div>
                </dl>
              </div>
            }
          </div>

          <!-- ── Equity curve ─────────────────────────────────────────────── -->
          <figure class="panel">
            <figcaption>
              <strong>Equity curve</strong>
              <span class="muted small">
                Cumulative net P&amp;L after each trade, in trade order. Two arms can share a total
                and differ entirely in whether reaching it was survivable.
              </span>
            </figcaption>
            <div
              echarts
              [options]="equityOptions()"
              [theme]="echartsTheme()"
              [autoResize]="true"
              class="chart"
            ></div>
          </figure>

          <div class="panel-grid">
            <!-- ── P&L distribution ───────────────────────────────────────── -->
            <figure class="panel">
              <figcaption>
                <strong>P&amp;L distribution</strong>
                <span class="muted small">
                  Shared bins across both arms — binning each separately would give them different
                  axes and make the comparison meaningless.
                </span>
              </figcaption>
              <div
                echarts
                [options]="histogramOptions()"
                [theme]="echartsTheme()"
                [autoResize]="true"
                class="chart"
              ></div>
            </figure>

            <!-- ── Per-session P&L ────────────────────────────────────────── -->
            <figure class="panel">
              <figcaption>
                <strong>Per-session P&amp;L</strong>
                <span class="muted small">
                  One fold per session. Shows whether the arms diverged everywhere or in a few days.
                </span>
              </figcaption>
              <div
                echarts
                [options]="sessionOptions()"
                [theme]="echartsTheme()"
                [autoResize]="true"
                class="chart"
              ></div>
            </figure>
          </div>

          <!-- ── Trade table ──────────────────────────────────────────────── -->
          <details class="table-details" open>
            <summary class="small">
              Trade list
              <span class="muted">
                ({{ d.trades.length | number }} of {{ d.totalTrades | number }} shown)
              </span>
            </summary>
            @if (d.rowsTruncated) {
              <p class="muted small">
                Row list is capped per arm. The charts and every statistic above cover ALL
                {{ d.totalTrades | number }} trades — only this table is trimmed.
              </p>
            }
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Arm</th>
                    <th>Session</th>
                    <th class="num">#</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Dir</th>
                    <th class="num">Size</th>
                    <th class="num">Entry px</th>
                    <th class="num">Exit px</th>
                    <th class="num">Hold</th>
                    <th class="num">Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of visibleTrades(); track t.arm + '-' + t.sequence) {
                    <tr
                      class="row-clickable"
                      tabindex="0"
                      role="button"
                      [attr.aria-label]="
                        'Chart trade ' + t.sequence + ' on ' + t.sessionDate + ', ' + t.arm + ' arm'
                      "
                      (click)="openTrade(t)"
                      (keydown.enter)="openTrade(t)"
                      (keydown.space)="$event.preventDefault(); openTrade(t)"
                    >
                      <td>
                        <span class="swatch sm" [style.background]="armColour(t.arm)"></span>
                        {{ t.arm }}
                      </td>
                      <td>{{ t.sessionDate }}</td>
                      <td class="num">{{ t.sequence }}</td>
                      <td class="small">{{ t.entryTimeUtc | date: 'HH:mm:ss' : 'UTC' }}</td>
                      <td class="small">{{ t.exitTimeUtc | date: 'HH:mm:ss' : 'UTC' }}</td>
                      <td>{{ t.direction }}</td>
                      <td class="num">{{ t.size }}</td>
                      <td class="num">{{ t.entryPrice | number: '1.5-5' }}</td>
                      <td class="num">{{ t.exitPrice | number: '1.5-5' }}</td>
                      <td class="num">{{ holdLabel(t.holdSeconds) }}</td>
                      <td class="num" [class.neg]="t.netPnl < 0">
                        {{ t.netPnl | number: '1.2-2' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (visibleTrades().length < d.trades.length) {
              <button type="button" class="btn" (click)="showAll.set(true)">
                Show all {{ d.trades.length | number }} loaded rows
              </button>
            }
          </details>
        }
      }

      <!-- ── Single-trade chart modal ──────────────────────────────────────── -->
      @if (selected(); as sel) {
        <div class="modal-scrim" role="dialog" aria-modal="true" (click)="closeTrade()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <header class="modal-head">
              <div>
                <h4>
                  <span class="swatch" [style.background]="armColour(sel.arm)"></span>
                  {{ sel.arm }} · trade #{{ sel.sequence }} · {{ sel.direction }}
                  <span class="chip" [class.chip--loss]="sel.netPnl < 0">
                    {{ sel.netPnl | number: '1.2-2' }}
                  </span>
                </h4>
                <p class="muted small">
                  {{ sel.sessionDate }} · {{ sel.entryTimeUtc | date: 'HH:mm:ss' : 'UTC' }} →
                  {{ sel.exitTimeUtc | date: 'HH:mm:ss' : 'UTC' }} UTC · held
                  {{ holdLabel(sel.holdSeconds) }} · size {{ sel.size }} ·
                  {{ sel.entryPrice | number: '1.5-5' }} → {{ sel.exitPrice | number: '1.5-5' }}
                </p>
              </div>
              <button type="button" class="modal-close" (click)="closeTrade()" aria-label="Close">
                ×
              </button>
            </header>

            <div class="modal-body">
              @if (contextLoading()) {
                <p class="muted small">Rebuilding bars from the tape…</p>
              } @else if (contextError(); as ce) {
                <p class="err small" role="alert">{{ ce }}</p>
              } @else if (context(); as ctx) {
                @if (ctx.bars.length === 0) {
                  <p class="muted small">{{ contextNote() }}</p>
                } @else {
                  <div
                    echarts
                    [options]="tradeChartOptions()"
                    [theme]="echartsTheme()"
                    [autoResize]="true"
                    class="modal-chart"
                  ></div>
                  <p class="muted small">
                    {{ ctx.bars.length }} bars at {{ ctx.barSeconds }}s, rebuilt from the raw tape.
                    Middle panel is per-bar aggressor delta (buy − sell volume), lower panel its
                    running total — each on its own axis, since their ranges differ by an order of
                    magnitude.
                  </p>
                  <p class="muted small note-why">
                    <strong>Why IN/OUT rarely sit exactly on a candle.</strong> The strategy decides
                    once per minute and the trade is stamped with that minute's START, though the
                    decision is taken at its END. Fills also come from the <em>order book</em> — a
                    buy lifts the ask, a sell hits the bid — while these candles are the
                    <em>trade tape</em>, so an entry usually prints a tick above the last trade and
                    an exit a tick below. Win or loss is decided by direction, not by where the
                    markers sit: this <strong>{{ sel.direction }}</strong> went
                    {{ sel.entryPrice | number: '1.5-5' }} → {{ sel.exitPrice | number: '1.5-5' }},
                    which moved
                    <strong>{{ favourLabel(sel) }}</strong>
                    the position.
                  </p>
                }
              }
            </div>
          </div>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .trades {
        --c-real: #2a78d6;
        --c-proxy: #eb6834;
        --axis: rgba(0, 0, 0, 0.22);
        --head-bg: #fcfcfb;
        --row-hover: rgba(42, 120, 214, 0.09);
        display: grid;
        gap: 1rem;
      }
      @media (prefers-color-scheme: dark) {
        :host-context(:not([data-theme='light'])) .trades {
          --c-real: #3987e5;
          --c-proxy: #d95926;
          --axis: rgba(255, 255, 255, 0.26);
          --head-bg: #1a1a19;
          --row-hover: rgba(57, 135, 229, 0.16);
        }
      }
      :host-context([data-theme='dark']) .trades {
        --c-real: #3987e5;
        --c-proxy: #d95926;
        --axis: rgba(255, 255, 255, 0.26);
        --head-bg: #1a1a19;
        --row-hover: rgba(57, 135, 229, 0.16);
      }

      .trades-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
      }
      h3 {
        margin: 0 0 0.15rem;
        font-size: 1rem;
      }
      p {
        margin: 0;
      }
      .muted {
        opacity: 0.7;
      }
      .small {
        font-size: 0.8125rem;
      }
      .err {
        color: #d7263d;
      }
      .neg {
        color: #d7263d;
      }

      .arms {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: 0.75rem;
      }
      .arm {
        border: 1px solid var(--axis);
        border-radius: 8px;
        padding: 0.65rem 0.75rem;
        min-width: 0;
      }
      .arm header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 0.4rem;
      }
      .arm dl {
        margin: 0;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.15rem 0.5rem;
        font-size: 0.8125rem;
      }
      .arm dl > div {
        display: contents;
      }
      .arm dt {
        opacity: 0.7;
      }
      .arm dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      .panel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(21rem, 1fr));
        gap: 0.9rem;
      }
      .panel {
        margin: 0;
        display: grid;
        gap: 0.35rem;
        min-width: 0;
      }
      figcaption {
        display: grid;
        gap: 0.1rem;
      }
      .chart {
        width: 100%;
        height: 260px;
      }

      .swatch {
        width: 0.7rem;
        height: 0.7rem;
        border-radius: 2px;
        display: inline-block;
        flex: none;
      }
      .swatch.sm {
        width: 0.55rem;
        height: 0.55rem;
      }

      .table-details summary {
        cursor: pointer;
      }
      /* Wide content scrolls in its own container so the page never scrolls sideways. */
      .table-wrap {
        overflow-x: auto;
        max-height: 26rem;
        overflow-y: auto;
        margin-top: 0.5rem;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.8125rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.25rem 0.5rem;
        border-bottom: 1px solid var(--axis);
        white-space: nowrap;
      }
      /* Sticky header needs an OPAQUE background or rows scroll through it. The colour is defined
         as a token on the component root and consumed here, so all three theme states are covered:
         a bare :root default, the prefers-color-scheme case (no data-theme attribute at all — the
         state a system-themed viewer is in), and the explicit toggle. Defining the dark value only
         under [data-theme='dark'] left system-dark viewers with a white header bar and unreadable
         white-on-white text. */
      th {
        position: sticky;
        top: 0;
        background: var(--head-bg);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .btn {
        padding: 0.35rem 0.75rem;
        border-radius: 7px;
        border: 1px solid var(--axis);
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        margin-top: 0.5rem;
      }
      .btn[disabled] {
        opacity: 0.55;
        cursor: default;
      }

      .row-clickable {
        cursor: pointer;
      }
      .row-clickable:hover,
      .row-clickable:focus-visible {
        background: var(--row-hover);
        outline: none;
      }
      .row-clickable:focus-visible {
        /* Keyboard users need the target visible, not merely reachable. */
        box-shadow: inset 0 0 0 2px var(--c-real);
      }

      .modal-scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: grid;
        place-items: center;
        padding: 1.5rem;
        z-index: 1000;
      }
      .modal-card {
        background: var(--head-bg);
        border: 1px solid var(--axis);
        border-radius: 12px;
        width: min(1100px, 100%);
        max-height: 90vh;
        overflow: auto;
        padding: 1rem 1.15rem 1.15rem;
        display: grid;
        gap: 0.75rem;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
      }
      .modal-head h4 {
        margin: 0 0 0.2rem;
        font-size: 0.95rem;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .chip {
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: rgba(52, 199, 89, 0.16);
        font-variant-numeric: tabular-nums;
      }
      .chip--loss {
        background: rgba(215, 38, 61, 0.16);
      }
      .modal-close {
        border: none;
        background: transparent;
        color: inherit;
        font-size: 1.4rem;
        line-height: 1;
        cursor: pointer;
        padding: 0 0.25rem;
      }
      .modal-body {
        display: grid;
        gap: 0.5rem;
      }
      .modal-chart {
        width: 100%;
        height: 460px;
      }
      .note-why {
        border-left: 2px solid var(--axis);
        padding-left: 0.6rem;
      }
    `,
  ],
})
export class CmeExperimentTradesComponent {
  private readonly service = inject(CmeMicrostructureService);
  private readonly themeSvc = inject(ThemeService);

  /** Run to inspect. Changing it clears the view rather than showing another run's trades. */
  readonly runId = input<number | null>(null);

  protected readonly data = signal<CmeExperimentTradesDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string>('');
  protected readonly showAll = signal(false);

  protected readonly echartsTheme = computed(() =>
    this.themeSvc.theme() === 'dark' ? 'dark' : '',
  );

  /** Initial table render is bounded — 2,000 DOM rows costs more than it informs. */
  private readonly initialRows = 200;

  protected readonly visibleTrades = computed(() => {
    const t = this.data()?.trades ?? [];
    return this.showAll() ? t : t.slice(0, this.initialRows);
  });

  protected armColour(arm: string): string {
    return arm === 'real' ? 'var(--c-real)' : 'var(--c-proxy)';
  }

  protected readonly armRows = computed(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { key: 'real', label: 'Real aggressor', colour: 'var(--c-real)', ...d.real },
      { key: 'proxy', label: 'Tick-rule proxy', colour: 'var(--c-proxy)', ...d.proxy },
    ].filter((a) => a.tradeCount !== undefined) as ({
      key: string;
      label: string;
      colour: string;
    } & NonNullable<CmeExperimentTradesDto['real']>)[];
  });

  /**
   * Whether price moved for or against the position — the thing that actually decides win/loss,
   * stated in words so it does not have to be inferred from two prices and a direction.
   */
  protected favourLabel(t: CmeExperimentTradeDto): string {
    const favourable =
      t.direction === 'Long' ? t.exitPrice >= t.entryPrice : t.exitPrice <= t.entryPrice;
    return favourable ? 'in favour of' : 'against';
  }

  protected holdLabel(seconds: number): string {
    if (!seconds || seconds < 0) return '—';
    if (seconds < 90) return `${seconds.toFixed(0)}s`;
    if (seconds < 5400) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  }

  /**
   * Resolved hex rather than a CSS var: echarts renders to canvas, where var() does not resolve.
   * Kept in step with the stylesheet above by construction — same two validated pairs.
   */
  private palette(): { real: string; proxy: string; axis: string } {
    const dark = this.themeSvc.theme() === 'dark';
    return dark
      ? { real: '#3987e5', proxy: '#d95926', axis: 'rgba(255,255,255,0.26)' }
      : { real: '#2a78d6', proxy: '#eb6834', axis: 'rgba(0,0,0,0.22)' };
  }

  protected readonly equityOptions = computed<EChartsOption>(() => {
    const d = this.data();
    const p = this.palette();
    const real = d?.real?.equity ?? [];
    const proxy = d?.proxy?.equity ?? [];
    // Trade index, not time: the arms take DIFFERENT numbers of trades, so a shared trade-count
    // axis is what makes "where did they diverge" answerable at all.
    const len = Math.max(real.length, proxy.length);

    return {
      grid: { left: 56, right: 12, top: 28, bottom: 32 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Real aggressor', 'Tick-rule proxy'], top: 0 },
      xAxis: {
        type: 'category',
        name: 'trade #',
        nameLocation: 'middle',
        nameGap: 22,
        data: Array.from({ length: len }, (_, i) => i + 1),
        axisLine: { lineStyle: { color: p.axis } },
      },
      yAxis: {
        type: 'value',
        name: 'cumulative P&L',
        axisLine: { lineStyle: { color: p.axis } },
        splitLine: { lineStyle: { color: p.axis, opacity: 0.4 } },
      },
      series: [
        {
          name: 'Real aggressor',
          type: 'line',
          data: real,
          showSymbol: false,
          lineStyle: { width: 2, color: p.real },
          itemStyle: { color: p.real },
        },
        {
          name: 'Tick-rule proxy',
          type: 'line',
          data: proxy,
          showSymbol: false,
          lineStyle: { width: 2, color: p.proxy },
          itemStyle: { color: p.proxy },
        },
        // Break-even reference: without it a curve that never recovers looks like one that merely
        // dipped, because the axis floats to the data.
        {
          name: 'break-even',
          type: 'line',
          data: Array.from({ length: len }, () => 0),
          showSymbol: false,
          silent: true,
          lineStyle: { width: 1, type: 'dashed', color: p.axis },
          tooltip: { show: false },
        },
      ],
    };
  });

  protected readonly histogramOptions = computed<EChartsOption>(() => {
    const d = this.data();
    const p = this.palette();
    const bins = d?.histogram ?? [];

    return {
      grid: { left: 46, right: 12, top: 28, bottom: 40 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['Real aggressor', 'Tick-rule proxy'], top: 0 },
      xAxis: {
        type: 'category',
        name: 'net P&L per trade',
        nameLocation: 'middle',
        nameGap: 26,
        data: bins.map((b) => b.binLowerPnl.toFixed(1)),
        axisLabel: { interval: Math.max(0, Math.floor(bins.length / 6) - 1) },
        axisLine: { lineStyle: { color: p.axis } },
      },
      yAxis: {
        type: 'value',
        name: 'trades',
        axisLine: { lineStyle: { color: p.axis } },
        splitLine: { lineStyle: { color: p.axis, opacity: 0.4 } },
      },
      series: [
        {
          name: 'Real aggressor',
          type: 'bar',
          data: bins.map((b) => b.realCount),
          itemStyle: { color: p.real, borderRadius: [2, 2, 0, 0] },
        },
        {
          name: 'Tick-rule proxy',
          type: 'bar',
          data: bins.map((b) => b.proxyCount),
          itemStyle: { color: p.proxy, borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  });

  protected readonly sessionOptions = computed<EChartsOption>(() => {
    const d = this.data();
    const p = this.palette();
    const sessions = d?.sessions ?? [];

    return {
      grid: { left: 56, right: 12, top: 28, bottom: 52 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['Real aggressor', 'Tick-rule proxy'], top: 0 },
      xAxis: {
        type: 'category',
        data: sessions.map((s) => s.sessionDate),
        axisLabel: { rotate: 45, fontSize: 10 },
        axisLine: { lineStyle: { color: p.axis } },
      },
      yAxis: {
        type: 'value',
        name: 'session P&L',
        axisLine: { lineStyle: { color: p.axis } },
        splitLine: { lineStyle: { color: p.axis, opacity: 0.4 } },
      },
      series: [
        {
          name: 'Real aggressor',
          type: 'bar',
          data: sessions.map((s) => s.realNetPnl),
          itemStyle: { color: p.real },
        },
        {
          name: 'Tick-rule proxy',
          type: 'bar',
          data: sessions.map((s) => s.proxyNetPnl),
          itemStyle: { color: p.proxy },
        },
      ],
    };
  });

  // ── Single-trade chart modal ────────────────────────────────────────────────

  protected readonly selected = signal<CmeExperimentTradeDto | null>(null);
  protected readonly context = signal<CmeTradeContextDto | null>(null);
  protected readonly contextLoading = signal(false);
  protected readonly contextError = signal<string | null>(null);
  protected readonly contextNote = signal('');

  openTrade(t: CmeExperimentTradeDto): void {
    this.selected.set(t);
    this.context.set(null);
    this.contextError.set(null);
    this.contextLoading.set(true);

    const id = this.runId();
    if (!id) return;

    this.service.getTradeContext(id, t.arm, t.sequence).subscribe({
      next: (res) => {
        if (res.status && res.data) {
          this.context.set(res.data);
          // Carries the "tape no longer readable" explanation on an otherwise-successful envelope,
          // which is the difference between an empty chart and an understood one.
          this.contextNote.set(res.message ?? '');
        } else {
          this.contextError.set(res.message || 'Could not rebuild context for this trade.');
        }
        this.contextLoading.set(false);
      },
      error: (err: unknown) => {
        this.contextError.set(
          err instanceof Error ? err.message : 'Could not rebuild context for this trade.',
        );
        this.contextLoading.set(false);
      },
    });
  }

  closeTrade(): void {
    this.selected.set(null);
    this.context.set(null);
    this.contextError.set(null);
  }

  /**
   * Price candles with the trade marked, and aggressor delta on a SEPARATE grid below.
   *
   * <p>The delta panel is a small multiple sharing the x-axis, not a second y-axis on the price
   * plot. Price and signed volume have no common scale, and overlaying them would manufacture
   * apparent agreement between the two at whatever ratio the axes happened to land on.</p>
   */
  protected readonly tradeChartOptions = computed<EChartsOption>(() => {
    const ctx = this.context();
    const sel = this.selected();
    const p = this.palette();
    const bars = ctx?.bars ?? [];

    const times = bars.map((b) => b.timestampUtc);
    const candles = bars.map((b) => [b.open, b.close, b.low, b.high]);
    const armColour = sel?.arm === 'real' ? p.real : p.proxy;

    const label = (iso: string) => iso.slice(11, 19);
    const nearest = (iso: string) => {
      // Snap to the bar containing the event: category axes only accept a category that exists, and
      // an entry timestamp mid-bar has no category of its own.
      const t = Date.parse(iso);
      let best = 0;
      let bestDiff = Number.POSITIVE_INFINITY;
      times.forEach((s, i) => {
        const diff = Math.abs(Date.parse(s) - t);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      });
      return best;
    };

    const entryIdx = sel ? nearest(sel.entryTimeUtc) : 0;
    const exitIdx = sel ? nearest(sel.exitTimeUtc) : 0;

    return {
      animation: false,
      // Two grids, one shared category axis. axisPointer links them so a hover reads price and
      // flow at the SAME instant — the comparison the whole experiment is about.
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['Price', 'Aggressor delta', 'Cumulative delta'], top: 0 },
      // THREE grids, not two. Per-bar delta and cumulative delta are different measures with
      // different ranges (here roughly -200..+100 against 0..800); sharing one axis flattens the
      // bars into a line at zero and hides the per-bar texture entirely. Same reason price gets its
      // own grid — this is small multiples, not a stacked axis.
      grid: [
        { left: 64, right: 58, top: 30, height: '44%' },
        { left: 64, right: 58, top: '61%', height: '15%' },
        { left: 64, right: 58, top: '81%', height: '13%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: times,
          gridIndex: 0,
          axisLabel: { formatter: label, fontSize: 10 },
          axisLine: { lineStyle: { color: p.axis } },
        },
        {
          type: 'category',
          data: times,
          gridIndex: 1,
          axisLabel: { show: false },
          axisLine: { lineStyle: { color: p.axis } },
        },
        {
          type: 'category',
          data: times,
          gridIndex: 2,
          axisLabel: { formatter: label, fontSize: 10 },
          axisLine: { lineStyle: { color: p.axis } },
        },
      ],
      yAxis: [
        {
          type: 'value',
          scale: true,
          name: 'price',
          gridIndex: 0,
          axisLine: { lineStyle: { color: p.axis } },
          splitLine: { lineStyle: { color: p.axis, opacity: 0.35 } },
        },
        {
          type: 'value',
          gridIndex: 1,
          axisLine: { lineStyle: { color: p.axis } },
          splitLine: { show: false },
        },
        {
          type: 'value',
          gridIndex: 2,
          axisLine: { lineStyle: { color: p.axis } },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2] },
        { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 2, height: 14 },
      ],
      series: [
        {
          name: 'Price',
          type: 'candlestick',
          data: candles,
          xAxisIndex: 0,
          yAxisIndex: 0,
          itemStyle: {
            color: 'transparent',
            color0: p.axis,
            borderColor: p.real,
            borderColor0: p.proxy,
          },
          markPoint: {
            symbolSize: 44,
            data: sel
              ? [
                  {
                    name: 'Entry',
                    coord: [entryIdx, sel.entryPrice],
                    value: 'IN',
                    itemStyle: { color: armColour },
                  },
                  {
                    name: 'Exit',
                    coord: [exitIdx, sel.exitPrice],
                    value: 'OUT',
                    itemStyle: { color: sel.netPnl >= 0 ? '#34c759' : '#d7263d' },
                  },
                ]
              : [],
          },
          markLine: {
            symbol: 'none',
            data: sel
              ? [
                  // The held window shaded by its own boundaries, so "when was I in the market"
                  // is answerable at a glance rather than by reading timestamps off the axis.
                  [
                    { name: 'held', coord: [entryIdx, sel.entryPrice] },
                    { coord: [exitIdx, sel.exitPrice] },
                  ],
                ]
              : [],
            lineStyle: { color: armColour, width: 2, type: 'dashed' },
            label: { show: false },
          },
        },
        {
          name: 'Aggressor delta',
          type: 'bar',
          data: bars.map((b) => b.delta),
          xAxisIndex: 1,
          yAxisIndex: 1,
          // Diverging by sign: buy-dominant bars take the real-arm hue, sell-dominant the proxy's,
          // which keeps the page's two hues doing one job each rather than inventing a third.
          itemStyle: {
            color: (params: { data: number }) => (params.data >= 0 ? p.real : p.proxy),
          },
        },
        {
          name: 'Cumulative delta',
          type: 'line',
          data: bars.map((b) => b.cumulativeDelta),
          xAxisIndex: 2,
          yAxisIndex: 2,
          showSymbol: false,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 1.5, color: p.real },
          itemStyle: { color: p.real },
        },
      ],
    } as EChartsOption;
  });

  load(): void {
    const id = this.runId();
    if (!id || this.loading()) return;

    this.loading.set(true);
    this.error.set(null);
    this.showAll.set(false);

    this.service.getExperimentTrades(id).subscribe({
      next: (res) => {
        if (res.status && res.data) {
          this.data.set(res.data);
          // A successful envelope still carries the "this run predates trade capture" explanation,
          // which is the difference between an empty chart and an understood one.
          this.note.set(res.message ?? '');
        } else {
          this.error.set(res.message || 'Could not load trades for this run.');
        }
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(err instanceof Error ? err.message : 'Could not load trades for this run.');
        this.loading.set(false);
      },
    });
  }
}
