/**
 * Monte Carlo of a run's trades in the browser (PE-I8): the R multiples resampled into many other
 * orderings of the same edge, each compounded at a fixed risk per trade, to show how deep the
 * drawdown could have run and how often it reaches ruin — the one backtest path is a single draw.
 *
 * Resampling is a circular block bootstrap (blocks of ⌈√n⌉ consecutive trades keep streaks and
 * clustering), plain i.i.d. below ten trades. Seeded from the sample: the same run always gives the
 * same figures.
 */
import { quantile, sampleSeed, seededRandom } from './r-analysis';

export interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface PathStats {
  /** Largest fall from a running equity peak, % of that peak. */
  maxDrawdownPct: number;
  /** Equity change over the whole path, %. */
  finalReturnPct: number;
  longestLosingStreak: number;
}

export interface MonteCarloOptions {
  /** Simulated paths (default 2000). */
  runs?: number;
  /** Equity risked per trade, % (default 1): a −1R trade loses this much of the equity. */
  riskPct?: number;
  /** A drawdown this deep (%) counts as ruin (default 50). */
  ruinDrawdownPct?: number;
  seed?: number;
}

export interface MonteCarloResult {
  runs: number;
  trades: number;
  /** 1 = i.i.d. resampling. */
  blockSize: number;
  riskPct: number;
  ruinDrawdownPct: number;
  maxDrawdownPct: Percentiles;
  finalReturnPct: Percentiles;
  longestLosingStreak: Percentiles;
  /** Share (0–1) of paths whose drawdown reached the ruin level. */
  riskOfRuin: number;
  /** The run's own order of trades at the same risk. */
  observed: PathStats;
}

export const MONTE_CARLO_DEFAULTS = { runs: 2000, riskPct: 1, ruinDrawdownPct: 50 } as const;

/** Below this many trades the paths are resampled trade by trade (blocks would be one or two long). */
const MIN_TRADES_FOR_BLOCKS = 10;

/** Compounds a sequence of R multiples at `riskPct` of equity per trade. */
export function pathStats(rs: readonly number[], riskPct: number): PathStats {
  const risk = riskPct / 100;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  for (const r of rs) {
    equity = Math.max(0, equity * (1 + risk * r));
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 100;
    if (dd > maxDd) maxDd = dd;
    if (r < 0) {
      streak++;
      if (streak > longest) longest = streak;
    } else {
      streak = 0;
    }
  }
  return {
    maxDrawdownPct: maxDd,
    finalReturnPct: (equity - 1) * 100,
    longestLosingStreak: longest,
  };
}

export function blockSizeFor(trades: number): number {
  return trades < MIN_TRADES_FOR_BLOCKS ? 1 : Math.ceil(Math.sqrt(trades));
}

function percentiles(values: Float64Array): Percentiles {
  values.sort();
  const s = values as unknown as number[];
  return {
    p5: quantile(s, 0.05),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p95: quantile(s, 0.95),
  };
}

/** Null below two trades: there is nothing to reorder. */
export function monteCarloR(
  values: readonly number[],
  options: MonteCarloOptions = {},
): MonteCarloResult | null {
  const n = values.length;
  if (n < 2) return null;
  const runs = Math.max(1, Math.floor(options.runs ?? MONTE_CARLO_DEFAULTS.runs));
  const riskPct = options.riskPct ?? MONTE_CARLO_DEFAULTS.riskPct;
  const ruin = options.ruinDrawdownPct ?? MONTE_CARLO_DEFAULTS.ruinDrawdownPct;
  const block = blockSizeFor(n);
  const random = seededRandom(options.seed ?? sampleSeed(values));

  const dd = new Float64Array(runs);
  const ret = new Float64Array(runs);
  const streaks = new Float64Array(runs);
  const path = new Array<number>(n);
  let ruined = 0;
  for (let i = 0; i < runs; i++) {
    let k = 0;
    while (k < n) {
      const start = Math.floor(random() * n);
      for (let j = 0; j < block && k < n; j++) path[k++] = values[(start + j) % n];
    }
    const s = pathStats(path, riskPct);
    dd[i] = s.maxDrawdownPct;
    ret[i] = s.finalReturnPct;
    streaks[i] = s.longestLosingStreak;
    if (s.maxDrawdownPct >= ruin) ruined++;
  }
  return {
    runs,
    trades: n,
    blockSize: block,
    riskPct,
    ruinDrawdownPct: ruin,
    maxDrawdownPct: percentiles(dd),
    finalReturnPct: percentiles(ret),
    longestLosingStreak: percentiles(streaks),
    riskOfRuin: ruined / runs,
    observed: pathStats(values, riskPct),
  };
}
