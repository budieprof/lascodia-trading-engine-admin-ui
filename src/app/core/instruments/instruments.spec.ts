import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '@core/api/api.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { pineSessionFromCalendar, weekdayIndex } from './calendar-session';
import {
  classifySymbol,
  distanceUnitOf,
  fallbackInstrument,
  formatDistance,
  formatMoney,
  formatQuantity,
  normaliseInstrument,
  resolveInstrument,
  setInstrumentCatalogue,
} from './instrument-math';
import { InstrumentsService } from './instruments.service';
import { InstrumentFormatService } from './instrument-format.service';
import type { InstrumentDto, TradingCalendarDto } from './instrument.types';

ensureTestBed();

const ES: Partial<InstrumentDto> = {
  symbol: 'ESZ6',
  assetClass: 'Future',
  exchange: 'CME',
  description: 'E-mini S&P 500 Dec 2026',
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
  tradingCalendarCode: 'cme-equity-index',
  status: 'Active',
};
const BTC: Partial<InstrumentDto> = {
  symbol: 'BTC-USDT',
  assetClass: 'Crypto',
  exchange: 'Binance',
  quoteCurrency: 'USDT',
  baseCurrency: 'BTC',
  tickSize: 0.01,
  tickValue: 0.01,
  multiplier: 1,
  quantityUnit: 'Coins',
  quantityStep: 0.00001,
  minQuantity: 0.00001,
  maxQuantity: 9000,
  priceDecimals: 2,
  displayDistance: 'Points',
  tradingCalendarCode: 'crypto-24x7',
};

afterEach(() => setInstrumentCatalogue([]));

describe('instrument math — other asset classes', () => {
  it('futures in ticks, contracts as the unit', () => {
    const es = normaliseInstrument(ES)!;
    expect(formatDistance(es, 1.5)).toBe('6.0 ticks');
    expect(formatQuantity(es, 2)).toBe('2 contracts');
    expect(formatQuantity(es, 1)).toBe('1 contract');
  });
  it('crypto quantities in coins of the base asset', () => {
    const btc = normaliseInstrument(BTC)!;
    expect(formatQuantity(btc, 0.5)).toBe('0.50000 BTC');
    expect(formatDistance(btc, 12.34)).toBe('1234.0 points');
  });
  it('an engine row claiming pips for a non-FX instrument is shown in its own unit', () => {
    expect(normaliseInstrument({ ...ES, displayDistance: 'Pips' })!.displayDistance).toBe('Ticks');
  });
  it('symbol-only classifier: engine lists + canonical crypto/continuous forms; unknown → FX', () => {
    expect(classifySymbol('BTC-USDT-PERP')).toBe('Crypto');
    expect(classifySymbol('ES1!')).toBe('Future');
    expect(classifySymbol('US500')).toBe('Index');
    expect(classifySymbol('XAUUSD')).toBe('Commodity');
    expect(classifySymbol('EURUSD')).toBe('Fx');
    expect(fallbackInstrument('USDJPY').priceDecimals).toBe(3);
  });
  it('money', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatMoney(12, 'USDT')).toBe('12.00 USDT');
  });
  it('a computed resolving a symbol follows the catalogue load', () => {
    const pip = computed(() => distanceUnitOf('ESZ6'));
    expect(pip()).toBeCloseTo(0.0001, 12); // unknown → FX fallback
    setInstrumentCatalogue([normaliseInstrument(ES)!]);
    expect(pip()).toBe(0.25);
  });
});

describe('calendar → Pine session', () => {
  const fx: TradingCalendarDto = {
    code: 'fx-24x5',
    timeZone: 'America/New_York',
    is24x7: false,
    holidays: [],
    sessions: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].map((day) => ({
      day,
      open: '17:00',
      close: '17:00',
      kind: 'Regular' as const,
    })),
  };
  it('fx-24x5 equals what scripting/chart-bars reports today', () => {
    expect(pineSessionFromCalendar(fx)).toEqual({
      session: '1700-1700:23456',
      timeZone: 'America/New_York',
    });
  });
  it('globex with a maintenance break; equities regular hours; 24x7', () => {
    const globex: TradingCalendarDto = {
      code: 'cme-globex',
      timeZone: 'America/Chicago',
      is24x7: false,
      holidays: [],
      sessions: [0, 1, 2, 3, 4].flatMap((day) => [
        { day, open: '17:00', close: '16:00', kind: 'Regular' as const },
        { day: day + 1, open: '16:00', close: '17:00', kind: 'Maintenance' as const },
      ]),
    };
    expect(pineSessionFromCalendar(globex)?.session).toBe('1700-1600:23456');
    const nyse: TradingCalendarDto = {
      code: 'nyse',
      timeZone: 'America/New_York',
      is24x7: false,
      holidays: [],
      sessions: [1, 2, 3, 4, 5].flatMap((day) => [
        { day, open: '04:00', close: '09:30', kind: 'Pre' as const },
        { day, open: '09:30', close: '16:00', kind: 'Regular' as const },
      ]),
    };
    expect(pineSessionFromCalendar(nyse)?.session).toBe('0930-1600:23456');
    expect(pineSessionFromCalendar({ ...nyse, is24x7: true })?.session).toBe('0000-0000:1234567');
    expect(weekdayIndex('sat')).toBe(6);
  });
});

describe('InstrumentsService', () => {
  function setup(api: Partial<ApiService>) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    return TestBed.inject(InstrumentsService);
  }

  it('uses the engine instrument master when served', async () => {
    const svc = setup({ getEnvelope: vi.fn(() => of([ES, BTC])) as never, post: vi.fn() as never });
    await svc.load();
    expect(svc.source()).toBe('instruments');
    expect(svc.assetClasses()).toEqual(['Future', 'Crypto']);
    expect(resolveInstrument('esz6').tickValue).toBe(12.5);
  });

  it('falls back to FX instruments from the currency pairs when instruments 404s', async () => {
    const post = vi.fn(() =>
      of({
        status: true,
        message: null,
        responseCode: '00',
        data: {
          pager: {},
          data: [
            {
              id: 1,
              symbol: 'USDJPY',
              baseCurrency: 'USD',
              quoteCurrency: 'JPY',
              decimalPlaces: 3,
              contractSize: 100000,
              minLotSize: 0.01,
              maxLotSize: 50,
              lotStep: 0.01,
              isActive: true,
              assetClass: 'FxMajor',
            },
          ],
        },
      }),
    );
    const svc = setup({
      getEnvelope: vi.fn(() => throwError(() => ({ status: 404 }))) as never,
      post: post as never,
    });
    await svc.load();
    expect(svc.source()).toBe('currency-pairs');
    const fmt = TestBed.inject(InstrumentFormatService);
    expect(fmt.unitSize('USDJPY')).toBe(0.01);
    expect(fmt.distance('USDJPY', 0.25)).toBe('25.0 pips');
    expect(fmt.quantity('USDJPY', 0.1)).toBe('0.10 lots');
    expect(fmt.price('USDJPY', 151.8)).toBe('151.800');
  });

  it('a calendar the engine does not serve is null, and is asked again later', async () => {
    const get = vi.fn(() => throwError(() => ({ status: 404 })));
    const svc = setup({ getEnvelope: get as never });
    expect(await svc.calendar('fx-24x5')).toBeNull();
    expect(await svc.calendar('fx-24x5')).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
