import type { InstrumentFacts } from '../datafeed/instrument-facts';

/**
 * Whether the chart offers the AI's DIRECTED proposals (limit / stop on a side) for the symbol, and how their prices
 * are put on the instrument's grid (UA09). A directed proposal ends in an order ticket, so it is offered only where an
 * order can be placed: a symbol the MT5 broker lists (its pair row), or an exchange-traded instrument with a venue
 * ticket that is not expired or halted. A guessed symbol, an engine instrument no broker lists, an expired future or a
 * symbol still being resolved gets the spot analysis only — with the reason. Pure.
 */

export interface ProposeGate {
  allowed: boolean;
  /** Why the directed proposals are not offered (null when they are). */
  reason: string | null;
}

const ACTIVE = /^(active|trading|open|tradable|tradeable)$/i;

export function proposeGate(facts: InstrumentFacts | null | undefined, nowMs: number): ProposeGate {
  // No facts (a chart before UI01 wiring): unchanged — offered.
  if (!facts) return { allowed: true, reason: null };
  const sym = facts.symbol.toUpperCase();
  if (facts.route.kind === 'resolving')
    return { allowed: false, reason: `Resolving ${sym}: proposals wait for its instrument.` };
  if (facts.origin === 'pair') return { allowed: true, reason: null };
  if (facts.route.kind === 'venue') {
    const inst = facts.route.instrument;
    const last = Date.parse(inst.future?.lastTradeDate ?? inst.future?.expiry ?? '');
    if (Number.isFinite(last) && last <= nowMs)
      return { allowed: false, reason: `${sym} has expired: it cannot be traded.` };
    if (inst.status && !ACTIVE.test(inst.status))
      return {
        allowed: false,
        reason: `${sym} is ${inst.status.toLowerCase()} on ${facts.route.name}: no orders.`,
      };
    return { allowed: true, reason: null };
  }
  if (facts.origin === 'catalogue')
    return {
      allowed: false,
      reason: `No broker or venue ticket trades ${sym}: proposals would have nowhere to go.`,
    };
  return {
    allowed: false,
    reason: `${sym} is not a known instrument: proposals need one that can be traded.`,
  };
}

/** A proposed price on the instrument's tick grid (nearest tick), at its decimals; null stays null. */
export function onTick(
  price: number | null | undefined,
  facts: InstrumentFacts | null | undefined,
): number | null {
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  if (!facts) return price;
  const tick = facts.tickSize > 0 ? facts.tickSize : 10 ** -facts.precision;
  return Number((Math.round(price / tick) * tick).toFixed(facts.precision));
}

/** The price as the panel prints it: on the tick, at the instrument's decimals; `fallback` when there is none. */
export function priceText(
  price: number | null | undefined,
  facts: InstrumentFacts | null | undefined,
  fallback: string,
): string {
  const v = onTick(price, facts);
  if (v === null) return fallback;
  return facts ? v.toFixed(facts.precision) : String(v);
}
