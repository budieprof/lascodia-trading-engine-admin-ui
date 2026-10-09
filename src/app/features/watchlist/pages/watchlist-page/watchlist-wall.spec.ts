import { describe, expect, it } from 'vitest';

import { applyTick, canonicalSymbol, readLegacyWall, seedFromSnapshot } from './watchlist-wall';
import type { WatchQuote } from '@features/chart-analysis/watchlist/watchlist.model';

describe('watchlist wall (SP-I6)', () => {
  it('reads the old browser wall once per symbol and survives junk', () => {
    const raw = JSON.stringify([
      { symbol: 'eur/usd', timeframe: 'H1' },
      { symbol: 'EURUSD', timeframe: 'M5' },
      { symbol: 'GBP-JPY', timeframe: 'H1' },
      { nope: true },
    ]);
    expect(readLegacyWall(raw)).toEqual(['EURUSD', 'GBPJPY']);
    expect(readLegacyWall('{not json')).toEqual([]);
    expect(readLegacyWall(null)).toEqual([]);
    expect(readLegacyWall('{"a":1}')).toEqual([]);
    expect(canonicalSymbol(' xau/usd ')).toBe('XAUUSD');
  });

  it('folds pushed ticks into the quotes, ignoring empty or unchanged ones', () => {
    const now = '2026-10-09T10:00:00Z';
    const a = applyTick({}, { symbol: 'eurusd', bid: 1.1, ask: 1.1002, timeUtc: '2026-10-09T09:59:59Z' }, now);
    expect(a['EURUSD']).toEqual({
      symbol: 'EURUSD',
      bid: 1.1,
      ask: 1.1002,
      spread: 1.1002 - 1.1,
      timestamp: '2026-10-09T09:59:59Z',
    });
    expect(applyTick(a, { symbol: 'EURUSD', bid: 1.1, ask: 1.1002 }, now)).toBe(a);
    expect(applyTick(a, { symbol: 'EURUSD' }, now)).toBe(a);
    expect(applyTick(a, { bid: 1 }, now)).toBe(a);
    // A tick without an ask prices both sides at the bid rather than dropping it.
    expect(applyTick({}, { symbol: 'X', bid: 2 }, now)['X'].ask).toBe(2);
  });

  it('seeds from the day snapshot without overwriting a pushed quote', () => {
    const pushed = applyTick({}, { symbol: 'EURUSD', bid: 1.2, ask: 1.2001 }, 'now');
    const snap = [
      { symbol: 'EURUSD', bid: 1.1, ask: 1.1001, asOfUtc: 't' },
      { symbol: 'GBPUSD', bid: 1.3, ask: 1.3002, asOfUtc: 't' },
      { symbol: 'USDJPY', bid: null, ask: null, asOfUtc: null },
    ] as WatchQuote[];
    const seeded = seedFromSnapshot(pushed, snap);
    expect(seeded['EURUSD'].bid).toBe(1.2);
    expect(seeded['GBPUSD'].ask).toBe(1.3002);
    expect(seeded['USDJPY']).toBeUndefined();
    expect(seedFromSnapshot(seeded, snap)).toBe(seeded);
  });
});
