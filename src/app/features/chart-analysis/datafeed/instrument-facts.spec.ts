import { afterEach, describe, expect, it } from 'vitest';

import type { CurrencyPairDto } from '@core/api/api.types';
import { fxPipSize, normaliseInstrument, setInstrumentCatalogue } from '@core/instruments/instrument-math';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import {
  decimalsOfPrices,
  exactStepDecimals,
  formatFactsDistance,
  formatFactsQuantity,
  instrumentFacts,
  pairDistanceUnit,
  pnlForMove,
  priceFormatOf,
  routeBadge,
  snapQuantityDown,
} from './instrument-facts';

const pair = (p: Partial<CurrencyPairDto>): CurrencyPairDto => ({
  id: 1,
  symbol: 'EURUSD',
  baseCurrency: 'EUR',
  quoteCurrency: 'USD',
  decimalPlaces: 5,
  contractSize: 100_000,
  minLotSize: 0.01,
  maxLotSize: 100,
  lotStep: 0.01,
  isActive: true,
  assetClass: 'FxMajor',
  ...p,
});

const EURUSD = pair({});
const USDJPY = pair({ symbol: 'USDJPY', baseCurrency: 'USD', quoteCurrency: 'JPY', decimalPlaces: 3 });
const XAUUSD = pair({
  symbol: 'XAUUSD',
  baseCurrency: 'XAU',
  quoteCurrency: 'USD',
  decimalPlaces: 2,
  contractSize: 100,
  assetClass: 'Commodity',
});

const row = (r: Partial<InstrumentDto>): InstrumentDto => normaliseInstrument(r)!;
const ES = row({
  symbol: 'ESZ6',
  assetClass: 'Future',
  exchange: 'CME',
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 12.5,
  multiplier: 50,
  quantityUnit: 'Contracts',
  quantityStep: 1,
  minQuantity: 1,
  maxQuantity: 500,
  priceDecimals: 2,
  displayDistance: 'Ticks',
  future: { root: 'ES', contractCode: 'ESZ6', expiry: '2026-12-18', lastTradeDate: '2026-12-18', isFront: true, continuousSymbol: 'ES1!' },
});
const BTC = row({
  symbol: 'BTC-USD',
  assetClass: 'Crypto',
  exchange: 'Coinbase',
  quoteCurrency: 'USD',
  baseCurrency: 'BTC',
  tickSize: 0.01,
  tickValue: 0.01,
  multiplier: 1,
  quantityUnit: 'Coins',
  quantityStep: 0.001,
  minQuantity: 0.001,
  maxQuantity: 1000,
  priceDecimals: 2,
  displayDistance: 'Points',
  crypto: { kind: 'Spot', settleAsset: null, fundingIntervalHours: null },
});
const BTC_INV = row({
  ...BTC,
  symbol: 'BTC-USD-PERP',
  exchange: 'OKX',
  multiplier: 100,
  tickValue: 0,
  quantityUnit: 'Contracts',
  quantityStep: 1,
  minQuantity: 1,
  contractType: 'Inverse',
  crypto: { kind: 'Perpetual', settleAsset: 'BTC', fundingIntervalHours: 8 },
});

afterEach(() => setInstrumentCatalogue([]));

describe('instrumentFacts — FX pinned (UI01)', () => {
  it('EURUSD: 5 decimals, pip 0.0001, point min move, 100 000 per lot, MT5 ticket', () => {
    const f = instrumentFacts('EURUSD', { pair: EURUSD, lookup: 'resolving' });
    expect(f.origin).toBe('pair');
    expect(f.precision).toBe(5);
    expect(f.distanceUnit).toBe(fxPipSize(5));
    expect(f.distanceUnit).toBeCloseTo(0.0001, 12);
    expect(f.distanceLabel).toBe('pips');
    expect(f.distanceLabelOne).toBe('pip');
    expect(f.tickSize).toBeCloseTo(0.00001, 12);
    expect(priceFormatOf(f)).toEqual({ type: 'price', precision: 5, minMove: 1 / 10 ** 5 });
    expect(f.valuePerPrice).toBe(100_000);
    expect(f.quantityStep).toBe(0.01);
    expect(f.quantityDecimals).toBe(2);
    expect(f.quantityUnit).toBe('Lots');
    expect(f.resolving).toBe(false);
    expect(f.route).toEqual({ kind: 'mt5' });
    expect(routeBadge(f.route)).toBe('MT5 broker');
  });

  it('USDJPY: 3 decimals, pip 0.01', () => {
    const f = instrumentFacts('usdjpy', { pair: USDJPY });
    expect(f.precision).toBe(3);
    expect(f.distanceUnit).toBe(fxPipSize(3));
    expect(f.distanceUnit).toBeCloseTo(0.01, 12);
    expect(f.distanceLabel).toBe('pips');
  });

  it('XAUUSD (Commodity CFD): 2 decimals, the point, 100 oz per lot', () => {
    const f = instrumentFacts('XAUUSD', { pair: XAUUSD });
    expect(f.precision).toBe(2);
    expect(f.distanceUnit).toBe(10 ** -2);
    expect(f.distanceLabel).toBe('points');
    expect(f.valuePerPrice).toBe(100);
    expect(f.route.kind).toBe('mt5');
  });

  it('a pair without an asset class takes the catalogue / symbol class, not a blind FX pip', () => {
    // XAUUSD at 3 decimals: the FX rule would make the "pip" 0.01; it is a commodity, measured in points.
    const f = instrumentFacts('XAUUSD', { pair: { ...XAUUSD, decimalPlaces: 3, assetClass: null } });
    expect(f.assetClass).toBe('Commodity');
    expect(f.distanceUnit).toBeCloseTo(0.001, 12);
    expect(f.distanceLabel).toBe('points');
  });

  it('FX replay money is exactly diff × lots × 100 000', () => {
    const f = instrumentFacts('EURUSD', { pair: EURUSD });
    const diff = 1.1012 - 1.1;
    expect(pnlForMove(f, 1.1, 1.1012, 0.5)).toBe(diff * 0.5 * 100_000);
  });
});

describe('instrumentFacts — other asset classes', () => {
  it('ES future: tick 0.25 as min move, ticks, $12.50 a tick, contracts, venue ticket', () => {
    setInstrumentCatalogue([ES]);
    const f = instrumentFacts('ESZ6', { lookup: 'found' });
    expect(f.origin).toBe('catalogue');
    expect(priceFormatOf(f)).toEqual({ type: 'price', precision: 2, minMove: 0.25 });
    expect(f.distanceUnit).toBe(0.25);
    expect(f.distanceLabel).toBe('ticks');
    expect(formatFactsDistance(f, 1.5)).toBe('6.0 ticks');
    expect(pnlForMove(f, 5000, 5010, 2)).toBeCloseTo(1000, 9); // 40 ticks × 12.5 × 2
    expect(formatFactsQuantity(f, 1)).toBe('1 contract');
    expect(f.route).toMatchObject({ kind: 'venue', name: 'CME' });
    expect(routeBadge(f.route)).toBe('Venue: CME');
  });

  it('BTC spot (linear): coins on a 0.001 step, P&L = move × coins', () => {
    setInstrumentCatalogue([BTC]);
    const f = instrumentFacts('BTC-USD');
    expect(f.quantityDecimals).toBe(3);
    expect(formatFactsQuantity(f, 0.015)).toBe('0.015 BTC');
    expect(pnlForMove(f, 60_000, 61_000, 0.5)).toBeCloseTo(500, 6);
    expect(f.pnlCurrency).toBe('USD');
  });

  it('inverse perpetual: P&L in the coin, contracts × value × (1/entry − 1/exit)', () => {
    setInstrumentCatalogue([BTC_INV]);
    const f = instrumentFacts('BTC-USD-PERP');
    expect(f.inverse).toBe(true);
    expect(f.pnlCurrency).toBe('BTC');
    expect(pnlForMove(f, 50_000, 60_000, 10)).toBeCloseTo(10 * 100 * (1 / 50_000 - 1 / 60_000), 12);
  });

  it('a guessed non-FX symbol: no money, no sizing, the bars\' own decimals', () => {
    const f = instrumentFacts('ESZ5', { lookup: 'missing', digitsHint: 2 });
    expect(f.origin).toBe('guess');
    expect(f.assetClass).toBe('Future');
    expect(f.precision).toBe(2);
    expect(f.valuePerPrice).toBeNull();
    expect(f.tickValue).toBeNull();
    expect(f.quantityStep).toBeNull();
    expect(pnlForMove(f, 1, 2, 1)).toBeNull();
    expect(snapQuantityDown(f, 1)).toBeNull();
  });

  it('resolving: no pair, the catalogue still loading → no ticket yet', () => {
    const f = instrumentFacts('BTC-USD', { lookup: 'resolving' });
    expect(f.resolving).toBe(true);
    expect(f.route.kind).toBe('resolving');
    expect(routeBadge(f.route)).toBe('Resolving instrument…');
  });

  it('Bps: a basis point of the reference price, labelled points without one', () => {
    const bps = row({ ...BTC, symbol: 'X-BPS', displayDistance: 'Bps', crypto: null });
    setInstrumentCatalogue([bps]);
    expect(instrumentFacts('X-BPS', { refPrice: 50_000 }).distanceUnit).toBe(5);
    expect(instrumentFacts('X-BPS', { refPrice: 50_000 }).distanceLabel).toBe('bps');
    const noRef = instrumentFacts('X-BPS');
    expect(noRef.distanceUnit).toBeCloseTo(0.01, 12);
    expect(noRef.distanceLabel).toBe('points');
  });
});

describe('quantity and decimals helpers', () => {
  it('snapQuantityDown floors to the step at its decimals', () => {
    expect(snapQuantityDown({ quantityStep: 0.001, quantityDecimals: 3 }, 0.0129)).toBe(0.012);
    expect(snapQuantityDown({ quantityStep: 0.001, quantityDecimals: 3 }, 0.015)).toBe(0.015);
    expect(snapQuantityDown({ quantityStep: 0.01, quantityDecimals: 2 }, 0.3)).toBe(0.3);
    expect(snapQuantityDown({ quantityStep: 0.01, quantityDecimals: 2 }, 0.009)).toBeNull();
    expect(snapQuantityDown({ quantityStep: null, quantityDecimals: 2 }, 1)).toBeNull();
  });

  it('exactStepDecimals', () => {
    expect(exactStepDecimals(0.25)).toBe(2);
    expect(exactStepDecimals(1e-8)).toBe(8);
    expect(exactStepDecimals(1.5e-7)).toBe(8);
    expect(exactStepDecimals(1)).toBe(0);
  });

  it('decimalsOfPrices reads what the prices carry', () => {
    expect(decimalsOfPrices([1.08345, 1.0835])).toBe(5);
    expect(decimalsOfPrices([65000.5, 65001.25])).toBe(2);
    expect(decimalsOfPrices([5012.25])).toBe(2);
    expect(decimalsOfPrices([])).toBeNull();
  });
});

describe('pairDistanceUnit (UI08: replaces symbol-info pipSizeFor)', () => {
  it('FX keeps the engine pip; a classless commodity pair is not given an FX pip', () => {
    expect(pairDistanceUnit({ symbol: 'EURUSD', decimalPlaces: 5, assetClass: 'FxMajor' })).toBeCloseTo(0.0001, 12);
    expect(pairDistanceUnit({ symbol: 'USDJPY', decimalPlaces: 3, assetClass: 'FxMajor' })).toBeCloseTo(0.01, 12);
    expect(pairDistanceUnit({ symbol: 'EURUSD', decimalPlaces: 5 })).toBeCloseTo(0.0001, 12);
    expect(pairDistanceUnit({ symbol: 'XAUUSD', decimalPlaces: 3, assetClass: null })).toBeCloseTo(0.001, 12);
    expect(pairDistanceUnit({ symbol: 'US500', decimalPlaces: 1, assetClass: 'Index' })).toBeCloseTo(0.1, 12);
  });
});

