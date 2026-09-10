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

// ── Authoring: subjects, metrics, actions ───────────────────────────────────

/**
 * One metric the registry can resolve, as the explorer shows it.
 *
 * `currentValue` is what actually answers "why hasn't this fired?" — a threshold
 * looks reasonable until you see the metric reading `unavailable (no candles
 * stored yet)` beside it.
 */
export interface MonitorMetric {
  name: string;
  displayName: string;
  description: string;
  /** Provider that serves it — 'Tick', 'Candles & structure', 'Account', … */
  source: string;
  /** 'Numeric' | 'Categorical' | 'Boolean'. */
  kind: string;
  unit?: string | null;
  /** 'Free' | 'Cheap' | 'Expensive'. Free metrics are eligible for the tick fast lane. */
  cost: string;
  requiresLivePrice: boolean;
  supportsAggregation: boolean;
  aliases: string[];
  /** Operators that mean something for this metric's kind. */
  operators: string[];
  currentValue?: string | null;
  currentValueAvailable?: boolean;
}

/** One action a monitor can run when it fires. */
export interface MonitorAction {
  type: string;
  displayName: string;
  description: string;
  /** 0 notify, 1 propose, 2 state-changing. */
  tier: number;
  tierName: string;
  subjectKinds: string[];
}

/** What can be asked about a subject, plus the action catalogue. */
export interface MonitorMetricCatalogue {
  subjectKind: string;
  subjectRef?: string | null;
  subjectKinds: string[];
  metrics: MonitorMetric[];
  actions: MonitorAction[];
}

// ── Preview (historical replay) ─────────────────────────────────────────────

/** One moment a replayed spec would have fired. */
export interface MonitorPreviewFire {
  atUtc: string;
  note: string;
  mid?: number | null;
}

/**
 * What replaying a candidate spec over history found.
 *
 * `fireCount === 0` on a watch the operator expected to be busy is the single
 * most important signal here: it means the condition cannot work, which is
 * otherwise indistinguishable from a market that has not moved yet.
 */
export interface MonitorPreviewResult {
  explanation: string;
  errors: string[];
  warnings: string[];
  samplesEvaluated: number;
  fromUtc?: string | null;
  toUtc?: string | null;
  fires: MonitorPreviewFire[];
  fireCount: number;
  unresolvableSamples: number;
  meanHoursBetweenFires?: number | null;
  /** Plain-language read of the result. */
  verdict: string;
}

/** Payload for POST analysis-monitors/preview. */
export interface MonitorPreviewRequest {
  triggerSpecJson?: string;
  subjectKind?: string;
  subjectRef?: string;
  symbol?: string;
  timeframe?: string;
  lookbackDays?: number;
  cooldownSeconds?: number;
}

// ── Create ─────────────────────────────────────────────────────────────────

/** Tier-2 authorisation supplied when creating a state-changing monitor. */
export interface MonitorActionAuthorizationRequest {
  by: string;
  reason: string;
  actions: string[];
  /**
   * Opt IN to describe-only. Defaults false, so an authorised monitor acts for real —
   * the authorisation above is the deliberate act, not a second confirmation.
   */
  dryRun?: boolean;
}

/** Payload for POST analysis-monitors. */
export interface CreateMonitorRequest {
  anchorLlmInvocationId?: number | null;
  subjectKind?: string;
  subjectRef?: string;
  symbol?: string | null;
  timeframe?: string | null;
  intentText: string;
  triggerSpecJson?: string;
  actionSpecJson?: string;
  invalidationSpecJson?: string | null;
  recurring?: boolean;
  cooldownSeconds?: number;
  maxTriggers?: number;
  expiresInHours?: number;
  minEvalIntervalSeconds?: number;
  maxPriceAgeSeconds?: number;
  deliverTo?: string[];
  requiresAck?: boolean;
  ackEscalateAfterSeconds?: number;
  maxActionTier?: number;
  actionAuthorization?: MonitorActionAuthorizationRequest | null;
  llmSpendCapUsd?: number;
  /** Arms despite non-fatal lint warnings. Fatal problems are never overridable. */
  acceptWarnings?: boolean;
}

// ── Templates ──────────────────────────────────────────────────────────────

/** One declared template parameter. */
export interface MonitorTemplateParameter {
  name: string;
  label: string;
  /** 'number' | 'string' | 'symbol' | 'account' | 'percent'. */
  type: string;
  default?: string | null;
  example?: string | null;
}

/** A reusable, parameterised monitor definition. */
export interface MonitorTemplate {
  id: number;
  name: string;
  description: string;
  subjectKind: string;
  intentTemplate: string;
  triggerTemplateJson: string;
  actionTemplateJson: string;
  invalidationTemplateJson?: string | null;
  /** JSON array of MonitorTemplateParameter. */
  parametersJson: string;
  recurring: boolean;
  cooldownSeconds: number;
  maxTriggers: number;
  defaultExpiryHours: number;
  maxActionTier: number;
  /** Built-ins are re-seeded on startup: duplicate to tune one, never edit it. */
  isBuiltIn: boolean;
  builtInKey?: string | null;
  instantiationCount: number;
  createdBy?: string | null;
  createdAtUtc: string;
  /** Placeholder names actually found in the template bodies. */
  placeholders: string[];
}

/** Payload for instantiating a template across one or more subjects. */
export interface InstantiateTemplateRequest {
  subjectRefs: string[];
  parameters: Record<string, string>;
  timeframe?: string | null;
  expiresInHours?: number | null;
  anchorLlmInvocationId?: number | null;
  deliverTo?: string[] | null;
  acceptWarnings?: boolean;
}

/** What a fan-out produced. Partial success is normal and reported. */
export interface MonitorInstantiationResult {
  monitorGroupId: string;
  created: import('@core/api/api.types').AnalysisMonitorDto[];
  /** Subjects that could not be armed, and why. */
  failures: string[];
}
