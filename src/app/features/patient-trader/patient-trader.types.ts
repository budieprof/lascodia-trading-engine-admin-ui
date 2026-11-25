import { OcoChipPartner } from '@shared/utils/oco';

/**
 * Patient Trader — contract types for the cockpit.
 *
 * The module is a generation-only discretionary agent: it keeps a standing view of each market it
 * follows, waits for a quiet market to break into a large move, and writes a complete plan when
 * one does. It never manages a position, and it decides its own entry, stop and target.
 */

/**
 * How far the module may go. Each step is the gate on the next, and the module is advanced by
 * changing this value rather than by a deploy.
 */
export type PatientTraderMode = 'ForecastOnly' | 'PlanOnly' | 'Live';

/** One market the agent follows. */
export interface PatientTraderMarket {
  symbol: string;
  timeframe: string;
  enabled: boolean;
  /**
   * The market's own mode. Null = follow the module. A market can never go further than the
   * module's mode: PlanOnly here under a ForecastOnly module still runs ForecastOnly.
   */
  mode?: PatientTraderMode | null;
}

export interface PatientTraderConfig {
  enabled: boolean;
  mode: PatientTraderMode;
  markets: PatientTraderMarket[];

  viewIntervalMinutes: number;
  viewHorizonHours: number;
  planExpiryHours: number;
  maxOpenPlansPerSymbol: number;
  maxPlansPerDay: number;
  catalystBlackoutMinutesBefore: number;
  catalystArmMinutesAfter: number;

  /** Stops closer than this are rejected as unsurvivable. The module's most important number. */
  minStopAtrMultiple: number;
  maxStopAtrMultiple: number;
  minRewardRisk: number;
  maxTargetAtrMultiple: number;
  minConfidence: number;

  dailySpendCapUsd: number;
  /** The most one market may spend in a day. 0 restores the shared pot. */
  perMarketDailySpendCapUsd: number;
  memoryEnabled: boolean;
  maxNotesInPrompt: number;

  /** Spreads of round-trip cost charged before a payoff is judged. 2 = in and out. */
  spreadCostMultiple: number;
  /** Bars of history the target-reach and stop-noise checks are measured over. */
  evidenceLookbackBars: number;
  reachPercentile: number;
  noisePercentile: number;
  /** How far beyond measured noise the stop must sit. */
  stopNoiseMultiple: number;
  /** Require the stop to sit beyond a real swing rather than float in mid-range. */
  requireStopStructure: boolean;
  /** Stand down entirely while the fleet kill switch is thrown. */
  respectKillSwitch: boolean;
  /** Armed plans allowed to share a currency leg in the same direction. 0 disables. */
  maxCorrelatedPlans: number;

  /** Extra reward:risk a plan must clear to call itself High conviction. */
  highConvictionRewardRiskBonus: number;
  /** Confidence floor for a High conviction claim. */
  highConvictionMinConfidence: number;

  /** View prompt arm: 'a' (control), 'b' (argue the other side first), or 'split'. */
  promptVariant: string;

  /**
   * 'Assistant': a full admin-assistant analysis that writes one card per viable idea, each armed
   * as a watch that files that exact card when its condition is met. 'Classic': JSON view + one plan.
   */
  analysisEngine: PatientTraderEngine;
  /** Most cards one market may have armed at once (1-6). */
  maxCardsPerAnalysis: number;
  /** How many times one analysis may resume after pausing at the assistant's per-request budget. */
  analysisMaxResumes: number;
  /** Default life of a card's watch when the analyst does not say (1-72h). */
  cardWatchExpiryHours: number;
  /** Admin user the headless analysis runs as; 0 = the oldest active admin. */
  analystAdminUserId: number;
  /**
   * The instruction each assistant analysis is given. Blank = the engine's built-in sentence.
   * `{symbol}` and `{timeframe}` are filled in per market. The mode line, the cards already
   * watching and the gate limits are always added after it by the engine.
   */
  analysisInstruction: string;
  /** The engine's built-in instruction (read-only; shown and used by "Reset to default"). */
  defaultAnalysisInstruction?: string;

  /**
   * Count notional (subscription) spend against the caps as well as paid spend. Off = the caps
   * only stop paid API spend; subscription analyses are never capped.
   */
  spendCapCountsNotional: boolean;
  /** A card whose watch fires inside a high-impact release window is held back, not filed. */
  blackoutAppliesAtFire: boolean;
  /**
   * Fingerprint of the persisted configuration, filled by the read. Sent back on save so a save
   * edited from an older read is refused instead of overwriting someone else's change.
   */
  version?: string | null;
}

export type PatientTraderEngine = 'Assistant' | 'Classic';

/**
 * Defaults mirroring the engine's own. Used to backfill a partial read so a newly added field
 * never renders a form control blank.
 */
export const DEFAULT_PATIENT_TRADER_CONFIG: PatientTraderConfig = {
  enabled: false,
  mode: 'ForecastOnly',
  markets: [],
  viewIntervalMinutes: 240,
  viewHorizonHours: 24,
  planExpiryHours: 12,
  maxOpenPlansPerSymbol: 1,
  maxPlansPerDay: 6,
  catalystBlackoutMinutesBefore: 30,
  catalystArmMinutesAfter: 90,
  minStopAtrMultiple: 1.0,
  maxStopAtrMultiple: 4.0,
  minRewardRisk: 2.0,
  maxTargetAtrMultiple: 12.0,
  minConfidence: 0.55,
  dailySpendCapUsd: 5.0,
  perMarketDailySpendCapUsd: 1.5,
  memoryEnabled: true,
  maxNotesInPrompt: 6,
  spreadCostMultiple: 2.0,
  evidenceLookbackBars: 1500,
  reachPercentile: 0.9,
  noisePercentile: 0.7,
  stopNoiseMultiple: 1.0,
  requireStopStructure: true,
  respectKillSwitch: true,
  maxCorrelatedPlans: 2,
  highConvictionRewardRiskBonus: 0.5,
  highConvictionMinConfidence: 0.7,
  promptVariant: 'a',
  analysisEngine: 'Assistant',
  maxCardsPerAnalysis: 6,
  analysisMaxResumes: 8,
  cardWatchExpiryHours: 24,
  analystAdminUserId: 0,
  analysisInstruction: '',
  spendCapCountsNotional: false,
  blackoutAppliesAtFire: true,
};

/** One market's current standing view. */
export interface PatientTraderView {
  id: number;
  symbol: string;
  timeframe: string;
  regime: string;
  /** Buy | Sell | None. "None" is a first-class answer, not a failure. */
  lean: string;
  confidence: number;
  narrative: string;
  scenariosJson: string | null;
  whatWouldChangeMyMind: string | null;
  llmInvocationId: number | null;
  /**
   * The market's standing journal conversation.
   *
   * Not the same as `llmInvocationId`: that is the individual billed call, which is the billing
   * record and is no longer browsable on /conversations. This is the thread the reasoning lives
   * in, with a follow-up box under it.
   */
  journalLlmInvocationId: number | null;
  /** The assistant conversation behind the view (Assistant engine only) — the full analysis. */
  analysisLlmInvocationId: number | null;
  /** Which engine wrote the view. */
  engine: PatientTraderEngine;
  createdAtUtc: string;
  ageMinutes: number;
}

/**
 * One entry in the scenario map as the engine stores it. Two shapes exist:
 *  - Classic: a pre-committed reaction `{ trigger, expectedReaction, myAction, invalidation }`.
 *  - Assistant: a wake level `{ trigger (the reason), direction, watch: { op, value }, probability }`.
 * Normalise with `normaliseScenario` (patient-trader.logic.ts) before rendering.
 */
export interface PatientTraderScenario {
  trigger?: string;
  expectedReaction?: string;
  myAction?: string;
  invalidation?: string;
  direction?: string;
  watch?: { op?: string; value?: number | null } | null;
  probability?: number | null;
}

/** A plan, including the ones that were refused or declined. */
export interface PatientTraderPlan {
  id: number;
  symbol: string;
  direction: string;
  /** Proposed | Armed | Filled | Settled | Rejected | Declined | Expired | Invalidated | Withdrawn. */
  status: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  rewardRisk: number;
  stopAtrMultiple: number;
  rejectionCode: string | null;
  rejectionReason: string | null;
  thesis: string;
  entryBasis: string;
  stopBasis: string;
  targetBasis: string;
  observeOnly: boolean;
  llmInvocationId: number | null;
  tradeSignalId: number | null;
  outcomeJson: string | null;
  createdAtUtc: string;
  /** True when this plan's stop sat within a whisker of the survivability floor. */
  nearFloor: boolean;
  /** The market's standing journal conversation — see the view type for why this is not llmInvocationId. */
  journalLlmInvocationId: number | null;
  /** 'Standard' or 'High' — how strongly the agent backed this one. */
  conviction: string;
  /** The way the agent said this plan would most likely die, written before it was armed. */
  preMortem: string | null;
  /** What the agent said would kill the idea before entry. */
  invalidationNote: string | null;
  /** The price at which the plan is abandoned before entry, if one was armed. */
  invalidationPrice: number | null;
  /** The recommendation card this plan is (Assistant engine). */
  recommendationId: number | null;
  /** The watch armed on the plan. */
  entryMonitorId: number | null;
  /** One-cancels-other group: plans sharing it are alternatives — at most one files. */
  ocoGroupId: string | null;
  /** When the plan's watch gives up. */
  expiresAtUtc: string;
  /** The other plans of this plan's OCO group (whole table, not just this page). */
  ocoPartners?: PatientTraderOcoPartner[];
  timeframe?: string;
  /** 'Limit' | 'Stop' | 'Market'. */
  entryStyle?: string;
  confidence?: number;
  armedAtUtc?: string | null;
  filledAtUtc?: string | null;
  settledAtUtc?: string | null;
  /** Refused before it was ever armed (as opposed to refused when its watch fired). */
  refusedBeforeArming?: boolean;
}

/** Another plan in the same one-cancels-other group. */
export interface PatientTraderOcoPartner {
  id: number;
  direction: string;
  status: string;
  recommendationId: number | null;
  entryMonitorId: number | null;
}

/** Plan statuses after which a leg can no longer file. */
const ENDED_PLAN_STATUSES = new Set([
  'Declined',
  'Rejected',
  'Expired',
  'Invalidated',
  'Withdrawn',
]);

/**
 * A plan's partners as the OCO chip lists them: by card number when the partner is a card (that
 * is the number the Recommendations and Monitors pages show), by plan number otherwise.
 */
export function planOcoChipPartners(plan: PatientTraderPlan): OcoChipPartner[] {
  return (plan.ocoPartners ?? []).map((p) => ({
    id: p.recommendationId ?? p.id,
    label: [p.direction !== 'None' ? p.direction : null, p.status, `plan ${p.id}`]
      .filter(Boolean)
      .join(' · '),
    ended: ENDED_PLAN_STATUSES.has(p.status),
  }));
}

/** The same trade held to its written stop and target, ignoring any later stop move. */
export interface PatientTraderAsWritten {
  outcome?: string | null;
  rMultiple?: number | null;
  mfeR?: number | null;
}

/** Resolved outcome of a plan, as stored in `outcomeJson`. */
export interface PatientTraderOutcome {
  outcome?: string;
  rMultiple?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
  barsToExit?: number;
  livedHours?: number;
  /** 'trade' = a real position settled it; 'replay' = walked over the candles afterwards. */
  source?: string | null;
  asWritten?: PatientTraderAsWritten | null;
  /** A refused card replayed to see what it would have done. */
  forgone?: boolean | null;
  /** Where a replay started: 'fire' | 'resting-from-creation' | 'plan'. */
  from?: string | null;
  note?: string | null;
}

export interface PatientTraderCounters {
  activeMarkets: number;
  armedPlans: number;
  plansLast7Days: number;
  declinedLast7Days: number;
  rejectedLast7Days: number;
  settledLast7Days: number;

  /** Plans whose entry was never reached — the failure that looks like success. */
  entryNotReachedCount: number;
  fillRate: number | null;
  /** Accepted plans whose stop hugged the floor — the writing-to-the-checker warning. */
  nearFloorCount: number;
  meanRMultiple: number | null;

  viewsScored: number;
  /** Whether the agent reads the market, answered before any money is involved. */
  viewAccuracy: number | null;
  viewsAbstained: number;

  /** Real trades behind `meanRMultiple` (paper walks are not counted). */
  tradesSettled: number;
  /** Plans abandoned before entry because the invalidation price was reached. */
  invalidatedCount: number;
  /** Cards refused at the moment their watch fired. */
  refusedAtFire: number;
  /** Refusals in the window, by reason code. */
  rejectedByCode: Record<string, number>;
  /** Refused cards replayed over the candles afterwards. */
  refusalsScored: number;
  /** Of those, how many would have reached their target. */
  forgoneWinners: number;
}

export interface PatientTraderBoard {
  counters: PatientTraderCounters;
  views: PatientTraderView[];
  plans: PatientTraderPlan[];
  /** Plans matching the filters, for the pager. */
  totalPlans: number;
  /** Days the counters cover. */
  windowDays: number;
}

/** Filters and paging for the plans table. */
export interface PatientTraderBoardQuery {
  limit: number;
  offset?: number;
  ocoGroupId?: string | null;
  status?: readonly string[];
  direction?: string | null;
  rejectionCode?: string | null;
  symbol?: string | null;
}

/** Every plan status the engine writes, in lifecycle order (the filter's options). */
export const PLAN_STATUSES = [
  'Proposed',
  'Armed',
  'Filled',
  'Settled',
  'Rejected',
  'Declined',
  'Expired',
  'Invalidated',
  'Withdrawn',
] as const;

// ── /health ──────────────────────────────────────────────────────────────────

/** Viability-gate limits for one direction — PRICE distances (divide by pipSize for pips). */
export interface PatientTraderDirectionLimits {
  minStop: number;
  maxStop: number;
  maxTarget: number;
  noise: number;
  reach: number;
  needsStructure: boolean;
}

/** The enforced viability-gate limits a card's signal is held to when its watch fires. */
export interface PatientTraderCardLimits {
  lookbackBars: number;
  pipSize: number;
  atr: number;
  minRewardRisk: number | null;
  minConfidence: number | null;
  noisePercentile: number;
  noiseHorizonHours: number;
  reachPercentile: number;
  reachHorizonHours: number;
  buy: PatientTraderDirectionLimits;
  sell: PatientTraderDirectionLimits;
}

export interface PatientTraderSpend {
  paidToday: number;
  notionalToday: number;
  dailyCapUsd: number;
  perMarketCapUsd: number;
  capCountsNotional: boolean;
  /** What the caps are compared against today (paid, or paid + notional). */
  countedToday: number;
  dailyCapReached: boolean;
}

export interface PatientTraderMarketHealth {
  symbol: string;
  timeframe: string;
  /** The mode it actually runs in. */
  mode: string;
  /** True when the market has its own mode rather than following the module. */
  ownMode: boolean;
  lastViewAtUtc: string | null;
  lastViewTrigger: string | null;
  nextDueAtUtc: string | null;
  /** An analysis ran and wrote no view — the "stuck" signal. */
  lastRunWithoutViewAtUtc: string | null;
  lastRunWithoutViewSessionId: number | null;
  closedUntilUtc: string | null;
  closedReason: string | null;
  blackoutUntilUtc: string | null;
  blackoutTitle: string | null;
  /** Multi-line list of the releases coming up. */
  upcomingCatalysts: string | null;
  armedCards: number;
  paidToday: number;
  notionalToday: number;
  marketCapReached: boolean;
  limits: PatientTraderCardLimits | null;
}

export interface PatientTraderHealth {
  enabled: boolean;
  mode: string;
  engine: string;
  killSwitchActive: boolean;
  respectKillSwitch: boolean;
  atUtc: string;
  spend: PatientTraderSpend;
  markets: PatientTraderMarketHealth[];
}

// ── /results ─────────────────────────────────────────────────────────────────

export interface PatientTraderRStats {
  count: number;
  wins: number;
  losses: number;
  scratches: number;
  sumR: number;
  meanR: number | null;
  ci95Low: number | null;
  ci95High: number | null;
}

export interface PatientTraderBreakEvenTrade {
  planId: number;
  recommendationId: number | null;
  direction: string;
  settledAtUtc: string | null;
  realR: number | null;
  mfeR: number | null;
  asWrittenOutcome: string | null;
  asWrittenR: number | null;
}

export interface PatientTraderBreakEven {
  count: number;
  meanMfeR: number | null;
  replayed: number;
  asWrittenHitTp: number;
  asWrittenHitSl: number;
  asWrittenOther: number;
  asWrittenSumR: number;
  realSumR: number;
  trades: PatientTraderBreakEvenTrade[];
}

export interface PatientTraderRefusalCodeStats {
  code: string;
  scored: number;
  hitTp: number;
  hitSl: number;
  sumR: number;
}

export interface PatientTraderRefusalResults {
  scored: number;
  hitTp: number;
  hitSl: number;
  other: number;
  sumR: number;
  byCode: PatientTraderRefusalCodeStats[];
}

export interface PatientTraderViewResults {
  correct: number;
  wrong: number;
  flat: number;
  abstained: number;
  unscorable: number;
  accuracy: number | null;
  buyScored: number;
  buyAccuracy: number | null;
  sellScored: number;
  sellAccuracy: number | null;
  /** Views the naive "last day's move continues" baseline could also be scored on. */
  baselineScored: number;
  baselineAccuracy: number | null;
  /** The agent's accuracy on exactly those views. */
  accuracyOnBaselineViews: number | null;
}

export interface PatientTraderEquityPoint {
  atUtc: string;
  planId: number;
  direction: string;
  r: number;
  cumR: number;
}

export interface PatientTraderResults {
  days: number;
  symbol: string | null;
  trades: PatientTraderRStats;
  tradesBuy: PatientTraderRStats;
  tradesSell: PatientTraderRStats;
  asWritten: PatientTraderRStats;
  paperFills: PatientTraderRStats;
  breakEven: PatientTraderBreakEven;
  refused: PatientTraderRefusalResults;
  views: PatientTraderViewResults;
  equity: PatientTraderEquityPoint[];
}

// ── /views (history) ─────────────────────────────────────────────────────────

export interface PatientTraderViewHistoryRow {
  id: number;
  symbol: string;
  timeframe: string;
  regime: string;
  lean: string;
  confidence: number;
  trigger: string;
  narrative: string;
  midAtView: number | null;
  createdAtUtc: string;
  horizonUtc: string;
  llmInvocationId: number | null;
  verdict: string | null;
  movedPips: number | null;
  realised: string | null;
  baseline: string | null;
  baselineVerdict: string | null;
}

export interface PatientTraderViewHistory {
  total: number;
  views: PatientTraderViewHistoryRow[];
}

/** Plan statuses that mean the agent chose not to trade, rather than failed to. */
export const DECLINED_STATUSES = ['Declined', 'Rejected'] as const;
