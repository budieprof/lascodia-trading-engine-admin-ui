import type { Bar } from '../datafeed/candle-feed.service';
import { pineGt, pineLt, utcDay, type DayOf, type Maybe, type Ohlc } from '../indicators/math';
import type { IndicatorContext } from '../indicators/registry';
import { notionalAllowed, QUOTE_NOTIONAL } from '../indicators/volume-labels';

/**
 * US01: the studies' incremental TAIL path. A tick changes the newest bar; a minute resync the last
 * one or two. Recomputing every study over the whole window (up to 20 000 bars) per tick cost the
 * chart — and each of up to seven split panels — a full pass of every study's maths per price.
 *
 * <p>For the common built-ins, a {@link TailKernel} computes a study one bar at a time with the SAME
 * floating-point operations, in the same order, as its full computation in `indicators/math.ts`, so
 * the values are identical to the last bit (pinned by `study-tail.spec.ts`, a property test over
 * random tick sequences against `def.compute`). The engine keeps each study's state as it stood
 * before the newest bar (a checkpoint), so a change at or after that bar resumes from it: one
 * bar's work per tick instead of the whole history. A change further back (history prepended, a
 * resync rewriting older bars, another time zone) — or a study without a kernel, or inputs a kernel
 * does not cover (a fractional length) — computes in full, exactly as before.</p>
 *
 * Pure: no chart, no Angular.
 */

type Out = Record<string, Maybe[]>;
type Params = Record<string, number | string>;

/** One study computed bar by bar. `S` is everything the full computation carries from bar to bar. */
export interface TailKernel<S> {
  /** The plot keys `compute` returns, each written at every bar. */
  readonly keys: readonly string[];
  init(): S;
  clone(s: S): S;
  /** Bar `i` (every bar before it already stepped into `s`): advance `s`, write each plot's value at `i`. */
  step(s: S, bars: readonly Ohlc[], i: number, out: Out): void;
}

// ── Inputs, read exactly as the registry reads them ─────────────────────────

const num = (p: Params, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/** A length the kernels cover: a whole number ≥ 1 (anything else computes in full). */
const whole = (n: number): boolean => Number.isInteger(n) && n >= 1;

/** `sourceValues(bars, source)` for one bar — the same arithmetic. */
type SourceOf = (b: Ohlc) => number;
function sourceOf(p: Params): SourceOf {
  switch ((p['source'] as string | undefined) ?? 'close') {
    case 'open':
      return (b) => b.open;
    case 'high':
      return (b) => b.high;
    case 'low':
      return (b) => b.low;
    case 'hl2':
      return (b) => (b.high + b.low) / 2;
    case 'hlc3':
      return (b) => (b.high + b.low + b.close) / 3;
    case 'ohlc4':
      return (b) => (b.open + b.high + b.low + b.close) / 4;
    default:
      return (b) => b.close;
  }
}

// ── Building blocks (each mirrors one function of math.ts) ──────────────────

/** `sma(values, period)`: the running sum, added then the leaving value taken off. */
interface SmaState {
  sum: number;
}
function smaStep(s: SmaState, v: number, leaving: number | undefined, i: number, period: number): Maybe {
  s.sum += v;
  if (i >= period) s.sum -= leaving as number;
  return i >= period - 1 ? s.sum / period : null;
}

/** `ema(values, period)`: seeded with the SMA of the first `period` values. */
interface EmaState {
  seed: number;
  prev: number;
}
function emaStep(s: EmaState, v: number, i: number, period: number, k: number): Maybe {
  if (i < period) {
    s.seed += v;
    if (i < period - 1) return null;
    s.prev = s.seed / period;
    return s.prev;
  }
  s.prev = v * k + s.prev * (1 - k);
  return s.prev;
}

/** `wilder(values, period)`. */
function wilderStep(s: EmaState, v: number, i: number, period: number): Maybe {
  if (i < period) {
    s.seed += v;
    if (i < period - 1) return null;
    s.prev = s.seed / period;
    return s.prev;
  }
  s.prev = (s.prev * (period - 1) + v) / period;
  return s.prev;
}

const ema0 = (): EmaState => ({ seed: 0, prev: 0 });

function set(out: Out, key: string, i: number, v: Maybe): void {
  out[key][i] = v;
}

// ── Kernels ─────────────────────────────────────────────────────────────────

function smaKernel(p: Params): TailKernel<SmaState> | null {
  const period = num(p, 'length', 20);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  return {
    keys: ['ma'],
    init: () => ({ sum: 0 }),
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) =>
      set(out, 'ma', i, smaStep(s, at(bars[i]), i >= period ? at(bars[i - period]) : undefined, i, period)),
  };
}

function emaKernel(p: Params): TailKernel<EmaState> | null {
  const period = num(p, 'length', 20);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  const k = 2 / (period + 1);
  return {
    keys: ['ma'],
    init: ema0,
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) => set(out, 'ma', i, emaStep(s, at(bars[i]), i, period, k)),
  };
}

/** `wma`: each value from its own window, heaviest on the newest bar. */
function wmaKernel(p: Params): TailKernel<null> | null {
  const period = num(p, 'length', 20);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  const denom = (period * (period + 1)) / 2;
  return {
    keys: ['ma'],
    init: () => null,
    clone: () => null,
    step: (_s, bars, i, out) => {
      if (i < period - 1) return set(out, 'ma', i, null);
      let acc = 0;
      for (let j = 0; j < period; j++) acc += at(bars[i - period + 1 + j]) * (j + 1);
      set(out, 'ma', i, acc / denom);
    },
  };
}

function bollingerKernel(p: Params): TailKernel<SmaState> | null {
  const period = num(p, 'length', 20);
  const mult = num(p, 'mult', 2);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  return {
    keys: ['upper', 'middle', 'lower'],
    init: () => ({ sum: 0 }),
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) => {
      const mean = smaStep(s, at(bars[i]), i >= period ? at(bars[i - period]) : undefined, i, period);
      set(out, 'middle', i, mean);
      if (mean === null) {
        set(out, 'upper', i, null);
        set(out, 'lower', i, null);
        return;
      }
      let acc = 0;
      for (let j = i - period + 1; j <= i; j++) acc += (at(bars[j]) - mean) ** 2;
      const sd = Math.sqrt(acc / period);
      set(out, 'upper', i, mean + mult * sd);
      set(out, 'lower', i, mean - mult * sd);
    },
  };
}

/** `vwap(bars, dayOf)` = `vwapRun(bars, { source: 'hlc3', periodOf: dayOf })`. */
interface VwapState {
  key: number;
  sv: number;
  spv: number;
  sp2v: number;
}
function vwapKernel(_p: Params, ctx?: IndicatorContext): TailKernel<VwapState> {
  const dayOf: DayOf = ctx?.tradingDay ?? utcDay;
  return {
    keys: ['vwap'],
    init: () => ({ key: NaN, sv: 0, spv: 0, sp2v: 0 }),
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) => {
      const b = bars[i];
      const k = dayOf(b.time);
      if (k !== s.key) {
        s.key = k;
        s.sv = 0;
        s.spv = 0;
        s.sp2v = 0;
      }
      const price = (b.high + b.low + b.close) / 3;
      const v = b.volume;
      if (Number.isFinite(price) && Number.isFinite(v) && v > 0) {
        s.spv += price * v;
        s.sv += v;
        s.sp2v += v * price * price;
      }
      set(out, 'vwap', i, s.sv <= 0 ? null : s.spv / s.sv);
    },
  };
}

/** `rsi(closes, period)`: Wilder averages of the gains and losses from the second bar on. */
interface RsiState {
  gain: EmaState;
  loss: EmaState;
}
function rsiKernel(p: Params): TailKernel<RsiState> | null {
  const period = num(p, 'length', 14);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  return {
    keys: ['rsi'],
    init: () => ({ gain: ema0(), loss: ema0() }),
    clone: (s) => ({ gain: { ...s.gain }, loss: { ...s.loss } }),
    step: (s, bars, i, out) => {
      if (i === 0) return set(out, 'rsi', i, null);
      const d = at(bars[i]) - at(bars[i - 1]);
      const g = wilderStep(s.gain, Math.max(0, d), i - 1, period);
      const l = wilderStep(s.loss, Math.max(0, -d), i - 1, period);
      set(out, 'rsi', i, g === null || l === null ? null : l === 0 ? 100 : 100 - 100 / (1 + g / l));
    },
  };
}

/** `macd`: two EMAs, and the signal EMA over the MACD line from its first value. */
interface MacdState {
  fast: EmaState;
  slow: EmaState;
  signal: EmaState;
  /** Values of the MACD line so far (the signal EMA's index). */
  dense: number;
}
function macdKernel(p: Params): TailKernel<MacdState> | null {
  const fast = num(p, 'fast', 12);
  const slow = num(p, 'slow', 26);
  const sig = num(p, 'signal', 9);
  if (!whole(fast) || !whole(slow) || !whole(sig)) return null;
  const at = sourceOf(p);
  const kf = 2 / (fast + 1);
  const ks = 2 / (slow + 1);
  const kg = 2 / (sig + 1);
  return {
    keys: ['macd', 'signal', 'histogram'],
    init: () => ({ fast: ema0(), slow: ema0(), signal: ema0(), dense: 0 }),
    clone: (s) => ({ fast: { ...s.fast }, slow: { ...s.slow }, signal: { ...s.signal }, dense: s.dense }),
    step: (s, bars, i, out) => {
      const v = at(bars[i]);
      const f = emaStep(s.fast, v, i, fast, kf);
      const sl = emaStep(s.slow, v, i, slow, ks);
      const line = f !== null && sl !== null ? f - sl : null;
      let signal: Maybe = null;
      if (line !== null) signal = emaStep(s.signal, line, s.dense++, sig, kg);
      set(out, 'macd', i, line);
      set(out, 'signal', i, signal);
      set(out, 'histogram', i, line !== null && signal !== null ? line - signal : null);
    },
  };
}

function atrKernel(p: Params): TailKernel<EmaState> | null {
  const period = num(p, 'length', 14);
  if (!whole(period)) return null;
  return {
    keys: ['atr'],
    init: ema0,
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) => {
      const b = bars[i];
      let tr: number;
      if (i === 0) tr = b.high - b.low;
      else {
        const pc = bars[i - 1].close;
        tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
      }
      set(out, 'atr', i, wilderStep(s, tr, i, period));
    },
  };
}

/** `volume`: the bar's volume (or quote notional) with its SMA. */
function volumeKernel(p: Params, ctx?: IndicatorContext): TailKernel<SmaState> | null {
  const period = num(p, 'length', 20);
  if (!whole(period)) return null;
  const notional = p['measure'] === QUOTE_NOTIONAL;
  const blank = notional && !notionalAllowed(ctx?.volumeKind);
  const vol = (b: Ohlc): number => (notional ? b.volume * ((b.high + b.low + b.close) / 3) : b.volume);
  return {
    keys: ['volume', 'ma'],
    init: () => ({ sum: 0 }),
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) => {
      if (blank) {
        set(out, 'volume', i, null);
        set(out, 'ma', i, null);
        return;
      }
      const v = vol(bars[i]);
      set(out, 'volume', i, v);
      set(out, 'ma', i, smaStep(s, v, i >= period ? vol(bars[i - period]) : undefined, i, period));
    },
  };
}

function obvKernel(): TailKernel<{ running: number }> {
  return {
    keys: ['obv'],
    init: () => ({ running: 0 }),
    clone: (s) => ({ ...s }),
    step: (s, bars, i, out) => {
      if (i === 0) return set(out, 'obv', i, null);
      const c = bars[i].close;
      const prev = bars[i - 1].close;
      s.running += pineGt(c, prev) ? bars[i].volume : pineLt(c, prev) ? -bars[i].volume : 0;
      set(out, 'obv', i, s.running);
    },
  };
}

/** `stochastic`: raw %K per window, then the SMA smoothings over the defined values, clamped to 0..100. */
interface StochState {
  k: SmaState;
  d: SmaState;
  /** Raw %K values so far, and %K values so far (each smoothing's own index). */
  rawCount: number;
  kCount: number;
  /** The last `smoothK` raw values / `smoothD` %K values (what leaves each running sum). */
  rawRing: number[];
  kRing: number[];
}
function stochasticKernel(p: Params): TailKernel<StochState> | null {
  const period = num(p, 'length', 14);
  const smoothK = num(p, 'smoothK', 1);
  const smoothD = num(p, 'smoothD', 3);
  if (!whole(period) || !whole(smoothK) || !whole(smoothD)) return null;
  const clamp = (v: number): number => Math.max(0, Math.min(100, v));
  return {
    keys: ['k', 'd'],
    init: () => ({ k: { sum: 0 }, d: { sum: 0 }, rawCount: 0, kCount: 0, rawRing: [], kRing: [] }),
    clone: (s) => ({
      k: { ...s.k },
      d: { ...s.d },
      rawCount: s.rawCount,
      kCount: s.kCount,
      rawRing: s.rawRing.slice(),
      kRing: s.kRing.slice(),
    }),
    step: (s, bars, i, out) => {
      if (i < period - 1) {
        set(out, 'k', i, null);
        set(out, 'd', i, null);
        return;
      }
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        hh = Math.max(hh, bars[j].high);
        ll = Math.min(ll, bars[j].low);
      }
      const span = hh - ll;
      const raw = span === 0 ? 50 : Math.max(0, Math.min(100, ((bars[i].close - ll) / span) * 100));
      let k: Maybe;
      if (smoothK <= 1) k = raw;
      else {
        const n = s.rawCount++;
        s.rawRing.push(raw);
        const leaving = n >= smoothK ? s.rawRing.shift() : undefined;
        k = smaStep(s.k, raw, leaving, n, smoothK);
      }
      k = k === null ? null : clamp(k);
      let d: Maybe = null;
      if (k !== null) {
        if (smoothD <= 1) d = k;
        else {
          const n = s.kCount++;
          s.kRing.push(k);
          const leaving = n >= smoothD ? s.kRing.shift() : undefined;
          d = smaStep(s.d, k, leaving, n, smoothD);
        }
      }
      set(out, 'k', i, k);
      set(out, 'd', i, d === null ? null : clamp(d));
    },
  };
}

function donchianKernel(p: Params): TailKernel<null> | null {
  const period = num(p, 'length', 20);
  if (!whole(period)) return null;
  return {
    keys: ['upper', 'middle', 'lower'],
    init: () => null,
    clone: () => null,
    step: (_s, bars, i, out) => {
      if (i < period - 1) {
        set(out, 'upper', i, null);
        set(out, 'middle', i, null);
        set(out, 'lower', i, null);
        return;
      }
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        hh = Math.max(hh, bars[j].high);
        ll = Math.min(ll, bars[j].low);
      }
      set(out, 'upper', i, hh);
      set(out, 'lower', i, ll);
      set(out, 'middle', i, (hh + ll) / 2);
    },
  };
}

function momentumKernel(p: Params): TailKernel<null> | null {
  const period = num(p, 'length', 10);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  return {
    keys: ['mom'],
    init: () => null,
    clone: () => null,
    step: (_s, bars, i, out) =>
      set(out, 'mom', i, i < period ? null : at(bars[i]) - at(bars[i - period])),
  };
}

function rocKernel(p: Params): TailKernel<null> | null {
  const period = num(p, 'length', 9);
  if (!whole(period)) return null;
  const at = sourceOf(p);
  return {
    keys: ['roc'],
    init: () => null,
    clone: () => null,
    step: (_s, bars, i, out) => {
      if (i < period) return set(out, 'roc', i, null);
      const base = at(bars[i - period]);
      set(out, 'roc', i, base === 0 ? null : ((at(bars[i]) - base) / base) * 100);
    },
  };
}

type KernelFactory = (p: Params, ctx?: IndicatorContext) => TailKernel<unknown> | null;

/** The built-ins with a tail kernel, by registry id. */
export const TAIL_KERNELS: Readonly<Record<string, KernelFactory>> = {
  sma: smaKernel as KernelFactory,
  ema: emaKernel as KernelFactory,
  wma: wmaKernel as KernelFactory,
  bollinger: bollingerKernel as KernelFactory,
  vwap: vwapKernel as KernelFactory,
  rsi: rsiKernel as KernelFactory,
  macd: macdKernel as KernelFactory,
  atr: atrKernel as KernelFactory,
  volume: volumeKernel as KernelFactory,
  obv: obvKernel as KernelFactory,
  stochastic: stochasticKernel as KernelFactory,
  donchian: donchianKernel as KernelFactory,
  momentum: momentumKernel as KernelFactory,
  roc: rocKernel as KernelFactory,
};

// ── The engine ──────────────────────────────────────────────────────────────

interface Entry {
  kernel: TailKernel<unknown>;
  out: Out;
  /** The state after bars [0, at): every value before `at` is final until a bar before it changes. */
  checkpoint: unknown;
  at: number;
  /** The first bar that changed since this entry was last computed (Infinity: none). */
  dirtyFrom: number;
  /** The sweep it was last used in. */
  used: number;
}

/** What one {@link StudyTailEngine.compute} produced. */
export interface TailResult {
  values: Out;
  /** The first bar whose value may have changed: every value before it is as it was. */
  from: number;
}

export class StudyTailEngine {
  private readonly entries = new Map<string, Entry>();
  private sweepNo = 0;

  /** Bars were rebuilt (another series, style, time zone, history on the left): every study starts over. */
  reset(): void {
    this.entries.clear();
  }

  /**
   * The bars at and after `from` changed, were added or taken off. Also forgets the studies not
   * computed since the previous call but one (removed, or their inputs changed: a new key).
   */
  barsChanged(from: number): void {
    this.sweepNo++;
    for (const [key, e] of this.entries) {
      if (e.used < this.sweepNo - 2) this.entries.delete(key);
      else e.dirtyFrom = Math.min(e.dirtyFrom, from);
    }
  }

  /** Whether `defId` with these inputs has a kernel (else the caller computes it in full). */
  covers(defId: string, params: Params, ctx?: IndicatorContext): boolean {
    return !!TAIL_KERNELS[defId]?.(params, ctx);
  }

  /**
   * The study's values over `bars`, from its checkpoint when nothing before it changed, else from
   * the first bar. `key` must change whenever the inputs or the context the values depend on change
   * (the host's study cache key). Null when the study has no kernel for these inputs.
   */
  compute(
    key: string,
    defId: string,
    params: Params,
    bars: readonly Ohlc[],
    ctx?: IndicatorContext,
  ): TailResult | null {
    let e = this.entries.get(key);
    const n = bars.length;
    if (!e || e.dirtyFrom < e.at || n < e.at) {
      const kernel = TAIL_KERNELS[defId]?.(params, ctx);
      if (!kernel) {
        this.entries.delete(key);
        return null;
      }
      const out: Out = {};
      for (const k of kernel.keys) out[k] = [];
      e = { kernel, out, checkpoint: kernel.init(), at: 0, dirtyFrom: Infinity, used: this.sweepNo };
      this.entries.set(key, e);
    }
    const from = e.at;
    const { kernel, out } = e;
    for (const k of kernel.keys) out[k].length = from;
    const s = kernel.clone(e.checkpoint);
    for (let i = from; i < n; i++) {
      // The newest bar is the one a tick moves: the checkpoint is the state just before it.
      if (i === n - 1) {
        e.checkpoint = kernel.clone(s);
        e.at = i;
      }
      kernel.step(s, bars, i, out);
    }
    e.dirtyFrom = Infinity;
    e.used = this.sweepNo;
    return { values: out, from };
  }
}

/**
 * The plotted bars as the study maths takes them ({@link Ohlc}), kept in step from the first bar
 * that changed: a tick makes one object, not 20 000. A new array each time (what holds the old one
 * keeps what it saw); the bars before `from` are the same objects.
 */
export class StudyBarsMirror {
  ohlc: Ohlc[] = [];
  utcTimes: number[] = [];

  update(plotted: readonly Bar[], plottedUtc: readonly Bar[], from: number): void {
    const start = Math.max(0, Math.min(from, this.ohlc.length, plotted.length));
    const ohlc = this.ohlc.slice(0, start);
    const utc = this.utcTimes.slice(0, start);
    for (let i = start; i < plotted.length; i++) {
      const b = plotted[i];
      ohlc.push({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      });
      utc.push(plottedUtc[i]?.time ?? b.time);
    }
    this.ohlc = ohlc;
    this.utcTimes = utc;
  }
}
