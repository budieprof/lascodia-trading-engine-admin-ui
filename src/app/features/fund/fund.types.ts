/**
 * Fund module DTOs (engine `docs/api/fund-module-api.md`, enterprise program fund-module). Plan feature
 * `fundModule`: without it every route answers 403 `-403-quota` (shown as an upgrade notice).
 */

export interface FundScopeAccount {
  id: number;
  accountId: string;
  accountName: string;
  broker: string;
  accountType: string;
  currency: string;
}

export interface FundScopeGroup {
  id: number;
  name: string;
  accounts: number;
}

export interface FundScope {
  accounts: FundScopeAccount[];
  groups: FundScopeGroup[];
  /** The caller may also read best-execution reports. */
  bestExecution: boolean;
}

// ── Performance ─────────────────────────────────────────────────────────────

export interface PerformanceDay {
  dayUtc: string;
  equity: number;
  flow: number;
  return: number | null;
  index: number;
  drawdown: number;
}

/** Where a statement flow comes from: the broker's own balance deal (reported by the EA), entered by hand, or inferred. */
export type FlowSource = 'broker' | 'recorded' | 'inferred';

export interface PerformanceFlow {
  dayUtc: string;
  tradingAccountId: number;
  amount: number;
  inferred: boolean;
  note: string | null;
  /** When the flow happened (UTC); null for inferred flows and portfolio joins (only the day is known). Engine 2026-10-29+. */
  atUtc?: string | null;
  /** Engine 2026-10-29+; older engines send only `inferred`. */
  source?: FlowSource;
}

export interface MonthReturn {
  year: number;
  month: number;
  return: number;
  days: number;
}

export interface YearReturn {
  year: number;
  return: number;
  days: number;
}

export interface PerformanceStatement {
  scope: string;
  tradingAccountId: number | null;
  accountGroupId: number | null;
  accounts: string[];
  currency: string;
  fromUtc: string;
  toUtc: string;
  generatedAtUtc: string;
  riskFreeRatePct: number;
  startEquity: number | null;
  endEquity: number | null;
  netFlows: number;
  timeWeightedReturn: number | null;
  annualisedReturn: number | null;
  annualisedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  maxDrawdownPeakUtc: string | null;
  maxDrawdownTroughUtc: string | null;
  maxDrawdownRecoveredUtc: string | null;
  currentDrawdown: number;
  bestDay: number | null;
  worstDay: number | null;
  positiveDayShare: number | null;
  returnDays: number;
  days: PerformanceDay[];
  months: MonthReturn[];
  years: YearReturn[];
  flows: PerformanceFlow[];
  methodology: string[];
  dataNotes: string[];
}

export type CashFlowKind = 'Deposit' | 'Withdrawal' | 'Fee' | 'Adjustment';

export interface CashFlow {
  id: number;
  tradingAccountId: number;
  occurredAtUtc: string;
  amount: number;
  kind: CashFlowKind | string;
  note: string | null;
  recordedBy: string;
  recordedAtUtc: string;
  /** The MT5 deal ticket when the EA reported this flow from the broker's deal history (null = entered by hand). */
  brokerDealTicket?: string | null;
}

export interface RecordCashFlowBody {
  occurredAtUtc: string;
  amount: number;
  kind: CashFlowKind;
  note: string | null;
}

// ── Best execution ──────────────────────────────────────────────────────────

export interface FillGroupStats {
  key: string;
  fills: number;
  lots: number;
  withArrivalBenchmark: number;
  meanSlippagePips: number | null;
  medianSlippagePips: number | null;
  p95AbsSlippagePips: number | null;
  priceImprovementShare: number | null;
  meanSlippageBps: number | null;
  meanVsRequestedPips: number | null;
  meanQuotedSpreadPips: number | null;
  meanEffectiveSpreadPips: number | null;
  meanLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  meanMarkoutPips: (number | null)[];
  favourableMarkoutShare: (number | null)[];
  markoutSamples: number[];
  commission: number;
}

export interface BestExecutionFill {
  orderId: number;
  tradingAccountId: number;
  account: string;
  broker: string;
  symbol: string;
  side: string;
  lots: number;
  arrivalUtc: string;
  filledAtUtc: string;
  fillPrice: number;
  arrivalMid: number | null;
  arrivalSource: string;
  requestedPrice: number | null;
  slippageVsArrivalPips: number | null;
  slippageVsArrivalBps: number | null;
  slippageVsRequestedPips: number | null;
  quotedSpreadPips: number | null;
  effectiveSpreadPips: number | null;
  latencyMs: number | null;
  markoutPips: (number | null)[];
  commission: number | null;
}

export interface BestExecutionReport {
  fromUtc: string;
  toUtc: string;
  tradingAccountId: number | null;
  symbol: string | null;
  generatedAtUtc: string;
  markoutHorizons: string[];
  overall: FillGroupStats;
  byBroker: FillGroupStats[];
  byAccount: FillGroupStats[];
  bySymbol: FillGroupStats[];
  fills: BestExecutionFill[];
  fillsMeasured: number;
  truncated: boolean;
  methodology: string[];
  dataNotes: string[];
}

// ── Compliance exports ──────────────────────────────────────────────────────

export type ComplianceSection = 'audit' | 'orders' | 'approvals';
export type ComplianceFormat = 'json' | 'csv';

export interface ComplianceExportRecord {
  id: number;
  fromUtc: string;
  toUtc: string;
  sections: string[];
  format: string;
  rowCounts: Record<string, number>;
  sha256: string;
  signature: string | null;
  signingKeyId: string | null;
  createdBy: string;
  createdAtUtc: string;
}

export interface ComplianceVerification {
  sha256: string;
  issued: boolean;
  signatureValid: boolean | null;
  record: ComplianceExportRecord | null;
  message: string;
}

/** A downloaded file plus what the engine said about it in its headers. */
export interface DownloadedFile {
  blob: Blob;
  fileName: string;
  sha256: string | null;
  signature: string | null;
  signingKeyId: string | null;
}

/** `GET fund/compliance-exports/preview` — what a download of the period would hold (nothing built or registered). */
export interface ComplianceExportPreview {
  fromUtc: string;
  toUtc: string;
  rowCounts: Record<string, number>;
  maxRowsPerSection: number;
  tooLarge: string[];
  auditByCategory: { key: string; count: number }[];
  ordersByStatus: { key: string; count: number }[];
  paperOrders: number;
  approvalsByStatus: { key: string; count: number }[];
  days: { dayUtc: string; audit: number; orders: number }[];
  signingConfigured: boolean;
  signingKeyId: string | null;
  exportsTotal: number;
  lastExportAtUtc: string | null;
}
