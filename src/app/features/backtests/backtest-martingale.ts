import type { StrategyReport } from '@features/scripting/report/strategy-report.model';
import {
  medianR,
  type LadderTrade,
} from '@shared/components/martingale-simulator/martingale-ladder.logic';

/** What the backtest page hands the martingale simulator. */
export interface BacktestLadder {
  trades: LadderTrade[];
  /** Reward:risk for recovery sizing on trades that record no target of their own. */
  assumedGeomR: number;
  /** Where {@link assumedGeomR} came from, in words the operator can check. */
  geomNote: string;
  /** A caveat about the trade list itself; null when there is none. */
  notice: string | null;
}

/** The subset of a JSON-DSL run's `Trades[]` the ladder needs (engine PascalCase wire names). */
export interface DslLadderTrade {
  Direction: number; // 0 = Buy / Long, 1 = Sell / Short
  EntryPrice: number;
  ExitPrice: number;
  PnL: number;
  GrossPnL: number;
  EntryTime: string;
  ExitTime: string;
  StopLoss?: number | null;
  TakeProfit?: number | null;
}

const fmtR = (v: number) => v.toFixed(2);

/**
 * A Pine script run's closed trades as ladder trades.
 *
 * <p>R is the report's own `rMultiple` — profit (after costs) over the money at risk at the
 * trade's initial stop — so it restakes correctly at any size. A trade with no stop on its entry
 * bar has no R and is skipped (it never defined a risk the ladder could scale).</p>
 *
 * <p>The report does not record a take-profit price, so the entry-known reward:risk recovery
 * stakes divide by is not available per trade. The default stand-in is the median R of trades that
 * closed at their take-profit leg (the script's target geometry, net of costs); without such trades
 * it is 1R. The operator can override it.</p>
 */
export function ladderFromScriptReport(report: StrategyReport): BacktestLadder {
  const symbol = report.meta.symbol || '—';
  const closed = report.trades.filter((t) => !t.isOpen && t.entryTime != null);

  const trades: LadderTrade[] = closed.map((t, i) => ({
    id: t.number ?? i + 1,
    symbol,
    at: new Date(t.entryTime as number).toISOString(),
    exitMs: t.exitTime ?? null,
    r: t.rMultiple ?? null,
    geomR: null,
  }));

  const tpRs = closed
    .filter((t) => t.exitLeg === 'TakeProfit' && t.rMultiple != null)
    .map((t) => t.rMultiple as number);
  const med = medianR(tpRs);
  const assumedGeomR = med != null ? Math.round(med * 100) / 100 : 1;
  const geomNote =
    med != null
      ? `This report records no take-profit price, so recovery stakes size for ${fmtR(med)}R: the median R of the ${tpRs.length} trade${tpRs.length === 1 ? '' : 's'} that closed at their take-profit. Change it if the script's target differs.`
      : 'This report records no take-profit price and no trade closed at one, so recovery stakes size for 1R. Set the R:R the script actually targets.';

  const trimmed = report.meta.trimmedTrades ?? 0;
  const notice =
    trimmed > 0
      ? `The report lists only the most recent ${closed.length.toLocaleString()} closed trades (${trimmed.toLocaleString()} earlier ones were trimmed), so the ladder starts from the first listed trade.`
      : null;

  return { trades, assumedGeomR, geomNote, notice };
}

/**
 * A JSON-DSL run's trades as ladder trades. These carry prices, not R, so R is the price move over
 * the stop distance, scaled by net/gross P&L so costs count. Reward:risk comes from each trade's own
 * entry-time take-profit when the run recorded one.
 */
export function ladderFromDslTrades(
  rows: readonly DslLadderTrade[],
  symbol: string,
): BacktestLadder {
  const ordered = [...rows].sort((a, b) => Date.parse(a.EntryTime) - Date.parse(b.EntryTime));
  const trades: LadderTrade[] = ordered.map((t, i) => {
    const sl = t.StopLoss ?? null;
    const risk = sl != null ? Math.abs(t.EntryPrice - sl) : 0;
    let r: number | null = null;
    let geomR: number | null = null;
    if (risk > 0 && Number.isFinite(risk)) {
      const dir = t.Direction === 1 ? -1 : 1;
      const priceR = (dir * (t.ExitPrice - t.EntryPrice)) / risk;
      r = t.GrossPnL && priceR ? priceR * (t.PnL / t.GrossPnL) : priceR;
      if (t.TakeProfit != null) {
        const g = Math.abs(t.TakeProfit - t.EntryPrice) / risk;
        geomR = Number.isFinite(g) && g > 0 ? g : null;
      }
    }
    return {
      id: i + 1,
      symbol,
      at: t.EntryTime,
      exitMs: Date.parse(t.ExitTime) || null,
      r,
      geomR,
    };
  });

  const recorded = trades.filter((t) => t.geomR != null).map((t) => t.geomR as number);
  const med = medianR(recorded);
  const assumedGeomR = med != null ? Math.round(med * 100) / 100 : 1;
  const geomNote =
    med != null
      ? `Trades without a recorded take-profit size for ${fmtR(med)}R, the median of the ${recorded.length} that recorded one.`
      : 'This run recorded no take-profit prices, so recovery stakes size for 1R. Set the R:R the strategy actually targets.';
  const noStop = trades.filter((t) => t.r === null).length;
  const notice =
    noStop > 0
      ? `${noStop} trade${noStop === 1 ? '' : 's'} recorded no stop-loss, so ${noStop === 1 ? 'it has' : 'they have'} no R and ${noStop === 1 ? 'is' : 'are'} skipped.`
      : null;
  return { trades, assumedGeomR, geomNote, notice };
}
