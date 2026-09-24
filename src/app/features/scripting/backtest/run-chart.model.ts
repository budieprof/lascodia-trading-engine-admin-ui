import type { CandleDto } from '@core/api/api.types';
import { timeframeMs } from '@shared/pine-chart/core/timeline';
import { toPineChartData, type PineChartData } from '@shared/pine-chart/model/chart-data';

import type { StrategyReport } from '../report/strategy-report.model';

/**
 * The chart of a script strategy's backtest run (ADR-0027 §4).
 *
 * A run's `resultJson` holds its Strategy report; when it also carries the run's `bars` (and
 * `outputs`) — a §3-shaped payload — the chart draws exactly those. Otherwise the price comes from
 * the engine's candle store over the run's window. Either way the report's trades are placed by
 * their entry / exit times (Pine fills at bar opens, so a time names its bar exactly): a trade's
 * bar index counts from the run's first bar, which a window of bars need not start at.
 */

/** Most bars the candle-store chart asks for (the newest ones of the run's window). */
export const MAX_RUN_CHART_BARS = 5000;

const ENGINE_TIMEFRAMES: readonly (readonly [string, number])[] = [
  ['M1', 60_000],
  ['M5', 5 * 60_000],
  ['M15', 15 * 60_000],
  ['H1', 60 * 60_000],
  ['H4', 4 * 60 * 60_000],
  ['D1', 24 * 60 * 60_000],
];

/** The engine timeframe (M1…D1) for an engine or Pine spelling; null when the engine does not store it. */
export function engineTimeframe(timeframe: string | null | undefined): string | null {
  const ms = timeframeMs(timeframe);
  if (ms === null) return null;
  return ENGINE_TIMEFRAMES.find(([, m]) => m === ms)?.[0] ?? null;
}

/**
 * The report as the chart reads it (meta + trades), with the trades placed by time. With `fromMs`,
 * trades that closed before it are left out — they have no bars on a window that starts later.
 */
export function chartReport(
  report: StrategyReport | null | undefined,
  fromMs: number = -Infinity,
): Record<string, unknown> | null {
  if (!report) return null;
  return {
    meta: {
      symbol: report.meta.symbol,
      timeframe: report.meta.timeframe,
      accountCurrency: report.meta.accountCurrency,
      initialCapital: report.meta.initialCapital,
    },
    trades: report.trades
      .filter((t) => !endsBefore(t, fromMs))
      .map((t) => ({ ...t, entryBarIndex: null, exitBarIndex: null })),
  };
}

function endsBefore(
  t: { isOpen: boolean; entryTime: number | null; exitTime: number | null },
  fromMs: number,
): boolean {
  if (t.isOpen) return false;
  const end = t.exitTime ?? t.entryTime;
  return typeof end === 'number' && end < fromMs;
}

/** Closed trades that ended before `fromMs` — listed in the report, not on a chart starting there. */
export function tradesBefore(report: StrategyReport | null | undefined, fromMs: number): number {
  return report ? report.trades.filter((t) => endsBefore(t, fromMs)).length : 0;
}

function parseObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json || !json.trim().startsWith('{')) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The run's own chart when its `resultJson` carries bars; null otherwise. Top-level keys may be
 * camelCase or PascalCase; the trades come from the (casing-tolerant) normalised report.
 */
export function storedRunChartData(
  resultJson: string | null | undefined,
  report: StrategyReport | null | undefined,
): PineChartData | null {
  const root = parseObject(resultJson);
  if (!root) return null;
  const pick = (name: string): unknown =>
    root[name] ?? root[name.charAt(0).toUpperCase() + name.slice(1)] ?? null;
  const bars = pick('bars');
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const data = toPineChartData({
    compile: pick('compile'),
    bars,
    outputs: pick('outputs'),
    report: chartReport(report) ?? pick('report'),
  });
  return data && data.bars.length ? data : null;
}

/** Stored candles (any order) → chart bars ascending, with the report's trades placed by time. */
export function candleChartData(
  candles: readonly CandleDto[],
  report: StrategyReport | null | undefined,
): PineChartData | null {
  const bars = candles
    .map((c) => ({
      t: Date.parse(c.timestamp),
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: Number.isFinite(c.volume) ? c.volume : 0,
    }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
    .sort((a, b) => a.t - b.t);
  if (bars.length === 0) return null;
  return toPineChartData({
    compile: null,
    bars,
    outputs: null,
    report: chartReport(report, bars[0].t),
  });
}

/** The candle-store window of a run: the report's first/last bar times, else the run's dates. */
export function runWindow(
  run: { fromDate: string; toDate: string },
  report: StrategyReport | null | undefined,
): { from: string; to: string } {
  const first = report?.meta.firstBarTime;
  const last = report?.meta.lastBarTimeClose ?? report?.meta.lastBarTime;
  return {
    from:
      typeof first === 'number' && Number.isFinite(first)
        ? new Date(first).toISOString()
        : run.fromDate,
    to:
      typeof last === 'number' && Number.isFinite(last) ? new Date(last).toISOString() : run.toDate,
  };
}
