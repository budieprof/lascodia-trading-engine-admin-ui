/**
 * Auto analysis (DR-I11, TrendSpider-style), on the price pane:
 *
 * - **Fitted, scored trendlines**: every line through two swing highs (lows) that no CLOSE has broken since its first
 *   anchor, scored by how many swings it touches, how long it has held and how recently it was touched; the best
 *   per side, near-duplicates dropped. Touch count and score are on the chart, so a weak line says it is weak.
 * - **Higher-timeframe support and resistance on this chart**: the S/R levels of the next higher timeframe's bars
 *   (`supportResistance`, the same clustering as the chart's S/R overlay), labelled with that timeframe.
 * - **Auto Fib from the zig-zag**: Fibonacci retracement of the last zig-zag leg (TradingView's convention: level 0 at
 *   the leg's end, 1 at its start), its swing size adapted to the symbol's volatility. The last leg is provisional —
 *   it moves while price extends it — and is labelled so.
 *
 * Pure; unit-tested directly. Analysis aids, never signals.
 */
import { atr, zigzag, type Ohlc } from '../indicators/math';
import { resolutionMs } from '../datafeed/resolution';
import { supportResistance, type SrLevel } from './analysis-overlays';

export interface AutoAnalysisSettings {
  trendlines: boolean;
  htfLevels: boolean;
  autoFib: boolean;
}

export interface TrendAnchor {
  index: number;
  time: number;
  price: number;
}

export interface AutoTrendline {
  kind: 'support' | 'resistance';
  a: TrendAnchor;
  b: TrendAnchor;
  /** Price change per bar. */
  slope: number;
  /** Swings within the touch tolerance of the line (its two anchors included). */
  touches: number;
  score: number;
}

export interface TrendlineOptions {
  /** Bars each side a swing must dominate. */
  depth?: number;
  /** Most recent swings per side considered. */
  maxPivots?: number;
  /** A swing within this × ATR of the line touches it. */
  touchAtr?: number;
  /** A close beyond this × ATR breaks the line. */
  breakAtr?: number;
  /** Lines kept per side. */
  perSide?: number;
}

interface Swing {
  index: number;
  price: number;
}

/** Swing highs / lows: Pine's pivot rule (nothing before higher, everything after strictly lower). */
function swings(bars: readonly Ohlc[], depth: number, high: boolean): Swing[] {
  const out: Swing[] = [];
  const v = (k: number) => (high ? bars[k].high : -bars[k].low);
  for (let j = depth; j < bars.length - depth; j++) {
    let ok = true;
    for (let k = j - depth; k <= j + depth && ok; k++) {
      if (k === j) continue;
      if (k < j ? v(k) > v(j) : v(k) >= v(j)) ok = false;
    }
    if (ok) out.push({ index: j, price: high ? bars[j].high : bars[j].low });
  }
  return out;
}

function lastAtr(bars: readonly Ohlc[]): number | null {
  const series = atr(bars as Ohlc[], 14);
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v > 0) return v;
  }
  return null;
}

/** The fitted trendlines of one side. */
function sideLines(
  bars: readonly Ohlc[],
  kind: 'support' | 'resistance',
  pts: Swing[],
  touchTol: number,
  breakTol: number,
  perSide: number,
): AutoTrendline[] {
  const n = bars.length;
  const sign = kind === 'resistance' ? 1 : -1;
  const candidates: (AutoTrendline & { touched: Set<number> })[] = [];
  for (let p = 0; p < pts.length; p++) {
    for (let q = p + 1; q < pts.length; q++) {
      const a = pts[p];
      const b = pts[q];
      const slope = (b.price - a.price) / (b.index - a.index);
      const at = (k: number) => a.price + slope * (k - a.index);
      // Held: no close beyond it since its first anchor.
      let held = true;
      for (let k = a.index; k < n && held; k++) {
        if (sign * (bars[k].close - at(k)) > breakTol) held = false;
      }
      if (!held) continue;
      const touched = new Set<number>();
      let lastTouch = b.index;
      for (const s of pts) {
        if (s.index < a.index) continue;
        if (Math.abs(s.price - at(s.index)) <= touchTol) {
          touched.add(s.index);
          if (s.index > lastTouch) lastTouch = s.index;
        }
      }
      const touches = touched.size;
      // More touches first; then how long it has held and how recently it was respected.
      const score = touches + (n - 1 - a.index) / n + lastTouch / Math.max(1, n - 1);
      candidates.push({
        kind,
        a: { index: a.index, time: bars[a.index].time, price: a.price },
        b: { index: b.index, time: bars[b.index].time, price: b.price },
        slope,
        touches,
        score,
        touched,
      });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const kept: (AutoTrendline & { touched: Set<number> })[] = [];
  for (const c of candidates) {
    if (kept.length >= perSide) break;
    // The same swings again (a near-copy of a kept line) is not a second line.
    const dup = kept.some((k) => [...c.touched].filter((i) => k.touched.has(i)).length >= 2);
    if (!dup) kept.push(c);
  }
  return kept.map(({ touched: _t, ...line }) => line);
}

/** Fitted, scored trendlines — the best `perSide` resistance and support lines still holding. */
export function scoredTrendlines(
  bars: readonly Ohlc[],
  opts: TrendlineOptions = {},
): AutoTrendline[] {
  const depth = Math.max(1, Math.floor(opts.depth ?? 5));
  if (bars.length < depth * 2 + 10) return [];
  const unit = lastAtr(bars);
  if (unit === null) return [];
  const maxPivots = opts.maxPivots ?? 30;
  const touchTol = unit * (opts.touchAtr ?? 0.25);
  const breakTol = unit * (opts.breakAtr ?? 0.1);
  const perSide = opts.perSide ?? 2;
  const highs = swings(bars, depth, true).slice(-maxPivots);
  const lows = swings(bars, depth, false).slice(-maxPivots);
  return [
    ...sideLines(bars, 'resistance', highs, touchTol, breakTol, perSide),
    ...sideLines(bars, 'support', lows, touchTol, breakTol, perSide),
  ];
}

// ── Higher-timeframe levels ────────────────────────────────────────────────────

const LADDER = ['1', '5', '15', '60', '240', '1D', '1W'] as const;

/**
 * The timeframe whose levels this chart shows: the first of 1m / 5m / 15m / 1h / 4h / 1D / 1W at least four times
 * the chart's (H1 → 4h, M15 → 1h, 4h → 1D); null above that.
 */
export function higherTimeframe(resolution: string): string | null {
  const ms = resolutionMs(resolution);
  if (!ms) return null;
  for (const tf of LADDER) {
    const t = resolutionMs(tf);
    if (t && t >= ms * 4) return tf;
  }
  return null;
}

export interface HtfLevel extends SrLevel {
  timeframe: string;
}

/** The higher timeframe's S/R levels, labelled with it. */
export function htfLevels(htfBars: readonly Ohlc[], timeframe: string): HtfLevel[] {
  return supportResistance(htfBars, { max: 6 }).map((l) => ({ ...l, timeframe }));
}

// ── Auto Fib from the zig-zag ─────────────────────────────────────────────────

export const AUTO_FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export interface AutoFib {
  /** The leg's start (level 1) and end (level 0). */
  from: { time: number; price: number };
  to: { time: number; price: number };
  levels: { ratio: number; price: number }[];
  /** The zig-zag's reversal threshold used, in percent. */
  deviation: number;
}

/**
 * Fibonacci retracement of the last zig-zag leg. The reversal threshold is three ATRs as a percentage of price unless
 * given (a fixed 5% — the stock default — never reverses on an FX hour chart).
 */
export function autoFib(bars: readonly Ohlc[], deviationPct?: number): AutoFib | null {
  if (bars.length < 20) return null;
  const unit = lastAtr(bars);
  const close = bars[bars.length - 1].close;
  const deviation =
    deviationPct ?? (unit !== null && close > 0 ? Math.max(0.05, ((3 * unit) / close) * 100) : 5);
  const zz = zigzag(bars as Ohlc[], deviation);
  const pivots: { i: number; price: number }[] = [];
  zz.forEach((v, i) => {
    if (v !== null && v !== undefined) pivots.push({ i, price: v });
  });
  // The first entry is the series' first close, not a turning point: a leg needs two real pivots.
  if (pivots.length < 3) return null;
  const a = pivots[pivots.length - 2];
  const b = pivots[pivots.length - 1];
  if (a.price === b.price) return null;
  return {
    from: { time: bars[a.i].time, price: a.price },
    to: { time: bars[b.i].time, price: b.price },
    levels: AUTO_FIB_RATIOS.map((ratio) => ({
      ratio,
      price: b.price + (a.price - b.price) * ratio,
    })),
    deviation,
  };
}

/** Everything the overlay draws. */
export interface AutoAnalysis {
  trendlines: AutoTrendline[];
  htf: HtfLevel[];
  fib: AutoFib | null;
}
