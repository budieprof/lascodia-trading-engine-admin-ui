import type { ScriptLiveClosedTrade } from '../api/scripting-api.types';
import { toCsv, type CsvCell } from '../shared/download';
import type { StrategyReport, ReportTrade } from './strategy-report.model';
import { TRADE_ORIGIN_TITLES, type TradeOrigin } from './trade-origin';

/**
 * The List of trades as CSV (PE-I14): what a Preview or the live emulator's report shows, for a
 * spreadsheet. Backtest runs have the engine's own export (`GET backtest/{id}/export`) instead.
 * Times are UTC ISO-8601; quantities are Pine units (100,000 = one EURUSD lot); money is the
 * report's account currency.
 */

const iso = (ms: number | null | undefined): string =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '';

const side = (direction: string): string => (direction.startsWith('s') ? 'Short' : 'Long');

export function reportTradesCsv(
  report: StrategyReport,
  originOf?: ((t: ReportTrade) => TradeOrigin | null) | null,
): string {
  const withOrigin = !!originOf;
  const headers = [
    'Trade #',
    'Side',
    'Status',
    'Entry signal',
    'Entry time (UTC)',
    'Entry price',
    'Exit signal',
    'Exit time (UTC)',
    'Exit price',
    'Exit leg',
    'Quantity (units)',
    `Profit${report.meta.accountCurrency ? ` (${report.meta.accountCurrency})` : ''}`,
    'Profit %',
    'Cumulative profit',
    'Run-up',
    'Drawdown',
    'Bars held',
    'Commission',
    'Initial stop',
    'R multiple',
    ...(withOrigin ? ['Origin'] : []),
  ];
  const rows: CsvCell[][] = report.trades.map((t) => [
    t.number,
    side(t.direction),
    t.isOpen ? 'Open' : 'Closed',
    t.entrySignal,
    iso(t.entryTime),
    t.entryPrice,
    t.isOpen ? '' : t.exitSignal,
    t.isOpen ? '' : iso(t.exitTime),
    t.isOpen ? null : t.exitPrice,
    t.exitLeg,
    t.qty,
    t.profit,
    t.profitPercent,
    t.cumulativeProfit,
    t.runUp,
    t.drawdown,
    t.barsHeld,
    t.commission,
    t.initialStopPrice,
    t.rMultiple,
    ...(withOrigin ? [originTitle(originOf!(t))] : []),
  ]);
  return toCsv(headers, rows);
}

/** The live session's closed trades (newest 500, oldest first), each with where it came from. */
export function liveClosedTradesCsv(trades: readonly ScriptLiveClosedTrade[]): string {
  const headers = [
    'Trade key',
    'Origin',
    'Side',
    'Entry id',
    'Entry time (UTC)',
    'Entry price',
    'Exit time (UTC)',
    'Exit price',
    'Exit leg',
    'Exit comment',
    'Quantity (units)',
    'Lots',
    'Profit',
    'Stop at entry',
    'Target at entry',
  ];
  const rows: CsvCell[][] = trades.map((t) => [
    t.tradeKey,
    originTitle(t.origin),
    side(t.direction),
    t.entryId,
    iso(t.entryTimeMs),
    t.entryPrice,
    iso(t.exitTimeMs),
    t.exitPrice,
    t.exitLeg,
    t.exitComment,
    t.qty,
    t.lots,
    t.profit,
    t.stopLoss,
    t.takeProfit,
  ]);
  return toCsv(headers, rows);
}

function originTitle(origin: TradeOrigin | null): string {
  return origin ? TRADE_ORIGIN_TITLES[origin] : '';
}
