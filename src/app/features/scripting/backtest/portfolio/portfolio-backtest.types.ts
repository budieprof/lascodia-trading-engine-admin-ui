/**
 * Portfolio backtests (BT-I12 / BX-5, engine scripting API §8h, route `portfolio-backtest`): several script strategies,
 * each on its own symbol and timeframe, trading ONE account on one bar clock. Field names are the engine's camelCase
 * wire names; enums arrive as strings.
 */

export type PortfolioRunStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';

/** `POST portfolio-backtest` — one member. Exactly one of `strategyId` / `pineSource`. */
export interface PortfolioMemberRequest {
  strategyId?: number;
  pineSource?: string;
  name?: string;
  /** Default: the strategy's own (required for written source). */
  symbol?: string;
  /** M1, M5, M15, H1, H4, D1; default: the strategy's own (required for written source). */
  timeframe?: string;
  /** Input overrides keyed by input id, on top of the strategy's own inputs. */
  inputs?: Record<string, unknown>;
  /** The share of the account's equity the member's script sees as its own, % (0 < x ≤ 100; default 100). */
  equitySharePct?: number;
}

/** `POST portfolio-backtest` body. */
export interface QueuePortfolioBacktestRequest {
  name?: string;
  fromDate: string;
  toDate: string;
  initialBalance?: number;
  accountCurrency?: string;
  leverage?: number;
  barMagnifier?: boolean;
  tradingAccountId?: number;
  riskProfileId?: number;
  maxSameDirectionCurrencyLegs?: number;
  maxCorrelatedPositions?: number;
  members: PortfolioMemberRequest[];
}

/** A run in the list (`GET portfolio-backtest`). */
export interface PortfolioRunSummary {
  id: number;
  name: string;
  status: PortfolioRunStatus;
  fromDate: string;
  toDate: string;
  accountCurrency: string;
  initialBalance: number;
  leverage: number | null;
  memberCount: number;
  /** What a running run is doing now. */
  stage: string | null;
  errorMessage: string | null;
  failedMemberIndex: number | null;
  queuedBy: string | null;
  queuedAt: string;
  executionStartedAt: string | null;
  completedAt: string | null;
  cancelRequested: boolean;
  finalBalance: number | null;
  netProfit: number | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  totalTrades: number | null;
  refusedEntries: number | null;
  costModelKey: string | null;
}

/** The exposure rule the account applies (the live Tier-2 rule with the profile's limits), frozen at queue time. */
export interface PortfolioExposureRule {
  source: string;
  tradingAccountId?: number | null;
  riskProfileId?: number | null;
  riskProfileName?: string | null;
  maxSameDirectionCurrencyLegs: number;
  maxCorrelatedPositions: number;
  correlationThreshold: number;
  correlationGroups: string[][];
  symbolLegs: Record<string, { base: string; quote: string }>;
}

/** A member as it was queued. */
export interface PortfolioMemberView {
  index: number;
  strategyId: number | null;
  name: string;
  symbol: string;
  timeframe: string;
  equitySharePct: number;
  newsBlackoutExempt: boolean;
  standaloneCapital: number;
  inputOverrides: Record<string, unknown> | null;
  /** The source of a member written for the run (null for a saved strategy). */
  pineSource: string | null;
}

/** `GET portfolio-backtest/{id}`. */
export interface PortfolioRun extends PortfolioRunSummary {
  barMagnifier: boolean | null;
  exposure: PortfolioExposureRule | null;
  members: PortfolioMemberView[];
  result: PortfolioResult | null;
}

export type PortfolioRefusalKind = 'ExposureCap' | 'Margin' | 'NewsBlackout' | 'Other';

export interface PortfolioRefusal {
  memberIndex: number;
  member: string;
  symbol: string;
  kind: PortfolioRefusalKind;
  direction: 'Buy' | 'Sell' | null;
  lots: number | null;
  price: number | null;
  timeUtc: string;
  reason: string;
}

export interface PortfolioMarginCall {
  memberIndex: number;
  member: string;
  timeUtc: string;
  lots: number;
  price: number;
  reason: string;
}

/** A trade the account held (the single backtests' trade shape). */
export interface PortfolioTrade {
  direction: 'Buy' | 'Sell';
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  pnL: number;
  commission: number;
  swap: number;
  slippage: number;
  entryTime: string;
  exitTime: string;
  exitReason: string;
  initialStopLoss?: number | null;
  takeProfit?: number | null;
  riskedAmount?: number | null;
  rMultiple?: number | null;
  entryId?: string | null;
  exitId?: string | null;
}

/** The account's metrics — the single backtests' calculator over the account's equity. */
export interface PortfolioAccountMetrics {
  initialBalance: number;
  finalBalance: number;
  netProfit: number;
  totalReturn: number;
  maxDrawdownPct: number;
  maxDrawdown: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  cagrPct: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  expectancyR: number | null;
  medianR?: number | null;
  sqn?: number | null;
  exposurePct: number;
  totalCommission: number;
  totalSwap: number;
  totalSlippage: number;
  marginCalls: number;
  notes: string[];
}

export interface PortfolioCurvePoint {
  timeUtc: string;
  equity: number;
  balance: number;
  drawdownPct: number;
  marginUsed: number;
}

export interface PortfolioMemberResult {
  index: number;
  name: string;
  strategyId: number | null;
  symbol: string;
  timeframe: string;
  equitySharePct: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  commission: number;
  swap: number;
  executionCost: number;
  trades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  sumR: number;
  rTrades: number;
  expectancyR: number | null;
  drawdownContribution: number;
  drawdownSharePct: number | null;
  refusedEntries: Partial<Record<PortfolioRefusalKind, number>>;
  marginCalls: number;
  timeInMarketPct: number;
  costModel: string | null;
  notes: string[];
  inputs: Record<string, unknown> | null;
  tradeList: PortfolioTrade[];
}

export interface PortfolioCurrencyExposure {
  currency: string;
  net: number;
  long: number;
  short: number;
  notional: number;
}

export interface PortfolioExposurePoint {
  timeUtc: string;
  currencies: PortfolioCurrencyExposure[];
}

export interface PortfolioMarginDay {
  day: string;
  equity: number;
  maxMarginUsed: number;
  minFreeMargin: number;
  maxMarginUsePct: number;
}

export interface PortfolioStandaloneMember {
  index: number;
  name: string;
  initialBalance: number | null;
  netProfit: number | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  trades: number | null;
  winRate: number | null;
  expectancyR: number | null;
  sharpeRatio: number | null;
  failure: string | null;
}

export interface PortfolioComparison {
  currency: string;
  members: PortfolioStandaloneMember[];
  sumInitialBalance: number;
  sumNetProfit: number;
  sumTrades: number;
  portfolioNetProfit: number;
  portfolioTrades: number;
  curve: { timeUtc: string; portfolioProfit: number; standaloneProfit: number }[];
}

/** The findings of a completed run. */
export interface PortfolioResult {
  accountCurrency: string;
  initialBalance: number;
  finalBalance: number;
  fromUtc: string;
  toUtc: string;
  costModelKey: string | null;
  account: PortfolioAccountMetrics;
  curve: PortfolioCurvePoint[];
  members: PortfolioMemberResult[];
  maxDrawdown: { amount: number; pct: number; peakUtc: string | null; troughUtc: string | null };
  correlation: { members: number[]; matrix: (number | null)[][]; days: number };
  exposure: PortfolioExposurePoint[];
  margin: PortfolioMarginDay[];
  refusals: PortfolioRefusal[];
  marginCalls: PortfolioMarginCall[];
  comparison: PortfolioComparison;
  exposureRule: PortfolioExposureRule;
  notes: string[];
  elapsedMs: number;
}
