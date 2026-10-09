import type { LiveQuote } from '../overlays/trade-layer';
import { roundPrice, type TradeLine } from './trade-lines';
import type {
  ManualTradePreview,
  ManualTradeRequest,
  TicketDirection,
  TicketMode,
  TradeGate,
} from './manual-trading.types';

/**
 * The order ticket's pure half (SP-I4): what the operator set, the request it makes, its default brackets, the stop
 * guard as the chart applies it before asking, and the brackets as chart lines.
 */

/** What the operator set on the ticket. Prices are absolute; null = not set. */
export interface TicketState {
  accountId: number | null;
  direction: TicketDirection;
  /** True: at market. False: at {@link entry} (a pending order, live only). */
  atMarket: boolean;
  entry: number | null;
  stop: number | null;
  target: number | null;
  mode: TicketMode;
}

/** A ticket opened from somewhere else (a position tool's "Stage…", DR-I9). */
export interface TicketPrefill {
  direction: TicketDirection;
  entry: number | null;
  stop: number | null;
  target: number | null;
}

export const DEFAULT_TICKET: TicketState = {
  accountId: null,
  direction: 'Buy',
  atMarket: true,
  entry: null,
  stop: null,
  target: null,
  mode: 'Paper',
};

/** The default stop distance: 1.5 ATR (comfortably outside the 1-ATR guard — stops sized to survive noise). */
export const DEFAULT_STOP_ATR = 1.5;
/** The default target: 2R. */
export const DEFAULT_TARGET_R = 2;

/** The price a market ticket enters at: the ask for a buy, the bid for a sell. */
export function marketEntry(direction: TicketDirection, quote: LiveQuote | null): number | null {
  if (!quote) return null;
  return direction === 'Buy' ? (quote.ask ?? quote.bid) : quote.bid;
}

/** The ticket's entry: the market side of the quote, or the price the operator set. */
export function ticketEntry(state: TicketState, quote: LiveQuote | null): number | null {
  return state.atMarket ? marketEntry(state.direction, quote) : state.entry;
}

/** The request both ticket endpoints take; null until an account is chosen. */
export function ticketRequest(state: TicketState, symbol: string): ManualTradeRequest | null {
  if (state.accountId === null) return null;
  return {
    tradingAccountId: state.accountId,
    symbol,
    direction: state.direction,
    entryPrice: state.atMarket ? null : state.entry,
    stopLoss: state.stop,
    takeProfit: state.target,
    mode: state.mode,
  };
}

/** Default stop and target around `entry`: {@link DEFAULT_STOP_ATR} ATR, then {@link DEFAULT_TARGET_R}R. */
export function defaultBrackets(
  direction: TicketDirection,
  entry: number,
  atr: number,
  precision: number,
): { stop: number; target: number } | null {
  if (!(entry > 0) || !(atr > 0)) return null;
  const risk = atr * DEFAULT_STOP_ATR;
  const sign = direction === 'Buy' ? 1 : -1;
  return {
    stop: roundPrice(entry - sign * risk, precision),
    target: roundPrice(entry + sign * risk * DEFAULT_TARGET_R, precision),
  };
}

/** Brackets mirrored to the other side of `entry` when the direction flips (same distances). */
export function flipBrackets(
  entry: number,
  stop: number | null,
  target: number | null,
  precision: number,
): { stop: number | null; target: number | null } {
  const mirror = (p: number | null) => (p === null ? null : roundPrice(2 * entry - p, precision));
  return { stop: mirror(stop), target: mirror(target) };
}

/**
 * The stop guard as the chart applies it before asking the engine (the engine applies it again): a stop must sit at
 * least `minMultiple` × ATR from the entry, on the loss side. Null = fine; otherwise why not.
 */
export function stopGuardProblem(
  direction: TicketDirection,
  entry: number | null,
  stop: number | null,
  atr: number | null,
  minMultiple: number,
  precision: number,
): string | null {
  if (stop === null) return 'Set a stop loss: manual trades are refused without one.';
  if (entry === null) return null;
  const wrong = direction === 'Buy' ? stop >= entry : stop <= entry;
  if (wrong) return `The stop must be ${direction === 'Buy' ? 'below' : 'above'} the entry.`;
  if (atr === null || !(atr > 0)) return null;
  const distance = Math.abs(entry - stop);
  // A tenth of a point of slack: prices are binary floats here (decimals in the engine), and a stop placed exactly
  // on the guard must not read as inside it.
  const slack = 10 ** -(Math.max(0, precision) + 1);
  if (distance + slack < atr * minMultiple) {
    const closest = direction === 'Buy' ? entry - atr * minMultiple : entry + atr * minMultiple;
    return (
      `The stop is ${(distance / atr).toFixed(2)} ATR from the entry; it must be at least ${minMultiple} ATR ` +
      `(${direction === 'Buy' ? 'at or below' : 'at or above'} ${closest.toFixed(precision)}) to survive ordinary noise.`
    );
  }
  return null;
}

/** The first blocking gate that failed, or null. */
export function firstRefusal(gates: readonly TradeGate[]): TradeGate | null {
  return gates.find((g) => g.blocking && !g.passed) ?? null;
}

const GREEN = '#26A69A';
const RED = '#EF5350';
const BLUE = '#2962FF';

/** The ticket's brackets as draggable chart lines; the entry only when it is not at market. */
export function ticketLines(
  state: TicketState,
  entry: number | null,
  pip: number,
  preview: ManualTradePreview | null,
): TradeLine[] {
  const lines: TradeLine[] = [];
  const pips = (p: number) => (entry !== null && pip > 0 ? Math.abs(p - entry) / pip : null);
  const side = state.direction === 'Buy' ? 'BUY' : 'SELL';
  if (!state.atMarket && state.entry !== null)
    lines.push({
      key: 'ticket:entry',
      kind: 'ticketEntry',
      price: state.entry,
      label: `${side} at`,
      color: BLUE,
      draggable: true,
      drawn: true,
    });
  if (state.stop !== null) {
    const p = pips(state.stop);
    const money =
      preview?.riskMoney != null
        ? ` · −${preview.riskMoney.toFixed(2)} ${preview.account.currency}`
        : '';
    lines.push({
      key: 'ticket:stop',
      kind: 'ticketStop',
      price: state.stop,
      label: `${side} SL${p !== null ? ` ${p.toFixed(1)}p` : ''}${money}`,
      color: RED,
      draggable: true,
      drawn: true,
    });
  }
  if (state.target !== null) {
    const p = pips(state.target);
    const rr = preview?.rewardRisk != null ? ` · ${preview.rewardRisk.toFixed(2)}R` : '';
    lines.push({
      key: 'ticket:target',
      kind: 'ticketTarget',
      price: state.target,
      label: `${side} TP${p !== null ? ` ${p.toFixed(1)}p` : ''}${rr}`,
      color: GREEN,
      draggable: true,
      drawn: true,
    });
  }
  return lines;
}

/** A dragged ticket line, applied to the ticket. */
export function moveTicketLine(
  state: TicketState,
  kind: TradeLine['kind'],
  price: number,
): TicketState {
  switch (kind) {
    case 'ticketEntry':
      return { ...state, atMarket: false, entry: price };
    case 'ticketStop':
      return { ...state, stop: price };
    case 'ticketTarget':
      return { ...state, target: price };
    default:
      return state;
  }
}
