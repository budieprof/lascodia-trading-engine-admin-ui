import { describe, expect, it } from 'vitest';
import { instrumentKey } from './instrument-key';

describe('US07 instrument keys', () => {
  it('futures contracts and both continuous series key by the continuous root', () => {
    for (const s of ['ESZ6', 'esh7', 'ES1!', 'ES1!U']) expect(instrumentKey(s)).toBe('ES1!');
    expect(instrumentKey('CLF26')).toBe('CL1!');
    expect(instrumentKey('6EH6')).toBe('6E1!');
    expect(instrumentKey('RTYM5')).toBe('RTY1!');
  });

  it('FX, CFDs and crypto keep their engine symbol (upper case); a catalogued non-future is never folded', () => {
    for (const s of ['EURUSD', 'usdjpy', 'US500', 'HK50', 'DE40', 'BTC-USD', 'BTC-USDT-PERP', 'XAUUSD'])
      expect(instrumentKey(s)).toBe(s.toUpperCase());
    expect(instrumentKey('ABCZ5', 'Equity')).toBe('ABCZ5');
  });

  it('a synthetic keys by its canonical spelling', () => {
    expect(instrumentKey('ratio(eurusd, gbpusd)'.replace(' ', ''))).toBe('RATIO(EURUSD,GBPUSD)');
    expect(instrumentKey('SPREAD(EURUSD,GBPUSD,1)')).toBe('SPREAD(EURUSD,GBPUSD)');
  });
});
