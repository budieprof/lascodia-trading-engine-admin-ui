// ============================================================
// Research workbench — wire types (engine scripting API §8a–§8f)
// ============================================================
//
// The optimizer's search space and spec (§8a), walk-forward runs and their analysis (§8b), Monte Carlo
// in R (§8c), the multiple-testing ledger and PBO (§8d), parameter-stability heatmaps (§8e) and an
// optimization run's candidates with the overfitting evidence (§8f). JSON is camelCase; times are ISO
// strings. Kept in the research folder so the workbench can evolve them without touching shared files.

// ── §8a Search space and spec ─────────────────────────────────────────────

export type OptimizationObjective =
  | 'HealthScore'
  | 'ExpectancyR'
  | 'SharpeRatio'
  | 'SortinoRatio'
  | 'ProfitFactor';

/** A number range (`step` optional; 0 = continuous float) or a subset of a choice input's options. */
export interface SearchRange {
  min?: number | null;
  max?: number | null;
  step?: number | null;
  choices?: unknown[] | null;
}

/** Limits a candidate must meet over its folds. Units: maxDrawdownPct is a percent, minWinRate a fraction. */
export interface SearchConstraints {
  minTrades?: number | null;
  maxDrawdownPct?: number | null;
  minWinRate?: number | null;
  minProfitFactor?: number | null;
  minExpectancyR?: number | null;
}

export interface SearchSpec {
  ranges: Record<string, SearchRange>;
  locked: Record<string, unknown>;
  objective: OptimizationObjective;
  constraints?: SearchConstraints | null;
}

export type SearchDimensionKind = 'integer' | 'float' | 'choice';
export type RangeSource = 'spec' | 'declared' | 'derived' | 'options' | 'enum' | 'bool';

export interface SearchedInputDto {
  id: string;
  title: string;
  group: string | null;
  tooltip: string | null;
  inputKind: string;
  kind: SearchDimensionKind;
  min: number | null;
  max: number | null;
  step: number | null;
  choices: unknown[] | null;
  options: unknown[] | null;
  current: unknown;
  default: unknown;
  rangeSource: RangeSource | string;
  declaredMin: number | null;
  declaredMax: number | null;
  declaredStep: number | null;
}

export interface SkippedInputDto {
  id: string;
  title: string;
  inputKind: string;
  reason: string;
  locked: boolean;
  lockedValue: unknown;
  current: unknown;
}

export interface ParameterSpaceDto {
  strategyId: number;
  spaceId: number;
  searched: SearchedInputDto[];
  skipped: SkippedInputDto[];
  initialCandidates: number;
  maxInitialCandidates: number;
  objectives: string[];
  constraints: string[];
  searchSpec: SearchSpec | null;
  problems: string[];
}

/** The optimizer run fields the shared `OptimizationRunDto` type does not carry (yet). */
export interface OptimizationRunExtraFields {
  searchSpecJson?: string | null;
  queuedAt?: string | null;
  executionStartedAt?: string | null;
  executionStage?: string | null;
  executionStageMessage?: string | null;
  failureCategory?: string | null;
  deferralReason?: string | null;
  deferredUntilUtc?: string | null;
  bestSharpeRatio?: number | null;
  bestMaxDrawdownPct?: number | null;
  bestWinRate?: number | null;
}

// ── §8f Candidates and overfitting evidence ──────────────────────────────

export interface OptimizationFoldStat {
  trades: number;
  rTrades: number;
  meanR: number | null;
  sharpeR: number | null;
}

export interface OptimizationCandidateDto {
  rank: number;
  parametersJson: string | null;
  parameters: Record<string, unknown> | null;
  healthScore: number | null;
  expectancyR: number | null;
  sharpeR: number | null;
  trades: number | null;
  rTrades: number | null;
  isWinner: boolean;
  folds: (OptimizationFoldStat | null)[];
}

export interface OptimizationSelectionDto {
  selectedParametersJson: string | null;
  selectedIsWinner: boolean;
  selectedSharpeR: number | null;
  selectedRTrades: number | null;
  runTrials: number;
  ledgerTrials: number;
  peerStrategies: number;
  effectiveTrials: number;
  deflatedSharpeRun: number | null;
  deflatedSharpeEffective: number | null;
  minDsr: number;
  pbo: number | null;
  pboBlocks: number | null;
  pboCombinations: number | null;
  pboMedianLogit: number | null;
  pboWhyNot: string | null;
  maxPbo: number;
  degradationSlope: number | null;
  warnings: string[];
}

export interface CscvSplit {
  inSampleSharpe: number;
  outOfSampleSharpe: number | null;
  logit: number;
}

export interface OptimizationCandidatesDto {
  optimizationRunId: number;
  strategyId: number;
  status: string;
  completedAt: string | null;
  objective: string;
  candidates: number;
  candidatesWithR: number;
  sortBy: string;
  rows: OptimizationCandidateDto[];
  selection: OptimizationSelectionDto;
  cscvSplits: CscvSplit[];
  validation: {
    passed: boolean | null;
    hasOosValidation: boolean | null;
    inSampleHealthScore: number | null;
    outOfSampleHealthScore: number | null;
    failureReason: string | null;
  } | null;
  whyNot: string | null;
}

// ── §8d Trial ledger ──────────────────────────────────────────────────────

export interface TrialLedgerRunDto {
  optimizationRunId: number;
  status: string;
  completedAt: string | null;
  candidates: number;
  candidatesWithFolds: number;
  pbo: number | null;
  blocks: number | null;
  combinations: number | null;
  medianLogit: number | null;
  whyNot: string | null;
}

export interface TrialLedgerDto {
  strategyId: number;
  lineageRootStrategyId: number;
  rowsByKind: Record<string, number>;
  distinctConfigurations: number;
  foldSearchCandidates: number;
  ledgerTrials: number;
  peerStrategies: number;
  effectiveTrials: number;
  optimizationRuns: TrialLedgerRunDto[];
}

// ── §8e Heatmap ───────────────────────────────────────────────────────────

export interface HeatmapAxis {
  id: string;
  numeric: boolean;
  distinct: number;
  min: number | null;
  max: number | null;
}

export interface HeatmapAxisBins {
  id: string;
  numeric: boolean;
  labels: string[];
  edges: number[] | null;
}

export interface HeatmapCell {
  meanExpectancyR: number;
  count: number;
  bestExpectancyR: number;
}

export interface HeatmapDto {
  x: HeatmapAxisBins;
  y: HeatmapAxisBins;
  /** Rows by y bin, columns by x bin; null where no candidate fell. */
  cells: (HeatmapCell | null)[][];
  peakX: number;
  peakY: number;
  peakMeanExpectancyR: number;
  plateauScore: number | null;
  neighbourhoodPositiveShare: number | null;
  candidates: number;
}

export interface PlateauDto {
  score: number;
  peakExpectancyR: number;
  neighboursMeanExpectancyR: number;
  neighbours: number;
  positiveShare: number;
}

export interface OptimizationHeatmapDto {
  optimizationRunId: number;
  strategyId: number;
  candidates: number;
  parameters: HeatmapAxis[];
  heatmap: HeatmapDto | null;
  plateau: PlateauDto | null;
  peakParametersJson: string | null;
  whyNot: string | null;
}

// ── §8b Walk-forward ──────────────────────────────────────────────────────

export type WalkForwardWindowMode = 'Anchored' | 'Rolling';

/** Walk-forward run fields the shared `WalkForwardRunDto` type does not carry (yet). */
export interface WalkForwardRunExtraFields {
  reOptimizePerFold?: boolean;
  windowMode?: WalkForwardWindowMode | string;
  terminalHoldoutFromUtc?: string | null;
  holdoutScoredAt?: string | null;
  holdoutResultJson?: string | null;
  failureCode?: string | null;
  queuedAt?: string | null;
}

export interface WalkForwardLaunchRequest {
  strategyId: number;
  symbol: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  initialBalance: number;
  reOptimizePerFold: boolean;
  windowMode: WalkForwardWindowMode;
}

export interface WalkForwardFoldDto {
  windowIndex: number;
  inSampleFrom: string;
  inSampleTo: string;
  outOfSampleFrom: string;
  outOfSampleTo: string;
  reOptimized: boolean;
  parameters: Record<string, unknown> | null;
  oosSharpe: number;
  oosTrades: number;
  oosWinRate: number;
  oosProfitFactor: number;
  oosNetProfit: number;
  oosExpectancyR: number | null;
  oosMaxDrawdownPct: number | null;
  isSharpe: number | null;
  isNetProfit: number | null;
  isTrades: number | null;
  isHealthScore: number | null;
  efficiency: number | null;
}

export interface WalkForwardEquityPoint {
  time: string;
  equity: number;
  drawdownPct: number;
  fold: number;
  cumulativeR: number | null;
}

export interface WalkForwardStitchedTrade {
  fold: number;
  direction: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  pnL: number;
  r: number | null;
  exitReason: string;
  equity: number;
}

export interface WalkForwardStitched {
  startingEquity: number;
  endingEquity: number;
  netProfit: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number | null;
  totalR: number | null;
  rTrades: number;
  outOfSampleDays: number;
  annualisedReturnPct: number | null;
  equity: WalkForwardEquityPoint[];
  trades: WalkForwardStitchedTrade[];
}

export interface WalkForwardEfficiency {
  walkForwardEfficiency: number | null;
  sharpeEfficiency: number | null;
  foldsCompared: number;
  note: string | null;
}

export interface WalkForwardParameterDrift {
  id: string;
  numeric: boolean;
  values: unknown[];
  min: number | null;
  max: number | null;
  median: number | null;
  relativeSpread: number | null;
  meanRelativeStep: number | null;
  changes: number;
  distinct: number;
}

export interface WalkForwardAnalysisDto {
  runId: number;
  strategyId: number;
  symbol: string;
  timeframe: string;
  windowMode: string;
  reOptimizePerFold: boolean;
  fromDate: string;
  toDate: string;
  terminalHoldoutFromUtc: string | null;
  averageOutOfSampleSharpe: number | null;
  sharpeStdDev: number | null;
  folds: WalkForwardFoldDto[];
  stitched: WalkForwardStitched;
  efficiency: WalkForwardEfficiency;
  parameterDrift: WalkForwardParameterDrift[];
  notes: string[];
}

/** The terminal holdout's single score (`holdoutResultJson`, PascalCase in the engine's JSON). */
export interface WalkForwardHoldoutScore {
  walkForwardRunId: number | null;
  fromUtc: string | null;
  toUtc: string | null;
  scoredAtUtc: string | null;
  bars: number | null;
  totalTrades: number | null;
  netProfit: number | null;
  sharpeRatio: number | null;
  expectancyR: number | null;
  maxDrawdownPct: number | null;
  winRate: number | null;
  profitFactor: number | null;
  healthScore: number | null;
  foldsAverageSharpe: number | null;
  unscorable: boolean;
}

// ── §8c Monte Carlo in R ──────────────────────────────────────────────────

export interface MonteCarloPercentiles {
  p5: number;
  p50: number;
  p95: number;
}

export interface MonteCarloResult {
  trades: number;
  iterations: number;
  blockSize: number;
  riskPerTradePct: number;
  ruinDrawdownPct: number;
  meanR: number;
  totalR: number;
  years: number | null;
  maxDrawdownPct: MonteCarloPercentiles;
  totalReturnPct: MonteCarloPercentiles;
  cagrPct: MonteCarloPercentiles | null;
  timeToRecoverTrades: MonteCarloPercentiles;
  timeToRecoverDays: MonteCarloPercentiles | null;
  riskOfRuin: number;
  probabilityOfLoss: number;
  unrecoveredShare: number;
}

export interface MonteCarloDto {
  source: string;
  backtestRunId: number | null;
  walkForwardRunId: number | null;
  strategyId: number;
  tradesInSource: number;
  tradesWithR: number;
  firstTradeUtc: string | null;
  lastTradeUtc: string | null;
  tradesPerYear: number | null;
  daysPerTrade: number | null;
  result: MonteCarloResult;
  notes: string[];
}

export interface MonteCarloParams {
  iterations: number;
  riskPerTradePct: number;
  ruinDrawdownPct: number;
}
