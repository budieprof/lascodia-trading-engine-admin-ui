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
    raw[i] = span === 0 ? 50 : ((bars[i].close - ll) / span) * 100;
  }
  const k = smoothDense(raw, smoothK);
  const d = smoothDense(k, smoothD);
  return { k, d };
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
