import type { CurrencySentiment } from './chart-panels.types';

/** Plain words for a −1 … +1 news-pressure score. */
export function sentimentWord(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'no reading';
  if (score <= -0.5) return 'strongly bearish';
  if (score <= -0.15) return 'bearish';
  if (score < 0.15) return 'neutral';
  if (score < 0.5) return 'bullish';
  return 'strongly bullish';
}

/** The news score's change over about 24 hours, two decimals; null without both readings. */
export function newsChange(s: CurrencySentiment | null | undefined): number | null {
  if (s?.newsScore == null || s.newsScore24hAgo == null) return null;
  return Math.round((s.newsScore - s.newsScore24hAgo) * 100) / 100;
}

/** The pair's news tilt in words: which currency the news favours, or neither. */
export function tiltWords(tilt: number | null | undefined, base: string | null, quote: string | null): string {
  if (tilt === null || tilt === undefined || !base || !quote) return 'not comparable';
  if (Math.abs(tilt) < 0.15) return `no clear side between ${base} and ${quote}`;
  return tilt > 0 ? `the news favours ${base} over ${quote}` : `the news favours ${quote} over ${base}`;
}

/** `44% long` for a 0–100 share; '—' without one. */
export function longShare(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? '—' : `${Math.round(pct)}% long`;
}

/** A weekly COT report is stale after ~10 days (published every Friday for the Tuesday before). */
export function cotIsStale(reportDate: string | null | undefined, nowMs: number): boolean {
  if (!reportDate) return false;
  const t = Date.parse(reportDate);
  return Number.isFinite(t) && nowMs - t > 10 * 86_400_000;
}
