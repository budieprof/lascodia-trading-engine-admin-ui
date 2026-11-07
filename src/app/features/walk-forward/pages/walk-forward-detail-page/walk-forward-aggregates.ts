import { PF_NO_LOSS_SENTINEL } from '@shared/utils/metric-format';

/**
 * Walk-forward OOS aggregates, POOLED by trades (U05, 2026-11-07).
 *
 * The page used to average the folds' win rates and profit factors with equal weight: a fold with
 * 2 trades and 100% wins counted as much as one with 200 trades, and a single fold with no losing
 * trade (the engine's 9999 profit-factor sentinel) dragged the "average PF" into the thousands.
 * Pooled = Σ wins ÷ Σ trades, Σ gross profit ÷ Σ gross loss over every fold's OOS trades.
 */

export interface FoldForAggregate {
  OosTotalTrades: number;
  /** FRACTION 0..1 (engine BacktestResult.WinRate). */
  OosWinRate: number;
  OosProfitFactor: number;
  Trades?: readonly { PnL: number }[] | null;
}

export interface PooledOos {
  totalTrades: number;
  /** Pooled win rate, FRACTION; null with no OOS trade. */
  winRate: number | null;
  /**
   * Pooled profit factor; `Infinity` when the pooled trades lost nothing; null when it cannot be
   * pooled (no trades, or folds without their trade list) — see `profitFactorBasis`.
   */
  profitFactor: number | null;
  /**
   * `pooled` — from every fold's trade list; `median` — the trade lists are missing, so the median
   * of the folds' own profit factors (sentinels excluded) is shown instead and labelled so; `none`.
   */
  profitFactorBasis: 'pooled' | 'median' | 'none';
}

export function pooledOos(folds: readonly FoldForAggregate[]): PooledOos {
  const totalTrades = folds.reduce((a, f) => a + Math.max(0, f.OosTotalTrades || 0), 0);
  if (totalTrades === 0) {
    return { totalTrades: 0, winRate: null, profitFactor: null, profitFactorBasis: 'none' };
  }
  // wins_i = winRate_i × trades_i exactly (the engine computes WinRate = wins / trades).
  const wins = folds.reduce(
    (a, f) => a + (f.OosWinRate || 0) * Math.max(0, f.OosTotalTrades || 0),
    0,
  );
  const winRate = wins / totalTrades;

  const withTrades = folds.filter((f) => (f.OosTotalTrades || 0) > 0);
  const allListed = withTrades.every((f) => Array.isArray(f.Trades) && f.Trades.length > 0);
  if (allListed) {
    let gp = 0;
    let gl = 0;
    for (const f of withTrades) {
      for (const t of f.Trades!) {
        if (t.PnL > 0) gp += t.PnL;
        else if (t.PnL < 0) gl -= t.PnL;
      }
    }
    const pf = gl > 0 ? gp / gl : gp > 0 ? Number.POSITIVE_INFINITY : null;
    return {
      totalTrades,
      winRate,
      profitFactor: pf,
      profitFactorBasis: pf == null ? 'none' : 'pooled',
    };
  }

  const finite = withTrades
    .map((f) => f.OosProfitFactor)
    .filter((v) => Number.isFinite(v) && v < PF_NO_LOSS_SENTINEL)
    .sort((a, b) => a - b);
  if (finite.length === 0) {
    return { totalTrades, winRate, profitFactor: null, profitFactorBasis: 'none' };
  }
  const mid = Math.floor(finite.length / 2);
  const median = finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
  return { totalTrades, winRate, profitFactor: median, profitFactorBasis: 'median' };
}
