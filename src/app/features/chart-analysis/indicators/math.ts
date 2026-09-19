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

export type Maybe = number | null;

export interface Ohlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const nulls = (n: number): Maybe[] => new Array<Maybe>(Math.max(0, n)).fill(null);

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
 * new UTC day.
 *
 * VWAP without a session reset is a different (and far less useful) indicator:
 * it drifts toward the all-time mean and stops tracking the day's value area.
 */
export function vwap(bars: Ohlc[]): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor(bars[i].time / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    pv += typical * bars[i].volume;
    vol += bars[i].volume;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
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

/** On-balance volume. */
export function obv(bars: Ohlc[]): Maybe[] {
  if (bars.length === 0) return [];
  const out: Maybe[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[i - 1] as number;
    const d = bars[i].close - bars[i - 1].close;
    out[i] = d > 0 ? prev + bars[i].volume : d < 0 ? prev - bars[i].volume : prev;
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
  const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
  const avg = sma(typical, period);
  const out: Maybe[] = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    const mean = avg[i];
    if (mean === null) continue;
    let deviation = 0;
    for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(typical[j] - mean);
    const meanDeviation = deviation / period;
    out[i] = meanDeviation === 0 ? 0 : (typical[i] - mean) / (0.015 * meanDeviation);
  }
  return out;
}

/** Money Flow Index — RSI weighted by volume. */
export function mfi(bars: Ohlc[], period = 14): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
  for (let i = period; i < bars.length; i++) {
    let positive = 0;
    let negative = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = typical[j] * bars[j].volume;
      if (typical[j] > typical[j - 1]) positive += flow;
      else if (typical[j] < typical[j - 1]) negative += flow;
    }
    out[i] = negative === 0 ? 100 : 100 - 100 / (1 + positive / negative);
  }
  return out;
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
 * Parabolic SAR.
 *
 * Genuinely stateful: the acceleration factor ratchets up on each new extreme
 * and resets on every flip, so it cannot be computed for one bar in isolation.
 */
export function psar(bars: Ohlc[], step = 0.02, max = 0.2): Maybe[] {
  const out: Maybe[] = nulls(bars.length);
  if (bars.length < 2) return out;
  let rising = bars[1].close >= bars[0].close;
  let sar = rising ? bars[0].low : bars[0].high;
  let extreme = rising ? bars[0].high : bars[0].low;
  let af = step;
  out[0] = sar;

  for (let i = 1; i < bars.length; i++) {
    sar = sar + af * (extreme - sar);
    if (rising) {
      // SAR may never move above the last two lows while rising.
      sar = Math.min(sar, bars[i - 1].low, bars[Math.max(0, i - 2)].low);
      if (bars[i].low < sar) {
        rising = false;
        sar = extreme;
        extreme = bars[i].low;
        af = step;
      } else if (bars[i].high > extreme) {
        extreme = bars[i].high;
        af = Math.min(max, af + step);
      }
    } else {
      sar = Math.max(sar, bars[i - 1].high, bars[Math.max(0, i - 2)].high);
      if (bars[i].high > sar) {
        rising = true;
        sar = extreme;
        extreme = bars[i].high;
        af = step;
      } else if (bars[i].low < extreme) {
        extreme = bars[i].low;
        af = Math.min(max, af + step);
      }
    }
    out[i] = sar;
  }
  return out;
}

/** SuperTrend — ATR bands that flip side when price closes through them. */
export function superTrend(bars: Ohlc[], period = 10, mult = 3): Maybe[] {
  const range = atr(bars, period);
  const out: Maybe[] = nulls(bars.length);
  let trendUp = true;
  let previous: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const r = range[i];
    if (r === null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const upper = mid + mult * r;
    const lower = mid - mult * r;
    if (previous === null) {
      previous = lower;
      out[i] = lower;
      continue;
    }
    if (trendUp) {
      previous = Math.max(lower, previous);
      if (bars[i].close < previous) {
        trendUp = false;
        previous = upper;
      }
    } else {
      previous = Math.min(upper, previous);
      if (bars[i].close > previous) {
        trendUp = true;
        previous = lower;
      }
    }
    out[i] = previous;
  }
  return out;
}

export interface IchimokuResult {
  conversion: Maybe[];
  base: Maybe[];
  spanA: Maybe[];
  spanB: Maybe[];
  lagging: Maybe[];
}

/**
 * Ichimoku Cloud.
 *
 * Spans are plotted FORWARD by `displacement` bars and the lagging span
 * BACKWARD by the same — that shift is the indicator, not a presentation
 * detail. Values shifted past the end of the series are dropped rather than
 * clamped, since the cloud legitimately extends beyond the last bar.
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

  return {
    conversion,
    base,
    spanA: shift(rawSpanA, displacement),
    spanB: shift(rawSpanB, displacement),
    lagging: shift(
      bars.map((b) => b.close as Maybe),
      -displacement,
    ),
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
 * Computed from the PREVIOUS day's high/low/close and held flat through the
 * current day — a pivot that recomputed intrabar would not be a pivot.
 */
export function pivotPoints(bars: Ohlc[]): PivotResult {
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
    const d = Math.floor(bars[i].time / 86_400_000);
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

/** Hull moving average — WMA of (2·WMA(n/2) − WMA(n)), smoothed over √n. */
export function hma(values: number[], period = 9): Maybe[] {
  const half = Math.max(1, Math.round(period / 2));
  const sqrt = Math.max(1, Math.round(Math.sqrt(period)));
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

/** TRIX — rate of change of a triple-smoothed EMA, in percent. */
export function trix(values: number[], period = 18): Maybe[] {
  const e1 = ema(values, period);
  const e2 = denseMap(e1, (d) => ema(d, period));
  const e3 = denseMap(e2, (d) => ema(d, period));
  const out: Maybe[] = nulls(values.length);
  for (let i = 1; i < values.length; i++) {
    const now = e3[i];
    const prev = e3[i - 1];
    if (now === null || prev === null || prev === 0) continue;
    out[i] = ((now - prev) / prev) * 100;
  }
  return out;
}

/** Detrended Price Oscillator. */
export function dpo(values: number[], period = 21): Maybe[] {
  const shift = Math.floor(period / 2) + 1;
  const avg = sma(values, period);
  const out: Maybe[] = nulls(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = avg[i - shift + period] ?? avg[i];
    if (a === null || a === undefined) continue;
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

/** Force Index — price change times volume, smoothed. */
export function forceIndex(bars: Ohlc[], period = 13): Maybe[] {
  const raw: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    raw.push((bars[i].close - bars[i - 1].close) * bars[i].volume);
  }
  return ema(raw, period);
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

/** Ease of Movement. */
export function easeOfMovement(bars: Ohlc[], period = 14): Maybe[] {
  const raw: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const midMove = (bars[i].high + bars[i].low) / 2 - (bars[i - 1].high + bars[i - 1].low) / 2;
    const span = bars[i].high - bars[i].low;
    const boxRatio = span === 0 || bars[i].volume === 0 ? 0 : bars[i].volume / 100000000 / span;
    raw.push(boxRatio === 0 ? 0 : midMove / boxRatio);
  }
  return sma(raw, period);
}

/** Price Volume Trend. */
export function pvt(bars: Ohlc[]): Maybe[] {
  const out: Maybe[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = (out[i - 1] ?? 0) as number;
    const prevClose = bars[i - 1].close;
    out.push(
      prevClose === 0 ? prev : prev + ((bars[i].close - prevClose) / prevClose) * bars[i].volume,
    );
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

/** Historical volatility — annualised stdev of log returns, in percent. */
export function historicalVolatility(bars: Ohlc[], period = 20, barsPerYear = 6240): Maybe[] {
  const returns: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    returns.push(prev > 0 ? Math.log(bars[i].close / prev) : 0);
  }
  const out: Maybe[] = nulls(bars.length);
  for (let i = period; i < bars.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += returns[j];
    mean /= period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (returns[j] - mean) ** 2;
    out[i] = Math.sqrt(variance / (period - 1)) * Math.sqrt(barsPerYear) * 100;
  }
  return out;
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

/** Fisher Transform — maps price into a near-Gaussian distribution. */
export function fisher(bars: Ohlc[], period = 9): { fisher: Maybe[]; trigger: Maybe[] } {
  const out: Maybe[] = nulls(bars.length);
  let value = 0;
  let prevFisher = 0;
  const trigger: Maybe[] = nulls(bars.length);

  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const median = (bars[i].high + bars[i].low) / 2;
    const span = hh - ll;
    const raw = span === 0 ? 0 : 2 * ((median - ll) / span) - 1;
    value = 0.66 * raw + 0.67 * value;
    // The transform blows up at ±1, so the input is clamped just inside.
    const clamped = Math.max(-0.999, Math.min(0.999, value));
    const f = 0.5 * Math.log((1 + clamped) / (1 - clamped)) + 0.5 * prevFisher;
    trigger[i] = prevFisher;
    prevFisher = f;
    out[i] = f;
  }
  return { fisher: out, trigger };
}

export interface VolumeProfileBin {
  price: number;
  volume: number;
}

/**
 * Volume profile — volume distributed across price bins.
 *
 * Returns bins rather than a per-bar series because it is a HORIZONTAL
 * histogram: it has one value per price level for the whole window, not one
 * per bar, so it cannot be plotted through the normal series path.
 */
export function volumeProfile(bars: Ohlc[], bins = 24): VolumeProfileBin[] {
  if (bars.length === 0 || bins <= 0) return [];
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  const span = hi - lo;
  if (span <= 0) return [];
  const step = span / bins;
  const out: VolumeProfileBin[] = Array.from({ length: bins }, (_, i) => ({
    price: lo + step * (i + 0.5),
    volume: 0,
  }));
  for (const b of bars) {
    // Spread each bar's volume across the bins its range covers, rather than
    // dumping it all at the close — otherwise the profile is a histogram of
    // closing prices, which is a different and much less useful chart.
    const first = Math.max(0, Math.min(bins - 1, Math.floor((b.low - lo) / step)));
    const last = Math.max(0, Math.min(bins - 1, Math.floor((b.high - lo) / step)));
    const touched = last - first + 1;
    const share = b.volume / touched;
    for (let i = first; i <= last; i++) out[i].volume += share;
  }
  return out;
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

/** Relative Vigor Index — close-open over range, smoothed, with a signal. */
export function rvi(bars: Ohlc[], period = 10): { rvi: Maybe[]; signal: Maybe[] } {
  const numerator: number[] = [];
  const denominator: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    numerator.push(bars[i].close - bars[i].open);
    denominator.push(bars[i].high - bars[i].low);
  }
  const num = sma(numerator, period);
  const den = sma(denominator, period);
  const line: Maybe[] = bars.map((_, i) =>
    num[i] !== null && den[i] !== null && (den[i] as number) !== 0
      ? (num[i] as number) / (den[i] as number)
      : null,
  );
  return { rvi: line, signal: denseMap(line, (d) => sma(d, 4)) };
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

/** Williams Alligator — three displaced smoothed averages. */
export function alligator(bars: Ohlc[]): { jaw: Maybe[]; teeth: Maybe[]; lips: Maybe[] } {
  const median = bars.map((b) => (b.high + b.low) / 2);
  const shift = (series: Maybe[], by: number): Maybe[] => {
    const out: Maybe[] = nulls(series.length);
    for (let i = 0; i < series.length; i++) {
      const target = i + by;
      if (target < series.length) out[target] = series[i];
    }
    return out;
  };
  return {
    jaw: shift(smma(median, 13), 8),
    teeth: shift(smma(median, 8), 5),
    lips: shift(smma(median, 5), 3),
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

/** Bollinger bandwidth — band span as a fraction of the basis. */
export function bandwidth(closes: number[], period = 20, mult = 2): Maybe[] {
  const { upper, middle, lower } = bollinger(closes, period, mult);
  return closes.map((_, i) => {
    const u = upper[i];
    const m = middle[i];
    const l = lower[i];
    if (u === null || m === null || l === null || m === 0) return null;
    return (u - l) / m;
  });
}
