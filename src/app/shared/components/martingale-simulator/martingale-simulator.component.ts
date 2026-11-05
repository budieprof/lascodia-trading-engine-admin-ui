import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import { ThemeService } from '@core/theme/theme.service';
import {
  simulateLadder,
  type CapPolicy,
  type LadderMode,
  type LadderTrade,
  type SimResult,
  type SimTrade,
  type SkipInfo,
} from './martingale-ladder.logic';

export type { SimTrade, SkipInfo } from './martingale-ladder.logic';

const DEFAULT_INTRO =
  "Replays the signals above as a per-symbol recovery ladder under the one-position rule: a signal that fills while the symbol's previous position is still open is skipped, as it could never have been placed live. The deficit is tracked in money and a chain only resets once losses plus the target are actually PAID — a trade that merely closes positive shrinks the deficit and the chain continues. Stakes size by each trade's entry-known TP/SL geometry.";

/**
 * Martingale / recovery-sizing simulator. The host page adapts its own trades into
 * {@link LadderTrade}s (signal-sensitivity replay, backtest trade list); the simulation itself is
 * the pure {@link simulateLadder} in `martingale-ladder.logic.ts`.
 *
 * <p><b>Why this lives client-side.</b> A ladder is a pure function of an ORDERED sequence of
 * per-trade R multiples, and both hosts already carry exactly that. Recomputing in the browser means
 * the ladder re-simulates instantly as the operator drags depth / base risk, instead of a round-trip
 * per knob.</p>
 */
@Component({
  selector: 'app-martingale-simulator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, NgxEchartsDirective],
  template: `
    <section class="mg" aria-labelledby="mg-h">
      <header class="mg-head">
        <div>
          <h2 id="mg-h">Martingale simulation</h2>
          <p class="sub">{{ intro() }}</p>
        </div>
        <label class="toggle">
          <input type="checkbox" [(ngModel)]="enabledModel" (ngModelChange)="enabled.set($event)" />
          <span>Enable</span>
        </label>
      </header>

      @if (!trades()) {
        <p class="sub">{{ emptyText() }}</p>
      } @else if (enabled()) {
        <!-- ── Controls ──────────────────────────────────────────────────── -->
        <div class="controls">
          <label>
            <span>Ladder symbol</span>
            <select [ngModel]="symbolScope()" (ngModelChange)="symbolScope.set($event)">
              <option value="__all__">All symbols</option>
              @for (s of symbols(); track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
          </label>
          <label>
            <span>Sizing</span>
            <select [ngModel]="mode()" (ngModelChange)="mode.set($event)">
              <option value="recovery">Recovery (cover losses + profit)</option>
              <option value="fixed">Fixed multiplier</option>
            </select>
          </label>
          @if (mode() === 'fixed') {
            <label>
              <span>Multiplier ×</span>
              <input
                type="number"
                min="1"
                max="5"
                step="0.1"
                [ngModel]="fixedMult()"
                (ngModelChange)="fixedMult.set(+$event)"
              />
            </label>
          } @else {
            <label>
              <span>Target profit (R)</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                [ngModel]="targetProfitR()"
                (ngModelChange)="targetProfitR.set(+$event)"
              />
            </label>
          }
          @if (mode() === 'recovery' && needsAssumedGeom()) {
            <label [title]="assumedGeomNote() ?? ''">
              <span>Reward:risk for sizing (R)</span>
              <input
                type="number"
                min="0.1"
                max="20"
                step="0.1"
                data-testid="mg-assumed-geom"
                [ngModel]="assumedGeomR()"
                (ngModelChange)="assumedGeomR.set(+$event)"
              />
            </label>
          }
          <label>
            <span>Base risk %</span>
            <input
              type="number"
              min="0.05"
              max="10"
              step="0.05"
              [ngModel]="baseRiskPct()"
              (ngModelChange)="baseRiskPct.set(+$event)"
            />
          </label>
          <label
            title="Recovery rungs allowed after the opening loss (depth 0). Matches the engine's MaxDepth: a cap of N permits N recovery trades."
          >
            <span>Max depth (recovery rungs)</span>
            <input
              type="number"
              min="1"
              max="40"
              step="1"
              [ngModel]="maxDepth()"
              (ngModelChange)="maxDepth.set(+$event)"
            />
          </label>
          <label>
            <span>At depth cap</span>
            <select [ngModel]="capPolicy()" (ngModelChange)="capPolicy.set($event)">
              <option value="abandon">Abandon — take the loss, reset</option>
              <option value="continue">Continue — keep laddering</option>
            </select>
          </label>
          @if (showLedgerToggle()) {
            <label class="chk">
              <span>Running ledger</span>
              <span class="chk-row">
                <input
                  type="checkbox"
                  [(ngModel)]="showCumulativeModel"
                  (ngModelChange)="showCumulative.set($event)"
                />
                <span class="chk-lbl">Cumulative columns in the table</span>
              </span>
            </label>
          }
          <label>
            <span>Start balance</span>
            <input
              type="number"
              min="100"
              step="100"
              [ngModel]="startBalance()"
              (ngModelChange)="startBalance.set(+$event)"
            />
          </label>
        </div>

        @if (mode() === 'recovery' && needsAssumedGeom() && assumedGeomNote(); as note) {
          <p class="sub" data-testid="mg-geom-note">{{ note }}</p>
        }
        @if (notice(); as n) {
          <p class="warn">{{ n }}</p>
        }
        @if (sim(); as s) {
          @if (s.usableTrades === 0) {
            <p class="warn">
              No trades in this result carry a usable risk distance, so no ladder can be simulated.
            </p>
          } @else {
            <!-- ── Verdict ───────────────────────────────────────────────── -->
            @if (s.ruinedAtIndex !== null) {
              <p class="verdict verdict--ruin" role="alert">
                <strong>Ladder broke after {{ s.ruinedAtIndex }} trades</strong> — the next stake
                the recovery rule demanded exceeded the remaining balance, so the scheme is
                unexecutable from that point and the simulation stops there. Everything below is the
                run up to the break.
              </p>
            } @else if (s.finalEquity > s.baselineFinal) {
              <p class="verdict verdict--ok">
                Survived. Ladder finished at
                {{ s.finalEquity | number: '1.0-0' }} vs
                {{ s.baselineFinal | number: '1.0-0' }} flat-sized — but read max drawdown and peak
                stake before treating that as an edge.
              </p>
              @if (s.baselineAllFilledFinal < s.baselineFinal) {
                <p class="verdict verdict--warn">
                  <strong>Most of that came from SELECTION, not sizing.</strong> Flat sizing over
                  all {{ s.allFilledCount }} filled trades ends at
                  {{ s.baselineAllFilledFinal | number: '1.0-0' }}; flat sizing over just the
                  {{ s.usableTrades }} the one-position rule admits ends at
                  {{ s.baselineFinal | number: '1.0-0' }} — before any stake is resized. On this
                  symbol the losses cluster in overlapping entries, so simply refusing to stack
                  positions does most of the work. The ladder's own contribution is the gap from
                  {{ s.baselineFinal | number: '1.0-0' }} to {{ s.finalEquity | number: '1.0-0' }}.
                </p>
              }
            } @else {
              <p class="verdict">
                Survived, and finished BEHIND flat sizing:
                {{ s.finalEquity | number: '1.0-0' }} vs {{ s.baselineFinal | number: '1.0-0' }}.
                Sizing cannot create expectancy that the signals do not have.
              </p>
            }

            <!-- ── Tiles ─────────────────────────────────────────────────── -->
            <div class="tiles">
              <div class="tile" [attr.data-state]="s.ruinedAtIndex !== null ? 'bad' : 'ok'">
                <span class="k">Final equity</span>
                <span class="v">{{ s.finalEquity | number: '1.0-0' }}</span>
                <span class="s">flat: {{ s.baselineFinal | number: '1.0-0' }}</span>
              </div>
              <div class="tile" [attr.data-state]="s.maxDrawdownPct >= 50 ? 'bad' : 'ok'">
                <span class="k">Max drawdown</span>
                <span class="v">{{ s.maxDrawdownPct | number: '1.1-1' }}%</span>
                <span class="s">peak-to-trough</span>
              </div>
              <div class="tile" [attr.data-state]="s.peakStakePct >= 50 ? 'bad' : 'ok'">
                <span class="k">Peak stake</span>
                <span class="v">{{ s.peakStakePct | number: '1.1-1' }}%</span>
                <span class="s">of equity, single trade</span>
              </div>
              <div class="tile">
                <span class="k">Deepest ladder</span>
                <span class="v">{{ s.maxDepth }}</span>
                <span class="s">cap {{ maxDepth() }}</span>
              </div>
              <div class="tile">
                <span class="k">Ladders</span>
                <span class="v">{{ s.laddersRecovered }}/{{ s.laddersStarted }}</span>
                <span class="s">paid in full · {{ s.laddersAbandoned }} abandoned</span>
              </div>
              <div
                class="tile"
                [attr.data-state]="s.baselineAllFilledFinal < s.baselineFinal ? 'warn' : 'ok'"
              >
                <span class="k">Selection effect</span>
                <span class="v">
                  {{ s.baselineAllFilledFinal | number: '1.0-0' }}
                </span>
                <span class="s">
                  flat over ALL {{ s.allFilledCount }} filled · vs
                  {{ s.baselineFinal | number: '1.0-0' }} over the {{ s.usableTrades }} serialised
                </span>
              </div>
              <div class="tile">
                <span class="k">Trades simulated</span>
                <span class="v">{{ s.usableTrades | number }}</span>
                <span class="s">
                  {{ s.skippedNoR }} {{ noRiskLabel() }} · {{ s.skippedOverlap }} overlap-skipped
                </span>
              </div>
            </div>

            <!-- ── Equity curves ─────────────────────────────────────────── -->
            <figure class="panel">
              <figcaption>
                <strong>Equity — ladder vs flat sizing</strong>
                <span class="sub">
                  Same signals, same order, same outcomes. The only difference is stake. A ruin ends
                  the ladder curve; the flat curve continues so the comparison stays visible.
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

            <!-- ── Depth histogram ───────────────────────────────────────── -->
            <figure class="panel">
              <figcaption>
                <strong>Ladder depth reached</strong>
                <span class="sub">
                  How often the ladder went N deep. The right tail is what decides survival — a
                  scheme is only as safe as its worst run, not its average one.
                </span>
              </figcaption>
              <div
                echarts
                [options]="depthOptions()"
                [theme]="echartsTheme()"
                [autoResize]="true"
                class="chart chart--short"
              ></div>
            </figure>
          }
        }
      }
    </section>
  `,
  styles: [
    `
      .mg {
        --ok: #2a78d6;
        --bad: #d7263d;
        --line: rgba(0, 0, 0, 0.18);
        --surface: #fcfcfb;
        display: grid;
        gap: 0.9rem;
        margin-top: 1.25rem;
      }
      @media (prefers-color-scheme: dark) {
        :host-context(:not([data-theme='light'])) .mg {
          --ok: #3987e5;
          --bad: #ff6b6b;
          --line: rgba(255, 255, 255, 0.22);
          --surface: #1a1a19;
        }
      }
      :host-context([data-theme='dark']) .mg {
        --ok: #3987e5;
        --bad: #ff6b6b;
        --line: rgba(255, 255, 255, 0.22);
        --surface: #1a1a19;
      }

      .mg-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
      }
      h2 {
        margin: 0 0 0.15rem;
        font-size: 1.05rem;
      }
      p {
        margin: 0;
      }
      .sub {
        font-size: 0.8125rem;
        opacity: 0.72;
      }
      .warn {
        font-size: 0.8125rem;
        color: #b26a00;
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.85rem;
      }

      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(11rem, 100%), 1fr));
        gap: 0.6rem;
        padding: 0.7rem;
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      .controls label {
        display: grid;
        gap: 0.2rem;
        font-size: 0.75rem;
        min-width: 0;
      }
      .controls span {
        opacity: 0.72;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .chk-row {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding-top: 0.25rem;
      }
      .chk-lbl {
        text-transform: none;
        letter-spacing: 0;
        opacity: 0.9;
        font-size: 0.78rem;
      }
      .controls input,
      .controls select {
        font: inherit;
        font-size: 0.85rem;
        padding: 0.3rem 0.4rem;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        min-width: 0;
      }

      .verdict {
        font-size: 0.85rem;
        padding: 0.55rem 0.7rem;
        border-radius: 8px;
        border-left: 3px solid var(--line);
        background: rgba(127, 127, 127, 0.08);
      }
      .verdict--ruin {
        border-left-color: var(--bad);
        background: rgba(215, 38, 61, 0.1);
      }
      .verdict--ok {
        border-left-color: #34c759;
        background: rgba(52, 199, 89, 0.1);
      }
      .verdict--warn {
        border-left-color: #ff9500;
        background: rgba(255, 149, 0, 0.1);
      }

      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(9.5rem, 100%), 1fr));
        gap: 0.55rem;
      }
      .tile {
        display: grid;
        gap: 0.1rem;
        padding: 0.55rem 0.65rem;
        border: 1px solid var(--line);
        border-radius: 8px;
        min-width: 0;
      }
      .tile[data-state='bad'] {
        border-color: rgba(215, 38, 61, 0.5);
      }
      .tile .k {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        opacity: 0.7;
      }
      .tile .v {
        font-size: 1.1rem;
        font-variant-numeric: tabular-nums;
      }
      .tile .s {
        font-size: 0.72rem;
        opacity: 0.7;
      }

      .panel {
        margin: 0;
        display: grid;
        gap: 0.35rem;
      }
      figcaption {
        display: grid;
        gap: 0.1rem;
      }
      .chart {
        width: 100%;
        height: 300px;
      }
      .chart--short {
        height: 200px;
      }
    `,
  ],
})
export class MartingaleSimulatorComponent {
  private readonly theme = inject(ThemeService);

  /** The trades to replay, in any order. Null until the host has something to replay. */
  readonly trades = input<LadderTrade[] | null>(null);
  /** The panel's explanatory paragraph. */
  readonly intro = input<string>(DEFAULT_INTRO);
  /** Shown while {@link trades} is null. */
  readonly emptyText = input<string>(
    'Run a sensitivity analysis first — the ladder replays its signals.',
  );
  /** What a trade with no R is called in the "Trades simulated" tile ("unfilled", "no stop"). */
  readonly noRiskLabel = input<string>('unfilled');
  /** Opening balance until the operator edits it (a backtest passes its own initial balance). */
  readonly defaultStartBalance = input<number | null>(null);
  /** Reward:risk used for recovery sizing when a trade records no target; editable. */
  readonly defaultAssumedGeomR = input<number | null>(null);
  /** Where {@link defaultAssumedGeomR} came from, shown under the controls. */
  readonly assumedGeomNote = input<string | null>(null);
  /** Whether the host has a trade table with ladder columns the "Running ledger" box controls. */
  readonly showLedgerToggle = input<boolean>(true);
  /** A caveat about the trade list itself (e.g. a report that lists only recent trades). */
  readonly notice = input<string | null>(null);

  /** Public: the host's trade table shows ladder columns only while this is on. */
  readonly enabled = signal(false);
  protected enabledModel = false;

  /**
   * Public per-trade lookup for the host's table, keyed by {@link LadderTrade.id}. Null when off or
   * before trades exist — the table hides its ladder columns entirely then.
   */
  readonly tradeBySignalId = computed<Map<number, SimTrade> | null>(() => {
    if (!this.enabled()) return null;
    const s = this.sim();
    if (!s) return null;
    const m = new Map<number, SimTrade>();
    for (const t of s.trades) m.set(t.signalId, t);
    return m;
  });

  /**
   * Why a trade was NOT simulated, keyed by id. 'unfilled' = never took risk; 'overlap' = it filled
   * while the symbol's simulated position was still open. Absent = after the ladder broke.
   */
  readonly skipReasonBySignalId = computed<Map<number, SkipInfo> | null>(() => {
    if (!this.enabled()) return null;
    return this.sim()?.skipReasons ?? null;
  });

  /** Public: adds running-ledger columns (cum P&L, equity) to the host's table. */
  readonly showCumulative = signal(true);
  protected showCumulativeModel = true;

  protected readonly symbolScope = signal<string>('__all__');
  protected readonly mode = signal<LadderMode>('recovery');
  protected readonly fixedMult = signal(2);
  protected readonly targetProfitR = signal(0.5);
  protected readonly baseRiskPct = signal(1);
  protected readonly maxDepth = signal(6);
  protected readonly capPolicy = signal<CapPolicy>('abandon');
  protected readonly startBalance = linkedSignal(() => this.defaultStartBalance() ?? 10000);
  protected readonly assumedGeomR = linkedSignal(() => this.defaultAssumedGeomR() ?? 1);

  /** The reward:risk control appears only when some trade records no target of its own. */
  protected readonly needsAssumedGeom = computed(() =>
    (this.trades() ?? []).some((t) => t.r !== null && t.geomR === null),
  );

  protected readonly echartsTheme = computed(() => (this.theme.theme() === 'dark' ? 'dark' : ''));

  protected readonly symbols = computed(() =>
    [...new Set((this.trades() ?? []).map((t) => t.symbol))].sort(),
  );

  protected readonly sim = computed<SimResult | null>(() => {
    const trades = this.trades();
    if (!trades) return null;
    return simulateLadder(trades, {
      symbolScope: this.symbolScope(),
      mode: this.mode(),
      fixedMult: this.fixedMult(),
      targetProfitR: this.targetProfitR(),
      baseRiskPct: this.baseRiskPct(),
      maxDepth: this.maxDepth(),
      capPolicy: this.capPolicy(),
      startBalance: this.startBalance(),
      assumedGeomR: this.assumedGeomR(),
    });
  });

  protected readonly equityOptions = computed<EChartsOption>(() => {
    const s = this.sim();
    const dark = this.theme.theme() === 'dark';
    const ok = dark ? '#3987e5' : '#2a78d6';
    const flat = dark ? '#d95926' : '#eb6834';
    const axis = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
    // Full precision: at a small balance / base risk, per-trade moves are cents, and rounding to
    // whole currency collapses the entire series into a step function that reads as a broken chart.
    const led = s?.trades.map((t) => +t.equity.toFixed(2)) ?? [];
    const bl = s?.baselineEquity.map((v) => +v.toFixed(2)) ?? [];
    // Date labels, not trade numbers: the page's own equity curve above speaks in dates, and the
    // operator's first move is to compare the two. Same sequence semantics, comparable axis.
    // A multi-year backtest needs the year; a few weeks of signals reads better with the time.
    const ts = s?.trades ?? [];
    const spanDays =
      ts.length > 1 ? (Date.parse(ts[ts.length - 1].at) - Date.parse(ts[0].at)) / 86_400_000 : 0;
    const labels = ts.map((t) => {
      const d = new Date(t.at);
      return spanDays > 300
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    });

    return {
      grid: { left: 68, right: 16, top: 30, bottom: 34 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Ladder', 'Flat sizing'], top: 0 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { hideOverlap: true, fontSize: 10 },
        axisLine: { lineStyle: { color: axis } },
      },
      yAxis: {
        type: 'value',
        name: 'equity',
        // Scale to the data. Anchored at zero, a 10,264-vs-9,971 comparison renders as two flat
        // lines squashed into the top of the plot — unreadable, which defeats the chart.
        scale: true,
        axisLine: { lineStyle: { color: axis } },
        splitLine: { lineStyle: { color: axis, opacity: 0.4 } },
      },
      series: [
        {
          name: 'Ladder',
          type: 'line',
          data: led,
          showSymbol: false,
          lineStyle: { width: 2, color: ok },
          itemStyle: { color: ok },
          // Ruin is marked, not implied by the line simply stopping.
          markPoint:
            s?.ruinedAtIndex != null
              ? {
                  symbolSize: 46,
                  data: [
                    {
                      name: 'ruin',
                      value: 'RUIN',
                      coord: [Math.max(0, led.length - 1), led[led.length - 1] ?? 0],
                      itemStyle: { color: '#d7263d' },
                    },
                  ],
                }
              : undefined,
        },
        {
          name: 'Flat sizing',
          type: 'line',
          data: bl,
          showSymbol: false,
          lineStyle: { width: 2, color: flat },
          itemStyle: { color: flat },
        },
      ],
    };
  });

  protected readonly depthOptions = computed<EChartsOption>(() => {
    const s = this.sim();
    const dark = this.theme.theme() === 'dark';
    const ok = dark ? '#3987e5' : '#2a78d6';
    const axis = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';

    const counts = new Map<number, number>();
    (s?.trades ?? []).forEach((t) => counts.set(t.depth, (counts.get(t.depth) ?? 0) + 1));
    const depths = [...counts.keys()].sort((a, b) => a - b);

    return {
      grid: { left: 56, right: 16, top: 18, bottom: 34 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category',
        name: 'depth',
        nameLocation: 'middle',
        nameGap: 22,
        data: depths,
        axisLine: { lineStyle: { color: axis } },
      },
      yAxis: {
        type: 'value',
        name: 'trades',
        axisLine: { lineStyle: { color: axis } },
        splitLine: { lineStyle: { color: axis, opacity: 0.4 } },
      },
      series: [
        {
          type: 'bar',
          data: depths.map((d) => counts.get(d) ?? 0),
          itemStyle: { color: ok, borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
  });
}
