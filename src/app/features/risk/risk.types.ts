/**
 * Wire types of the engine's portfolio-risk API (`api/v1/lascodia-trading-engine/risk/*`, engine
 * `PortfolioRiskController`, gaps program risk vertical). Mapped here only — components never read raw JSON.
 */

export interface CurrencyExposureLeg {
  currency: string;
  net: number;
  gross: number;
}

export type SnapshotScope = 'Account' | 'Tenant';
export type SnapshotStatus = 'Computed' | 'NoPositions' | 'MissingHistory';

export interface PortfolioRiskSnapshot {
  id: number;
  tradingAccountId: number | null;
  scope: SnapshotScope;
  status: SnapshotStatus;
  currency: string;
  equity: number;
  balance: number;
  marginUsed: number;
  marginLevelPct: number | null;
  openPositionCount: number;
  grossExposure: number;
  netExposure: number;
  vaR95: number;
  vaR99: number;
  cVaR95: number;
  cVaR99: number;
  stressedVaR: number;
  monteCarloVaR95: number;
  monteCarloVaR99: number;
  monteCarloCVaR95: number;
  evtVaR95: number;
  evtVaR99: number;
  evtCVaR99: number;
  correlationConcentration: number;
  vaR95Pct: number | null;
  portfolioSigma1d: number | null;
  stopOutSigma1d: number | null;
  marginCallSigma1d: number | null;
  daysToStopOut: number | null;
  exposureByCurrency: CurrencyExposureLeg[];
  returnWindowDays: number;
  computedAtUtc: string;
}

export interface PortfolioRiskAccountRow {
  tradingAccountId: number;
  accountId: string;
  accountName: string;
  currency: string;
  isPaper: boolean;
  maxVaR95Pct: number | null;
  maxTotalDrawdownPct: number | null;
  latest: PortfolioRiskSnapshot | null;
  ageSeconds: number | null;
}

export type StressMode = 'Off' | 'Observe' | 'Enforce';

export interface PortfolioRiskOverview {
  asOfUtc: string;
  book: PortfolioRiskSnapshot | null;
  accounts: PortfolioRiskAccountRow[];
  stressMode: StressMode;
  maxScenarioLossPct: number;
  minStopOutSigma: number;
  marginAlertSigma: number;
  snapshotIntervalSeconds: number;
  snapshotsEnabled: boolean;
}

export interface PortfolioRiskPoint {
  computedAtUtc: string;
  status: SnapshotStatus;
  equity: number;
  vaR95: number;
  vaR99: number;
  cVaR95: number;
  cVaR99: number;
  stressedVaR: number;
  vaR95Pct: number | null;
  marginLevelPct: number | null;
  stopOutSigma1d: number | null;
  grossExposure: number;
  openPositionCount: number;
}

export interface PortfolioRiskSeries {
  tradingAccountId: number | null;
  scope: SnapshotScope;
  currency: string;
  fromUtc: string;
  toUtc: string;
  storedPoints: number;
  points: PortfolioRiskPoint[];
}

export interface SymbolMarginDistance {
  symbol: string;
  netNotional: number;
  adverseDirection: 'up' | 'down';
  pctMoveToStopOut: number | null;
  pctMoveToMarginCall: number | null;
  sigmaMoveToStopOut: number | null;
  dailySigmaPct: number | null;
}

export type MarginForecastStatus = 'Flat' | 'NoStopOutLevel' | 'Ok' | 'WithinAlertBuffer' | 'AtMarginCall' | 'AtStopOut';

export interface MarginForecast {
  status: MarginForecastStatus;
  currency: string;
  effectiveEquity: number;
  marginUsed: number;
  marginUsedSource: 'broker' | 'estimated';
  marginLevelPct: number | null;
  stopOutMode: 'Percent' | 'Money';
  stopOutLevel: number;
  marginCallLevel: number;
  equityAtStopOut: number | null;
  equityAtMarginCall: number | null;
  lossToStopOut: number | null;
  lossToMarginCall: number | null;
  sigma1d: number | null;
  sigma1h: number | null;
  stopOutSigma1d: number | null;
  stopOutSigma1h: number | null;
  marginCallSigma1d: number | null;
  marginCallSigma1h: number | null;
  stopOutProbability1h: number | null;
  stopOutProbability1d: number | null;
  daysToStopOut: number | null;
  adverseDriftSigmaPerDay: number;
  symbols: SymbolMarginDistance[];
  note: string | null;
}

export interface MarginForecastResponse {
  tradingAccountId: number;
  accountId: string;
  asOfUtc: string;
  openPositionCount: number;
  forecast: MarginForecast;
  unresolvedRates: string[];
}

export interface WhatIfRequest {
  tradingAccountId: number;
  symbol: string;
  direction: 'Buy' | 'Sell';
  lots: number;
  price?: number | null;
}

export interface ScenarioTradeImpact {
  scenarioId: number;
  name: string;
  preTradePnl: number;
  pnlPerLot: number;
  postTradePnl: number;
  postTradeLossPct: number;
  maxLots: number | null;
}

export interface StressPreTradeEvaluation {
  settings: { mode: StressMode; maxScenarioLossPct: number; minStopOutSigma: number; adverseDriftSigmaPerDay: number };
  trade: { symbol: string; isBuy: boolean; lots: number; price: number };
  equity: number;
  lossLimit: number;
  scenarios: ScenarioTradeImpact[];
  worstScenario: ScenarioTradeImpact | null;
  scenarioMaxLots: number | null;
  preTradeStopOutSigma: number | null;
  postTradeStopOutSigma: number | null;
  stopOutMaxLots: number | null;
  stopOutUnavailable: string | null;
  maxLots: number | null;
  wouldReject: boolean;
  wouldShrink: boolean;
  reason: string | null;
  elapsedMs: number;
}

export type StepVerdict = 'Pass' | 'WouldReject' | 'WouldShrink' | 'Reject' | 'Shrink';

export interface WhatIfResult {
  tradingAccountId: number;
  symbol: string;
  direction: 'Buy' | 'Sell';
  lots: number;
  price: number;
  currency: string;
  equity: number;
  preTradeVaR95: number;
  postTradeVaR95: number;
  marginalVaR95: number;
  maxVaR95Pct: number;
  wouldBreachVaRLimit: boolean;
  stress: StressPreTradeEvaluation;
  preTradeForecast: MarginForecast;
  postTradeForecast: MarginForecast;
  stepVerdict: StepVerdict;
}

export interface NettedCurrencyExposure {
  currency: string;
  positions: number;
  pendingOrders: number;
  signals: number;
  committed: number;
  withSignals: number;
  grossCommitted: number;
  signalBookNet: number;
}

export interface NettedExposure {
  asOfUtc: string;
  scope: SnapshotScope;
  tradingAccountId: number | null;
  currency: string;
  positionCount: number;
  pendingOrderCount: number;
  signalCount: number;
  signalBookEnabled: boolean;
  currencies: NettedCurrencyExposure[];
  unresolvedRates: string[];
}

export type ScenarioType = 'Historical' | 'Hypothetical' | 'ReverseStress';

export interface StressShockDefinition {
  dateFrom?: string | null;
  dateTo?: string | null;
  currencyShocks: { currency: string; pctChange: number }[];
  symbolShocks: { symbol: string; pctChange: number }[];
  assetClassShocks: { assetClass: string; pctChange: number }[];
  targetLossPct?: number | null;
  searchSymbols: string[];
}

export interface StressScenario {
  id: number;
  name: string;
  scenarioType: ScenarioType;
  shockDefinitionJson: string;
  definition: StressShockDefinition;
  isActive: boolean;
  description: string | null;
  source: string | null;
  code: string | null;
  isBuiltIn: boolean;
  ownership: 'Platform' | 'Organisation';
  problems: string[];
}

export interface StressScenarioWrite {
  name: string;
  scenarioType: ScenarioType;
  shockDefinitionJson: string;
  isActive: boolean;
  description: string | null;
  source: string | null;
}

export interface StressImpact {
  positionId: number;
  symbol: string;
  direction: string | null;
  lots: number;
  notional: number;
  movePct: number;
  source: string;
  pnlImpact: number;
}

export interface StressResult {
  id: number;
  stressTestScenarioId: number;
  scenarioName: string;
  scenarioType: string;
  tradingAccountId: number;
  accountId: string;
  currency: string;
  portfolioEquity: number;
  stressedPnl: number;
  stressedPnlPct: number;
  postStressEquity: number | null;
  postStressMarginLevelPct: number | null;
  wouldTriggerMarginCall: boolean;
  wouldTriggerStopOut: boolean;
  wouldBreachDrawdownLimit: boolean;
  minimumShockPct: number | null;
  trigger: string | null;
  executedAt: string;
  impacts: StressImpact[];
}

// ── Console operability ─────────────────────────────────────────────────────

export interface RiskSetting {
  key: string;
  label: string;
  group: string;
  description: string;
  kind: 'Bool' | 'Int' | 'Decimal' | 'Enum';
  allowedValues: string[];
  min: number | null;
  max: number | null;
  unit: string | null;
  defaultValue: string;
  platformValue: string | null;
  organisationValue: string | null;
  effectiveValue: string;
  effectiveSource: string;
  layered: boolean;
  tightenOnly: boolean;
  platformWritePermission: string;
  organisationWritePermission: string | null;
  dataType: string;
  lastChangedAtUtc: string | null;
  lastChangedBy: string | null;
  lastChangedLayer: string | null;
  lastOldValue: string | null;
  lastNewValue: string | null;
}

export interface StressDecision {
  id: number;
  tradeSignalId: number;
  outcome: 'WouldReject' | 'WouldShrink' | 'Rejected' | 'Shrunk' | string;
  reason: string;
  contextJson: string | null;
  createdAt: string;
}

export interface RiskJob {
  name: string;
  purpose: string;
  enabled: boolean;
  lastRunAtUtc: string | null;
  lastStatus: string | null;
  lastResult: string | null;
  nextRunAtUtc: string | null;
  lastErrorAtUtc: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  runNow: string;
  runNowPermission: string;
  operatorNote: string | null;
}

export interface Paged<T> {
  data: T[];
  pager?: { totalItemCount?: number; currentPage?: number; itemCountPerPage?: number };
}
