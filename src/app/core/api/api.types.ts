// ============================================================
// Response Wrappers
// ============================================================

export interface ResponseData<T> {
  data: T | null;
  status: boolean;
  message: string | null;
  responseCode: string | null;
}

/** Engine response codes. `'00'` = success, `'-11'` = validation error, `'-14'` = not found. */
export const ResponseCode = {
  Success: '00',
  ValidationError: '-11',
  NotFound: '-14',
} as const;

export type ResponseCodeValue = (typeof ResponseCode)[keyof typeof ResponseCode];

/** Thrown by envelope-aware ApiService methods when the server returns `status: false`. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly response: ResponseData<unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isValidation(): boolean {
    return this.code === ResponseCode.ValidationError;
  }
  get isNotFound(): boolean {
    return this.code === ResponseCode.NotFound;
  }
}

export interface Pager {
  totalItemCount: number;
  filter: any;
  currentPage: number;
  itemCountPerPage: number;
  pageNo: number;
  pageSize: number;
}

export interface PagedData<T> {
  pager: Pager;
  data: T[];
}

export interface PagerRequest {
  currentPage?: number;
  itemCountPerPage?: number;
  filter?: any;
  /**
   * Server-side sort column. Should match a DTO property name (case-insensitive
   * via the server's safelist mapping). Sent on every refetch by
   * `DataTableComponent` so sorting consults the database, not just the
   * in-memory page. The handler ignores values not in its safelist.
   */
  sortBy?: string;
  /** `'asc'` or `'desc'`. Ignored when `sortBy` is absent. */
  sortDirection?: 'asc' | 'desc';
}

// ============================================================
// Query Filter Types
// ============================================================

export interface OrderQueryFilter {
  search?: string;
  status?: string;
  orderType?: string;
  strategyId?: number;
}
export interface PositionQueryFilter {
  symbol?: string;
  status?: string;
  isPaper?: boolean;
}
export interface StrategyQueryFilter {
  search?: string;
  status?: string;
  symbol?: string;
}
export interface TradeSignalQueryFilter {
  search?: string;
  status?: string;
  direction?: string;
  strategyId?: number;
  from?: string;
  to?: string;
}
export interface TradingAccountQueryFilter {
  brokerId?: number;
  isPaper?: boolean;
}
export interface BrokerQueryFilter {
  brokerType?: string;
}
export interface RiskProfileQueryFilter {
  search?: string;
}
export interface CurrencyPairQueryFilter {
  search?: string;
  isActive?: boolean;
}
export interface AlertQueryFilter {
  symbol?: string;
  alertType?: string;
  isActive?: boolean;
}
export interface CandleQueryFilter {
  symbol?: string;
  timeframe?: string;
  from?: string;
  to?: string;
}
export interface MLModelQueryFilter {
  symbol?: string;
  timeframe?: string;
  isActive?: boolean;
  status?: string;
  /**
   * Default: server treats absent / `true` as exclude meta-learners and MAML
   * `Symbol="ALL"` initializers from the result. Set to `false` explicitly to
   * include them — useful when inspecting cross-symbol initializers directly.
   */
  excludeMetaLearners?: boolean;
}
export interface MLTrainingRunQueryFilter {
  symbol?: string;
  timeframe?: string;
  status?: string;
}
export interface MLShadowEvaluationQueryFilter {
  symbol?: string;
  status?: string;
}
export interface BacktestRunQueryFilter {
  strategyId?: number;
  status?: string;
}
export interface WalkForwardRunQueryFilter {
  strategyId?: number;
  status?: string;
}
export interface StrategyAllocationQueryFilter {
  strategyId?: number;
}
export interface ExecutionQualityLogQueryFilter {
  symbol?: string;
  session?: string;
  strategyId?: number;
  from?: string;
  to?: string;
}
export interface DecisionLogQueryFilter {
  entityType?: string;
  entityId?: number;
  decisionType?: string;
  outcome?: string;
  from?: string;
  to?: string;
}
export interface COTReportQueryFilter {
  symbol?: string;
}
export interface RegimeSnapshotQueryFilter {
  symbol?: string;
  timeframe?: string;
  regime?: string;
}
export interface OptimizationRunQueryFilter {
  strategyId?: number;
  status?: string;
}
export interface EconomicEventQueryFilter {
  currency?: string;
  impact?: string;
  from?: string;
  to?: string;
}
export interface DrawdownSnapshotQueryFilter {
  fromDate?: string;
  toDate?: string;
  recoveryMode?: RecoveryMode;
  minDrawdownPct?: number;
}
export interface DriftReportQueryFilter {
  symbol?: string;
  detectorType?: string;
  severity?: string;
  fromDate?: string;
  toDate?: string;
  isActive?: boolean;
  unresolvedOnly?: boolean;
}

// ============================================================
// String Union Enums
// ============================================================

export type OrderType = 'Buy' | 'Sell';

export type ExecutionType = 'Market' | 'Limit' | 'Stop' | 'StopLimit';

export type OrderStatus =
  | 'Pending'
  | 'Submitted'
  | 'PartialFill'
  | 'Filled'
  | 'Cancelled'
  | 'Rejected'
  | 'Expired';

export type PositionStatus = 'Open' | 'Closed' | 'Closing';

export type PositionDirection = 'Long' | 'Short';

export type TradeDirection = 'Buy' | 'Sell';

export type TradeSignalStatus = 'Pending' | 'Approved' | 'Executed' | 'Rejected' | 'Expired';

export type StrategyType =
  | 'MovingAverageCrossover'
  | 'RSIReversion'
  | 'BreakoutScalper'
  | 'Custom'
  | 'BollingerBandReversion'
  | 'MACDDivergence'
  | 'SessionBreakout'
  | 'MomentumTrend'
  | 'CompositeML'
  | 'StatisticalArbitrage'
  | 'VwapReversion'
  | 'CalendarEffect'
  | 'NewsFade'
  | 'CarryTrade'
  | 'WeekendGapFade'
  | 'RoundNumberFade'
  | 'WedgeBreakout'
  | 'CrossAssetLeadLag'
  | 'OrderFlowImbalance'
  | 'SubMinuteEvent'
  | 'LlmProposal'
  | 'RuleBased';

export type StrategyStatus = 'Active' | 'Paused' | 'Backtesting' | 'Stopped';

/**
 * Wire-format projection of the engine's `PromotionGateResult`. Returned by
 * `GET /strategy/{id}/promotion-gates`. The diagnostics list is the per-gate
 * detail breakdown the engine emits during evaluation; the UI renders one row
 * per entry, parsing common shapes (`Key=Value`) where possible.
 */
export interface PromotionGatesDto {
  passed: boolean;
  failureSummary: string;
  diagnostics: string[];
}

/**
 * Promotion-ladder stage. Auto-advanced by `StrategyPromotionWorker`:
 * `BacktestQualified → Approved` after observation passes health gates,
 * `Approved → Active` after capacity gates pass. The `Draft → BacktestQualified`
 * transition is operator-driven; hunt-script-created strategies land in `Draft`.
 */
export type StrategyLifecycleStage =
  | 'Draft'
  | 'PaperTrading'
  | 'BacktestQualified'
  | 'ShadowLive'
  | 'Approved'
  | 'Active';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1';

export type MLModelStatus = 'Training' | 'Active' | 'Superseded' | 'Failed';

export type RunStatus = 'Queued' | 'Running' | 'Completed' | 'Failed';

export type TriggerType =
  | 'Scheduled'
  | 'Manual'
  | 'AutoDegrading'
  | 'AutoDeferred'
  | 'SymbolicCatalogueShift';

export type TradingSession = 'London' | 'NewYork' | 'Asian' | 'LondonNYOverlap';

export type MarketRegime =
  | 'Trending'
  | 'Ranging'
  | 'HighVolatility'
  | 'LowVolatility'
  | 'Crisis'
  | 'Breakout';

export type AlertType =
  | 'PriceLevel'
  | 'DrawdownBreached'
  | 'SignalGenerated'
  | 'OrderFilled'
  | 'PositionClosed'
  | 'MLModelDegraded'
  | 'DataQualityIssue'
  | 'SystemicMLDegradation'
  | 'LatencySla'
  | 'OptimizationLifecycleIssue'
  | 'WorkerCrash'
  | 'EADisconnected'
  | 'ConfigurationDrift'
  | 'BrokerReconciliation'
  | 'MLMonitoringStale'
  | 'SymbolicFeatureLifecycle';

export type AlertSeverity = 'Info' | 'Medium' | 'High' | 'Critical';

export type AlertChannel = 'Email' | 'Webhook' | 'Telegram';

export type TrailingStopType = 'FixedPips' | 'ATR' | 'Percentage';

export type RecoveryMode = 'Normal' | 'Reduced' | 'Halted';

export type OptimizationRunStatus =
  | 'Queued'
  | 'Running'
  | 'Completed'
  | 'Failed'
  | 'Approved'
  | 'Rejected';

export type ConfigDataType = 'String' | 'Int' | 'Decimal' | 'Bool' | 'Json';

export type ScaleType = 'ScaleIn' | 'ScaleOut';

export type ScaleOrderStatus = 'Pending' | 'Triggered' | 'Filled' | 'Cancelled';

export type ShadowEvaluationStatus =
  | 'Running'
  | 'Completed'
  | 'Promoted'
  | 'Rejected'
  | 'Processing';

export type EconomicImpact = 'Low' | 'Medium' | 'High';

export type StrategyHealthStatus = 'Healthy' | 'Degrading' | 'Critical';

export type SentimentSource = 'COT' | 'NewsSentiment' | 'AutoFeed';

export type EconomicEventSource = 'ForexFactory' | 'Investing' | 'Manual' | 'Oanda';

export type PromotionDecision = 'AutoPromoted' | 'FlaggedForReview' | 'Rejected';

// ============================================================
// DTO Interfaces
// ============================================================

export interface OrderDto {
  id: number;
  tradeSignalId: number | null;
  symbol: string | null;
  orderType: OrderType;
  executionType: ExecutionType;
  quantity: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  filledPrice: number | null;
  filledQuantity: number | null;
  status: OrderStatus;
  brokerOrderId: string | null;
  rejectionReason: string | null;
  notes: string | null;
  isPaper: boolean;
  createdAt: string;
  filledAt: string | null;
}

export interface PositionDto {
  id: number;
  symbol: string | null;
  direction: PositionDirection;
  openLots: number;
  averageEntryPrice: number;
  currentPrice: number | null;
  unrealizedPnL: number;
  realizedPnL: number;
  stopLoss: number | null;
  takeProfit: number | null;
  status: PositionStatus;
  isPaper: boolean;
  trailingStopLevel: number | null;
  brokerPositionId: string | null;
  openedAt: string;
  closedAt: string | null;
}

/**
 * One row of a position's lifecycle audit trail (PRD-V2 FR-5.8). `eventType`
 * and `source` are free-form strings on the engine entity so the UI buckets
 * them at render-time. Common eventType values: Opened, Modified,
 * PartialClose, Closed, ForceClosed, Reconciled, StaleClose. Common source
 * values: EA, PositionWorker, ReconciliationWorker, Broker, Manual.
 *
 * Position-side fields (symbol/direction/status/etc.) are joined in the
 * engine query and denormalised onto the DTO so the fleet-view feed can
 * render every row without an N+1 lookup to GET /position/{id}.
 */
export interface PositionLifecycleEventDto {
  id: number;
  positionId: number;
  eventType: string;
  source: string;
  previousLots: number | null;
  newLots: number | null;
  swapAccumulated: number | null;
  commissionAccumulated: number | null;
  description: string | null;
  occurredAt: string;
  // Joined from the parent Position. May be null/default when the parent
  // is soft-deleted; the UI falls back to the bare positionId in that case.
  symbol: string | null;
  direction: PositionDirection;
  positionStatus: PositionStatus;
  openLots: number;
  unrealizedPnL: number;
  realizedPnL: number;
  brokerPositionId: string | null;
}

export interface StrategyDto {
  id: number;
  name: string | null;
  description: string | null;
  strategyType: StrategyType;
  symbol: string | null;
  timeframe: Timeframe;
  parametersJson: string | null;
  status: StrategyStatus;
  pauseReason: string | null;
  riskProfileId: number | null;
  /** Promotion-ladder stage. See `StrategyLifecycleStage` for the auto-advance rules. */
  lifecycleStage: StrategyLifecycleStage;
  /** When the strategy entered its current lifecycle stage (UTC ISO). */
  lifecycleStageEnteredAt: string | null;
  /** Active rollout percentage (25/50/75/100); null when no rollout is in progress. */
  rolloutPct: number | null;
  /** UTC timestamp of the most recent live signal this strategy fired (null = never fired). */
  lastSignalAt: string | null;
  createdAt: string;
  riskOverridesJson: string | null;
  sizingConfigJson: string | null;
  sessionFilterJson: string | null;
  regimeGateJson: string | null;
  multiTimeframeGateJson: string | null;
}

export interface TradeSignalDto {
  id: number;
  strategyId: number;
  symbol: string | null;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  suggestedLotSize: number;
  confidence: number;
  mlPredictedDirection: TradeDirection;
  mlPredictedMagnitude: number | null;
  mlConfidenceScore: number | null;
  mlModelId: number | null;
  status: TradeSignalStatus;
  rejectionReason: string | null;
  orderId: number | null;
  generatedAt: string;
  expiresAt: string;
  isManual: boolean;
  /** Provenance of the signal. SpotAnalysis = auto-generated from an LLM
   *  spot analysis (owned by the seeded sentinel strategy). */
  source: TradeSignalSource;
}

/** Trade-signal provenance. Mirrors the backend TradeSignalSource enum. */
export type TradeSignalSource = 'Strategy' | 'Manual' | 'SpotAnalysis';

export type AccountType = 'Demo' | 'Real' | 'Contest';
export type MarginMode = 'Hedging' | 'Netting';

export interface TradingAccountDto {
  id: number;
  accountId: string | null;
  accountName: string | null;
  brokerServer: string | null;
  brokerName: string | null;
  accountType: AccountType;
  leverage: number;
  marginMode: MarginMode;
  currency: string | null;
  balance: number;
  equity: number;
  marginUsed: number;
  marginAvailable: number;
  /** Broker-reported margin level percentage. */
  marginLevel: number;
  /** Floating P&L for currently open positions. */
  profit: number;
  /** Credit balance allocated to this account. */
  credit: number;
  /** Stop-out mode (Percent / Money). */
  marginSoMode: string | null;
  /** Margin level threshold below which the broker raises a margin call. */
  marginSoCall: number;
  /** Margin level threshold below which the broker force-liquidates. */
  marginSoStopOut: number;
  /** Operator-configured cap on absolute daily realized loss (account currency). */
  maxAbsoluteDailyLoss: number;
  isActive: boolean;
  isPaper: boolean;
  lastSyncedAt: string;
  /** Per-account risk profile (null = strategy/default applies). When set it
   *  overrides the signal's strategy profile for this account and actively
   *  sizes trades to its maxRiskPerTradePct of account equity. */
  riskProfileId: number | null;
}

export interface RiskProfileDto {
  id: number;
  name: string | null;
  maxLotSizePerTrade: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  maxOpenPositions: number;
  maxDailyTrades: number;
  maxRiskPerTradePct: number;
  maxSymbolExposurePct: number;
  isDefault: boolean;
  drawdownRecoveryThresholdPct: number;
  recoveryLotSizeMultiplier: number;
  recoveryExitThresholdPct: number;
  requireStopLoss: boolean;
  requireTakeProfit: boolean;
  minStopLossDistancePips: number;
  minTakeProfitDistancePips: number;
  minRiskRewardRatio: number;
}

export interface CurrencyPairDto {
  id: number;
  symbol: string | null;
  baseCurrency: string | null;
  quoteCurrency: string | null;
  decimalPlaces: number;
  contractSize: number;
  minLotSize: number;
  maxLotSize: number;
  lotStep: number;
  isActive: boolean;
}

export interface AlertDto {
  id: number;
  alertType: AlertType;
  symbol: string | null;
  conditionJson: string;
  isActive: boolean;
  severity: AlertSeverity;
  deduplicationKey: string | null;
  cooldownSeconds: number;
  lastTriggeredAt: string | null;
  autoResolvedAt: string | null;
}

export interface AlertChannelStatusDto {
  channel: AlertChannel;
  isConfigured: boolean;
  /**
   * Per-channel kill-switch — when `false` the engine no-ops dispatch even if
   * the channel is fully configured. Used to silence a channel without losing
   * its credentials (e.g. SMTP rate-limited).
   */
  isEnabled: boolean;
  /** Server-masked preview (e.g. "al•••••@example.com" or "https://hooks.…"). */
  destinationPreview: string | null;
  timeoutSeconds: number;
}

export interface TestAlertChannelResultDto {
  channel: AlertChannel;
  delivered: boolean;
  destination: string;
  message: string;
  attemptedAt: string;
}

export interface SetAlertChannelEnabledRequest {
  channel: AlertChannel;
  isEnabled: boolean;
}

export interface SetAlertChannelEnabledResultDto {
  channel: AlertChannel;
  isEnabled: boolean;
  configKey: string;
}

export interface CandleDto {
  id: number;
  symbol: string | null;
  timeframe: string | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
  isClosed: boolean;
}

export interface MLModelOverfitFlagDto {
  mlModelId: number;
  symbol: string;
  timeframe: Timeframe;
  learnerArchitecture: string;
  modelVersion: string | null;
  firstActiveAt: string | null;
  cvSharpe: number | null;
  liveSharpe7d: number | null;
  sharpeRatio: number | null;
  resolvedSignals: number;
  reason: string;
}

export interface CandleCoverageDto {
  symbol: string;
  timeframe: string;
  totalCandles: number;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  requestedFrom: string | null;
  requestedTo: string | null;
  candlesInWindow: number;
  segmentCount: number;
  largestSegmentCandles: number;
  largestSegmentFrom: string | null;
  largestSegmentTo: string | null;
}

export interface MLModelDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe;
  modelVersion: string | null;
  filePath: string | null;
  status: MLModelStatus;
  /** Learner architecture used to train the model (e.g. `TabNet`, `BaggedLogistic`). */
  learnerArchitecture: string;
  isActive: boolean;
  directionAccuracy: number | null;
  magnitudeRMSE: number | null;
  trainingSamples: number;
  trainedAt: string;
  activatedAt: string | null;
  // Quality metrics — populated when training writes the model row.
  /** F1 on the validation set. <0.10 alongside high accuracy = severe class imbalance. */
  f1Score: number | null;
  /**
   * Matthews Correlation Coefficient — class-imbalance-robust skill score in [−1, +1].
   * Computed at training time from the persisted confusion-matrix counts (TP/TN/FP/FN),
   * so this is the *exact* MCC, not the UI-side symmetric-error estimate. When present,
   * the model health panel shows it directly; when null (older models trained before
   * this column existed) the UI falls back to `estimateMccFromAccuracyAndF1`.
   */
  mcc: number | null;
  /** Brier score (calibration). Lower is better; >0.25 typically indicates poor calibration. */
  brierScore: number | null;
  sharpeRatio: number | null;
  expectedValue: number | null;
  /** Adversarial fragility score (0..1, lower better; null when not measured). */
  fragilityScore: number | null;
  // Walk-forward cross-validation summary.
  walkForwardFolds: number | null;
  /** Mean accuracy across folds — compare to `directionAccuracy` to spot lucky-window concentration. */
  walkForwardAvgAccuracy: number | null;
  walkForwardStdDev: number | null;
  // Suppression / lifecycle flags.
  isSuppressed: boolean;
  isFallbackChampion: boolean;
}

/**
 * One row from `MLModelLifecycleLog` returned by `GET /ml-model/{id}/lifecycle`.
 * Surfaces the engine's "why did this model transition?" reasoning.
 */
export interface MLModelLifecycleLogEntryDto {
  id: number;
  mlModelId: number;
  /** e.g. `Activation`, `Supersession`, `DegradationRetirement`, `Suppression`, `Promotion`. */
  eventType: string;
  previousStatus: MLModelStatus | null;
  newStatus: MLModelStatus | null;
  previousChampionModelId: number | null;
  shadowEvaluationId: number | null;
  /** Operator-readable reason for the transition. */
  reason: string | null;
  triggeredByAccountId: number | null;
  directionAccuracyAtTransition: number | null;
  liveAccuracyAtTransition: number | null;
  brierScoreAtTransition: number | null;
  occurredAt: string;
}

export interface MLTrainingRunDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe;
  triggerType: TriggerType;
  status: RunStatus;
  /** Learner architecture used for the run (e.g. `TabNet`, `BaggedLogistic`). */
  learnerArchitecture: string;
  fromDate: string;
  toDate: string;
  totalSamples: number;
  directionAccuracy: number | null;
  magnitudeRMSE: number | null;
  mlModelId: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface MLTrainingRunDiagnosticsDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe;
  triggerType: TriggerType;
  status: RunStatus;
  priority: number;
  fromDate: string;
  toDate: string;
  totalSamples: number;
  mlModelId: number | null;
  errorMessage: string | null;
  startedAt: string;
  pickedUpAt: string | null;
  completedAt: string | null;
  trainingDurationMs: number | null;
  attemptCount: number;

  // Core eval metrics
  directionAccuracy: number | null;
  magnitudeRMSE: number | null;
  f1Score: number | null;
  brierScore: number | null;
  sharpeRatio: number | null;
  expectedValue: number | null;
  abstentionRate: number | null;
  abstentionPrecision: number | null;

  // Dataset / label quality
  labelImbalanceRatio: number | null;
  trainingDatasetStatsJson: string | null;
  datasetHash: string | null;
  candleIdRangeStart: number | null;
  candleIdRangeEnd: number | null;

  // Architecture / hyperparams
  learnerArchitecture: string;
  hyperparamConfigJson: string | null;
  cvFoldScoresJson: string | null;

  // Drift context
  driftTriggerType: string | null;
  driftMetadataJson: string | null;

  // Training feature-flag audit trail
  isPretrainingRun: boolean;
  isDistillationRun: boolean;
  isEmergencyRetrain: boolean;
  isMamlRun: boolean;
  mamlInnerSteps: number | null;
  smoteApplied: boolean;
  adversarialAugmentApplied: boolean;
  mixupApplied: boolean;
  curriculumApplied: boolean;
  curriculumFinalDifficulty: number | null;
  nceLossUsed: boolean;
  rareEventWeightingApplied: boolean;
  temporalDecayHalfLifeDays: number | null;
  labelNoiseRatePercent: number | null;
  sparsityPercent: number | null;
  coresetSelectionRatio: number | null;
}

export interface MLFeatureImportanceItem {
  feature: string;
  meanImportance: number;
  stdImportance: number;
  agreementScore: number;
}

export interface MLMrmrFeatureItem {
  featureName: string;
  mrmrRank: number;
  mrmrScore: number;
  mutualInfoWithTarget: number;
  redundancyScore: number;
}

export interface MLModelFeatureImportanceDto {
  modelId: number;
  symbol: string | null;
  timeframe: string;
  consensusComputedAt: string | null;
  contributingModelCount: number;
  meanKendallTau: number;
  schemaKey: string | null;
  features: MLFeatureImportanceItem[];
  mrmrFallback: MLMrmrFeatureItem[];
}

export interface BatchCancelOrdersItem {
  id: number;
  status: 'Cancelled' | 'Failed';
  reason: string | null;
}

export interface BatchCancelOrdersResult {
  total: number;
  cancelled: number;
  failed: number;
  results: BatchCancelOrdersItem[];
}

export interface BatchCancelOrdersRequest {
  orderIds: number[];
  reason?: string;
}

export interface OperatorRoleDto {
  id: number;
  tradingAccountId: number;
  role: string;
  assignedAt: string;
  assignedByAccountId: number | null;
}

export interface DriftAlertDto {
  id: number;
  symbol: string | null;
  alertType: AlertType;
  severity: AlertSeverity;
  detectorType: string | null;
  conditionJson: string;
  deduplicationKey: string | null;
  cooldownSeconds: number;
  isActive: boolean;
  lastTriggeredAt: string | null;
  autoResolvedAt: string | null;
}

export interface ShadowEvaluationDto {
  id: number;
  challengerModelId: number;
  championModelId: number;
  symbol: string | null;
  timeframe: Timeframe;
  status: ShadowEvaluationStatus;
  requiredTrades: number;
  completedTrades: number;
  championDirectionAccuracy: number;
  championMagnitudeCorrelation: number;
  championBrierScore: number;
  challengerDirectionAccuracy: number;
  challengerMagnitudeCorrelation: number;
  challengerBrierScore: number;
  promotionDecision: PromotionDecision;
  decisionReason: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface BacktestRunDto {
  id: number;
  strategyId: number;
  symbol: string | null;
  timeframe: Timeframe;
  fromDate: string;
  toDate: string;
  initialBalance: number;
  status: RunStatus;
  resultJson: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  // Denormalized result metrics — present once the run completes successfully.
  // Engine populates these from the result JSON during BacktestWorker so the
  // dashboard can sort/filter without parsing JSON per row.
  totalTrades: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  sharpeRatio: number | null;
  finalBalance: number | null;
  totalReturn: number | null;
}

export interface WalkForwardRunDto {
  id: number;
  strategyId: number;
  symbol: string | null;
  timeframe: Timeframe;
  fromDate: string;
  toDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  status: RunStatus;
  initialBalance: number;
  averageOutOfSampleScore: number | null;
  scoreConsistency: number | null;
  windowResultsJson: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StrategyAllocationDto {
  id: number;
  strategyId: number;
  strategyName: string | null;
  weight: number;
  rollingSharpRatio: number;
  lastRebalancedAt: string;
}

export interface ExecutionQualityLogDto {
  id: number;
  orderId: number;
  strategyId: number | null;
  symbol: string | null;
  session: TradingSession;
  requestedPrice: number;
  filledPrice: number;
  slippagePips: number;
  submitToFillMs: number;
  wasPartialFill: boolean;
  fillRate: number;
  recordedAt: string;
}

export interface DecisionLogDto {
  id: number;
  entityType: string | null;
  entityId: number;
  decisionType: string | null;
  outcome: string | null;
  reason: string | null;
  contextJson: string | null;
  source: string | null;
  createdAt: string;
}

export interface EngineConfigDto {
  id: number;
  key: string | null;
  value: string | null;
  description: string | null;
  dataType: ConfigDataType;
  isHotReloadable: boolean;
  lastUpdatedAt: string;
}

export interface EconomicEventDto {
  id: number;
  title: string | null;
  currency: string | null;
  impact: EconomicImpact;
  scheduledAt: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  source: EconomicEventSource;
}

export interface DrawdownSnapshotDto {
  id: number;
  currentEquity: number;
  peakEquity: number;
  drawdownPct: number;
  recoveryMode: RecoveryMode;
  recordedAt: string;
}

export interface SentimentSnapshotDto {
  id: number;
  currency: string | null;
  source: SentimentSource;
  sentimentScore: number;
  confidence: number;
  rawDataJson: string | null;
  capturedAt: string;
}

export interface COTReportDto {
  id: number;
  currency: string | null;
  reportDate: string;
  commercialLong: number;
  commercialShort: number;
  nonCommercialLong: number;
  nonCommercialShort: number;
  retailLong: number;
  retailShort: number;
  netNonCommercialPositioning: number;
  netPositioningChangeWeekly: number;
}

export interface MarketRegimeSnapshotDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe;
  regime: MarketRegime;
  confidence: number;
  adx: number;
  atr: number;
  bollingerBandWidth: number;
  detectedAt: string;
}

export interface StrategyPerformanceSnapshotDto {
  id: number;
  strategyId: number;
  windowTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalPnL: number;
  healthScore: number;
  healthStatus: string | null;
  evaluatedAt: string;
  marketRegime?: string | null;
}

export interface StrategyVariantDto {
  id: number;
  baseStrategyId: number;
  name: string;
  parameterOverridesJson: string;
  isActive: boolean;
  shadowSignalCount: number;
  requiredSignals: number;
  shadowWinRate: number;
  shadowExpectedValue: number;
  shadowSharpeRatio: number;
  baseWinRate: number;
  baseExpectedValue: number;
  isPromoted: boolean;
  comparisonResultJson: string | null;
  startedAt: string;
  completedAt: string | null;
}

/** Body for `POST /strategy/health/recent`. Fetches the last N snapshots for each id. */
export interface GetRecentStrategySnapshotsRequest {
  strategyIds: number[];
  count?: number;
}

/**
 * Capacity-curve point for a single AUM tier. The strategy was simulated at
 * `aumTier` and the resulting Sharpe / PF / max-DD were recorded; `meetsFloor`
 * is `true` when Sharpe stayed above the operator-set floor fraction of the
 * baseline (typically 50% of `baselineSharpe`).
 */
export interface CapacityTierDto {
  aumTier: number;
  sharpeAtTier: number;
  profitFactorAtTier: number;
  maxDrawdownPctAtTier: number;
  meetsFloor: boolean;
}

export interface StrategyCapacityProfileDto {
  strategyId: number;
  baselineAum: number;
  baselineSharpe: number;
  /** Largest AUM tier where Sharpe stayed above the floor; 0 when none passed. */
  capacityFloorAum: number;
  computedAt: string;
  tiers: CapacityTierDto[];
}

/** One per-strategy entry in the allocator's snapshot. */
export interface StrategyAllocationWeightEntry {
  strategyId: number;
  strategyName: string;
  symbol: string;
  weight: number;
  recentSharpe: number;
  observationCount: number;
  computedAt: string;
}

/**
 * Snapshot of the meta-allocator's current weights across the active portfolio.
 * Operators read this to see which strategies are throttled (weight < 1.0) and
 * the Sharpe ratio that drove the throttle.
 */
export interface StrategyAllocationWeightsDto {
  coveredStrategies: number;
  throttledStrategies: number;
  targetSharpe: number;
  minWeight: number;
  latestComputedAt: string;
  entries: StrategyAllocationWeightEntry[];
}

/** One row of the FWER report's per-hypothesis-class breakdown. */
export interface HypothesisClassFwerEntry {
  hypothesisClass: string;
  activeStrategies: number;
  trialsInWindow: number;
  bonferroniSurvivors: number;
}

export interface StrategyRejectionReasonDto {
  reason: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface StrategyRejectionStageDto {
  stage: string;
  count: number;
  reasons: StrategyRejectionReasonDto[];
}

/**
 * Per-strategy aggregate of `SignalRejectionAudit` rows over an optional UTC
 * window. Stages are ordered by total count desc; reasons within a stage by
 * count desc. Powers the strategy-detail "Pipeline rejections" panel.
 */
export interface StrategyRejectionDistributionDto {
  strategyId: number;
  from: string | null;
  to: string | null;
  totalRejections: number;
  stages: StrategyRejectionStageDto[];
}

/** Body for `POST /strategy/{id}/rejection-distribution`. */
export interface GetStrategyRejectionDistributionRequest {
  from?: string | null;
  to?: string | null;
}

export interface EquityCurvePointDto {
  closedAt: string;
  realizedPnL: number;
  cumulativePnL: number;
}

/**
 * Per-strategy realised cumulative-PnL series powering the compare-page
 * overlay. Server returns chronological points capped at 5,000 entries.
 */
export interface StrategyEquityCurveDto {
  strategyId: number;
  from: string | null;
  to: string | null;
  pointCount: number;
  finalCumulativePnL: number;
  points: EquityCurvePointDto[];
}

/** Body for `POST /strategy/{id}/equity-curve`. */
export interface GetStrategyEquityCurveRequest {
  from?: string | null;
  to?: string | null;
}

/**
 * One row in the strategy-generation timeline. Status values today are
 * `Running` / `Completed` / `Failed`; `failureStage` + `failureMessage` are
 * populated only when status is `Failed`.
 */
export interface StrategyGenerationCycleRunDto {
  id: number;
  workerName: string;
  cycleId: string;
  status: string;
  fingerprint: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  durationMs: number | null;
  candidatesCreated: number;
  reserveCandidatesCreated: number;
  candidatesScreened: number;
  symbolsProcessed: number;
  symbolsSkipped: number;
  strategiesPruned: number;
  portfolioFilterRemoved: number;
  failureStage: string | null;
  failureMessage: string | null;
  lastUpdatedAtUtc: string;
}

/**
 * Portfolio-wide multiple-testing-tax report. Operator reads it to see how many
 * of the currently-active strategies would survive Bonferroni / Benjamini-
 * Hochberg corrections — a leading indicator that screening has approved more
 * strategies than the trial volume statistically supports.
 */
export interface PortfolioFwerReportDto {
  alpha: number;
  lookbackDays: number;
  totalTrialsInWindow: number;
  totalActiveStrategies: number;
  eligibleStrategies: number;
  bonferroniSurvivors: number;
  benjaminiHochbergSurvivors: number;
  benjaminiHochbergCriticalPValue: number;
  byHypothesisClass: HypothesisClassFwerEntry[];
}

export interface OptimizationRunDto {
  id: number;
  strategyId: number;
  triggerType: TriggerType;
  status: OptimizationRunStatus;
  iterations: number;
  bestParametersJson: string | null;
  bestHealthScore: number | null;
  baselineParametersJson: string | null;
  baselineHealthScore: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  approvedAt: string | null;
}

export interface LivePriceDto {
  symbol: string | null;
  bid: number;
  ask: number;
  spread: number;
  timestamp: string;
}

/** A single price/volume entry inside an OrderBookSnapshot's `levelsJson` payload. */
export interface OrderBookLevel {
  /** Price for this depth level. */
  P: number;
  /** Volume resting at this price level. */
  V: number;
}

/** Parsed shape of an OrderBookSnapshot's `levelsJson` payload. */
export interface OrderBookLevels {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface OrderBookSnapshotDto {
  id: number;
  symbol: string;
  bidPrice: number;
  askPrice: number;
  bidVolume: number;
  askVolume: number;
  spreadPoints: number;
  /** Raw JSON of beyond-top-of-book levels — null when the broker only exposes top-of-book. */
  levelsJson: string | null;
  instanceId: string;
  capturedAt: string;
}

/** One log event captured by the engine's in-memory ring buffer. */
export interface EngineLogEntryDto {
  timestamp: string;
  /** "Trace" | "Debug" | "Information" | "Warning" | "Error" | "Critical". */
  level: string;
  category: string;
  eventId: number;
  message: string;
  /** Stringified exception if the log entry carried one. */
  exception: string | null;
}

/** Response of GET /system/logs. */
export interface EngineLogPageDto {
  entries: EngineLogEntryDto[];
  bufferSize: number;
  bufferCapacity: number;
  /** How many entries have been overwritten since the buffer was initialised. */
  droppedCount: number;
}

export interface EngineStatusDto {
  isRunning: boolean;
  activeStrategies: number;
  openPositions: number;
  pendingOrders: number;
  paperMode: string | null;
  checkedAt: string;
}

/** @deprecated Use EngineStatusDto instead */
export type HealthStatusDto = EngineStatusDto;

export interface ApiQuotaStatusDto {
  brokerKey: string | null;
  maxRequests: number;
  remainingRequests: number;
  isThrottled: boolean;
}

export interface TokenResponseDto {
  token: string;
  expiresAt: string;
  tokenType: string;
}

// ============================================================
// Ops / Admin (Phase 2)
// ============================================================

export interface KillSwitchStatusDto {
  enabled: boolean;
  reason: string | null;
  changedAt: string | null;
  changedBy: string | null;
}

export interface ToggleKillSwitchRequest {
  enabled: boolean;
  reason?: string | null;
}

export type WorkerHealthStatus = 'Healthy' | 'Degraded' | 'Failed' | 'Idle';

/**
 * Mirrors the engine's `WorkerHealthSnapshot` entity (the raw response shape
 * of `GET /health/workers`). Field names are camelCased copies of the C#
 * properties — keep this aligned with `WorkerHealthSnapshot.cs` when fields
 * are added/renamed engine-side.
 */
export interface WorkerHealthSnapshot {
  workerName: string;
  isRunning: boolean;
  isCompleted: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  lastCycleDurationMs: number;
  cycleDurationP50Ms: number;
  cycleDurationP95Ms: number;
  cycleDurationP99Ms: number;
  consecutiveFailures: number;
  errorsLastHour: number;
  successesLastHour: number;
  backlogDepth: number;
  lastQueueLatencyMs: number;
  queueLatencyP50Ms: number;
  queueLatencyP95Ms: number;
  lastExecutionDurationMs: number;
  executionDurationP50Ms: number;
  executionDurationP95Ms: number;
  retriesLastHour: number;
  recoveriesLastHour: number;
  configuredIntervalSeconds: number;
  capturedAt: string;
}

/**
 * Engine snapshot enriched with derived status, category, error rate, and
 * staleness flags. Produced client-side by `WorkersService.list()` so every
 * consumer sees the same derivation rather than re-implementing it.
 */
export interface WorkerHealthDto extends WorkerHealthSnapshot {
  /** Display name (= workerName, kept for convenience). */
  name: string;
  /** First CamelCase segment of the worker name — e.g. "ML", "Strategy", "Risk". */
  category: string;
  /** Derived from isRunning + consecutiveFailures + errorRate + staleness. */
  status: WorkerHealthStatus;
  /** errorsLastHour / (errorsLastHour + successesLastHour); 0 when no activity. */
  errorRate: number;
  /** Seconds since lastSuccessAt observed at capturedAt time. */
  staleSeconds: number | null;
  /** True when staleSeconds exceeds 3× the configured interval (floor 5 min). */
  isStale: boolean;
}

export type EAInstanceStatus = 'Active' | 'Disconnected' | 'ShuttingDown';

export interface EAInstanceDto {
  id: number;
  instanceId: string;
  tradingAccountId: number;
  symbols: string;
  chartSymbol: string;
  chartTimeframe: string;
  isCoordinator: boolean;
  status: EAInstanceStatus;
  lastHeartbeat: string;
  eaVersion: string;
  registeredAt: string;
  deregisteredAt: string | null;
}

export interface DeadLetterDto {
  id: number;
  eventType: string | null;
  payloadJson: string | null;
  errorMessage: string | null;
  attemptCount: number;
  isResolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * Calibration / trend-report response. The engine compares the latest
 * month's rejection mix against a multi-month baseline and flags any
 * (stage, reason) bucket whose share moved by more than the threshold.
 */
export interface CalibrationTrendRowDto {
  stage: string;
  reason: string;
  latestMonthCount: number;
  baselineCount: number;
  latestMonthSharePct: number;
  baselineSharePct: number;
  deltaPct: number;
  isAnomaly: boolean;
  hint: string | null;
}
export interface CalibrationTrendReportDto {
  latestMonthStart: string;
  latestMonthEnd: string;
  baselineStart: string;
  baselineEnd: string;
  latestMonthTotal: number;
  baselineTotal: number;
  anomalyThresholdPct: number;
  minBaselineCount: number;
  rows: CalibrationTrendRowDto[];
}

/**
 * Which screening gate is bindingly tight on candidate qualification —
 * informs the operator-side decision to loosen IS / OOS / MonteCarlo
 * thresholds. The engine groups recent failures by reason+class and
 * picks the dominant one.
 */
export interface ScreeningGateBindingRowDto {
  reason: string;
  count: number;
  sharePct: number;
  class: string;
  topStrategyType: string | null;
  topStrategyTypeCount: number;
}
export interface ScreeningGateBindingReportDto {
  windowStart: string;
  windowEnd: string;
  lookbackDays: number;
  totalFailures: number;
  isReliable: boolean;
  overallClass: string;
  bindingReason: string;
  bindingReasonShare: number;
  bindingClass: string;
  recommendation: string;
  rows: ScreeningGateBindingRowDto[];
}

export interface SignalRejectionEntryDto {
  id: number;
  tradeSignalId: number | null;
  strategyId: number | null;
  symbol: string | null;
  stage: string;
  reason: string;
  detail: string | null;
  source: string | null;
  rejectedAt: string;
}

/**
 * Engine-computed floor recommendations — pulls percentile distributions
 * of recent observations and suggests floors that exclude the bottom N%.
 */
export interface DefaultsCalibrationDistributionDto {
  min: number;
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
  mean: number;
}
export interface DefaultsCalibrationEntryDto {
  configKey: string;
  floorDescription: string;
  dataSource: string;
  sampleCount: number;
  currentFloor: number;
  /**
   * Null when the engine has insufficient samples to compute percentiles
   * (typically below the configured MinBaselineCount). The UI hides the
   * percentile chart and shows the sample-count note instead.
   */
  distribution: DefaultsCalibrationDistributionDto | null;
  exclusionRatePct: number;
  recommendedFloor: number;
  recommendationRationale: string;
}
export interface DefaultsCalibrationDto {
  generatedAtUtc: string;
  analysisFromUtc: string;
  analysisToUtc: string;
  defaults: DefaultsCalibrationEntryDto[];
}

// ============================================================
// ML Signal A/B Tests (Phase 3)
// ============================================================

export type MLSignalAbTestStatus =
  | 'Running'
  | 'Completed'
  | 'ChampionWon'
  | 'ChallengerWon'
  | 'Inconclusive';

export interface MLSignalAbTestResultDto {
  id: number;
  championModelId: number;
  challengerModelId: number;
  symbol: string | null;
  timeframe: Timeframe;
  status: MLSignalAbTestStatus;
  sampleSize: number;
  championPnl: number;
  challengerPnl: number;
  championWinRate: number;
  challengerWinRate: number;
  /** SPRT log-likelihood ratio; positive favours challenger. */
  sprtLogLikelihoodRatio: number | null;
  pValue: number | null;
  decision: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ============================================================
// Optimization (Phase 3)
// ============================================================

export interface ValidateOptimizationRequest {
  strategyId: number;
  parametersJson?: string;
  searchBudget?: number;
}

export interface OptimizationValidationDto {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface OptimizationDryRunDto {
  strategyId: number;
  estimatedGridSize: number;
  candleCount: number;
  estimatedDurationMinutes: number;
  estimatedCpuCores: number;
  notes: string | null;
}

// ============================================================
// Command / Request Interfaces
// ============================================================

// ============================================================
// Command / Request Types (matching swagger exactly)
// ============================================================

export interface CreateOrderRequest {
  tradeSignalId?: number | null;
  strategyId: number;
  tradingAccountId: number;
  symbol?: string;
  orderType?: string;
  executionType?: string;
  quantity: number;
  price: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  isPaper?: boolean;
  notes?: string | null;
}

export interface UpdateOrderRequest {
  symbol?: string | null;
  orderType?: string | null;
  quantity?: number | null;
  price?: number | null;
  status?: string | null;
  notes?: string | null;
}

export interface ModifyOrderRequest {
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface SubmitOrderResult {
  orderId: number;
  brokerOrderId: string | null;
  status: OrderStatus;
  message: string | null;
}

export interface CreateStrategyRequest {
  name?: string;
  description?: string;
  strategyType?: string;
  symbol?: string;
  timeframe?: string;
  parametersJson?: string;
  riskProfileId?: number | null;
  riskOverridesJson?: string | null;
  sizingConfigJson?: string | null;
  sessionFilterJson?: string | null;
  regimeGateJson?: string | null;
  multiTimeframeGateJson?: string | null;
}

export interface StrategyParameterFieldDto {
  name: string;
  label: string;
  kind: 'int' | 'decimal' | 'bool' | 'enum' | 'string' | string;
  description: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  default: unknown;
  enumValues: string[] | null;
}

export interface StrategyParameterSchemaDto {
  strategyType: string;
  fields: StrategyParameterFieldDto[];
}

export interface RunBacktestPreviewRequest {
  symbol: string;
  timeframe: string;
  strategyType: string;
  parametersJson?: string;
  lookbackDays?: number;
  initialBalance?: number;
  riskOverridesJson?: string | null;
  sizingConfigJson?: string | null;
  sessionFilterJson?: string | null;
  regimeGateJson?: string | null;
  multiTimeframeGateJson?: string | null;
}

export interface BacktestPreviewResult {
  symbol: string;
  timeframe: string;
  candlesAnalyzed: number;
  fromUtc: string;
  toUtc: string;
  initialBalance: number;
  finalBalance: number;
  totalReturn: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  expectancy: number;
  exposurePct: number;
  timedOut: boolean;
  note: string | null;
  equityCurve: number[];
}

export interface StrategyRejectionSummaryDto {
  strategyId: number;
  symbol: string;
  stage: string;
  reason: string;
  count: number;
  latestRejectedAt: string;
}

export interface ArchitectureOptionDto {
  value: number;
  name: string;
}

export interface AvailableArchitecturesDto {
  torchAvailable: boolean;
  disabledReason: string | null;
  disabledArchitectures: string[];
  architectures: ArchitectureOptionDto[];
}

/**
 * Mined symbolic feature. Status flows Candidate → Promoted → Retired
 * (or Rejected at mine-time). `expressionJson` is the polymorphic
 * expression tree; UI renders the human-friendly `name` and optionally
 * lets operators peek the JSON for advanced inspection.
 */
export type SymbolicFeatureStatus = 'Candidate' | 'Promoted' | 'Retired' | 'Rejected';

export interface SymbolicFeatureDto {
  id: number;
  symbol: string;
  timeframe: string;
  name: string;
  expressionJson: string;
  nodeCount: number;
  depth: number;
  trainingIc: number;
  validationIc: number;
  trainingCoverage: number;
  validationCoverage: number;
  forwardReturnHorizonBars: number;
  status: SymbolicFeatureStatus | string;
  retirementReason: string | null;
  minedAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
}

/** One decay-evaluation snapshot for an active symbolic feature. */
export interface SymbolicFeatureDecaySnapshotDto {
  id: number;
  featureId: number;
  symbol: string;
  timeframe: string;
  liveIc: number;
  liveCoverage: number;
  liveWindowBars: number;
  outcome: string;
  consecutiveDecayCyclesAfter: number;
  evaluatedAt: string;
}

/** Per-slot V6 OrderBook feature stats. */
export interface V6FeatureSlotStatsDto {
  slotIndex: number;
  semanticName: string;
  modelsWithFeature: number;
  modelsAboveThreshold: number;
  fractionAboveThreshold: number;
  meanImportance: number;
  maxImportance: number;
}

/**
 * Operator-facing diagnostic: are the V6 OrderBook features (slots 52-56)
 * actually being used by trained models? Drives the "should we invest more
 * in microstructure infra" decision.
 */
export interface V6OrderBookFeatureUtilizationDto {
  computedAtUtc: string;
  modelsExamined: number;
  modelsWithV6Schema: number;
  modelsSkippedDeserialisation: number;
  modelsWithUsableImportance: number;
  importanceThreshold: number;
  slotStats: V6FeatureSlotStatsDto[];
  verdict: 'ImportancesHigh' | 'ImportancesMixed' | 'ImportancesLow' | 'InsufficientData' | string;
  verdictReason: string;
}

export interface PromoteSymbolicFeatureRequest {
  reason?: string | null;
}

export interface RetireSymbolicFeatureRequest {
  reason: string;
}

/**
 * LLM-generated strategy proposal awaiting operator review.
 * `proposalJson` is the raw DSL the model produced; operators inspect
 * it before promoting (which creates a Paused Strategy linked via
 * `promotedStrategyId`) or rejecting.
 */
export type LlmProposalStatus =
  | 'Pending'
  | 'Approved'
  | 'Rejected'
  | 'DslInvalid'
  | 'Duplicate'
  | 'Screening'
  | 'Validating';

/**
 * Bull/bear/judge advisory review of an auto-promoted strategy (PRD-0001 §6 F4).
 * Strictly informational — never blocks the deterministic gates. The four
 * JSON fields stay as raw strings so the UI deserializes the thesis blobs
 * on demand (avoids duplicating the engine-side PromotionReviewSchemas).
 */
export type PromotionReviewRecommendation = 'Confirm' | 'Caution' | 'SkipRecommend';

export type PromotionReviewOutcome =
  | 'Completed'
  | 'Truncated'
  | 'GenerationFailed'
  | 'SkippedOutOfBand'
  | 'SkippedDisabled';

export interface PromotionReviewSnapshotDto {
  id: number;
  strategyId: number;
  screeningScore: number;
  borderlineLowerPercentile: number;
  borderlineUpperPercentile: number;
  bullThesisJson: string | null;
  bearThesisJson: string | null;
  judgeRecommendation: PromotionReviewRecommendation | null;
  judgeConfidence: number | null;
  judgeKeyConcernsJson: string | null;
  outcome: PromotionReviewOutcome;
  totalCostUsd: number;
  llmInvocationIdsJson: string | null;
  createdAt: string;
}

export interface LlmProposalDto {
  id: number;
  name: string;
  symbol: string;
  source: string;
  status: LlmProposalStatus | string;
  proposalJson: string;
  rejectionReason: string | null;
  promotedStrategyId: number | null;
  proposedAt: string;
}

/**
 * Per-cycle outcome of the strategy-proposal generator. Mirrors the
 * engine `StrategyProposalCycleResult` returned by the manual-trigger
 * endpoint + the scheduled worker.
 */
export interface StrategyProposalCycleResult {
  pendingWritten: number;
  dslInvalidWritten: number;
  duplicateWritten: number;
  autoPromotedCount: number;
  sourcesAttempted: number;
  completedAt: string;
  totalWritten: number;
}

export interface StrategyPromotionConfigEntryDto {
  key: string;
  value: string;
  description: string | null;
  dataType: ConfigDataType;
  isHotReloadable: boolean;
  group: string;
  lastUpdatedAt: string;
}

export interface StrategyPromotionConfigUpdateEntry {
  key: string;
  value: string;
}

/**
 * Worker-status snapshot for the LLM strategy-proposal page header.
 * Mirrors the engine `LlmProposalStatusDto`.
 */
export interface LlmProposalStatusDto {
  workerEnabled: boolean;
  apiKeyConfigured: boolean;
  model: string;
  pollIntervalHours: number;
  proposalsPerCycle: number;
  totalProposalsAllTime: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  dslInvalidCount: number;
  duplicateCount: number;
  approvalRateAllTime: number | null;
  lastProposalAt: string | null;
  nextScheduledRunAt: string | null;
  recentActivity: LlmProposalDto[];
}

// ── LLM observability (PRD-0001 narrative layer) ─────────────────────────
// Mirrors LlmInvocation / LifecycleEventRationale wire shapes from the
// engine's new /llm/* endpoints. Outcome and DataType numbers come from
// the C# enums LlmOutcome / ConfigDataType respectively.

/**
 * Terminal outcome of a single LLM API call. Mirrors engine LlmOutcome.
 * Wire format is the C# enum name (string) because the engine registers
 * `JsonStringEnumConverter` globally.
 */
export type LlmOutcome = 'Ok' | 'Retry' | 'Failed' | 'BudgetExceeded' | 'SchemaFallback';

export const LlmOutcomeLabel: Record<LlmOutcome, string> = {
  Ok: 'Ok',
  Retry: 'Retry',
  Failed: 'Failed',
  BudgetExceeded: 'Budget exceeded',
  SchemaFallback: 'Schema fallback',
};

export interface LlmInvocationDto {
  id: number;
  provider: string;
  model: string;
  purpose: string;
  promptHash: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
  costUsd: number;
  outcome: LlmOutcome;
  invokedAt: string;
  errorMessage: string | null;
}

/** Detail view returned from GET /llm/invocations/{id} — list metadata plus
 *  the full request + response bodies. The list endpoint omits the bodies to
 *  keep the ledger query light; only the row-click drilldown fetches them. */
export interface LlmInvocationDetailDto extends LlmInvocationDto {
  /** "<systemPrompt>\n<userPrompt>" — the literal bytes hashed into promptHash. */
  requestBody: string | null;
  /** Raw response content returned by the provider. Null on failed / budget rows. */
  responseBody: string | null;
}

export interface LlmInvocationsBucketDto {
  label: string;
  calls: number;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface LlmInvocationsSummaryDto {
  totalCalls: number;
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  averageLatencyMs: number;
  okCount: number;
  retryCount: number;
  failedCount: number;
  budgetExceededCount: number;
  schemaFallbackCount: number;
  byProvider: LlmInvocationsBucketDto[];
  byModel: LlmInvocationsBucketDto[];
  byPurpose: LlmInvocationsBucketDto[];
}

export interface LifecycleRationaleDto {
  id: number;
  eventType: string;
  eventId: number;
  eventCorrelationId: string;
  rationaleText: string;
  keyMetricReferenced: string;
  confidence: number;
  llmInvocationId: number;
  llmProvider: string | null;
  llmModel: string | null;
  createdAt: string;
}

export interface LlmInvocationQueryFilter {
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  outcome?: LlmOutcome | null;
  from?: string | null;
  to?: string | null;
}

export interface LifecycleRationaleQueryFilter {
  eventType?: string | null;
  eventId?: number | null;
  minConfidence?: number | null;
  from?: string | null;
  to?: string | null;
}

export interface LlmConfigEntryDto {
  key: string;
  value: string;
  description: string | null;
  dataType: ConfigDataType;
  isHotReloadable: boolean;
  isSecret: boolean;
  lastUpdatedAt: string;
}

export interface LlmConfigUpdateEntry {
  key: string;
  value: string;
}

export interface TestLlmProviderTierResult {
  tier: 'Deep' | 'Quick';
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  llmInvocationId: number | null;
  responseSnippet: string | null;
  errorMessage: string | null;
}

export interface TestLlmProviderResult {
  tiers: TestLlmProviderTierResult[];
}

export interface RationaleCoverageEntryDto {
  eventType: string;
  description: string;
  count: number;
  averageConfidence: number | null;
  latestAt: string | null;
  latestRationaleId: number | null;
}

export interface RationaleCoverageDto {
  windowHours: number;
  totalRationales: number;
  averageConfidence: number;
  lowConfidenceCount: number;
  totalCostUsd: number;
  byEventType: RationaleCoverageEntryDto[];
}

/** One-shot market-analysis result from POST /market-data/analyze. */
export interface MarketAnalysisResultDto {
  symbol: string;
  timeframe: string;
  provider: string;
  model: string;
  llmInvocationId: number;
  latencyMs: number;
  analysis: string;
  completedAt: string;
  /** Primary (best) recommendation — mirrors recommendations[0] for
   *  back-compat with the single-recommendation bubble/replay. Null when the
   *  LLM emitted no parseable block. */
  recommendation: MarketAnalysisRecommendationDto | null;
  /** Full ranked set the LLM produced (primary first). */
  recommendations?: MarketAnalysisRecommendationDto[] | null;
  /** Ids of trade signals persisted from the viable subset when the
   *  auto-generate-signals toggle was on. Empty/absent otherwise. */
  generatedSignalIds?: number[] | null;
  /** LLM-emitted position-management instructions for any open
   *  SpotAnalysis-source positions on this symbol. Every instruction the
   *  model emitted is mirrored here, including ones the server rejected
   *  (RateLimited / BelowConfidence / PositionClosed / Failed), so the UI
   *  can show the LLM's full intent and explain rejections. Empty/absent
   *  when the model chose not to act on any open positions. */
  exitInstructions?: MarketAnalysisExitInstructionDto[] | null;
}

/** Position-management instruction the LLM emitted in its
 *  <<<EXIT_INSTRUCTIONS_JSON>>> block, mirrored back to the UI with the
 *  server's dispatch outcome. */
export interface MarketAnalysisExitInstructionDto {
  /** Target position id. Matches the openPositions entry the LLM was shown. */
  positionId: number;
  /** "close" — partial or full close. "moveStop" — move SL to lock in profit. */
  action: 'close' | 'moveStop';
  /** For action = "close": the LLM-requested fraction in [1, 100]. */
  closeFractionPct: number | null;
  /** For action = "moveStop": the new SL price. */
  newStopLoss: number | null;
  /** LLM-reported confidence [0, 1]. Server floor: 0.60. */
  confidence: number;
  /** One-sentence rationale (max 200 chars on the wire). */
  reason: string;
  /** Dispatch outcome — one of:
   *   - "Executed"        — close / modify command dispatched successfully.
   *   - "RateLimited"     — 30-min per-position cooldown not elapsed.
   *   - "BelowConfidence" — below the 0.60 confidence floor.
   *   - "PositionClosed"  — position closed between snapshot and dispatch.
   *   - "Failed"          — validation / dispatch error (see failureMessage). */
  outcome: 'Executed' | 'RateLimited' | 'BelowConfidence' | 'PositionClosed' | 'Failed';
  /** For action = "close" + outcome = "Executed": the actual lots closed
   *  after broker-lot-step snap (may differ slightly from the LLM's intent). */
  executedCloseLots: number | null;
  /** Populated when outcome ≠ "Executed" with a reason the operator can
   *  surface — e.g. "Cooldown active — last executed action 12 min ago…". */
  failureMessage: string | null;
}

/** Operator-actionable trade decision parsed from the analysis. Price fields
 *  are null when action = Hold. */
export interface MarketAnalysisRecommendationDto {
  action: 'Buy' | 'Sell' | 'Hold';
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Self-reported probability the trade plays out, [0, 1]. */
  confidence: number;
  rationale: string;
}

/** Structured multi-week → multi-month posture parsed from the macro
 *  analysis tail block. NOT a tactical trade (no entry/SL/TP) — a directional
 *  bias plus the D1 levels that confirm or invalidate it. */
export interface LongerHorizonViewDto {
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  /** Conviction in the posture, [0, 1]. */
  confidence: number;
  structure: string;
  positioning: string;
  catalysts: string;
  keyLevels: string;
}

/** Longer-horizon macro-analysis result from POST /market-data/analyze-macro.
 *  Sibling of {@link MarketAnalysisResultDto}; D1-anchored, positioning-aware,
 *  no tactical trade chip. `longerHorizon` is null when the LLM omitted /
 *  mangled the structured block (prose still returned). */
export interface MarketMacroAnalysisResultDto {
  symbol: string;
  /** The operator's working timeframe at trigger time. Echoed for context /
   *  per-pair keying only — the analysis itself is always D1-anchored. */
  timeframe: string;
  provider: string;
  model: string;
  llmInvocationId: number;
  latencyMs: number;
  analysis: string;
  completedAt: string;
  longerHorizon: LongerHorizonViewDto | null;
}

/**
 * Auto-tune proposal emitted by CompositeMLAutoTuningWorker. Awaits operator
 * Apply or Reject. Apply transactionally upserts the EngineConfig row.
 */
export type AutoTuneProposalStatus = 'Pending' | 'Applied' | 'Rejected' | 'Stale';

export interface AutoTuneProposalDto {
  id: number;
  proposalKey: string;
  currentValue: number;
  proposedValue: number;
  confidenceLow: number;
  confidenceHigh: number;
  evidenceCount: number;
  rationaleJson: string;
  proposedAtUtc: string;
  status: AutoTuneProposalStatus | string;
  reviewedAtUtc: string | null;
  reviewedBy: string | null;
  appliedAtUtc: string | null;
}

/** Per-knob auto-apply config — the 4-gate safety stack on autonomous apply. */
export interface AutoApplyConfigDto {
  id: number;
  proposalKey: string;
  autoApplyEnabled: boolean;
  convergenceTolerance: number;
  requiredConvergenceCount: number;
  quietPeriodHours: number;
  minValue: number | null;
  maxValue: number | null;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface UpsertAutoApplyConfigRequest {
  autoApplyEnabled: boolean;
  convergenceTolerance: number;
  requiredConvergenceCount: number;
  quietPeriodHours: number;
  minValue?: number | null;
  maxValue?: number | null;
}

/**
 * One worker's override-knob allow-list. Replaces the "grep CLAUDE.md to
 * find the override key" workflow with a queryable surface.
 */
export interface WorkerOverrideKnobsDto {
  workerName: string;
  overrideKnobs: string[];
}

/**
 * Hot-reload EA safety config. Zero / undefined values mean "keep current"
 * per engine convention — the EA ignores them. Only `targetInstanceId` is
 * required when scoping to one EA; omit for fleet-wide push.
 */
export interface UpdateEAConfigRequest {
  targetInstanceId?: string | null;
  maxPosPerSymbol?: number;
  maxLotPerOrder?: number;
  maxSpreadPoints?: number;
  maxConsecLosses?: number;
  consecLossPauseMin?: number;
  maxDailyLossPerSymbolPct?: number;
  maxOpenPositions?: number;
  maxDailyLossPct?: number;
  maxOrdersPerMin?: number;
}

export interface RefreshSymbolSpecsRequest {
  tradingAccountId: number;
}

export interface StrategyTemplateDto {
  id: number;
  name: string | null;
  description: string | null;
  strategyType: StrategyType;
  parametersJson: string | null;
  riskProfileId: number | null;
  riskOverridesJson: string | null;
  sizingConfigJson: string | null;
  sessionFilterJson: string | null;
  regimeGateJson: string | null;
  multiTimeframeGateJson: string | null;
  appliedCount: number;
  createdAt: string;
}

export interface CreateStrategyTemplateRequest {
  name: string;
  description?: string | null;
  strategyType: string;
  parametersJson?: string;
  riskProfileId?: number | null;
  riskOverridesJson?: string | null;
  sizingConfigJson?: string | null;
  sessionFilterJson?: string | null;
  regimeGateJson?: string | null;
  multiTimeframeGateJson?: string | null;
}

export interface ApplyStrategyTemplateRequest {
  templateId: number;
  symbols: string[];
  timeframe: string;
  namePrefix?: string | null;
}

export interface ApplyStrategyTemplateResult {
  createdCount: number;
  skippedCount: number;
  createdStrategyIds: number[];
  skippedReasons: string[];
}

export interface UpdateStrategyRequest {
  name?: string | null;
  description?: string | null;
  strategyType?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  parametersJson?: string | null;
  riskProfileId?: number | null;
  /** Optional free-text reason annotating the auto-captured pre-edit snapshot. */
  changeReason?: string | null;
}

export interface StrategyVersionDto {
  id: number;
  strategyId: number;
  versionNumber: number;
  name: string | null;
  description: string | null;
  parametersJson: string | null;
  riskProfileId: number | null;
  riskOverridesJson: string | null;
  sizingConfigJson: string | null;
  sessionFilterJson: string | null;
  regimeGateJson: string | null;
  multiTimeframeGateJson: string | null;
  capturedAt: string;
  changeReason: string | null;
}

export interface StrategyLineageNodeDto {
  id: number;
  name: string | null;
  symbol: string | null;
  timeframe: string;
  strategyType: string;
  status: string;
  generation: number;
  generationSource: string | null;
  createdAt: string;
  /** Negative = ancestor, 0 = focused strategy, positive = descendant. */
  depthOffset: number;
  parentInTree: number | null;
}

export interface StrategyLineageDto {
  focusStrategyId: number;
  nodes: StrategyLineageNodeDto[];
}

export type BulkStrategyAction = 'Activate' | 'Pause' | 'SetRiskProfile' | 'ClearRiskProfile';

export interface BulkUpdateStrategiesRequest {
  strategyIds: number[];
  action: BulkStrategyAction;
  riskProfileId?: number | null;
}

export interface BulkUpdateStrategiesResult {
  updatedCount: number;
  skippedCount: number;
  updatedIds: number[];
  skippedReasons: string[];
}

export interface BacktestPreviewSnapshotDto {
  id: number;
  /** Trading account id of the operator who saved the snapshot. Null for legacy rows. */
  capturedByUserId: number | null;
  label: string | null;
  /** Free-text notes editable post-save. */
  notes: string | null;
  symbol: string | null;
  timeframe: string | null;
  strategyType: string | null;
  lookbackDays: number;
  initialBalance: number;
  parametersJson: string | null;
  riskProfileId: number | null;
  riskOverridesJson: string | null;
  sizingConfigJson: string | null;
  sessionFilterJson: string | null;
  regimeGateJson: string | null;
  multiTimeframeGateJson: string | null;
  candlesAnalyzed: number;
  fromUtc: string;
  toUtc: string;
  finalBalance: number;
  totalReturn: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  expectancy: number;
  exposurePct: number;
  equityCurveJson: string | null;
  capturedAt: string;
}

export interface SaveBacktestPreviewSnapshotRequest {
  label?: string | null;
  symbol: string;
  timeframe: string;
  strategyType: string;
  lookbackDays: number;
  initialBalance: number;
  parametersJson?: string | null;
  riskProfileId?: number | null;
  riskOverridesJson?: string | null;
  sizingConfigJson?: string | null;
  sessionFilterJson?: string | null;
  regimeGateJson?: string | null;
  multiTimeframeGateJson?: string | null;
  candlesAnalyzed: number;
  fromUtc: string;
  toUtc: string;
  finalBalance: number;
  totalReturn: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  expectancy: number;
  exposurePct: number;
  equityCurveJson?: string | null;
}

export interface RejectTradeSignalRequest {
  id?: number;
  reason?: string | null;
}

/**
 * POST /trade-signal — operator-driven manual signal creation. Mirrors the
 * subset of `CreateTradeSignalCommand` an operator would actually fill in;
 * the engine treats omitted ML fields as "no model scored this" (the signal
 * still flows through the standard pending-approve-execute pipeline).
 */
export interface CreateTradeSignalRequest {
  strategyId: number;
  symbol: string;
  direction: 'Buy' | 'Sell';
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  suggestedLotSize: number;
  /** Operator-assigned confidence in [0, 1]. */
  confidence: number;
  /** UTC ISO; signal is auto-expired by the engine after this time. */
  expiresAt: string;
}

export interface CreateTradingAccountRequest {
  brokerId: number;
  accountId?: string;
  accountName?: string;
  currency?: string;
  isPaper?: boolean;
}

export interface UpdateTradingAccountRequest {
  accountName?: string | null;
  currency?: string | null;
  isPaper?: boolean | null;
}

export interface SyncAccountBalanceRequest {
  id: number;
  balance: number;
  equity: number;
  marginUsed: number;
  marginAvailable: number;
}

export interface CreateRiskProfileRequest {
  name?: string;
  maxLotSizePerTrade: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  maxOpenPositions: number;
  maxDailyTrades: number;
  maxRiskPerTradePct: number;
  maxSymbolExposurePct: number;
  isDefault?: boolean;
  drawdownRecoveryThresholdPct: number;
  recoveryLotSizeMultiplier: number;
  recoveryExitThresholdPct: number;
  requireStopLoss?: boolean;
  requireTakeProfit?: boolean;
  minStopLossDistancePips?: number;
  minTakeProfitDistancePips?: number;
  minRiskRewardRatio?: number;
}

export interface UpdateRiskProfileRequest {
  name?: string;
  maxLotSizePerTrade: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  maxOpenPositions: number;
  maxDailyTrades: number;
  maxRiskPerTradePct: number;
  maxSymbolExposurePct: number;
  isDefault?: boolean;
  drawdownRecoveryThresholdPct: number;
  recoveryLotSizeMultiplier: number;
  recoveryExitThresholdPct: number;
  requireStopLoss: boolean;
  requireTakeProfit: boolean;
  minStopLossDistancePips: number;
  minTakeProfitDistancePips: number;
  minRiskRewardRatio: number;
}

export interface CreateCurrencyPairRequest {
  symbol?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  decimalPlaces: number;
  contractSize: number;
  minLotSize: number;
  maxLotSize: number;
  lotStep: number;
}

export interface UpdateCurrencyPairRequest {
  symbol?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  decimalPlaces: number;
  contractSize: number;
  minLotSize: number;
  maxLotSize: number;
  lotStep: number;
  isActive?: boolean;
}

export interface CreateAlertRequest {
  alertType: AlertType;
  symbol?: string | null;
  conditionJson: string;
  severity?: AlertSeverity;
  deduplicationKey?: string | null;
  cooldownSeconds?: number;
  isActive?: boolean;
}

export interface UpdateAlertRequest {
  alertType: AlertType;
  symbol?: string | null;
  conditionJson: string;
  severity: AlertSeverity;
  deduplicationKey?: string | null;
  cooldownSeconds: number;
  isActive: boolean;
}

export interface TestAlertChannelRequest {
  channel: AlertChannel;
  message?: string | null;
}

export interface TriggerMLTrainingRequest {
  symbol?: string;
  timeframe?: string;
  fromDate: string;
  toDate: string;
  triggerType?: string;
  learnerArchitecture?: number;
}

export interface TriggerHyperparamSearchRequest {
  symbol?: string;
  timeframe?: string;
  trainingDays: number;
  searchCandidates: number;
  useGPSearch?: boolean;
  regimeScope?: string | null;
}

export interface StartShadowEvaluationRequest {
  challengerModelId: number;
  championModelId: number;
  symbol?: string;
  timeframe?: string;
  requiredTrades: number;
}

export interface CreateBacktestRequest {
  strategyId: number;
  symbol?: string;
  timeframe?: string;
  fromDate: string;
  toDate: string;
  initialBalance: number;
}

export interface CreateWalkForwardRequest {
  strategyId: number;
  symbol?: string;
  timeframe?: string;
  fromDate: string;
  toDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  initialBalance: number;
}

export interface UpsertConfigRequest {
  key?: string;
  value?: string;
  description?: string | null;
  dataType?: string;
  isHotReloadable?: boolean;
}

export interface CreateEconomicEventRequest {
  title?: string;
  currency?: string;
  impact?: string;
  scheduledAt: string;
  source?: string;
  forecast?: string | null;
  previous?: string | null;
}

export interface GenerateTokenRequest {
  userId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  businessId?: number | null;
}

export interface AssignRiskProfileRequest {
  strategyId: number;
  riskProfileId?: number | null;
}

export interface SetPaperTradingModeRequest {
  isPaperMode: boolean;
  reason?: string | null;
}

export interface RecordDrawdownSnapshotRequest {
  currentEquity: number;
  peakEquity: number;
}

export interface RecordSentimentRequest {
  symbol?: string;
  source?: string;
  sentimentScore: number;
  bullishPct: number;
  bearishPct: number;
  neutralPct: number;
}

export interface IngestCOTReportRequest {
  symbol?: string;
  reportDate: string;
  commercialLong: number;
  commercialShort: number;
  nonCommercialLong: number;
  nonCommercialShort: number;
  totalOpenInterest: number;
}

export interface RecordExecutionQualityRequest {
  orderId: number;
  strategyId?: number | null;
  symbol?: string;
  session?: string;
  requestedPrice: number;
  filledPrice: number;
  slippagePips: number;
  submitToFillMs: number;
  wasPartialFill: boolean;
  fillRate: number;
}

export interface LogDecisionRequest {
  entityType?: string;
  entityId: number;
  decisionType?: string;
  outcome?: string;
  reason?: string;
  contextJson?: string;
  source?: string;
}

export interface RecordPredictionOutcomeRequest {
  tradeSignalId: number;
  actualDirection?: string;
  actualMagnitudePips: number;
  wasProfitable: boolean;
}

export interface RollbackMLModelRequest {
  symbol?: string;
  timeframe?: string;
}

export interface ScalePositionRequest {
  positionId: number;
  scaleType?: string;
  lots: number;
  price: number;
}

export interface UpdateTrailingStopRequest {
  positionId: number;
  trailingStopType?: string;
  trailingStopValue: number;
}

export interface TriggerOptimizationRequest {
  strategyId: number;
  triggerType?: string;
}

// ============================================================
// CompositeML Operator Console (v2 Phase 1)
// ============================================================

/**
 * One currently-Active CompositeML policy snapshot. One row per
 * (Symbol, Timeframe, IsColdStart) partition tier. `policyKnobDeltaJson`
 * is opaque on the UI side — it carries the per-knob change vs the prior
 * activation as a JSON blob. UI renders it lazily on detail expand.
 */
export interface ActivePolicyDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe | null;
  isColdStart: boolean;
  trainer: string | null;
  activatedAtUtc: string | null;
  evaluationOutcome: string;
  policyKnobDeltaJson: string | null;
}

/**
 * Per-layer health snapshot over a lookback window. `enabledFraction` of
 * 1.0 = always on, 0.0 = always off, anything in between = toggled
 * mid-window (often a soak experiment). `distinctConfigHashes > 1`
 * means the layer's config changed during the window.
 */
export interface CompositeMLLayerHealthDto {
  layerName: string;
  enabledFraction: number;
  cycleCount: number;
  distinctConfigHashes: number;
  lastEnabledAtUtc: string | null;
  lastDisabledAtUtc: string | null;
}

/** Lifecycle stage of a CompositeML policy snapshot. */
export type CompositeMLPolicySnapshotStatus = 'Candidate' | 'Active' | 'Retired' | 'Rejected';

/**
 * One node in a policy snapshot's ancestry chain. Depth 0 = the snapshot
 * the caller asked about; subsequent depths walk backwards via the
 * `priorSnapshotId` recorded inside `policyKnobDeltaJson`.
 */
export interface PolicyLineageNodeDto {
  id: number;
  depth: number;
  status: CompositeMLPolicySnapshotStatus;
  trainer: string | null;
  evaluationOutcome: string;
  activatedAtUtc: string | null;
  retiredAtUtc: string | null;
  policyKnobDeltaJson: string | null;
}

/** Full lineage payload for a snapshot. Chain is depth-ascending. */
export interface PolicyLineageDto {
  rootId: number;
  chainLength: number;
  truncatedByDepth: boolean;
  chain: PolicyLineageNodeDto[];
}

/**
 * Per-knob diff entry. `deltaFraction` is `(to - from) / |from|` — null
 * when from = 0 (divide-by-zero), either value is null/non-finite, or
 * the knob is absent from one of the snapshots (legacy schema).
 */
export interface PolicySnapshotKnobDiffDto {
  name: string;
  fromValue: number | null;
  toValue: number | null;
  deltaFraction: number | null;
}

/** Full diff payload between two snapshots. Knobs ordered by schema. */
export interface PolicySnapshotDiffDto {
  fromId: number;
  toId: number;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  knobs: PolicySnapshotKnobDiffDto[];
}

/**
 * Active layer-skill snapshot driving the auto-arbitration weight applied at
 * slate-scoring time. Three-tier partitioned: a single (layer, pair) lookup
 * can yield up to 3 rows — per-pair, per-symbol, global — with caller
 * resolving most-specific-first. `autoDisabledUntilUtc` non-null = auto-
 * arbitration has temporarily suppressed this layer until that timestamp.
 */
export interface LayerSkillSnapshotDto {
  id: number;
  layerId: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  evaluatedAtUtc: string;
  observationsEnabled: number;
  observationsAblated: number;
  meanRewardEnabled: number;
  meanRewardAblated: number;
  skillEstimate: number;
  skillStandardError: number;
  zStatistic: number | null;
  autoDisabledUntilUtc: string | null;
  rewardVarianceEnabled: number | null;
  rewardVarianceAblated: number | null;
}

/** Same partitioning as LayerSkillSnapshotDto but for trainer arbitration. */
export interface TrainerSkillSnapshotDto {
  id: number;
  trainerId: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  evaluatedAtUtc: string;
  observationsActive: number;
  observationsAlternate: number;
  meanRewardActive: number;
  meanRewardAlternate: number;
  skillEstimate: number;
  skillStandardError: number;
  zStatistic: number | null;
  autoDisabledUntilUtc: string | null;
  rewardVarianceActive: number | null;
  rewardVarianceAlternate: number | null;
  primaryStratumKey: string | null;
}

/** Operator action set for skill overrides. */
export type SkillOverrideAction = 'enabled' | 'disabled' | 'clear';

export interface SetLayerSkillManualOverrideRequest {
  layerId: string;
  action: SkillOverrideAction;
  symbol?: string | null;
  timeframe?: Timeframe | null;
}

export interface SetTrainerSkillManualOverrideRequest {
  trainerId: string;
  action: SkillOverrideAction;
  symbol?: string | null;
  timeframe?: Timeframe | null;
}

/**
 * One row in the catalogue-drift summary. `isDropAlert` is engine-computed
 * (relativeDelta ≤ −threshold AND priorObservedCount ≥ minPriorCount); the
 * UI just renders it. `relativeDelta` is null when prior is absent or zero.
 */
export interface CatalogueDriftSummaryRowDto {
  layerKey: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  latestObservedCount: number;
  latestThreshold: number;
  latestIsWarm: boolean;
  latestEvaluatedAtUtc: string;
  priorObservedCount: number | null;
  priorEvaluatedAtUtc: string | null;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  isDropAlert: boolean;
}

export interface CatalogueDriftSummaryDto {
  compareWindowDays: number;
  queriedAtUtc: string;
  rows: CatalogueDriftSummaryRowDto[];
}

/** One time-series sample of a catalogue layer-key + scope. */
export interface CatalogueDriftHistoryPointDto {
  evaluatedAtUtc: string;
  observedCount: number;
  threshold: number;
  isWarm: boolean;
}

export interface CatalogueDriftHistoryDto {
  layerKey: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  lookbackDays: number;
  points: CatalogueDriftHistoryPointDto[];
}

/**
 * One catalogue entry's gate-cutover state. `returnLedgerCount = true` means
 * the gate has been cut over to use the evidence ledger as the source of
 * truth; `false` means it's still on the legacy hand-rolled idiom.
 */
export interface GateCutoverStatusRowDto {
  layerKey: string;
  description: string;
  coveredKnob: string;
  returnLedgerCount: boolean;
  lastUpdatedAtUtc: string | null;
}

export interface GateCutoverStatusDto {
  rows: GateCutoverStatusRowDto[];
}

export interface SetGateCutoverRequest {
  layerKey: string;
  returnLedgerCount: boolean;
}

/**
 * One audit finding from the CompositeML options-health diagnostic.
 * Severity is engine-defined ("Information" or "Warning"); checkName is the
 * snake_case identifier matching the log emission tag; message is operator-
 * readable with the offending knob values inline.
 */
export interface CompositeMLOptionsDiagnosticDto {
  severity: 'Information' | 'Warning';
  checkName: string;
  message: string;
}

/**
 * One row of the cold-start diagnostic dashboard. For scalar floors,
 * `groupingDetail` is either null or an upstream-missing hint string
 * (e.g. "(no active Champion MLModel for this scope)"). For grouped
 * floors, it carries the per-group counts (e.g. "Blend=12,Ucb1=4").
 * `outcomeNetPnL` / `outcomeRowCount` / `isOutcomeWarm` are non-null
 * only for outcome-aware catalogue entries — they let ops spot pairs
 * that are count-warm but outcome-cold (≥N observations but NetPnL ≤ 0).
 */
export interface ColdStartFloorRowDto {
  layerKey: string;
  description: string;
  threshold: number;
  observed: number;
  isWarm: boolean;
  observationsNeeded: number;
  groupingDetail: string | null;
  outcomeNetPnL: number | null;
  outcomeRowCount: number | null;
  isOutcomeWarm: boolean | null;
}

export interface ColdStartReportDto {
  symbol: string | null;
  timeframe: Timeframe | null;
  asOfUtc: string;
  floors: ColdStartFloorRowDto[];
}

/**
 * Donor-warm-start forensic row. For each Active CompositeML pair
 * (target), reports the best donor the canonical PolicyDonorSelector
 * would pick. `donorSymbol`/`donorTimeframe`/`donorScore` are null when
 * no candidate scored above `minScoreFloor`. `scoreBucket` is the
 * coarse bucket matching the engine's `donor_warm_start.decisions`
 * metric tag (e.g. "exact_match" / "high" / "medium" / "low" / "none").
 */
export interface CompositeMLDonorSelectionDto {
  targetSymbol: string;
  targetTimeframe: Timeframe;
  donorSymbol: string | null;
  donorTimeframe: Timeframe | null;
  donorScore: number | null;
  scoreBucket: string;
  minScoreFloor: number;
}
