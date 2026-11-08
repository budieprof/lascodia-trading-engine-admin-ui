import type { InstrumentDto } from '@core/instruments/instrument.types';
import type { VenueRoute } from '@features/venues/venues.types';

/**
 * FR01 (multi-asset chart program, follow-up wave): what the venue ticket and the DOM ladder say about where an order
 * would ACTUALLY route — the engine's own answer (`GET execution-console/route`) for the selected account, never the
 * catalogue's exchange. Pure decisions; the components only fetch and render.
 */
export type RouteState =
  /** Waiting for the engine's answer (or for the instrument to resolve). */
  | { kind: 'resolving' }
  /** An FX / CFD symbol: the account's MT5 broker (today's ticket and ladder, unchanged). */
  | { kind: 'mt5' }
  /** Routed now to this venue account. */
  | { kind: 'venue'; route: VenueRoute }
  /** No route for this account, in the engine's words (`route` = the answer, when there was one). */
  | { kind: 'none'; reason: string; route: VenueRoute | null }
  /** The route could not be asked (no permission, the engine did not answer): unknown, never guessed. */
  | { kind: 'unknown'; reason: string };

export interface RouteInput {
  /** The symbol is exchange-traded (a venue instrument); false = MT5 symbol. */
  exchangeTraded: boolean;
  /** The trading / execution account the answer is for has been chosen. */
  hasAccount: boolean;
  /** The caller may ask (`accounts.read`). */
  permitted: boolean;
  /** The engine's answer for the CURRENT symbol + account (null while asking / not asked). */
  answer: VenueRoute | null;
  /** The request failed (message), else null. */
  error: string | null;
}

export function routeStateOf(i: RouteInput): RouteState {
  if (!i.exchangeTraded) return { kind: 'mt5' };
  if (!i.hasAccount)
    return { kind: 'none', reason: 'choose an account to see where its orders would route', route: null };
  if (!i.permitted)
    return { kind: 'unknown', reason: 'asking where an order routes needs the accounts.read permission' };
  if (i.error !== null) return { kind: 'unknown', reason: `the engine did not answer: ${i.error}` };
  if (!i.answer) return { kind: 'resolving' };
  const a = i.answer;
  if (a.kind === 'mt5' && a.routable) return { kind: 'mt5' };
  if (a.kind === 'venue' && a.routable) return { kind: 'venue', route: a };
  return { kind: 'none', reason: a.reason ?? 'the engine names no route', route: a };
}

/** The short badge: "Routes to Coinbase · BTC-USD", "No route for this account", "MT5 broker", "Route: resolving…". */
export function routeBadgeText(s: RouteState): string {
  switch (s.kind) {
    case 'venue': {
      const r = s.route;
      const where = r.venueName || r.venue || 'venue';
      const paper = (r.mode ?? '').toLowerCase() === 'paper' ? ' (paper)' : '';
      return `Routes to ${where}${r.venueSymbol ? ' · ' + r.venueSymbol : ''}${paper}`;
    }
    case 'mt5':
      return 'MT5 broker';
    case 'none':
      return 'No route for this account';
    case 'unknown':
      return 'Route unknown';
    default:
      return 'Route: resolving…';
  }
}

/** The badge with its reason: "No route for this account (Coinbase main is Disabled: …)". */
export function routeLine(s: RouteState): string {
  const badge = routeBadgeText(s);
  if (s.kind === 'none' || s.kind === 'unknown') return `${badge} (${s.reason})`;
  if (s.kind === 'venue' && s.route.executionAccountName)
    return `${badge} — venue account ${s.route.executionAccountName}`;
  return badge;
}

/** Why a venue ticket may not be sent because of its route (null = the route is fine). */
export function routeSendBlock(s: RouteState): string | null {
  switch (s.kind) {
    case 'venue':
      return null;
    case 'resolving':
      return 'Waiting for the engine to say where this order would route.';
    case 'mt5':
      return 'This symbol routes to the MT5 broker: use the FX / CFD ticket.';
    default:
      return `${routeBadgeText(s)}: ${s.reason}.`.replace(/\.\.$/, '.');
  }
}

/**
 * The instrument as the ROUTED venue trades it, for the ticket's own checks (FR02-FR04): that venue's minimum order value
 * (null = it publishes none → no check), the routed adapter's time-in-force set, the routed broker's fractional answer,
 * and the venue minimum quantity when it is larger. Only refuses more: a missing route keeps the catalogue row as it is.
 */
export function withRouteTerms(inst: InstrumentDto, s: RouteState): InstrumentDto {
  if (s.kind !== 'venue') return inst;
  const r = s.route;
  const venueMin = r.venueMinQuantity ?? 0;
  return {
    ...inst,
    minNotional: r.minNotional,
    timeInForce: r.timeInForce.length > 0 ? r.timeInForce : (inst.timeInForce ?? []),
    fractionable: r.fractionable ?? inst.fractionable ?? null,
    minQuantity: Math.max(inst.minQuantity, venueMin),
  };
}

/** The request key of a route question (a changed key = a new question; an old answer is never shown for it). */
export function routeKey(
  symbol: string,
  tradingAccountId: number | null,
  executionAccountId: number | null,
): string {
  return `${symbol.trim().toUpperCase()}|${tradingAccountId ?? ''}|${executionAccountId ?? ''}`;
}
