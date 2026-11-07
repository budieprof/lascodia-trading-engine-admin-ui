/**
 * News Intelligence cockpit types — mirror of the engine's
 * `/news-intel/*` contract (LascodiaTradingEngine.API/Controllers/v1/NewsIntelController.cs).
 */

/** How an article reached the engine. */
export type NewsSourceKind =
  | 'Rss'
  | 'Search'
  | 'LlmSweep'
  | 'CentralBank'
  | 'EconomicCalendar'
  // Sourcing v2 (news-intel program, 2026-11-07).
  | 'Filing'
  | 'PressWire'
  | 'Vendor';

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
  /**
   * Every exposure leg of the symbol (ADR-0035) with weight, basis, coverage, score and
   * contribution. Null/absent for a single-key request or an engine before ADR-0035.
   */
  legs?: NewsExposureLegView[] | null;
  /**
   * tanh(Σ weight × score) over the covered legs — equals pairBias for a fully covered FX pair.
   * NULL when coverage would mislead (a ±1 leg untracked, or nothing covered): never render it as 0.
   */
  symbolBias?: number | null;
  /** Share of Σ|weight| on tracked legs, 0..1. */
  coverage?: number | null;
  /** True for indices, stocks, energy, crypto: the prompt renders the multi-leg block. */
  multiLeg?: boolean;
}

/** One exposure leg of a symbol's news reading (engine `NewsExposureLegView`, ADR-0035). */
export interface NewsExposureLegView {
  /** Exposure key: `USD`, `WTI`, `IDX:US500`, `EQ:AAPL`, `CR:BTC`, `F:RISK`. */
  key: string;
  weight: number;
  /** base, quote, own, constituent, factor:static, factor:fitted. */
  basis: string;
  /** Whether the module tracks this key — an untracked leg has no score, not a zero one. */
  covered: boolean;
  /** Null when untracked; 0 for a tracked key that is quiet. */
  score: number | null;
  contribution: number | null;
  absolutePressure: number | null;
  storyCount: number | null;
}

/** One static/fitted exposure leg as the exposure map resolved it (engine `ExposureLeg`). */
export interface ExposureLegDto {
  key: string;
  weight: number;
  basis: string;
}

/** A symbol resolved through the exposure map (engine `SymbolExposure`). */
export interface SymbolExposureDto {
  symbol: string;
  legs: ExposureLegDto[];
  /** Calendar codes whose High-impact scheduled events block entries on this symbol. */
  calendarKeys: string[];
  /** `catalogue` | `instrument` | `fitted`. */
  source: string;
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
  /** How the symbol resolved through the exposure map; null for a single-key request. */
  exposure?: SymbolExposureDto | null;
  /** News as risk (validation vertical): vol forecast, breaking stories, scheduled events. */
  risk?: NewsRiskBlockView | null;
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
  /** Sourcing v2: publish→first-seen p50/p90 per channel (source null) and per publisher, 24 h and 7 d. */
  latency?: NewsSourceLatencyView[] | null;
  /** Sourcing v2: conditional-GET state per polled feed URL. */
  feeds?: NewsFeedStateView[] | null;
  /** Sourcing v2: one sentence per source that is OFF, naming the knob that turns it on. */
  sourceNotes?: string[] | null;
}

/** Publish→first-seen lag for one channel (source null) or one publisher over one window. */
export interface NewsSourceLatencyView {
  channel: string;
  source: string | null;
  /** 24 or 168. */
  windowHours: number;
  count: number;
  p50Minutes: number;
  p90Minutes: number;
}

/** One polled feed's conditional-GET state. */
export interface NewsFeedStateView {
  url: string;
  /** Last HTTP status (304 = not modified). */
  lastStatus: number;
  lastPolledUtc: string;
  /** Consecutive 304s. */
  notModifiedStreak: number;
  /** The publisher sends ETag/Last-Modified, so a conditional GET is possible at all. */
  hasValidators: boolean;
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
    match: 'Exposures:',
    title: 'Exposures',
    blurb:
      'Which news exposures the module tracks (currencies, commodities, indices, stocks, crypto, factors). Empty means the same list as NewsIntel:Currencies. "Recommended" is derived from the symbol universe and read-only — copy from it.',
  },
  {
    match: 'Vendor:',
    title: 'Paid news vendors',
    blurb:
      'Benzinga, Polygon, Finnhub, Marketaux. Off by default. API keys are secrets: they show only as set / not set and are changed on the Sources tab.',
  },
  {
    match: 'Calendar:',
    title: 'Scheduled market events',
    blurb:
      'Earnings, EIA inventories, rig counts, expiries, OPEC+, promoted central-bank decisions and extra calendar countries. Recording only — whether they block entries is NewsBlackout:MultiAsset:Mode.',
  },
  {
    match: 'Story:',
    title: 'Stories',
    blurb:
      'Clustering articles into stories and their lifecycle (Developing / Confirmed / Denied / Resolved). Observe records stories without changing any weight; Enforce demotes echoes and zeroes denied claims.',
  },
  {
    match: 'Eval:',
    title: 'Evaluation',
    blurb: 'Bounds for operator-triggered classifier evaluations over the gold set.',
  },
  {
    match: 'Study:',
    title: 'Event study',
    blurb:
      'The nightly study of what the market did after news, which the recommended severities and the direction verdict come from.',
  },
  {
    match: 'Loadings:',
    title: 'Fitted loadings',
    blurb:
      'Weekly regression of each symbol on the factor proxies (risk, US rates, crypto market), shrunk toward the static weights and capped. Point-in-time: a loading is used only after it was computed.',
  },
  {
    match: 'BreakingGate:',
    title: 'Breaking-news gate',
    blurb:
      'Refuses new entries on a symbol for a few minutes after a fresh, official, high-severity story on one of its main legs. Observe records what would have been refused.',
  },
  {
    match: 'Risk:',
    title: 'News as risk',
    blurb:
      'Stop widening from the news volatility forecast, and the record of every news-as-risk decision (Risk:Observations:*) — what each gate in Observe would have refused. Never tightens a stop.',
  },
  {
    match: 'Coverage:',
    title: 'Coverage',
    blurb:
      'How long the bulk coverage read (every symbol at once) is reused before the engine recomputes it.',
  },
  {
    match: 'Retention:',
    title: 'Retention',
    blurb:
      'How long articles, labels and roll-ups are kept. Articles are backtest input — keep them.',
  },
];

/** One pair's reading of an article (`POST /news-intel/articles/{id}/analysis`). */
export interface NewsPairImplication {
  symbol: string;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  confidence: number;
  horizon: string;
  rationale: string;
}

/** On-demand AI read of one article — explanatory only, feeds no decision. */
export interface NewsArticleAnalysis {
  articleId: number;
  summary: string;
  analysis: string;
  pairs: NewsPairImplication[];
  risks: string[];
  model: string;
  llmInvocationId: number | null;
  generatedAtUtc: string;
  cached: boolean;
  /** True when the model read the article's body; false when only its headline. */
  readFullText: boolean;
  /** The publisher URL the body came from (Google News links resolved). */
  sourceUrl: string | null;
  /** Why the body could not be read, when it could not. */
  contentNote: string | null;
}

/** Config keys the engine lists but refuses to write (derived values). */
export const NEWS_READ_ONLY_KEYS: ReadonlySet<string> = new Set([
  'NewsIntel:Exposures:Recommended',
]);

/** The engine's masked placeholders for a secret value (`SecretConfigKeys`). */
export const SECRET_SET = '***SET';
export const SECRET_UNSET = '***UNSET';

// ── Exposure keys (ADR-0035) ─────────────────────────────────────────────

/** What an exposure key names (engine `ExposureKind`). */
export type ExposureKindName =
  | 'Currency'
  | 'Commodity'
  | 'EquityIndex'
  | 'Equity'
  | 'Crypto'
  | 'Factor';

// ── Scheduled market events (sourcing v2) ────────────────────────────────

/** Engine `ScheduledMarketEventKind`, serialised as its name. */
export type ScheduledMarketEventKind =
  | 'Earnings'
  | 'Inventories'
  | 'RigCount'
  | 'OpecMeeting'
  | 'OptionsExpiry'
  | 'IndexRebalance'
  | 'TokenUnlock'
  | 'CentralBankDecision'
  | 'Other';

/** One scheduled market event (`GET /news-intel/scheduled-events`). */
export interface ScheduledMarketEventRow {
  id: number;
  exposureKey: string;
  kind: ScheduledMarketEventKind | string;
  scheduledAtUtc: string;
  /** High / Medium / Low. Only High blocks (and only under Enforce). */
  impact: string;
  title: string;
  source: string;
  /** When the engine first knew of it — the point-in-time anchor. */
  firstSeenUtc: string;
  notes: string | null;
  actual: string | null;
}

// ── Stories (understanding v2) ───────────────────────────────────────────

export type NewsStoryState = 'Developing' | 'Confirmed' | 'Denied' | 'Resolved';

/** One story cluster (`GET /news-intel/stories`). The state is the LIVE reading. */
export interface NewsStoryView {
  id: number;
  eventKey: string | null;
  title: string;
  firstArticleId: number;
  firstSeenUtc: string;
  lastSeenUtc: string;
  /** Comma-separated exposure keys. */
  exposures: string;
  state: NewsStoryState | string;
  stateChangedAtUtc: string;
  deniedAtUtc: string | null;
  resolvedAtUtc: string | null;
  articleCount: number;
  publisherCount: number;
  /** How the newest member joined: event key or lexical similarity. */
  lastMatchBasis: string | null;
  /** Distinct publisher names among the members (engine gaps build; absent on older engines). */
  publishers?: string[];
}

/** One label of a story member (engine `NewsStoryMemberLabelView`). Novelty is per exposure key. */
export interface NewsStoryMemberLabelView {
  exposureKey: string;
  category: string;
  direction: string;
  certainty: string;
  novelty: string;
  relevance: number;
  confidence: number;
}

/** One member article of a story (engine `NewsStoryMemberView`). */
export interface NewsStoryMemberView {
  id: number;
  title: string;
  sourceName: string;
  sourceKind: string;
  url: string | null;
  publishedAtUtc: string;
  firstSeenUtc: string;
  classificationStatus: string;
  eventKey: string | null;
  stance: string;
  isOrigin: boolean;
  labels: NewsStoryMemberLabelView[];
}

/** `GET news-intel/stories/{id}/articles`. */
export interface NewsStoryMembersView {
  story: NewsStoryView;
  articles: NewsStoryMemberView[];
}

// ── Gold set + evaluation (understanding v2) ─────────────────────────────

export type NewsGoldProvenance = 'AgentDraft' | 'OperatorConfirmed' | 'OperatorEdited';

/** One gold label (`GET /news-intel/gold`). */
export interface NewsGoldLabelView {
  id: number;
  articleId: number;
  title: string;
  sourceName: string;
  firstSeenUtc: string;
  exposureKey: string;
  relevant: boolean;
  category: string;
  direction: string;
  certainty: string;
  relevance: number;
  stance: string;
  eventKey: string | null;
  provenance: NewsGoldProvenance | string;
  labeller: string;
  labelledAtUtc: string;
  note: string | null;
}

export interface NewsGoldPage {
  total: number;
  items: NewsGoldLabelView[];
  countsByProvenance: Record<string, number>;
}

/** `PUT /news-intel/gold/{id}` — only the fields sent are judged. */
export interface NewsGoldEditRequest {
  category?: string;
  direction?: string;
  certainty?: string;
  relevance?: number;
  relevant?: boolean;
  stance?: string;
  eventKey?: string;
  note?: string;
}

export interface NewsGoldSeedResult {
  [field: string]: unknown;
}

/** One evaluation run (`GET /news-intel/eval/runs[/{id}]`). The list omits `metricsJson`. */
export interface NewsEvalRunView {
  id: number;
  /** Running / Completed / Failed / Abandoned. */
  status: string;
  classifierModel: string | null;
  promptVersion: string | null;
  triageMode: string | null;
  articleCount: number;
  draftLabelCount: number;
  repeats: number;
  relevanceF1: number | null;
  categoryMacroF1: number | null;
  directionMacroF1: number | null;
  runToRunAgreement: number | null;
  metricsJson: string | null;
  requestedBy: string | null;
  error: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
}

/** `POST /news-intel/eval/run` body. */
export interface NewsEvalRunRequest {
  maxArticles?: number;
  repeats?: number;
  reviewedOnly?: boolean;
}

/** Engine enum names the gold-label editor offers (domain `NewsIntelEnums.cs`). */
export const NEWS_CATEGORIES = [
  'Other',
  'MonetaryPolicy',
  'Inflation',
  'Employment',
  'Growth',
  'FiscalPolicy',
  'TradePolicy',
  'Geopolitical',
  'Politics',
  'CentralBankSpeak',
  'Intervention',
  'CreditStress',
  'Commodity',
  'RiskSentiment',
  'NaturalDisaster',
  'Earnings',
  'Guidance',
  'MergersAcquisitions',
  'RegulationLegal',
  'SupplyDisruption',
  'Inventories',
  'CryptoSecurity',
  'EtfFlows',
  'Stablecoin',
  'IndexRebalance',
] as const;
export const NEWS_DIRECTIONS = ['Neutral', 'Bullish', 'Bearish'] as const;
export const NEWS_CERTAINTIES = ['Rumor', 'Reported', 'Confirmed', 'Official'] as const;
export const NEWS_STANCES = ['Asserts', 'Denies', 'Updates', 'Resolves'] as const;
export const NEWS_STORY_STATES: readonly NewsStoryState[] = [
  'Developing',
  'Confirmed',
  'Denied',
  'Resolved',
];

// ── Validation (wave 2: event study, fitted severities, news as risk) ────
// Mirrors the engine entities `NewsEventStudyRun` / `NewsEventStudyResult` on branch ni/validation.
// The endpoints are optional: an engine without them answers 404 and the pages say so.

/** One event-study run. JSON columns arrive as strings. */
export interface NewsEventStudyRunView {
  id: number;
  /** Running / Completed / Failed. */
  status: string;
  /** manual | nightly. */
  trigger: string | null;
  requestedBy: string | null;
  fromUtc: string;
  toUtc: string;
  /** A PromptVersion, `legacy`, or null = every lineage reported separately. */
  lineageFilter: string | null;
  paramsFingerprint: string | null;
  labelsConsidered: number;
  observations: number;
  /** Positive / Negative / Inconclusive / InsufficientData. */
  alignmentVerdict: string | null;
  alignmentHorizonMinutes: number | null;
  alignmentMean: number | null;
  alignmentCiLow: number | null;
  alignmentCiHigh: number | null;
  coverageJson?: string | null;
  volCalibrationJson?: string | null;
  summaryJson?: string | null;
  error: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
}

/** One aggregate row (`section` = group | term-ic). Mean is signed return in ATR units, or the rank IC. */
export interface NewsEventStudyResultView {
  section: string;
  dimension: string;
  bucket: string;
  horizonMinutes: number;
  n: number;
  clusters: number;
  mean: number;
  hitRate: number | null;
  tStat: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

/** A run with its result rows. */
export interface NewsEventStudyDetail {
  run: NewsEventStudyRunView;
  results: NewsEventStudyResultView[];
}

/** Expected-volatility forecast for one symbol (engine `NewsVolatilityForecast`). */
export interface NewsVolatilityForecastView {
  /** Expected range relative to normal, ≥ 1, ≤ cap. */
  multiplier: number;
  absolutePressure: number;
  scheduledHighEvents: number;
  horizonMinutes: number;
  pressureCoefficient: number;
  eventCoefficient: number;
  /** `study:#id` or `config`. */
  source: string;
}

/** A breaking story on one of a symbol's legs (engine `BreakingStory`). */
export interface BreakingStoryView {
  articleId: number;
  headline: string;
  source: string | null;
  key: string;
  legWeight: number;
  category: string;
  certainty: string;
  severity: number;
  magnitude: number;
  firstSeenUtc: string;
  pauseUntilUtc: string;
}

export interface NewsRiskBlockView {
  volatility: NewsVolatilityForecastView;
  breakingStories: BreakingStoryView[];
  scheduledEvents: {
    key: string;
    title: string;
    scheduledAtUtc: string;
    impact: string;
    source: string;
  }[];
}

/** One recommended severity (engine `RecommendedSeverity`). */
export interface RecommendedSeverityView {
  category: string;
  current: number;
  recommended: number;
  fitted: number | null;
  n: number;
  clusters: number;
  meanSignedR: number | null;
  /** Why: fitted / shrunk / insufficient data (kept current). */
  basis: string;
}

// ── Gaps (engine ni/gaps): bulk coverage, exposures + search terms, risk observations, vendor verify ──

/** One leg on the bulk coverage read (engine `NewsCoverageLegView`). */
export interface NewsCoverageLegView {
  key: string;
  kind: string | null;
  weight: number;
  basis: string;
  covered: boolean;
  score: number | null;
  contribution: number | null;
  absolutePressure: number | null;
  /** Minutes since the newest labelled article on this key (7-day look-back); null when none or untracked. */
  newestItemAgeMinutes: number | null;
}

/** One universe symbol on `GET news-intel/coverage` (engine `NewsCoverageSymbolView`). */
export interface NewsCoverageSymbolView {
  symbol: string;
  /** FX | Metal | Energy | Index | Stock | Crypto | Unplaced. */
  assetClass: string;
  source: string;
  legs: NewsCoverageLegView[];
  coverage: number;
  symbolBias: number | null;
  newestItemAgeMinutes: number | null;
  includedInPrompt: boolean;
  omissionReason: string | null;
  calendarKeys: string[];
  /** Economic-calendar keys the blackout has always refused on, whatever the mode. */
  legacyEnforced: string[];
  /** Economic-calendar keys the exposure map added: refuse only under NewsBlackout:MultiAsset:Mode=Enforce. */
  modeGoverned: string[];
  /** Keys whose scheduled market events refuse entries — only under Enforce. */
  scheduledEventKeys: string[];
  /** What refuses entries under the mode in force. */
  blockingKeys: string[];
  riskObservations7d: number;
  problem: string | null;
}

/** `GET news-intel/coverage` (engine `NewsCoverageView`). */
export interface NewsCoverageView {
  asOfUtc: string;
  computedAtUtc: string;
  cached: boolean;
  moduleEnabled: boolean;
  multiAssetMode: string;
  tracked: string[];
  pressureKeysComputed: number;
  symbols: NewsCoverageSymbolView[];
  untrackedKeysNeeded: string[];
}

/** One key's search term (engine `NewsSearchTermView`). */
export interface NewsSearchTermView {
  key: string;
  kind: string | null;
  tracked: boolean;
  recommended: boolean;
  term: string | null;
  /** config | shipped-default | built-in | none. */
  source: string;
  polled: boolean;
}

/** `GET news-intel/exposures`. */
export interface NewsExposureListView {
  tracked: string[];
  recommended: string[];
  searchEnabled: boolean;
  searchTerms: NewsSearchTermView[];
}

export type NewsRiskObservationKind =
  | 'MultiAssetBlackout'
  | 'ScheduledEventBlackout'
  | 'BreakingGate'
  | 'StopWidening';

export const NEWS_RISK_OBSERVATION_KINDS: readonly NewsRiskObservationKind[] = [
  'MultiAssetBlackout',
  'ScheduledEventBlackout',
  'BreakingGate',
  'StopWidening',
];

export interface NewsRiskObservationCountView {
  kind: string;
  symbol: string;
  mode: string;
  count: number;
  lastObservedAtUtc: string;
}

export interface NewsRiskObservationView {
  id: number;
  kind: string;
  mode: string;
  symbol: string;
  key: string | null;
  eventRef: string | null;
  storyId: number | null;
  observedAtUtc: string;
  eventAtUtc: string | null;
  detail: string | null;
}

/** `GET news-intel/risk-observations`. */
export interface NewsRiskObservationPage {
  fromUtc: string;
  toUtc: string;
  total: number;
  countsByKind: Record<string, number>;
  counts: NewsRiskObservationCountView[];
  items: NewsRiskObservationView[];
}

/** `POST news-intel/vendors/{name}/verify` (engine `NewsVendorVerifyResult`) — never carries the key. */
export interface NewsVendorVerifyResult {
  vendor: string;
  keySet: boolean;
  /** First 8 hex chars of SHA-256(key). */
  keyFingerprint: string | null;
  keyLength: number | null;
  ok: boolean;
  /** ok | no-key | unknown-vendor | http-error | unparseable | failed | cooldown. */
  status: string;
  httpStatus: number | null;
  itemsParsed: number | null;
  error: string | null;
  enabled: boolean;
  checkedAtUtc: string;
  elapsedMs: number | null;
}
