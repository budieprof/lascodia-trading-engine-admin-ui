import { describe, expect, it } from 'vitest';
import { indicatorById, indicatorLabel, defaultParams } from './registry';
import { volumeStudyNote } from './volume-labels';

const bars = [
  { time: 0, open: 10, high: 12, low: 8, close: 10, volume: 2 },
  { time: 1, open: 10, high: 13, low: 9, close: 11, volume: 4 },
];

describe('volume studies say what volume they use (UA07)', () => {
  it('names the unit from C1 volumeKind, and marks estimated deltas', () => {
    expect(volumeStudyNote('volume', 'tick')).toBe(
      'Built on tick volume (MT5 price-change count, not traded size)',
    );
    expect(volumeStudyNote('obv', 'base', 'BTC')).toBe('Built on traded volume in BTC');
    expect(volumeStudyNote('profile:vp-session', 'contracts')).toBe(
      'Built on traded volume in contracts',
    );
    expect(volumeStudyNote('profile:tpo', 'tick')).toBeNull();
    expect(volumeStudyNote('cvd', 'shares')).toBe(
      'Built on traded volume in shares; buy/sell split estimated from the bar, not trades',
    );
    expect(volumeStudyNote('rsi', 'tick')).toBeNull();
    expect(volumeStudyNote('vwap', null)).toBe('Built on volume (unit not reported)');
  });

  it('Volume: unchanged by default (FX), quote notional only for coins and shares', () => {
    const def = indicatorById('volume')!;
    expect(def.compute(bars, { length: 2 })['volume']).toEqual([2, 4]);
    expect(
      def.compute(bars, { length: 2, measure: 'Quote notional' }, { volumeKind: 'base' })['volume'],
    ).toEqual([20, 44]);
    expect(
      def.compute(bars, { length: 2, measure: 'Quote notional' }, { volumeKind: 'tick' })['volume'],
    ).toEqual([null, null]);
    expect(volumeStudyNote('volume', 'tick', null, { measure: 'Quote notional' })).toContain(
      'needs volume in coins or shares',
    );
    // The label of a saved FX layout and of a fresh study is the same as before the new input.
    expect(indicatorLabel(def, defaultParams(def))).toBe('Volume 20');
    expect(
      indicatorLabel(indicatorById('sessions')!, defaultParams(indicatorById('sessions')!)),
    ).not.toContain('Auto');
  });
});
