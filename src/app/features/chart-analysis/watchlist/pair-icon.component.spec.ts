import { describe, expect, it } from 'vitest';
import { CURRENCY_FLAG_SVG, pairFlags, pairName } from './pair-icon.component';

describe('pairFlags (TradingView-style overlapping circle flags)', () => {
  it('splits an FX or metal symbol into base and quote when both have artwork', () => {
    expect(pairFlags('EURUSD')).toEqual(['EUR', 'USD']);
    expect(pairFlags('usdjpy')).toEqual(['USD', 'JPY']);
    expect(pairFlags('XAUUSD')).toEqual(['XAU', 'USD']);
    expect(pairFlags('USDNGN')).toEqual(['USD', 'NGN']);
  });

  it('falls back (null) for symbols that are not a known currency pair', () => {
    expect(pairFlags('SPX')).toBeNull();
    expect(pairFlags('BTCUSD')).toBeNull();
    expect(pairFlags('EUR')).toBeNull();
  });

  it('has artwork for every currency the engine trades', () => {
    for (const ccy of ['AUD', 'CAD', 'CHF', 'CNH', 'EUR', 'GBP', 'JPY', 'NGN', 'NZD', 'USD', 'XAU']) {
      expect(CURRENCY_FLAG_SVG[ccy], ccy).toMatch(/^<rect width="32" height="32"/);
    }
  });
});

describe('pairName (TradingView titles a pair by its currency names)', () => {
  it('names a pair whose currencies are both known, else null', () => {
    expect(pairName('EUR', 'USD')).toBe('Euro / U.S. Dollar');
    expect(pairName('xau', 'usd')).toBe('Gold / U.S. Dollar');
    expect(pairName('BTC', 'USD')).toBeNull();
    expect(pairName(null, 'USD')).toBeNull();
  });
});
