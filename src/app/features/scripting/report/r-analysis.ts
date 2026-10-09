/**
 * R analysis of a run's closed trades (PE-I1): each trade's result in units of what it risked at
 * the stop it opened with — sizing-free, so runs and symbols compare — with the expectancy and a
 * bootstrap interval around it, the distribution, and the deflated Sharpe the promotion gate
 * computes from the same numbers.
 *
 * Pure functions: the R tab renders what these return.
 */
import { closedTrades, type StrategyReport } from './strategy-report.model';

/** Where a run's R multiples come from, best first. */
export type RBasis = 'engine' | 'reported' | 'price';

export const R_BASIS_TEXT: Record<RBasis, string> = {
  engine:
    "each trade's net profit ÷ the money it risked at its entry stop, from the engine's trade list (costs included)",
  reported:
    "each trade's net profit ÷ the money it risked at its entry stop, from the Strategy report",
  price:
    "each trade's price move ÷ its distance to the entry stop — before costs: this report carries no R per trade",
};

export interface RSample {
  /** R multiples of the closed trades that opened with a stop on their losing side, in order. */
  values: number[];
  basis: RBasis | null;
  /** Closed trades looked at. */
  closed: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The price R of a trade: its move over the distance to a stop on the losing side of its entry. */
export function priceR(
  direction: string,
  entry: number | null,
  exit: number | null,
  stop: number | null,
): number | null {
  if (!finite(entry) || !finite(exit) || !finite(stop)) return null;
  const short = direction.toLowerCase().startsWith('s');
  // A stop on the winning side (or at entry) risks nothing: R is not defined (engine BT-12).
  const risk = short ? stop - entry : entry - stop;
  if (!(risk > 0)) return null;
  return ((short ? -1 : 1) * (exit - entry)) / risk;
}

/**
 * The report's own R multiples (C6 `rMultiple`) when it carries them; else the price R of every
 * closed trade with an initial stop (C6 `initialStopPrice`); else none.
 */
export function rSampleFromReport(report: StrategyReport): RSample {
  const closed = closedTrades(report);
  const reported = closed.map((t) => t.rMultiple).filter(finite);
  if (reported.length > 0) return { values: reported, basis: 'reported', closed: closed.length };
  const price = closed
    .map((t) => priceR(t.direction, t.entryPrice, t.exitPrice, t.initialStopPrice))
    .filter(finite);
  return { values: price, basis: price.length > 0 ? 'price' : null, closed: closed.length };
}

/**
 * The engine trade list's R multiples (`Trades[].RMultiple`, C6), or `PnL ÷ RiskedAmount` from an
 * older result that stored only those.
 */
export function rSampleFromEngineTrades(trades: readonly unknown[]): RSample {
  const values: number[] = [];
  for (const t of trades) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const r = o['RMultiple'] ?? o['rMultiple'];
    if (finite(r)) {
      values.push(r);
      continue;
    }
    const pnl = o['PnL'] ?? o['pnL'] ?? o['pnl'];
    const risked = o['RiskedAmount'] ?? o['riskedAmount'];
    if (finite(pnl) && finite(risked) && risked > 0) values.push(pnl / risked);
  }
  return { values, basis: values.length > 0 ? 'engine' : null, closed: trades.length };
}

export interface RSummary {
  n: number;
  /** Mean R — the expectancy per trade. */
  mean: number;
  median: number;
  sumR: number;
  /** Sample standard deviation (n − 1); null below two trades. */
  stdev: number | null;
  /** mean ÷ stdev: the per-trade Sharpe in R the promotion gate deflates; null when R never varies. */
  sharpe: number | null;
  /** mean ÷ (stdev ÷ √n). */
  tStat: number | null;
  /** System Quality Number: √min(n, 100) × mean ÷ stdev. */
  sqn: number | null;
  /** Share (0–1) of trades above 0R. */
  winRate: number;
  avgWin: number | null;
  avgLoss: number | null;
  best: number;
  worst: number;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarizeR(values: readonly number[]): RSummary | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sumR = values.reduce((s, v) => s + v, 0);
  const mean = sumR / n;
  let stdev: number | null = null;
  if (n >= 2) {
    const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1);
    stdev = Math.sqrt(variance);
  }
  const varies = stdev !== null && stdev > 0;
  const wins = values.filter((v) => v > 0);
  const losses = values.filter((v) => v < 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  return {
    n,
    mean,
    median: quantile(sorted, 0.5),
    sumR,
    stdev,
    sharpe: varies ? mean / stdev! : null,
    tStat: varies ? mean / (stdev! / Math.sqrt(n)) : null,
    sqn: varies ? (Math.sqrt(Math.min(n, 100)) * mean) / stdev! : null,
    winRate: wins.length / n,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    best: sorted[n - 1],
    worst: sorted[0],
  };
}

/** A seeded uniform [0, 1) generator (mulberry32): the same sample always gives the same interval. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed derived from the sample itself, so a report always shows the same resampled figures. */
export function sampleSeed(values: readonly number[]): number {
  let h = 2166136261 ^ values.length;
  for (const v of values) {
    h ^= Math.round(v * 10_000) | 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface MeanInterval {
  low: number;
  high: number;
  /** 0–1, e.g. 0.95. */
  level: number;
  resamples: number;
}

/**
 * Percentile bootstrap interval of the mean R: the trades resampled with replacement `resamples`
 * times. Wide when the sample is small or its outcomes vary — the honest width of "expectancy".
 */
export function bootstrapMeanInterval(
  values: readonly number[],
  options: { resamples?: number; level?: number; seed?: number } = {},
): MeanInterval | null {
  const n = values.length;
  if (n < 2) return null;
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const random = seededRandom(options.seed ?? sampleSeed(values));
  const means = new Float64Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(random() * n)];
    means[i] = sum / n;
  }
  means.sort();
  const tail = (1 - level) / 2;
  return {
    low: quantile(means as unknown as number[], tail),
    high: quantile(means as unknown as number[], 1 - tail),
    level,
    resamples,
  };
}

export interface RBin {
  /** Inclusive lower edge; null for the open "below" bin. */
  from: number | null;
  /** Exclusive upper edge; null for the open "above" bin. */
  to: number | null;
  count: number;
  label: string;
  /** The bin holds losing trades (its upper edge is at or below 0). */
  losing: boolean;
}

const HIST_MIN = -3;
const HIST_MAX = 6;

function rText(v: number): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
  return v < 0 ? `−${s.slice(1)}` : s;
}

/**
 * The R distribution in fixed-width bins (0.25R, 0.5R or 1R, by spread) between −3R and +6R, with
 * open bins for anything beyond. Empty for no trades.
 */
export function rHistogram(values: readonly number[]): RBin[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const spread = quantile(sorted, 0.95) - quantile(sorted, 0.05);
  const width = spread <= 2.5 ? 0.25 : spread <= 6 ? 0.5 : 1;
  const lo = Math.max(HIST_MIN, Math.floor(sorted[0] / width) * width);
  const hiRaw = Math.min(HIST_MAX, (Math.floor(sorted[sorted.length - 1] / width) + 1) * width);
  const hi = Math.max(hiRaw, lo + width);
  const bins: RBin[] = [];
  const below = sorted.filter((v) => v < lo).length;
  if (below > 0) {
    bins.push({ from: null, to: lo, count: below, label: `< ${rText(lo)}R`, losing: true });
  }
  const steps = Math.round((hi - lo) / width);
  for (let i = 0; i < steps; i++) {
    const from = +(lo + i * width).toFixed(4);
    const to = +(lo + (i + 1) * width).toFixed(4);
    bins.push({
      from,
      to,
      count: 0,
      label: `${rText(from)} to ${rText(to)}R`,
      losing: to <= 0,
    });
  }
  const above = sorted.filter((v) => v >= hi).length;
  if (above > 0) {
    bins.push({ from: hi, to: null, count: above, label: `≥ ${rText(hi)}R`, losing: false });
  }
  for (const v of sorted) {
    if (v < lo || v >= hi) continue;
    const i = Math.min(steps - 1, Math.floor((v - lo) / width + 1e-9));
    bins[(below > 0 ? 1 : 0) + i].count++;
  }
  return bins;
}

// ── Deflated Sharpe — the promotion gate's formula ───────────────────────────────

/**
 * Inverse standard-normal CDF — the same rational approximation as the engine's
 * `PromotionGateValidator.InverseStandardNormalCdf`, so the console shows the gate's number.
 */
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/** The Sharpe the best of `trials` tries of a strategy with no edge is expected to reach, per trade. */
export function expectedMaxSharpe(trials: number, trades: number): number {
  const gamma = 0.5772156649015329;
  const z = (1 - gamma) * probit(1 - 1 / trials) + gamma * probit(1 - 1 / (trials * Math.E));
  return z / Math.sqrt(trades);
}

/**
 * The deflated Sharpe as the promotion gate computes it (engine `ComputeDeflatedSharpe`): how many
 * standard errors (1/√trades) the per-trade Sharpe stands above the best of `trials` no-edge tries.
 * The gate counts at least two trials and needs two trades; 0 otherwise.
 */
export function deflatedSharpe(perTradeSharpe: number, trials: number, trades: number): number {
  const n = Math.max(trials, 2);
  if (trades <= 1) return 0;
  return (perTradeSharpe - expectedMaxSharpe(n, trades)) * Math.sqrt(trades);
}
