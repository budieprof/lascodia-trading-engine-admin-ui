import type { TicketDirection } from '../trading/manual-trading.types';

/**
 * The price ladder (DOM) — pure half. A FIXED price grid centred on the market (it does not scroll with every tick;
 * the operator re-centres), one row per `rowTicks` points: the broker book's size on each side, my working orders and
 * pending manual signals, my position's average, and the session's tick count at each price. Plus what a click on a
 * row means as an order (side and kind from the column and the stop modifier, checked against the market) and the
 * OCO bracket builder's two legs.
 */

export interface LadderOrder {
  /** Order id, or the signal id of a manual signal the EA has not placed yet (`isSignal`). */
  id: number;
  isSignal: boolean;
  direction: TicketDirection;
  price: number;
  lots: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** "Limit" / "Stop" / "signal"… for the chip. */
  kind: string;
  status: string;
  /** The OCO pair it is a leg of. */
  ocoGroupId: number | null;
}

export interface LadderPosition {
  direction: TicketDirection;
  price: number;
  lots: number;
}

export interface LadderRow {
  /** Row index on the grid (price ≈ index × rowSize). */
  index: number;
  price: number;
  bidSize: number;
  askSize: number;
  /** Size as a share of the largest level in view (bar width, 0–1). */
  bidShare: number;
  askShare: number;
  bestBid: boolean;
  bestAsk: boolean;
  /** Strictly between the best bid and best ask. */
  inSpread: boolean;
  buys: LadderOrder[];
  sells: LadderOrder[];
  positions: LadderPosition[];
  /** Session ticks at this price (tick count — MT5 FX feeds carry no traded volume). */
  ticks: number;
  tickShare: number;
}

export interface LadderGrid {
  /** Price of one row: `rowTicks` points. */
  rowSize: number;
  /** Row index at the vertical centre. */
  centerIndex: number;
  /** Rows above and below the centre. */
  halfRows: number;
}

/** One point of the symbol (the smallest price step): 10^-digits. */
export function pointSize(digits: number): number {
  return 10 ** -Math.max(0, Math.min(10, Math.trunc(digits)));
}

/** A pip: 10 points on 5- and 3-digit symbols, else one point. */
export function pipSizeOf(digits: number): number {
  return digits === 5 || digits === 3 ? pointSize(digits - 1) : pointSize(digits);
}

/** Row index of `price` on a grid of `rowSize` (prices are binary floats: a tiny epsilon keeps x.5 rows stable). */
export function rowIndex(price: number, rowSize: number): number {
  return Math.floor(price / rowSize + 1e-7);
}

/** The price a row stands for, rounded to the symbol's digits. */
export function rowPrice(index: number, rowSize: number, digits: number): number {
  const f = 10 ** Math.max(0, Math.min(10, digits));
  return Math.round(index * rowSize * f) / f;
}

/** The centre row for the market now: the mid of the best prices, else whichever exists. */
export function centreIndexFor(bid: number | null, ask: number | null, rowSize: number): number | null {
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
  return mid === null || !(mid > 0) ? null : rowIndex(mid, rowSize);
}

/** True when the best prices have left the middle part of the view (auto re-centre). */
export function needsRecentre(grid: LadderGrid, bid: number | null, ask: number | null, margin = 0.25): boolean {
  const idx = centreIndexFor(bid, ask, grid.rowSize);
  if (idx === null) return false;
  const limit = Math.max(1, Math.floor(grid.halfRows * (1 - margin)));
  return Math.abs(idx - grid.centerIndex) > limit;
}

/** Adds one tick per bid price to the session's count (keyed by row index of `rowSize`). */
export function addTicks(counts: Map<number, number>, bids: readonly number[], rowSize: number): void {
  for (const b of bids) {
    if (!(b > 0)) continue;
    const i = rowIndex(b, rowSize);
    counts.set(i, (counts.get(i) ?? 0) + 1);
  }
}

/** The rows in view, highest price first. */
export function buildLadder(
  grid: LadderGrid,
  digits: number,
  /** Price → size per side, as the source reports sizes (the shared hub's `BookState` fits). */
  book: { readonly bids: ReadonlyMap<number, number>; readonly asks: ReadonlyMap<number, number> } | null,
  orders: readonly LadderOrder[],
  positions: readonly LadderPosition[],
  tickCounts: ReadonlyMap<number, number>,
  /** The tick counts' own grid (points); re-binned to this grid's rows. */
  tickRowSize: number,
): LadderRow[] {
  const { rowSize, centerIndex, halfRows } = grid;
  const top = centerIndex + halfRows;
  const bottom = centerIndex - halfRows;
  const bidSizes = new Map<number, number>();
  const askSizes = new Map<number, number>();
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  if (book) {
    for (const [p, s] of book.bids) {
      if (bestBid === null || p > bestBid) bestBid = p;
      const i = rowIndex(p, rowSize);
      if (i >= bottom && i <= top) bidSizes.set(i, (bidSizes.get(i) ?? 0) + s);
    }
    for (const [p, s] of book.asks) {
      if (bestAsk === null || p < bestAsk) bestAsk = p;
      const i = rowIndex(p, rowSize);
      if (i >= bottom && i <= top) askSizes.set(i, (askSizes.get(i) ?? 0) + s);
    }
  }
  const ticks = new Map<number, number>();
  for (const [ti, n] of tickCounts) {
    const i = rowIndex(ti * tickRowSize + tickRowSize / 2, rowSize);
    if (i >= bottom && i <= top) ticks.set(i, (ticks.get(i) ?? 0) + n);
  }
  let maxSize = 0;
  for (const v of bidSizes.values()) maxSize = Math.max(maxSize, v);
  for (const v of askSizes.values()) maxSize = Math.max(maxSize, v);
  let maxTicks = 0;
  for (const v of ticks.values()) maxTicks = Math.max(maxTicks, v);

  const bestBidIdx = bestBid === null ? null : rowIndex(bestBid, rowSize);
  const bestAskIdx = bestAsk === null ? null : rowIndex(bestAsk, rowSize);
  const rows: LadderRow[] = [];
  for (let i = top; i >= bottom; i--) {
    const bid = bidSizes.get(i) ?? 0;
    const ask = askSizes.get(i) ?? 0;
    const n = ticks.get(i) ?? 0;
    rows.push({
      index: i,
      price: rowPrice(i, rowSize, digits),
      bidSize: bid,
      askSize: ask,
      bidShare: maxSize > 0 ? bid / maxSize : 0,
      askShare: maxSize > 0 ? ask / maxSize : 0,
      bestBid: bestBidIdx === i,
      bestAsk: bestAskIdx === i,
      inSpread: bestBidIdx !== null && bestAskIdx !== null && i > bestBidIdx && i < bestAskIdx,
      buys: orders.filter((o) => o.direction === 'Buy' && rowIndex(o.price, rowSize) === i),
      sells: orders.filter((o) => o.direction === 'Sell' && rowIndex(o.price, rowSize) === i),
      positions: positions.filter((p) => rowIndex(p.price, rowSize) === i),
      ticks: n,
      tickShare: maxTicks > 0 ? n / maxTicks : 0,
    });
  }
  return rows;
}

// ── What a click means ──────────────────────────────────────────────────────

export type LadderColumn = 'bid' | 'ask';

export interface LadderIntent {
  direction: TicketDirection;
  kind: 'Limit' | 'Stop';
  price: number;
}

/**
 * A click in the bid column buys at that price (a buy LIMIT: below the ask); in the ask column it sells (a sell LIMIT:
 * above the bid). With the stop modifier (Shift) the bid column places a sell STOP (below the bid) and the ask column a
 * buy STOP (above the ask). The engine (and the EA) decide limit vs stop from the price against the market, so a price
 * on the wrong side is refused here with the reason rather than silently becoming the other kind.
 */
export function ladderIntent(
  column: LadderColumn,
  price: number,
  bestBid: number | null,
  bestAsk: number | null,
  stop: boolean,
): LadderIntent | { problem: string } {
  if (!(price > 0)) return { problem: 'No price.' };
  if (bestBid === null || bestAsk === null)
    return { problem: 'No live bid and ask: an order cannot be placed against an unknown market.' };
  if (!stop) {
    if (column === 'bid')
      return price < bestAsk
        ? { direction: 'Buy', kind: 'Limit', price }
        : { problem: `A buy limit must be below the ask (${bestAsk}). Hold Shift in the ask column for a buy stop above the market.` };
    return price > bestBid
      ? { direction: 'Sell', kind: 'Limit', price }
      : { problem: `A sell limit must be above the bid (${bestBid}). Hold Shift in the bid column for a sell stop below the market.` };
  }
  if (column === 'ask')
    return price > bestAsk
      ? { direction: 'Buy', kind: 'Stop', price }
      : { problem: `A buy stop must be above the ask (${bestAsk}).` };
  return price < bestBid
    ? { direction: 'Sell', kind: 'Stop', price }
    : { problem: `A sell stop must be below the bid (${bestBid}).` };
}

/** Whether a dragged working order may be dropped at `price` (it keeps its side and kind; the engine checks again). */
export function dropProblem(
  order: Pick<LadderOrder, 'direction' | 'kind'>,
  price: number,
  bestBid: number | null,
  bestAsk: number | null,
): string | null {
  if (bestBid === null || bestAsk === null) return 'No live bid and ask.';
  const buy = order.direction === 'Buy';
  const stop = order.kind.toLowerCase().includes('stop');
  if (buy && !stop && !(price < bestAsk)) return `A buy limit must stay below the ask (${bestAsk}).`;
  if (buy && stop && !(price > bestAsk)) return `A buy stop must stay above the ask (${bestAsk}).`;
  if (!buy && !stop && !(price > bestBid)) return `A sell limit must stay above the bid (${bestBid}).`;
  if (!buy && stop && !(price < bestBid)) return `A sell stop must stay below the bid (${bestBid}).`;
  return null;
}

// ── Brackets and the OCO builder ────────────────────────────────────────────

/** The ladder's bracket defaults (the ticket's: 1.5 ATR stop, 2R target). */
export interface BracketDefaults {
  stopAtr: number;
  targetR: number;
}

/** Stop and target around an entry from the ATR and the defaults; null without a usable ATR. */
export function ladderBrackets(
  direction: TicketDirection,
  entry: number,
  atr: number | null,
  defaults: BracketDefaults,
  digits: number,
): { stopLoss: number; takeProfit: number | null } | null {
  if (!(entry > 0) || atr === null || !(atr > 0) || !(defaults.stopAtr > 0)) return null;
  const f = 10 ** Math.max(0, digits);
  const round = (p: number) => Math.round(p * f) / f;
  const risk = atr * defaults.stopAtr;
  const sign = direction === 'Buy' ? 1 : -1;
  return {
    stopLoss: round(entry - sign * risk),
    takeProfit: defaults.targetR > 0 ? round(entry + sign * risk * defaults.targetR) : null,
  };
}

/** Why two intents cannot be an OCO pair (null when they can). */
export function ocoPairProblem(first: LadderIntent, second: LadderIntent): string | null {
  if (first.direction === second.direction)
    return 'An OCO pair needs one buy and one sell leg (the manual ticket refuses a second ticket on the same side while the first works).';
  if (first.price === second.price) return 'The two legs need different prices.';
  return null;
}
