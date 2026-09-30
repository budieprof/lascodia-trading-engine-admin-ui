import type { Timeframe } from '@core/api/api.types';
import type { TradeChartSelection } from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';
import type { ReportTrade } from '@features/scripting/report/strategy-report.model';

/**
 * A research trade (backtest or walk-forward window), as the engine serialises it (PascalCase
 * `BacktestTrade`). SL/TP are the entry-time levels; runs recorded before the engine kept them
 * have neither, and the chart simply draws no zones for those.
 *
 * A research trade is always closed. A trade that is still open — a live session's, or a report
 * row with no exit — has no `ExitTime` (and no `ExitPrice`): the chart then runs to now and draws
 * no exit.
 */
export interface ChartableTrade {
  Direction: number; // 0 = Buy / Long, 1 = Sell / Short
  EntryPrice: number;
  ExitPrice: number | null;
  EntryTime: string;
  ExitTime: string | null;
  ExitReason: number; // 0 = StopLoss, 1 = TakeProfit, 2 = EndOfData (3 = Trailing on newer runs)
  StopLoss?: number | null;
  TakeProfit?: number | null;
}

const EXIT_LABEL: Record<number, string> = {
  0: 'stop loss',
  1: 'take profit',
  2: 'end of data',
  3: 'trailing stop',
};

const TIMEFRAMES: readonly string[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

function asTimeframe(tf: string | null | undefined): Timeframe | null {
  const t = (tf ?? '').toUpperCase();
  return TIMEFRAMES.includes(t) ? (t as Timeframe) : null;
}

/**
 * The position chart's selection for a research trade: entry line, SL/TP zones when the run
 * recorded them, the exit dot, opened on the run's own timeframe. Read-only — no live price lines,
 * no action, no draggable grips. A trade with no exit yet gets no exit dot and no "Exit" legend
 * (never one standing in at the entry price); its chart runs to now.
 */
export function researchTradeSelection(
  trade: ChartableTrade,
  ctx: { symbol: string; timeframe: string | null | undefined; label: string },
): TradeChartSelection {
  const long = trade.Direction === 0;
  const exitTime = trade.ExitTime || null;
  const exitPrice =
    exitTime !== null && trade.ExitPrice != null && Number.isFinite(Number(trade.ExitPrice))
      ? Number(trade.ExitPrice)
      : null;
  const exit = EXIT_LABEL[trade.ExitReason];
  const outcome = exitTime === null ? ' · open' : exit ? ` · exited on ${exit}` : '';
  return {
    title: `${ctx.label} · ${ctx.symbol} · ${long ? 'Long' : 'Short'}${outcome}`,
    symbol: ctx.symbol,
    direction: long ? 'Buy' : 'Sell',
    referencePrice: Number(trade.EntryPrice),
    referenceTime: trade.EntryTime,
    referenceLabel: 'ENTRY',
    stopLoss: trade.StopLoss ?? null,
    takeProfit: trade.TakeProfit ?? null,
    currentPrice: null,
    currentAsk: null,
    exitPrice,
    exitTime,
    action: null,
    editable: null,
    timeframe: asTimeframe(ctx.timeframe),
  };
}

/** A Strategy report's `exitLeg` as a research trade's `ExitReason` (-1 = a signal / close exit). */
export function exitReasonOfLeg(leg: string | null | undefined): number {
  switch (leg) {
    case 'TakeProfit':
      return 1;
    case 'StopLoss':
      return 0;
    case 'Trailing':
      return 3;
    default:
      return -1;
  }
}

/** Side, entry and exit (unix ms, null while open) of a fill, and its Pine entry id when known. */
export interface FillTimes {
  long: boolean;
  entryMs: number | null;
  exitMs: number | null;
  entryId?: string | null;
}

const within1s = (a: number, b: number): boolean => Math.abs(a - b) < 1_000;

/**
 * The fill a Strategy-report row describes, found in another list of the same trades (a run's
 * trade list, a live session's closed or open trades): same side, entry within a second. When
 * several qualify — pyramided entries on one bar, or the pieces a partial exit splits a trade
 * into — the one that also shares the row's exit and entry id wins; on a tie, the first.
 */
export function matchReportTrade<T>(
  row: ReportTrade,
  fills: readonly T[],
  timesOf: (fill: T) => FillTimes,
): T | undefined {
  if (row.entryTime == null) return undefined;
  const long = row.direction === 'long';
  let best: T | undefined;
  let bestScore = -1;
  for (const fill of fills) {
    const k = timesOf(fill);
    // `within1s` is false for NaN, so an unparseable time never matches.
    if (k.long !== long || k.entryMs == null || !within1s(k.entryMs, row.entryTime)) continue;
    let score = 0;
    if (row.exitTime != null && k.exitMs != null && within1s(k.exitMs, row.exitTime)) score += 2;
    if (row.entryId && k.entryId === row.entryId) score += 1;
    if (score > bestScore) {
      best = fill;
      bestScore = score;
    }
  }
  return best;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A research trade's {@link FillTimes}. */
export function chartableTimes(t: ChartableTrade): FillTimes {
  return { long: t.Direction === 0, entryMs: parseMs(t.EntryTime), exitMs: parseMs(t.ExitTime) };
}

/**
 * A Strategy-report row (Pine units, unix-ms times) as a chartable trade, with the SL/TP of the
 * fill it matched in `match` (the report carries none). The exit comes from the row, else from
 * the match; an open row with no exit on either side stays open — its chart runs to now.
 */
export function reportRowAsChartable(
  row: ReportTrade,
  match: ChartableTrade | null | undefined,
): ChartableTrade | null {
  if (row.entryTime == null || row.entryPrice == null) return null;
  const exitTime =
    row.exitTime != null ? new Date(row.exitTime).toISOString() : match?.ExitTime || null;
  return {
    Direction: row.direction === 'long' ? 0 : 1,
    EntryPrice: row.entryPrice,
    ExitPrice: exitTime !== null ? (row.exitPrice ?? match?.ExitPrice ?? null) : null,
    EntryTime: new Date(row.entryTime).toISOString(),
    ExitTime: exitTime,
    ExitReason: exitReasonOfLeg(row.exitLeg),
    StopLoss: match?.StopLoss ?? null,
    TakeProfit: match?.TakeProfit ?? null,
  };
}

/**
 * A Strategy-report row as a chartable trade. The report carries no SL/TP, so they are taken from
 * the run's own trade list — the same fills, matched on entry time and side — when one is
 * available.
 */
export function reportTradeAsChartable(
  row: ReportTrade,
  runTrades: readonly ChartableTrade[],
): ChartableTrade | null {
  return reportRowAsChartable(row, matchReportTrade(row, runTrades, chartableTimes));
}
