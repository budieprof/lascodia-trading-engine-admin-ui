import type { TradeChartSelection } from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';
import {
  exitReasonOfLeg,
  matchReportTrade,
  reportRowAsChartable,
  researchTradeSelection,
  type ChartableTrade,
  type FillTimes,
} from '@features/backtests/backtest-trade-chart';

import type { ScriptLiveClosedTrade, ScriptLiveStatus } from '../api/scripting-api.types';
import { engineTimeframe } from '../backtest/run-chart.model';
import type { ReportTrade } from '../report/strategy-report.model';
import { parseTradeOrigin, tradeOriginTitle, type TradeOrigin } from '../report/trade-origin';

/**
 * Charting a live session's trades on the same position chart a backtest trade opens
 * (`EATradeChartModalComponent`, via the backtest helpers): a List-of-trades row of the live
 * report, or a row of the Open trades table. The live report carries no SL/TP and no origin, so
 * both come from the status payload's own trade lists — `closedTrades` for a closed row,
 * `openTrades` for an open one — matched on side and entry time like a backtest row is matched
 * against its run's trades. On an engine build without `closedTrades` / `origin` a closed row
 * charts with no SL/TP zones and its origin reads "unknown".
 */

/** A live-session trade as the chart and the origin badges read it. */
export interface LiveTradeFill {
  long: boolean;
  entryId: string;
  entryPrice: number | null;
  entryTimeMs: number | null;
  /** Both null while the trade is open. */
  exitPrice: number | null;
  exitTimeMs: number | null;
  exitLeg: string;
  stopLoss: number | null;
  takeProfit: number | null;
  origin: TradeOrigin | null;
}

/** The session's trades, split the way the report splits them. */
export interface LiveTradeBook {
  closed: readonly LiveTradeFill[];
  open: readonly LiveTradeFill[];
}

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function iso(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function closedTradeFill(t: ScriptLiveClosedTrade): LiveTradeFill {
  return {
    long: t.direction !== 'short',
    entryId: t.entryId,
    entryPrice: t.entryPrice,
    entryTimeMs: t.entryTimeMs,
    exitPrice: t.exitPrice,
    exitTimeMs: t.exitTimeMs,
    exitLeg: t.exitLeg,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    origin: t.origin,
  };
}

/**
 * An `openTrades[]` row — loosely typed emulator state — as a fill: the current engine's keys
 * (`entryTimeMs`, `stopLoss`, `takeProfit`), else the emulator's older spellings.
 */
export function openTradeFill(row: Json): LiveTradeFill {
  return {
    long: !text(row['direction']).toLowerCase().startsWith('s'),
    entryId: text(row['entryId']),
    entryPrice: num(row['entryPrice']),
    entryTimeMs: num(row['entryTimeMs']) ?? num(row['entryTime']),
    exitPrice: null,
    exitTimeMs: null,
    exitLeg: '',
    stopLoss: num(row['stopLoss']) ?? num(row['protectedStop']),
    takeProfit: num(row['takeProfit']) ?? num(row['protectedTarget']),
    origin: parseTradeOrigin(row['origin']),
  };
}

export function liveTradeBook(live: ScriptLiveStatus | null): LiveTradeBook {
  return {
    closed: (live?.closedTrades ?? []).map(closedTradeFill),
    open: (live?.openTrades ?? []).map(openTradeFill),
  };
}

/** True when the engine tagged any trade with its origin (an older build tags none). */
export function hasTradeOrigins(book: LiveTradeBook): boolean {
  return book.closed.some((f) => f.origin !== null) || book.open.some((f) => f.origin !== null);
}

export function fillTimes(f: LiveTradeFill): FillTimes {
  return {
    long: f.long,
    entryMs: f.entryTimeMs,
    exitMs: f.exitTimeMs,
    entryId: f.entryId || null,
  };
}

/** The fill a row of the live report describes: an open row among the open trades, a closed one among the closed. */
export function matchLiveFill(row: ReportTrade, book: LiveTradeBook): LiveTradeFill | undefined {
  return matchReportTrade(row, row.isOpen ? book.open : book.closed, fillTimes);
}

/** A live fill as a chartable trade; null without an entry price and time. */
export function liveFillAsChartable(f: LiveTradeFill): ChartableTrade | null {
  const entryTime = iso(f.entryTimeMs);
  if (f.entryPrice === null || entryTime === null) return null;
  const exitTime = iso(f.exitTimeMs);
  return {
    Direction: f.long ? 0 : 1,
    EntryPrice: f.entryPrice,
    ExitPrice: exitTime !== null ? f.exitPrice : null,
    EntryTime: entryTime,
    ExitTime: exitTime,
    ExitReason: exitReasonOfLeg(f.exitLeg),
    StopLoss: f.stopLoss,
    TakeProfit: f.takeProfit,
  };
}

/** Where the chart opens: the strategy's symbol / timeframe, else the live report's. */
export interface LiveChartContext {
  symbol: string;
  /** Engine timeframe (M1…D1), or null for the chart's default. */
  timeframe: string | null;
}

export function liveChartContext(
  strategy: { symbol?: string | null; timeframe?: string | null },
  reportMeta: { symbol: string; timeframe: string } | null | undefined,
): LiveChartContext {
  return {
    symbol: (strategy.symbol || reportMeta?.symbol || '').replace(/\//g, '').toUpperCase(),
    timeframe: engineTimeframe(strategy.timeframe) ?? engineTimeframe(reportMeta?.timeframe),
  };
}

/** "Live session · trade #12 · Paper" / "… · Warm-up replay" / "… · Origin unknown". */
export function liveTradeLabel(ref: string, origin: TradeOrigin | null): string {
  return `Live session · ${ref} · ${tradeOriginTitle(origin)}`;
}

export interface LiveTradeChart {
  selection: TradeChartSelection;
  origin: TradeOrigin | null;
}

/**
 * A List-of-trades row of the live report as a chart: SL/TP and origin from the matching fill;
 * an open row has no exit (the chart runs to now). Null when the row has no entry.
 */
export function liveReportTradeChart(
  row: ReportTrade,
  book: LiveTradeBook,
  ctx: LiveChartContext,
): LiveTradeChart | null {
  const match = matchLiveFill(row, book);
  const trade = reportRowAsChartable(row, match ? liveFillAsChartable(match) : null);
  if (!trade) return null;
  const origin = match?.origin ?? null;
  const ref = row.number !== null ? `trade #${row.number}` : 'trade';
  return {
    origin,
    selection: researchTradeSelection(trade, { ...ctx, label: liveTradeLabel(ref, origin) }),
  };
}

/**
 * A row of the Open trades table as a chart: entry line and the trade's current SL/TP zones, no
 * exit. Named by its number in the live report when the report lists it. Null without an entry.
 */
export function liveOpenTradeChart(
  row: Json,
  reportTrades: readonly ReportTrade[],
  ctx: LiveChartContext,
): LiveTradeChart | null {
  const fill = openTradeFill(row);
  const trade = liveFillAsChartable(fill);
  if (!trade) return null;
  const listed = reportTrades.find(
    (t) => t.isOpen && t.number !== null && matchReportTrade(t, [fill], fillTimes) !== undefined,
  );
  const ref = listed
    ? `trade #${listed.number}`
    : fill.entryId
      ? `open trade "${fill.entryId}"`
      : 'open trade';
  return {
    origin: fill.origin,
    selection: researchTradeSelection(trade, { ...ctx, label: liveTradeLabel(ref, fill.origin) }),
  };
}
