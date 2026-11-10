/**
 * Approval-card safety, as pure decisions (engine `AdminAssistant/Safety`):
 *
 * - **Provenance** — `args.provenance = {untrusted, sources:[{kind, source}], kinds, highImpact,
 *   requiresAcknowledgement, note}`. The assistant read text written OUTSIDE the engine (a news
 *   article, a web page, an attachment) before proposing the card. When `requiresAcknowledgement`,
 *   the engine refuses the confirm (-23) unless the body says `acknowledgeUntrusted: true` — so the
 *   Approve button stays disabled until the operator ticks the check.
 * - **Undo** — `args.undo` recorded at confirm: `{available:true, status, label, expiresAtUtc,
 *   undoneAtUtc, undoneBy, undoReason, error}` or `{available:false, reason}`.
 *   `POST market-data/analyze/follow-up/{turnId}/undo {reason}` replays the inverse; -24 = not
 *   possible any more, -25 = it partly failed.
 */
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/** The engine refused a confirm because the untrusted-text acknowledgement was missing. */
export const ACK_REQUIRED_CODE = '-23';
/** Undo refused: no inverse, the window passed, or the target changed since. */
export const UNDO_NOT_POSSIBLE_CODE = '-24';
/** Undo ran but did not complete. */
export const UNDO_PARTLY_FAILED_CODE = '-25';

export const ACK_LABEL = "I've checked this isn't based on misleading outside text";

function parse(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ── Provenance ───────────────────────────────────────────────────────────────

export interface ProvenanceView {
  /** "Proposed after reading outside text (news, web page)". */
  label: string;
  /** Hover text: every source and the engine's note. */
  title: string;
  sources: { kind: string; source: string }[];
  highImpact: boolean;
  requiresAck: boolean;
}

/** The engine's kinds (`AssistantProvenance`), in plain words. */
const KIND_WORDS: Record<string, string> = {
  news: 'news',
  economic: 'economic calendar',
  web: 'web',
  url: 'a web page',
  llm_output: 'earlier model output',
  conversation: 'another conversation',
  conversation_recall: 'an earlier conversation',
  recall: 'an earlier conversation',
  attachment: 'an attachment',
  attachments: 'attachments',
  screenshot: 'a screenshot',
  page_context: 'page text',
  page_command: 'page text',
  sql: 'stored outside text',
  unknown: 'outside text',
  external: 'outside text',
};

export function kindWord(kind: string): string {
  return KIND_WORDS[kind.toLowerCase()] ?? kind.replace(/[_-]/g, ' ');
}

/** The provenance badge of a card, or null when it was not proposed after reading outside text. */
export function provenanceOf(toolArgsJson: string | null | undefined): ProvenanceView | null {
  const p = obj(parse(toolArgsJson)?.['provenance']);
  if (!p || p['untrusted'] !== true) return null;
  const sources = (Array.isArray(p['sources']) ? p['sources'] : [])
    .map((s) => obj(s))
    .filter((s): s is Record<string, unknown> => !!s)
    .map((s) => ({ kind: str(s['kind']) ?? 'external', source: str(s['source']) ?? '' }));
  const kinds = [
    ...new Set(
      (Array.isArray(p['kinds']) ? p['kinds'] : sources.map((s) => s.kind))
        .map((k) => str(k))
        .filter((k): k is string => !!k),
    ),
  ];
  const words = kinds.map(kindWord);
  const label = words.length
    ? `Proposed after reading outside text (${words.join(', ')})`
    : 'Proposed after reading outside text';
  const lines = [
    'The assistant read text written outside the engine before proposing this. Such text can be ' +
      'wrong, or carry instructions disguised as data — check that this change is what you want.',
  ];
  for (const s of sources) lines.push(`• ${kindWord(s.kind)}${s.source ? `: ${s.source}` : ''}`);
  const note = str(p['note']);
  if (note) lines.push(note);
  const requiresAck = p['requiresAcknowledgement'] === true;
  if (requiresAck) lines.push('This is a high-impact change: tick the check to approve it.');
  return {
    label,
    title: lines.join('\n'),
    sources,
    highImpact: p['highImpact'] === true,
    requiresAck,
  };
}

/** Approve is allowed unless the card needs the acknowledgement and it is not ticked. */
export function approveBlockedByAck(
  toolArgsJson: string | null | undefined,
  acknowledged: boolean,
): boolean {
  return !acknowledged && provenanceOf(toolArgsJson)?.requiresAck === true;
}

// ── Undo ─────────────────────────────────────────────────────────────────────

export type UndoView =
  | { kind: 'offer'; label: string; expiresAt: string | null; remainingMs: number | null }
  | { kind: 'expired'; label: string }
  | { kind: 'running'; label: string }
  | { kind: 'done'; label: string; at: string | null; by: string | null; reason: string | null }
  | { kind: 'failed'; label: string; error: string | null }
  | { kind: 'none'; reason: string };

/**
 * What the card can say about undo, at `nowMs`. Null when the card has no undo record (it was
 * never confirmed, or predates undo) — and only a Confirmed card offers it.
 */
export function undoOf(
  turn: Pick<SpotAnalysisFollowUpTurnDto, 'toolArgsJson' | 'actionStatus'>,
  nowMs: number,
): UndoView | null {
  const u = obj(parse(turn.toolArgsJson)?.['undo']);
  if (!u) return null;
  if (u['available'] !== true) {
    const reason = str(u['reason']);
    return reason ? { kind: 'none', reason } : null;
  }
  const label = str(u['label']) ?? 'Undo this change';
  const status = (str(u['status']) ?? 'available').toLowerCase();
  if (status === 'running') return { kind: 'running', label };
  if (status === 'done')
    return {
      kind: 'done',
      label,
      at: str(u['undoneAtUtc']),
      by: str(u['undoneBy']),
      reason: str(u['undoReason']) ?? str(u['reason']),
    };
  if (status === 'failed') return { kind: 'failed', label, error: str(u['error']) };
  if ((turn.actionStatus ?? '').toLowerCase() !== 'confirmed') return null;
  const expiresAt = str(u['expiresAtUtc']);
  const exp = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(exp) && exp <= nowMs) return { kind: 'expired', label };
  return {
    kind: 'offer',
    label,
    expiresAt,
    remainingMs: Number.isFinite(exp) ? exp - nowMs : null,
  };
}

/** "14:05 left" / "45 s left". */
export function countdownText(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s left`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')} left`;
}

/** "admin-user:7" → "operator #7"; anything else as written. */
export function whoText(by: string | null): string {
  if (!by) return 'an operator';
  const m = /^admin-user:(\d+)$/.exec(by);
  if (m) return `operator #${m[1]}`;
  return /^\d+$/.test(by) ? `operator #${by}` : by;
}

/** The message to show for an undo refusal / failure. */
export function undoFailureText(
  code: string | null | undefined,
  message: string | null | undefined,
): string {
  const m = (message ?? '').trim();
  if (code === UNDO_NOT_POSSIBLE_CODE) return m || 'This change can no longer be undone.';
  if (code === UNDO_PARTLY_FAILED_CODE)
    return m || 'The undo did not complete. The card shows what ran; finish it by hand.';
  return m || 'The undo could not be sent. Is the engine reachable?';
}

// ── Batch review ─────────────────────────────────────────────────────────────

/** The engine's cap on one batch (`resolve-batch` answers -11 above it, nothing done). */
export const BATCH_MAX = 20;

/**
 * Cards the batch endpoint can decide: pending cards of the thread, in id order (the order the
 * engine runs them), at most {@link BATCH_MAX}. Never page commands — they run in the browser and
 * the engine refuses them in a batch (-11); they stay one at a time.
 */
export function batchableCards(
  turns: readonly SpotAnalysisFollowUpTurnDto[],
): SpotAnalysisFollowUpTurnDto[] {
  return turns
    .filter(
      (t) =>
        t.role === 'ActionProposal' &&
        t.id > 0 &&
        (t.actionStatus ?? 'Pending').toLowerCase() === 'pending' &&
        t.toolName !== 'ui_action',
    )
    .sort((a, b) => a.id - b.id)
    .slice(0, BATCH_MAX);
}

export function batchNeedsAck(cards: readonly SpotAnalysisFollowUpTurnDto[]): boolean {
  return cards.some((c) => provenanceOf(c.toolArgsJson)?.requiresAck === true);
}

/** One card's title for the combined preview: its summary, else its operation / call. */
export function cardTitle(t: SpotAnalysisFollowUpTurnDto): string {
  const a = parse(t.toolArgsJson);
  const s =
    str(a?.['summary']) ?? str(a?.['label']) ?? str(a?.['title']) ?? str(a?.['operationId']);
  if (s) return s.length > 140 ? `${s.slice(0, 139)}…` : s;
  const call = [str(a?.['method']), str(a?.['path'])].filter(Boolean).join(' ');
  return call || str(t.content)?.slice(0, 140) || `Card #${t.id}`;
}

export type BatchStatus = 'Confirmed' | 'Dismissed' | 'Failed' | 'Refused' | 'Skipped';

export interface BatchResultDto {
  turnId: number;
  status: BatchStatus | string;
  code?: string | null;
  message?: string | null;
}

/** `POST resolve-batch` answer: one result per card sent, and the refreshed thread. */
export interface FollowUpBatchResult {
  results: BatchResultDto[];
  thread: SpotAnalysisFollowUpTurnDto[];
}

export interface BatchResultRow {
  turnId: number;
  title: string;
  status: string;
  text: string;
  tone: 'good' | 'bad' | 'warn' | 'neutral';
}

/** The engine's per-card results, in the order of the cards sent, in plain words. */
export function batchResultRows(
  results: readonly BatchResultDto[] | null | undefined,
  cards: readonly SpotAnalysisFollowUpTurnDto[],
): BatchResultRow[] {
  const byId = new Map((results ?? []).map((r) => [r.turnId, r]));
  return cards.map((c) => {
    const r = byId.get(c.id);
    const title = cardTitle(c);
    if (!r)
      return {
        turnId: c.id,
        title,
        status: 'Unknown',
        text: 'No result came back for this card.',
        tone: 'warn',
      };
    const msg = (r.message ?? '').trim();
    switch (r.status) {
      case 'Confirmed':
        return {
          turnId: c.id,
          title,
          status: r.status,
          text: msg || 'Approved and run.',
          tone: 'good',
        };
      case 'Dismissed':
        return {
          turnId: c.id,
          title,
          status: r.status,
          text: msg || 'Dismissed.',
          tone: 'neutral',
        };
      case 'Failed':
        return {
          turnId: c.id,
          title,
          status: r.status,
          text: msg || 'Approved, but the change failed when it ran.',
          tone: 'bad',
        };
      case 'Refused':
        return {
          turnId: c.id,
          title,
          status: r.status,
          text:
            msg ||
            (r.code === ACK_REQUIRED_CODE
              ? 'Refused: tick the outside-text check first.'
              : 'Refused by the engine; the card is still waiting.'),
          tone: 'bad',
        };
      case 'Skipped':
        return {
          turnId: c.id,
          title,
          status: r.status,
          text: msg || 'Not run: an earlier card failed, so the rest were stopped.',
          tone: 'warn',
        };
      default:
        return {
          turnId: c.id,
          title,
          status: String(r.status),
          text: msg || String(r.status),
          tone: 'neutral',
        };
    }
  });
}

/** "3 approved, 1 failed, 1 skipped". */
export function batchSummary(rows: readonly BatchResultRow[]): string {
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const parts = [
    [n('Confirmed'), 'approved'],
    [n('Dismissed'), 'dismissed'],
    [n('Failed'), 'failed'],
    [n('Refused'), 'refused'],
    [n('Skipped'), 'skipped'],
  ]
    .filter(([c]) => (c as number) > 0)
    .map(([c, w]) => `${c} ${w}`);
  return parts.join(', ') || 'Nothing was decided.';
}

/**
 * The engine's `{responseCode, message}` out of a failed call: an envelope answered with
 * `status:false` on HTTP 200, or carried as the body of an HTTP error.
 */
export function errorEnvelope(err: unknown): { code: string | null; message: string | null } {
  const e = err as { error?: unknown; message?: unknown; code?: unknown } | null;
  const body =
    e && typeof e.error === 'object' && e.error !== null
      ? (e.error as Record<string, unknown>)
      : null;
  const code =
    typeof body?.['responseCode'] === 'string'
      ? (body['responseCode'] as string)
      : typeof e?.code === 'string'
        ? (e.code as string)
        : null;
  if ((err as { status?: unknown } | null)?.status === 0)
    return { code, message: 'The engine could not be reached; nothing was changed.' };
  const message =
    typeof body?.['message'] === 'string' && (body['message'] as string).trim()
      ? (body['message'] as string)
      : typeof e?.message === 'string'
        ? (e.message as string)
        : null;
  return { code, message };
}
