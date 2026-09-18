/**
 * Patient Trader — contract types for the cockpit.
 *
 * The module is a generation-only discretionary agent: it keeps a standing view of each market it
 * follows, waits for a quiet market to break into a large move, and writes a complete plan when
 * one does. It never manages a position, and it decides its own entry, stop and target.
 */

/** One market the agent follows. */
export interface PatientTraderMarket {
  symbol: string;
  timeframe: string;
  enabled: boolean;
}

/**
 * How far the module may go. Each step is the gate on the next, and the module is advanced by
 * changing this value rather than by a deploy.
 */
export type PatientTraderMode = 'ForecastOnly' | 'PlanOnly' | 'Live';

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
}

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
  createdAtUtc: string;
  ageMinutes: number;
}

/** One entry in the scenario map — a pre-committed reaction, not a forecast. */
export interface PatientTraderScenario {
  trigger?: string;
  expectedReaction?: string;
  myAction?: string;
  invalidation?: string;
}

/** A plan, including the ones that were refused or declined. */
export interface PatientTraderPlan {
  id: number;
  symbol: string;
  direction: string;
  /** Proposed | Armed | Filled | Settled | Rejected | Declined | Expired. */
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
}

/** Resolved outcome of a plan, from the position-free forward walk. */
export interface PatientTraderOutcome {
  outcome?: string;
  rMultiple?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
  barsToExit?: number;
  livedHours?: number;
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
}

export interface PatientTraderBoard {
  counters: PatientTraderCounters;
  views: PatientTraderView[];
  plans: PatientTraderPlan[];
}

/** Plan statuses that mean the agent chose not to trade, rather than failed to. */
export const DECLINED_STATUSES = ['Declined', 'Rejected'] as const;

/** Parses an outcome blob, tolerating absence and malformed JSON. */
export function parseOutcome(json: string | null): PatientTraderOutcome | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as PatientTraderOutcome;
  } catch {
    return null;
  }
}

/** Parses a scenario map, returning an empty list rather than throwing. */
export function parseScenarios(json: string | null): PatientTraderScenario[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PatientTraderScenario[]) : [];
  } catch {
    return [];
  }
}
