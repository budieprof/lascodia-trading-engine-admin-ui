import { describe, expect, it } from 'vitest';
import { CURRENCY_FLAG_SVG, pairFlags, pairName } from './pair-icon.component';
import { COIN_SVG, COUNTRY_FLAG_SVG, splitCrypto, symbolArt } from './symbol-art';

describe('symbolArt (an icon for every instrument the engine lists, not just FX)', () => {
  it('gives every metal a coin and pairs it with its quote flag', () => {
    for (const s of ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'])
      expect(pairFlags(s), s).not.toBeNull();
    expect(pairName('XAG', 'USD')).toBe('Silver / U.S. Dollar');
  });

  it('splits crypto symbols into coin and quote', () => {
    expect(splitCrypto('BTCUSD')).toEqual(['BTC', 'USD']);
    expect(splitCrypto('LINKUSD')).toEqual(['LINK', 'USD']);
    expect(splitCrypto('BTCUSDT')).toEqual(['BTC', 'USDT']);
    expect(splitCrypto('ETHBTC')).toEqual(['ETH', 'BTC']);
    expect(splitCrypto('BTC-USD')).toEqual(['BTC', 'USD']);
  });

  it('draws a coin over its quote for every crypto the engine lists', () => {
    const coins = [
      'AAVE',
      'ADA',
      'BCH',
      'BNB',
      'BTC',
      'DOGE',
      'DOT',
      'ETH',
      'FIL',
      'LINK',
      'LTC',
      'MANA',
      'MATIC',
    ];
    for (const c of [...coins, 'SOL', 'UNI', 'XRP', 'XTZ']) {
      const art = symbolArt(`${c}USD`, 'Crypto');
      expect(art?.front, c).toBe(COIN_SVG[c]);
      expect(art?.back, c).toBe(CURRENCY_FLAG_SVG['USD']);
    }
    expect(symbolArt('BTCXAU', 'Crypto')?.back).toBe(CURRENCY_FLAG_SVG['XAU']);
    expect(symbolArt('ETHBTC', 'Crypto')?.back).toBe(COIN_SVG['BTC']);
    expect(symbolArt('ZZZUSD', 'Crypto')).toBeNull();
  });

  it("shows an index's home flag", () => {
    const cases: Array<[string, string]> = [
      ['US30', CURRENCY_FLAG_SVG['USD']],
      ['US500', CURRENCY_FLAG_SVG['USD']],
      ['NAS100', CURRENCY_FLAG_SVG['USD']],
      ['UK100', CURRENCY_FLAG_SVG['GBP']],
      ['DE40', COUNTRY_FLAG_SVG['DE']],
      ['FR40', COUNTRY_FLAG_SVG['FR']],
      ['JP225', CURRENCY_FLAG_SVG['JPY']],
      ['AUS200', CURRENCY_FLAG_SVG['AUD']],
      ['HK50', CURRENCY_FLAG_SVG['HKD']],
      ['STOXX50', CURRENCY_FLAG_SVG['EUR']],
    ];
    for (const [s, flag] of cases) expect(symbolArt(s, 'Index')?.front, s).toBe(flag);
    expect(symbolArt('SOMEIDX', 'Index', 'CAD')?.front).toBe(CURRENCY_FLAG_SVG['CAD']);
  });

  it('marks energy commodities', () => {
    for (const s of ['USOIL', 'UKOIL', 'XNGUSD'])
      expect(symbolArt(s, 'Commodity'), s).not.toBeNull();
    expect(symbolArt('USOIL', 'Commodity')?.label).toBe('Crude oil');
    expect(symbolArt('XNGUSD', 'Commodity')?.label).toBe('Natural gas');
  });

  it('gives every stock a brand-coloured monogram, and any unknown ticker a stable one', () => {
    const a = symbolArt('AAPL', 'Equity');
    expect(a?.front).toContain('>A</text>');
    expect(symbolArt('MSFT', 'Equity')?.front).toContain('#F25022');
    expect(symbolArt('NEWCO', 'Equity')?.front).toBe(symbolArt('NEWCO', 'Etf')?.front);
  });

  it('leaves FX to the pair flags', () => {
    expect(symbolArt('EURUSD', 'Fx')).toBeNull();
  });
});
