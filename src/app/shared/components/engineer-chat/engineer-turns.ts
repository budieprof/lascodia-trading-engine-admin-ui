/**
 * Pure rendering logic for algo-engineer conversations (the harness turn conventions).
 *
 * Every turn the host service writes is a `SpotAnalysisFollowUp` row; the kind is carried by
 * `role` + `toolName` (see the harness contract, section 1). Everything here is a plain function
 * so the classification, grouping and formatting rules are testable without a TestBed — the
 * components only bind the results.
 *
 * Legacy turns (written before the harness) have `toolName = null` on every Assistant /
 * ActionProposal turn, so none of the named conventions below can match them and they keep the
 * chat's original rendering.
 */
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/** How one turn renders. */
export type TurnKind =
  | 'user'
  | 'assistant'
  /** A `thought` turn still streaming (`{"final":false}`) — the agent's inner narration. */
  | 'thought'
  | 'plan'
  | 'report'
  | 'notice'
  | 'approval'
  /** Any other ActionProposal — the spot chat's http_action, the assistant's operation call. */
  | 'action'
  /** A `recommend` tool turn — the spot chat's recommendation card. */
  | 'rec'
  /** A tool turn rendered as one row of a collapsed tool strip. */
  | 'tool'
  /** A spot follow-up tool turn rendered the way it always was (args + raw result). */
  | 'tool-legacy';

/** Parsed `toolResultJson` of a harness Tool turn: `{"ok":bool,"summary":string,"result":string}`. */
export interface ToolResult {
  /** True / false when the call reported it; null when the turn carries no verdict. */
  ok: boolean | null;
  summary: string | null;
  result: string | null;
  /** The raw payload, for a turn whose result is not in the harness shape. */
  raw: string | null;
}

/** One call in a tool strip. */
export interface ToolRow {
  turn: SpotAnalysisFollowUpTurnDto;
  result: ToolResult;
}

/** A single turn rendered on its own. */
export interface TurnItem {
  type: 'turn';
  key: string;
  kind: Exclude<TurnKind, 'tool' | 'thought'>;
  turn: SpotAnalysisFollowUpTurnDto;
  /** First turn of a calendar day (viewer's timezone) — draw a date divider above it. */
  newDay: boolean;
}

/** A run of consecutive tool calls folded into one strip. */
export interface ToolsItem {
  type: 'tools';
  key: string;
  rows: ToolRow[];
  failed: number;
  /** The first call — anchors the date divider. */
  turn: SpotAnalysisFollowUpTurnDto;
  /** The latest call — its time stamps the strip. */
  last: SpotAnalysisFollowUpTurnDto;
  newDay: boolean;
}

/** One passage of the agent thinking out loud. Its content GROWS between refreshes. */
export interface ThoughtEntry {
  type: 'thought';
  key: string;
  turn: SpotAnalysisFollowUpTurnDto;
}

/**
 * What sits inside a thinking block, in the order it happened: passages of narration and the
 * tool calls the agent made while narrating. Tool strips render exactly as they do outside a
 * block — folding them IN is what stops a couple of `Read` calls from cutting one train of
 * thought into three separate "Thinking" headers.
 */
export type ThinkingEntry = ThoughtEntry | ToolsItem;

/** A stretch of thinking: consecutive thought passages plus any tool calls between them. */
export interface ThinkingItem {
  type: 'thinking';
  key: string;
  entries: ThinkingEntry[];
  thoughtCount: number;
  toolCount: number;
  failed: number;
  /** The first turn of the stretch — anchors the date divider and the stable key. */
  turn: SpotAnalysisFollowUpTurnDto;
  /** The newest turn of the stretch — its time stamps the block. */
  last: SpotAnalysisFollowUpTurnDto;
  newDay: boolean;
}

/** A renderable chat item. */
export type ChatItem = TurnItem | ToolsItem | ThinkingItem;

function parseObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Case-insensitive action-status compare — the engine has written both `Pending` and `pending`. */
export function isStatus(actual: string | null | undefined, expected: string): boolean {
  return (actual ?? '').trim().toLowerCase() === expected.toLowerCase();
}

/** An action / approval still awaiting the operator. A proposal with no status yet is pending. */
export function isPendingAction(status: string | null | undefined): boolean {
  return !status || isStatus(status, 'Pending');
}

/** Parse a Tool turn's result. Never throws; a non-JSON result is kept raw. */
export function parseToolResult(json: string | null | undefined): ToolResult {
  if (!json) return { ok: null, summary: null, result: null, raw: null };
  const o = parseObject(json);
  if (!o) return { ok: null, summary: null, result: null, raw: json };
  return {
    ok: typeof o['ok'] === 'boolean' ? (o['ok'] as boolean) : null,
    summary: str(o['summary']),
    result:
      typeof o['result'] === 'string'
        ? (o['result'] as string)
        : o['result'] == null
          ? null
          : JSON.stringify(o['result'], null, 2),
    raw: json,
  };
}

/**
 * True when a Tool turn follows the harness convention: either no result at all (an agent-posted
 * turn whose content IS the record — it used to render as an empty "pulled live data" box), or a
 * result in the `{ok, summary}` shape. The spot chat's own follow-up tools return raw data and so
 * never match, which keeps their rendering unchanged outside Engineer threads.
 */
export function isHarnessToolTurn(t: SpotAnalysisFollowUpTurnDto): boolean {
  if (t.role !== 'Tool') return false;
  if (!t.toolResultJson) return true;
  const o = parseObject(t.toolResultJson);
  return !!o && typeof o['ok'] === 'boolean' && ('summary' in o || 'result' in o);
}

/**
 * A streaming-narration turn: `role: Assistant`, `toolName: "thought"`.
 *
 * The host service writes one of these while the agent thinks out loud and patches its content
 * every ~1s as tokens arrive, then patches `toolResultJson` to `{"final":true}` when that passage
 * turns out to be the answer the operator should read. The same turn is never posted twice.
 */
export function isThoughtTurn(t: SpotAnalysisFollowUpTurnDto): boolean {
  return t.role === 'Assistant' && t.toolName === 'thought';
}

/**
 * True when a `thought` turn has been marked final — it IS the answer, and renders as a normal
 * assistant message rather than inner narration.
 *
 * ASSUMPTION: a thought turn whose result is missing or unparseable is treated as NOT final. The
 * service writes `{"final":false}` from the first patch onwards, so the only way to see no payload
 * at all is a turn that has just been created — which is thinking, not an answer. Erring this way
 * keeps a mid-stream passage out of the answer column; the patch that finalises it moves it there.
 */
export function isFinalThought(t: SpotAnalysisFollowUpTurnDto): boolean {
  return parseObject(t.toolResultJson)?.['final'] === true;
}

/**
 * How a turn renders. `engineer` is true for an Engineer conversation: there every non-rec tool
 * call folds into the strip. Elsewhere only harness-shaped tool turns do.
 */
export function classifyTurn(t: SpotAnalysisFollowUpTurnDto, engineer: boolean): TurnKind {
  switch (t.role) {
    case 'User':
      return 'user';
    case 'Assistant':
      // A finalised thought is the answer: it renders exactly like any other assistant message.
      if (t.toolName === 'thought') return isFinalThought(t) ? 'assistant' : 'thought';
      if (t.toolName === 'plan') return 'plan';
      if (t.toolName === 'work_order_report') return 'report';
      if (t.toolName === 'run_notice') return 'notice';
      return 'assistant';
    case 'ActionProposal':
      return t.toolName === 'approval' ? 'approval' : 'action';
    case 'Tool':
      if (t.toolName === 'recommend' && t.toolResultJson) return 'rec';
      return engineer || isHarnessToolTurn(t) ? 'tool' : 'tool-legacy';
    default:
      return 'assistant';
  }
}

/**
 * Whether a turn opens a new calendar day and so needs a date divider above it.
 *
 * Exported separately from the component so the boundary rule can be tested directly,
 * without a TestBed. The comparison is in the VIEWER's timezone, matching what DatePipe
 * renders beside each turn: comparing the UTC dates instead would draw the divider in the
 * wrong place for anyone whose local midnight is not UTC midnight — which is everyone here,
 * the engine stores UTC and the operator reads BST.
 */
export function startsNewLocalDay(
  currentIso: string | null | undefined,
  previousIso: string | null | undefined,
): boolean {
  if (!currentIso) return false;
  // The first turn always carries the date: the reader has no earlier row to infer it from.
  if (!previousIso) return true;
  return new Date(currentIso).toDateString() !== new Date(previousIso).toDateString();
}

function newToolsItem(t: SpotAnalysisFollowUpTurnDto, row: ToolRow, newDay: boolean): ToolsItem {
  return {
    type: 'tools',
    key: `tools-${t.id}`,
    rows: [row],
    failed: row.result.ok === false ? 1 : 0,
    turn: t,
    last: t,
    newDay,
  };
}

/**
 * Fold the thread into render items.
 *
 * Two runs collapse: consecutive tool calls into one strip, and consecutive thinking passages
 * into one thinking block. Tool calls made DURING a thinking stretch are folded into that block
 * (in order) rather than ending it — otherwise a train of thought punctuated by three `Read`
 * calls would render as four separate "Thinking" headers and read as noise.
 *
 * Anything else — an answer (including a finalised thought), a plan, an approval, a report, a
 * user message — closes the open block, which is the correct reading: the narration ran up to
 * the thing it produced.
 *
 * No group ever spans a calendar day, so the date divider still lands above the right turn.
 * `previousIso` is the timestamp of whatever precedes the first turn (the opener), so the thread
 * does not draw the same date twice.
 */
export function groupTurns(
  turns: readonly SpotAnalysisFollowUpTurnDto[],
  engineer: boolean,
  previousIso: string | null = null,
): ChatItem[] {
  const items: ChatItem[] = [];
  let prev: string | null = previousIso;
  for (const t of turns) {
    const newDay = startsNewLocalDay(t.createdAtUtc, prev);
    const kind = classifyTurn(t, engineer);
    const tail = items[items.length - 1];
    if (kind === 'thought') {
      const entry: ThoughtEntry = { type: 'thought', key: `thought-${t.id}`, turn: t };
      if (tail && tail.type === 'thinking' && !newDay) {
        tail.entries.push(entry);
        tail.thoughtCount++;
        tail.last = t;
      } else {
        items.push({
          type: 'thinking',
          key: `thinking-${t.id}`,
          entries: [entry],
          thoughtCount: 1,
          toolCount: 0,
          failed: 0,
          turn: t,
          last: t,
          newDay,
        });
      }
    } else if (kind === 'tool') {
      const row: ToolRow = { turn: t, result: parseToolResult(t.toolResultJson) };
      if (tail && tail.type === 'thinking' && !newDay) {
        // Inside an open thinking block: extend its trailing strip, or start one.
        const lastEntry = tail.entries[tail.entries.length - 1];
        if (lastEntry && lastEntry.type === 'tools') {
          lastEntry.rows.push(row);
          lastEntry.last = t;
          if (row.result.ok === false) lastEntry.failed++;
        } else {
          tail.entries.push(newToolsItem(t, row, false));
        }
        tail.toolCount++;
        tail.last = t;
        if (row.result.ok === false) tail.failed++;
      } else if (tail && tail.type === 'tools' && !newDay) {
        tail.rows.push(row);
        tail.last = t;
        if (row.result.ok === false) tail.failed++;
      } else {
        items.push(newToolsItem(t, row, newDay));
      }
    } else {
      items.push({ type: 'turn', key: `turn-${t.id}`, kind, turn: t, newDay });
    }
    if (t.createdAtUtc) prev = t.createdAtUtc;
  }
  return items;
}

/** "3 tool calls · 1 failed" — the failure count only when there is one. */
export function toolStripLabel(count: number, failed: number): string {
  const calls = `${count} tool call${count === 1 ? '' : 's'}`;
  return failed > 0 ? `${calls} · ${failed} failed` : calls;
}

// ── Thinking block ────────────────────────────────────────────────────────────────────────────

/** "12 thoughts · 3 tool calls" — what a collapsed block says it is hiding. */
export function thinkingSummaryLabel(thoughts: number, tools: number, failed = 0): string {
  const parts = [`${thoughts} thought${thoughts === 1 ? '' : 's'}`];
  if (tools > 0) parts.push(toolStripLabel(tools, failed));
  return parts.join(' · ');
}

/**
 * Whether a thinking block starts expanded.
 *
 * Only the newest one, and only while the run is alive — that is the narration the operator is
 * watching. Everything older folds away so the thread reads as answers and cards, which is what
 * it is for. (The operator's own toggle overrides this; the component keeps that per block.)
 */
export function thinkingDefaultOpen(isLatest: boolean, runLive: boolean): boolean {
  return isLatest && runLive;
}

/** The newest thought passage of a block — what a live "Thinking…" affordance shows. */
export function latestThoughtText(item: ThinkingItem): string {
  for (let i = item.entries.length - 1; i >= 0; i--) {
    const e = item.entries[i];
    if (e.type === 'thought' && (e.turn.content ?? '').trim()) return e.turn.content.trim();
  }
  return '';
}

/** The last line of the newest passage — a one-line presence cue that keeps up with the stream. */
export function latestThoughtLine(item: ThinkingItem): string {
  const lines = latestThoughtText(item)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/** Index of the newest thinking block in the thread, or -1 when it has none. */
export function latestThinkingIndex(items: readonly ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'thinking') return i;
  return -1;
}

// ── Render identity (the anti-flicker rule) ───────────────────────────────────────────────────

/** Everything about a turn that changes what it renders. Timestamps and ids included. */
function sameTurn(a: SpotAnalysisFollowUpTurnDto, b: SpotAnalysisFollowUpTurnDto): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.role === b.role &&
      a.toolName === b.toolName &&
      a.content === b.content &&
      a.createdAtUtc === b.createdAtUtc &&
      a.actionStatus === b.actionStatus &&
      a.toolArgsJson === b.toolArgsJson &&
      a.toolResultJson === b.toolResultJson)
  );
}

function sameTools(a: ToolsItem, b: ToolsItem): boolean {
  if (a.key !== b.key || a.failed !== b.failed || a.rows.length !== b.rows.length) return false;
  return a.rows.every((r, i) => sameTurn(r.turn, b.rows[i].turn));
}

function sameEntry(a: ThinkingEntry, b: ThinkingEntry): boolean {
  if (a.type !== b.type) return false;
  return a.type === 'thought'
    ? sameTurn(a.turn, (b as ThoughtEntry).turn)
    : sameTools(a, b as ToolsItem);
}

/** True when two render items would produce byte-identical output. */
export function sameChatItem(a: ChatItem, b: ChatItem): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.key !== b.key || a.newDay !== b.newDay) return false;
  if (a.type === 'turn')
    return a.kind === (b as TurnItem).kind && sameTurn(a.turn, (b as TurnItem).turn);
  if (a.type === 'tools') return sameTools(a, b as ToolsItem);
  const t = b as ThinkingItem;
  return (
    a.thoughtCount === t.thoughtCount &&
    a.toolCount === t.toolCount &&
    a.failed === t.failed &&
    a.entries.length === t.entries.length &&
    a.entries.every((e, i) => sameEntry(e, t.entries[i]))
  );
}

/**
 * Keep the OBJECT IDENTITY of every item the refetch did not actually change.
 *
 * The thread is refetched on every `analysisConversationChanged` tickle, which during a streaming
 * run is about once a second. `groupTurns` builds brand-new objects from a brand-new payload every
 * time, so without this each refresh hands an OnPush child a new `item` input and the whole thread
 * re-renders once a second — the churn shows up as a flicker on tool strips, plan cards and rec
 * charts, and it is why the `trackBy` key alone is not enough.
 *
 * Returns the PREVIOUS array itself when nothing changed at all, so the `computed` that wraps this
 * can hand the template the same reference and the `@for` does no work either.
 */
export function reuseUnchangedItems(prev: readonly ChatItem[], next: ChatItem[]): ChatItem[] {
  if (prev.length === 0) return next;
  const byKey = new Map(prev.map((i) => [i.key, i]));
  let reused = 0;
  const out = next.map((item) => {
    const old = byKey.get(item.key);
    if (old && sameChatItem(old, item)) {
      reused++;
      return old;
    }
    return item;
  });
  return reused === next.length && prev.length === next.length ? (prev as ChatItem[]) : out;
}

// ── Plan card ─────────────────────────────────────────────────────────────────────────────────

export type PlanTaskState = 'done' | 'todo' | 'doing';

export interface PlanTask {
  state: PlanTaskState;
  text: string;
  /** Nesting level (0 = top). */
  depth: number;
}

export type PlanBlock = { type: 'md'; text: string } | { type: 'tasks'; tasks: PlanTask[] };

export interface ParsedPlan {
  blocks: PlanBlock[];
  done: number;
  total: number;
}

const PLAN_TASK = /^(\s*)[-*+]\s+\[([ xX~])\]\s+(.*)$/;

/**
 * Split a plan turn into prose blocks and task lists. Task lines (`- [x]`, `- [ ]`, `- [~]`)
 * become structured tasks so the card can style the three states — the shared markdown renderer
 * only knows the two GFM ones and would print `[~]` literally.
 */
export function parsePlan(content: string | null | undefined): ParsedPlan {
  const blocks: PlanBlock[] = [];
  let prose: string[] = [];
  let done = 0;
  let total = 0;
  const flushProse = () => {
    const text = prose.join('\n').trim();
    if (text) blocks.push({ type: 'md', text });
    prose = [];
  };
  for (const line of (content ?? '').split('\n')) {
    const m = PLAN_TASK.exec(line);
    if (!m) {
      prose.push(line);
      continue;
    }
    flushProse();
    const mark = m[2];
    const state: PlanTaskState = mark === '~' ? 'doing' : mark === ' ' ? 'todo' : 'done';
    const indent = m[1].replace(/\t/g, '    ').length;
    const task: PlanTask = { state, text: m[3].trim(), depth: Math.min(Math.floor(indent / 2), 4) };
    total++;
    if (state === 'done') done++;
    const tail = blocks[blocks.length - 1];
    if (tail && tail.type === 'tasks') tail.tasks.push(task);
    else blocks.push({ type: 'tasks', tasks: [task] });
  }
  flushProse();
  return { blocks, done, total };
}

// ── Approval card ─────────────────────────────────────────────────────────────────────────────

export interface ParsedApproval {
  approvalId: string | null;
  verb: string | null;
  targets: string[];
  sideEffect: string | null;
  live: boolean;
  requestedAtUtc: string | null;
  /** From the resolution payload, once resolved. */
  resolvedAtUtc: string | null;
}

export function parseApproval(t: SpotAnalysisFollowUpTurnDto): ParsedApproval {
  const a = parseObject(t.toolArgsJson) ?? {};
  const r = parseObject(t.toolResultJson) ?? {};
  const targets = Array.isArray(a['targets'])
    ? (a['targets'] as unknown[]).filter((x) => x != null).map((x) => String(x))
    : [];
  return {
    approvalId: str(a['approvalId']),
    verb: str(a['verb']),
    targets,
    sideEffect: str(a['sideEffect']),
    live: a['live'] === true,
    requestedAtUtc: str(a['requestedAtUtc']),
    resolvedAtUtc: str(r['resolvedAtUtc']),
  };
}

/** Status chip text + tone for a resolved approval. */
export function approvalStatus(status: string | null | undefined): {
  label: string;
  tone: 'ok' | 'bad' | 'muted' | 'pending';
} {
  if (isPendingAction(status)) return { label: 'Pending', tone: 'pending' };
  if (isStatus(status, 'Approved')) return { label: 'Approved', tone: 'ok' };
  if (isStatus(status, 'Rejected')) return { label: 'Rejected', tone: 'bad' };
  if (isStatus(status, 'Expired')) return { label: 'Expired', tone: 'muted' };
  return { label: status ?? '', tone: 'muted' };
}

// ── Work-order report ─────────────────────────────────────────────────────────────────────────

export interface LiveChange {
  kind: string;
  ref: string;
  description: string;
  atUtc: string | null;
}

export interface ParsedReport {
  outcome: 'done' | 'partial' | 'blocked' | null;
  /** Null when the report did not carry the list at all (distinct from an explicit empty list). */
  liveChanges: LiveChange[] | null;
  openItems: string[];
  nextCheck: string | null;
}

export function parseReport(t: SpotAnalysisFollowUpTurnDto): ParsedReport {
  const o = parseObject(t.toolResultJson);
  if (!o) return { outcome: null, liveChanges: null, openItems: [], nextCheck: null };
  const outcomeRaw = (str(o['outcome']) ?? '').toLowerCase();
  const outcome =
    outcomeRaw === 'done' || outcomeRaw === 'partial' || outcomeRaw === 'blocked'
      ? outcomeRaw
      : null;
  const liveChanges = Array.isArray(o['liveChanges'])
    ? (o['liveChanges'] as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          kind: str(c['kind']) ?? '',
          ref: str(c['ref']) ?? '',
          description: str(c['description']) ?? '',
          atUtc: str(c['atUtc']),
        }))
    : null;
  const openItems = Array.isArray(o['openItems'])
    ? (o['openItems'] as unknown[]).filter((x) => typeof x === 'string').map((x) => x as string)
    : [];
  return { outcome, liveChanges, openItems, nextCheck: str(o['nextCheck']) };
}

// ── Run notice ────────────────────────────────────────────────────────────────────────────────

const NOTICE_LABELS: Record<string, string> = {
  stopped: 'Run stopped',
  failed: 'Run failed',
  max_steps: 'Step limit reached',
  budget: 'Budget exhausted',
  interrupted: 'Run interrupted',
  watch_fired: 'Watch fired',
  checkpoint: 'Checkpoint',
};

export function parseRunNotice(t: SpotAnalysisFollowUpTurnDto): { kind: string; label: string } {
  const kind = (str(parseObject(t.toolResultJson)?.['kind']) ?? '').toLowerCase();
  return { kind, label: NOTICE_LABELS[kind] ?? 'Notice' };
}

// ── Run state (header) ────────────────────────────────────────────────────────────────────────

/** Statuses during which a run is alive and can be stopped. */
const LIVE_STATUSES = new Set(['working', 'waitingforoperator', 'watching']);

/** Working / WaitingForOperator / Watching — the run holds the conversation and Stop applies. */
export function isRunLive(status: string | null | undefined): boolean {
  return LIVE_STATUSES.has((status ?? '').toLowerCase());
}

export type RunTone = 'working' | 'waiting' | 'watching' | 'done' | 'stopped' | 'failed' | 'idle';

export function runStatusLabel(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case '':
      return 'Idle';
    case 'working':
      return 'Working';
    case 'waitingforoperator':
      return 'Waiting for you';
    case 'watching':
      return 'Watching';
    case 'done':
      return 'Done';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
    case 'stale':
      return 'Stale';
    default:
      return status ?? 'Idle';
  }
}

export function runStatusTone(status: string | null | undefined): RunTone {
  switch ((status ?? '').toLowerCase()) {
    case 'working':
      return 'working';
    case 'waitingforoperator':
      return 'waiting';
    case 'watching':
      return 'watching';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'stale':
      return 'stopped';
    default:
      return 'idle';
  }
}

/** `42s` · `3m 05s` · `1h 02m` — compact, and stable in width as it ticks. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Run duration: to `now` while the run is Working (the header ticks), otherwise to when it ended —
 * or, for a run that is waiting/watching/stale and has no end, to its last update.
 */
export function runElapsedMs(
  run: {
    status: string;
    startedAtUtc: string;
    updatedAtUtc?: string | null;
    endedAtUtc?: string | null;
  },
  nowMs: number,
): number {
  const start = Date.parse(run.startedAtUtc);
  if (!Number.isFinite(start)) return 0;
  if ((run.status ?? '').toLowerCase() === 'working' && !run.endedAtUtc) return nowMs - start;
  const end = Date.parse(run.endedAtUtc ?? run.updatedAtUtc ?? '');
  return Number.isFinite(end) ? end - start : nowMs - start;
}

/** `$0.42` below a dollar gets cents; small amounts keep enough precision to be non-zero. */
export function formatUsd(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '$0.00';
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export interface CapabilityChip {
  label: string;
  on: boolean;
  title: string;
}

/** Chips from `capabilitiesJson`: read-only first (it overrides the rest), then each gate, then model. */
export function parseCapabilities(json: string | null | undefined): CapabilityChip[] {
  const o = parseObject(json);
  if (!o) return [];
  const chips: CapabilityChip[] = [];
  if (o['readOnly'] === true)
    chips.push({ label: 'Read-only', on: true, title: 'This order may not change anything live' });
  const gate = (key: string, label: string, what: string) => {
    if (typeof o[key] !== 'boolean') return;
    const on = o[key] === true && o['readOnly'] !== true;
    chips.push({ label, on, title: `${what}: ${on ? 'allowed' : 'not allowed'}` });
  };
  gate('mlControl', 'ML control', 'Train / control ML models');
  gate('configWrite', 'Config write', 'Write engine config');
  gate('promote', 'Promote', 'Promote models / changes live');
  const model = str(o['model']);
  if (model) chips.push({ label: model, on: true, title: 'Model' });
  return chips;
}

export interface WatchChip {
  id: string;
  label: string;
  title: string;
  nextCheckAtUtc: string | null;
  /** What is being watched, spaced for prose: `training run`. */
  kind: string;
  /** How many things this watch covers (its `ids`, or 1 when it names none). */
  count: number;
}

/** One chip per `watchesJson` entry: `training_run 75961`, with the note as a tooltip. */
export function parseWatches(json: string | null | undefined): WatchChip[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
    .map((w, i) => {
      const kind = (str(w['kind']) ?? 'watch').replace(/_/g, ' ');
      const ids = Array.isArray(w['ids']) ? (w['ids'] as unknown[]).map((x) => String(x)) : [];
      const note = str(w['note']);
      const next = str(w['nextCheckAtUtc']);
      return {
        id: str(w['id']) ?? `w-${i}`,
        label: ids.length ? `${kind} ${ids.join(', ')}` : kind,
        title: [note, next ? `next check ${new Date(next).toLocaleString()}` : null]
          .filter(Boolean)
          .join(' · '),
        nextCheckAtUtc: next,
        kind,
        count: Math.max(ids.length, 1),
      };
    });
}

// ── Presence line ─────────────────────────────────────────────────────────────────────────────

function pluralise(noun: string, n: number): string {
  if (n === 1) return noun;
  return /(s|x|z|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`;
}

/** "Watching 4 training runs" — null when the run holds no watches. */
export function watchesSummary(json: string | null | undefined): string | null {
  const chips = parseWatches(json);
  if (chips.length === 0) return null;
  const total = chips.reduce((n, c) => n + c.count, 0);
  const kinds = new Set(chips.map((c) => c.kind));
  const noun = kinds.size === 1 ? [...kinds][0] : 'watch';
  return `Watching ${total} ${pluralise(noun, total)}`;
}

/**
 * The agent's `activity` as presence rather than as a field.
 *
 * The host writes either a sentence ("Reading training diagnostics…") or the bare name of what it
 * is running ("pnl_sim"). A bare identifier reads as a fragment in a status line, so it becomes
 * "Running pnl_sim…"; a sentence is left exactly as written.
 */
export function describeActivity(activity: string | null | undefined): string | null {
  const a = (activity ?? '').trim();
  if (!a) return null;
  return /^[A-Za-z][\w.:-]*$/.test(a) ? `Running ${a}…` : a;
}

export interface RunPresence {
  /** What the operator reads: "Thinking…", "Running pnl_sim…", "Waiting for you". */
  text: string;
  /** True while the run is alive — the pulsing affordance and the live thinking block. */
  live: boolean;
}

/**
 * One line that says what the agent is doing now, from the run-state fields.
 *
 * Working with nothing to say is still "Thinking…": a live run always has presence, and a blank
 * line would read as a stall.
 */
export function runPresence(
  run: {
    status: string;
    activity?: string | null;
    stopReason?: string | null;
    watchesJson?: string | null;
  } | null,
): RunPresence {
  if (!run) return { text: 'Idle', live: false };
  const status = (run.status ?? '').toLowerCase();
  const activity = describeActivity(run.activity);
  const live = isRunLive(run.status);
  switch (status) {
    case 'working':
      return { text: activity ?? 'Thinking…', live };
    case 'waitingforoperator':
      return { text: activity ? `Waiting for you — ${activity}` : 'Waiting for you', live };
    case 'watching':
      return { text: watchesSummary(run.watchesJson) ?? activity ?? 'Watching', live };
    case 'stale':
      return { text: 'Stalled — no report for 15 minutes', live: false };
    default:
      return { text: run.stopReason?.trim() || activity || runStatusLabel(run.status), live };
  }
}

/** Composer hint chips for an Engineer thread. `stop` calls the Stop endpoint instead of sending. */
export const ENGINEER_HINTS: ReadonlyArray<{ label: string; send: string | null }> = [
  { label: 'continue', send: 'continue' },
  { label: 'stop', send: null },
  { label: 'what changed live?', send: 'what changed live?' },
  { label: 'status?', send: 'status?' },
];
