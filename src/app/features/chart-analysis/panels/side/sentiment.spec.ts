import { describe, expect, it } from 'vitest';

import type { CurrencySentiment } from './chart-panels.types';
import { cotIsStale, longShare, newsChange, sentimentWord, tiltWords } from './sentiment';

describe('sentiment panel (SP-I9)', () => {
  it('puts scores into plain words', () => {
    expect(sentimentWord(-0.61)).toBe('strongly bearish');
    expect(sentimentWord(-0.2)).toBe('bearish');
    expect(sentimentWord(0.05)).toBe('neutral');
    expect(sentimentWord(0.3)).toBe('bullish');
    expect(sentimentWord(0.58)).toBe('strongly bullish');
    expect(sentimentWord(null)).toBe('no reading');
  });

  it('change over 24h, tilt and COT long share', () => {
    expect(newsChange({ newsScore: -0.6, newsScore24hAgo: -0.2 } as CurrencySentiment)).toBe(-0.4);
    expect(newsChange({ newsScore: -0.6, newsScore24hAgo: null } as CurrencySentiment)).toBeNull();
    expect(tiltWords(-1, 'EUR', 'USD')).toBe('the news favours USD over EUR');
    expect(tiltWords(0.05, 'EUR', 'USD')).toBe('no clear side between EUR and USD');
    expect(tiltWords(null, 'EUR', 'USD')).toBe('not comparable');
    expect(longShare(44.1)).toBe('44% long');
    expect(longShare(null)).toBe('—');
  });

  it('a weekly COT report goes stale after ten days', () => {
    const now = Date.parse('2026-10-09T00:00:00Z');
    expect(cotIsStale('2026-09-29T00:00:00Z', now)).toBe(false);
    expect(cotIsStale('2026-09-22T00:00:00Z', now)).toBe(true);
  });
});
