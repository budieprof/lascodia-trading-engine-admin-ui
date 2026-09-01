/**
 * Shapes for the analysis-monitor cockpit.
 *
 * Mirrors `MarketDataController`'s `analysis-monitors/board` +
 * `analysis-monitors/{id}` endpoints (engine:
 * `Application/MarketData/Queries/AnalysisMonitors/`). `AnalysisMonitorDto`
 * itself lives in `@core/api/api.types` because the chat strip shares it.
 */

/** Fleet roll-up rendered as the cockpit's KPI strip. */
export interface AnalysisMonitorBoardCounters {
  active: number;
  paused: number;
  triggered: number;
  expired: number;
  cancelled: number;
  invalidated: number;
  error: number;
  /** Active monitors armed by the patient-hunter sweep rather than an operator. */
  activeHunter: number;
  /** Active monitors that spend an LLM call per evaluation window. */
  activeLlmAssisted: number;
  firedLast24h: number;
  expiringWithin1h: number;

  /** Seconds since the most recently checked Active monitor was evaluated. */
  workerLastCheckSeconds?: number | null;
  /** Seconds since the LEAST recently checked Active monitor was evaluated. */
  workerStalestCheckSeconds?: number | null;
  /**
   * Active monitors overdue against THEIR OWN cadence — deterministic ones are
   * checked every worker loop, LLM-judged ones only every `minEvalIntervalSeconds`.
   */
  workerOverdueCount: number;
  /**
   * True when Active monitors exist and every one of them is overdue.
   * The distinction that matters most on this page: a monitor reading "Active"
   * is only actually armed if the worker is alive to evaluate it.
   */
  workerLooksStalled: boolean;
}

/** One row on a monitor's timeline / the fleet activity feed. */
export interface AnalysisMonitorActivity {
  id: number;
  monitorId: number;
  /** Created | Evaluated | Fired | Suppressed | Invalidated | Expired |
   *  Cancelled | Paused | Resumed | Updated | Extended | EvalError | ManualEval */
  kind: string;
  occurredAtUtc: string;
  note?: string | null;
  fired: boolean;
  statusAfter?: string | null;
  resultLlmInvocationId?: number | null;
  /** Comma-separated signal ids filed by this fire. */
  generatedSignalIds?: string | null;
  actorUserId?: string | null;
  observedMid?: number | null;
  evaluationPath?: string | null;

  // Denormalised from the owning monitor so the feed renders in one fetch.
  symbol: string;
  timeframe: string;
  intentText?: string | null;
  origin: string;
  anchorLlmInvocationId: number;
}

export interface AnalysisMonitorBoard {
  monitors: import('@core/api/api.types').AnalysisMonitorDto[];
  counters: AnalysisMonitorBoardCounters;
  activity: AnalysisMonitorActivity[];
  totalCount: number;
  page: number;
  pageSize: number;
  asOfUtc: string;
}

/** A trade signal produced by one of this monitor's fires. */
export interface AnalysisMonitorSignal {
  id: number;
  symbol: string;
  direction: string;
  status: string;
  createdAtUtc: string;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

/** A monitor in this watch's re-arm lineage. */
export interface AnalysisMonitorLineage {
  id: number;
  status: string;
  intentText: string;
  rearmDepth: number;
  createdAtUtc: string;
  /** 'parent' | 'successor' */
  relation: string;
}

export interface AnalysisMonitorDetail {
  monitor: import('@core/api/api.types').AnalysisMonitorDto;
  timeline: AnalysisMonitorActivity[];
  signals: AnalysisMonitorSignal[];
  lineage: AnalysisMonitorLineage[];
  timelineTotal: number;
  includesHeartbeats: boolean;
  asOfUtc: string;
}

/** Filters the board query accepts. */
export interface AnalysisMonitorBoardFilter {
  /** Status allow-list; the pseudo-status 'Live' expands to Active + Paused. */
  statuses?: string[] | null;
  symbol?: string | null;
  origin?: string | null;
  evaluationMode?: string | null;
  search?: string | null;
  anchorLlmInvocationId?: number | null;
  activityLimit?: number;
  page?: number;
  pageSize?: number;
}

/** Payload for an in-place monitor edit. Omitted fields are left alone. */
export interface UpdateAnalysisMonitorRequest {
  intentText?: string | null;
  trigger?: unknown;
  action?: unknown;
  /** Explicit null clears the thesis-break condition. */
  invalidation?: unknown;
  recurring?: boolean | null;
  cooldownSeconds?: number | null;
  maxTriggers?: number | null;
  minEvalIntervalSeconds?: number | null;
  reason?: string | null;
}
