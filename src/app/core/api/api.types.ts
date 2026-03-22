// ============================================================
// Response Wrappers
// ============================================================

export interface ResponseData<T> {
  data: T | null;
  status: boolean;
  message: string | null;
  responseCode: string | null;
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
}

// ============================================================
// Query Filter Types
// ============================================================

export interface OrderQueryFilter { search?: string; status?: string; orderType?: string; }
export interface PositionQueryFilter { symbol?: string; status?: string; isPaper?: boolean; }
export interface StrategyQueryFilter { search?: string; status?: string; symbol?: string; }
export interface TradeSignalQueryFilter { search?: string; status?: string; direction?: string; strategyId?: number; from?: string; to?: string; }
export interface TradingAccountQueryFilter { brokerId?: number; isPaper?: boolean; }
export interface BrokerQueryFilter { brokerType?: string; }
export interface RiskProfileQueryFilter { search?: string; }
export interface CurrencyPairQueryFilter { search?: string; isActive?: boolean; }
export interface AlertQueryFilter { symbol?: string; alertType?: string; isActive?: boolean; }
export interface CandleQueryFilter { symbol?: string; timeframe?: string; from?: string; to?: string; }
export interface MLModelQueryFilter { symbol?: string; timeframe?: string; isActive?: boolean; status?: string; }
export interface MLTrainingRunQueryFilter { symbol?: string; timeframe?: string; status?: string; }
export interface MLShadowEvaluationQueryFilter { symbol?: string; status?: string; }
export interface BacktestRunQueryFilter { strategyId?: number; status?: string; }
export interface WalkForwardRunQueryFilter { strategyId?: number; status?: string; }
export interface StrategyAllocationQueryFilter { strategyId?: number; }
export interface ExecutionQualityLogQueryFilter { symbol?: string; session?: string; strategyId?: number; from?: string; to?: string; }
export interface DecisionLogQueryFilter { entityType?: string; entityId?: number; decisionType?: string; outcome?: string; from?: string; to?: string; }
export interface COTReportQueryFilter { symbol?: string; }
export interface RegimeSnapshotQueryFilter { symbol?: string; timeframe?: string; regime?: string; }
export interface OptimizationRunQueryFilter { strategyId?: number; status?: string; }
export interface EconomicEventQueryFilter { currency?: string; impact?: string; from?: string; to?: string; }

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

export type TradeSignalStatus =
  | 'Pending'
  | 'Approved'
  | 'Executed'
  | 'Rejected'
  | 'Expired';

export type StrategyType =
  | 'MovingAverageCrossover'
  | 'RSIReversion'
  | 'BreakoutScalper'
  | 'Custom'
  | 'BollingerBandReversion'
  | 'MACDDivergence'
  | 'SessionBreakout'
  | 'MomentumTrend';

export type StrategyStatus = 'Active' | 'Paused' | 'Backtesting' | 'Stopped';

export type BrokerType = 'Oanda' | 'IB' | 'Paper' | 'Fxcm';

export type BrokerEnvironment = 'Live' | 'Practice';

export type BrokerStatus = 'Connected' | 'Disconnected' | 'Error';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1';

export type MLModelStatus = 'Training' | 'Active' | 'Superseded' | 'Failed';

export type RunStatus = 'Queued' | 'Running' | 'Completed' | 'Failed';

export type TriggerType = 'Scheduled' | 'Manual' | 'AutoDegrading';

export type TradingSession =
  | 'London'
  | 'NewYork'
  | 'Asian'
  | 'LondonNYOverlap';

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
  | 'DataQualityIssue';

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

export type ScaleOrderStatus =
  | 'Pending'
  | 'Triggered'
  | 'Filled'
  | 'Cancelled';

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

export interface StrategyDto {
  id: number;
  name: string | null;
  description: string | null;
  strategyType: StrategyType;
  symbol: string | null;
  timeframe: Timeframe;
  parametersJson: string | null;
  status: StrategyStatus;
  riskProfileId: number | null;
  createdAt: string;
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
}

export interface TradingAccountDto {
  id: number;
  brokerId: number;
  accountId: string | null;
  accountName: string | null;
  currency: string | null;
  balance: number;
  equity: number;
  marginUsed: number;
  marginAvailable: number;
  isActive: boolean;
  isPaper: boolean;
  lastSyncedAt: string;
}

export interface BrokerDto {
  id: number;
  name: string | null;
  brokerType: BrokerType;
  environment: BrokerEnvironment;
  baseUrl: string | null;
  isActive: boolean;
  isPaper: boolean;
  status: BrokerStatus;
  statusMessage: string | null;
  createdAt: string;
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
  channel: AlertChannel;
  destination: string | null;
  conditionJson: string | null;
  isActive: boolean;
  lastTriggeredAt: string | null;
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

export interface MLModelDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe;
  modelVersion: string | null;
  filePath: string | null;
  status: MLModelStatus;
  isActive: boolean;
  directionAccuracy: number | null;
  magnitudeRMSE: number | null;
  trainingSamples: number;
  trainedAt: string;
  activatedAt: string | null;
}

export interface MLTrainingRunDto {
  id: number;
  symbol: string | null;
  timeframe: Timeframe;
  triggerType: TriggerType;
  status: RunStatus;
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
}

export interface UpdateStrategyRequest {
  name?: string | null;
  description?: string | null;
  strategyType?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  parametersJson?: string | null;
  riskProfileId?: number | null;
}

export interface CreateBrokerRequest {
  name?: string;
  brokerType?: string;
  environment?: string;
  baseUrl?: string;
  apiKey?: string | null;
  apiSecret?: string | null;
  isPaper?: boolean;
}

export interface UpdateBrokerRequest {
  name?: string | null;
  brokerType?: string | null;
  environment?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  isPaper?: boolean | null;
}

export interface UpdateBrokerStatusRequest {
  id: number;
  status?: string;
  statusMessage?: string | null;
}

export interface SwitchBrokerRequest {
  brokerName?: string;
}

export interface RejectTradeSignalRequest {
  id?: number;
  reason?: string | null;
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
  alertType?: string;
  symbol?: string;
  channel?: string;
  destination?: string;
  conditionJson?: string;
}

export interface UpdateAlertRequest {
  alertType?: string | null;
  symbol?: string | null;
  channel?: string | null;
  destination?: string | null;
  conditionJson?: string | null;
  isActive?: boolean | null;
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
