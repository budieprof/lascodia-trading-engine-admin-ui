/**
 * The drawings' engine sync, the parts with no Angular in them (DR-02 / DR-I3): the outbox entry, its persistence in
 * `localStorage`, and what counts as "the same drawing" when the engine's copy meets ours.
 *
 * The outbox survives a reload — that is the point (DR-02: the unsent list lived in memory, and a drawing made
 * while the engine was down, or in the second before a reload, was lost). Several tabs share the storage, so a
 * write MERGES with what is there: a tab removes only the entries it saw acknowledged (and only if no other tab
 * has replaced them since) and adds its own, never the whole map at once.
 */
import type { Drawing } from './model';
import { behaviorFor } from './tools/registry';

const SYNC_KEY = 'lascodia.chart.drawings.sync.v2';

/** One unacknowledged write: the latest state of a drawing to save, or a drawing to delete. */
export interface OutboxEntry {
  op: 'upsert' | 'delete';
  id: string;
  /** The drawing as it is (upsert) or was (delete — its symbol and creation time name it). */
  drawing: Drawing;
  /** Who queued it and when (`tab:n`): an acknowledgement removes the entry only if it is still this one. */
  seq: string;
}

export interface SyncStateOnDisk {
  /** The engine's version (`updatedAt`) of every drawing it acknowledged. */
  versions: Record<string, string>;
  outbox: Record<string, OutboxEntry>;
}

/** The newer write to one drawing replaces the older: the outbox holds the latest state, not a history. */
export function coalesce(_older: OutboxEntry | undefined, newer: OutboxEntry): OutboxEntry {
  return newer;
}

/** Measurements (the ruler) are never stored or sent. */
export function isTransient(d: Pick<Drawing, 'kind'>): boolean {
  return !!behaviorFor(d.kind)?.transient;
}

/** What the engine stores of a drawing, for "is it the same?" — the id and creation time aside. */
function content(d: Drawing): string {
  return JSON.stringify([
    d.kind,
    d.symbol,
    d.resolution,
    d.points,
    d.style,
    d.options && Object.keys(d.options).length ? d.options : null,
    !!d.locked,
    !!d.hidden,
    d.visibleOn && d.visibleOn.length ? d.visibleOn : null,
    d.z ?? 0,
  ]);
}

/** Whether two copies of a drawing say the same thing. */
export function sameContent(a: Drawing, b: Drawing): boolean {
  return a === b || content(a) === content(b);
}

export function readSyncState(): SyncStateOnDisk {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return { versions: {}, outbox: {} };
    const parsed = JSON.parse(raw) as Partial<SyncStateOnDisk>;
    const outbox: Record<string, OutboxEntry> = {};
    for (const [id, e] of Object.entries(parsed.outbox ?? {})) {
      if (
        e &&
        (e.op === 'upsert' || e.op === 'delete') &&
        e.drawing &&
        Array.isArray(e.drawing.points)
      ) {
        outbox[id] = e;
      }
    }
    const versions: Record<string, string> = {};
    for (const [id, v] of Object.entries(parsed.versions ?? {}))
      if (typeof v === 'string') versions[id] = v;
    return { versions, outbox };
  } catch {
    return { versions: {}, outbox: {} };
  }
}

/**
 * Merge this tab's sync state into storage: its outbox entries written over the stored ones; the entries it saw
 * acknowledged (`acked`: id → the seq that was acknowledged) removed unless another tab replaced them since; its
 * versions over the stored ones (the newer of two wins), and the versions of drawings it saw deleted (`forgotten`)
 * removed.
 */
export function writeSyncState(
  versions: ReadonlyMap<string, string>,
  outbox: ReadonlyMap<string, OutboxEntry>,
  acked: ReadonlyMap<string, string>,
  forgotten: ReadonlySet<string> = new Set(),
): void {
  try {
    const stored = readSyncState();
    for (const [id, seq] of acked) if (stored.outbox[id]?.seq === seq) delete stored.outbox[id];
    for (const [id, e] of outbox) stored.outbox[id] = e;
    // A deleted drawing's version goes with it, or the map would grow with every drawing ever removed.
    for (const id of forgotten) if (!versions.has(id)) delete stored.versions[id];
    for (const [id, v] of versions)
      if (!stored.versions[id] || v > stored.versions[id]) stored.versions[id] = v;
    localStorage.setItem(SYNC_KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable: the outbox lives in memory for this session */
  }
}
