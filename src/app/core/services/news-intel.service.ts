import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '@core/api/api.service';
import { ResponseData } from '@core/api/api.types';
import {
  NEWS_CONFIG_SECTIONS,
  NewsArticleView,
  NewsClassificationStatus,
  NewsConfigChange,
  NewsConfigEntry,
  NewsConfigGroup,
  NewsFocusResult,
  NewsIntelStatusView,
  NewsPressurePoint,
  NewsPressureSummaryView,
} from '@features/news-intel/news-intel.types';

/**
 * Data access for the News Intelligence cockpit — `/news-intel/*` on the engine.
 *
 * No mock branch: every endpoint here is live. The module ships disabled, so an empty
 * cockpit is a real and correct state rather than something to paper over with fixtures.
 */
@Injectable({ providedIn: 'root' })
export class NewsIntelService {
  private readonly api = inject(ApiService);

  /**
   * The focused read for one instrument — the block the analysis prompt would carry, plus
   * whether it would actually carry it.
   *
   * Accepts a pair symbol (`EURUSD`) or a single currency (`USD`). This hits the same engine
   * service the snapshot builder uses, so the cockpit cannot show a number the model never saw.
   */
  getFocus(symbol: string, asOfUtc?: string): Observable<NewsFocusResult> {
    const qs = new URLSearchParams({ symbol });
    if (asOfUtc) qs.set('asOfUtc', asOfUtc);
    return this.api.getEnvelope<NewsFocusResult>(`/news-intel/focus?${qs}`);
  }

  /** Module health: article counts by status, per-source ingestion, latest pressure. */
  getStatus(hours = 24): Observable<NewsIntelStatusView> {
    return this.api.getEnvelope<NewsIntelStatusView>(`/news-intel/status?hours=${hours}`);
  }

  /** Current weighted pressure per currency, with contributing headlines. */
  getPressure(opts?: {
    currencies?: string[];
    asOfUtc?: string;
    topItems?: number;
  }): Observable<NewsPressureSummaryView[]> {
    const qs = new URLSearchParams();
    if (opts?.currencies?.length) qs.set('currencies', opts.currencies.join(','));
    if (opts?.asOfUtc) qs.set('asOfUtc', opts.asOfUtc);
    if (opts?.topItems) qs.set('topItems', String(opts.topItems));
    const suffix = qs.toString();
    return this.api.getEnvelope<NewsPressureSummaryView[]>(
      `/news-intel/pressure${suffix ? `?${suffix}` : ''}`,
    );
  }

  /** The raw record layer — recently ingested articles with their labels. */
  getArticles(opts?: {
    currency?: string;
    status?: NewsClassificationStatus;
    hours?: number;
    take?: number;
  }): Observable<NewsArticleView[]> {
    const qs = new URLSearchParams();
    if (opts?.currency) qs.set('currency', opts.currency);
    if (opts?.status) qs.set('status', opts.status);
    qs.set('hours', String(opts?.hours ?? 24));
    qs.set('take', String(opts?.take ?? 100));
    return this.api.getEnvelope<NewsArticleView[]>(`/news-intel/articles?${qs}`);
  }

  /** Pressure history for one currency — the series behind the sparkline. */
  getTimeseries(currency: string, hours = 48): Observable<NewsPressurePoint[]> {
    return this.api.getEnvelope<NewsPressurePoint[]>(
      `/news-intel/timeseries?currency=${encodeURIComponent(currency)}&hours=${hours}`,
    );
  }

  /** Every `NewsIntel:` knob with its current value and description. */
  getConfig(): Observable<NewsConfigEntry[]> {
    return this.api.getEnvelope<NewsConfigEntry[]>('/news-intel/config');
  }

  /**
   * Saves knob changes.
   *
   * Returns one message per key: the engine's risk-loosening governance may QUEUE a change
   * for cooling-off rather than apply it, and the difference is only visible in that message.
   * Treating a 200 as "applied" would be wrong.
   */
  saveConfig(
    entries: NewsConfigChange[],
    opts?: { reason?: string; immediate?: boolean },
  ): Observable<string[]> {
    return this.api
      .put<ResponseData<string[]>>('/news-intel/config', {
        entries,
        reason: opts?.reason ?? null,
        immediate: opts?.immediate ?? false,
      })
      .pipe(map((r) => r.data ?? []));
  }

  /** Sends one article back to the classification queue, clearing its labels and attempts. */
  reclassify(articleId: number): Observable<string> {
    return this.api
      .post<ResponseData<string>>(`/news-intel/articles/${articleId}/reclassify`)
      .pipe(map((r) => r.data ?? r.message ?? 'requeued'));
  }

  /**
   * Groups config rows into display sections by key prefix. Anything that matches no section
   * lands in a trailing "Other" group rather than vanishing — a knob added engine-side must
   * become visible without a UI change, which is the whole point of driving this off the
   * server's key list.
   */
  static groupConfig(entries: NewsConfigEntry[]): NewsConfigGroup[] {
    const groups: NewsConfigGroup[] = NEWS_CONFIG_SECTIONS.map((s) => ({
      title: s.title,
      blurb: s.blurb,
      entries: [],
    }));

    const other: NewsConfigEntry[] = [];

    for (const entry of entries) {
      const idx = NEWS_CONFIG_SECTIONS.findIndex((s) =>
        entry.key.startsWith(`NewsIntel:${s.match}`),
      );
      if (idx >= 0) groups[idx].entries.push(entry);
      else other.push(entry);
    }

    if (other.length) {
      groups.unshift({
        title: 'Module',
        blurb: 'Master switch and the currency set everything else is scoped to.',
        entries: other,
      });
    }

    return groups.filter((g) => g.entries.length > 0);
  }

  /** Short label for a key, for use as a form field name. Strips the section prefix. */
  static shortLabel(key: string): string {
    const tail = key.replace(/^NewsIntel:/, '');
    const seg = tail.includes(':') ? tail.slice(tail.indexOf(':') + 1) : tail;
    // "HalfLifeIntradayMinutes" → "Half life intraday minutes"
    return seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  }
}
