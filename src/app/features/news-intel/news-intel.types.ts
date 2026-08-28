/**
 * News Intelligence cockpit types — mirror of the engine's
 * `/news-intel/*` contract (LascodiaTradingEngine.API/Controllers/v1/NewsIntelController.cs).
 */

/** How an article reached the engine. */
export type NewsSourceKind = 'Rss' | 'Search' | 'LlmSweep' | 'CentralBank' | 'EconomicCalendar';

/** Where an article sits in the labelling pipeline. */
export type NewsClassificationStatus =
  | 'Pending'
  | 'InProgress'
  | 'Completed'
  | 'Failed'
  | 'Skipped';

/** One weighted contributor behind a leg's pressure. */
export interface NewsPressureItem {
  headline: string;
  source: string | null;
  category: string;
  direction: string;
  certainty: string;
  novelty: string;
  ageMinutes: number;
  /** Final decayed weight, 0–1. */
  weight: number;
  /**
   * What the tape did in the hour after publication: `NotMeasured` (window still open, or no
   * strength history covers it), `Muted`, `Confirmed`, `Contradicted`. Only `Muted` and
   * `Contradicted` reduce the weight — confirmation is reported but never amplifies, because
   * a move in the labelled direction cannot distinguish a repricing that is starting from one
   * that is ending.
   */
  marketResponse: string;
  /** The realised currency-strength move behind that verdict, or null when unmeasured. */
  marketResponsePct: number | null;
}

/** One currency leg's pressure. */
export interface NewsPressureLeg {
  currency: string;
  /** Signed, −1..+1; positive is currency-bullish. */
  score: number;
  /** Unsigned "how much news is in play", 0..1. */
  absolutePressure: number;
  articleCount: number;
  /** Distinct story clusters — the syndication-adjusted count. */
  storyCount: number;
  dominantCategory: string | null;
  topItems: NewsPressureItem[];
  /** Directional contributors whose post-publication window had closed. */
  responseMeasured: number;
  /** …of those, how many the market did not move on. A high share means the score rests on news already discounted. */
  responseMuted: number;
  /** …how many the currency moved WITH. */
  responseConfirmed: number;
  /** …how many the currency moved AGAINST. */
  responseContradicted: number;

  // ── Liveness ──
  // The score says which way the evidence points; these say how much of it is still tradeable.
  // A trade-war cluster holds a currency deeply negative for days after the market has finished
  // repricing it — true, and no longer an opportunity.

  /** The recency window liveness was computed over, in minutes. */
  freshWindowMinutes: number;
  /** Contributors inside that window, whatever the tape did. */
  freshCount: number;
  /** …of those, how many the market has not already absorbed (Muted) or contradicted. */
  liveCount: number;
  /**
   * Share of the leg's weight that is still live, 0..1 — the number that falls to zero as a
   * story ages out. Null when there is no weight to divide: "nothing to measure" and "measured,
   * and none of it is live" are different claims.
   */
  liveShare: number | null;
  /** Signed sum over the live contributors — which way the still-tradeable part points. */
  liveSignedWeight: number;
}

/** The block exactly as the analysis prompt would carry it. */
export interface NewsPressureContext {
  baseLeg: NewsPressureLeg | null;
  quoteLeg: NewsPressureLeg | null;
  /**
   * base − quote, squashed. Positive favours a long.
   *
   * Null when the difference cannot be meant: a single-currency request, or a leg whose code
   * the module does not track (the base of "XAUUSD"). A tracked leg that is merely quiet
   * counts as zero and keeps this non-null.
   */
  pairBias: number | null;
  asOfNote: string;
  /** Scores computed under different fingerprints are not comparable. */
  paramsFingerprint: string;
}

/**
 * Focused read for one instrument. `includedInPrompt` is deliberately separate from
 * `context`: the block can exist and still be withheld from the model (module on but prompt
 * block off, or below the noise floor), and an operator needs to see both facts.
 */
export interface NewsFocusResult {
  context: NewsPressureContext | null;
  includedInPrompt: boolean;
  omissionReason: string | null;
  baseCurrency: string;
  quoteCurrency: string | null;
}

/** One label as returned by the article listing. */
export interface NewsLabelView {
  currency: string;
  category: string;
  direction: string;
  certainty: string;
  novelty: string;
  horizon: string;
  magnitude: number;
  relevance: number;
  confidence: number;
  rationale: string | null;
}

/** One stored article with its labels. */
export interface NewsArticleView {
  id: number;
  title: string;
  sourceName: string;
  sourceKind: NewsSourceKind;
  url: string | null;
  publishedAtUtc: string;
  /** The point-in-time anchor — when the engine could first have acted on it. */
  firstSeenUtc: string;
  storyKey: string;
  classificationStatus: NewsClassificationStatus;
  classifierModel: string | null;
  classifierLlmInvocationId: number | null;
  lastError: string | null;
  labels: NewsLabelView[];
}

/** Per-source ingestion stat. `newest` is the staleness tell. */
export interface NewsSourceStatView {
  kind: string;
  source: string;
  count: number;
  newest: string;
  /** Articles this publisher produced that were labelled for at least one tracked currency. */
  labelled: number;
  /** Articles classified and found to bear on no tracked currency. */
  skipped: number;
  /**
   * skipped / count, 0–1. The evidence for `NewsIntel:Ingest:BlockedPublishers`: a publisher
   * near 1.0 is spending model batches — shared with money-path spot analysis — to produce
   * nothing.
   */
  skipRate: number;
}

/** Latest roll-up for one currency. */
export interface NewsPressureSummaryView {
  currency: string;
  asOfUtc: string;
  weightedScore: number;
  absolutePressure: number;
  articleCount: number;
  storyCount: number;
  dominantCategory: string | null;
  paramsFingerprint: string | null;

  // ── Liveness, as recorded at asOfUtc ──
  // NULL on rows written before liveness shipped. Render that as unknown, never as zero:
  // zero is the claim "fully priced", and nobody measured that for historical rows.
  freshWindowMinutes: number | null;
  freshCount: number | null;
  liveCount: number | null;
  /** Share of this row's weight still live, 0..1. */
  liveShare: number | null;
  liveSignedWeight: number | null;
}

/**
 * Per-discovery-channel totals. `newest` is the liveness tell — a channel whose newest
 * article is hours old is not quiet, it is broken.
 */
export interface NewsChannelStatView {
  kind: string;
  count: number;
  publishers: number;
  newest: string;
  /** Age of the newest article on this channel, in minutes. */
  staleMinutes: number;
  /**
   * Server verdict, against a threshold matched to THIS channel's cadence. Do not re-derive it
   * client-side: a central-bank wire quiet for two days is normal and an RSS backbone quiet for
   * two hours is dead, and a cockpit that guesses differently from the engine is worse than one
   * that says nothing.
   */
  stale: boolean;
}

/** Module health snapshot. */
export interface NewsIntelStatusView {
  enabled: boolean;
  windowHours: number;
  articlesByStatus: Record<string, number>;
  channelBreakdown: NewsChannelStatView[];
  sourceBreakdown: NewsSourceStatView[];
  latestPressure: NewsPressureSummaryView[];
}

/** One point on a currency's pressure time series. */
export interface NewsPressurePoint {
  asOfUtc: string;
  weightedScore: number;
  absolutePressure: number;
  articleCount: number;
  paramsFingerprint: string | null;
  /** Share still live at this point — plot beside the score to see edge drain while it holds. */
  liveShare: number | null;
}

/** One currency's pressure series — a leg of the divergence chart. */
export interface NewsCurrencySeries {
  currency: string;
  points: NewsPressurePoint[];
}

/**
 * Articles first seen in one hour, split by channel.
 *
 * Counts rather than rates: a rate normalises away exactly the thing worth seeing, which is a
 * channel's band going flat while the others carry on.
 */
export interface NewsIngestBucket {
  hourUtc: string;
  total: number;
  byChannel: Record<string, number>;
}

/** What one liveness-backfill pass did. Repeat while `remainingRows` is non-zero. */
export interface NewsLivenessBackfillResult {
  instantsProcessed: number;
  rowsFilled: number;
  rowsWithoutReading: number;
  remainingRows: number;
  oldestRemainingUtc: string | null;
  dryRun: boolean;
}

/** One editable knob, with the description that explains what it does. */
export interface NewsConfigEntry {
  key: string;
  value: string;
  dataType: string;
  description: string | null;
  isHotReloadable: boolean;
}

/** A pending knob change. */
export interface NewsConfigChange {
  key: string;
  value: string;
  dataType?: string;
}

/**
 * Config panel grouping. Purely presentational — derived from the key prefix so a knob added
 * on the engine side appears in the right section without a UI change.
 */
export interface NewsConfigGroup {
  title: string;
  blurb: string;
  entries: NewsConfigEntry[];
}

/** Config-panel sections, in display order, keyed on the segment after `NewsIntel:`. */
export const NEWS_CONFIG_SECTIONS: { match: string; title: string; blurb: string }[] = [
  {
    match: 'Ingest:',
    title: 'Sourcing',
    blurb: 'Which feeds and searches are polled, how often, and how far back they look.',
  },
  {
    match: 'Sweep:',
    title: 'LLM web sweep',
    blurb:
      'The hourly model sweep that finds stories no subscribed feed carried. Slow by nature; runs in its own worker so it never delays feed polling.',
  },
  {
    match: 'Classify:',
    title: 'Classification',
    blurb:
      'How articles get labelled. The model decides what kind of event it is; it never decides how much it counts for.',
  },
  {
    match: 'Pressure:',
    title: 'Roll-up',
    blurb:
      'Cadence and window for the per-currency aggregation, plus the SentimentSnapshot mirror.',
  },
  {
    match: 'Prompt:',
    title: 'Prompt injection',
    blurb: 'Whether and how the block reaches the spot-analysis prompt.',
  },
  {
    match: 'FreshEdge:',
    title: 'Fresh edge',
    blurb:
      'How much of a reading is still LIVE, as opposed to merely true. The score says which way the evidence points; it does not say whether anything is left to trade, and the two come apart routinely — a trade-war cluster held CAD at −0.99 for days after the market had finished repricing it. Live = inside this window AND not already Muted or Contradicted by the tape. Stories with no measured response yet count as live on purpose: for genuinely fresh news the response window has not closed, and requiring a confirmed response selects almost nothing, because confirmation only accrues with age.',
  },
  {
    match: 'Weight:Response',
    title: 'Market response',
    blurb:
      'What the tape did in the hour after a story, folded in as damping ONLY. A story the market ignored counts for less; one it moved against counts for less still; one it moved with is reported but never amplified — confirmation cannot tell a repricing that is starting from one that is ending. Set the muted factor to 1.0 to switch the damping off while still reporting the verdict.',
  },
  {
    match: 'Weight:',
    title: 'Weight formula',
    blurb:
      'Every term of the score. weight = severity × source reliability × certainty × novelty × relevance × confidence × decay × corroboration × market response. Changing any of these re-scores everything on the next roll-up.',
  },
  {
    match: 'Retention:',
    title: 'Retention',
    blurb:
      'How long articles, labels and roll-ups are kept. Articles are backtest input — keep them.',
  },
];
