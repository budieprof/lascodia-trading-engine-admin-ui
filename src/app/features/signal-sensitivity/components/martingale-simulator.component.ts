import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import { ThemeService } from '@core/theme/theme.service';
import type {
  AnalyzeSignalSensitivityResultDto,
  AnalyzeSignalSensitivitySignalDto,
} from '@core/api/api.types';

/** How the next stake is chosen after a loss. */
type LadderMode = 'recovery' | 'fixed';

/** What happens when the ladder hits its depth cap without recovering. */
type CapPolicy = 'abandon' | 'continue';

/** One simulated trade in sequence. */
interface SimTrade {
  index: number;
  symbol: string;
  r: number;
  laddered: boolean;
  depth: number;
  stakePct: number;
  pnl: number;
  equity: number;
}

interface SimResult {
  trades: SimTrade[];
  baselineEquity: number[];
  finalEquity: number;
  baselineFinal: number;
  maxDrawdownPct: number;
  ruinedAtIndex: number | null;
  maxDepth: number;
  laddersStarted: number;
  laddersRecovered: number;
  laddersAbandoned: number;
  peakStakePct: number;
  usableTrades: number;
  skippedNoR: number;
}

/**
 * Martingale / recovery-sizing simulator over the sensitivity result.
 *
 * <p><b>Why this lives client-side.</b> A ladder is a pure function of an ORDERED sequence of
 * per-trade R multiples, and the sensitivity result already carries exactly that — entry, SL, TP,
 * outcome, scenario P&L and timing for every replayed signal. Recomputing in the browser means the
 * ladder re-simulates instantly as the operator drags depth / base risk, instead of a round-trip per
 * knob, and it stays automatically consistent with whatever TP/SL multipliers are active above.</p>
 *
 * <p><b>Sizing is in R, not money.</b> Each trade's outcome is normalised to a multiple of the risk
 * it took, so restaking is a clean multiplication. Raw P&L cannot be restaked — doubling the lot on
 * a trade does not double a P&L figure that already has a lot size baked into it.</p>
 *
 * <p><b>The ladder is per-symbol and strictly sequential</b>, matching the intended rule: a symbol
 * running a ladder holds at most one position at a time, so its trades form one ordered chain and
 * other symbols are untouched.</p>
 */
@Component({
  selector: 'app-martingale-simulator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, PercentPipe, FormsModule, NgxEchartsDirective],
  template: `
    <section class="mg" aria-labelledby="mg-h">
      <header class="mg-head">
        <div>
          <h2 id="mg-h">Martingale simulation</h2>
          <p class="sub">
            Replays the signals above as a per-symbol recovery ladder. Sizing is expressed in R
            (multiples of the risk each trade took), so it tracks whatever TP/SL multipliers are
            active — change them above and this re-simulates.
          </p>
        </div>
        <label class="toggle">
          <input type="checkbox" [(ngModel)]="enabledModel" (ngModelChange)="enabled.set($event)" />
          <span>Enable</span>
        </label>
      </header>

      @if (!result()) {
        <p class="sub">Run a sensitivity analysis first — the ladder replays its signals.</p>
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
          <label>
            <span>Max depth</span>
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

        @if (sim(); as s) {
          @if (s.usableTrades === 0) {
            <p class="warn">
              No trades in this result carry a usable risk distance, so no ladder can be simulated.
            </p>
          } @else {
            <!-- ── Verdict ───────────────────────────────────────────────── -->
            @if (s.ruinedAtIndex !== null) {
              <p class="verdict verdict--ruin" role="alert">
                <strong
                  >Account wiped at trade #{{ s.ruinedAtIndex + 1 }} of {{ s.usableTrades }}</strong
                >
                — the ladder reached a stake the balance could not cover. Everything below is the
                run up to that point; the curve stops there because there is nothing left to trade.
              </p>
            } @else if (s.finalEquity > s.baselineFinal) {
              <p class="verdict verdict--ok">
                Survived. Ladder finished at
                {{ s.finalEquity | number: '1.0-0' }} vs
                {{ s.baselineFinal | number: '1.0-0' }} flat-sized — but read max drawdown and peak
                stake before treating that as an edge.
              </p>
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
                <span class="s">recovered · {{ s.laddersAbandoned }} abandoned</span>
              </div>
              <div class="tile">
                <span class="k">Trades simulated</span>
                <span class="v">{{ s.usableTrades | number }}</span>
                <span class="s">
                  @if (s.skippedNoR > 0) {
                    {{ s.skippedNoR }} skipped (no risk distance)
                  } @else {
                    all usable
                  }
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
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
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

      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
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

  /** The sensitivity result to replay. Null until the operator runs an analysis. */
  readonly result = input<AnalyzeSignalSensitivityResultDto | null>(null);

  protected readonly enabled = signal(false);
  protected enabledModel = false;

  protected readonly symbolScope = signal<string>('__all__');
  protected readonly mode = signal<LadderMode>('recovery');
  protected readonly fixedMult = signal(2);
  protected readonly targetProfitR = signal(0.5);
  protected readonly baseRiskPct = signal(1);
  protected readonly maxDepth = signal(6);
  protected readonly capPolicy = signal<CapPolicy>('abandon');
  protected readonly startBalance = signal(10000);

  protected readonly echartsTheme = computed(() => (this.theme.theme() === 'dark' ? 'dark' : ''));

  protected readonly symbols = computed(() =>
    [...new Set((this.result()?.signals ?? []).map((s) => s.symbol))].sort(),
  );

  /**
   * Per-trade outcome as a multiple of the risk that trade took.
   *
   * <p>Derived from prices rather than read off a field, because the sensitivity replay applies
   * TP/SL multipliers that the stored levels do not reflect. A stopped-out trade is −1R by
   * definition; anything else is scaled by how far it actually travelled against its own stop
   * distance, so the number restakes correctly at any lot size.</p>
   *
   * <p>Returns null when the trade never took risk (no fill, zero stop distance) — those are
   * excluded rather than silently counted as scratches, since a ladder must not advance on a trade
   * that never happened.</p>
   */
  private rMultiple(
    sig: AnalyzeSignalSensitivitySignalDto,
    slMult: number,
    tpMult: number,
  ): number | null {
    if (!sig.fillAt) return null; // never filled — no risk taken
    const riskDist = Math.abs(sig.entryPrice - sig.originalSL) * (slMult || 1);
    if (!isFinite(riskDist) || riskDist <= 0) return null;

    if (sig.outcome === 'HitSL') return -1;
    if (sig.outcome === 'HitTP') {
      const rewardDist = Math.abs(sig.originalTP - sig.entryPrice) * (tpMult || 1);
      return rewardDist / riskDist;
    }
    // EarlyExit / Expired / Open — use realised travel, signed by direction.
    if (sig.exitPrice == null) return null;
    const move = sig.exitPrice - sig.entryPrice;
    const signed = (sig.direction || '').toLowerCase().startsWith('s') ? -move : move;
    return signed / riskDist;
  }

  protected readonly sim = computed<SimResult | null>(() => {
    const res = this.result();
    if (!res) return null;

    const scope = this.symbolScope();
    const slMult = res.slMultiplier ?? 1;
    const tpMult = res.tpMultiplier ?? 1;

    // Chronological by fill, then id — the ladder is a SEQUENCE, so order is the whole model.
    const ordered = [...res.signals].sort((a, b) => {
      const ta = Date.parse(a.fillAt ?? a.triggeredAt ?? a.generatedAt);
      const tb = Date.parse(b.fillAt ?? b.triggeredAt ?? b.generatedAt);
      return ta === tb ? a.signalId - b.signalId : ta - tb;
    });

    const base = this.baseRiskPct() / 100;
    const target = this.targetProfitR();
    const cap = Math.max(1, Math.trunc(this.maxDepth()));
    const useRecovery = this.mode() === 'recovery';
    const mult = Math.max(1, this.fixedMult());

    let equity = this.startBalance();
    let baseline = this.startBalance();
    let peakEquity = equity;
    let maxDd = 0;
    let peakStakePct = 0;
    let ruinedAt: number | null = null;
    let maxDepthSeen = 0;
    let started = 0;
    let recovered = 0;
    let abandoned = 0;
    let skipped = 0;

    // Ladder state is PER SYMBOL: a symbol running a ladder is serialised, and other symbols
    // continue on flat sizing untouched. That is the rule being modelled, not a simplification.
    const ladder = new Map<string, { depth: number; cumLossR: number }>();

    const trades: SimTrade[] = [];
    const baselineEquity: number[] = [];

    ordered.forEach((sig) => {
      const r = this.rMultiple(sig, slMult, tpMult);
      if (r === null) {
        skipped++;
        return;
      }

      const inScope = scope === '__all__' || sig.symbol === scope;
      const st = ladder.get(sig.symbol) ?? { depth: 0, cumLossR: 0 };

      // Stake in fraction-of-equity terms. Depth 0 is always the base stake.
      let stakePct = base;
      if (inScope && st.depth > 0) {
        stakePct = useRecovery
          ? // Recover accumulated losses plus a target, at this trade's own reward ratio. With
            // r < 1 the reward leg is smaller than the risk leg, which is exactly why this grows
            // faster than doubling.
            (base * (st.cumLossR + target)) / Math.max(0.05, r > 0 ? r : 1)
          : base * Math.pow(mult, st.depth);
      }

      const stakeMoney = equity * stakePct;
      peakStakePct = Math.max(peakStakePct, stakePct * 100);

      // Ruin: the stake the ladder demands exceeds what is left. Recording the index rather than
      // clamping keeps the failure visible instead of quietly capping it into survival.
      if (stakeMoney > equity || equity <= 0) {
        ruinedAt = trades.length;
        return;
      }

      const pnl = r * stakeMoney;
      equity += pnl;
      baseline += r * (baseline * base);
      baselineEquity.push(baseline);

      peakEquity = Math.max(peakEquity, equity);
      maxDd = Math.max(maxDd, peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0);

      trades.push({
        index: trades.length,
        symbol: sig.symbol,
        r,
        laddered: inScope && st.depth > 0,
        depth: inScope ? st.depth : 0,
        stakePct: stakePct * 100,
        pnl,
        equity,
      });

      if (equity <= 0) {
        ruinedAt = trades.length - 1;
        return;
      }

      // Advance ladder state.
      if (inScope) {
        if (r > 0) {
          if (st.depth > 0) recovered++;
          ladder.set(sig.symbol, { depth: 0, cumLossR: 0 });
        } else {
          if (st.depth === 0) started++;
          maxDepthSeen = Math.max(maxDepthSeen, st.depth + 1);
          const nextDepth = st.depth + 1;
          if (nextDepth >= cap && this.capPolicy() === 'abandon') {
            abandoned++;
            ladder.set(sig.symbol, { depth: 0, cumLossR: 0 });
          } else {
            ladder.set(sig.symbol, {
              depth: nextDepth,
              cumLossR: st.cumLossR + stakePct / base,
            });
          }
        }
      }
    });

    return {
      trades,
      baselineEquity,
      finalEquity: equity,
      baselineFinal: baseline,
      maxDrawdownPct: maxDd,
      ruinedAtIndex: ruinedAt,
      maxDepth: maxDepthSeen,
      laddersStarted: started,
      laddersRecovered: recovered,
      laddersAbandoned: abandoned,
      peakStakePct,
      usableTrades: trades.length,
      skippedNoR: skipped,
    };
  });

  protected readonly equityOptions = computed<EChartsOption>(() => {
    const s = this.sim();
    const dark = this.theme.theme() === 'dark';
    const ok = dark ? '#3987e5' : '#2a78d6';
    const flat = dark ? '#d95926' : '#eb6834';
    const axis = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
    const led = s?.trades.map((t) => Math.round(t.equity)) ?? [];
    const bl = s?.baselineEquity.map((v) => Math.round(v)) ?? [];

    return {
      grid: { left: 68, right: 16, top: 30, bottom: 34 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Ladder', 'Flat sizing'], top: 0 },
      xAxis: {
        type: 'category',
        name: 'trade #',
        nameLocation: 'middle',
        nameGap: 22,
        data: bl.map((_, i) => i + 1),
        axisLine: { lineStyle: { color: axis } },
      },
      yAxis: {
        type: 'value',
        name: 'equity',
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
