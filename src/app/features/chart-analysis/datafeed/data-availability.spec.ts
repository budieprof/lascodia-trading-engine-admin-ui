import { describe, expect, it } from 'vitest';
import { intervalNote, noDataMessage } from './data-availability';

describe('data availability (UD10 + "no data yet")', () => {
  it('marks intervals without data', () => {
    expect(intervalNote({ instrument: { hasCandles: false }, firstBarMs: undefined })).toBe(
      'no data yet',
    );
    expect(intervalNote({ instrument: { hasCandles: true }, firstBarMs: null })).toBe(
      'no stored bars',
    );
    expect(intervalNote({ instrument: null, firstBarMs: 123 })).toBeNull();
    expect(intervalNote({ instrument: null, firstBarMs: undefined })).toBeNull();
  });

  it('says why a chart is empty', () => {
    expect(noDataMessage('SOL-USD', '1h', { hasCandles: false, candleSource: null })).toBe(
      'No data yet for SOL-USD: no candle source is enabled for it.',
    );
    expect(
      noDataMessage('SOL-USD', '1h', {
        hasCandles: false,
        candleSource: { id: 'crypto-okx', kind: 'venue', label: 'OKX' },
      }),
    ).toBe('No data yet for SOL-USD: nothing has been stored from OKX so far.');
    // FX exactly as before.
    expect(noDataMessage('EURUSD', '1h', null)).toBe('No 1h candles stored for EURUSD.');
    expect(
      noDataMessage('BTC-USD', '1W', { hasCandles: true, firstCandleUtc: '2026-10-28T00:00:00Z' }),
    ).toBe("No 1W candles stored for BTC-USD (the engine's candles for it start 2026-10-28).");
  });
});
