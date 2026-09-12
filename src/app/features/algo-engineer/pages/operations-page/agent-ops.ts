/**
 * The algo-engineer fleet, as one view.
 *
 * A work order is a conversation, a run, its open approvals and its armed watches — four separate
 * engine reads that only become "what the agent is doing" once they are joined. That join is here,
 * as plain functions, so the ordering rules (an approval nobody has noticed goes to the top) are
 * testable without rendering anything, and so the page component stays a template over signals.
 *
 * Everything reuses the chat's own vocabulary — `parseApproval`, `parseWatches`, `isRunLive`,
 * `runStatusLabel` — because the two surfaces must not disagree about what "Watching" means.
 */
import type {
  AgentChangeSetDto,
  AlgoEngineerAuditRowDto,
  AlgoEngineerRunStateDto,
  AnalysisConversationSummaryDto,
  AnalysisMonitorDto,
  SpotAnalysisFollowUpTurnDto,
} from '@core/api/api.types';
import {
  isPendingAction,
  isRunLive,
  parseApproval,
  parseWatches,
  runStatusLabel,
} from '@shared/components/engineer-chat/engineer-turns';

// ── Age ───────────────────────────────────────────────────────────────────────────────────────

/**
 * How long something has been sitting there — `just now` · `4m` · `2h 13m` · `3d`.
 *
 * Deliberately coarser than the run bar's `formatElapsed`: this answers "should I be worried",
 * not "how long exactly", and a seconds field ticking on a list of ten cards is noise.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 6 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d < 3 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** How overdue an unanswered approval is. The thresholds are the operator's, not the agent's:
 *  the host stops blocking on a card after ~3 minutes, but the card stays open until answered. */
export type ApprovalUrgency = 'fresh' | 'waiting' | 'stalled';

export function approvalUrgency(ageMs: number): ApprovalUrgency {
  if (ageMs >= 10 * 60_000) return 'stalled';
  if (ageMs >= 2 * 60_000) return 'waiting';
  return 'fresh';
}

// ── Work orders ───────────────────────────────────────────────────────────────────────────────

/** One approval card still waiting on the operator, wherever it lives. */
export interface PendingApproval {
  /** The card's turn id — unique across the fleet, and the deep link's anchor. */
  turnId: number;
  sessionId: number;
  /** The work order it belongs to, for a card read out of context. */
  workOrder: string;
  verb: string;
  targets: string[];
  sideEffect: string | null;
  /** True when approving changes something in production. */
  live: boolean;
  requestedAtUtc: string;
  ageMs: number;
  urgency: ApprovalUrgency;
}

/** Something the agent is waiting on — a host-side watch or an armed engine monitor. */
export interface WatchRow {
  key: string;
  /** What is being watched: `training run 75961`, or the monitor's own intent. */
  what: string;
  /** Where it came from — a watch the agent registered, or a monitor armed in the engine. */
  source: 'watch' | 'monitor';
  /** When it next looks, ISO; null when it is continuous or unknown. */
  nextCheckAtUtc: string | null;
  /** Free-text state for a monitor ('paused', 'every cycle'), null for a host watch. */
  note: string | null;
  /** The monitor's id, for a link into the cockpit. */
  monitorId: number | null;
}

export interface WorkOrderRow {
  sessionId: number;
  title: string;
  /** Run status as the run-state row reports it, falling back to the conversation's summary. */
  status: string;
  statusLabel: string;
  live: boolean;
  run: AlgoEngineerRunStateDto | null;
  approvals: PendingApproval[];
  watches: WatchRow[];
  lastActivityAtUtc: string;
}

export interface WorkOrderInput {
  conversation: AnalysisConversationSummaryDto;
  /** The session's latest run, when it was fetched. */
  run?: AlgoEngineerRunStateDto | null;
  monitors?: readonly AnalysisMonitorDto[];
  /** The thread, when it was fetched — the only place open approval cards live. */
  turns?: readonly SpotAnalysisFollowUpTurnDto[];
}

/** The Engineer conversations — an agent work order, not an analysis. */
export function isEngineerConversation(c: AnalysisConversationSummaryDto): boolean {
  return (c.kind ?? '').trim().toLowerCase() === 'engineer';
}

/** What to call a work order in a list: its opening instruction, clipped to one line. */
export function workOrderTitle(c: AnalysisConversationSummaryDto, max = 110): string {
  const raw = (c.preview ?? '').trim() || (c.purpose ?? '').trim();
  const line = raw.split('\n')[0].trim();
  if (!line) return `Work order #${c.llmInvocationId}`;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Every approval card in a thread that is still awaiting an answer.
 *
 * `actionStatus` is the authority, not the run status: a run that gave up waiting (or a host that
 * died) leaves the card Pending, and that card is exactly the one nobody notices.
 */
export function extractPendingApprovals(
  sessionId: number,
  workOrder: string,
  turns: readonly SpotAnalysisFollowUpTurnDto[],
  nowMs: number,
): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const t of turns) {
    if (t.role !== 'ActionProposal' || t.toolName !== 'approval') continue;
    if (!isPendingAction(t.actionStatus)) continue;
    const a = parseApproval(t);
    const requestedAtUtc = a.requestedAtUtc ?? t.createdAtUtc;
    const parsed = Date.parse(requestedAtUtc);
    const ageMs = Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
    out.push({
      turnId: t.id,
      sessionId,
      workOrder,
      verb: a.verb ?? 'approval',
      targets: a.targets,
      sideEffect: a.sideEffect,
      live: a.live,
      requestedAtUtc,
      ageMs,
      urgency: approvalUrgency(ageMs),
    });
  }
  return out;
}

/** When a monitor next looks, and what state it is in. Both are server-computed where possible. */
export function monitorWatchRow(m: AnalysisMonitorDto, nowMs: number): WatchRow {
  const status = (m.status ?? '').toLowerCase();
  const cooldownUntil = m.cooldownUntilUtc ? Date.parse(m.cooldownUntilUtc) : NaN;
  const cooling = Number.isFinite(cooldownUntil) && cooldownUntil > nowMs;
  return {
    key: `monitor-${m.id}`,
    what: (m.intentText ?? '').trim() || `${m.symbol} ${m.timeframe}`,
    source: 'monitor',
    nextCheckAtUtc: cooling ? (m.cooldownUntilUtc ?? null) : null,
    note: status === 'paused' ? 'paused' : cooling ? 'cooling down' : 'every cycle',
    monitorId: m.id,
  };
}

/** The agent's own watches (run state) plus the monitors armed for this conversation. */
export function watchRowsFor(
  run: AlgoEngineerRunStateDto | null | undefined,
  monitors: readonly AnalysisMonitorDto[] = [],
  nowMs = Date.now(),
): WatchRow[] {
  const hosted: WatchRow[] = parseWatches(run?.watchesJson).map((w) => ({
    key: `watch-${w.id}`,
    what: w.label,
    source: 'watch',
    nextCheckAtUtc: w.nextCheckAtUtc,
    note: null,
    monitorId: null,
  }));
  return [...hosted, ...monitors.map((m) => monitorWatchRow(m, nowMs))];
}

/** Join one work order's four reads into the row every section renders from. */
export function buildWorkOrder(input: WorkOrderInput, nowMs = Date.now()): WorkOrderRow {
  const c = input.conversation;
  const title = workOrderTitle(c);
  const status = input.run?.status ?? c.runStatus ?? '';
  return {
    sessionId: c.llmInvocationId,
    title,
    status,
    statusLabel: runStatusLabel(status),
    live: isRunLive(status),
    run: input.run ?? null,
    approvals: extractPendingApprovals(c.llmInvocationId, title, input.turns ?? [], nowMs),
    watches: watchRowsFor(input.run, input.monitors ?? [], nowMs),
    lastActivityAtUtc: c.lastActivityAtUtc,
  };
}

// ── Grouping ──────────────────────────────────────────────────────────────────────────────────

/** Sort weight for the Running-now list: what needs a human, then what is burning budget. */
const RUNNING_ORDER: Record<string, number> = {
  waitingforoperator: 0,
  working: 1,
  watching: 2,
  stale: 3,
};

function runningWeight(status: string): number {
  return RUNNING_ORDER[(status ?? '').toLowerCase()] ?? 4;
}

/**
 * The work orders with something alive about them, in the order an operator should read them:
 * waiting-for-you first (it is blocked on them), then working, then watching, newest activity first
 * inside each band.
 *
 * A Stale run is included even though `isRunLive` says otherwise — a run that stopped reporting 15
 * minutes ago is precisely what the operator needs to see, and hiding it is how three EAs sat
 * offline for a week.
 */
export function runningWorkOrders(rows: readonly WorkOrderRow[]): WorkOrderRow[] {
  return rows
    .filter((r) => r.live || (r.status ?? '').toLowerCase() === 'stale')
    .sort(
      (a, b) =>
        runningWeight(a.status) - runningWeight(b.status) ||
        Date.parse(b.lastActivityAtUtc) - Date.parse(a.lastActivityAtUtc),
    );
}

/**
 * Every open approval across the fleet, oldest first.
 *
 * Oldest-first rather than newest-first on purpose: this row exists because an approval nobody
 * notices stalls a job, and the one that has waited longest is the one nobody noticed.
 */
export function waitingForYou(rows: readonly WorkOrderRow[]): PendingApproval[] {
  return rows.flatMap((r) => r.approvals).sort((a, b) => b.ageMs - a.ageMs);
}

/** Work orders holding at least one watch, busiest first. */
export function watchingWorkOrders(rows: readonly WorkOrderRow[]): WorkOrderRow[] {
  return rows
    .filter((r) => r.watches.length > 0)
    .sort(
      (a, b) =>
        b.watches.length - a.watches.length ||
        Date.parse(b.lastActivityAtUtc) - Date.parse(a.lastActivityAtUtc),
    );
}

// ── Today ─────────────────────────────────────────────────────────────────────────────────────

/** Audit kinds that mean something in production changed. */
const LIVE_CHANGE_KINDS = new Set(['change_set', 'config_change', 'model_lifecycle']);

export interface TodaySummary {
  liveChanges: number;
  spendUsd: number;
  started: number;
  finished: number;
  /** True when the counts came from the audit timeline rather than the local fallback. */
  fromAudit: boolean;
}

function after(iso: string | null | undefined, sinceMs: number): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= sinceMs;
}

/**
 * The day so far.
 *
 * The audit timeline is the authority when it is there; until it ships (or when it fails) the same
 * questions are answered from what the other endpoints already say — change sets created today, and
 * runs that started or ended today. The tiles read the same either way; `fromAudit` is what lets the
 * page say where the numbers came from rather than quietly presenting a weaker answer as the strong
 * one.
 *
 * Spend always comes from the run rows: the audit carries no cost. A run that started yesterday and
 * is still burning counts against yesterday — the alternative is apportioning spend we cannot see.
 */
export function summariseToday(input: {
  audit: readonly AlgoEngineerAuditRowDto[] | null;
  runs: readonly AlgoEngineerRunStateDto[];
  changeSets: readonly AgentChangeSetDto[];
  dayStartMs: number;
}): TodaySummary {
  const { audit, runs, changeSets, dayStartMs } = input;
  const startedToday = runs.filter((r) => after(r.startedAtUtc, dayStartMs));
  const spendUsd = startedToday.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0);

  if (audit) {
    const today = audit.filter((r) => after(r.atUtc, dayStartMs));
    return {
      liveChanges: today.filter((r) => LIVE_CHANGE_KINDS.has(r.kind)).length,
      spendUsd,
      started: today.filter((r) => r.kind === 'run_started').length,
      finished: today.filter((r) => r.kind === 'run_ended').length,
      fromAudit: true,
    };
  }

  return {
    liveChanges: changeSets.filter((c) => after(c.createdAtUtc, dayStartMs)).length,
    spendUsd,
    started: startedToday.length,
    finished: runs.filter((r) => after(r.endedAtUtc, dayStartMs)).length,
    fromAudit: false,
  };
}

/** Midnight local time — the operator's day, not UTC's. */
export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const AUDIT_KIND_LABELS: Record<string, string> = {
  approval_requested: 'Approval asked',
  approval_resolved: 'Approval answered',
  change_set: 'Change set',
  change_status: 'Change status',
  change_outcome: 'Change outcome',
  model_lifecycle: 'Model',
  config_change: 'Config',
  run_started: 'Run started',
  run_ended: 'Run ended',
  monitor_armed: 'Monitor armed',
  monitor_fired: 'Monitor fired',
};

/** A readable label for an audit kind; an unknown kind reads as itself rather than disappearing. */
export function auditKindLabel(kind: string): string {
  return AUDIT_KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

/** Today's timeline, newest first and capped — the page shows a feed, not a ledger. */
export function todaysActivity(
  audit: readonly AlgoEngineerAuditRowDto[] | null,
  dayStartMs: number,
  limit = 12,
): AlgoEngineerAuditRowDto[] {
  if (!audit) return [];
  return audit
    .filter((r) => after(r.atUtc, dayStartMs))
    .sort((a, b) => Date.parse(b.atUtc) - Date.parse(a.atUtc))
    .slice(0, limit);
}
