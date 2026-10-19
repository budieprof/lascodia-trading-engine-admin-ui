/**
 * Wire types for the recommendations page — `/trade-recommendation/{paged,summary,{id}/detail}`.
 * Mirrors `TradeRecommendationCards.cs` / `GetTradeRecommendationDetailQuery.cs` in the engine.
 */

/** Filter for the paged list and the summary. Sent nested under `filter` for `paged`. */
export interface TradeRecommendationCardFilter {
  /** A number (optionally `#`-prefixed) matches card / analysis / signal / plan id; text matches symbol, rationale, reason. */
  search?: string | null;
  statuses?: string[] | null;
  sources?: string[] | null;
  directions?: string[] | null;
  symbols?: string[] | null;
  timeframe?: string | null;
  fromUtc?: string | null;
  toUtc?: string | null;
  llmInvocationId?: number | null;
  hasSignal?: boolean | null;
}

/** One card, with the analysis, watch and outcome joined in. */
export interface TradeRecommendationCardDto {
  id: number;
  /** SpotAnalysis | ChatRecommend | PatientTrader | MonitorReview | StructureWatch */
  source: string;
  llmInvocationId: number | null;
  patientTraderPlanId: number | null;
  spotAnalysisFollowUpId: number | null;
  analysisMonitorId: number | null;
  symbol: string;
  timeframe: string;
  direction: 'Buy' | 'Sell' | string;
  orderType: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number | null;
  rationale: string | null;
  /** Proposed | Filed | Parked | Rejected | Expired | Withdrawn */
  status: string;
  statusReason: string | null;
  tradeSignalId: number | null;
  pendingSignalRecId: number | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  rewardRisk: number | null;
  analysisPurpose: string | null;
  analysisModel: string | null;
  siblingCount: number;
  conviction: string | null;
  planStatus: string | null;
  watchingMonitorId: number | null;
  monitorCount: number;
  latestMonitorStatus: string | null;
  ocoGroupId: string | null;
  signalStatus: string | null;
  signalRejectionReason: string | null;
  orderCount: number;
  positionCount: number;
  openPositionCount: number;
  realizedPnL: number | null;
  unrealizedPnL: number | null;
  /** Open | Won | Lost | Flat | Unfilled | SignalExpired | SignalRejected | Signal | Watching | <card status> */
  outcome: string;
}

export interface TradeRecommendationSummaryDto {
  total: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  byDirection: Record<string, number>;
  bySymbol: Record<string, number>;
  withSignal: number;
  withPosition: number;
  openPositions: number;
  closedPositions: number;
  wins: number;
  losses: number;
  realizedPnL: number;
  unrealizedPnL: number;
  watched: number;
  avgConfidence: number | null;
  avgRewardRisk: number | null;
  firstAtUtc: string | null;
  lastAtUtc: string | null;
}

export interface RecAnalysisDto {
  id: number;
  purpose: string;
  provider: string;
  model: string;
  resolvedModel: string | null;
  promptVersion: string | null;
  outcome: string;
  invokedAt: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
  costUsd: number;
  errorMessage: string | null;
  conversationTurns: number;
  followUpCalls: number;
  followUpCostUsd: number;
}

export interface RecChatTurnDto {
  id: number;
  role: string;
  content: string;
  contentTruncated: boolean;
  toolName: string | null;
  toolArgsJson: string | null;
  toolResultJson: string | null;
  actionStatus: string | null;
  followUpInvocationId: number | null;
  createdAtUtc: string;
}

export interface RecPlanDto {
  id: number;
  status: string;
  entryStyle: string;
  entryBasis: string;
  stopBasis: string;
  targetBasis: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  rewardRisk: number;
  stopAtrMultiple: number;
  atrAtPlan: number;
  thesis: string;
  invalidationNote: string | null;
  invalidationPrice: number | null;
  preMortem: string | null;
  conviction: string;
  confidence: number;
  rejectionCode: string | null;
  rejectionReason: string | null;
  ocoGroupId: string | null;
  observeOnly: boolean;
  entryMonitorId: number | null;
  tradeSignalId: number | null;
  viewId: number | null;
  createdAtUtc: string;
  expiresAtUtc: string;
  armedAtUtc: string | null;
  filledAtUtc: string | null;
  settledAtUtc: string | null;
  outcomeJson: string | null;
}

export interface RecMonitorEventDto {
  id: number;
  kind: string;
  occurredAtUtc: string;
  note: string | null;
  fired: boolean;
  evaluationPath: string | null;
  observedSpreadPips: number | null;
  resultLlmInvocationId: number | null;
  generatedSignalIds: string | null;
  statusAfter: string | null;
  actorUserId: string | null;
}

export interface RecMonitorDto {
  id: number;
  status: string;
  origin: string;
  createdBy: string | null;
  symbol: string;
  timeframe: string;
  intentText: string;
  evaluationMode: string;
  triggerSpecJson: string;
  actionSpecJson: string;
  invalidationSpecJson: string | null;
  confirmOn: string | null;
  confirmPendingSinceUtc: string | null;
  ocoGroupId: string | null;
  monitorGroupId: string | null;
  recurring: boolean;
  triggerCount: number;
  maxTriggers: number;
  dryRunActions: boolean;
  planTargetPrice: number | null;
  scriptSource: string | null;
  scriptLastReading: string | null;
  lastEvalNote: string | null;
  lastObservedPrice: number | null;
  outcomeJson: string | null;
  llmSpendUsd: number;
  anchorLlmInvocationId: number | null;
  createdAtUtc: string;
  expiresAtUtc: string;
  lastCheckedAtUtc: string | null;
  lastTriggeredAtUtc: string | null;
  evaluatedCount: number;
  events: RecMonitorEventDto[];
}

export interface RecOcoLegDto {
  ocoGroupId: string;
  monitorId: number | null;
  monitorStatus: string | null;
  planId: number | null;
  recommendationId: number | null;
  card: TradeRecommendationCardDto | null;
}

export interface RecAccountAttemptDto {
  tradingAccountId: number;
  accountName: string | null;
  passed: boolean;
  blockReason: string | null;
  attemptedAt: string;
}

export interface RecOrderDto {
  id: number;
  tradingAccountId: number;
  accountName: string | null;
  orderType: string;
  executionType: string;
  status: string;
  quantity: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  filledPrice: number | null;
  filledQuantity: number | null;
  brokerOrderId: string | null;
  rejectionReason: string | null;
  isPaper: boolean;
  createdAt: string;
  filledAt: string | null;
  slippagePips: number | null;
  submitToFillMs: number | null;
}

export interface RecPositionDto {
  id: number;
  openOrderId: number | null;
  tradingAccountId: number;
  accountName: string | null;
  /** Demo | Real — the card's P&L sums both. */
  accountType: string | null;
  status: string;
  direction: string;
  openLots: number;
  averageEntryPrice: number;
  currentPrice: number | null;
  closePrice: number | null;
  stopLoss: number | null;
  initialStopLoss: number | null;
  takeProfit: number | null;
  realizedPnL: number;
  unrealizedPnL: number;
  swap: number;
  commission: number;
  maxFavorablePrice: number | null;
  maxAdversePrice: number | null;
  isPaper: boolean;
  brokerPositionId: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface RecSignalDto {
  id: number;
  status: string;
  source: string;
  direction: string;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  originalTakeProfit: number | null;
  suggestedLotSize: number;
  confidence: number;
  atrAtGeneration: number | null;
  rejectionReason: string | null;
  gateBypassReason: string | null;
  strategyId: number;
  strategyName: string | null;
  analysisMonitorId: number | null;
  orderId: number | null;
  generatedAt: string;
  expiresAt: string;
  ghostOutcome: string | null;
  ghostPnLPips: number | null;
  accountAttempts: RecAccountAttemptDto[];
  orders: RecOrderDto[];
  positions: RecPositionDto[];
}

export interface RecPendingRecDto {
  id: number;
  state: string;
  recommendedEntryPrice: number;
  atrAtGeneration: number;
  createdAt: string;
  parkExpiresAt: string;
  signalExpiresAt: string;
  lastRevalAttemptAt: string | null;
  revalAttempts: number;
  terminalReason: string | null;
  resultingTradeSignalId: number | null;
}

export interface RecTimelineEventDto {
  atUtc: string;
  kind: string;
  title: string;
  detail: string | null;
  tone: 'good' | 'bad' | 'warn' | 'neutral';
  refKind: string | null;
  refId: number | null;
}

export interface TradeRecommendationDetailDto {
  card: TradeRecommendationCardDto;
  analysis: RecAnalysisDto | null;
  chatTurn: RecChatTurnDto | null;
  question: RecChatTurnDto | null;
  answer: RecChatTurnDto | null;
  plan: RecPlanDto | null;
  originMonitor: RecMonitorDto | null;
  monitors: RecMonitorDto[];
  ocoLegs: RecOcoLegDto[];
  siblings: TradeRecommendationCardDto[];
  signal: RecSignalDto | null;
  pendingRec: RecPendingRecDto | null;
  timeline: RecTimelineEventDto[];
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** Price decimals by instrument family — metals 2, JPY 3, else 5. */
export function recPriceDigits(symbol: string | null | undefined): number {
  const s = (symbol ?? '').toUpperCase();
  if (s.startsWith('XAU') || s.startsWith('XAG')) return 2;
  if (s.includes('JPY')) return 3;
  return 5;
}

/** Pip size by instrument family — metals 0.1, JPY 0.01, else 0.0001. */
export function recPipSize(symbol: string | null | undefined): number {
  const s = (symbol ?? '').toUpperCase();
  if (s.startsWith('XAU') || s.startsWith('XAG')) return 0.1;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

export function recFormatPrice(symbol: string, v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(recPriceDigits(symbol));
}

/** Distance between two prices in pips, one decimal; null when either is missing. */
export function recPips(
  symbol: string,
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a == null || b == null) return null;
  return Math.round((Math.abs(a - b) / recPipSize(symbol)) * 10) / 10;
}

/** Parse a JSON string, or null when it is empty or not JSON. */
export function recParseJson<T = Record<string, unknown>>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Pretty-print a JSON string; returns the input unchanged when it is not JSON. */
export function recPrettyJson(s: string | null | undefined): string {
  if (!s) return '';
  const v = recParseJson<unknown>(s);
  return v == null ? s : JSON.stringify(v, null, 2);
}

/** Outcome → label and tone for the outcome pill. */
export function recOutcomeView(outcome: string): {
  label: string;
  tone: 'good' | 'bad' | 'warn' | 'info' | 'neutral';
} {
  switch (outcome) {
    case 'Open':
      return { label: 'Position open', tone: 'info' };
    case 'Won':
      return { label: 'Won', tone: 'good' };
    case 'Lost':
      return { label: 'Lost', tone: 'bad' };
    case 'Flat':
      return { label: 'Closed flat', tone: 'neutral' };
    case 'Unfilled':
      return { label: 'Order unfilled', tone: 'warn' };
    case 'SignalExpired':
      return { label: 'Signal expired', tone: 'warn' };
    case 'SignalRejected':
      return { label: 'Signal rejected', tone: 'bad' };
    case 'Signal':
      return { label: 'Signal live', tone: 'info' };
    case 'Watching':
      return { label: 'Watching', tone: 'info' };
    case 'Rejected':
      return { label: 'Refused', tone: 'bad' };
    case 'Withdrawn':
    case 'Expired':
      return { label: outcome, tone: 'warn' };
    case 'Parked':
      return { label: 'Parked', tone: 'info' };
    default:
      return { label: outcome || '—', tone: 'neutral' };
  }
}

const TRIGGER_OPS: Record<string, string> = {
  above: 'above',
  below: 'below',
  gt: '>',
  gte: '≥',
  ge: '≥',
  lt: '<',
  lte: '≤',
  le: '≤',
  eq: '=',
  equals: '=',
  ne: '≠',
  neq: '≠',
  notequals: '≠',
  crossesup: 'crosses above',
  crossesdown: 'crosses below',
  between: 'between',
  outside: 'outside',
  in: 'in',
  notin: 'not in',
};

/**
 * A watch trigger as one readable line. Analysts write it either as prose or as
 * the monitor spec DSL (`{ v, all | any | not | conditions: [...] }` with leaves
 * `{ metric, op, value | ref | values, subject?, agg?, windowMinutes?, offsetPips? }`);
 * the detail page interpolated the DSL object straight into the template and
 * printed "trigger [object Object]". Unknown shapes fall back to compact JSON
 * rather than inventing a reading.
 */
export function recTriggerText(trigger: unknown): string {
  if (trigger == null) return '';
  if (typeof trigger === 'string') return trigger;
  if (typeof trigger === 'number' || typeof trigger === 'boolean') return String(trigger);
  return describeTriggerNode(trigger, true);
}

function describeTriggerNode(node: unknown, top: boolean): string {
  if (node == null || typeof node !== 'object') return String(node ?? '');
  if (Array.isArray(node)) return node.map((n) => describeTriggerNode(n, false)).join(' and ');
  const o = node as Record<string, unknown>;
  const group = (items: unknown, joiner: string) => {
    const parts = (Array.isArray(items) ? items : [items]).map((n) =>
      describeTriggerNode(n, false),
    );
    const text = parts.join(joiner);
    return top || parts.length < 2 ? text : `(${text})`;
  };
  if (o['all'] != null) return group(o['all'], ' and ');
  if (o['conditions'] != null) return group(o['conditions'], ' and ');
  if (o['any'] != null) return group(o['any'], ' or ');
  if (o['not'] != null) return `not ${describeTriggerNode(o['not'], false)}`;
  if (typeof o['metric'] === 'string' && typeof o['op'] === 'string') {
    const op = TRIGGER_OPS[o['op'].toLowerCase()] ?? o['op'];
    const agg = typeof o['agg'] === 'string' ? `${o['agg']} ` : '';
    const subject = typeof o['subject'] === 'string' ? `${o['subject']} ` : '';
    const win = typeof o['windowMinutes'] === 'number' ? ` over ${o['windowMinutes']}m` : '';
    let rhs: string;
    if (Array.isArray(o['values'])) rhs = (o['values'] as unknown[]).map(String).join(' – ');
    else if (Array.isArray(o['value'])) rhs = (o['value'] as unknown[]).map(String).join(' – ');
    else if (o['value'] != null) rhs = String(o['value']);
    else if (o['ref'] != null)
      rhs = typeof o['ref'] === 'string' ? o['ref'] : JSON.stringify(o['ref']);
    else rhs = '';
    const offset =
      typeof o['offsetPips'] === 'number' && o['offsetPips'] !== 0
        ? ` ${o['offsetPips'] > 0 ? '+' : '−'} ${Math.abs(o['offsetPips'])}p`
        : '';
    return `${subject}${agg}${o['metric']}${win} ${op} ${rhs}${offset}`.replace(/\s+/g, ' ').trim();
  }
  return JSON.stringify(node);
}

/** "[GateCode] detail" → { code, detail }; anything else → detail only. */
export function recSplitReason(reason: string | null | undefined): {
  code: string | null;
  detail: string;
} {
  if (!reason) return { code: null, detail: '' };
  const m = /^\s*\[([^\]]+)\]\s*(.*)$/s.exec(reason);
  return m ? { code: m[1], detail: m[2] } : { code: null, detail: reason };
}

export const REC_STATUSES = [
  'Proposed',
  'Filed',
  'Parked',
  'Rejected',
  'Expired',
  'Withdrawn',
] as const;
export const REC_SOURCES = [
  'ChatRecommend',
  'PatientTrader',
  'SpotAnalysis',
  'MonitorReview',
  'StructureWatch',
] as const;

export const REC_SOURCE_LABELS: Record<string, string> = {
  ChatRecommend: 'Chat',
  PatientTrader: 'Patient Trader',
  SpotAnalysis: 'Spot analysis',
  MonitorReview: 'Monitor review',
  StructureWatch: 'Structure watch',
};
