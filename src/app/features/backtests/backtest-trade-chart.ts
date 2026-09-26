import type { Timeframe } from '@core/api/api.types';
import type { TradeChartSelection } from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';
import type { ReportTrade } from '@features/scripting/report/strategy-report.model';

/**
 * A closed research trade (backtest or walk-forward window), as the engine serialises it
 * (PascalCase `BacktestTrade`). SL/TP are the entry-time levels; runs recorded before the engine
 * kept them have neither, and the chart simply draws no zones for those.
 */
export interface ChartableTrade {
  Direction: number; // 0 = Buy / Long, 1 = Sell / Short
  EntryPrice: number;
  ExitPrice: number;
  EntryTime: string;
  ExitTime: string;
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
 * no action, no draggable grips.
 */
export function researchTradeSelection(
  trade: ChartableTrade,
  ctx: { symbol: string; timeframe: string | null | undefined; label: string },
): TradeChartSelection {
  const long = trade.Direction === 0;
  const exit = EXIT_LABEL[trade.ExitReason];
  return {
    title: `${ctx.label} · ${ctx.symbol} · ${long ? 'Long' : 'Short'}${exit ? ` · exited on ${exit}` : ''}`,
    symbol: ctx.symbol,
    direction: long ? 'Buy' : 'Sell',
    referencePrice: Number(trade.EntryPrice),
    referenceTime: trade.EntryTime,
    referenceLabel: 'ENTRY',
    stopLoss: trade.StopLoss ?? null,
    takeProfit: trade.TakeProfit ?? null,
    currentPrice: null,
    currentAsk: null,
    exitPrice: Number(trade.ExitPrice),
    exitTime: trade.ExitTime,
    action: null,
    editable: null,
    timeframe: asTimeframe(ctx.timeframe),
  };
}

/**
 * A Strategy-report row (Pine units, unix-ms times) as a chartable trade. The report carries no
 * SL/TP, so they are taken from the run's own trade list — the same fills, matched on entry time
 * and side — when one is available.
 */
export function reportTradeAsChartable(
  row: ReportTrade,
  runTrades: readonly ChartableTrade[],
): ChartableTrade | null {
  if (row.entryTime == null || row.entryPrice == null) return null;
  const long = row.direction === 'long';
  const entryMs = row.entryTime;
  const match = runTrades.find(
    (t) =>
      (t.Direction === 0) === long && Math.abs(new Date(t.EntryTime).getTime() - entryMs) < 1_000,
  );
  const exitReason =
    row.exitLeg === 'TakeProfit'
      ? 1
      : row.exitLeg === 'StopLoss'
        ? 0
        : row.exitLeg === 'Trailing'
          ? 3
          : -1;
  return {
    Direction: long ? 0 : 1,
    EntryPrice: row.entryPrice,
    ExitPrice: row.exitPrice ?? match?.ExitPrice ?? row.entryPrice,
    EntryTime: new Date(entryMs).toISOString(),
    // An open trade has no exit yet; the chart then runs to "now".
    ExitTime: row.exitTime != null ? new Date(row.exitTime).toISOString() : (match?.ExitTime ?? ''),
    ExitReason: exitReason,
    StopLoss: match?.StopLoss ?? null,
    TakeProfit: match?.TakeProfit ?? null,
  };
}
