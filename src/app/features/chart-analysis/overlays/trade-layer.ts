import type { OrderDto, PositionDto } from '@core/api/api.types';
import type { ChartMarker } from '../chart/chart-host.component';
import type { PriceOverlay } from './overlay-renderer';

/**
 * The chart's trade layer (CC-09, CC-10, CC-I3) — the pure half: the lines a symbol's open
 * positions and working orders draw, a position's live P&L, and the fill markers of closed trades.
 * The page fetches; nothing here touches the engine.
 */

/** A position as the chart reads it: the engine sends the opening stop and the close price since CC-I3. */
export type ChartPosition = PositionDto & {
  initialStopLoss?: number | null;
  closePrice?: number | null;
};

const GREEN = '#26A69A';
const RED = '#EF5350';
/** Paper fills are drawn in their own colour: they never reached a broker. */
const PAPER = '#7E57C2';

const isLong = (direction: unknown) =>
  String(direction).toLowerCase().includes('buy') || String(direction).toLowerCase() === 'long';

/** The live quote the P&L is read at: a long exits at the bid, a short at the ask. */
export interface LiveQuote {
  bid: number;
  ask: number | null;
}

/** A position's open P&L at the live quote. */
export interface PositionPnl {
  pips: number;
  /** In multiples of the risk it opened with (entry → initial stop); null without an opening stop. */
  r: number | null;
  /**
   * In the account's currency, estimated from the engine's last reading of the position (its
   * money per price unit at its own current price) — null when that reading is too close to the entry
   * to scale from, or absent.
   */
  money: number | null;
}

/**
 * The P&L of `p` at `quote`. Exit side of the book: a long closes at the bid, a short at the ask
 * (the bid when no ask is known). `pip` in price.
 */
export function positionPnl(p: ChartPosition, quote: LiveQuote, pip: number): PositionPnl {
  const long = isLong(p.direction);
  const exit = long ? quote.bid : (quote.ask ?? quote.bid);
  const move = (exit - p.averageEntryPrice) * (long ? 1 : -1);
  const pips = pip > 0 ? move / pip : 0;
  const stop = p.initialStopLoss ?? null;
  const risk = stop !== null && stop !== undefined ? Math.abs(p.averageEntryPrice - stop) : 0;
  const r = risk > 0 ? move / risk : null;
  let money: number | null = null;
  const enginePrice = p.currentPrice;
  if (enginePrice !== null && enginePrice !== undefined && Number.isFinite(p.unrealizedPnL)) {
    const engineMove = (enginePrice - p.averageEntryPrice) * (long ? 1 : -1);
    // A reading half a pip from the entry is mostly spread and rounding: scaling from it is noise.
    if (Math.abs(engineMove) >= pip * 0.5) money = (p.unrealizedPnL * move) / engineMove;
  }
  return { pips, r, money };
}

/** "+12.4 pips · +0.62R · ≈ +12.40 USD" (the money part only when known). */
export function pnlText(pnl: PositionPnl, currency: string | null): string {
  const sign = (v: number) => (v >= 0 ? '+' : '−');
  const parts = [`${sign(pnl.pips)}${Math.abs(pnl.pips).toFixed(1)} pips`];
  if (pnl.r !== null) parts.push(`${sign(pnl.r)}${Math.abs(pnl.r).toFixed(2)}R`);
  if (pnl.money !== null)
    parts.push(
      `≈ ${sign(pnl.money)}${Math.abs(pnl.money).toFixed(2)}${currency ? ` ${currency}` : ''}`,
    );
  return parts.join(' · ');
}

/**
 * The lines open positions draw: entry (with its live P&L when a quote is known), stop, target.
 * Only `symbol`'s positions in the account scope — re-checked here: an engine that drops a filter
 * answers with the whole table, and another account's stop on this chart is a wrong chart.
 */
export function positionLines(
  rows: readonly ChartPosition[],
  symbol: string,
  inScope: (accountId: number | null | undefined) => boolean,
  quote: LiveQuote | null,
  pip: number,
  currencyOf: (accountId: number) => string | null,
): PriceOverlay[] {
  const out: PriceOverlay[] = [];
  for (const p of rows) {
    if ((p.symbol ?? '').toUpperCase() !== symbol.toUpperCase() || !inScope(p.tradingAccountId))
      continue;
    const long = isLong(p.direction);
    const lots = p.openLots || p.tradedLots || 0;
    const pnl = quote ? positionPnl(p, quote, pip) : null;
    out.push({
      kind: 'entry',
      price: p.averageEntryPrice,
      label: `${p.isPaper ? 'PAPER ' : ''}${long ? 'LONG' : 'SHORT'} ${lots.toFixed(2)}`,
      color: long ? GREEN : RED,
      ...(pnl ? { pnl: pnlText(pnl, currencyOf(p.tradingAccountId)), pnlUp: pnl.pips >= 0 } : {}),
    });
    if (p.stopLoss) out.push({ kind: 'stop', price: p.stopLoss, label: 'SL', color: RED });
    if (p.takeProfit) out.push({ kind: 'target', price: p.takeProfit, label: 'TP', color: GREEN });
  }
  return out;
}

/**
 * The lines working orders draw: only orders that can still fill. A filled order is already a
 * position and is drawn as one; a cancelled one is history.
 */
export function orderLines(
  rows: readonly OrderDto[],
  symbol: string,
  inScope: (accountId: number | null | undefined) => boolean,
): PriceOverlay[] {
  const out: PriceOverlay[] = [];
  for (const o of rows) {
    if (
      (o.symbol ?? '').toUpperCase() !== symbol.toUpperCase() ||
      !inScope(o.tradingAccountId) ||
      !['Pending', 'Submitted', 'PartialFill'].includes(String(o.status))
    )
      continue;
    const buy = String(o.orderType) === 'Buy';
    out.push({
      kind: 'order',
      price: o.price,
      label: `${String(o.executionType).toUpperCase()} ${buy ? 'BUY' : 'SELL'} ${o.quantity}`,
      color: buy ? GREEN : RED,
    });
    if (o.stopLoss) out.push({ kind: 'stop', price: o.stopLoss, label: 'O·SL', color: RED });
    if (o.takeProfit)
      out.push({ kind: 'target', price: o.takeProfit, label: 'O·TP', color: GREEN });
  }
  return out;
}

/**
 * Fill markers of closed trades (CC-I3): the entry under (long) / over (short) the bar it opened on,
 * the exit on the other side of the bar it closed on, with its result in pips when the close price is
 * known. Paper trades are drawn in their own colour and say "paper": they never reached a broker.
 */
export function closedTradeMarkers(
  rows: readonly ChartPosition[],
  symbol: string,
  inScope: (accountId: number | null | undefined) => boolean,
  pip: number,
): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const p of rows) {
    if ((p.symbol ?? '').toUpperCase() !== symbol.toUpperCase() || !inScope(p.tradingAccountId))
      continue;
    const opened = Date.parse(p.openedAt ?? '');
    const closed = Date.parse(p.closedAt ?? '');
    if (!Number.isFinite(opened)) continue;
    const long = isLong(p.direction);
    const tag = p.isPaper ? 'paper ' : '';
    const entryColor = p.isPaper ? PAPER : long ? GREEN : RED;
    out.push({
      time: opened,
      position: long ? 'belowBar' : 'aboveBar',
      shape: long ? 'arrowUp' : 'arrowDown',
      color: entryColor,
      text: `${tag}${long ? 'Buy' : 'Sell'} ${p.averageEntryPrice}`,
    });
    if (!Number.isFinite(closed)) continue;
    const exit = p.closePrice ?? null;
    const pips =
      exit !== null && pip > 0 ? ((exit - p.averageEntryPrice) * (long ? 1 : -1)) / pip : null;
    const won = pips !== null ? pips >= 0 : p.realizedPnL >= 0;
    out.push({
      time: closed,
      position: long ? 'aboveBar' : 'belowBar',
      shape: 'circle',
      color: p.isPaper ? PAPER : won ? GREEN : RED,
      text:
        pips !== null
          ? `${tag}exit ${pips >= 0 ? '+' : '−'}${Math.abs(pips).toFixed(1)}p`
          : `${tag}exit`,
    });
  }
  return out;
}

/**
 * Whether a realtime trade event concerns this chart: its symbol, when it names one (an event that
 * names none may concern anything, so it counts).
 */
export function concernsSymbol(payload: unknown, symbol: string): boolean {
  const s = (payload as { symbol?: unknown } | null)?.symbol;
  return typeof s !== 'string' || !s || s.toUpperCase() === symbol.toUpperCase();
}
