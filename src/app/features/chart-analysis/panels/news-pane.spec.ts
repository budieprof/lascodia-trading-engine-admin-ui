import { describe, expect, it } from 'vitest';

import type { NewsArticleView, NewsLabelView } from '@features/news-intel/news-intel.types';
import { articleFlags, headlineAge, mergeArticles } from './news-pane';

const label = (currency: string, direction: string, relevance = 0.8, confidence = 0.8): NewsLabelView => ({
  currency,
  category: 'MonetaryPolicy',
  direction,
  certainty: 'Confirmed',
  novelty: 'New',
  horizon: 'Days',
  magnitude: 2,
  relevance,
  confidence,
  rationale: 'ECB signals a pause',
});

const art = (id: number, at: string, labels: NewsLabelView[] = []): NewsArticleView =>
  ({ id, title: `#${id}`, sourceName: 'Reuters', publishedAtUtc: at, labels }) as unknown as NewsArticleView;

describe('news pane (SP-07, SP-11, SP-I7)', () => {
  it('merges both legs once per article, newest first', () => {
    const eur = [art(1, '2026-10-09T08:00:00Z'), art(3, '2026-10-09T10:00:00Z')];
    const usd = [art(2, '2026-10-09T09:00:00Z'), art(3, '2026-10-09T10:00:00Z')];
    expect(mergeArticles(eur, usd, null).map((a) => a.id)).toEqual([3, 2, 1]);
  });

  it('a headline’s age moves with the clock', () => {
    const at = '2026-10-09T10:00:00Z';
    const t = Date.parse(at);
    expect(headlineAge(at, t + 20_000)).toBe('just now');
    expect(headlineAge(at, t + 5 * 60_000)).toBe('5 min ago');
    expect(headlineAge(at, t + 3 * 3_600_000)).toBe('3 h ago');
    expect(headlineAge(at, t + 50 * 3_600_000)).toBe('2 d ago');
    expect(headlineAge(at, t - 60_000)).toBe('just now'); // a clock behind the feed never reads negative
  });

  it('flags the pair’s currencies with the most relevant label each', () => {
    const a = art(1, '2026-10-09T10:00:00Z', [
      label('EUR', 'Bearish', 0.9, 0.9),
      label('EUR', 'Bullish', 0.2, 0.5),
      label('USD', 'Neutral'),
      label('JPY', 'Bullish'),
    ]);
    const flags = articleFlags(a, ['EUR', 'USD']);
    expect(flags.map((f) => [f.currency, f.direction, f.arrow])).toEqual([
      ['EUR', 'Bearish', '▼'],
      ['USD', 'Neutral', '·'],
    ]);
    expect(flags[0].category).toBe('Monetary Policy');
    expect(flags[0].title).toContain('ECB signals a pause');
    expect(articleFlags(art(2, '2026-10-09T10:00:00Z'), ['EUR'])).toEqual([]);
  });
});
