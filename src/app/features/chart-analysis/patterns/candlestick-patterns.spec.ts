import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { CANDLESTICK_PATTERNS, detectCandlestickPatterns } from './candlestick-patterns';

type Q = [open: number, high: number, low: number, close: number];
const toBars = (qs: Q[]): Ohlc[] => qs.map(([open, high, low, close], i) => ({ time: i * 60_000, open, high, low, close, volume: 1 }));

/** 14 neutral bars (body 1, range 2) so "average body" is exactly 1. */
const FILLER: Q[] = Array.from({ length: 14 }, () => [100, 101.5, 99.5, 101] as Q);

const FIXTURES: Record<string, Q[]> = {
  doji: [[101, 102, 100, 101.02]],
  'dragonfly-doji': [[101, 101.05, 99, 101.02]],
  'gravestone-doji': [[101, 103, 100.98, 101.02]],
  'long-legged-doji': [[101, 102, 100, 101.02]],
  hammer: [[100.5, 101.04, 99, 101]],
  'hanging-man': [[100.5, 101.04, 99, 101]],
  'inverted-hammer': [[101, 102.5, 100.96, 101.5]],
  'shooting-star': [[101, 102.5, 100.96, 101.5]],
  'marubozu-white': [[100, 102.02, 99.98, 102]],
  'marubozu-black': [[102, 102.02, 99.98, 100]],
  'spinning-top': [[100.8, 102, 99.6, 101.2]],
  'long-lower-shadow': [[101, 101.2, 98, 101.1]],
  'long-upper-shadow': [[101, 104, 100.9, 101.1]],
  'bullish-engulfing': [[101.5, 101.6, 100.4, 100.5], [100.3, 102, 100.2, 101.8]],
  'bearish-engulfing': [[100.5, 101.6, 100.4, 101.5], [101.7, 101.8, 100, 100.2]],
  'bullish-harami': [[103, 103.1, 99.9, 100], [100.5, 102, 100.4, 101.8]],
  'bearish-harami': [[100, 103.1, 99.9, 103], [102.5, 102.6, 101, 101.2]],
  'bullish-harami-cross': [[103, 103.1, 99.9, 100], [101.5, 102, 101, 101.52]],
  'bearish-harami-cross': [[100, 103.1, 99.9, 103], [101.5, 102, 101, 101.52]],
  piercing: [[103, 103.1, 99.9, 100], [99.5, 102, 99.4, 102]],
  'dark-cloud-cover': [[100, 103.1, 99.9, 103], [103.5, 103.6, 100.9, 101]],
  'tweezer-top': [[100, 102, 99.9, 101.8], [101.8, 102.05, 100, 100.2]],
  'tweezer-bottom': [[101.8, 102, 100, 100.2], [100.2, 101.9, 100.05, 101.7]],
  'kicking-bull': [[102, 102.01, 99.99, 100], [103, 105.01, 102.99, 105]],
  'kicking-bear': [[100, 102.01, 99.99, 102], [99, 99.01, 96.99, 97]],
  'morning-star': [[104, 104.1, 100.9, 101], [100.4, 100.6, 99.9, 100.2], [100.5, 103.2, 100.4, 103]],
  'evening-star': [[100, 103.1, 99.9, 103], [103.6, 104.1, 103.4, 103.8], [103.5, 103.6, 100.9, 101]],
  'morning-doji-star': [[104, 104.1, 100.9, 101], [100.3, 100.6, 99.9, 100.31], [100.5, 103.2, 100.4, 103]],
  'evening-doji-star': [[100, 103.1, 99.9, 103], [103.7, 104.1, 103.4, 103.71], [103.5, 103.6, 100.9, 101]],
  'three-white-soldiers': [[101, 102.6, 100.9, 102.5], [102, 104.1, 101.9, 104], [103.5, 105.6, 103.4, 105.5]],
  'three-black-crows': [[102.5, 102.6, 100.9, 101], [101.5, 101.6, 99.4, 99.5], [100, 100.1, 97.9, 98]],
  'abandoned-baby-bull': [[103, 103.1, 100.9, 101], [100, 100.5, 99.5, 100.02], [101, 103, 100.8, 102.8]],
  'abandoned-baby-bear': [[100, 103.1, 99.9, 103], [104, 104.5, 103.5, 104.02], [103, 103.2, 101, 101.2]],
  'tri-star-bull': [[101, 101.5, 100.5, 101.02], [100, 100.4, 99.6, 100.01], [101, 101.5, 100.5, 101.01]],
  'tri-star-bear': [[101, 101.5, 100.5, 101.02], [102, 102.4, 101.6, 102.01], [101, 101.5, 100.5, 101.01]],
  'upside-tasuki-gap': [[101, 103.1, 100.9, 103], [103.5, 105, 103.4, 104.8], [104.5, 104.6, 103.2, 103.3]],
  'downside-tasuki-gap': [[103, 103.1, 100.9, 101], [100.5, 100.6, 99, 99.2], [99.5, 100.75, 99.4, 100.7]],
  'rising-three-methods': [
    [101, 104.1, 100.9, 104],
    [103.8, 103.9, 102.9, 103],
    [103, 103.5, 102.4, 102.5],
    [102.5, 103.2, 102.3, 103.1],
    [103.2, 105.6, 103.1, 105.5],
  ],
  'falling-three-methods': [
    [104, 104.1, 100.9, 101],
    [101.2, 102.1, 101.1, 102],
    [102, 102.6, 101.5, 102.5],
    [102.5, 102.7, 101.8, 101.9],
    [101.8, 101.9, 99.4, 99.5],
  ],
};

describe('detectCandlestickPatterns', () => {
  it('has a fixture for every catalogue entry', () => {
    expect(CANDLESTICK_PATTERNS.map((p) => p.id).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  for (const meta of CANDLESTICK_PATTERNS) {
    it(`detects ${meta.name}`, () => {
      const bars = toBars([...FILLER, ...FIXTURES[meta.id]]);
      const hits = detectCandlestickPatterns(bars, { ids: [meta.id], trend: 'none' });
      const last = bars.length - 1;
      expect(hits.some((h) => h.index === last && h.id === meta.id)).toBe(true);
      const hit = hits.find((h) => h.index === last)!;
      expect(hit).toMatchObject({ name: meta.name, abbr: meta.abbr, direction: meta.direction });
    });
  }

  it('finds nothing directional on plain filler bars', () => {
    const hits = detectCandlestickPatterns(toBars([...FILLER, ...FILLER]), { trend: 'none' });
    expect(hits).toEqual([]);
  });

  it('rejects a would-be engulfing whose body does not cover the prior body', () => {
    const bars = toBars([...FILLER, [101.5, 101.6, 100.4, 100.5], [100.7, 101.6, 100.6, 101.3]]);
    expect(detectCandlestickPatterns(bars, { ids: ['bullish-engulfing'], trend: 'none' })).toEqual([]);
  });

  it('rejects a hammer with a long upper wick', () => {
    const bars = toBars([...FILLER, [100.5, 102, 99, 101]]);
    expect(detectCandlestickPatterns(bars, { ids: ['hammer'], trend: 'none' })).toEqual([]);
  });

  it('rejects a morning star whose third bar fails to close above the first body midpoint', () => {
    const bars = toBars([...FILLER, [104, 104.1, 100.9, 101], [100.4, 100.6, 99.9, 100.2], [100.5, 102, 100.4, 101.8]]);
    expect(detectCandlestickPatterns(bars, { ids: ['morning-star'], trend: 'none' })).toEqual([]);
  });

  describe('sma50 trend filter', () => {
    const down: Q[] = Array.from({ length: 60 }, (_, i) => {
      const c = 160 - i;
      return [c + 1, c + 1.2, c - 0.2, c] as Q;
    });
    const up: Q[] = Array.from({ length: 60 }, (_, i) => {
      const c = 41 + i;
      return [c - 1, c + 0.2, c - 1.2, c] as Q;
    });
    const HAMMER: Q = [100.5, 101.04, 99, 101];

    it('fires a hammer (not a hanging man) after a downtrend', () => {
      const bars = toBars([...down, HAMMER]);
      const ids = detectCandlestickPatterns(bars, { ids: ['hammer', 'hanging-man'], trend: 'sma50' }).map((h) => h.id);
      expect(ids).toEqual(['hammer']);
    });

    it('fires a hanging man (not a hammer) after an uptrend', () => {
      const bars = toBars([...up, HAMMER]);
      const ids = detectCandlestickPatterns(bars, { ids: ['hammer', 'hanging-man'], trend: 'sma50' }).map((h) => h.id);
      expect(ids).toEqual(['hanging-man']);
    });

    it('skips trend-dependent patterns before the SMA has warmed up', () => {
      const bars = toBars([...FILLER, HAMMER]);
      expect(detectCandlestickPatterns(bars, { ids: ['hammer'] })).toEqual([]);
    });
  });
});
