import { describe, expect, it } from 'vitest';

import type { OrderBookSnapshot } from './chart-panels.types';
import { formatUnits, parseDepth, snapshotAgeSeconds } from './depth';

const snap = (levelsJson: string | null, over: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot => ({
  id: 1,
  symbol: 'GBPUSD',
  bidPrice: 1.32411,
  askPrice: 1.32411,
  bidVolume: 500_000,
  askVolume: 1_000_000,
  spreadPoints: 0,
  levelsJson,
  instanceId: 'LASC-1',
  capturedAt: '2026-10-09T04:11:11Z',
  ...over,
});

describe('broker depth (SP-I9)', () => {
  // The live shape: asks arrive deepest-first, the book can be locked (best bid = best ask).
  const live =
    '{"bids":[{"P":1.32411,"V":500000},{"P":1.32410,"V":3000000},{"P":1.32408,"V":3000000}],' +
    '"asks":[{"P":1.32420,"V":6600000},{"P":1.32412,"V":500000},{"P":1.32411,"V":1000000}]}';

  it('orders each side best first, cumulates, scales to the deeper side', () => {
    const d = parseDepth(snap(live));
    expect(d.hasLevels).toBe(true);
    expect(d.bids.map((l) => l.price)).toEqual([1.32411, 1.3241, 1.32408]);
    expect(d.asks.map((l) => l.price)).toEqual([1.32411, 1.32412, 1.3242]);
    expect(d.bids.map((l) => l.cumulative)).toEqual([500_000, 3_500_000, 6_500_000]);
    expect(d.asks.at(-1)!.cumulative).toBe(8_100_000);
    expect(d.asks.at(-1)!.share).toBe(1);
    expect(d.spread).toBe(0); // locked
    expect(d.bidShare).toBeCloseTo(6_500_000 / 14_600_000);
  });

  it('caps the levels and falls back to the top of book', () => {
    expect(parseDepth(snap(live), 2).bids).toHaveLength(2);
    const top = parseDepth(snap(null, { askPrice: 1.3242 }));
    expect(top.hasLevels).toBe(false);
    expect(top.bids[0].price).toBe(1.32411);
    expect(top.asks[0].price).toBe(1.3242);
    expect(parseDepth(snap('{broken')).hasLevels).toBe(false);
    expect(parseDepth(null).bids).toEqual([]);
  });

  it('formats units and ages', () => {
    expect(formatUnits(10_100_000)).toBe('10.1M');
    expect(formatUnits(500_000)).toBe('500K');
    expect(formatUnits(800)).toBe('800');
    expect(snapshotAgeSeconds('2026-10-09T04:11:11Z', Date.parse('2026-10-09T04:11:14Z'))).toBe(3);
    expect(snapshotAgeSeconds('nope', 0)).toBeNull();
  });
});
