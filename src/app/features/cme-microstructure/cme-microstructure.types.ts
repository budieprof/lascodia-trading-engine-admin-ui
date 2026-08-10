/**
 * CME microstructure operator surface (engine ADR-0021 / ADR-0022).
 *
 * The engine captures real CME futures tape + depth (the only place FX has a genuine centralized
 * book and aggressor-tagged trades), bridges it to the spot symbol we trade, and gates everything on
 * one decisive experiment: does REAL aggressor delta beat the tick-rule proxy out-of-sample?
 * Keep these shapes in sync with `Microstructure/Queries/GetCmeStatus` + the experiment command.
 */

/** One seeded quarterly contract in a root's chain (e.g. 6EU5 under root 6E → spot EURUSD). */
export interface CmeContractDto {
  contractCode: string;
  rootSymbol: string;
  spotSymbol: string;
  expiryDate: string;
  rollDate: string | null;
  /** Back-adjustment offset that makes a multi-quarter series continuous across rolls. */
  priceAdjustment: number;
  isFrontMonth: boolean;
  lastTradeEventTimestamp: string | null;
}

/** A would-have signal the shadow monitor recorded. No order was placed. */
export interface CmeShadowSignalDto {
  id: number;
  symbol: string;
  direction: string;
  confidence: number;
  cumulativeDelta: number;
  bookImbalanceTop5: number;
  basis: number | null;
  evaluatedAt: string;
}

/** Subsystem status: what's seeded, what's ingested, what shadow has been saying. */
export interface CmeStatusDto {
  contractCount: number;
  frontMonthContract: string | null;
  tradeCount: number;
  bookSnapshotCount: number;
  barCount: number;
  latestBarUtc: string | null;
  shadowSignalCount: number;
  contracts: CmeContractDto[];
  recentShadowSignals: CmeShadowSignalDto[];
  feedHealth: CmeFeedHealthDto;
  v11Models: CmeV11ModelDto[];
}

/**
 * Whether the CME feed is usable right now, as opposed to merely configured.
 *
 * `NoData` is the expected state before the historical slice is purchased — it is not an error.
 * `Stale` means data exists but the newest bar is past the staleness gate, so the strategy path
 * refuses it. Only `Live` is tradeable.
 */
export interface CmeFeedHealthDto {
  status: 'NoData' | 'Stale' | 'Live';
  latestBarAgeSeconds: number | null;
  /** The gate the age is judged against, so the operator can see WHY something reads stale. */
  maxFlowStalenessSeconds: number;
  tradesLast24h: number;
  booksLast24h: number;
  barsLast24h: number;
  ingestEnabled: boolean;
  shadowMonitorEnabled: boolean;
}

/** An active ML model carrying the V11 CME real-flow feature block. */
export interface CmeV11ModelDto {
  modelId: number;
  symbol: string;
  timeframe: string;
  modelVersion: string;
  isActive: boolean;
  /**
   * True when the model was TRAINED against observed CME flow, so serving it without flow is a
   * source mismatch and the scorer suppresses it. A V11 model trained with no flow coverage reads
   * false and scores normally — the distinction the parity gate turns on.
   */
  requiresRealFlow: boolean;
  trainedAt: string | null;
}

/** Aggregated out-of-sample performance of one delta source across the experiment's folds. */
export interface ExperimentArmDto {
  name: string;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  tradeCount: number;
  wins: number;
  losses: number;
  profitFactor: number;
  winRate: number;
}

/**
 * The decisive experiment's verdict. A positive, fold-consistent `oosNetPnlDelta` is the evidence
 * that real CME flow carries edge the proxy can't — the go/no-go for the whole data spend.
 */
export interface CmeOrderflowExperimentResultDto {
  ran: boolean;
  reason: string;
  eventsLoaded: number;
  foldsScored: number;
  real: ExperimentArmDto;
  proxy: ExperimentArmDto;
  oosNetPnlDelta: number;
  oosProfitFactorDelta: number;
  fractionFoldsRealBeatsProxy: number;
}

/** Request bodies (engine binds camelCase → PascalCase). */
export interface SeedCmeContractsRequest {
  rootSymbol: string;
  spotSymbol: string;
  fromUtc: string;
  toUtc: string;
}

export interface RunCmeOrderflowExperimentRequest {
  contract: string;
  fromUtc: string;
  toUtc: string;
  oosFolds: number;
}

/**
 * Synthetic-data regimes. `NoEdge` is the null control — the experiment must find nothing;
 * `DeltaLeadsPrice` plants a lead-lag it must detect. Synthetic data validates the PIPELINE and the
 * HARNESS; it can never prove a real edge exists.
 */
export type SyntheticFlowRegime = 'NoEdge' | 'DeltaLeadsPrice';

export interface GenerateSyntheticCmeRequest {
  contract: string;
  rootSymbol: string;
  minutes: number;
  regime: SyntheticFlowRegime;
  seed: number;
  purgeExistingSynthetic: boolean;
}

export interface SyntheticCmeGenerationResultDto {
  tradesWritten: number;
  booksWritten: number;
  barsBuilt: number;
  purgedTrades: number;
  purgedBooks: number;
  regime: string;
}
