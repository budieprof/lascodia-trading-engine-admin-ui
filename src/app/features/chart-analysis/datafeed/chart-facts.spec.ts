import { describe, expect, it } from 'vitest';
import {
  MAX_CLOSURES,
  isVenueSource,
  mergeClosures,
  readChartFacts,
  readClosures,
  readFirstBarMs,
  volumeLabel,
  volumeUnitTag,
} from './chart-facts';

describe('chart-facts — C1 fields of a chart-bars answer', () => {
  it('an engine before C1 carries no facts (null, never FX by assumption)', () => {
    expect(
      readChartFacts({
        session: '1700-1700:23456',
        timeZone: 'America/New_York',
        bars: [],
      } as never),
    ).toBeNull();
    expect(readChartFacts(null)).toBeNull();
  });

  it('reads asset class, calendar, volume kind, source and adjustment; drops an unknown volume kind', () => {
    expect(
      readChartFacts({
        assetClass: 'Crypto',
        calendarCode: 'crypto-24x7',
        volumeKind: 'base',
        source: { id: 'crypto-coinbase', kind: 'venue', label: 'Coinbase Advanced Trade' },
        adjustment: 'none',
      }),
    ).toEqual({
      assetClass: 'Crypto',
      calendarCode: 'crypto-24x7',
      volumeKind: 'base',
      source: { id: 'crypto-coinbase', kind: 'venue', label: 'Coinbase Advanced Trade' },
      adjustment: 'none',
    });
    expect(
      readChartFacts({ assetClass: 'Fx', volumeKind: 'lots' as never, source: null })?.volumeKind,
    ).toBeNull();
  });

  it('keeps well-formed closures, merges answers without duplicates and caps the memory', () => {
    const a = { fromMs: 10, toMs: 20, kind: 'Holiday', label: 'X' };
    const b = { fromMs: 30, toMs: 40, kind: 'Break', label: 'Y' };
    expect(
      readClosures({ closures: [a, { fromMs: 5, toMs: 5, kind: 'Break', label: '' }, b] }),
    ).toEqual([a, b]);
    expect(mergeClosures([b], [a, b])).toEqual([a, b]);
    const many = Array.from({ length: MAX_CLOSURES + 5 }, (_, i) => ({
      fromMs: i * 10,
      toMs: i * 10 + 5,
      kind: 'Break',
      label: '',
    }));
    const merged = mergeClosures([], many);
    expect(merged).toHaveLength(MAX_CLOSURES);
    expect(merged[0].fromMs).toBe(50);
  });

  it('first bar, venue sources and volume labels', () => {
    expect(readFirstBarMs({ firstBarMs: 123 })).toBe(123);
    expect(readFirstBarMs({ firstBarMs: null })).toBeNull();
    expect(isVenueSource({ id: 'mt5', kind: 'mt5', label: 'MT5 broker feed' })).toBe(false);
    expect(isVenueSource({ id: 'crypto-okx', kind: 'venue', label: 'OKX' })).toBe(true);
    expect(isVenueSource(null)).toBe(false);
    expect(volumeLabel('tick')).toBe('tick volume');
    expect(volumeLabel('base', 'BTC')).toBe('volume (BTC)');
    expect(volumeLabel(null)).toBe('volume (unit unknown)');
    expect(volumeUnitTag('contracts')).toBe('contracts');
    expect(volumeUnitTag(null)).toBeNull();
  });
});
