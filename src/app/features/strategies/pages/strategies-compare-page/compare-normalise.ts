import { rSampleFromEngineTrades } from '@features/scripting/report/r-analysis';

/**
 * U11 — strategy comparison on a common footing. Live realised P&L is money (sizes and accounts differ); a strategy's
 * newest completed backtest can be read in R (sizing-free) or in percent of its initial capital. For every basis: the
 * cumulative curve, its maximum drawdown in the same unit, and the correlation of DAILY results between strategies.
 * Pure.
 */

export type CompareBasis = 'live' | 'r' | 'pct';

export const COMPARE_BASIS_LABELS: Record<CompareBasis, string> = {
  live: 'Live realised P&L (account currency)',
  r: 'Newest backtest — R per trade',
  pct: 'Newest backtest — % of initial capital',
};

/** One closed trade's result at its close time, in the basis' unit. */
export interface CompareStep {
  time: number;
  value: number;
}

export interface NormalisedSeries {
  strategyId: number;
  steps: CompareStep[];
  /** Cumulative curve: [time, cumulative] in close order. */
  curve: [number, number][];
  total: number;
  /** Largest fall from a running peak of the cumulative curve (≥ 0), same unit. Starts from 0. */
  maxDrawdown: number;
  trades: number;
  /** What the series is built from, e.g. "backtest #812 (2024-01-01 → 2025-12-31), 140 of 150 trades with R". */
  source: string;
}

const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || iso === '') return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : null;
};

export function normalise(
  strategyId: number,
  steps: CompareStep[],
  source: string,
): NormalisedSeries {
  const sorted = [...steps].sort((a, b) => a.time - b.time);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  const curve: [number, number][] = [];
  for (const s of sorted) {
    cum += s.value;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    curve.push([s.time, cum]);
  }
  return {
    strategyId,
    steps: sorted,
    curve,
    total: cum,
    maxDrawdown: dd,
    trades: sorted.length,
    source,
  };
}

/** Live realised P&L points (`closedAt`, `realizedPnL`). */
export function liveSteps(
  points: readonly { closedAt: string; realizedPnL: number }[],
): CompareStep[] {
  return points
    .map((p) => ({ time: ms(p.closedAt), value: p.realizedPnL }))
    .filter((s): s is CompareStep => s.time !== null && Number.isFinite(s.value));
}

/**
 * A backtest's trades as R steps (the engine's `RMultiple`, else PnL ÷ RiskedAmount; trades without one are left out)
 * or as % of the run's initial capital (PnL ÷ initial × 100, simple — not compounded, so a curve's end is the run's
 * net profit %). Trade times are the engine's `ExitTime` (UTC).
 */
export function backtestSteps(
  trades: readonly unknown[],
  basis: 'r' | 'pct',
  initialBalance: number | null,
): { steps: CompareStep[]; considered: number } {
  const steps: CompareStep[] = [];
  for (const t of trades) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const time = ms(o['ExitTime'] ?? o['exitTime']);
    if (time === null) continue;
    if (basis === 'r') {
      const r = rSampleFromEngineTrades([t]).values[0];
      if (r !== undefined) steps.push({ time, value: r });
    } else {
      const pnl = o['PnL'] ?? o['pnL'] ?? o['pnl'];
      if (typeof pnl === 'number' && Number.isFinite(pnl) && initialBalance && initialBalance > 0)
        steps.push({ time, value: (pnl / initialBalance) * 100 });
    }
  }
  return { steps, considered: trades.length };
}

/** UTC day index of a time. */
const day = (t: number) => Math.floor(t / 86_400_000);

/**
 * Pearson correlation of two series' DAILY sums over the days both cover (from the later first day to the earlier last
 * day), a day without a closed trade counting 0. Null with fewer than 10 such days or no variation.
 */
export function dailyCorrelation(
  a: readonly CompareStep[],
  b: readonly CompareStep[],
): { rho: number; days: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const from = Math.max(day(a[0].time), day(b[0].time));
  const to = Math.min(day(a[a.length - 1].time), day(b[b.length - 1].time));
  const days = to - from + 1;
  if (days < 10) return null;
  const sum = (s: readonly CompareStep[]) => {
    const v = new Float64Array(days);
    for (const x of s) {
      const d = day(x.time) - from;
      if (d >= 0 && d < days) v[d] += x.value;
    }
    return v;
  };
  const x = sum(a);
  const y = sum(b);
  let mx = 0;
  let my = 0;
  for (let i = 0; i < days; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= days;
  my /= days;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < days; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return { rho: sxy / Math.sqrt(sxx * syy), days };
}

export interface CorrelationCell {
  a: number;
  b: number;
  rho: number | null;
  days: number;
}

/** Every unordered pair of the series. */
export function correlationPairs(series: readonly NormalisedSeries[]): CorrelationCell[] {
  const out: CorrelationCell[] = [];
  for (let i = 0; i < series.length; i++)
    for (let j = i + 1; j < series.length; j++) {
      const c = dailyCorrelation(series[i].steps, series[j].steps);
      out.push({
        a: series[i].strategyId,
        b: series[j].strategyId,
        rho: c?.rho ?? null,
        days: c?.days ?? 0,
      });
    }
  return out;
}
