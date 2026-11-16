/**
 * Review A8 (2026-11-16): a tab still running an older release asks for a lazy chunk that the
 * current release no longer has. The edge now answers such a request 404 (never the SPA shell), so
 * the dynamic import fails — and the one useful thing the console can do is reload onto the
 * release that IS live. Once: a reload that does not help (the chunk really is missing from the
 * live release) must not loop, so a second failure within {@link CHUNK_RELOAD_WINDOW_MS} is
 * reported instead.
 */

/** sessionStorage stamp of the last chunk-error reload (per tab, survives the reload). */
export const CHUNK_RELOAD_KEY = 'lascodia.chunkReloadAt';
/** A second chunk failure this soon after a reload is not reloaded again. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

const CHUNK_ERROR_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite-style CSS preload failure
];

/** True when `err` (or the rejection/error it wraps) is a failed lazy-chunk load. */
export function isChunkLoadError(err: unknown, depth = 0): boolean {
  if (!err || depth > 3) return false;
  if (typeof err === 'string') return CHUNK_ERROR_PATTERNS.some((p) => p.test(err));
  if (typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown; rejection?: unknown; error?: unknown };
  const text = `${typeof e.name === 'string' ? e.name : ''} ${typeof e.message === 'string' ? e.message : ''}`;
  if (CHUNK_ERROR_PATTERNS.some((p) => p.test(text))) return true;
  return isChunkLoadError(e.rejection, depth + 1) || isChunkLoadError(e.error, depth + 1);
}

export interface ChunkReloadDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload?: () => void;
  now?: number;
}

/**
 * Reloads the page for a chunk-load error unless one was already done within the window.
 * Returns true when a reload was started (the caller should then stay quiet).
 */
export function reloadOnceForChunkError(err: unknown, deps: ChunkReloadDeps = {}): boolean {
  if (!isChunkLoadError(err)) return false;
  const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage;
  const now = deps.now ?? Date.now();
  let last = NaN;
  try {
    last = Number(storage?.getItem(CHUNK_RELOAD_KEY));
  } catch {
    /* storage blocked */
  }
  if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
  try {
    // Without a place to remember the attempt there is no loop guard: do not reload at all.
    if (!storage) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  (deps.reload ?? (() => window.location.reload()))();
  return true;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
