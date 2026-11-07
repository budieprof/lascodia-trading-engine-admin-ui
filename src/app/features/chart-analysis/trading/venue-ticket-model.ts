import type { InstrumentDto } from '@core/instruments/instrument.types';
import type {
  MarginMode,
  VenueOrderType,
  VenueTicketPreviewRequest,
  VenueTif,
} from '@features/venues/venues.types';

/**
 * The exchange-traded order ticket (multi-asset WS7 7.5) as pure data: quantity in the instrument's own unit
 * (contracts / shares / coins) on its step, prices on its tick grid, time in force, post-only / reduce-only, leverage
 * and margin mode for crypto derivatives, and the bracket as a distance in TICKS. The engine's dry run
 * (`execution-console/ticket/preview`) judges it again — these rules only say early what the engine would say.
 * FX / CFD symbols never reach this model: they keep today's ticket (`ticket-model.ts`), unchanged.
 */

export type VenueSide = 'Buy' | 'Sell';

export interface VenueTicketState {
  executionAccountId: number | null;
  side: VenueSide;
  orderType: VenueOrderType;
  quantity: number;
  price: number | null;
  stopPrice: number | null;
  tif: VenueTif;
  postOnly: boolean;
  reduceOnly: boolean;
  /** Crypto derivatives only; null = the account's setting. */
  leverage: number | null;
  marginMode: MarginMode | null;
  /** Bracket distance from the entry in ticks; null = none. */
  stopLossTicks: number | null;
  takeProfitTicks: number | null;
}

/** What kind of exchange-traded instrument the ticket is for (decides which controls it shows). */
export type VenueKind = 'future' | 'crypto-spot' | 'crypto-derivative' | 'equity';

export function venueKindOf(inst: InstrumentDto): VenueKind {
  if (inst.future) return 'future';
  if (inst.crypto) return inst.crypto.kind === 'Spot' ? 'crypto-spot' : 'crypto-derivative';
  return 'equity';
}

/** Decimal places of a step (0.25 → 2, 0.001 → 3, 1 → 0). */
export function stepDecimals(step: number): number {
  if (!(step > 0)) return 0;
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** A number rounded to `decimals` without binary noise (0.1 + 0.2 → 0.3). */
export function roundTo(value: number, decimals: number): number {
  const f = 10 ** Math.max(0, Math.min(12, decimals));
  return Math.round(value * f) / f;
}

/** The nearest price on the tick grid (half up), at the instrument's decimals. */
export function snapPrice(price: number, tick: number, decimals?: number): number {
  if (!(tick > 0) || !Number.isFinite(price)) return price;
  const d = decimals ?? stepDecimals(tick);
  return roundTo(Math.round(price / tick + 1e-9) * tick, Math.max(d, stepDecimals(tick)));
}

/** The quantity floored to the step and clamped to [min, max] (max 0 = none). */
export function snapQuantity(qty: number, step: number, min: number, max: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return min > 0 ? min : step;
  const s = step > 0 ? step : 1;
  let q = roundTo(Math.floor(qty / s + 1e-9) * s, stepDecimals(s));
  if (min > 0 && q < min) q = min;
  if (max > 0 && q > max) q = roundTo(Math.floor(max / s + 1e-9) * s, stepDecimals(s));
  return q;
}

export function onGrid(value: number, step: number): boolean {
  if (!(step > 0)) return true;
  const n = value / step;
  return Math.abs(n - Math.round(n)) < 1e-7;
}

/**
 * The time-in-force choices for an order type (a market order fills now: IOC / FOK only), narrowed to what the
 * instrument's execution venue supports when it says (C2 `timeInForce`; empty / absent = unknown → not narrowed).
 */
export function tifChoices(
  orderType: VenueOrderType,
  inst?: Pick<InstrumentDto, 'timeInForce'> | null,
): VenueTif[] {
  const all: VenueTif[] = orderType === 'Market' ? ['Ioc', 'Fok'] : ['Gtc', 'Day', 'Ioc', 'Fok'];
  const venue = (inst?.timeInForce ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  return venue.length ? all.filter((t) => venue.includes(t.toLowerCase())) : all;
}

/** The entry the bracket is measured from: the order's own price, else the side's live quote. */
export function ticketEntry(
  s: Pick<VenueTicketState, 'side' | 'orderType' | 'price' | 'stopPrice'>,
  quote: { bid: number | null; ask: number | null } | null,
): number | null {
  if ((s.orderType === 'Limit' || s.orderType === 'StopLimit') && s.price && s.price > 0) return s.price;
  if (s.orderType === 'Stop' && s.stopPrice && s.stopPrice > 0) return s.stopPrice;
  const q = s.side === 'Buy' ? quote?.ask : quote?.bid;
  return q && q > 0 ? q : null;
}

/** Stop / target prices of a bracket in ticks from `entry`. */
export function bracketPrices(
  entry: number,
  side: VenueSide,
  tick: number,
  stopLossTicks: number | null,
  takeProfitTicks: number | null,
  decimals: number,
): { stopLoss: number | null; takeProfit: number | null } {
  const sign = side === 'Buy' ? 1 : -1;
  const at = (ticks: number | null, dir: number) =>
    ticks && ticks > 0 ? roundTo(entry + dir * sign * ticks * tick, Math.max(decimals, stepDecimals(tick))) : null;
  return { stopLoss: at(stopLossTicks, -1), takeProfit: at(takeProfitTicks, 1) };
}

/** Ticks between two prices (rounded to whole ticks). */
export function ticksBetween(a: number, b: number, tick: number): number {
  return tick > 0 ? Math.round(Math.abs(a - b) / tick) : 0;
}

/**
 * Money of a move of `ticks` on `qty` units. Linear: tick value × ticks × quantity, in the quote currency. Inverse
 * (coin-margined, C2 `contractType`): contracts × contract value × |1/entry − 1/(entry + ticks × tick)|, in the coin —
 * not linear in price, so it needs the entry; null without one.
 */
export function moneyForTicks(
  inst: Pick<InstrumentDto, 'tickValue'> & Partial<Pick<InstrumentDto, 'contractType' | 'multiplier' | 'tickSize'>>,
  ticks: number,
  qty: number,
  entry?: number | null,
): number | null {
  if (inst.contractType === 'Inverse') {
    const tick = inst.tickSize ?? 0;
    if (!entry || !(entry > 0) || !(tick > 0) || !(inst.multiplier && inst.multiplier > 0)) return null;
    const exit = entry + ticks * tick;
    if (!(exit > 0)) return null;
    return qty * inst.multiplier * Math.abs(1 / entry - 1 / exit);
  }
  return inst.tickValue * ticks * qty;
}

/** What the ticket checks beyond its shape: the price it is valued at and the clock (expiry). */
export interface VenueTicketContext {
  /** The price the order is valued at (its own limit / trigger, else the side's quote); null = unknown. */
  refPrice?: number | null;
  /** Now, Unix ms (tests pin it). */
  now?: number;
}

/** Days before a contract's last trade date the ticket starts warning. */
const EXPIRY_WARN_DAYS = 3;

function lastTradeMs(inst: InstrumentDto): number | null {
  const d = inst.future?.lastTradeDate ?? inst.future?.expiry ?? null;
  if (!d) return null;
  const t = Date.parse(d.length === 10 ? `${d}T23:59:59Z` : d);
  return Number.isFinite(t) ? t : null;
}

/** The order's value in the quote currency (inverse: contracts × contract value, already in USD); null = unknown. */
export function orderNotional(s: Pick<VenueTicketState, 'quantity'>, inst: InstrumentDto, refPrice: number | null | undefined): number | null {
  if (!(s.quantity > 0)) return null;
  const mult = inst.multiplier > 0 ? inst.multiplier : 1;
  if (inst.contractType === 'Inverse') return s.quantity * mult;
  return refPrice && refPrice > 0 ? s.quantity * mult * refPrice : null;
}

/**
 * The ticket's problems, in the engine's words (blocking): its shape, and what the venue would refuse (UI06) — below
 * the minimum order value, a fractional quantity of a whole-share stock, a TIF the venue does not offer, an expired
 * futures contract. These only ever refuse MORE than the engine's dry run; the engine judges again.
 */
export function venueTicketProblems(
  s: VenueTicketState,
  inst: InstrumentDto,
  ctx: VenueTicketContext = {},
): string[] {
  const p: string[] = [];
  const kind = venueKindOf(inst);
  const step = inst.quantityStep > 0 ? inst.quantityStep : 1;
  if (!(s.quantity > 0)) p.push('Enter a quantity.');
  else {
    if (!onGrid(s.quantity, step)) p.push(`Quantity must be a multiple of ${step}.`);
    if (inst.minQuantity > 0 && s.quantity < inst.minQuantity) p.push(`The minimum is ${inst.minQuantity}.`);
    if (inst.maxQuantity > 0 && s.quantity > inst.maxQuantity) p.push(`The maximum is ${inst.maxQuantity}.`);
  }
  const needsPrice = s.orderType === 'Limit' || s.orderType === 'StopLimit';
  const needsStop = s.orderType === 'Stop' || s.orderType === 'StopLimit';
  if (needsPrice && !(s.price && s.price > 0)) p.push('A limit order needs a price.');
  if (needsStop && !(s.stopPrice && s.stopPrice > 0)) p.push('A stop order needs a trigger price.');
  if (needsPrice && s.price && !onGrid(s.price, inst.tickSize)) p.push(`Price must be on the ${inst.tickSize} tick grid.`);
  if (needsStop && s.stopPrice && !onGrid(s.stopPrice, inst.tickSize)) p.push(`Trigger must be on the ${inst.tickSize} tick grid.`);
  if (!tifChoices(s.orderType).includes(s.tif)) p.push(`${s.tif.toUpperCase()} is not offered for a ${s.orderType} order.`);
  else if (!tifChoices(s.orderType, inst).includes(s.tif))
    p.push(`${inst.exchange || 'The venue'} does not offer ${s.tif.toUpperCase()} for ${inst.symbol}.`);
  if (kind === 'equity' && inst.fractionable === false && s.quantity > 0 && !Number.isInteger(s.quantity))
    p.push(`${inst.symbol} trades in whole shares only.`);
  const minNotional = inst.minNotional ?? 0;
  const notional = minNotional > 0 ? orderNotional(s, inst, ctx.refPrice) : null;
  if (notional !== null && notional < minNotional - 1e-9)
    p.push(
      `Order value ≈ ${roundTo(notional, 2)} ${inst.quoteCurrency ?? ''} is below the venue minimum of ${minNotional} ${inst.quoteCurrency ?? ''}.`.replace(/ +\./g, '.'),
    );
  const last = kind === 'future' ? lastTradeMs(inst) : null;
  if (last !== null && (ctx.now ?? Date.now()) > last && !s.reduceOnly)
    p.push(`${inst.symbol} stopped trading (last trade ${new Date(last).toISOString().slice(0, 10)}): use the next contract.`);
  if (s.postOnly && !(s.orderType === 'Limit' && (s.tif === 'Gtc' || s.tif === 'Day')))
    p.push('Post-only needs a Limit order resting Gtc or Day.');
  if (s.reduceOnly && !(kind === 'future' || kind === 'crypto-derivative'))
    p.push('Reduce-only exists only for futures and crypto derivatives.');
  if (s.leverage !== null && kind !== 'crypto-derivative') p.push('Leverage is set only for crypto derivatives.');
  if (s.marginMode !== null && kind !== 'crypto-derivative') p.push('Margin mode is set only for crypto derivatives.');
  if (s.leverage !== null && !(s.leverage >= 1 && s.leverage <= 500)) p.push('Leverage between 1 and 500.');
  return p;
}

/**
 * What the ticket should say but not refuse (UI06): a contract close to its last trade date, a sell of a stock the
 * venue will not lend (the ticket cannot see what you hold — a sell beyond your long is refused there), a TIF list the
 * venue did not publish.
 */
export function venueTicketWarnings(
  s: VenueTicketState,
  inst: InstrumentDto,
  ctx: VenueTicketContext = {},
): string[] {
  const w: string[] = [];
  const kind = venueKindOf(inst);
  const last = kind === 'future' ? lastTradeMs(inst) : null;
  const now = ctx.now ?? Date.now();
  if (last !== null && now <= last && last - now < EXPIRY_WARN_DAYS * 86_400_000)
    w.push(`${inst.symbol} stops trading ${new Date(last).toISOString().slice(0, 10)}: consider the next contract.`);
  if (last !== null && now > last && s.reduceOnly)
    w.push(`${inst.symbol} is past its last trade date: only closing is possible, if the venue still accepts it.`);
  if (kind === 'equity' && s.side === 'Sell' && inst.equity && inst.equity.shortable === false)
    w.push(`${inst.symbol} is not shortable here: a sell can only close shares you hold.`);
  if (kind === 'equity' && inst.fractionable == null && s.quantity > 0 && !Number.isInteger(s.quantity))
    w.push(`Whether ${inst.symbol} takes fractional shares is not known: the venue may refuse ${s.quantity}.`);
  if (inst.contractType === 'Inverse')
    w.push(`Inverse contract: P&L and margin are in ${inst.crypto?.settleAsset || inst.baseCurrency || 'the coin'}, one contract = ${inst.multiplier} ${inst.quoteCurrency ?? ''}.`.trim());
  return w;
}

export function defaultVenueTicket(inst: InstrumentDto, side: VenueSide = 'Buy'): VenueTicketState {
  const step = inst.quantityStep > 0 ? inst.quantityStep : 1;
  return {
    executionAccountId: null,
    side,
    orderType: 'Limit',
    quantity: inst.minQuantity > 0 ? inst.minQuantity : step,
    price: null,
    stopPrice: null,
    tif: tifChoices('Limit', inst)[0] ?? 'Gtc',
    postOnly: false,
    reduceOnly: false,
    leverage: null,
    marginMode: null,
    stopLossTicks: null,
    takeProfitTicks: null,
  };
}

/** A ticket change that keeps it valid where a choice depends on another (market → IOC, post-only off, …). */
export function patchVenueTicket(
  s: VenueTicketState,
  patch: Partial<VenueTicketState>,
  inst?: Pick<InstrumentDto, 'timeInForce'> | null,
): VenueTicketState {
  const next = { ...s, ...patch };
  const tifs = tifChoices(next.orderType, inst);
  if (!tifs.includes(next.tif) && tifs.length) next.tif = tifs[0];
  if (next.postOnly && next.orderType !== 'Limit') next.postOnly = false;
  if (next.orderType === 'Market') {
    next.price = null;
    next.stopPrice = null;
  }
  if (next.orderType === 'Limit') next.stopPrice = null;
  if (next.orderType === 'Stop') next.price = null;
  return next;
}

export function previewRequestOf(symbol: string, s: VenueTicketState): VenueTicketPreviewRequest {
  return {
    executionAccountId: s.executionAccountId,
    symbol,
    side: s.side,
    orderType: s.orderType,
    quantity: s.quantity,
    price: s.orderType === 'Limit' || s.orderType === 'StopLimit' ? s.price : null,
    stopPrice: s.orderType === 'Stop' || s.orderType === 'StopLimit' ? s.stopPrice : null,
    timeInForce: s.tif,
    postOnly: s.postOnly,
    reduceOnly: s.reduceOnly,
    leverage: s.leverage,
    marginMode: s.marginMode,
    stopLossTicks: s.stopLossTicks,
    takeProfitTicks: s.takeProfitTicks,
  };
}

/** A ladder click / chart prefill as a ticket change (price on the grid; Stop orders take the trigger). */
export function prefillPatch(
  inst: InstrumentDto,
  p: { side: VenueSide; orderType: VenueOrderType; price: number | null },
): Partial<VenueTicketState> {
  const price = p.price === null ? null : snapPrice(p.price, inst.tickSize, inst.priceDecimals);
  if (p.orderType === 'Stop') return { side: p.side, orderType: 'Stop', stopPrice: price, price: null, postOnly: false };
  if (p.orderType === 'Market') return { side: p.side, orderType: 'Market', price: null, stopPrice: null, tif: 'Ioc', postOnly: false };
  return { side: p.side, orderType: p.orderType, price, stopPrice: null };
}
