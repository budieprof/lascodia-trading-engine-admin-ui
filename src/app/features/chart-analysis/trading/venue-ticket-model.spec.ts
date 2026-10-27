import { describe, expect, it } from 'vitest';

import type { InstrumentDto } from '@core/instruments/instrument.types';

import {
  bracketPrices,
  defaultVenueTicket,
  moneyForTicks,
  patchVenueTicket,
  prefillPatch,
  previewRequestOf,
  snapPrice,
  snapQuantity,
  stepDecimals,
  ticketEntry,
  tifChoices,
  venueKindOf,
  venueTicketProblems,
} from './venue-ticket-model';

const base: InstrumentDto = {
  symbol: 'ESZ6',
  assetClass: 'Future',
  exchange: 'CME',
  description: null,
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 12.5,
  multiplier: 50,
  quantityUnit: 'Contracts',
  quantityStep: 1,
  minQuantity: 1,
  maxQuantity: 100,
  priceDecimals: 2,
  displayDistance: 'Ticks',
  tradingCalendarCode: 'cme-globex',
  status: 'Active',
  future: { root: 'ES', contractCode: 'ESZ6', expiry: null, lastTradeDate: null, isFront: true, continuousSymbol: 'ES1!' },
};
const PERP: InstrumentDto = {
  ...base,
  symbol: 'BTC-USDT-PERP',
  assetClass: 'Crypto',
  exchange: 'Binance',
  quoteCurrency: 'USDT',
  tickSize: 0.1,
  tickValue: 0.1,
  multiplier: 1,
  quantityUnit: 'Coins',
  quantityStep: 0.001,
  minQuantity: 0.001,
  maxQuantity: 0,
  priceDecimals: 1,
  future: null,
  crypto: { kind: 'Perpetual', settleAsset: 'USDT', fundingIntervalHours: 8 },
};
const AAPL: InstrumentDto = {
  ...base,
  symbol: 'AAPL',
  assetClass: 'Equity',
  exchange: 'XNAS',
  tickSize: 0.01,
  tickValue: 0.01,
  multiplier: 1,
  quantityUnit: 'Shares',
  maxQuantity: 0,
  future: null,
  equity: { primaryExchange: 'XNAS', shortable: true },
};

describe('venue ticket model', () => {
  it('kinds', () => {
    expect(venueKindOf(base)).toBe('future');
    expect(venueKindOf(PERP)).toBe('crypto-derivative');
    expect(venueKindOf({ ...PERP, crypto: { kind: 'Spot', settleAsset: null, fundingIntervalHours: null } })).toBe('crypto-spot');
    expect(venueKindOf(AAPL)).toBe('equity');
  });

  it('snaps quantity to the step and price to the tick grid', () => {
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(1e-7)).toBe(7);
    expect(snapQuantity(0.0129, 0.001, 0.001, 0)).toBe(0.012);
    expect(snapQuantity(0, 1, 1, 0)).toBe(1);
    expect(snapQuantity(250, 1, 1, 100)).toBe(100);
    expect(snapPrice(6000.13, 0.25, 2)).toBe(6000.25);
    expect(snapPrice(6000.12, 0.25, 2)).toBe(6000);
    expect(snapPrice(65000.06, 0.1, 1)).toBe(65000.1);
  });

  it('brackets in ticks from the entry, per side', () => {
    expect(bracketPrices(6000, 'Buy', 0.25, 8, 16, 2)).toEqual({ stopLoss: 5998, takeProfit: 6004 });
    expect(bracketPrices(6000, 'Sell', 0.25, 8, null, 2)).toEqual({ stopLoss: 6002, takeProfit: null });
    expect(moneyForTicks(base, 8, 2)).toBe(200);
  });

  it('entry: own price, else the side’s quote', () => {
    const t = defaultVenueTicket(base);
    expect(ticketEntry({ ...t, orderType: 'Limit', price: 5990 }, { bid: 6000, ask: 6000.25 })).toBe(5990);
    expect(ticketEntry({ ...t, orderType: 'Market' }, { bid: 6000, ask: 6000.25 })).toBe(6000.25);
    expect(ticketEntry({ ...t, orderType: 'Market', side: 'Sell' }, { bid: 6000, ask: 6000.25 })).toBe(6000);
    expect(ticketEntry({ ...t, orderType: 'Market' }, null)).toBeNull();
  });

  it('mirrors the engine’s shape rules', () => {
    const ok = { ...defaultVenueTicket(PERP), price: 65000.1, postOnly: true, reduceOnly: true, leverage: 5 };
    expect(venueTicketProblems(ok, PERP)).toEqual([]);
    const bad = { ...defaultVenueTicket(AAPL), quantity: 1.5, price: 190.005, postOnly: true, tif: 'Ioc' as const, reduceOnly: true, leverage: 2 };
    const p = venueTicketProblems(bad, AAPL).join(' | ');
    expect(p).toMatch(/multiple of 1/);
    expect(p).toMatch(/tick grid/);
    expect(p).toMatch(/Post-only/);
    expect(p).toMatch(/Reduce-only/);
    expect(p).toMatch(/Leverage/);
    expect(venueTicketProblems({ ...defaultVenueTicket(base), orderType: 'StopLimit' }, base).join(' ')).toMatch(/needs a price.*trigger|trigger/);
  });

  it('patches keep the ticket coherent', () => {
    const t = patchVenueTicket({ ...defaultVenueTicket(base), price: 6000, postOnly: true }, { orderType: 'Market' });
    expect(t.tif).toBe('Ioc');
    expect(t.price).toBeNull();
    expect(t.postOnly).toBe(false);
    expect(tifChoices('Limit')).toContain('Gtc');
    expect(prefillPatch(base, { side: 'Sell', orderType: 'Stop', price: 5990.1 })).toEqual({
      side: 'Sell',
      orderType: 'Stop',
      stopPrice: 5990,
      price: null,
      postOnly: false,
    });
  });

  it('builds the preview request', () => {
    const r = previewRequestOf('ESZ6', { ...defaultVenueTicket(base), orderType: 'Limit', price: 6000, stopPrice: 5000, stopLossTicks: 8 });
    expect(r).toMatchObject({ symbol: 'ESZ6', orderType: 'Limit', price: 6000, stopPrice: null, stopLossTicks: 8, timeInForce: 'Gtc' });
  });
});
