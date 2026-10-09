/**
 * Pattern and structure scorecards (DR-I8): how each candlestick pattern, chart pattern and structure event has
 * behaved on the loaded bars of this symbol and timeframe — sample size, hit rate after k bars, mean R, and the
 * favourable / adverse excursions — net of the spread.
 *
 * The rules, stated so the numbers can be checked (and so the Pine export trades the same thing):
 * - a signal is known at its bar's CLOSE; the trade enters at the NEXT bar's open (no look-ahead);
 * - it is held k bars and leaves at the open after the k-th bar (a Pine market order placed on that bar's close);
 * - 1R is ATR(14) (Wilder) at the signal bar — every pattern is measured on the same ruler, with no stop;
 * - one spread is paid per trade (the bars are bid prices);
 * - a signal whose k bars have not all happened yet is not counted;
 * - neutral patterns (a doji says nothing about direction) are not scored.
 *
 * Past behaviour on a few hundred bars is evidence to look at, not a forecast — the panel says so.
 *
 * Pure; unit-tested directly.
 */
import { atr, type Maybe, type Ohlc } from '../indicators/math';
import { detectCandlestickPatterns, round9, type CandleTrendFilter } from './candlestick-patterns';
import { detectChartPatterns, type ChartPatternOptions } from './chart-patterns';

export type ScoreSource = 'candle' | 'chart' | 'structure';

/** One signal: where it was known (its bar) and which way it points. */
export interface ScoreSignal {
  index: number;
  id: string;
  name: string;
  direction: 'bullish' | 'bearish';
  source: ScoreSource;
}

export interface PatternScore {
  id: string;
  name: string;
  source: ScoreSource;
  direction: 'bullish' | 'bearish';
  /** Signals with all k bars behind them. */
  samples: number;
  /** Share of them that made money after the spread. */
  hitRate: number;
  /** Mean result in R (ATR at the signal), after the spread. */
  meanR: number;
  /** Mean best excursion in the k bars, in R, after the spread. */
  meanMfeR: number;
  /** Mean worst excursion against, in R, including the spread (a positive number). */
  meanMaeR: number;
}

export interface ScoreOptions {
  /** Bars held. */
  horizon: number;
  /** One spread in price units (paid once per trade). */
  spread: number;
  atrLength?: number;
}

/** The trade one signal makes under the rules above; null when it cannot be scored (yet). */
export function scoreTrade(
  bars: readonly Ohlc[],
  atrValues: readonly Maybe[],
  s: Pick<ScoreSignal, 'index' | 'direction'>,
  o: ScoreOptions,
): { r: number; mfeR: number; maeR: number } | null {
  const entryIndex = s.index + 1;
  const exitIndex = entryIndex + o.horizon;
  if (o.horizon < 1 || exitIndex >= bars.length) return null;
  const unit = atrValues[s.index];
  if (unit === null || unit === undefined || !(unit > 0)) return null;
  const dir = s.direction === 'bullish' ? 1 : -1;
  const entry = bars[entryIndex].open;
  let best = -Infinity;
  let worst = -Infinity;
  for (let j = entryIndex; j < exitIndex; j++) {
    const fav = dir > 0 ? bars[j].high - entry : entry - bars[j].low;
    const adv = dir > 0 ? entry - bars[j].low : bars[j].high - entry;
    if (fav > best) best = fav;
    if (adv > worst) worst = adv;
  }
  const move = dir * (bars[exitIndex].open - entry);
  return {
    r: (move - o.spread) / unit,
    mfeR: (best - o.spread) / unit,
    maeR: (Math.max(0, worst) + o.spread) / unit,
  };
}

/** Scores per signal id (and direction), most samples first. */
export function scoreSignals(
  bars: readonly Ohlc[],
  signals: readonly ScoreSignal[],
  o: ScoreOptions,
): PatternScore[] {
  const atrValues = atr(bars as Ohlc[], o.atrLength ?? 14);
  const groups = new Map<
    string,
    { s: ScoreSignal; trades: { r: number; mfeR: number; maeR: number }[] }
  >();
  for (const s of signals) {
    const key = `${s.source}|${s.id}|${s.direction}`;
    const g = groups.get(key) ?? { s, trades: [] };
    groups.set(key, g);
    const t = scoreTrade(bars, atrValues, s, o);
    if (t) g.trades.push(t);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return [...groups.values()]
    .map(({ s, trades }) => ({
      id: s.id,
      name: s.name,
      source: s.source,
      direction: s.direction,
      samples: trades.length,
      hitRate: trades.length ? trades.filter((t) => t.r > 0).length / trades.length : 0,
      meanR: mean(trades.map((t) => t.r)),
      meanMfeR: mean(trades.map((t) => t.mfeR)),
      meanMaeR: mean(trades.map((t) => t.maeR)),
    }))
    .sort((a, b) => b.samples - a.samples || a.name.localeCompare(b.name));
}

// ── Signals ──────────────────────────────────────────────────────────────────

/** Candlestick patterns with a direction, at their last bar. */
export function candleSignals(
  bars: readonly Ohlc[],
  opts: { ids?: string[]; trend?: CandleTrendFilter } = {},
): ScoreSignal[] {
  return detectCandlestickPatterns(bars, opts)
    .filter((h) => h.direction !== 'neutral')
    .map((h) => ({
      index: h.index,
      id: h.id,
      name: h.name,
      direction: h.direction as 'bullish' | 'bearish',
      source: 'candle' as const,
    }));
}

/**
 * Chart patterns that CONFIRMED (closed through their breakout), at the confirming bar — every one in the bars,
 * not the overlay's few most recent per type.
 */
export function chartPatternSignals(
  bars: readonly Ohlc[],
  opts: Omit<ChartPatternOptions, 'maxPerType'> = {},
): ScoreSignal[] {
  return detectChartPatterns(bars, { ...opts, maxPerType: 100_000 })
    .filter(
      (h) =>
        h.status === 'confirmed' && h.confirmedIndex !== undefined && h.direction !== 'neutral',
    )
    .map((h) => ({
      index: h.confirmedIndex as number,
      id: h.id,
      name: h.name,
      direction: h.direction as 'bullish' | 'bearish',
      source: 'chart' as const,
    }));
}

export const STRUCTURE_EVENTS = {
  'bos-up': { name: 'Break of structure up', direction: 'bullish' },
  'bos-down': { name: 'Break of structure down', direction: 'bearish' },
  'selling-climax': { name: 'Selling climax', direction: 'bullish' },
  'buying-climax': { name: 'Buying climax', direction: 'bearish' },
} as const;

/**
 * Structure events across the bars:
 * - a break of structure: a close beyond the last confirmed swing high (low) — a swing of `depth` bars each side,
 *   confirmed `depth` bars after it — once per swing (Pine: `ta.pivothigh(high, depth, depth)`);
 * - a climax: a bar whose range AND volume are `mult` × their means over the 50 bars before it (the market
 *   structure overlay's rule), read as exhaustion — a selling climax points up, a buying climax down.
 */
export function structureSignals(bars: readonly Ohlc[], depth = 5, mult = 2.5): ScoreSignal[] {
  const out: ScoreSignal[] = [];
  const n = bars.length;
  const d = Math.max(1, Math.floor(depth));
  // Pine's rule (and the engine's): no bar before it higher, every bar after it strictly lower — in a flat top the
  // most recent of the equal bars is the pivot.
  // Compared as Pine compares floats (rounded to nine decimals).
  const r = round9;
  const isHigh = (j: number) => {
    for (let k = j - d; k <= j + d; k++) {
      if (k === j) continue;
      if (k < j ? r(bars[k].high) > r(bars[j].high) : r(bars[k].high) >= r(bars[j].high))
        return false;
    }
    return true;
  };
  const isLow = (j: number) => {
    for (let k = j - d; k <= j + d; k++) {
      if (k === j) continue;
      if (k < j ? r(bars[k].low) < r(bars[j].low) : r(bars[k].low) <= r(bars[j].low)) return false;
    }
    return true;
  };
  const push = (index: number, id: keyof typeof STRUCTURE_EVENTS) =>
    out.push({ index, id, ...STRUCTURE_EVENTS[id], source: 'structure' });
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  let rangeSum = 0;
  let volSum = 0;
  for (let t = 0; t < n; t++) {
    const j = t - d;
    if (j >= d) {
      if (isHigh(j)) lastHigh = bars[j].high;
      if (isLow(j)) lastLow = bars[j].low;
    }
    if (lastHigh !== null && r(bars[t].close) > r(lastHigh)) {
      push(t, 'bos-up');
      lastHigh = null;
    }
    if (lastLow !== null && r(bars[t].close) < r(lastLow)) {
      push(t, 'bos-down');
      lastLow = null;
    }
    // Climax against the 50 bars before t.
    if (t >= 50) {
      const meanRange = rangeSum / 50;
      const meanVol = volSum / 50;
      const range = bars[t].high - bars[t].low;
      if (r(range) > r(meanRange * mult) && r(bars[t].volume) > r(meanVol * mult)) {
        push(t, r(bars[t].close) < r(bars[t].open) ? 'selling-climax' : 'buying-climax');
      }
      rangeSum -= bars[t - 50].high - bars[t - 50].low;
      volSum -= bars[t - 50].volume;
    }
    rangeSum += bars[t].high - bars[t].low;
    volSum += bars[t].volume;
  }
  return out;
}
