/**
 * Live progress of a long assistant question (engine realtime event `assistantProgress`, and the
 * snapshot `GET market-data/analyze/{llmInvocationId}/progress` for a thread opened mid-question):
 *
 *   { llmInvocationId, questionTurnId, phase: thinking|reading|checking|proposing|answering|waiting|done,
 *     round, tools:[{name, label}], message, model, escalated, atUtc }
 *
 * Pure reducer + wording, so the rules (filter by conversation, never go back to an older event,
 * hide on done) are unit-tested.
 */

export type ProgressPhase =
  | 'thinking'
  | 'reading'
  | 'checking'
  | 'proposing'
  | 'answering'
  | 'waiting'
  | 'done';

export interface AssistantProgressEvent {
  llmInvocationId: number;
  questionTurnId?: number | null;
  phase: ProgressPhase | string;
  round?: number | null;
  tools?: { name: string; label?: string | null }[] | null;
  message?: string | null;
  model?: string | null;
  escalated?: boolean | null;
  atUtc?: string | null;
}

export interface ProgressState {
  event: AssistantProgressEvent;
  /** When this question's first event was seen (ms) — the elapsed-time fallback. */
  firstSeenMs: number;
  /** When the current event arrived (ms) — a `waiting` line fades after {@link WAITING_HIDE_MS}. */
  receivedMs: number;
}

/**
 * The engine sends no `done` after `waiting` until the last pending card is resolved (a `done`
 * follows then), so the line hides itself shortly after a `waiting` — the cards say the rest.
 */
export const WAITING_HIDE_MS = 6000;

/** Whether the state still has a line to show at `nowMs`. */
export function progressVisible(state: ProgressState | null, nowMs: number): boolean {
  if (!state) return false;
  if (state.event.phase === 'waiting') return nowMs - state.receivedMs < WAITING_HIDE_MS;
  return true;
}

/** Fold one event into the state for the open conversation. Null = nothing to show. */
export function reduceProgress(
  state: ProgressState | null,
  ev: AssistantProgressEvent | null | undefined,
  openId: number | null | undefined,
  nowMs: number,
): ProgressState | null {
  if (!ev || !openId || ev.llmInvocationId !== openId) return state;
  if (state) {
    // A late, older event of the same question must not rewind the line.
    const sameQ = (state.event.questionTurnId ?? null) === (ev.questionTurnId ?? null);
    const prevAt = Date.parse(state.event.atUtc ?? '');
    const at = Date.parse(ev.atUtc ?? '');
    if (sameQ && Number.isFinite(prevAt) && Number.isFinite(at) && at < prevAt) return state;
  }
  if (ev.phase === 'done') return null;
  const sameQuestion =
    state !== null && (state.event.questionTurnId ?? null) === (ev.questionTurnId ?? null);
  return { event: ev, firstSeenMs: sameQuestion ? state.firstSeenMs : nowMs, receivedMs: nowMs };
}

const PHASE_WORDS: Record<string, string> = {
  thinking: 'Thinking',
  reading: 'Reading engine data',
  checking: 'Checking its answer',
  proposing: 'Preparing a change for you to approve',
  answering: 'Writing the answer',
  waiting: 'Waiting for you',
};

export interface ProgressLine {
  text: string;
  tools: string[];
  modelNote: string | null;
  round: number | null;
}

/**
 * "using the quick model" / "handed to the main model". The engine sets `model` (sonnet / haiku /
 * opus) only while the question is routed to the smaller, quicker model; it is null on the main
 * model and after an escalation (`escalated`).
 */
export function modelNote(ev: Pick<AssistantProgressEvent, 'model' | 'escalated'>): string | null {
  if (ev.escalated) return 'handed to the main model';
  const m = (ev.model ?? '').trim();
  return m ? `using the quick model (${m})` : null;
}

export function progressLine(ev: AssistantProgressEvent): ProgressLine {
  const msg = (ev.message ?? '').trim();
  const text = msg || PHASE_WORDS[ev.phase] || 'Working';
  const tools = (ev.tools ?? [])
    .map((t) => (t.label ?? '').trim() || t.name)
    .filter((t): t is string => !!t)
    .slice(0, 6);
  return {
    text: text.endsWith('…') ? text : `${text}…`,
    tools,
    modelNote: modelNote(ev),
    round: typeof ev.round === 'number' && ev.round > 0 ? ev.round : null,
  };
}

/** "42 s" / "3 min 05 s". */
export function elapsedText(fromMs: number | null, nowMs: number): string {
  if (fromMs == null || !Number.isFinite(fromMs)) return '';
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
