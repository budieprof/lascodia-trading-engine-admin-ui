/**
 * Decisions for the Assistant page (health + lessons), kept out of the components so they can be
 * tested exactly. Rules mirror the engine:
 *  - `ReviewAssistantLessonCommandHandler`: approve from ANY state (re-approve = edit, approve a
 *    rejected / retired one = restore), reject a Candidate only, retire an Approved one only.
 *  - `ReviewAssistantLessonCommandValidator`: text ≤ 2000, scopeValue ≤ 200, note ≤ 1000, and a
 *    scope value unless the scope is global.
 *  - `AssistantHealthRules`: alert keys `assistant-health:{unverified-rate|tool-errors:<tool>|turn-p95|spend-guard}`.
 */
import type {
  AssistantHealthAlertRow,
  AssistantHealthThresholds,
  AssistantMetrics,
  AssistantLesson,
  AssistantLessonReviewAction,
  AssistantLessonReviewBody,
  AssistantTurnStats,
} from './assistant-ops.types';

// ── Lessons ─────────────────────────────────────────────────────────────────

export const LESSON_STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Candidate', label: 'Waiting for review' },
  { value: 'Approved', label: 'In use' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Retired', label: 'Retired' },
  { value: '', label: 'All' },
];

export const LESSON_SOURCES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'card_rejection', label: 'Rejected approval card' },
  { value: 'correction', label: 'Operator correction' },
  { value: 'gate_exhausted', label: 'Answer posted unverified' },
  { value: 'manual', label: 'Added by an operator' },
  { value: 'seed', label: 'Shipped with the engine' },
];

export const LESSON_SCOPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'global', label: 'Everywhere' },
  { value: 'route', label: 'On pages starting with' },
  { value: 'tool', label: 'When it uses the tool' },
  { value: 'operation', label: 'When it calls the operation' },
  { value: 'symbol', label: 'For the symbol' },
];

export const TEXT_MAX = 2000;
export const SCOPE_VALUE_MAX = 200;
export const NOTE_MAX = 1000;
/** Rejecting or retiring asks for a reason: it is the only record of why guidance was dropped. */
export const REASON_MIN = 3;

/** What an operator can do to a lesson; `action` is the engine endpoint it calls. */
export type LessonActionKind = 'approve' | 'edit' | 'restore' | 'reject' | 'retire';

export interface LessonAction {
  kind: LessonActionKind;
  action: AssistantLessonReviewAction;
  label: string;
  /** Destructive-looking button. */
  danger: boolean;
}

const ACTIONS: Record<LessonActionKind, LessonAction> = {
  approve: { kind: 'approve', action: 'approve', label: 'Approve', danger: false },
  edit: { kind: 'edit', action: 'approve', label: 'Edit', danger: false },
  restore: { kind: 'restore', action: 'approve', label: 'Restore', danger: false },
  reject: { kind: 'reject', action: 'reject', label: 'Reject', danger: true },
  retire: { kind: 'retire', action: 'retire', label: 'Retire', danger: true },
};

/** The buttons a lesson in this status offers — exactly the transitions the engine accepts. */
export function lessonActions(status: string): LessonAction[] {
  switch (status) {
    case 'Candidate':
      return [ACTIONS.approve, ACTIONS.reject];
    case 'Approved':
      return [ACTIONS.edit, ACTIONS.retire];
    case 'Rejected':
    case 'Retired':
      return [ACTIONS.restore];
    default:
      return [];
  }
}

/** The review dialog's fields. */
export interface ReviewForm {
  text: string;
  scopeKind: string;
  scopeValue: string;
  note: string;
}

export function reviewFormFor(lesson: AssistantLesson): ReviewForm {
  return {
    text: lesson.text,
    scopeKind: lesson.scopeKind || 'global',
    scopeValue: lesson.scopeValue ?? '',
    note: '',
  };
}

export function needsReason(kind: LessonActionKind): boolean {
  return kind === 'reject' || kind === 'retire';
}

export function editsText(kind: LessonActionKind): boolean {
  return kind === 'approve' || kind === 'edit' || kind === 'restore';
}

/** The first thing wrong with the form, in plain words, or null when it can be sent. */
export function reviewProblem(kind: LessonActionKind, form: ReviewForm): string | null {
  const note = form.note.trim();
  if (needsReason(kind) && note.length < REASON_MIN)
    return kind === 'reject'
      ? 'Say why this lesson is wrong — it is the only record of the decision.'
      : 'Say why this lesson should stop reaching the assistant.';
  if (note.length > NOTE_MAX)
    return `The reason is too long (${note.length} of ${NOTE_MAX} characters).`;
  if (editsText(kind)) {
    const text = form.text.trim();
    if (!text) return 'The lesson needs some text.';
    if (text.length > TEXT_MAX)
      return `The lesson is too long (${text.length} of ${TEXT_MAX} characters).`;
    if (!LESSON_SCOPES.some((s) => s.value === form.scopeKind))
      return 'Pick where the lesson applies.';
    const value = form.scopeValue.trim();
    if (form.scopeKind !== 'global' && !value)
      return 'Say which page, tool, operation or symbol it applies to.';
    if (value.length > SCOPE_VALUE_MAX)
      return `The scope is too long (${value.length} of ${SCOPE_VALUE_MAX} characters).`;
  }
  return null;
}

/**
 * The request body. Approve sends text / scope only when they changed (the engine keeps the
 * lesson's own otherwise) and the note only when given; reject / retire send the note alone.
 */
export function reviewBody(
  kind: LessonActionKind,
  form: ReviewForm,
  lesson: AssistantLesson,
): AssistantLessonReviewBody {
  const body: AssistantLessonReviewBody = {};
  const note = form.note.trim();
  if (note) body.note = note;
  if (!editsText(kind)) return body;

  const text = form.text.trim();
  if (text !== lesson.text.trim()) body.text = text;
  const kindChanged = form.scopeKind !== (lesson.scopeKind || 'global');
  const value = form.scopeKind === 'global' ? '' : form.scopeValue.trim();
  const valueChanged = value !== (lesson.scopeValue ?? '').trim();
  if (kindChanged || valueChanged) {
    body.scopeKind = form.scopeKind;
    if (form.scopeKind !== 'global') body.scopeValue = value;
  }
  return body;
}

/** Toast after a successful review. */
export function reviewDoneMessage(kind: LessonActionKind, lesson: AssistantLesson): string {
  switch (kind) {
    case 'approve':
      return `Lesson #${lesson.id} approved — the assistant uses it from its next question.`;
    case 'edit':
      return `Lesson #${lesson.id} updated.`;
    case 'restore':
      return `Lesson #${lesson.id} restored — the assistant uses it again.`;
    case 'reject':
      return `Lesson #${lesson.id} rejected.`;
    case 'retire':
      return `Lesson #${lesson.id} retired — the assistant no longer sees it.`;
  }
}

export function dialogTitle(kind: LessonActionKind, lesson: AssistantLesson): string {
  const verb = {
    approve: 'Approve',
    edit: 'Edit',
    restore: 'Restore',
    reject: 'Reject',
    retire: 'Retire',
  }[kind];
  return `${verb} lesson #${lesson.id}`;
}

export function dialogMessage(kind: LessonActionKind): string {
  switch (kind) {
    case 'approve':
      return 'Approved lessons are added to what the assistant is told before it answers. Edit the wording or where it applies first if needed.';
    case 'edit':
      return 'The assistant already uses this lesson. Changes apply from its next question.';
    case 'restore':
      return 'Restoring approves the lesson again, so the assistant starts using it.';
    case 'reject':
      return 'The lesson is kept on record but never reaches the assistant.';
    case 'retire':
      return 'The assistant stops using this lesson. It stays on record and can be restored.';
  }
}

export function sourceLabel(source: string): string {
  return LESSON_SOURCES.find((s) => s.value === source)?.label ?? source;
}

export function statusLabel(status: string): string {
  return status === 'Candidate' ? 'Waiting for review' : status === 'Approved' ? 'In use' : status;
}

export function statusTone(status: string): 'warn' | 'ok' | 'muted' | 'bad' {
  return status === 'Candidate'
    ? 'warn'
    : status === 'Approved'
      ? 'ok'
      : status === 'Rejected'
        ? 'bad'
        : 'muted';
}

export function scopeLabel(kind: string, value: string | null): string {
  if (!kind || kind === 'global') return 'Everywhere';
  const what =
    { route: 'Pages', tool: 'Tool', operation: 'Operation', symbol: 'Symbol' }[kind] ?? kind;
  return `${what}: ${value ?? '—'}`;
}

/** `admin-user:12` → `Operator #12`; engine-made lessons have no person. */
export function personLabel(who: string | null, name?: string | null): string {
  if (name && name.trim()) return name.trim();
  if (!who) return '—';
  const m = /^admin-user:(.+)$/.exec(who);
  return m ? `Operator #${m[1]}` : who;
}

// ── Health ──────────────────────────────────────────────────────────────────

export const WINDOWS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: 'Last 24 h' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];

export type Split = 'all' | 'operator' | 'headless';

export const SPLITS: ReadonlyArray<{ value: Split; label: string }> = [
  { value: 'operator', label: 'Operator questions' },
  { value: 'headless', label: 'Run by the engine' },
  { value: 'all', label: 'Everything' },
];

/** 0.1234 → "12.3%"; a ratio with nothing behind it → "—". */
export function pct(ratio: number | null | undefined, denominator = 1): string {
  if (ratio == null || !Number.isFinite(ratio) || denominator <= 0) return '—';
  const v = ratio * 100;
  return `${v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** Seconds as "45 s" / "3.2 min". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 90) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

export function ms(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/** 1_234_567 → "1.2M". */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

/** "a: 3 · b: 1", largest first; empty → "—". */
export function countsText(counts: Record<string, number> | null | undefined): string {
  const entries = Object.entries(counts ?? {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return '—';
  return entries
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([k, v]) => `${humanise(k)}: ${v}`)
    .join(' · ');
}

/** `write_proposed` → "write proposed". */
export function humanise(key: string): string {
  return key.replace(/_/g, ' ');
}

/** The window has nothing to report (no question ran). */
export function isQuiet(s: AssistantTurnStats | null | undefined): boolean {
  return !s || (s.turns === 0 && s.spendGuardTrips === 0);
}

/** An active health alert, in words. */
export interface HealthBreach {
  key: string;
  title: string;
  detail: string;
  severity: string;
  since: string | null;
}

const SEVERITIES = ['Info', 'Low', 'Medium', 'High', 'Critical'];

/**
 * Turn one active `AssistantHealth` alert into a sentence. The alert row keeps only the rule's
 * condition (the dispatched message is not stored), so the words are rebuilt from it.
 */
export function breachFromAlert(a: AssistantHealthAlertRow): HealthBreach {
  const key = a.deduplicationKey ?? '';
  let condition: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(a.conditionJson || '{}') as { condition?: unknown };
    if (parsed && typeof parsed.condition === 'object' && parsed.condition !== null)
      condition = parsed.condition as Record<string, unknown>;
  } catch {
    /* keep the generic sentence */
  }
  const num = (k: string): number | null =>
    typeof condition[k] === 'number' ? (condition[k] as number) : null;
  const severity =
    typeof a.severity === 'number' ? (SEVERITIES[a.severity] ?? String(a.severity)) : a.severity;
  const base = { key, severity, since: a.lastTriggeredAt };
  const rule = key.replace(/^assistant-health:/, '');

  if (rule === 'unverified-rate') {
    return {
      ...base,
      title: 'Too many answers posted unverified',
      detail:
        `${num('Unverified') ?? '?'} of ${num('AnswerAttempts') ?? '?'} answers (${pct(num('rate'))}) went out ` +
        `with a check still objecting; the limit is ${num('threshold') ?? '?'}%. The figures in them could not ` +
        'be traced to something the assistant read.',
    };
  }
  if (rule.startsWith('tool-errors:')) {
    const tool = (condition['Tool'] as string) || rule.slice('tool-errors:'.length);
    return {
      ...base,
      title: `The ${tool} tool keeps failing`,
      detail: `${num('Errors') ?? '?'} of ${num('Calls') ?? '?'} calls failed (${pct(num('rate'))}); the limit is ${num('threshold') ?? '?'}%.`,
    };
  }
  if (rule === 'turn-p95') {
    return {
      ...base,
      title: 'Operator questions are slow',
      detail: `The slowest 5% took ${duration(num('p95'))} or more (typical ${duration(num('p50'))}); the limit is ${duration(num('threshold'))}.`,
    };
  }
  if (rule === 'spend-guard') {
    return {
      ...base,
      title: 'The spend guard refused questions',
      detail: `${num('trips') ?? '?'} question(s) hit a token, call or dollar ceiling for a conversation or the day.`,
    };
  }
  return {
    ...base,
    title: 'Assistant health alert',
    detail: key || 'An assistant health threshold was crossed.',
  };
}

// ── Thresholds and breaches over the requested window (engine 3f04f4b1+) ────

/** The engine defaults (`LlmOptions.AssistantAlert*`), used when the engine does not send its own. */
export const DEFAULT_THRESHOLDS: AssistantHealthThresholds = {
  unverifiedRatePct: 30,
  toolErrorRatePct: 40,
  turnP95Seconds: 900,
  spendGuardTrips: 1,
  minTurns: 10,
  toolMinCalls: 20,
};

export function thresholdsOf(m: AssistantMetrics | null | undefined): AssistantHealthThresholds {
  return m?.thresholds ?? DEFAULT_THRESHOLDS;
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/**
 * Tone of a "lower is better" figure against an engine limit: bad over the limit, warn from
 * half of it, good below. Neutral when the rule is off (limit 0) or there is no evidence yet.
 */
export function toneAgainst(value: number, limit: number, hasEvidence: boolean): Tone {
  if (!limit || limit <= 0 || !hasEvidence) return 'neutral';
  if (value > limit) return 'bad';
  if (value >= limit / 2) return 'warn';
  return 'good';
}

/**
 * Whether the metrics answer carries the engine's own verdict for the window. An older engine
 * has no `breaches` field; one that could not read its options sends `[]` with null thresholds —
 * both mean "fall back to the open alerts".
 */
export function hasWindowVerdict(m: AssistantMetrics | null | undefined): boolean {
  return !!m && Array.isArray(m.breaches) && m.thresholds != null;
}

/**
 * One crossed threshold of this window, in plain words. The engine's own message names config
 * keys and endpoints, so the known rules are rewritten from the window's figures; an unknown
 * rule shows the engine's message as it is.
 */
export function breachFromMetrics(
  b: { key: string; severity: string; message: string },
  m: AssistantMetrics,
): HealthBreach {
  const t = thresholdsOf(m);
  const op = m.operator;
  const rule = b.key.replace(/^assistant-health:/, '');
  const base = { key: b.key, severity: b.severity, since: null };
  if (rule === 'unverified-rate')
    return {
      ...base,
      title: 'Too many answers posted unverified',
      detail:
        `${op.unverified} of ${op.answerAttempts} operator answers (${pct(op.unverifiedRate)}) went out with a ` +
        `check still objecting; the limit is ${t.unverifiedRatePct}%. The figures in them could not be traced ` +
        'to something the assistant read.',
    };
  if (rule.startsWith('tool-errors:')) {
    const name = rule.slice('tool-errors:'.length);
    const tool = m.tools.find((x) => x.tool === name);
    return {
      ...base,
      title: `The ${name} tool keeps failing`,
      detail: tool
        ? `${tool.errors} of ${tool.calls} calls failed (${pct(tool.errorRate)}); the limit is ${t.toolErrorRatePct}%.` +
          (countsText(tool.errorClasses) !== '—'
            ? ` Most often: ${countsText(tool.errorClasses)}.`
            : '')
        : b.message,
    };
  }
  if (rule === 'turn-p95')
    return {
      ...base,
      title: 'Operator questions are slow',
      detail: `The slowest 5% took ${duration(op.wallP95Seconds)} or more (typical ${duration(op.wallP50Seconds)}); the limit is ${duration(t.turnP95Seconds)}.`,
    };
  if (rule === 'spend-guard')
    return {
      ...base,
      title: 'The spend guard refused questions',
      detail: `${m.all.spendGuardTrips} question(s) hit a token, call or dollar ceiling for a conversation or the day.`,
    };
  return { ...base, title: 'Assistant health alert', detail: b.message || b.key };
}
