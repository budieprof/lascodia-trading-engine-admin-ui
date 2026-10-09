import { Pipe, type PipeTransform } from '@angular/core';

import type { NewsArticleView } from '@features/news-intel/news-intel.types';
import { currencyFlag } from './economic-calendar';

/**
 * The chart's news pane, as pure functions: both legs' headlines merged (SP-07), a headline's age that keeps
 * moving (SP-11), and each article's flags for the pair's currencies (SP-I7).
 */

/**
 * Merge per-currency article lists: once per article, newest first. The pane asks for the base AND the quote
 * currency separately so each gets its own budget — one combined read let a busy USD tape crowd EUR out of EURUSD.
 */
export function mergeArticles(...lists: ReadonlyArray<readonly NewsArticleView[] | null | undefined>): NewsArticleView[] {
  const byId = new Map<number, NewsArticleView>();
  for (const list of lists) for (const a of list ?? []) if (!byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.publishedAtUtc) - Date.parse(a.publishedAtUtc) || b.id - a.id,
  );
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago` — relative to `nowMs`, never negative. */
export function headlineAge(publishedAtUtc: string, nowMs: number): string {
  const t = Date.parse(publishedAtUtc);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export interface ArticleFlag {
  currency: string;
  /** Country flag emoji ('' when unknown). */
  flag: string;
  direction: 'Bullish' | 'Bearish' | 'Neutral';
  /** ▲ ▼ or · */
  arrow: string;
  category: string;
  /** The classifier's rationale, for the tooltip. */
  title: string;
}

/**
 * The article's reading for each of `currencies` (one per currency, the most relevant label), in the order given.
 * An article not yet labelled for them has none.
 */
export function articleFlags(a: NewsArticleView, currencies: readonly string[]): ArticleFlag[] {
  const out: ArticleFlag[] = [];
  for (const ccy of currencies) {
    const code = ccy.toUpperCase();
    const label = (a.labels ?? [])
      .filter((l) => l.currency.toUpperCase() === code)
      .sort((x, y) => y.relevance * y.confidence - x.relevance * x.confidence)[0];
    if (!label) continue;
    const direction =
      label.direction === 'Bullish' || label.direction === 'Bearish' ? label.direction : 'Neutral';
    const category = label.category.replace(/([a-z])([A-Z])/g, '$1 $2');
    out.push({
      currency: code,
      flag: currencyFlag(code),
      direction,
      arrow: direction === 'Bullish' ? '▲' : direction === 'Bearish' ? '▼' : '·',
      category,
      title:
        `${code} ${direction.toLowerCase()} · ${category} · ${label.certainty}` +
        (label.rationale ? ` — ${label.rationale}` : ''),
    });
  }
  return out;
}

/** `@for (f of a | articleFlags: currencies; track f.currency)` — see {@link articleFlags}. */
@Pipe({ name: 'articleFlags', standalone: true })
export class ArticleFlagsPipe implements PipeTransform {
  transform(a: NewsArticleView, currencies: readonly string[] | null | undefined): ArticleFlag[] {
    return articleFlags(a, currencies ?? []);
  }
}
