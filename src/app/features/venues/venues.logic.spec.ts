import { afterEach, describe, expect, it } from 'vitest';

import type { CurrencyPairDto } from '@core/api/api.types';
import { instrumentFromCurrencyPair, setInstrumentCatalogue } from '@core/instruments/instrument-math';
import type { InstrumentDto } from '@core/instruments/instrument.types';

import {
  credentialBody,
  credentialFieldsFor,
  driftLabel,
  driftSummary,
  emptyFee,
  emptyMargin,
  feeBody,
  feeProblems,
  feeSummary,
  isExchangeTraded,
  lagText,
  marginBody,
  marginImportFromError,
  marginImportText,
  marginProblems,
  orderTypeName,
  quantityUnitName,
  unitWord,
  venueInstrumentFor,
} from './venues.logic';

/**
 * FX GOLDEN (multi-asset rule: the live FX console must not change). The 26 live CurrencyPair rows (read-only SELECT
 * 2026-10-24, the same fixture as `core/instruments/instrument-golden.spec.ts`) — whether the catalogue comes from the
 * currency-pair fallback or from the engine's instruments endpoint (no future / crypto / equity detail for an MT5
 * symbol) — never get an exchange-traded instrument, so the chart keeps today's order ticket, ladder and rail.
 */
const LIVE: [string, string, string, number, number, string][] = [
  ['AUDCAD', 'AUD', 'CAD', 5, 100000, 'FxMinor'],
  ['AUDNZD', 'AUD', 'NZD', 5, 100000, ''],
  ['AUDUSD', 'AUD', 'USD', 5, 100000, 'FxMajor'],
  ['CADJPY', 'CAD', 'JPY', 3, 100000, 'FxMinor'],
  ['DE40', 'EUR', 'EUR', 1, 1, 'Index'],
  ['EURAUD', 'EUR', 'AUD', 5, 100000, 'FxMinor'],
  ['EURCAD', 'EUR', 'CAD', 5, 100000, 'FxMinor'],
  ['EURGBP', 'EUR', 'GBP', 5, 100000, 'FxMinor'],
  ['EURJPY', 'EUR', 'JPY', 3, 100000, 'FxMinor'],
  ['EURUSD', 'EUR', 'USD', 5, 100000, 'FxMajor'],
  ['GBPAUD', 'GBP', 'AUD', 5, 100000, 'FxMinor'],
  ['GBPCAD', 'GBP', 'CAD', 5, 100000, 'FxMinor'],
  ['GBPCHF', 'GBP', 'CHF', 5, 100000, 'FxExotic'],
  ['GBPJPY', 'GBP', 'JPY', 3, 100000, 'FxMinor'],
  ['GBPNZD', 'GBP', 'NZD', 5, 100000, 'FxMinor'],
  ['GBPUSD', 'GBP', 'USD', 5, 100000, 'FxMajor'],
  ['NAS100', 'USD', 'USD', 2, 1, 'Index'],
  ['NZDJPY', 'NZD', 'JPY', 3, 100000, 'FxMinor'],
  ['NZDUSD', 'NZD', 'USD', 5, 100000, 'FxMajor'],
  ['US500', 'USD', 'USD', 2, 1, 'Index'],
  ['USDCAD', 'USD', 'CAD', 5, 100000, 'FxMajor'],
  ['USDCHF', 'USD', 'CHF', 5, 100000, 'FxMajor'],
  ['USDCNH', 'USD', 'CNH', 5, 100000, ''],
  ['USDJPY', 'USD', 'JPY', 3, 100000, 'FxMajor'],
  ['USDNGN', 'USD', 'NGN', 3, 100000, 'FxExotic'],
  ['XAUUSD', 'XAU', 'USD', 2, 100, 'Commodity'],
];

function pairs(): InstrumentDto[] {
  return LIVE.map(([symbol, base, quote, digits, contract, assetClass], i) =>
    instrumentFromCurrencyPair({
      id: i + 1,
      symbol,
      baseCurrency: base,
      quoteCurrency: quote,
      decimalPlaces: digits,
      contractSize: contract,
      assetClass,
    } as unknown as CurrencyPairDto),
  );
}

/** The same rows as the engine's `GET instruments` serves them (MT5 symbols: no exchange detail). */
function engineRows(): InstrumentDto[] {
  return pairs().map((p) => ({
    ...p,
    assetClass: p.symbol === 'US500' || p.symbol === 'NAS100' || p.symbol === 'DE40' ? 'Index' : p.symbol === 'XAUUSD' ? 'Commodity' : 'Fx',
    exchange: 'OTC',
    future: null,
    crypto: null,
    equity: null,
  }));
}

const ES: InstrumentDto = {
  symbol: 'ESZ6',
  assetClass: 'Future',
  exchange: 'CME',
  description: 'E-mini S&P 500',
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 12.5,
  multiplier: 50,
  quantityUnit: 'Contracts',
  quantityStep: 1,
  minQuantity: 1,
  maxQuantity: 0,
  priceDecimals: 2,
  displayDistance: 'Ticks',
  tradingCalendarCode: 'cme-globex',
  status: 'Active',
  future: { root: 'ES', contractCode: 'ESZ6', expiry: null, lastTradeDate: null, isFront: true, continuousSymbol: 'ES1!' },
};

afterEach(() => setInstrumentCatalogue([]));

describe('FX golden: every live MT5 symbol keeps today’s ticket and ladder', () => {
  it('currency-pair fallback catalogue', () => {
    setInstrumentCatalogue(pairs());
    for (const [symbol] of LIVE) {
      expect(isExchangeTraded(pairs().find((p) => p.symbol === symbol)), symbol).toBe(false);
      expect(venueInstrumentFor(symbol), symbol).toBeNull();
    }
  });

  it('engine instruments catalogue (and with exchange-traded rows beside them)', () => {
    setInstrumentCatalogue([...engineRows(), ES]);
    for (const [symbol] of LIVE) expect(venueInstrumentFor(symbol), symbol).toBeNull();
    expect(venueInstrumentFor('esz6')?.symbol).toBe('ESZ6');
  });

  it('no catalogue (engine unreachable): nothing is exchange-traded', () => {
    for (const s of ['EURUSD', 'ESZ6', 'BTC-USDT-PERP', 'AAPL']) expect(venueInstrumentFor(s)).toBeNull();
  });

  it('an asset class alone is not enough: the exchange detail must be there', () => {
    expect(isExchangeTraded({ ...ES, future: null })).toBe(false);
    expect(isExchangeTraded({ ...ES, assetClass: 'Crypto', future: null, crypto: { kind: 'Perpetual', settleAsset: 'USDT', fundingIntervalHours: 8 } })).toBe(true);
    expect(isExchangeTraded({ ...ES, assetClass: 'Equity', future: null, equity: { primaryExchange: 'XNAS', shortable: true } })).toBe(true);
    expect(isExchangeTraded({ ...ES, assetClass: 'Index' })).toBe(false);
  });
});

describe('enum names and words', () => {
  it('reads numbers and names', () => {
    expect(orderTypeName(3)).toBe('StopLimit');
    expect(orderTypeName('Limit')).toBe('Limit');
    expect(quantityUnitName(1)).toBe('Contracts');
    expect(driftLabel(2)).toBe('Quantities differ');
    expect(unitWord('Contracts', 1)).toBe('contract');
    expect(unitWord('Coins', 0.5)).toBe('coins');
    expect(unitWord(undefined)).toBe('lots');
    expect(lagText(null)).toBe('—');
    expect(lagText(30)).toBe('30 min');
    expect(lagText(180)).toBe('3 h');
  });
});

describe('credentials', () => {
  it('names the fields each adapter reads and never sends a missing required one', () => {
    expect(credentialFieldsFor('okx-swap').map((f) => f.name)).toEqual(['apiKey', 'apiSecret', 'passphrase']);
    expect(credentialFieldsFor('tradovate').map((f) => f.name)).toEqual(['apiKey', 'password', 'cid', 'apiSecret']);
    expect(credentialFieldsFor('tradier')).toEqual([{ name: 'apiKey', label: 'Access token' }]);
    const binance = credentialFieldsFor('binance-usdm');
    expect(credentialBody(binance, { apiKey: ' k ', apiSecret: 's', privateKeyPem: '' })).toEqual({ apiKey: 'k', apiSecret: 's' });
    expect(credentialBody(binance, { apiKey: 'k', apiSecret: ' ' })).toBeNull();
  });
});

describe('fee schedules', () => {
  it('mirrors the engine’s rules', () => {
    const f = { ...emptyFee('Future'), code: 'cme:ES', venue: 'cme', commissionPerContract: 0.85 };
    expect(feeProblems(f)).toEqual([]);
    expect(feeProblems({ ...f, commissionPerContract: null })).toContain('Give at least one fee of the asset class.');
    expect(feeProblems({ ...emptyFee('Crypto'), code: 'b', venue: 'binance', takerFeeBps: 2000 }).length).toBeGreaterThan(0);
    expect(feeProblems({ ...emptyFee('Crypto'), code: 'b', venue: 'binance', makerFeeBps: -1, takerFeeBps: 4 })).toEqual([]);
    expect(feeProblems({ ...f, effectiveToUtc: f.effectiveFromUtc })).toContain('The end must be after the start.');
  });

  it('sends only the class’s own amounts', () => {
    const body = feeBody({ ...emptyFee('Future'), code: ' cme:ES ', venue: 'CME', currency: 'usd', commissionPerContract: 1, takerFeeBps: 5 });
    expect(body.takerFeeBps).toBeNull();
    expect(body.commissionPerContract).toBe(1);
    expect(body.venue).toBe('cme');
    expect(body.currency).toBe('USD');
    expect(feeSummary({ ...body, exchangeFeePerContract: 1.38 })).toBe('2.38 USD per contract per side');
  });
});

describe('margin requirements', () => {
  it('refuses rows the models cannot use', () => {
    const fut = { ...emptyMargin('FuturesContract'), symbol: 'ES', source: 'cme', initialMargin: 15000, maintenanceMargin: 13600 };
    expect(marginProblems(fut)).toEqual([]);
    expect(marginProblems({ ...fut, maintenanceMargin: 16000 })).toContain('Maintenance margin cannot exceed the initial margin.');
    const tier = { ...emptyMargin('CryptoLeverageTier'), symbol: 'BTC-USDT-PERP', source: 'binance', maxLeverage: 125, maintenanceMarginRate: 0.004 };
    expect(marginProblems(tier)).toEqual([]);
    expect(marginProblems({ ...tier, maintenanceMarginRate: 0.01 }).join(' ')).toMatch(/liquidated/);
    expect(marginProblems({ ...emptyMargin('Equity'), symbol: 'AAPL', source: 'house' })).toContain('Give an initial or a maintenance rate.');
    expect(marginBody({ ...tier, initialMargin: 5 }).initialMargin).toBeNull();
  });
});

describe('drift', () => {
  it('summarises accounts and differences', () => {
    const s = driftSummary([
      { adapterKind: 'binance-usdm', executionAccountId: 1, tradingAccountId: null, atUtc: '', enginePositions: 1, venuePositions: 0, engineOrders: 0, venueOrders: 0, drift: [{ kind: 0, symbol: 'BTC-USDT-PERP', venueId: null, engineId: 5, engineQuantity: 1, venueQuantity: null }], skipped: null },
      { adapterKind: 'mt5-ea', executionAccountId: null, tradingAccountId: 17, atUtc: '', enginePositions: 0, venuePositions: 0, engineOrders: 0, venueOrders: 0, drift: [], skipped: 'no snapshot' },
    ]);
    expect(s).toEqual({ accounts: 2, withDrift: 1, drifts: 1, skipped: 1 });
  });
});

describe('margin CSV import', () => {
  const ok = { dryRun: true, inserted: 2, alreadyPresent: 1, errors: [], rows: [] };

  it('says what a dry run would do, then what the import did', () => {
    expect(marginImportText(ok)).toBe(
      'The file is fine: 2 new rows would be added. 1 row is already loaded and stays as it is.',
    );
    expect(marginImportText({ ...ok, inserted: 0, alreadyPresent: 3 })).toBe(
      'Nothing new in this file: every row is already loaded.',
    );
    expect(marginImportText({ ...ok, dryRun: false, alreadyPresent: 0 })).toBe('2 rows added.');
    expect(marginImportText({ ...ok, errors: ['line 3: x'] })).toBe(
      '1 problem found. Nothing was imported; fix the file and check it again.',
    );
  });

  it('reads the result a refused file carries, and nothing else', () => {
    const bad = { ...ok, errors: ['line 3: Symbol is required.'] };
    expect(marginImportFromError({ status: 400, error: { data: bad, responseCode: '-11' } })).toEqual(bad);
    expect(marginImportFromError({ response: { data: bad } })).toEqual(bad);
    expect(marginImportFromError({ response: { data: null } })).toBeNull();
    expect(marginImportFromError(new Error('network'))).toBeNull();
    expect(marginImportFromError(null)).toBeNull();
  });
});
