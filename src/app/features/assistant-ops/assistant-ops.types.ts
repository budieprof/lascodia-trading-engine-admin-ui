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
  /** Loop efficiency (engine harness wave 2); undefined on an older engine. */
  efficiency?: AssistantLoopEfficiency;
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
  /** The latest with/without replay of this lesson (engine harness wave 2; absent on older engines). */
  evalRunId?: number | null;
  /** Queued / Running / Completed / BudgetStopped / Failed — the replay run's status. */
  evalStatus?: string | null;
  evalAtUtc?: string | null;
  evalImproved?: number | null;
  evalWorsened?: number | null;
  evalUnchanged?: number | null;
  /** Approved 30+ days, used, and its replay changed nothing. */
  noMeasurableEffect?: boolean;
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

// ── Loop efficiency (AssistantMetrics.efficiency, engine harness wave 2) ────────────────────

/** How the assistant's loop ran: tool-call protocol, prompt reuse, quick-model routing. */
export interface AssistantLoopEfficiency {
  questions: number;
  nativeRounds: number;
  sentinelRounds: number;
  nativeFallbackRounds: number;
  nativeShare: number;
  sentinelShare: number;
  nativeFallbackShare: number;
  prefixReusedQuestions: number;
  prefixReuseShare: number;
  cacheHitRatioPrefixReused: number;
  cacheHitRatioPrefixRendered: number;
  routed: number;
  routedShare: number;
  escalated: number;
  escalationRate: number;
  escalationReasons: Record<string, number>;
  questionsByModel: Record<string, number>;
  avgNotionalCostRoutedUsd: number;
  avgNotionalCostMainUsd: number;
}

// ── Before / after (GET assistant/metrics/compare) ───────────────────────────────────────────

/** One window re-derived from the conversations (engine `AssistantHistoryStatsDto`). */
export interface AssistantHistoryStats {
  questions: number;
  answerAttempts: number;
  heldRate: number;
  held: number;
  unverifiedRate: number;
  unverified: number;
  avgRounds: number;
  avgToolCalls: number;
  toolErrorRate: number;
  avgTokensInput: number;
  avgTokensOutput: number;
  cacheHitRatio: number;
  wallP50Seconds: number;
  wallP95Seconds: number;
  truncated: boolean;
  /** Per figure: `exact` | `approx`. */
  exactness: Record<string, string>;
}

export interface AssistantMetricsWindow {
  fromUtc: string;
  toUtc: string;
  history: AssistantHistoryStats;
  telemetry: AssistantTurnStats | null;
  telemetryFromUtc: string | null;
}

export interface AssistantMetricsCompare {
  baseline: AssistantMetricsWindow;
  current: AssistantMetricsWindow;
  historyDeltas: Record<string, number>;
  telemetryDeltas: Record<string, number> | null;
  notes: string[];
}

// ── Evals (GET assistant/evals/runs, /runs/{id}; POST evals/run) ─────────────────────────────

/** Engine `AssistantEvalRunDto`. kind suite|lesson|judge; status Queued|Running|Completed|BudgetStopped|Failed. */
export interface AssistantEvalRun {
  id: number;
  kind: string;
  trigger: string;
  status: string;
  lessonId: number | null;
  model: string | null;
  resolvedModel: string | null;
  promptHash: string | null;
  caseIds: string[];
  requestedBy: string | null;
  queuedAtUtc: string;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  casesTotal: number;
  casesPassed: number;
  casesFailed: number;
  casesSkipped: number;
  /** 0..1, null until scored. */
  passRate: number | null;
  /** 0..1, null until scored. */
  meanScore: number | null;
  modelCalls: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  wallMs: number;
  improved: number | null;
  worsened: number | null;
  unchanged: number | null;
  summary: string | null;
  error: string | null;
}

export interface AssistantEvalCheck {
  name: string;
  passed: boolean;
  detail: string | null;
}

export interface AssistantEvalCaseResult {
  id: number;
  caseId: string;
  caseTitle: string | null;
  /** Lesson replay: `with` / `without`; empty for a suite. */
  arm: string;
  passed: boolean;
  skipped: string | null;
  score: number;
  checksTotal: number;
  checksFailed: number;
  checks: AssistantEvalCheck[];
  rounds: number;
  modelCalls: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  protocol: string | null;
  modelLatencyMs: number;
  wallMs: number;
  heldForRevision: number;
  unverified: boolean;
  failureReason: string | null;
  answer: string | null;
}

export interface AssistantEvalRunDetail {
  run: AssistantEvalRun;
  cases: AssistantEvalCaseResult[];
  lessonId: number | null;
  lessonText: string | null;
  lessonScope: string | null;
}

export interface AssistantEvalCaseInfo {
  id: string;
  title: string;
  kind: string;
  skip: string | null;
  recordedTokens: number;
}

export interface AssistantEvalSettings {
  evalEnabled: boolean;
  evalHourUtc: number;
  evalModel: string | null;
  evalMaxCases: number;
  dailyTokenCeiling: number;
  tokensSpentToday: number;
  regressionPoints: number;
  judgeEnabled: boolean;
  judgeIntervalDays: number;
  judgeHourUtc: number;
  judgeSampleSize: number;
  judgeModel: string | null;
  lessonReplayEnabled: boolean;
  lessonReplayMaxCases: number;
  cases: AssistantEvalCaseInfo[];
}

export interface AssistantEvalRuns {
  runs: AssistantEvalRun[];
  live: AssistantEvalRun | null;
  settings: AssistantEvalSettings;
}

export type AssistantEvalKind = 'suite' | 'lesson' | 'judge' | 'all';

// ── Quality (GET assistant/quality) ──────────────────────────────────────────────────────────

export interface AssistantQualityPoint {
  runId: number;
  gradedAtUtc: string;
  answers: number;
  correctness: number;
  completeness: number;
  clarity: number;
  honesty: number;
  overall: number;
  lowCorrectness: number;
  judgeModel: string | null;
}

export interface AssistantAnswerGrade {
  id: number;
  runId: number;
  conversationId: number;
  conversationLink: string;
  answerTurnId: number;
  questionTurnId: number | null;
  answeredAtUtc: string;
  question: string | null;
  answerExcerpt: string | null;
  correctness: number;
  completeness: number;
  clarity: number;
  honesty: number;
  correctnessReason: string | null;
  completenessReason: string | null;
  clarityReason: string | null;
  honestyReason: string | null;
  overall: number;
  judgeModel: string | null;
  lessonCandidateId: number | null;
  gradedAtUtc: string;
}

export interface AssistantQuality {
  fromUtc: string;
  answers: number;
  correctness: number;
  completeness: number;
  clarity: number;
  honesty: number;
  overall: number;
  trend: AssistantQualityPoint[];
  lowest: AssistantAnswerGrade[];
}
