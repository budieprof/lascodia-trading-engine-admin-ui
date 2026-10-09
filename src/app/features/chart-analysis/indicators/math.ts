/**
 * Indicator maths — pure functions over bar arrays.
 *
 * Kept free of Lightweight Charts and of Angular so the numbers can be tested
 * directly, and so the replica's indicator library is not welded to the
 * renderer. Every function takes ASCENDING bars and returns an array the same
 * length as its input, with `null` for bars where the indicator has no value
 * yet (the warm-up period).
 *
 * Returning `null` rather than skipping or zero-filling is deliberate: the
 * series data has to line up with bar times one-for-one, and a zero during
 * warm-up draws a line to the bottom of the pane that looks like a real
 * reading. Callers drop the nulls when converting to chart points.
 */

import { pivotLevels as verifiedPivotLevels, type PivotMethod } from '../panels/pivots';
import { periodKey, utcDay, type AnchorPeriod, type DayOf } from './periods';
import { volumeProfile as profileVolume, vwapRun } from '../profiles/profile-math';

export type Maybe = number | null;

export interface Ohlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// The trading periods (day / week / month of a bar) live in `periods.ts`, shared with the profile engine.
export { periodKey, utcDay, type AnchorPeriod, type DayOf } from './periods';

const nulls = (n: number): Maybe[] => new Array<Maybe>(Math.max(0, n)).fill(null);

// ── Pine semantics (DR-I1) ──────────────────────────────────────────────────
//
// The engine's Pine runtime is the reference these studies are held to (`reference-parity.spec.ts`). Where a
// TradingView built-in's result is decided by a comparison or by how `na` flows, the port below follows the
// runtime's rules exactly rather than approximately, or a flip lands on a different bar.

/**
 * Pine's float comparison rule (the engine's `PineOps`): both sides rounded to nine decimals, half away from
 * zero, before comparing — so `a > b` is false for values a hair apart. Any comparison with NaN is false.
 */
const round9 = (x: number): number => (Math.sign(x) * Math.round(Math.abs(x) * 1e9)) / 1e9;
const gt = (a: number, b: number): boolean => round9(a) > round9(b);
const lt = (a: number, b: number): boolean => round9(a) < round9(b);
const ge = (a: number, b: number): boolean => round9(a) >= round9(b);
const le = (a: number, b: number): boolean => round9(a) <= round9(b);
const eq = (a: number, b: number): boolean => round9(a) === round9(b);
const toNum = (v: Maybe | undefined): number => (v === null || v === undefined ? NaN : v);
const maybe = (v: number): Maybe => (Number.isFinite(v) ? v : null);

/**
 * `ta.ema` / `ta.rma` over a series with gaps, as the runtime does it: na values are skipped, the average is seeded
 * with the SMA of the first `period` values that are not na, and it holds its value across a na.
 */
function smoothNa(series: readonly Maybe[], period: number, wilderAlpha: boolean): Maybe[] {
  const out: Maybe[] = nulls(series.length);
  if (period <= 0) return out;
  const alpha = wilderAlpha ? 1 / period : 2 / (period + 1);
  let value = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    if (x !== null && x !== undefined && !Number.isNaN(x)) {
      if (seedCount < period) {
        seedSum += x;
        seedCount++;
        if (seedCount === period) value = seedSum / period;
      } else {
        value = alpha * x + (1 - alpha) * value;
      }
    }
    out[i] = maybe(value);
  }
  return out;
}

/** `ta.ema` with the runtime's na handling ({@link smoothNa}). */
export function emaNa(series: readonly Maybe[], period: number): Maybe[] {
  return smoothNa(series, period, false);
}

/**
 * `math.sum` / `ta.sma` with the runtime's na handling: the sum (or mean) of the last `period` values that are not
 * na — na until there are that many — holding across a na.
 */
function windowNa(series: readonly Maybe[], period: number, mean: boolean): Maybe[] {
  const out: Maybe[] = nulls(series.length);
  if (period <= 0) return out;
  const window: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    if (x !== null && x !== undefined && !Number.isNaN(x)) {
      window.push(x);
      if (window.length > period) window.shift();
    }
    if (window.length === period) {
      let s = 0;
      for (const v of window) s += v;
      out[i] = mean ? s / period : s;
    }
  }
  return out;
}

/** `ta.sma` with the runtime's na handling ({@link windowNa}). */
export function smaNa(series: readonly Maybe[], period: number): Maybe[] {
  return windowNa(series, period, true);
}

/** `math.sum` with the runtime's na handling ({@link windowNa}). */
export function sumNa(series: readonly Maybe[], period: number): Maybe[] {
  return windowNa(series, period, false);
}

/** `ta.swma`: weights 1-2-2-1 over the last four values; na while any of them is na. */
function swma(series: readonly Maybe[]): Maybe[] {
  const out: Maybe[] = nulls(series.length);
  for (let i = 3; i < series.length; i++) {
    const a3 = series[i - 3];
    const a2 = series[i - 2];
    const a1 = series[i - 1];
    const a0 = series[i];
    if (a3 === null || a2 === null || a1 === null || a0 === null) continue;
    // The runtime's operation order, so the values are the same to the last bit.
    out[i] = (a3 * 1) / 6 + (a2 * 2) / 6 + (a1 * 2) / 6 + (a0 * 1) / 6;
  }
  return out;
}

/** `ta.highest` / `ta.lowest` over the last `period` values that are not na (na until there are that many). */
function extremeNa(series: readonly Maybe[], period: number, max: boolean): Maybe[] {
  const out: Maybe[] = nulls(series.length);
  if (period <= 0) return out;
  const window: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    if (x !== null && x !== undefined && !Number.isNaN(x)) {
      window.push(x);
      if (window.length > period) window.shift();
    }
    if (window.length === period) out[i] = max ? Math.max(...window) : Math.min(...window);
  }
  return out;
}

/** Simple moving average. */
export function sma(values: number[], period: number): Maybe[] {
  if (period <= 0 || values.length === 0) return nulls(values.length);
  const out: Maybe[] = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average.
 *
 * Seeded with the SMA of the first `period` values — the conventional seed, and
 * the one that makes our EMA agree with TradingView's. Seeding with the first
 * close instead produces values that converge but differ visibly for the first
 * few hundred bars, which reads as "our chart is wrong".
 */
export function ema(values: number[], period: number): Maybe[] {
  if (period <= 0 || values.length < period) return nulls(values.length);
  const out: Maybe[] = nulls(values.length);
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Weighted moving average — linear weights, heaviest on the newest bar. */
export function wma(values: number[], period: number): Maybe[] {
  if (period <= 0 || values.length < period) return nulls(values.length);
  const out: Maybe[] = nulls(values.length);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - period + 1 + j] * (j + 1);
    out[i] = acc / denom;
  }
  return out;
}

/**
 * Wilder's smoothing — the running average used by RSI, ATR and ADX.
 * Distinct from EMA: the factor is 1/period, not 2/(period+1).
 */
function wilder(values: number[], period: number): Maybe[] {
  if (period <= 0 || values.length < period) return nulls(values.length);
  const out: Maybe[] = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index (Wilder). */
export function rsi(closes: number[], period = 14): Maybe[] {
  if (closes.length <= period) return nulls(closes.length);
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const avgGain = wilder(gains, period);
  const avgLoss = wilder(losses, period);
  const out: Maybe[] = nulls(closes.length);
  for (let i = 0; i < gains.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === null || l === null) continue;
    // A run with no losses is RSI 100 by definition; guarding the divide keeps
    // it from becoming NaN and blanking the pane.
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export interface MacdResult {
  macd: Maybe[];
  signal: Maybe[];
  histogram: Maybe[];
}

/** MACD — fast EMA minus slow EMA, with an EMA signal line. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line: Maybe[] = closes.map((_, i) =>
    f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null,
  );
  // The signal EMA runs over the MACD line's defined region only, then is
  // written back at the right offset — feeding it the nulls would poison the
  // seed and shift every subsequent value.
  const firstDefined = line.findIndex((v) => v !== null);
  const signal: Maybe[] = nulls(closes.length);
  if (firstDefined >= 0) {
    const dense = line.slice(firstDefined).map((v) => v as number);
    const sig = ema(dense, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstDefined + i] = sig[i];
  }
  const histogram: Maybe[] = closes.map((_, i) =>
    line[i] !== null && signal[i] !== null ? (line[i] as number) - (signal[i] as number) : null,
  );
  return { macd: line, signal, histogram };
}

export interface BandsResult {
  upper: Maybe[];
  middle: Maybe[];
  lower: Maybe[];
}

/** Bollinger Bands — SMA ± k population standard deviations. */
export function bollinger(closes: number[], period = 20, mult = 2): BandsResult {
  const middle = sma(closes, period);
  const upper: Maybe[] = nulls(closes.length);
  const lower: Maybe[] = nulls(closes.length);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i];
    if (mean === null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
}

/** True range per bar. First bar falls back to high-low. */
export function trueRange(bars: Ohlc[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Average True Range (Wilder). */
export function atr(bars: Ohlc[], period = 14): Maybe[] {
  return wilder(trueRange(bars), period);
}

export interface StochasticResult {
  k: Maybe[];
  d: Maybe[];
}

/** Stochastic oscillator — %K smoothed, with an SMA %D. */
export function stochastic(bars: Ohlc[], period = 14, smoothK = 3, smoothD = 3): StochasticResult {
  const raw: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const span = hh - ll;
    // A flat window has no range to position the close within; 50 is the
    // conventional answer and avoids a divide by zero.
    raw[i] = span === 0 ? 50 : clamp01x100(((bars[i].close - ll) / span) * 100);
  }
  const k = clampSeries(smoothDense(raw, smoothK), 0, 100);
  const d = clampSeries(smoothDense(k, smoothD), 0, 100);
  return { k, d };
}

/** Pin a 0..100 oscillator inside its own range, absorbing rounding noise. */
function clamp01x100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Clamp every defined value of a sparse series into `[min, max]`. */
function clampSeries(series: Maybe[], min: number, max: number): Maybe[] {
  return series.map((v) => (v === null ? null : Math.max(min, Math.min(max, v))));
}

/** SMA over a sparse (null-padded) series, preserving alignment. */
function smoothDense(series: Maybe[], period: number): Maybe[] {
  if (period <= 1) return series;
  const first = series.findIndex((v) => v !== null);
  if (first < 0) return series;
  const dense = series.slice(first).map((v) => (v ?? 0) as number);
  const smoothed = sma(dense, period);
  const out: Maybe[] = nulls(series.length);
  for (let i = 0; i < smoothed.length; i++) out[first + i] = smoothed[i];
  return out;
}

/**
 * Session VWAP — cumulative typical-price × volume over volume, reset at each
 * session's open: the first bar of each trading day (`dayOf`; the UTC day when
 * the symbol has no session of its own). For FX that is 17:00 New York, where
 * TradingView resets it — 21:00 or 22:00 UTC, not midnight.
 *
 * VWAP without a session reset is a different (and far less useful) indicator:
 * it drifts toward the all-time mean and stops tracking the day's value area.
 */
export function vwap(bars: Ohlc[], dayOf: DayOf = utcDay): Maybe[] {
  return vwapRun(bars, { source: 'hlc3', periodOf: dayOf }).vwap;
}

/** Highest high / lowest low channel (Donchian). */
export function donchian(bars: Ohlc[], period = 20): BandsResult {
  const upper: Maybe[] = nulls(bars.length);
  const lower: Maybe[] = nulls(bars.length);
  const middle: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    upper[i] = hh;
    lower[i] = ll;
    middle[i] = (hh + ll) / 2;
  }
  return { upper, middle, lower };
}

/**
 * On-balance volume (`ta.obv`): the running sum of volume signed by the close's change. The first bar has no
 * change, so it is na, as on TradingView; the sum starts on the second.
 */
export function obv(bars: Ohlc[]): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  let running = 0;
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close;
    const p = bars[i - 1].close;
    running += gt(c, p) ? bars[i].volume : lt(c, p) ? -bars[i].volume : 0;
    out[i] = running;
  }
  return out;
}

/** Average Directional Index, with the +DI / -DI lines that produce it. */
export function adx(
  bars: Ohlc[],
  period = 14,
): { adx: Maybe[]; plusDi: Maybe[]; minusDi: Maybe[] } {
  const len = bars.length;
  if (len < 2) return { adx: nulls(len), plusDi: nulls(len), minusDi: nulls(len) };
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const tr = trueRange(bars).slice(1);
  const smTr = wilder(tr, period);
  const smPlus = wilder(plusDm, period);
  const smMinus = wilder(minusDm, period);

  const plusDi: Maybe[] = nulls(len);
  const minusDi: Maybe[] = nulls(len);
  const dx: Maybe[] = [];
  for (let i = 0; i < tr.length; i++) {
    const t = smTr[i];
    const p = smPlus[i];
    const m = smMinus[i];
    if (t === null || p === null || m === null || t === 0) {
      dx.push(null);
      continue;
    }
    const pd = (p / t) * 100;
    const md = (m / t) * 100;
    plusDi[i + 1] = pd;
    minusDi[i + 1] = md;
    const sum = pd + md;
    dx.push(sum === 0 ? 0 : (Math.abs(pd - md) / sum) * 100);
  }
  const firstDx = dx.findIndex((v) => v !== null);
  const out: Maybe[] = nulls(len);
  if (firstDx >= 0) {
    const dense = dx.slice(firstDx).map((v) => (v ?? 0) as number);
    const smoothed = wilder(dense, period);
    for (let i = 0; i < smoothed.length; i++) out[firstDx + i + 1] = smoothed[i];
  }
  return { adx: out, plusDi, minusDi };
}

// ── Second wave: the indicators TradingView ships that we were missing ──────

/** Momentum — close minus the close `period` bars ago. */
export function momentum(closes: number[], period = 10): Maybe[] {
  const out: Maybe[] = nulls(closes.length);
  for (let i = period; i < closes.length; i++) out[i] = closes[i] - closes[i - period];
  return out;
}

/** Rate of Change, as a percentage. */
export function roc(closes: number[], period = 9): Maybe[] {
  const out: Maybe[] = nulls(closes.length);
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period];
    out[i] = base === 0 ? null : ((closes[i] - base) / base) * 100;
  }
  return out;
}

/** Williams %R — where the close sits in the period's range, as -100..0. */
export function williamsR(bars: Ohlc[], period = 14): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const span = hh - ll;
    out[i] = span === 0 ? -50 : ((hh - bars[i].close) / span) * -100;
  }
  return out;
}

/**
 * Commodity Channel Index.
 *
 * The 0.015 constant is Lambert's, chosen so roughly 70-80% of values fall
 * within ±100 — it is not a tunable, and changing it silently redefines every
 * overbought/oversold reading.
 */
export function cci(bars: Ohlc[], period = 20): Maybe[] {
  return cciOf(
    bars.map((b) => (b.high + b.low + b.close) / 3),
    period,
  );
}

/** CCI of any source series (`ta.cci(source, length)`): Woodies CCI runs on the close. */
export function cciOf(source: number[], period = 20): Maybe[] {
  const avg = sma(source, period);
  const out: Maybe[] = nulls(source.length);
  for (let i = period - 1; i < source.length; i++) {
    const mean = avg[i];
    if (mean === null) continue;
    let deviation = 0;
    for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(source[j] - mean);
    const meanDeviation = deviation / period;
    out[i] = meanDeviation === 0 ? 0 : (source[i] - mean) / (0.015 * meanDeviation);
  }
  return out;
}

/**
 * Money Flow Index (`ta.mfi(hlc3, length)`) — RSI weighted by volume: the volume-weighted typical price of rising
 * bars against that of falling ones over `period` bars.
 *
 * Pine's definition decides a bar's side with `ta.change(src) <= 0` / `>= 0`, and on the first bar the change is
 * na, so neither test holds and that bar's flow counts on BOTH sides. That is what TradingView shows on bar
 * `period - 1`, and what this does.
 */
export function mfi(bars: Ohlc[], period = 14): Maybe[] {
  const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
  const up: Maybe[] = typical.map(
    (t, i) => bars[i].volume * (i > 0 && le(t - typical[i - 1], 0) ? 0 : t),
  );
  const down: Maybe[] = typical.map(
    (t, i) => bars[i].volume * (i > 0 && ge(t - typical[i - 1], 0) ? 0 : t),
  );
  const upper = sumNa(up, period);
  const lower = sumNa(down, period);
  return bars.map((_, i) => {
    const u = upper[i];
    const l = lower[i];
    if (u === null || l === null) return null;
    // Pine divides with `upper / lower`: na for a zero lower sum would make the result na; TradingView's
    // reading of "no falling flow" is 100, which is what 100 - 100 / (1 + ∞) gives.
    return l === 0 ? 100 : 100 - 100 / (1 + u / l);
  });
}

/** Awesome Oscillator — SMA(5) minus SMA(34) of the median price. */
export function awesome(bars: Ohlc[], fast = 5, slow = 34): Maybe[] {
  const median = bars.map((b) => (b.high + b.low) / 2);
  const f = sma(median, fast);
  const s = sma(median, slow);
  return bars.map((_, i) =>
    f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null,
  );
}

/** Keltner Channels — EMA basis with an ATR-scaled envelope. */
export function keltner(bars: Ohlc[], period = 20, mult = 2, atrPeriod = 10): BandsResult {
  const basis = ema(
    bars.map((b) => b.close),
    period,
  );
  const range = atr(bars, atrPeriod);
  const upper: Maybe[] = nulls(bars.length);
  const lower: Maybe[] = nulls(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const m = basis[i];
    const r = range[i];
    if (m === null || r === null) continue;
    upper[i] = m + mult * r;
    lower[i] = m - mult * r;
  }
  return { upper, middle: basis, lower };
}

/**
 * Parabolic SAR — `ta.sar(start, increment, maximum)`, ported from the engine's runtime (DR-09).
 *
 * Genuinely stateful: the acceleration factor ratchets up on each new extreme and resets on every flip. The order
 * of the steps is the definition: the SAR is advanced, THEN tested for a reversal against this bar's range (a
 * reversal puts it at the extreme of the trend that ended), and only then clamped to the prior two bars' lows
 * (highs). Clamping first — as this used to — moved the reversal to another bar. The trend is seeded on bar 1
 * from the first two closes, so bar 0 has no value.
 */
export function psar(bars: Ohlc[], start = 0.02, increment = 0.02, maximum = 0.2): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  let isBelow = false;
  let maxMin = NaN;
  let result = NaN;
  let acceleration = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const b1 = i >= 1 ? bars[i - 1] : null;
    const b2 = i >= 2 ? bars[i - 2] : null;
    let firstTrendBar = false;
    if (i === 1 && b1) {
      if (gt(b.close, b1.close)) {
        isBelow = true;
        maxMin = b.high;
        result = b1.low;
      } else {
        isBelow = false;
        maxMin = b.low;
        result = b1.high;
      }
      firstTrendBar = true;
      acceleration = start;
    }

    result = result + acceleration * (maxMin - result);

    if (isBelow) {
      if (gt(result, b.low)) {
        firstTrendBar = true;
        isBelow = false;
        result = Math.max(b.high, maxMin);
        maxMin = b.low;
        acceleration = start;
      }
    } else if (lt(result, b.high)) {
      firstTrendBar = true;
      isBelow = true;
      result = Math.min(b.low, maxMin);
      maxMin = b.high;
      acceleration = start;
    }

    if (!firstTrendBar) {
      if (isBelow) {
        if (gt(b.high, maxMin)) {
          maxMin = b.high;
          acceleration = Math.min(acceleration + increment, maximum);
        }
      } else if (lt(b.low, maxMin)) {
        maxMin = b.low;
        acceleration = Math.min(acceleration + increment, maximum);
      }
    }

    // Never inside the prior two bars' range: under the lows while below price, over the highs while above.
    if (isBelow) {
      result = Math.min(result, b1?.low ?? NaN);
      if (i > 1) result = Math.min(result, b2?.low ?? NaN);
    } else {
      result = Math.max(result, b1?.high ?? NaN);
      if (i > 1) result = Math.max(result, b2?.high ?? NaN);
    }
    out[i] = maybe(result);
  }
  return out;
}

export interface SuperTrendResult {
  /** The line while the trend is up (direction −1): the ratcheted lower band, under price. */
  up: Maybe[];
  /** The line while the trend is down (direction +1): the ratcheted upper band, over price. */
  down: Maybe[];
  /** Both together. */
  line: Maybe[];
  /** Pine's direction: −1 up, +1 down. */
  direction: Maybe[];
}

/**
 * SuperTrend — `ta.supertrend(factor, atrPeriod)`, ported from the engine's runtime (DR-08).
 *
 * Each band RATCHETS: the lower band only rises (unless the previous close fell through it) and the upper band
 * only falls, so on a flip the line moves to the band carried from the bars before — not to that bar's raw
 * opposite band, which made the old line jump. The trend starts DOWN on the first bar with an ATR, as Pine's does.
 * Up and down are separate series so they draw in two colours and never join across a flip; the warm-up bars are
 * na (Pine's own reference implementation leaves its nz() seed, 0, on bar 0).
 */
export function superTrend(bars: Ohlc[], period = 10, factor = 3): SuperTrendResult {
  const n = bars.length;
  const range = atr(bars, period);
  const r: SuperTrendResult = { up: nulls(n), down: nulls(n), line: nulls(n), direction: nulls(n) };
  let prevLower = NaN;
  let prevUpper = NaN;
  let prevSt = NaN;
  let prevAtr = NaN;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const a = toNum(range[i]);
    const src = (b.high + b.low) / 2;
    let upper = src + factor * a;
    let lower = src - factor * a;
    const pLower = Number.isNaN(prevLower) ? 0 : prevLower; // nz(lowerBand[1])
    const pUpper = Number.isNaN(prevUpper) ? 0 : prevUpper; // nz(upperBand[1])
    const prevClose = i > 0 ? bars[i - 1].close : NaN;
    lower = gt(lower, pLower) || lt(prevClose, pLower) ? lower : pLower;
    upper = lt(upper, pUpper) || gt(prevClose, pUpper) ? upper : pUpper;
    let dir: number;
    if (Number.isNaN(prevAtr)) dir = 1;
    else if (eq(prevSt, pUpper)) dir = gt(b.close, upper) ? -1 : 1;
    else dir = lt(b.close, lower) ? 1 : -1;
    const st = dir === -1 ? lower : upper;
    prevLower = lower;
    prevUpper = upper;
    prevSt = st;
    prevAtr = a;
    if (range[i] === null) continue;
    r.line[i] = st;
    r.direction[i] = dir;
    if (dir < 0) r.up[i] = st;
    else r.down[i] = st;
  }
  return r;
}

export interface IchimokuResult {
  conversion: Maybe[];
  base: Maybe[];
  /** The leading spans on the chart's bars: the cloud under each bar. */
  spanA: Maybe[];
  spanB: Maybe[];
  lagging: Maybe[];
  /** The leading spans past the last bar, one per bar ahead (`displacement - 1` of them): the cloud to come. */
  spanAAhead: Maybe[];
  spanBAhead: Maybe[];
}

/**
 * Ichimoku Cloud, as TradingView plots it (DR-11).
 *
 * The leading spans are plotted FORWARD and the lagging span BACKWARD — that shift is the indicator, not a
 * presentation detail — by `displacement - 1` bars: TradingView's built-in plots with `offset = displacement - 1`
 * (25 for the default 26), so the cloud under a bar is the one computed 25 bars earlier. The spans' values that
 * land past the last bar are the cloud ahead of price, returned in `spanAAhead` / `spanBAhead` rather than
 * dropped.
 */
export function ichimoku(
  bars: Ohlc[],
  conversionPeriod = 9,
  basePeriod = 26,
  spanBPeriod = 52,
  displacement = 26,
): IchimokuResult {
  const midpoint = (period: number): Maybe[] => {
    const out: Maybe[] = nulls(bars.length);
    for (let i = period - 1; i < bars.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        hh = Math.max(hh, bars[j].high);
        ll = Math.min(ll, bars[j].low);
      }
      out[i] = (hh + ll) / 2;
    }
    return out;
  };

  const conversion = midpoint(conversionPeriod);
  const base = midpoint(basePeriod);
  const rawSpanA: Maybe[] = bars.map((_, i) =>
    conversion[i] !== null && base[i] !== null
      ? ((conversion[i] as number) + (base[i] as number)) / 2
      : null,
  );
  const rawSpanB = midpoint(spanBPeriod);

  const shift = (series: Maybe[], by: number): Maybe[] => {
    const out: Maybe[] = nulls(series.length);
    for (let i = 0; i < series.length; i++) {
      const target = i + by;
      if (target >= 0 && target < series.length) out[target] = series[i];
    }
    return out;
  };

  const by = Math.max(0, displacement - 1);
  // A leading span's value of bar i lands on bar i + by; those past the last bar are the cloud ahead.
  const n = bars.length;
  const ahead = (series: Maybe[]): Maybe[] => {
    const out = nulls(by);
    for (let i = Math.max(0, n - by); i < n; i++) out[i + by - n] = series[i];
    return out;
  };
  return {
    conversion,
    base,
    spanA: shift(rawSpanA, by),
    spanB: shift(rawSpanB, by),
    lagging: shift(
      bars.map((b) => b.close as Maybe),
      -by,
    ),
    spanAAhead: by > 0 ? ahead(rawSpanA) : [],
    spanBAhead: by > 0 ? ahead(rawSpanB) : [],
  };
}

export interface PivotResult {
  pivot: Maybe[];
  r1: Maybe[];
  r2: Maybe[];
  s1: Maybe[];
  s2: Maybe[];
}

/**
 * Classic daily pivot points, carried across each session.
 *
 * Computed from the PREVIOUS trading day's high/low/close (`dayOf`: the FX day
 * that rolls at 17:00 New York; the UTC day without a session) and held flat
 * through the current day — a pivot that recomputed intrabar would not be a
 * pivot.
 */
export function pivotPoints(bars: Ohlc[], dayOf: DayOf = utcDay): PivotResult {
  const n = bars.length;
  const result: PivotResult = {
    pivot: nulls(n),
    r1: nulls(n),
    r2: nulls(n),
    s1: nulls(n),
    s2: nulls(n),
  };
  let day = -1;
  let prev: { high: number; low: number; close: number } | null = null;
  let current: { high: number; low: number; close: number } | null = null;

  for (let i = 0; i < n; i++) {
    const d = dayOf(bars[i].time);
    if (d !== day) {
      prev = current;
      current = { high: bars[i].high, low: bars[i].low, close: bars[i].close };
      day = d;
    } else if (current) {
      current.high = Math.max(current.high, bars[i].high);
      current.low = Math.min(current.low, bars[i].low);
      current.close = bars[i].close;
    }
    if (!prev) continue;
    const p = (prev.high + prev.low + prev.close) / 3;
    const span = prev.high - prev.low;
    result.pivot[i] = p;
    result.r1[i] = 2 * p - prev.low;
    result.s1[i] = 2 * p - prev.high;
    result.r2[i] = p + span;
    result.s2[i] = p - span;
  }
  return result;
}

// ── Third wave ─────────────────────────────────────────────────────────────

/** Smoothed (Wilder/RMA) moving average — exposed because several studies want it. */
export function smma(values: number[], period: number): Maybe[] {
  return wilder(values, period);
}

/**
 * Hull moving average — `ta.hma`: WMA of (2·WMA(n/2) − WMA(n)) over √n, with the lengths TRUNCATED as Pine's
 * integer division and floor do (DR-10): HMA(9) is WMA(4) and WMA(9), smoothed by WMA(3). Rounding n/2 made it
 * WMA(5) — a different average, and the Technicals HMA vote inherited it.
 */
export function hma(values: number[], period = 9): Maybe[] {
  const half = Math.max(1, Math.floor(period / 2));
  const sqrt = Math.max(1, Math.floor(Math.sqrt(period)));
  const a = wma(values, half);
  const b = wma(values, period);
  const raw: Maybe[] = values.map((_, i) =>
    a[i] !== null && b[i] !== null ? 2 * (a[i] as number) - (b[i] as number) : null,
  );
  return denseMap(raw, (dense) => wma(dense, sqrt));
}

/**
 * Run a dense transform over the defined region of a sparse series and write
 * it back at the right offset.
 *
 * Feeding warm-up nulls into a recursive average poisons its seed and shifts
 * every later value — the same trap MACD's signal line has.
 */
function denseMap(series: Maybe[], fn: (dense: number[]) => Maybe[]): Maybe[] {
  const first = series.findIndex((v) => v !== null);
  const out: Maybe[] = nulls(series.length);
  if (first < 0) return out;
  const dense = series.slice(first).map((v) => (v ?? 0) as number);
  const result = fn(dense);
  for (let i = 0; i < result.length; i++) out[first + i] = result[i];
  return out;
}

/** Double EMA — 2·EMA − EMA(EMA). */
export function dema(values: number[], period = 20): Maybe[] {
  const e1 = ema(values, period);
  const e2 = denseMap(e1, (d) => ema(d, period));
  return values.map((_, i) =>
    e1[i] !== null && e2[i] !== null ? 2 * (e1[i] as number) - (e2[i] as number) : null,
  );
}

/** Triple EMA — 3·EMA − 3·EMA² + EMA³. */
export function tema(values: number[], period = 20): Maybe[] {
  const e1 = ema(values, period);
  const e2 = denseMap(e1, (d) => ema(d, period));
  const e3 = denseMap(e2, (d) => ema(d, period));
  return values.map((_, i) =>
    e1[i] !== null && e2[i] !== null && e3[i] !== null
      ? 3 * (e1[i] as number) - 3 * (e2[i] as number) + (e3[i] as number)
      : null,
  );
}

/** Arnaud Legoux MA — Gaussian window offset toward the recent end. */
export function alma(values: number[], period = 9, offset = 0.85, sigma = 6): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  if (period <= 0 || values.length < period) return out;
  const m = offset * (period - 1);
  const s = period / sigma;
  const weights: number[] = [];
  let norm = 0;
  for (let i = 0; i < period; i++) {
    const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
    weights.push(w);
    norm += w;
  }
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - period + 1 + j] * weights[j];
    out[i] = acc / norm;
  }
  return out;
}

/** Volume-weighted moving average. */
export function vwma(bars: Ohlc[], period = 20): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let pv = 0;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pv += bars[j].close * bars[j].volume;
      v += bars[j].volume;
    }
    out[i] = v === 0 ? null : pv / v;
  }
  return out;
}

/** Linear-regression value at each bar (the endpoint of the fitted line). */
export function linreg(values: number[], period = 14): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  if (period < 2) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let j = 0; j < period; j++) {
      const x = j;
      const y = values[i - period + 1 + j];
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    }
    const denom = period * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (period * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / period;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}

/** Percentage envelope around an MA. */
export function envelope(values: number[], period = 20, percent = 2): BandsResult {
  const middle = sma(values, period);
  const k = percent / 100;
  return {
    middle,
    upper: middle.map((m) => (m === null ? null : m * (1 + k))),
    lower: middle.map((m) => (m === null ? null : m * (1 - k))),
  };
}

/** Aroon up/down — how recently the period's high and low occurred. */
export function aroon(bars: Ohlc[], period = 14): { up: Maybe[]; down: Maybe[] } {
  const up: Maybe[] = nulls(bars.length);
  const down: Maybe[] = nulls(bars.length);
  for (let i = period; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let hiAt = i;
    let loAt = i;
    for (let j = i - period; j <= i; j++) {
      if (bars[j].high >= hi) {
        hi = bars[j].high;
        hiAt = j;
      }
      if (bars[j].low <= lo) {
        lo = bars[j].low;
        loAt = j;
      }
    }
    up[i] = ((period - (i - hiAt)) / period) * 100;
    down[i] = ((period - (i - loAt)) / period) * 100;
  }
  return { up, down };
}

/**
 * TRIX, as TradingView's built-in computes it: 10000 × the one-bar change of the triple EMA of ln(source). (The
 * rate of change of a triple EMA of the price itself, in percent, is the same idea 100 times smaller — which is
 * what this plotted before.)
 */
export function trix(values: number[], period = 18): Maybe[] {
  const e1 = ema(
    values.map((v) => Math.log(v)),
    period,
  );
  const e2 = denseMap(e1, (d) => ema(d, period));
  const e3 = denseMap(e2, (d) => ema(d, period));
  const out: Maybe[] = nulls(values.length);
  for (let i = 1; i < values.length; i++) {
    const now = e3[i];
    const prev = e3[i - 1];
    if (now === null || prev === null) continue;
    out[i] = 10000 * (now - prev);
  }
  return out;
}

/**
 * Detrended Price Oscillator, as TradingView plots it by default (not centred): the source minus its SMA of
 * `period` bars, taken `period / 2 + 1` bars back. It used to read the average from TEN BARS AHEAD (and fall back
 * to the current one at the right edge) — a look-ahead that put tomorrow's average into today's value.
 */
export function dpo(values: number[], period = 21): Maybe[] {
  const shift = Math.floor(period / 2) + 1;
  const avg = sma(values, period);
  const out: Maybe[] = nulls(values.length);
  for (let i = shift; i < values.length; i++) {
    const a = avg[i - shift];
    if (a === null) continue;
    out[i] = values[i] - a;
  }
  return out;
}

/** Ultimate Oscillator — buying pressure over three weighted lookbacks. */
export function ultimate(bars: Ohlc[], p1 = 7, p2 = 14, p3 = 28): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  const bp: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const low = Math.min(bars[i].low, prevClose);
    bp.push(bars[i].close - low);
    tr.push(Math.max(bars[i].high, prevClose) - low);
  }
  const windowSum = (arr: number[], end: number, n: number): number => {
    let acc = 0;
    for (let i = end - n + 1; i <= end; i++) acc += arr[i];
    return acc;
  };
  for (let i = p3 - 1; i < bp.length; i++) {
    const t1 = windowSum(tr, i, p1);
    const t2 = windowSum(tr, i, p2);
    const t3 = windowSum(tr, i, p3);
    if (t1 === 0 || t2 === 0 || t3 === 0) continue;
    const a1 = windowSum(bp, i, p1) / t1;
    const a2 = windowSum(bp, i, p2) / t2;
    const a3 = windowSum(bp, i, p3) / t3;
    out[i + 1] = ((4 * a1 + 2 * a2 + a3) / 7) * 100;
  }
  return out;
}

/** Chaikin Money Flow — volume weighted by where the close sat in the bar. */
export function cmf(bars: Ohlc[], period = 20): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let mfv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const span = bars[j].high - bars[j].low;
      const multiplier =
        span === 0 ? 0 : (bars[j].close - bars[j].low - (bars[j].high - bars[j].close)) / span;
      mfv += multiplier * bars[j].volume;
      vol += bars[j].volume;
    }
    out[i] = vol === 0 ? 0 : mfv / vol;
  }
  return out;
}

/** Accumulation/Distribution line. */
export function adl(bars: Ohlc[]): Maybe[] {
  const out: Maybe[] = [];
  let running = 0;
  for (const b of bars) {
    const span = b.high - b.low;
    const multiplier = span === 0 ? 0 : (b.close - b.low - (b.high - b.close)) / span;
    running += multiplier * b.volume;
    out.push(running);
  }
  return out;
}

/** Chaikin Oscillator — EMA(3) minus EMA(10) of the A/D line. */
export function chaikinOscillator(bars: Ohlc[], fast = 3, slow = 10): Maybe[] {
  const line = adl(bars).map((v) => (v ?? 0) as number);
  const f = ema(line, fast);
  const s = ema(line, slow);
  return bars.map((_, i) =>
    f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null,
  );
}

/**
 * Elder's Force Index (TradingView): EMA of the close's change × volume. The first bar has no change and is not
 * part of the average (it used to enter as a 0 and pull the seed toward zero).
 */
export function forceIndex(bars: Ohlc[], period = 13): Maybe[] {
  const raw: Maybe[] = bars.map((b, i) =>
    i === 0 ? null : (b.close - bars[i - 1].close) * b.volume,
  );
  return emaNa(raw, period);
}

/** Elder Ray bull and bear power, relative to an EMA. */
export function elderRay(bars: Ohlc[], period = 13): { bull: Maybe[]; bear: Maybe[] } {
  const basis = ema(
    bars.map((b) => b.close),
    period,
  );
  return {
    bull: bars.map((b, i) => (basis[i] === null ? null : b.high - (basis[i] as number))),
    bear: bars.map((b, i) => (basis[i] === null ? null : b.low - (basis[i] as number))),
  };
}

/** Balance of Power — close-open over the bar's range. */
export function balanceOfPower(bars: Ohlc[], period = 14): Maybe[] {
  const raw = bars.map((b) => {
    const span = b.high - b.low;
    return span === 0 ? 0 : (b.close - b.open) / span;
  });
  return sma(raw, period);
}

/**
 * Ease of Movement, as TradingView's built-in: the SMA of 10000 × change(hl2) × (high − low) / volume. A bar
 * without volume (or the first bar, without a change) has no value and is skipped, not counted as 0. (This used a
 * divisor of 1e8 — values 10,000 times TradingView's.)
 */
export function easeOfMovement(bars: Ohlc[], period = 14, divisor = 10000): Maybe[] {
  const raw: Maybe[] = bars.map((b, i) => {
    if (i === 0 || b.volume === 0) return null;
    const change = (b.high + b.low) / 2 - (bars[i - 1].high + bars[i - 1].low) / 2;
    return (divisor * change * (b.high - b.low)) / b.volume;
  });
  return smaNa(raw, period);
}

/** Price Volume Trend (`ta.pvt`): volume × the close's relative change, summed. The first bar (no change) is na. */
export function pvt(bars: Ohlc[]): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  let running = 0;
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    if (prevClose !== 0) running += ((bars[i].close - prevClose) / prevClose) * bars[i].volume;
    out[i] = running;
  }
  return out;
}

/** Mass Index — range expansion via a ratio of EMAs. */
export function massIndex(bars: Ohlc[], period = 25, emaPeriod = 9): Maybe[] {
  const range = bars.map((b) => b.high - b.low);
  const e1 = ema(range, emaPeriod);
  const e2 = denseMap(e1, (d) => ema(d, emaPeriod));
  const ratio: Maybe[] = bars.map((_, i) =>
    e1[i] !== null && e2[i] !== null && (e2[i] as number) !== 0
      ? (e1[i] as number) / (e2[i] as number)
      : null,
  );
  const out: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let acc = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (ratio[j] === null) {
        ok = false;
        break;
      }
      acc += ratio[j] as number;
    }
    if (ok) out[i] = acc;
  }
  return out;
}

/** Choppiness Index — 100 means pure chop, 0 means pure trend. */
export function choppiness(bars: Ohlc[], period = 14): Maybe[] {
  const tr = trueRange(bars);
  const out: Maybe[] = nulls(bars.length);
  const log10Period = Math.log10(period);
  for (let i = period - 1; i < bars.length; i++) {
    let sumTr = 0;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      sumTr += tr[j];
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const span = hh - ll;
    if (span <= 0 || sumTr <= 0) continue;
    out[i] = (100 * Math.log10(sumTr / span)) / log10Period;
  }
  return out;
}

/** Vortex indicator. */
export function vortex(bars: Ohlc[], period = 14): { plus: Maybe[]; minus: Maybe[] } {
  const plus: Maybe[] = nulls(bars.length);
  const minus: Maybe[] = nulls(bars.length);
  const tr = trueRange(bars);
  for (let i = period; i < bars.length; i++) {
    let vmPlus = 0;
    let vmMinus = 0;
    let sumTr = 0;
    for (let j = i - period + 1; j <= i; j++) {
      vmPlus += Math.abs(bars[j].high - bars[j - 1].low);
      vmMinus += Math.abs(bars[j].low - bars[j - 1].high);
      sumTr += tr[j];
    }
    if (sumTr === 0) continue;
    plus[i] = vmPlus / sumTr;
    minus[i] = vmMinus / sumTr;
  }
  return { plus, minus };
}

/**
 * Historical volatility — the annualised standard deviation of log returns, in percent (DR-12).
 *
 * Annualised by the bars a year holds AT THIS INTERVAL ({@link barsPerYear}): it used to assume 6,240 bars a year
 * on every timeframe (right for H1 only — ~4.9× too high on D1, ~3.5× too low on M5). The deviation is the
 * population one, as `ta.stdev` (TradingView's own HV multiplies by √365 on every intraday chart; the chart's
 * scaling is the honest annualisation).
 */
export function historicalVolatility(bars: Ohlc[], period = 20, barsPerYearCount = 6240): Maybe[] {
  const returns: Maybe[] = bars.map((b, i) =>
    i === 0 || bars[i - 1].close <= 0 ? null : Math.log(b.close / bars[i - 1].close),
  );
  const sd = stdevNa(returns, period);
  const scale = Math.sqrt(barsPerYearCount);
  return sd.map((v) => (v === null ? null : 100 * v * scale));
}

/** Population deviation of the last `period` values that are not na (`ta.stdev` with gaps). */
function stdevNa(series: readonly Maybe[], period: number): Maybe[] {
  const out: Maybe[] = nulls(series.length);
  if (period < 1) return out;
  const window: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    if (x !== null && x !== undefined && !Number.isNaN(x)) {
      window.push(x);
      if (window.length > period) window.shift();
    }
    if (window.length < period) continue;
    let sum = 0;
    for (const v of window) sum += v;
    const mean = sum / period;
    let sq = 0;
    for (const v of window) sq += (v - mean) ** 2;
    out[i] = Math.sqrt(Math.max(0, sq) / period);
  }
  return out;
}

/**
 * Bars a year holds at `intervalMs` (Historical Volatility's annualisation): `tradingDaysPerYear` trading days
 * (260 for a market that trades five days a week — FX; 365 for one that never closes) of 24-hour sessions below a
 * day, that many daily bars, 52 weekly and 12 monthly. H1 FX: 260 × 24 = 6,240.
 */
export function barsPerYear(intervalMs: number, tradingDaysPerYear = 260): number {
  const day = 86_400_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return tradingDaysPerYear * 24;
  if (intervalMs >= 28 * day) return 12;
  if (intervalMs >= 7 * day) return (52 * 7 * day) / intervalMs;
  return (tradingDaysPerYear * day) / intervalMs;
}

/**
 * The interval of `bars` in ms when the caller does not say: the median gap between consecutive bars, so a weekend
 * or a holiday gap does not count.
 */
export function inferBarInterval(bars: readonly Ohlc[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < bars.length && gaps.length < 500; i++) {
    const g = bars[i].time - bars[i - 1].time;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 3_600_000;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Stochastic RSI — the stochastic oscillator applied to RSI. */
export function stochRsi(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  smoothK = 3,
  smoothD = 3,
): StochasticResult {
  const r = rsi(closes, rsiPeriod);
  const raw: Maybe[] = nulls(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (r[i] === null) continue;
    let hh = -Infinity;
    let ll = Infinity;
    let ok = true;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (j < 0 || r[j] === null) {
        ok = false;
        break;
      }
      hh = Math.max(hh, r[j] as number);
      ll = Math.min(ll, r[j] as number);
    }
    if (!ok) continue;
    const span = hh - ll;
    // Clamped because the subtraction leaves floating-point noise: an
    // unclamped %K can land at -7e-15, which is a value below the pane's own
    // 0 line on a 0..100 oscillator.
    raw[i] = span === 0 ? 50 : clamp01x100((((r[i] as number) - ll) / span) * 100);
  }
  // Clamped AFTER smoothing as well as before. `sma` keeps a rolling sum
  // (`sum += new; sum -= old`), which accumulates floating-point drift, so an
  // average of values that are all exactly 0 can come out at -7e-15. On an
  // unbounded study that is invisible; on a 0..100 oscillator it is a reading
  // below the pane's own floor.
  const k = clampSeries(
    denseMap(raw, (d) => sma(d, smoothK)),
    0,
    100,
  );
  const d = clampSeries(
    denseMap(k, (dd) => sma(dd, smoothD)),
    0,
    100,
  );
  return { k, d };
}

/**
 * Fisher Transform, as TradingView's built-in: the bar's median (hl2) placed within the highest and lowest hl2 of
 * `period` bars, smoothed (0.66 × (x − 0.5) + 0.67 × previous, pinned to ±0.999 beyond ±0.99 — and the pinned
 * value is what the next bar smooths from), then 0.5·ln((1 + v) / (1 − v)) plus half the previous Fisher. The
 * trigger is the previous bar's Fisher (na on the first). This used the bars' high/low range, a different
 * normalisation (2x − 1), and clamped without feeding the clamp back.
 */
export function fisher(bars: Ohlc[], period = 9): { fisher: Maybe[]; trigger: Maybe[] } {
  const hl2 = bars.map((b) => (b.high + b.low) / 2);
  const hi = extremeNa(hl2, period, true);
  const lo = extremeNa(hl2, period, false);
  const out: Maybe[] = nulls(bars.length);
  const trigger: Maybe[] = nulls(bars.length);
  const pin = (v: number): number => (gt(v, 0.99) ? 0.999 : lt(v, -0.99) ? -0.999 : v);
  let value = NaN;
  let fish = NaN;
  for (let i = 0; i < bars.length; i++) {
    const h = toNum(hi[i]);
    const l = toNum(lo[i]);
    const ratio = h === l ? NaN : (hl2[i] - l) / (h - l);
    const prevFish = fish;
    value = pin(0.66 * (ratio - 0.5) + 0.67 * (Number.isNaN(value) ? 0 : value));
    fish =
      0.5 * Math.log((1 + value) / (1 - value)) + 0.5 * (Number.isNaN(prevFish) ? 0 : prevFish);
    out[i] = maybe(fish);
    trigger[i] = maybe(prevFish);
  }
  return { fisher: out, trigger };
}

export interface VolumeProfileBin {
  price: number;
  volume: number;
  /** Share of `volume` from bars that closed at or above their open. */
  up: number;
  /** Share of `volume` from bars that closed below their open. */
  down: number;
}

/**
 * Volume profile — volume distributed across price bins, as bins rather than a per-bar series because it is a
 * HORIZONTAL histogram. The profile engine's one implementation ({@link profileVolume}, DR-19): each bar's volume
 * spread over the bins its range covers in proportion to the overlap, up or down by the bar's own direction (the
 * OHLCV convention TradingView uses for its profiles when there is no aggressor tape, which FX never has).
 */
export function volumeProfile(bars: Ohlc[], bins = 24): VolumeProfileBin[] {
  if (bins <= 0) return [];
  const p = profileVolume(bars, { rows: bins });
  if (!p) return [];
  return p.rows.map((r) => ({
    price: (r.priceLow + r.priceHigh) / 2,
    volume: r.upVol + r.downVol,
    up: r.upVol,
    down: r.downVol,
  }));
}

// ── Fourth wave ────────────────────────────────────────────────────────────

/** Know Sure Thing — four smoothed ROCs, weighted. */
export function kst(closes: number[]): { kst: Maybe[]; signal: Maybe[] } {
  const parts: Array<[number, number, number]> = [
    [10, 10, 1],
    [15, 10, 2],
    [20, 10, 3],
    [30, 15, 4],
  ];
  const out: Maybe[] = nulls(closes.length);
  const smoothed = parts.map(([rocLen, smaLen]) =>
    denseMap(roc(closes, rocLen), (d) => sma(d, smaLen)),
  );
  for (let i = 0; i < closes.length; i++) {
    let acc = 0;
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      const v = smoothed[k][i];
      if (v === null) {
        ok = false;
        break;
      }
      acc += v * parts[k][2];
    }
    if (ok) out[i] = acc;
  }
  return { kst: out, signal: denseMap(out, (d) => sma(d, 9)) };
}

/** Coppock Curve — WMA of two summed ROCs. Long-horizon bottoming signal. */
export function coppock(closes: number[], roc1 = 14, roc2 = 11, wmaLen = 10): Maybe[] {
  const a = roc(closes, roc1);
  const b = roc(closes, roc2);
  const summed: Maybe[] = closes.map((_, i) =>
    a[i] !== null && b[i] !== null ? (a[i] as number) + (b[i] as number) : null,
  );
  return denseMap(summed, (d) => wma(d, wmaLen));
}

/**
 * Relative Vigor Index, as TradingView's built-in: the sum over `period` bars of the symmetrically weighted
 * (1-2-2-1) close − open, over the same of high − low, with the SWMA of that as the signal. (This used unweighted
 * averages and a 4-bar SMA signal.)
 */
export function rvi(bars: Ohlc[], period = 10): { rvi: Maybe[]; signal: Maybe[] } {
  const numerator = sumNa(swma(bars.map((b) => b.close - b.open)), period);
  const denominator = sumNa(swma(bars.map((b) => b.high - b.low)), period);
  const line: Maybe[] = bars.map((_, i) => {
    const n = numerator[i];
    const d = denominator[i];
    return n === null || d === null || d === 0 ? null : n / d;
  });
  return { rvi: line, signal: swma(line) };
}

/** Percentage Price Oscillator — MACD expressed as a percentage. */
export function ppo(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { ppo: Maybe[]; signal: Maybe[]; histogram: Maybe[] } {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line: Maybe[] = closes.map((_, i) =>
    f[i] !== null && s[i] !== null && (s[i] as number) !== 0
      ? (((f[i] as number) - (s[i] as number)) / (s[i] as number)) * 100
      : null,
  );
  const signal = denseMap(line, (d) => ema(d, signalPeriod));
  return {
    ppo: line,
    signal,
    histogram: closes.map((_, i) =>
      line[i] !== null && signal[i] !== null ? (line[i] as number) - (signal[i] as number) : null,
    ),
  };
}

/** Volume oscillator — the gap between two volume EMAs, as a percentage. */
export function volumeOscillator(bars: Ohlc[], fast = 5, slow = 10): Maybe[] {
  const volumes = bars.map((b) => b.volume);
  const f = ema(volumes, fast);
  const s = ema(volumes, slow);
  return bars.map((_, i) =>
    f[i] !== null && s[i] !== null && (s[i] as number) !== 0
      ? (((f[i] as number) - (s[i] as number)) / (s[i] as number)) * 100
      : null,
  );
}

/** Negative and positive volume indices. */
export function volumeIndices(bars: Ohlc[]): { nvi: Maybe[]; pvi: Maybe[] } {
  const nvi: Maybe[] = [1000];
  const pvi: Maybe[] = [1000];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const change = prevClose === 0 ? 0 : (bars[i].close - prevClose) / prevClose;
    const lastNvi = (nvi[i - 1] ?? 1000) as number;
    const lastPvi = (pvi[i - 1] ?? 1000) as number;
    nvi.push(bars[i].volume < bars[i - 1].volume ? lastNvi * (1 + change) : lastNvi);
    pvi.push(bars[i].volume > bars[i - 1].volume ? lastPvi * (1 + change) : lastPvi);
  }
  return { nvi, pvi };
}

/**
 * Standard-error bands — a regression curve with a ±k·SE envelope.
 *
 * The residual at each point is measured against the FITTED LINE AT THAT POINT,
 * not against the regression's endpoint value. Using the endpoint for the whole
 * window measures the window's slope rather than its scatter: a perfectly
 * straight series has zero error but would have produced bands as wide as the
 * move. The regression is therefore recomputed here rather than reusing
 * `linreg`, which by design returns only the endpoint.
 */
export function standardErrorBands(closes: number[], period = 21, mult = 2): BandsResult {
  const middle = linreg(closes, period);
  const upper: Maybe[] = nulls(closes.length);
  const lower: Maybe[] = nulls(closes.length);
  if (period < 3) return { upper, middle, lower };

  for (let i = period - 1; i < closes.length; i++) {
    const fit = middle[i];
    if (fit === null) continue;

    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < period; k++) {
      const y = closes[i - period + 1 + k];
      sx += k;
      sy += y;
      sxy += k * y;
      sxx += k * k;
    }
    const denom = period * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (period * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / period;

    let sumSq = 0;
    for (let k = 0; k < period; k++) {
      const predicted = intercept + slope * k;
      sumSq += (closes[i - period + 1 + k] - predicted) ** 2;
    }
    const se = Math.sqrt(sumSq / (period - 2));
    upper[i] = fit + mult * se;
    lower[i] = fit - mult * se;
  }
  return { upper, middle, lower };
}

/** Schaff Trend Cycle — a stochastic applied twice to MACD. */
export function schaff(closes: number[], fast = 23, slow = 50, cycle = 10): Maybe[] {
  const macdLine = macd(closes, fast, slow, 9).macd;
  const stochOf = (series: Maybe[]): Maybe[] => {
    const out: Maybe[] = nulls(series.length);
    for (let i = 0; i < series.length; i++) {
      if (series[i] === null) continue;
      let hi = -Infinity;
      let lo = Infinity;
      let ok = true;
      for (let j = i - cycle + 1; j <= i; j++) {
        if (j < 0 || series[j] === null) {
          ok = false;
          break;
        }
        hi = Math.max(hi, series[j] as number);
        lo = Math.min(lo, series[j] as number);
      }
      if (!ok) continue;
      const span = hi - lo;
      out[i] = span === 0 ? 50 : clamp01x100((((series[i] as number) - lo) / span) * 100);
    }
    return out;
  };
  // Twice: the first pass normalises MACD, the second sharpens the cycle. One
  // pass is just a stochastic of MACD and oscillates far more.
  return clampSeries(stochOf(stochOf(macdLine)), 0, 100);
}

export interface AlligatorResult {
  jaw: Maybe[];
  teeth: Maybe[];
  lips: Maybe[];
  /** Each line's values past the last bar (8, 5 and 3 of them): the forward shift is the indicator. */
  jawAhead: Maybe[];
  teethAhead: Maybe[];
  lipsAhead: Maybe[];
}

/** Williams Alligator — three smoothed averages of hl2, shifted forward 8, 5 and 3 bars (TradingView's). */
export function alligator(bars: Ohlc[]): AlligatorResult {
  const n = bars.length;
  const median = bars.map((b) => (b.high + b.low) / 2);
  const shift = (series: Maybe[], by: number): { on: Maybe[]; ahead: Maybe[] } => {
    const on: Maybe[] = nulls(n);
    const ahead: Maybe[] = nulls(by);
    for (let i = 0; i < n; i++) {
      const target = i + by;
      if (target < n) on[target] = series[i];
      else ahead[target - n] = series[i];
    }
    return { on, ahead };
  };
  const jaw = shift(smma(median, 13), 8);
  const teeth = shift(smma(median, 8), 5);
  const lips = shift(smma(median, 5), 3);
  return {
    jaw: jaw.on,
    teeth: teeth.on,
    lips: lips.on,
    jawAhead: jaw.ahead,
    teethAhead: teeth.ahead,
    lipsAhead: lips.ahead,
  };
}

/** Bollinger %B — where price sits within the bands, 0..1. */
export function percentB(closes: number[], period = 20, mult = 2): Maybe[] {
  const { upper, lower } = bollinger(closes, period, mult);
  return closes.map((c, i) => {
    const u = upper[i];
    const l = lower[i];
    if (u === null || l === null || u === l) return null;
    return (c - l) / (u - l);
  });
}

/** Bollinger BandWidth (`ta.bbw`): the band span as a PERCENTAGE of the basis, as TradingView plots it. */
export function bandwidth(closes: number[], period = 20, mult = 2): Maybe[] {
  const { upper, middle, lower } = bollinger(closes, period, mult);
  return closes.map((_, i) => {
    const u = upper[i];
    const m = middle[i];
    const l = lower[i];
    if (u === null || m === null || l === null || m === 0) return null;
    return ((u - l) / m) * 100;
  });
}

/**
 * Chande Momentum Oscillator — (up − down) / (up + down) over the period.
 *
 * Unlike RSI this uses raw sums rather than Wilder smoothing, so it swings
 * harder and reaches the extremes RSI rarely touches. That is the point of
 * having both.
 */
export function cmo(closes: number[], period = 9): Maybe[] {
  const out: Maybe[] = nulls(closes.length);
  if (closes.length <= period) return out;
  for (let i = period; i < closes.length; i++) {
    let up = 0;
    let down = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const d = closes[k] - closes[k - 1];
      if (d > 0) up += d;
      else down -= d;
    }
    const denom = up + down;
    // A period with no movement at all is 0 momentum, not a divide by zero.
    out[i] = denom === 0 ? 0 : ((up - down) / denom) * 100;
  }
  return out;
}

/**
 * Connors RSI — the average of three components: a short RSI of price, an RSI
 * of the current up/down STREAK, and the percent-rank of the latest return.
 *
 * The streak term is what makes it different from RSI: it measures how long a
 * run has persisted, not just how far price moved.
 */
export function connorsRsi(closes: number[], rsiLen = 3, streakLen = 2, rankLen = 100): Maybe[] {
  const n = closes.length;
  const priceRsi = rsi(closes, rsiLen);

  // Signed run length (TradingView's `updown`): +3 means three consecutive up closes. The first bar has no
  // previous close, so Pine's tests (`s == s[1]`, `s > s[1]`) are both false and it starts at −1.
  const streaks: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? streaks[i - 1] : 0;
    const c = closes[i];
    const p = i > 0 ? closes[i - 1] : NaN;
    if (eq(c, p)) streaks[i] = 0;
    else if (gt(c, p)) streaks[i] = prev <= 0 ? 1 : prev + 1;
    else streaks[i] = prev >= 0 ? -1 : prev - 1;
  }
  const streakRsi = rsi(streaks, streakLen);

  // ta.percentrank(ta.roc(close, 1), rankLen): the share of the previous `rankLen` one-bar returns at or below
  // this one, needing all `rankLen + 1` of them (the first bar has none).
  const roc1: Maybe[] = closes.map((c, i) =>
    i === 0 || closes[i - 1] === 0 ? null : (100 * (c - closes[i - 1])) / closes[i - 1],
  );
  const out: Maybe[] = nulls(n);
  for (let i = rankLen; i < n; i++) {
    const a = priceRsi[i];
    const b = streakRsi[i];
    const today = roc1[i];
    if (a === null || b === null || today === null) continue;
    let atOrBelow = 0;
    let complete = true;
    for (let k = 1; k <= rankLen; k++) {
      const prior = roc1[i - k];
      if (prior === null) {
        complete = false;
        break;
      }
      if (le(prior, today)) atOrBelow++;
    }
    if (!complete) continue;
    const rank = (100 * atOrBelow) / rankLen;
    out[i] = (a + b + rank) / 3;
  }
  return out;
}

/**
 * Chande Kroll Stop — ATR-offset extremes, then the extreme of THOSE.
 *
 * The double pass is what separates it from a plain ATR band: the first pass
 * offsets each bar's high/low, the second takes the running extreme of the
 * offsets, so the stop ratchets and never loosens within a trend.
 */
export function chandeKrollStop(
  bars: Ohlc[],
  atrLength = 10,
  atrMult = 1,
  stopLength = 9,
): { long: Maybe[]; short: Maybe[] } {
  // TradingView's Chande Kroll Stop: the first stops hang an ATR off the `atrLength` extremes; the stop LONG is the
  // lowest of the first LOW stops over `stopLength` bars, the stop SHORT the highest of the first HIGH stops. This
  // had the two names the other way round, and let a window start before it had `stopLength` values.
  const a = atr(bars, atrLength);
  const highs = extremeNa(
    bars.map((b) => b.high),
    atrLength,
    true,
  );
  const lows = extremeNa(
    bars.map((b) => b.low),
    atrLength,
    false,
  );
  const firstHigh: Maybe[] = bars.map((_, i) =>
    highs[i] === null || a[i] === null ? null : (highs[i] as number) - atrMult * (a[i] as number),
  );
  const firstLow: Maybe[] = bars.map((_, i) =>
    lows[i] === null || a[i] === null ? null : (lows[i] as number) + atrMult * (a[i] as number),
  );
  return {
    long: extremeNa(firstLow, stopLength, false),
    short: extremeNa(firstHigh, stopLength, true),
  };
}

/**
 * McGinley Dynamic — a moving average that adjusts its own speed to the market.
 *
 * The divisor tracks how far price has run from the line, so it accelerates in
 * a fast market and slows in a quiet one, which is what stops it lagging the
 * way a fixed-period EMA does through a gap.
 */
export function mcginley(closes: number[], period = 14): Maybe[] {
  // Seeded as TradingView's built-in is: with the EMA of the first `period` closes, on the bar it appears (it
  // used to start from the first close, and took hundreds of bars to forget it).
  const seed = ema(closes, period);
  const out: Maybe[] = nulls(closes.length);
  let md = NaN;
  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(md)) {
      md = toNum(seed[i]);
    } else {
      // ratio**4 is the defining term; a zero line would divide by zero, so it is held instead.
      const denom = period * Math.pow(closes[i] / md, 4);
      if (denom !== 0 && Number.isFinite(denom)) md = md + (closes[i] - md) / denom;
    }
    out[i] = maybe(md);
  }
  return out;
}

/**
 * Rolling standard deviation — `ta.stdev`: the POPULATION deviation (÷ n), as TradingView's built-in, Bollinger
 * Bands and the engine use (DR-13; this divided by n − 1). Two passes around the window mean.
 */
export function stdev(values: number[], period = 20): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  if (period < 1) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k];
    const mean = sum / period;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) sq += (values[k] - mean) ** 2;
    // Clamp: accumulated float error can leave sq at -1e-17 on a flat series,
    // and Math.sqrt of that is NaN, which blanks the pane.
    out[i] = Math.sqrt(Math.max(0, sq) / period);
  }
  return out;
}

/**
 * True Strength Index — double-smoothed momentum over double-smoothed absolute
 * momentum, as a percentage.
 */
export function tsi(
  closes: number[],
  long = 25,
  short = 13,
  signalLen = 13,
): {
  tsi: Maybe[];
  signal: Maybe[];
} {
  const ratio = tsiRatio(closes, long, short);
  const out = ratio.map((v) => (v === null ? null : 100 * v));
  return { tsi: out, signal: denseMap(out, (d) => ema(d, signalLen)) };
}

/**
 * `ta.tsi(source, short, long)`: the double-smoothed one-bar change (EMA `long`, then EMA `short`) over the same of
 * its absolute value — a ratio in [−1, 1]. The first bar has no change and is not averaged (it used to enter as 0).
 */
function tsiRatio(closes: number[], long: number, short: number): Maybe[] {
  const mom: Maybe[] = closes.map((c, i) => (i === 0 ? null : c - closes[i - 1]));
  const smooth = (v: Maybe[]) => emaNa(emaNa(v, long), short);
  const num = smooth(mom);
  const den = smooth(mom.map((m) => (m === null ? null : Math.abs(m))));
  return closes.map((_, i) => {
    const a = num[i];
    const b = den[i];
    return a === null || b === null || b === 0 ? null : a / b;
  });
}

/**
 * SMI Ergodic — TradingView's SMI Ergodic Indicator: `ta.tsi(close, short, long)` — the TSI as a RATIO in
 * [−1, 1], not a percentage — and its EMA signal, under Blau's naming and default lengths.
 */
export function smiErgodic(
  closes: number[],
  long = 20,
  short = 5,
  signalLen = 5,
): { tsi: Maybe[]; signal: Maybe[] } {
  const line = tsiRatio(closes, long, short);
  return { tsi: line, signal: denseMap(line, (d) => ema(d, signalLen)) };
}

/**
 * Relative Volatility Index — RSI applied to standard deviation instead of
 * price, so it measures whether VOLATILITY is rising or falling.
 */
export function relativeVolatilityIndex(closes: number[], period = 14, stdevLen = 10): Maybe[] {
  // TradingView's built-in: EMA (not Wilder) smoothing of the population σ on rising closes against falling ones.
  // Pine's tests on the change make a bar's "up" input 0 when the close fell or held, else σ — and σ is na in the
  // warm-up, while the 0s are not: the averages start from those, as on TradingView.
  const sd = stdev(closes, stdevLen);
  const up: Maybe[] = closes.map((c, i) =>
    i > 0 && le(c - closes[i - 1], 0) ? 0 : (sd[i] ?? null),
  );
  const down: Maybe[] = closes.map((c, i) =>
    i > 0 && gt(c - closes[i - 1], 0) ? 0 : (sd[i] ?? null),
  );
  const au = emaNa(up, period);
  const ad = emaNa(down, period);
  return closes.map((_, i) => {
    const u = au[i];
    const d = ad[i];
    return u === null || d === null || u + d === 0 ? null : (u / (u + d)) * 100;
  });
}

/**
 * Williams Fractals — a bar whose high (or low) is the most extreme of the
 * `2*size+1` bars centred on it.
 *
 * Confirmation LAGS by `size` bars by construction: a fractal cannot be known
 * until that many later bars have printed. The value is placed on the pivot
 * bar, which is where it belongs visually, but nothing here is tradeable at
 * that bar's close — it was not knowable yet.
 */
export function fractals(bars: Ohlc[], size = 2): { up: Maybe[]; down: Maybe[] } {
  const n = bars.length;
  const up: Maybe[] = nulls(n);
  const down: Maybe[] = nulls(n);
  for (let i = size; i < n - size; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - size; k <= i + size; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) isHigh = false;
      if (bars[k].low <= bars[i].low) isLow = false;
    }
    if (isHigh) up[i] = bars[i].high;
    if (isLow) down[i] = bars[i].low;
  }
  return { up, down };
}

/**
 * Zig Zag — pivots connected only once price reverses by `deviation` percent.
 *
 * Like fractals this REPAINTS: the most recent leg is provisional and moves as
 * new bars arrive. It is a structure-reading aid, never a signal.
 */
export function zigzag(bars: Ohlc[], deviation = 5): Maybe[] {
  const n = bars.length;
  const out: Maybe[] = nulls(n);
  if (n === 0) return out;
  const threshold = deviation / 100;

  // Each entry is a confirmed turning point. While price keeps moving the same
  // way the LAST entry is rewritten to the new extreme rather than appended —
  // a zig zag has one pivot per leg, not one per bar that made a new high.
  const pivots: Array<{ i: number; price: number }> = [{ i: 0, price: bars[0].close }];
  let anchor = bars[0].close;
  let dir: 1 | -1 | 0 = 0;

  for (let i = 1; i < n; i++) {
    const base = anchor || 1;
    const rise = (bars[i].high - anchor) / base;
    const fall = (anchor - bars[i].low) / base;

    if (dir !== 1 && rise >= threshold) {
      pivots.push({ i, price: bars[i].high });
      anchor = bars[i].high;
      dir = 1;
    } else if (dir !== -1 && fall >= threshold) {
      pivots.push({ i, price: bars[i].low });
      anchor = bars[i].low;
      dir = -1;
    } else if (dir === 1 && bars[i].high > anchor) {
      pivots[pivots.length - 1] = { i, price: bars[i].high };
      anchor = bars[i].high;
    } else if (dir === -1 && bars[i].low < anchor) {
      pivots[pivots.length - 1] = { i, price: bars[i].low };
      anchor = bars[i].low;
    }
  }

  for (const pivot of pivots) out[pivot.i] = pivot.price;
  return out;
}

/** Net volume — volume signed by the bar's direction. */
export function netVolume(bars: Ohlc[]): Maybe[] {
  return bars.map((b) => (b.close === b.open ? 0 : b.close > b.open ? b.volume : -b.volume));
}

export interface DeltaBar {
  time: number;
  /** Estimated buy-minus-sell volume for the bar. */
  delta: number;
  /** Running sum from the first bar. */
  cumulative: number;
}

/**
 * Buy/sell imbalance ESTIMATED from OHLCV.
 *
 * <p><b>This is not order flow.</b> Real order flow needs an aggressor tape — which side
 * crossed the spread on each trade — and this system has none for FX. The CME
 * microstructure work that would have supplied one closed NEGATIVE: aggressor delta did not
 * beat the tick-rule proxy, and it ships disabled.</p>
 *
 * <p>What this computes is the standard OHLCV proxy: a bar that closes near its high is
 * assumed to have been bought, one that closes near its low sold, scaled by volume. It is a
 * reasonable read of pressure and a poor substitute for the real thing, so every surface
 * that draws it must say "estimated" — a drawn estimate reads as a measurement unless the
 * chart itself says otherwise.</p>
 */
export function estimatedDelta(bars: readonly Ohlc[]): DeltaBar[] {
  const out: DeltaBar[] = [];
  let cumulative = 0;
  for (const bar of bars) {
    const range = bar.high - bar.low;
    // A zero-range bar carries no information about which side was in control; calling it
    // balanced is the only honest answer, and it avoids a divide by zero.
    const delta = range > 0 ? bar.volume * ((2 * (bar.close - bar.low)) / range - 1) : 0;
    cumulative += delta;
    out.push({ time: bar.time, delta, cumulative });
  }
  return out;
}

// ── Fifth wave: TradingView built-in parity ────────────────────────────────

const highestIn = (v: number[], from: number, to: number): number => {
  let m = -Infinity;
  for (let j = from; j <= to; j++) if (v[j] > m) m = v[j];
  return m;
};
const lowestIn = (v: number[], from: number, to: number): number => {
  let m = Infinity;
  for (let j = from; j <= to; j++) if (v[j] < m) m = v[j];
  return m;
};

/**
 * Align a second symbol's bars to the primary bars by time (an as-of join).
 *
 * Each primary bar takes the most recent compare bar at or before its time, so a
 * compare feed with gaps never borrows a FUTURE value. Bars before the first
 * compare bar are null.
 */
export function alignByTime(bars: readonly Ohlc[], compare: readonly Ohlc[]): (Ohlc | null)[] {
  const sorted = [...compare].sort((a, b) => a.time - b.time);
  const out: (Ohlc | null)[] = [];
  let j = -1;
  for (const bar of bars) {
    while (j + 1 < sorted.length && sorted[j + 1].time <= bar.time) j++;
    out.push(j >= 0 ? sorted[j] : null);
  }
  return out;
}

/** Least Squares Moving Average — the regression line's value `offset` bars back from its end. */
export function lsma(values: number[], period = 25, offset = 0): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  if (period < 2) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let j = 0; j < period; j++) {
      const y = values[i - period + 1 + j];
      sx += j;
      sy += y;
      sxy += j * y;
      sxx += j * j;
    }
    const denom = period * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (period * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / period;
    out[i] = intercept + slope * (period - 1 - offset);
  }
  return out;
}

/** Zero-lag EMA — EMA of `2·x − x[lag]`, lag = ⌊(period−1)/2⌋. */
export function zlema(values: number[], period = 20): Maybe[] {
  const lag = Math.floor((period - 1) / 2);
  const adj: Maybe[] = values.map((v, i) => (i >= lag ? 2 * v - values[i - lag] : null));
  return denseMap(adj, (d) => ema(d, period));
}

/** Kaufman Adaptive Moving Average — smoothing scaled by the efficiency ratio. */
export function kama(values: number[], period = 10, fast = 2, slow = 30): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  if (values.length <= period) return out;
  const fastSc = 2 / (fast + 1);
  const slowSc = 2 / (slow + 1);
  let prev = values[period - 1];
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    const change = Math.abs(values[i] - values[i - period]);
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) vol += Math.abs(values[j] - values[j - 1]);
    const er = vol === 0 ? 0 : change / vol;
    const sc = (er * (fastSc - slowSc) + slowSc) ** 2;
    prev = prev + sc * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** VIDYA — an EMA whose factor is scaled by |CMO|, so it speeds up in trends. */
export function vidya(values: number[], period = 9, cmoLen = 9): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  const alpha = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = cmoLen; i < values.length; i++) {
    let up = 0;
    let down = 0;
    for (let j = i - cmoLen + 1; j <= i; j++) {
      const d = values[j] - values[j - 1];
      if (d > 0) up += d;
      else down -= d;
    }
    const k = up + down === 0 ? 0 : Math.abs((up - down) / (up + down));
    prev = prev === null ? values[i] : alpha * k * values[i] + (1 - alpha * k) * prev;
    out[i] = prev;
  }
  return out;
}

/** Tillson T3 — six chained EMAs combined with the volume factor `v`. */
export function t3(values: number[], period = 5, v = 0.7): Maybe[] {
  const e1 = ema(values, period);
  const e2 = denseMap(e1, (d) => ema(d, period));
  const e3 = denseMap(e2, (d) => ema(d, period));
  const e4 = denseMap(e3, (d) => ema(d, period));
  const e5 = denseMap(e4, (d) => ema(d, period));
  const e6 = denseMap(e5, (d) => ema(d, period));
  const c1 = -(v ** 3);
  const c2 = 3 * v * v + 3 * v ** 3;
  const c3 = -6 * v * v - 3 * v - 3 * v ** 3;
  const c4 = 1 + 3 * v + v ** 3 + 3 * v * v;
  return values.map((_, i) =>
    e6[i] === null || e3[i] === null
      ? null
      : c1 * (e6[i] as number) +
        c2 * (e5[i] as number) +
        c3 * (e4[i] as number) +
        c4 * (e3[i] as number),
  );
}

/** Average Day Range — SMA of each bar's high−low. */
export function averageDayRange(bars: Ohlc[], period = 14): Maybe[] {
  return sma(
    bars.map((b) => b.high - b.low),
    period,
  );
}

/**
 * Chop Zone — the angle (degrees) of a 34-EMA of hlc3, normalised by the
 * 30-bar range. Positive = rising. TradingView colours bands of this angle;
 * here it is the histogram value itself.
 */
export function chopZone(bars: Ohlc[], emaLen = 34, rangeLen = 30): Maybe[] {
  const avg = bars.map((b) => (b.high + b.low + b.close) / 3);
  const e = ema(
    bars.map((b) => b.close),
    emaLen,
  );
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const out: Maybe[] = nulls(bars.length);
  for (let i = Math.max(rangeLen - 1, 1); i < bars.length; i++) {
    if (e[i] === null || e[i - 1] === null) continue;
    const hh = highestIn(highs, i - rangeLen + 1, i);
    const ll = lowestIn(lows, i - rangeLen + 1, i);
    if (hh === ll) {
      out[i] = 0;
      continue;
    }
    const span = (25 / (hh - ll)) * ll;
    const y = (((e[i - 1] as number) - (e[i] as number)) / avg[i]) * span;
    const angle = (Math.acos(1 / Math.sqrt(1 + y * y)) * 180) / Math.PI;
    out[i] = y > 0 ? -angle : angle;
  }
  return out;
}

/** Bollinger Bands Trend — (|lowerS−lowerL| − |upperS−upperL|) / middleS · 100. */
export function bbTrend(values: number[], short = 20, long = 50, mult = 2): Maybe[] {
  const s = bollinger(values, short, mult);
  const l = bollinger(values, long, mult);
  return values.map((_, i) => {
    const vals = [s.lower[i], l.lower[i], s.upper[i], l.upper[i], s.middle[i]];
    if (vals.some((v) => v === null) || s.middle[i] === 0) return null;
    const [sl, ll, su, lu, sm] = vals as number[];
    return ((Math.abs(sl - ll) - Math.abs(su - lu)) / sm) * 100;
  });
}

/** Ulcer Index — RMS of percentage drawdown from the rolling highest close. */
export function ulcerIndex(values: number[], period = 14): Maybe[] {
  const sq: number[] = values.map((v, i) => {
    const hh = highestIn(values, Math.max(0, i - period + 1), i);
    const dd = hh === 0 ? 0 : ((v - hh) / hh) * 100;
    return dd * dd;
  });
  // Clamp: the running SMA can leave -1e-17 on a flat stretch, and sqrt of that is NaN.
  return sma(sq, period).map((m, i) =>
    m === null || i < 2 * period - 2 ? null : Math.sqrt(Math.max(0, m)),
  );
}

/**
 * Chandelier Exit — ATR stop hung from the highest high (long) / lowest low
 * (short), ratcheting like TradingView's version.
 */
export function chandelierExit(
  bars: Ohlc[],
  period = 22,
  mult = 3,
): { long: Maybe[]; short: Maybe[] } {
  const a = atr(bars, period);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const long: Maybe[] = nulls(bars.length);
  const short: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    if (a[i] === null) continue;
    let ls = highestIn(highs, i - period + 1, i) - mult * (a[i] as number);
    let ss = lowestIn(lows, i - period + 1, i) + mult * (a[i] as number);
    const pl = long[i - 1];
    const ps = short[i - 1];
    if (pl !== null && pl !== undefined && bars[i - 1].close > pl) ls = Math.max(ls, pl);
    if (ps !== null && ps !== undefined && bars[i - 1].close < ps) ss = Math.min(ss, ps);
    long[i] = ls;
    short[i] = ss;
  }
  return { long, short };
}

/** Klinger Volume Oscillator (TradingView form): signed volume by hlc3 change, EMA fast − slow. */
export function klinger(
  bars: Ohlc[],
  fast = 34,
  slow = 55,
  signalLen = 13,
): { kvo: Maybe[]; signal: Maybe[] } {
  // `ta.change(hlc3) >= 0 ? volume : -volume`: on the first bar the change is na, the test is false, and the
  // volume counts as falling — as on TradingView (it used to enter as 0).
  const sv = bars.map((b, i) => {
    if (i === 0) return -b.volume;
    const p = bars[i - 1];
    const ch = (b.high + b.low + b.close) / 3 - (p.high + p.low + p.close) / 3;
    return ge(ch, 0) ? b.volume : -b.volume;
  });
  const f = ema(sv, fast);
  const s = ema(sv, slow);
  const kvo: Maybe[] = sv.map((_, i) =>
    f[i] === null || s[i] === null ? null : (f[i] as number) - (s[i] as number),
  );
  return { kvo, signal: denseMap(kvo, (d) => ema(d, signalLen)) };
}

/** Chaikin Volatility — % rate of change of an EMA of the high−low range. */
export function chaikinVolatility(bars: Ohlc[], emaLen = 10, rocLen = 10): Maybe[] {
  const e = ema(
    bars.map((b) => b.high - b.low),
    emaLen,
  );
  return e.map((v, i) => {
    const p = i >= rocLen ? e[i - rocLen] : null;
    return v === null || p === null || p === 0 ? null : ((v - p) / p) * 100;
  });
}

/** Price Oscillator — (fast MA − slow MA) / slow MA · 100. */
export function priceOscillator(
  values: number[],
  fast = 10,
  slow = 21,
  type: 'SMA' | 'EMA' = 'SMA',
): Maybe[] {
  const fn = type === 'EMA' ? ema : sma;
  const f = fn(values, fast);
  const s = fn(values, slow);
  return values.map((_, i) =>
    f[i] === null || s[i] === null || s[i] === 0
      ? null
      : (((f[i] as number) - (s[i] as number)) / (s[i] as number)) * 100,
  );
}

/** Average ranks (1-based, ties share the mean rank). */
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length);
  let k = 0;
  while (k < idx.length) {
    let m = k;
    while (m + 1 < idx.length && idx[m + 1][0] === idx[k][0]) m++;
    const r = (k + m) / 2 + 1;
    for (let t = k; t <= m; t++) out[idx[t][1]] = r;
    k = m + 1;
  }
  return out;
}

/** Rank Correlation Index — Spearman correlation of price rank vs time rank, ×100. */
export function rci(values: number[], period = 10): Maybe[] {
  const out: Maybe[] = nulls(values.length);
  if (period < 2) return out;
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    const pr = ranks(win);
    let d2 = 0;
    for (let j = 0; j < period; j++) d2 += (j + 1 - pr[j]) ** 2;
    out[i] = (1 - (6 * d2) / (period * (period * period - 1))) * 100;
  }
  return out;
}

/** Stochastic Momentum Index (Blau) with its EMA signal. */
export function smi(
  bars: Ohlc[],
  kLen = 10,
  dLen = 3,
  signalLen = 3,
): { smi: Maybe[]; signal: Maybe[] } {
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const rel: Maybe[] = nulls(bars.length);
  const rng: Maybe[] = nulls(bars.length);
  for (let i = kLen - 1; i < bars.length; i++) {
    const hh = highestIn(highs, i - kLen + 1, i);
    const ll = lowestIn(lows, i - kLen + 1, i);
    rel[i] = bars[i].close - (hh + ll) / 2;
    rng[i] = hh - ll;
  }
  const dbl = (s: Maybe[]) =>
    denseMap(
      denseMap(s, (d) => ema(d, dLen)),
      (d) => ema(d, dLen),
    );
  const r = dbl(rel);
  const g = dbl(rng);
  const out: Maybe[] = bars.map((_, i) =>
    r[i] === null || g[i] === null || g[i] === 0
      ? null
      : (200 * (r[i] as number)) / (g[i] as number),
  );
  return { smi: out, signal: denseMap(out, (d) => ema(d, signalLen)) };
}

export interface VwapBands {
  vwap: Maybe[];
  upper1: Maybe[];
  lower1: Maybe[];
  upper2: Maybe[];
  lower2: Maybe[];
}

/**
 * VWAP with volume-weighted standard-deviation bands, resetting whenever `periodKey` changes (and starting at
 * `startIndex`); a null key means "never reset". The VWAP itself is the profile engine's one implementation
 * ({@link vwapRun}): a bar without volume adds nothing, and the line is na until volume has traded.
 */
function vwapCore(
  bars: Ohlc[],
  mult1: number,
  mult2: number,
  startIndex: number,
  periodKey: ((t: number) => number) | null,
): VwapBands {
  const run = vwapRun(bars, { source: 'hlc3', startIndex, periodOf: periodKey ?? undefined });
  const band = (mult: number, sign: 1 | -1): Maybe[] =>
    run.vwap.map((v, i) => (v === null ? null : v + sign * mult * (run.dev[i] as number)));
  return {
    vwap: run.vwap,
    upper1: band(mult1, 1),
    lower1: band(mult1, -1),
    upper2: band(mult2, 1),
    lower2: band(mult2, -1),
  };
}

/** Session VWAP with ±mult1/±mult2 standard-deviation bands, reset with each `anchor` period. */
export function vwapBands(
  bars: Ohlc[],
  mult1 = 1,
  mult2 = 2,
  anchor: AnchorPeriod = 'Day',
  dayOf: DayOf = utcDay,
): VwapBands {
  return vwapCore(bars, mult1, mult2, 0, (t) => periodKey(t, anchor, dayOf));
}

/**
 * Anchored VWAP. The anchor is a UTC ms timestamp when `anchorTime > 0`
 * (first bar at or after it), else `barsBack` bars from the end.
 */
export function anchoredVwap(
  bars: Ohlc[],
  barsBack = 100,
  anchorTime = 0,
  mult1 = 1,
  mult2 = 2,
): VwapBands {
  let start: number;
  if (anchorTime > 0) {
    start = bars.findIndex((b) => b.time >= anchorTime);
    if (start < 0) start = bars.length;
  } else {
    start = Math.max(0, bars.length - Math.max(1, Math.floor(barsBack)));
  }
  return vwapCore(bars, mult1, mult2, start, null);
}

/** Volume with its moving average. */
export function volumeWithMa(bars: Ohlc[], period = 20): { volume: Maybe[]; ma: Maybe[] } {
  const v = bars.map((b) => b.volume);
  return { volume: v, ma: sma(v, period) };
}

/**
 * Up/Down volume — a bar's volume attributed by candle direction (up bars
 * positive, down bars negative) plus the net. TradingView splits by lower
 * timeframe ticks; with bar data only, candle direction is the proxy.
 */
export function upDownVolume(bars: Ohlc[]): { up: Maybe[]; down: Maybe[]; delta: Maybe[] } {
  const up = bars.map((b) => (b.close > b.open ? b.volume : 0));
  const down = bars.map((b) => (b.close < b.open ? -b.volume : 0));
  return { up, down, delta: up.map((u, i) => u + down[i]) };
}

/** Cumulative ESTIMATED delta that resets each period (see `estimatedDelta`) of trading days. */
export function cumulativeDeltaByPeriod(
  bars: Ohlc[],
  period: AnchorPeriod | 'None',
  dayOf: DayOf = utcDay,
): Maybe[] {
  const d = estimatedDelta(bars);
  let key = NaN;
  let cum = 0;
  return bars.map((b, i) => {
    const k = period === 'None' ? 0 : periodKey(b.time, period, dayOf);
    if (k !== key) {
      key = k;
      cum = 0;
    }
    cum += d[i].delta;
    return cum;
  });
}

export interface Pivot {
  index: number;
  price: number;
  high: boolean;
}

/**
 * Swing pivots: a bar whose high (low) is the strict extreme of `left` bars
 * before and `right` bars after it. Returned in time order.
 */
export function swingPivots(bars: Ohlc[], left = 5, right = 5): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: bars[i].high, high: true });
    if (isLow) out.push({ index: i, price: bars[i].low, high: false });
  }
  return out;
}

/** Alternating high/low pivots: consecutive same-side pivots keep only the more extreme. */
function alternatingPivots(bars: Ohlc[], left: number, right: number): Pivot[] {
  const out: Pivot[] = [];
  for (const p of swingPivots(bars, left, right)) {
    const last = out[out.length - 1];
    if (last && last.high === p.high) {
      if ((p.high && p.price > last.price) || (!p.high && p.price < last.price))
        out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

/**
 * Pivot Points High/Low — the most recent confirmed swing high and swing low
 * held as step lines. A null at each change breaks the line so no diagonal is
 * drawn between levels.
 */
export function pivotsHighLow(
  bars: Ohlc[],
  left = 10,
  right = 10,
): { high: Maybe[]; low: Maybe[] } {
  const n = bars.length;
  const high: Maybe[] = nulls(n);
  const low: Maybe[] = nulls(n);
  const piv = swingPivots(bars, left, right);
  const fill = (side: boolean, out: Maybe[]) => {
    const list = piv.filter((p) => p.high === side);
    list.forEach((p, k) => {
      const end = k + 1 < list.length ? list[k + 1].index : n;
      for (let i = p.index + 1; i < end; i++) out[i] = p.price;
    });
  };
  fill(true, high);
  fill(false, low);
  return { high, low };
}

export const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const FIB_EXTENSION_LEVELS = [0.618, 1, 1.618, 2.618] as const;

/**
 * Auto Fib Retracement over the last `lookback` bars: from the extreme that
 * came first to the one that came last. Level 0 sits at the later extreme
 * (TradingView's convention), level 1 at the earlier. Lines span only the
 * window from the first extreme to the last bar.
 */
export function autoFibRetracement(bars: Ohlc[], lookback = 100): Maybe[][] {
  const n = bars.length;
  const out = FIB_RETRACEMENT_LEVELS.map(() => nulls(n));
  if (n < 2) return out;
  const from = Math.max(0, n - lookback);
  let hi = from;
  let lo = from;
  for (let i = from; i < n; i++) {
    if (bars[i].high > bars[hi].high) hi = i;
    if (bars[i].low < bars[lo].low) lo = i;
  }
  const H = bars[hi].high;
  const L = bars[lo].low;
  const upMove = lo < hi; // low first, then high: retrace down from H
  const start = Math.min(hi, lo);
  FIB_RETRACEMENT_LEVELS.forEach((r, k) => {
    const price = upMove ? H - (H - L) * r : L + (H - L) * r;
    for (let i = start; i < n; i++) out[k][i] = price;
  });
  return out;
}

/**
 * Auto Fib Extension from the last three alternating pivots A→B→C:
 * level r = C + (B − A)·r, drawn from C onward.
 */
export function autoFibExtension(bars: Ohlc[], depth = 10): Maybe[][] {
  const n = bars.length;
  const out = FIB_EXTENSION_LEVELS.map(() => nulls(n));
  const piv = alternatingPivots(bars, depth, depth);
  if (piv.length < 3) return out;
  const [a, b, c] = piv.slice(-3);
  FIB_EXTENSION_LEVELS.forEach((r, k) => {
    const price = c.price + (b.price - a.price) * r;
    for (let i = c.index; i < n; i++) out[k][i] = price;
  });
  return out;
}

/**
 * Auto Andrews' Pitchfork from the last three alternating pivots P0, P1, P2:
 * the median runs from P0 through the P1–P2 midpoint; the tines are parallel
 * through P1 and P2.
 */
export function autoPitchfork(
  bars: Ohlc[],
  depth = 10,
): { median: Maybe[]; upper: Maybe[]; lower: Maybe[] } {
  const n = bars.length;
  const r = { median: nulls(n), upper: nulls(n), lower: nulls(n) };
  const piv = alternatingPivots(bars, depth, depth);
  if (piv.length < 3) return r;
  const [p0, p1, p2] = piv.slice(-3);
  const mx = (p1.index + p2.index) / 2;
  const my = (p1.price + p2.price) / 2;
  if (mx === p0.index) return r;
  const slope = (my - p0.price) / (mx - p0.index);
  const tineA = p1.price > p2.price ? p1 : p2;
  const tineB = tineA === p1 ? p2 : p1;
  for (let i = p0.index; i < n; i++) r.median[i] = p0.price + slope * (i - p0.index);
  for (let i = tineA.index; i < n; i++) r.upper[i] = tineA.price + slope * (i - tineA.index);
  for (let i = tineB.index; i < n; i++) r.lower[i] = tineB.price + slope * (i - tineB.index);
  return r;
}

/** Auto Trendlines: lines through the last two swing highs and last two swing lows, extended right. */
export function autoTrendlines(
  bars: Ohlc[],
  depth = 10,
): { resistance: Maybe[]; support: Maybe[] } {
  const n = bars.length;
  const piv = swingPivots(bars, depth, depth);
  const line = (side: boolean): Maybe[] => {
    const out = nulls(n);
    const list = piv.filter((p) => p.high === side);
    if (list.length < 2) return out;
    const [a, b] = list.slice(-2);
    const slope = (b.price - a.price) / (b.index - a.index);
    for (let i = a.index; i < n; i++) out[i] = a.price + slope * (i - a.index);
    return out;
  };
  return { resistance: line(true), support: line(false) };
}

export type PivotType = 'Traditional' | 'Fibonacci' | 'Woodie' | 'Classic' | 'DM' | 'Camarilla';

/** The chart's pivot types that `panels/pivots.ts` computes (TradingView-verified); Traditional is computed here. */
const PIVOT_METHOD_OF: Partial<Record<PivotType, PivotMethod>> = {
  Classic: 'classic',
  Fibonacci: 'fibonacci',
  Woodie: 'woodie',
  DM: 'dm',
  Camarilla: 'camarilla',
};
export const PIVOT_TYPES: readonly PivotType[] = [
  'Traditional',
  'Fibonacci',
  'Woodie',
  'Classic',
  'DM',
  'Camarilla',
];

export interface PivotLevels {
  p: number;
  r1: number;
  s1: number;
  r2: number | null;
  s2: number | null;
  r3: number | null;
  s3: number | null;
}

/**
 * Pivot levels from one prior period's OHLC. Classic, Fibonacci, Camarilla, Woodie and DM are the Technicals
 * page's TradingView-verified formulas (`panels/pivots.ts`, DR-14): Woodie's pivot is (H + L + 2·open) / 4 with the
 * CURRENT period's open (`currentOpen`), not the previous close; it falls back to the close only when the current
 * period has not opened. Traditional is TradingView's Pivot Points Standard default.
 */
export function pivotLevels(
  type: PivotType,
  o: number,
  h: number,
  l: number,
  c: number,
  currentOpen: number | null = null,
): PivotLevels {
  const range = h - l;
  const method = PIVOT_METHOD_OF[type];
  if (method) {
    const lv = verifiedPivotLevels({ start: 0, open: o, high: h, low: l, close: c }, currentOpen)[
      method
    ];
    return { p: lv.P!, r1: lv.R1!, s1: lv.S1!, r2: lv.R2, s2: lv.S2, r3: lv.R3, s3: lv.S3 };
  }
  switch (type) {
    default: {
      const p = (h + l + c) / 3;
      return {
        p,
        r1: 2 * p - l,
        s1: 2 * p - h,
        r2: p + range,
        s2: p - range,
        r3: h + 2 * (p - l),
        s3: l - 2 * (h - p),
      };
    }
  }
}

/**
 * Pivot Points Standard: each period's levels come from the PREVIOUS period's
 * OHLC — periods of trading days (`dayOf`). A null on the first bar of each
 * period breaks the step so periods are not joined by a diagonal.
 */
export function pivotPointsStandard(
  bars: Ohlc[],
  type: PivotType = 'Traditional',
  period: AnchorPeriod = 'Day',
  dayOf: DayOf = utcDay,
): Record<'p' | 'r1' | 's1' | 'r2' | 's2' | 'r3' | 's3', Maybe[]> {
  const n = bars.length;
  const keys = ['p', 'r1', 's1', 'r2', 's2', 'r3', 's3'] as const;
  const out = Object.fromEntries(keys.map((k) => [k, nulls(n)])) as Record<
    (typeof keys)[number],
    Maybe[]
  >;
  let key = NaN;
  let cur: { o: number; h: number; l: number; c: number } | null = null;
  let lv: PivotLevels | null = null;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const k = periodKey(b.time, period, dayOf);
    if (k !== key) {
      // The period that just ended sets this one's levels; Woodie also reads this period's open.
      if (cur) lv = pivotLevels(type, cur.o, cur.h, cur.l, cur.c, b.open);
      cur = { o: b.open, h: b.high, l: b.low, c: b.close };
      key = k;
      continue; // the break bar stays null
    }
    if (cur) {
      cur.h = Math.max(cur.h, b.high);
      cur.l = Math.min(cur.l, b.low);
      cur.c = b.close;
    }
    if (lv) for (const kk of keys) out[kk][i] = lv[kk];
  }
  return out;
}

/** Linear Regression Channel over the last `period` bars: fit ± mult·σ of residuals. */
export function linRegChannel(
  values: number[],
  period = 100,
  mult = 2,
): { upper: Maybe[]; middle: Maybe[]; lower: Maybe[] } {
  const n = values.length;
  const r = { upper: nulls(n), middle: nulls(n), lower: nulls(n) };
  const len = Math.min(period, n);
  if (len < 2) return r;
  const start = n - len;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let j = 0; j < len; j++) {
    const y = values[start + j];
    sx += j;
    sy += y;
    sxy += j * y;
    sxx += j * j;
  }
  const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx);
  const intercept = (sy - slope * sx) / len;
  let ss = 0;
  for (let j = 0; j < len; j++) ss += (values[start + j] - (intercept + slope * j)) ** 2;
  const sd = Math.sqrt(ss / len);
  for (let j = 0; j < len; j++) {
    const m = intercept + slope * j;
    r.middle[start + j] = m;
    r.upper[start + j] = m + mult * sd;
    r.lower[start + j] = m - mult * sd;
  }
  return r;
}

/**
 * Rolling Pearson correlation of two aligned series (`ta.correlation`), in two passes around the window means: the
 * one-pass sums lose the digits that matter when prices sit far from zero (EURUSD near 1.16 moving 1e-4).
 */
export function correlation(a: Maybe[], b: Maybe[], period = 20): Maybe[] {
  const n = a.length;
  const out: Maybe[] = nulls(n);
  for (let i = period - 1; i < n; i++) {
    let sa = 0;
    let sb = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const x = a[j];
      const y = b[j];
      if (x === null || y === null) {
        ok = false;
        break;
      }
      sa += x;
      sb += y;
    }
    if (!ok) continue;
    const ma = sa / period;
    const mb = sb / period;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const da = (a[j] as number) - ma;
      const db = (b[j] as number) - mb;
      sab += da * db;
      saa += da * da;
      sbb += db * db;
    }
    if (saa <= 0 || sbb <= 0) continue;
    out[i] = Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb)));
  }
  return out;
}

/** Relative strength vs another series: (a/a[n]) / (b/b[n]). Above 1 = outperforming. */
export function relativeStrength(a: Maybe[], b: Maybe[], period = 50): Maybe[] {
  return a.map((x, i) => {
    if (i < period) return null;
    const x0 = a[i - period];
    const y = b[i];
    const y0 = b[i - period];
    if (x === null || x0 === null || y === null || y0 === null || x0 === 0 || y === 0) return null;
    return x / x0 / (y / y0);
  });
}

/** Spread (a − mult·b) and ratio (a / b) of two aligned series. */
export function spreadRatio(a: Maybe[], b: Maybe[], mult = 1): { spread: Maybe[]; ratio: Maybe[] } {
  return {
    spread: a.map((x, i) => (x === null || b[i] === null ? null : x - mult * (b[i] as number))),
    ratio: a.map((x, i) =>
      x === null || b[i] === null || b[i] === 0 ? null : x / (b[i] as number),
    ),
  };
}
