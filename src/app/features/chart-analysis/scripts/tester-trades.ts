import type { ScriptInputValues } from '@core/api/scripting.types';
import type { ScriptBacktestRequest } from '@features/scripting/api/scripting-api.types';
import { validateBacktestForm } from '@features/scripting/backtest/script-backtest-launcher.component';
import { resolutionSource, type EngineTimeframe } from '../datafeed/resolution';
import type { ChartTrade } from './chart-script.model';

/**
 * The Strategy Tester's own parts that need no Angular (PC-I5, PC-12): the List of trades' row
 * window, its prices at the symbol's precision, and the "Deep backtest…" request.
 */

/** The rows a virtualised list renders: those in view and a margin either side. */
export interface RowWindow {
  start: number;
  end: number;
  /** Px above the first rendered row. */
  offset: number;
  /** Px of every row. */
  total: number;
}

/**
 * Rows `[start, end)` of `count` that a list scrolled to `scrollTop` with a `viewportHeight` px
 * window shows, `overscan` rows either side — a strategy with thousands of trades renders a few
 * dozen rows.
 */
export function rowWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): RowWindow {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end: Math.max(start, end), offset: start * rowHeight, total: count * rowHeight };
}

/** A price as the symbol quotes it (its decimals); a dash when there is none. */
export function formatPrice(v: number | null | undefined, precision: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const dp = Math.max(0, Math.min(10, Math.trunc(precision)));
  return v.toFixed(dp);
}

/** The trades in list order: by number, the newest first when `newestFirst`. */
export function orderTrades(trades: readonly ChartTrade[], newestFirst: boolean): ChartTrade[] {
  const out = [...trades].sort((a, b) => a.number - b.number);
  return newestFirst ? out.reverse() : out;
}

// ── Deep backtest ────────────────────────────────────────────────────────────

/** An engine strategy on the chart, as "Deep backtest…" queues it (`POST backtest`). */
export interface DeepBacktestTarget {
  strategyId: number;
  /** The strategy's own market and timeframe (the engine refuses a mismatch without an override). */
  strategySymbol: string;
  strategyTimeframe: string;
  /** The chart's symbol, and its timeframe as the engine stores timeframes (null: not one of them). */
  chartSymbol: string;
  chartTimeframe: EngineTimeframe | null;
}

/**
 * The engine timeframe a chart resolution is, for a backtest's timeframe: only the six stored ones
 * served as stored (1m, 5m, 15m, 1h); 4h and 1D are drawn on the session grid, not the stored H4 and
 * D1, and every other interval is built — none of them is a backtest timeframe. Null then.
 */
export function backtestTimeframeOf(resolution: string): EngineTimeframe | null {
  const src = resolutionSource(resolution);
  return src?.kind === 'stored' && src.aggregate === 1 ? src.timeframe : null;
}

/**
 * The `POST backtest` request for a deep backtest of the strategy as the chart runs it — the chart's
 * market and timeframe (as overrides where they differ from the strategy's, and the timeframe only
 * when the chart's is a backtest timeframe), the chart's input overrides — over `fromDate`…`toDate`;
 * or why it cannot be queued.
 */
export function deepBacktestRequest(
  target: DeepBacktestTarget,
  form: { fromDate: string; toDate: string },
  inputs: ScriptInputValues,
): ScriptBacktestRequest | string {
  const symbol = target.chartSymbol.trim().toUpperCase();
  const problem = validateBacktestForm({ ...form, symbolOverride: symbol });
  if (problem) return problem;
  const req: ScriptBacktestRequest = {
    strategyId: target.strategyId,
    symbol: target.strategySymbol,
    timeframe: target.strategyTimeframe,
    fromDate: form.fromDate,
    toDate: form.toDate,
    deep: true,
  };
  if (symbol && symbol !== target.strategySymbol.toUpperCase()) req.symbolOverride = symbol;
  const tf = target.chartTimeframe;
  if (tf && tf !== target.strategyTimeframe) req.timeframeOverride = tf;
  if (Object.keys(inputs).length) req.inputs = { ...inputs };
  return req;
}
