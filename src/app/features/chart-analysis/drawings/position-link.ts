/**
 * The Long / Short Position tool linked to trading (DR-I9):
 *
 * - **Prefill**: placed on a chart, the tool takes the account's equity and currency, the symbol's contract size and
 *   pip, and the rate that turns the quote currency into the account's — so its size is in lots, its distances in
 *   pips and its money in the account currency (TradingView's tool counts in the symbol's currency with a typed
 *   account size).
 * - **Stage**: the position as a manual trade signal for the existing manual-signal dialog — side, entry, stop,
 *   target and lots filled in. The chart sends nothing: the operator picks the strategy and creates the signal there,
 *   and it enters the queue as Pending through the standard approval workflow and every risk gate.
 *
 * Pure; unit-tested directly.
 */
import type { TradingAccountDto } from '@core/api/api.types';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import type { InstrumentFacts } from '../datafeed/instrument-facts';
import type { SignalPrefill } from '@features/trade-signals/components/create-signal-dialog/create-signal-dialog.component';
import { positionInputs, positionLevels } from './tools/forecast';
import { positionStats } from './tools/forecast-math';
import { behaviorFor } from './tools/registry';
import { optionsOf } from './tools/types';
import type { Drawing } from './model';

/**
 * Account-currency units per unit of the quote currency: 1 when the account counts in the quote currency, 1 / price in
 * the base currency, else through a cross quote (`cross(from, to)`: units of `to` per unit of `from`). Null when
 * none is known — money cannot then be put in the account's currency.
 */
export function quoteToAccountRate(
  accountCurrency: string | null | undefined,
  base: string | null | undefined,
  quote: string | null | undefined,
  price: number,
  cross?: (from: string, to: string) => number | null,
): number | null {
  const acct = (accountCurrency ?? '').toUpperCase();
  const q = (quote ?? '').toUpperCase();
  const b = (base ?? '').toUpperCase();
  if (!acct || !q) return null;
  if (acct === q) return 1;
  if (acct === b) return price > 0 ? 1 / price : null;
  const r = cross?.(q, acct) ?? null;
  return r !== null && Number.isFinite(r) && r > 0 ? r : null;
}

/** What a position tool is placed with when the chart knows the account and the symbol. */
export interface PositionAccountFacts {
  accountSize?: number;
  accountCurrency?: string;
  lotSize?: number;
  pipSize?: number;
  quoteRate?: number;
  /** The account's leverage: the tool caps the size by it (TradingView's default of 1 capped every FX trade). */
  leverage?: number;
}

/** What a position tool needs of the instrument (`datafeed/instrument-facts.ts`, the ONE source of units and money). */
export type PositionInstrumentFacts = Pick<InstrumentFacts, 'valuePerPrice' | 'distanceUnit' | 'inverse' | 'pnlCurrency'> & {
  instrument: Pick<InstrumentDto, 'baseCurrency'>;
};

/**
 * The account's and the symbol's facts for a new position tool. Without a conversion rate only the symbol's facts
 * (money per 1.0 move per unit, distance unit) are given — an account size in one currency against money in another
 * would size the trade wrong.
 *
 * US07 (ui-instrument leftover): from the instrument facts, not the currency pair. `lotSize` is the money one
 * quantity unit makes on a 1.0 price move (`valuePerPrice`: the contract size on an MT5 row — 100 000 on FX, as
 * before — tick value ÷ tick size on a catalogue row: 50 on ES); unknown, or an inverse contract (not linear in
 * price), gives none. The money is in the P&L currency (the quote currency; FX unchanged).
 */
export function positionAccountFacts(args: {
  account: Pick<TradingAccountDto, 'equity' | 'balance' | 'currency' | 'leverage'> | null;
  facts: PositionInstrumentFacts | null;
  price: number;
  cross?: (from: string, to: string) => number | null;
}): PositionAccountFacts | null {
  const { account, facts, price } = args;
  const out: PositionAccountFacts = {};
  if (facts && !facts.inverse && facts.valuePerPrice !== null && facts.valuePerPrice > 0)
    out.lotSize = facts.valuePerPrice;
  if (facts && facts.distanceUnit > 0) out.pipSize = facts.distanceUnit;
  const rate = account
    ? quoteToAccountRate(
        account.currency,
        facts?.instrument.baseCurrency,
        facts?.pnlCurrency,
        price,
        args.cross,
      )
    : null;
  const equity = account ? (account.equity > 0 ? account.equity : account.balance) : 0;
  if (account && rate !== null && equity > 0 && out.lotSize) {
    out.accountSize = Math.round(equity * 100) / 100;
    out.accountCurrency = (account.currency ?? '').toUpperCase();
    out.quoteRate = rate;
    if (account.leverage > 0) out.leverage = account.leverage;
  }
  return Object.keys(out).length ? out : null;
}

/** Whether a drawing is a position tool. */
export function isPositionTool(d: Drawing): boolean {
  return d.kind === 'long-position' || d.kind === 'short-position';
}

/**
 * The position as the manual-signal dialog's starting values: Buy for a long, Sell for a short, its entry, stop and
 * target, and its lots when the tool is linked to the account (else the dialog's own default). Null for anything but
 * a position on the price pane.
 */
export function positionOrderPrefill(d: Drawing, chartSymbol?: string): SignalPrefill | null {
  if (!isPositionTool(d) || d.pane || d.points.length === 0) return null;
  const side = d.kind === 'long-position' ? 'long' : 'short';
  const options = optionsOf(behaviorFor(d.kind), d);
  const levels = positionLevels(d, side);
  const linked =
    typeof options['accountCurrency'] === 'string' && options['accountCurrency'] !== '';
  const lots = linked ? positionStats(positionInputs(d, side, options)).qty : null;
  return {
    // US07: the chart's symbol — the drawing's is its instrument key (ES1! for a position drawn on ESZ6).
    symbol: (chartSymbol ?? d.symbol).toUpperCase(),
    direction: side === 'long' ? 'Buy' : 'Sell',
    entryPrice: levels.entry.price,
    stopLoss: levels.stop,
    takeProfit: levels.target,
    lotSize: lots !== null && lots > 0 ? Math.floor(lots * 100) / 100 || null : null,
  };
}
