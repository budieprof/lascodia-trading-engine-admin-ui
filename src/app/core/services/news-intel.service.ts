import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiCallOptions, ApiService } from '@core/api/api.service';
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
  NewsCurrencySeries,
  NewsIngestBucket,
  NewsLivenessBackfillResult,
  NewsPressureSummaryView,
  NewsArticleAnalysis,
  NewsEvalRunRequest,
  NewsEvalRunView,
  NewsGoldEditRequest,
  NewsGoldPage,
  NewsGoldProvenance,
  NewsGoldSeedResult,
  NewsStoryState,
  NewsStoryView,
  ScheduledMarketEventRow,
  NewsEventStudyRunView,
  NewsEventStudyDetail,
  NewsEventStudyResultView,
  NewsCoverageView,
  NewsExposureListView,
  NewsRiskObservationKind,
  NewsRiskObservationPage,
  NewsStoryMembersView,
  NewsVendorVerifyResult,
} from '@features/news-intel/news-intel.types';
import type { NewsPressureReadingView } from '@features/news-intel/news-intel.logic';

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
  getFocus(symbol: string, asOfUtc?: string, opts?: ApiCallOptions): Observable<NewsFocusResult> {
    const qs = new URLSearchParams({ symbol });
    if (asOfUtc) qs.set('asOfUtc', asOfUtc);
    return this.api.getEnvelope<NewsFocusResult>(`/news-intel/focus?${qs}`, opts);
  }

  /** Module health: article counts by status, per-source ingestion, latest pressure. */
  getStatus(hours = 24, opts?: ApiCallOptions): Observable<NewsIntelStatusView> {
    return this.api.getEnvelope<NewsIntelStatusView>(`/news-intel/status?hours=${hours}`, opts);
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

  /** Every tracked currency's series in ONE call — the divergence chart must read all legs from
   *  the same rows, or "USD up while CAD collapses" is a fact about request timing. */
  getAllTimeseries(hours = 48, maxPointsPerCurrency = 400): Observable<NewsCurrencySeries[]> {
    return this.api.getEnvelope<NewsCurrencySeries[]>(
      `/news-intel/timeseries-all?hours=${hours}&maxPointsPerCurrency=${maxPointsPerCurrency}`,
    );
  }

  /** Articles first seen per hour by channel — the visual form of a silently dead feed. */
  getIngestHistory(hours = 48): Observable<NewsIngestBucket[]> {
    return this.api.getEnvelope<NewsIngestBucket[]>(`/news-intel/ingest-history?hours=${hours}`);
  }

  /**
   * AI summary + per-pair implications for one article; `symbol` is always included. Cached
   * per article by the engine for a day; `refresh` regenerates (a new LLM call).
   */
  analyseArticle(
    id: number,
    symbol: string | null,
    refresh = false,
  ): Observable<NewsArticleAnalysis> {
    const qs = new URLSearchParams();
    if (symbol) qs.set('symbol', symbol);
    if (refresh) qs.set('refresh', 'true');
    return this.api.postEnvelope<NewsArticleAnalysis>(
      `/news-intel/articles/${id}/analysis?${qs}`,
      {},
    );
  }

  /** Recompute liveness for roll-up rows written before it was tracked. Bounded; call until
   *  `remainingRows` is zero. */
  backfillLiveness(maxInstants = 100, dryRun = false): Observable<NewsLivenessBackfillResult> {
    return this.api.postEnvelope<NewsLivenessBackfillResult>('/news-intel/backfill-liveness', {
      maxInstants,
      dryRun,
    });
  }

  /**
   * Pressure readings with their weighted contributors (engine `NewsPressureReading`). `asOfUtc` reads
   * point-in-time. Used for freshness per key and for a story's weight over time.
   */
  getPressureReadings(opts: {
    keys?: string[];
    asOfUtc?: string;
    topItems?: number;
  }): Observable<NewsPressureReadingView[]> {
    const qs = new URLSearchParams();
    if (opts.keys?.length) qs.set('currencies', opts.keys.join(','));
    if (opts.asOfUtc) qs.set('asOfUtc', opts.asOfUtc);
    qs.set('topItems', String(opts.topItems ?? 20));
    return this.api.getEnvelope<NewsPressureReadingView[]>(`/news-intel/pressure?${qs}`, {
      silent: true,
    });
  }

  // ── Sourcing v2: scheduled market events ──────────────────────────────

  /**
   * Scheduled market events in [from, to] (engine caps the window at 120 days), optionally for one
   * exposure key. What the multi-asset blackout reads.
   */
  getScheduledEvents(opts?: {
    from?: string;
    to?: string;
    key?: string;
    take?: number;
  }): Observable<ScheduledMarketEventRow[]> {
    const qs = new URLSearchParams();
    if (opts?.from) qs.set('from', opts.from);
    if (opts?.to) qs.set('to', opts.to);
    if (opts?.key) qs.set('key', opts.key);
    qs.set('take', String(opts?.take ?? 1000));
    return this.api.getEnvelope<ScheduledMarketEventRow[]>(`/news-intel/scheduled-events?${qs}`, {
      silent: true,
    });
  }

  // ── Understanding v2: stories, gold set, evaluation ───────────────────

  /** Story clusters active in the window, newest first. */
  getStories(opts?: {
    hours?: number;
    exposure?: string;
    state?: NewsStoryState | null;
    take?: number;
  }): Observable<NewsStoryView[]> {
    const qs = new URLSearchParams();
    qs.set('hours', String(opts?.hours ?? 48));
    if (opts?.exposure) qs.set('exposure', opts.exposure);
    if (opts?.state) qs.set('state', opts.state);
    qs.set('take', String(opts?.take ?? 200));
    return this.api.getEnvelope<NewsStoryView[]>(`/news-intel/stories?${qs}`, { silent: true });
  }

  /** A story's member articles, origin first, with publishers and labels (engine gaps build). */
  getStoryArticles(id: number, take = 200): Observable<NewsStoryMembersView> {
    return this.api.getEnvelope<NewsStoryMembersView>(
      `/news-intel/stories/${id}/articles?take=${take}`,
      { silent: true },
    );
  }

  // ── Gaps (engine ni/gaps) ──────────────────────────────────────────────

  /**
   * Every active universe symbol in one read — legs, coverage, bias, newest-item age, prompt verdict and
   * the blackout keys split legacy vs mode-governed. The engine computes pressure once per key and caches ~60 s.
   */
  getCoverage(opts?: {
    assetClass?: string | null;
    asOfUtc?: string | null;
  }): Observable<NewsCoverageView> {
    const qs = new URLSearchParams();
    if (opts?.assetClass) qs.set('assetClass', opts.assetClass);
    if (opts?.asOfUtc) qs.set('asOf', opts.asOfUtc);
    const q = qs.toString();
    return this.api.getEnvelope<NewsCoverageView>(`/news-intel/coverage${q ? '?' + q : ''}`, {
      silent: true,
    });
  }

  /** Tracked + recommended exposure keys with each key's effective search term and its source. */
  getExposureList(): Observable<NewsExposureListView> {
    return this.api.getEnvelope<NewsExposureListView>('/news-intel/exposures', { silent: true });
  }

  /** Recorded news-as-risk decisions (what Observe-mode gates would have refused), with counts. */
  getRiskObservations(opts?: {
    kind?: NewsRiskObservationKind | null;
    symbol?: string | null;
    fromUtc?: string | null;
    toUtc?: string | null;
    take?: number;
  }): Observable<NewsRiskObservationPage> {
    const qs = new URLSearchParams();
    if (opts?.kind) qs.set('kind', opts.kind);
    if (opts?.symbol) qs.set('symbol', opts.symbol);
    if (opts?.fromUtc) qs.set('from', opts.fromUtc);
    if (opts?.toUtc) qs.set('to', opts.toUtc);
    qs.set('take', String(opts?.take ?? 200));
    return this.api.getEnvelope<NewsRiskObservationPage>(`/news-intel/risk-observations?${qs}`, {
      silent: true,
    });
  }

  /** One bounded call to a paid vendor with its stored key; answers ok/error + a key fingerprint, never the key. */
  verifyVendor(name: string): Observable<NewsVendorVerifyResult> {
    return this.api.postEnvelope<NewsVendorVerifyResult>(
      `/news-intel/vendors/${encodeURIComponent(name)}/verify`,
      {},
      { silent: true },
    );
  }

  /** Gold labels with their article headline, filtered by provenance / exposure. */
  getGold(opts?: {
    provenance?: NewsGoldProvenance | null;
    exposure?: string;
    skip?: number;
    take?: number;
  }): Observable<NewsGoldPage> {
    const qs = new URLSearchParams();
    if (opts?.provenance) qs.set('provenance', opts.provenance);
    if (opts?.exposure) qs.set('exposure', opts.exposure);
    qs.set('skip', String(opts?.skip ?? 0));
    qs.set('take', String(opts?.take ?? 50));
    return this.api.getEnvelope<NewsGoldPage>(`/news-intel/gold?${qs}`, { silent: true });
  }

  /** Applies the shipped agent-drafted fixture. Idempotent; never overwrites a review. */
  seedGold(): Observable<NewsGoldSeedResult> {
    return this.api.postEnvelope<NewsGoldSeedResult>('/news-intel/gold/seed', {}, { silent: true });
  }

  /** Confirms a gold label as it stands. Returns the new provenance. */
  confirmGold(id: number): Observable<string> {
    return this.api.postEnvelope<string>(`/news-intel/gold/${id}/confirm`, {}, { silent: true });
  }

  /** Edits a gold label. Returns the new provenance (OperatorEdited, or OperatorConfirmed for a no-op). */
  editGold(id: number, body: NewsGoldEditRequest): Observable<string> {
    return this.api.putEnvelope<string>(`/news-intel/gold/${id}`, body, { silent: true });
  }

  /** Starts an evaluation run (background). One at a time — a refusal says why. */
  runEval(body: NewsEvalRunRequest): Observable<NewsEvalRunView> {
    return this.api.postEnvelope<NewsEvalRunView>('/news-intel/eval/run', body, { silent: true });
  }

  /** Recent evaluation runs, newest first (without metricsJson). */
  getEvalRuns(take = 20): Observable<NewsEvalRunView[]> {
    return this.api.getEnvelope<NewsEvalRunView[]>(`/news-intel/eval/runs?take=${take}`, {
      silent: true,
    });
  }

  /** One evaluation run with its full metric set. */
  getEvalRun(id: number): Observable<NewsEvalRunView> {
    return this.api.getEnvelope<NewsEvalRunView>(`/news-intel/eval/runs/${id}`, { silent: true });
  }

  // ── Validation (wave 2): event study ──────────────────────────────────
  // Routes follow the eval pattern (`eval/run`, `eval/runs`, `eval/runs/{id}`) plus the brief's
  // `event-study/{id}/recommended-weights`. An engine without them answers 404; callers show that.

  /** Starts an event-study run over [fromUtc, toUtc) (async; poll the run). */
  runEventStudy(body: {
    fromUtc?: string;
    toUtc?: string;
    lineage?: string | null;
  }): Observable<NewsEventStudyRunView> {
    return this.api.postEnvelope<NewsEventStudyRunView>('/news-intel/event-study/run', body, {
      silent: true,
    });
  }

  /** Recent event-study runs, newest first. */
  getEventStudyRuns(take = 20): Observable<NewsEventStudyRunView[]> {
    return this.api.getEnvelope<NewsEventStudyRunView[]>(
      `/news-intel/event-study/runs?take=${take}`,
      {
        silent: true,
      },
    );
  }

  /**
   * One run with its result rows. Accepts either `{ run, results }` or a run object carrying
   * `results`, so the page does not depend on which envelope the engine settles on.
   */
  getEventStudyRun(id: number): Observable<NewsEventStudyDetail> {
    return this.api
      .getEnvelope<
        NewsEventStudyDetail | (NewsEventStudyRunView & { results?: NewsEventStudyResultView[] })
      >(`/news-intel/event-study/runs/${id}`, { silent: true })
      .pipe(
        map((d) =>
          'run' in d && d.run
            ? { run: d.run, results: d.results ?? [] }
            : {
                run: d as NewsEventStudyRunView,
                results: (d as { results?: NewsEventStudyResultView[] }).results ?? [],
              },
        ),
      );
  }

  /** The recommended `Weight:CategorySeverityJson` for a run (shape read by `parseRecommendation`). */
  getRecommendedWeights(id: number): Observable<unknown> {
    return this.api.getEnvelope<unknown>(`/news-intel/event-study/${id}/recommended-weights`, {
      silent: true,
    });
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
      const idx = NEWS_CONFIG_SECTIONS.findIndex(
        (s) =>
          entry.key.startsWith(`NewsIntel:${s.match}`) ||
          // A section's own bare key (`NewsIntel:Exposures` for `Exposures:`) belongs to it too.
          (s.match.endsWith(':') && entry.key === `NewsIntel:${s.match.slice(0, -1)}`),
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
