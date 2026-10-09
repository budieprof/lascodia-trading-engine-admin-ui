import type { ScriptInputValues } from '@core/api/scripting.types';

/**
 * Local autosave of an unsaved Pine edit (PE-I3): a crash, a closed tab or a navigation away no
 * longer loses the work. Drafts live in this browser only — a per-viewer convenience, never the
 * record: the engine keeps the saved script and its versions. Storage that is blocked or full
 * simply means no draft (every access is guarded).
 */
export interface ScriptDraftRecord {
  source: string;
  /** Input overrides edited with the source, when the editor has them. */
  inputs?: ScriptInputValues | null;
  /** The name typed in the editor, when it has one. */
  name?: string | null;
  /** The saved revision the edit started from; null for a script never saved. */
  baseRevision: string | null;
  /** Epoch ms of the last autosave. */
  savedAt: number;
}

export const DRAFT_PREFIX = 'lascodia.pine.draft.v1:';
/** Larger edits are not autosaved (localStorage holds a few MB per origin). */
export const MAX_DRAFT_CHARS = 600_000;
/** Drafts older than this are dropped when the next draft is written. */
export const DRAFT_MAX_AGE_MS = 30 * 86_400_000;

export type DraftScope = 'strategy' | 'chart';

/** `strategy:1201`, `chart:45`, `chart:new` (a script never saved). */
export function draftKey(scope: DraftScope, id: string | number | null | undefined): string {
  return `${DRAFT_PREFIX}${scope}:${id === null || id === undefined || id === '' ? 'new' : id}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDraft(key: string): ScriptDraftRecord | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ScriptDraftRecord>;
    if (typeof d?.source !== 'string' || typeof d.savedAt !== 'number') return null;
    return {
      source: d.source,
      inputs: d.inputs && typeof d.inputs === 'object' ? (d.inputs as ScriptInputValues) : null,
      name: typeof d.name === 'string' ? d.name : null,
      baseRevision: typeof d.baseRevision === 'string' ? d.baseRevision : null,
      savedAt: d.savedAt,
    };
  } catch {
    return null;
  }
}

/** Stores the draft; false when it is too large or storage refused it. */
export function writeDraft(key: string, record: ScriptDraftRecord): boolean {
  if (record.source.length > MAX_DRAFT_CHARS) return false;
  const s = storage();
  if (!s) return false;
  try {
    pruneDrafts(record.savedAt);
    s.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

/** Drops drafts older than {@link DRAFT_MAX_AGE_MS}. */
export function pruneDrafts(now = Date.now()): void {
  const s = storage();
  if (!s) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const d = readDraft(key);
      if (!d || now - d.savedAt > DRAFT_MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) s.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

/**
 * Writes drafts a moment after the last change (typing does not hit storage on every key), and
 * on {@link flush} at once — before the page goes away.
 */
export class DraftAutosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { key: string; record: ScriptDraftRecord } | null = null;

  constructor(private readonly delayMs = 800) {}

  schedule(key: string, record: ScriptDraftRecord): void {
    this.pending = { key, record };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const p = this.pending;
    this.pending = null;
    if (p) writeDraft(p.key, p.record);
  }

  /** Forgets a scheduled write (the edit was saved or discarded). */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/** "2 min ago" for the restore prompt. */
export function draftAge(savedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
