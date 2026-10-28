/**
 * Wire shapes of the engine's prop-firm module (engine `docs/api/prop-module.md`, route `prop/*`).
 * Enums arrive as their names (the engine serialises them as strings).
 */

export type PropPhaseKind = 'Evaluation' | 'Verification' | 'Funded';
export type PropEnrollmentState = 'Active' | 'Passed' | 'Failed' | 'Funded' | 'Withdrawn';
export type PropRuleKind =
  | 'ProfitTarget'
  | 'MaxDailyLoss'
  | 'MaxOverallDrawdown'
  | 'MinTradingDays'
  | 'MaxPositionLots'
  | 'MaxTotalOpenLots'
  | 'NewsTrading'
  | 'WeekendHolding'
  | 'Consistency'
  | 'TimeLimit';
export type PropBreachSeverity = 'Breach' | 'Warning';
export type PropPayoutStatus = 'Draft' | 'Approved' | 'Rejected';
export type PropDailyLossReference =
  | 'StartOfDayBalance'
  | 'StartOfDayEquity'
  | 'HigherOfBalanceAndEquity';
export type PropDailyLossAmountBase = 'InitialBalance' | 'DayReference';
export type PropDrawdownMode = 'Static' | 'Trailing';
export type PropTrailingBasis = 'Equity' | 'Balance';
export type PropRuleAction = 'Fail' | 'Warn';
export type DayOfWeekName =
  | 'Sunday'
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday';

export interface PropWeekendRules {
  startDay: DayOfWeekName;
  startTime: string;
  endDay: DayOfWeekName;
  endTime: string;
}

export interface PropPhaseRules {
  name: string;
  kind: PropPhaseKind;
  profitTargetPct: number | null;
  profitTargetRequiresFlat: boolean;
  maxDailyLossPct: number | null;
  dailyLossReference: PropDailyLossReference;
  dailyLossAmountOf: PropDailyLossAmountBase;
  maxOverallDrawdownPct: number | null;
  drawdownMode: PropDrawdownMode;
  trailingBasis: PropTrailingBasis;
  trailingLocksAtInitialBalance: boolean;
  minTradingDays: number | null;
  maxLotsPerPosition: number | null;
  maxTotalOpenLots: number | null;
  lotsAction: PropRuleAction;
  newsTradingAllowed: boolean;
  newsWindowMinutes: number;
  newsAction: PropRuleAction;
  weekendHoldingAllowed: boolean;
  weekend: PropWeekendRules;
  weekendAction: PropRuleAction;
  consistencyMaxBestDayPct: number | null;
  timeLimitDays: number | null;
}

export interface PropProgramRules {
  phases: PropPhaseRules[];
  tradingDay: { resetTime: string; timeZone: string };
  profitSplit: { traderSharePct: number };
  haltOnBreach: boolean;
  haltOnPass: boolean;
}

export interface PropModuleStatus {
  available: boolean;
  plan: string | null;
  message: string | null;
}

export interface PropProgramVersion {
  id: number;
  version: number;
  changeNote: string | null;
  createdAtUtc: string;
  createdBy: string;
}

export interface PropProgram {
  id: number;
  name: string;
  description: string | null;
  currency: string;
  status: 'Active' | 'Archived';
  currentVersion: number;
  currentVersionId: number;
  rules: PropProgramRules;
  runningEnrollments: number;
  passedEnrollments: number;
  failedEnrollments: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  versions: PropProgramVersion[];
}

export interface SavePropProgramBody {
  name: string;
  description: string | null;
  currency?: string;
  rules: PropProgramRules;
  changeNote?: string | null;
}

export interface PropTrader {
  id: number;
  displayName: string;
  email: string | null;
  externalRef: string | null;
  adminUserId: number | null;
  isActive: boolean;
  runningEnrollments: number;
  totalEnrollments: number;
  createdAtUtc: string;
}

export interface SavePropTraderBody {
  displayName: string;
  email: string | null;
  externalRef: string | null;
  adminUserId: number | null;
  isActive: boolean;
}

export interface PropEnrollment {
  id: number;
  tradingAccountId: number;
  accountLabel: string;
  traderId: number;
  traderName: string;
  programId: number;
  programName: string;
  programVersion: number;
  phaseIndex: number;
  phaseName: string;
  phaseKind: PropPhaseKind;
  state: PropEnrollmentState;
  startedAtUtc: string;
  endedAtUtc: string | null;
  initialBalance: number;
  lastBalance: number;
  lastEquity: number;
  profitPct: number;
  tradingDays: number;
  failedRule: PropRuleKind | null;
  failedValue: number | null;
  failedLimit: number | null;
  failedAtUtc: string | null;
  failedDetail: string | null;
  passedAtUtc: string | null;
  haltRequired: boolean;
  haltAppliedAtUtc: string | null;
  haltLastError: string | null;
  lastEvaluatedAtUtc: string | null;
  lastDataAtUtc: string | null;
  previousEnrollmentId: number | null;
  canAdvance: boolean;
  note: string | null;
}

export interface EnrolBody {
  tradingAccountId: number;
  traderId: number;
  programId: number;
  phaseIndex: number;
  initialBalance: number | null;
  note: string | null;
}

export interface PropBreach {
  id: number;
  enrollmentId: number;
  tradingAccountId: number;
  accountLabel: string;
  traderId: number;
  traderName: string;
  rule: PropRuleKind;
  severity: PropBreachSeverity;
  value: number;
  limit: number;
  occurredAtUtc: string;
  detail: string;
}

export interface PropRuleMetrics {
  initialBalance: number;
  balance: number;
  equity: number;
  profitPct: number;
  profitTargetPct: number | null;
  profitTargetBalance: number | null;
  profitTargetMet: boolean | null;
  dailyLossReference: number | null;
  dailyLossLimit: number | null;
  dailyLossFloor: number | null;
  dailyLossUsed: number | null;
  dailyLossRemaining: number | null;
  highWaterMark: number;
  drawdownLimit: number | null;
  drawdownFloor: number | null;
  drawdownRemaining: number | null;
  tradingDays: number;
  minTradingDays: number | null;
  totalProfit: number;
  bestDayProfit: number | null;
  bestDaySharePct: number | null;
  consistencyMaxBestDayPct: number | null;
  consistencyMet: boolean | null;
  timeLimitEndsAtUtc: string | null;
  currentDay: string | null;
  dayStartUtc: string | null;
}

export interface PropCurvePoint {
  atUtc: string;
  equity: number;
  balance: number;
  drawdownFloor: number | null;
  dailyLossFloor: number | null;
  profitTarget: number | null;
}

export interface PropDailyStat {
  day: string;
  dayStartUtc: string;
  startBalance: number;
  startEquity: number;
  endBalance: number;
  endEquity: number;
  minEquity: number;
  maxEquity: number;
  realizedPnl: number;
  positionsOpened: number;
  positionsClosed: number;
  traded: boolean;
  observed: boolean;
  dailyLossFloor: number | null;
}

export interface PropPayoutDeduction {
  label: string;
  amount: number;
}

export interface PropPayout {
  id: number;
  enrollmentId: number;
  tradingAccountId: number;
  accountLabel: string;
  traderId: number;
  traderName: string;
  programName: string;
  periodStartUtc: string;
  periodEndUtc: string;
  currency: string;
  grossProfit: number;
  positionsClosed: number;
  traderSharePct: number;
  traderShare: number;
  deductions: PropPayoutDeduction[];
  deductionsTotal: number;
  netPayout: number;
  firmShare: number;
  consistencyMet: boolean | null;
  status: PropPayoutStatus;
  preparedBy: string;
  preparedAtUtc: string;
  decidedBy: string | null;
  decidedAtUtc: string | null;
  decisionNote: string | null;
  note: string | null;
  noMoneyMovement: boolean;
}

export interface PreparePayoutBody {
  enrollmentId: number;
  periodStartUtc: string;
  periodEndUtc: string;
  deductions: PropPayoutDeduction[];
  note: string | null;
  preview: boolean;
}

export interface PropDashboard {
  enrollment: PropEnrollment;
  phase: PropPhaseRules;
  tradingDay: { resetTime: string; timeZone: string };
  metrics: PropRuleMetrics;
  dataFresh: boolean;
  curve: PropCurvePoint[];
  days: PropDailyStat[];
  events: PropBreach[];
  payouts: PropPayout[];
}

export interface PropLeaderboardRow {
  rank: number;
  enrollmentId: number;
  traderId: number;
  traderName: string;
  tradingAccountId: number;
  accountLabel: string;
  programName: string;
  phaseName: string;
  state: PropEnrollmentState;
  profitPct: number;
  drawdownUsedPct: number | null;
  tradingDays: number;
  profitTargetPct: number | null;
  startedAtUtc: string;
}

/** A trading account as the enrol form lists it (engine `trading-account/list`). */
export interface AccountOption {
  id: number;
  label: string;
  balance: number | null;
}

// ── Overview + account fit (engine `GET prop/overview`, `GET prop/account-fit`) ─────────────────────

export interface PropSetting {
  key: string;
  value: string;
  meaning: string;
}

export interface PropOverviewAccount {
  id: number;
  label: string;
  accountType: string;
  currency: string;
  balance: number;
  equity: number;
  lastSyncedAtUtc: string;
  /** Balance and equity are recent enough for the evaluator to judge equity rules on. */
  fresh: boolean;
  runningEnrollmentId: number | null;
  runningProgram: string | null;
}

/** The module at a glance. `source: 'lists'` = built in the console from the list endpoints (older engine). */
export interface PropOverview {
  source: 'engine' | 'lists';
  generatedAtUtc: string | null;
  evaluationEnabled: boolean | null;
  enforcementEnabled: boolean | null;
  evaluationIntervalSeconds: number | null;
  staleAccountSeconds: number | null;
  requireDistinctPayoutApprover: boolean | null;
  settings: PropSetting[];
  activePrograms: number;
  archivedPrograms: number;
  activeTraders: number;
  traders: number;
  linkedTraders: number;
  enrollmentsByState: Record<string, number>;
  breaches24h: number;
  warnings24h: number;
  breaches7d: number;
  breachesTotal: number | null;
  payoutsByStatus: Record<string, number>;
  approvedNetPayouts: number;
  lastEvaluatedAtUtc: string | null;
  payoutApprovalPolicy: boolean | null;
  equityReportsLastHour: number | null;
  highImpactEventsNext7d: number | null;
  accounts: PropOverviewAccount[];
}

export interface PropReplayDay {
  day: string;
  startEquity: number;
  minEquity: number;
  endEquity: number;
  reference: number;
  loss: number;
  lossPct: number;
  realizedPnl: number;
  positionsOpened: number;
  traded: boolean;
}

export type PropReplayOutcome = 'Passed' | 'Failed' | 'Running' | 'NoData';

export interface PropReplay {
  outcome: PropReplayOutcome;
  measuredFromUtc: string | null;
  measuredToUtc: string | null;
  points: number;
  initialBalance: number;
  endEquity: number;
  endBalance: number;
  decidedAtUtc: string | null;
  failedRule: PropRuleKind | null;
  failedValue: number | null;
  failedLimit: number | null;
  failedDetail: string | null;
  profitTargetReachedAtUtc: string | null;
  timeLimitEndsAtUtc: string | null;
  profitPct: number;
  profitTargetPct: number | null;
  worstDayLossPct: number;
  worstDay: string | null;
  dailyLossLimitPct: number | null;
  maxDrawdownFromInitialPct: number;
  maxDrawdownFromPeakPct: number;
  drawdownLimitPct: number | null;
  drawdownMode: PropDrawdownMode;
  tradingDays: number;
  minTradingDays: number | null;
  warnings: number;
  days: PropReplayDay[];
  curve: { atUtc: string; equity: number }[];
  notes: string[];
}

export interface PropAccountFit {
  tradingAccountId: number;
  accountLabel: string;
  accountType: string;
  currency: string;
  runningEnrollmentId: number | null;
  replay: PropReplay;
}

export interface PropAccountFitReport {
  generatedAtUtc: string;
  windowStartUtc: string;
  days: number;
  programId: number | null;
  rulesName: string;
  phaseIndex: number;
  phase: PropPhaseRules;
  tradingDay: { resetTime: string; timeZone: string };
  accounts: PropAccountFit[];
  methodology: string[];
}
