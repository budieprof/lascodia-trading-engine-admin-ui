import { describe, expect, it } from 'vitest';

import type { InstrumentDto } from '@core/instruments/instrument.types';
import type { VenueRoute } from '@features/venues/venues.types';

import {
  routeBadgeText,
  routeKey,
  routeLine,
  routeSendBlock,
  routeStateOf,
  withRouteTerms,
  type RouteInput,
} from './venue-route';

const BTC: InstrumentDto = {
  symbol: 'BTC-USD',
  assetClass: 'Crypto',
  exchange: 'BINANCE',
  description: null,
  quoteCurrency: 'USD',
  tickSize: 0.01,
  tickValue: 0.01,
  multiplier: 1,
  quantityUnit: 'Coins',
  quantityStep: 0.00001,
  minQuantity: 0.00001,
  maxQuantity: 0,
  priceDecimals: 2,
  displayDistance: 'Bps',
  tradingCalendarCode: 'crypto-24x7',
  status: 'Active',
  minNotional: 5,
  timeInForce: ['Gtc', 'Ioc', 'Fok'],
};

function route(p: Partial<VenueRoute> = {}): VenueRoute {
  return {
    symbol: 'BTC-USD',
    kind: 'venue',
    routable: true,
    reason: null,
    exchangeTraded: true,
    executionAccountId: 7,
    executionAccountName: 'Coinbase main',
    adapterKind: 'coinbase',
    mode: 'Live',
    venue: 'coinbase',
    venueName: 'Coinbase',
    venueSymbol: 'BTC-USD',
    venueTickSize: 0.01,
    venueQuantityStep: 0.00000001,
    venueMinQuantity: 0.00000001,
    minNotional: 1,
    minNotionalCurrency: 'USD',
    fractionable: null,
    timeInForce: ['Gtc', 'Ioc'],
    candidates: [],
    ...p,
  };
}

const base: RouteInput = { exchangeTraded: true, hasAccount: true, permitted: true, answer: null, error: null };

describe('venue route (FR01)', () => {
  it('resolving: asked, not yet answered — no venue is named', () => {
    const s = routeStateOf(base);
    expect(s.kind).toBe('resolving');
    expect(routeBadgeText(s)).toBe('Route: resolving…');
    expect(routeSendBlock(s)).toMatch(/Waiting for the engine/);
  });

  it('MT5: an FX / CFD symbol keeps "MT5 broker" and is never asked', () => {
    const s = routeStateOf({ ...base, exchangeTraded: false });
    expect(routeBadgeText(s)).toBe('MT5 broker');
    expect(routeStateOf({ ...base, answer: route({ kind: 'mt5', routable: true }) }).kind).toBe('mt5');
  });

  it('routed venue: the engine\'s venue and venue symbol, never the catalogue exchange', () => {
    const s = routeStateOf({ ...base, answer: route() });
    expect(s.kind).toBe('venue');
    expect(routeBadgeText(s)).toBe('Routes to Coinbase · BTC-USD');
    expect(routeBadgeText(s)).not.toContain('Binance');
    expect(routeLine(s)).toBe('Routes to Coinbase · BTC-USD — venue account Coinbase main');
    expect(routeSendBlock(s)).toBeNull();
    expect(routeBadgeText(routeStateOf({ ...base, answer: route({ mode: 'Paper' }) }))).toBe(
      'Routes to Coinbase · BTC-USD (paper)',
    );
  });

  it('no route: says so with the engine\'s reason, and blocks the send', () => {
    const reason = 'Execution account 7 is Disabled: activate and verify it first.';
    const s = routeStateOf({ ...base, answer: route({ kind: 'none', routable: false, reason }) });
    expect(s.kind).toBe('none');
    expect(routeBadgeText(s)).toBe('No route for this account');
    expect(routeLine(s)).toBe(`No route for this account (${reason})`);
    expect(routeSendBlock(s)).toBe(`No route for this account: ${reason}`);
  });

  it('a named account that would route while venue routing is switched off is still "no route"', () => {
    const s = routeStateOf({
      ...base,
      answer: route({ routable: false, reason: 'Venue routing is switched off (Execution:Router:Enabled = false).' }),
    });
    expect(s.kind).toBe('none');
    expect(routeLine(s)).toContain('switched off');
  });

  it('no account / no permission / no answer: plain words, never a guessed venue', () => {
    expect(routeLine(routeStateOf({ ...base, hasAccount: false }))).toMatch(/^No route for this account \(choose an account/);
    expect(routeLine(routeStateOf({ ...base, permitted: false }))).toMatch(/^Route unknown \(.*accounts\.read/);
    expect(routeLine(routeStateOf({ ...base, error: 'HTTP 500' }))).toBe(
      'Route unknown (the engine did not answer: HTTP 500)',
    );
  });

  it('FR02-FR04: the ticket checks the ROUTED venue\'s minimum, TIF set and minimum quantity', () => {
    const t = withRouteTerms(BTC, routeStateOf({ ...base, answer: route({ venueMinQuantity: 0.0001 }) }));
    expect(t.minNotional).toBe(1);                  // Coinbase's, not the catalogue row's Binance 5
    expect(t.timeInForce).toEqual(['Gtc', 'Ioc']);  // the routed adapter's set
    expect(t.minQuantity).toBe(0.0001);             // the larger minimum (refuse more)
    const noMin = withRouteTerms(BTC, routeStateOf({ ...base, answer: route({ minNotional: null, timeInForce: [] }) }));
    expect(noMin.minNotional).toBeNull();           // the venue publishes none → no check
    expect(noMin.timeInForce).toEqual(['Gtc', 'Ioc', 'Fok']);
    // No route: the catalogue row stays as it is.
    expect(withRouteTerms(BTC, routeStateOf({ ...base, hasAccount: false }))).toBe(BTC);
  });

  it('FR03: a broker that cannot send fractions wins over an unknown listing', () => {
    const aapl = { ...BTC, symbol: 'AAPL', assetClass: 'Equity', fractionable: null } as InstrumentDto;
    expect(withRouteTerms(aapl, routeStateOf({ ...base, answer: route({ fractionable: false }) })).fractionable).toBe(false);
  });

  it('the question key changes with the symbol and either account', () => {
    expect(routeKey('btc-usd', 3, null)).toBe('BTC-USD|3|');
    expect(routeKey('BTC-USD', 3, 7)).not.toBe(routeKey('BTC-USD', 3, null));
  });
});
