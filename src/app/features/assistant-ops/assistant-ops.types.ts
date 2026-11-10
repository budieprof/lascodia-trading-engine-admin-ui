/**
 * Wire types for the assistant's operations surface — engine `AssistantOpsController`
 * (`api/v1/lascodia-trading-engine/assistant/*`). Hand-written: `core/api/_generated/schema.ts`
 * does not have these endpoints yet. Field names mirror the engine DTOs (camelCase on the wire):
 *   - `AssistantMetricsDto` & co. — `Application/AdminAssistant/Observability/AssistantMetricsQuery.cs`
 *   - `AssistantLessonDto`        — `Application/AdminAssistant/Lessons/AssistantLessonRequests.cs`
 */

// ── Metrics (GET assistant/metrics?hours=1..720) ─────────────────────────────

/** How the assistant's questions went over the window — one split (all / operator / headless). */
export interface AssistantTurnStats {
  /** Questions that ran (spend-guard refusals excluded — counted in spendGuardTrips). */
  turns: number;
  answered: number;
  finalAnswerRate: number;
  /** Questions that reached an answer attempt — the denominator of holdRate / unverifiedRate. */
  answerAttempts: number;
  holdRate: number;
  gateHoldsNumbers: number;
  gateHoldsAbsence: number;
  gateHoldsCausal: number;
  unverifiedRate: number;
  unverified: number;
  checkpointRate: number;
  spendGuardTrips: number;
  preflightBlocks: number;
  writesNotRun: number;
  writesRefused: number;
  toolParseRetries: number;
  /** Questions per latest outcome (answered / proposal / checkpoint / failed …). */
  outcomes: Record<string, number>;
  wallP50Seconds: number;
  wallP95Seconds: number;
  avgRounds: number;
  avgModelCalls: number;
  avgToolCalls: number;
  toolErrorRate: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  avgTokensInput: number;
  avgTokensOutput: number;
  /** Cache reads ÷ input tokens (input includes cached). */
  cacheHitRatio: number;
  notionalCostUsd: number;
  avgNotionalCostUsd: number;
}

/** One tool's record over the window (calls that ran as reads). */
export interface AssistantToolStats {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  errorClasses: Record<string, number>;
  p50Ms: number;
  p95Ms: number;
  truncatedRate: number;
  avgResultChars: number;
  parallelShare: number;
  operatorCalls: number;
  headlessCalls: number;
  /** Calls that did NOT run as reads (write_proposed, preflight_blocked, not_run, refused, ui_action). */
  nonReads: Record<string, number>;
}

/** What happened to the engine writes the assistant proposed (approval cards). */
export interface AssistantApprovalStats {
  proposed: number;
  confirmed: number;
  rejected: number;
  failed: number;
  pending: number;
  approvalRate: number;
  failedAfterConfirmRate: number;
}

export interface AssistantMetrics {
  fromUtc: string;
  toUtc: string;
  windowHours: number;
  all: AssistantTurnStats;
  operator: AssistantTurnStats;
  headless: AssistantTurnStats;
  tools: AssistantToolStats[];
  approvals: AssistantApprovalStats;
  /** The window held more rows than the read cap; the figures cover the newest rows only. */
  truncated: boolean;
  /**
   * Health thresholds crossed over THIS window (engine 3f04f4b1+). Undefined on an older engine;
   * empty — and `thresholds` null — when the engine could not read its options.
   */
  breaches?: AssistantHealthBreachDto[];
  /** The `Llm:AssistantAlert*` thresholds in force (0 = rule off); null when unavailable. */
  thresholds?: AssistantHealthThresholds | null;
}

export interface AssistantHealthBreachDto {
  key: string;
  severity: string;
  message: string;
}

export interface AssistantHealthThresholds {
  unverifiedRatePct: number;
  toolErrorRatePct: number;
  turnP95Seconds: number;
  spendGuardTrips: number;
  minTurns: number;
  toolMinCalls: number;
}

// ── Lessons (GET/POST assistant/lessons…) ────────────────────────────────────

export type AssistantLessonStatus = 'Candidate' | 'Approved' | 'Rejected' | 'Retired';

/** card_rejection / correction / gate_exhausted / manual / seed. */
export type AssistantLessonSource = string;

/** global / route / tool / operation / symbol. */
export type AssistantLessonScopeKind = 'global' | 'route' | 'tool' | 'operation' | 'symbol';

export interface AssistantLesson {
  id: number;
  status: AssistantLessonStatus | string;
  source: AssistantLessonSource;
  scopeKind: AssistantLessonScopeKind | string;
  scopeValue: string | null;
  text: string;
  evidence: string | null;
  sourceConversationIds: number[];
  sourceTurnId: number | null;
  sourceRef: string | null;
  createdBy: string | null;
  reviewedBy: string | null;
  /** Display names of createdBy / reviewedBy when they are admin users (engine 3f04f4b1+). */
  createdByName?: string | null;
  reviewedByName?: string | null;
  reviewNote: string | null;
  createdAtUtc: string;
  reviewedAtUtc: string | null;
  injectedCount: number;
  lastInjectedAtUtc: string | null;
}

/** The engine's `AssistantLessonReviewBody` (approve takes all four; reject / retire only `note`). */
export interface AssistantLessonReviewBody {
  text?: string;
  scopeKind?: string;
  scopeValue?: string;
  note?: string;
}

/** The three review endpoints: `POST assistant/lessons/{id}/{action}`. */
export type AssistantLessonReviewAction = 'approve' | 'reject' | 'retire';

/** One active `AssistantHealth` alert, as `POST alert/list` returns it (subset of `AlertDto`). */
export interface AssistantHealthAlertRow {
  id: number;
  severity: string | number;
  conditionJson: string;
  deduplicationKey: string | null;
  isActive: boolean;
  lastTriggeredAt: string | null;
}
