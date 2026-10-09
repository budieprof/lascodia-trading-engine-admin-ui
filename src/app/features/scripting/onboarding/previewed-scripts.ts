/**
 * Which scripts this browser has run a Preview of (PE-I9's checklist step "preview it"), by the
 * engine's source hash: the strategy's saved script counts as previewed when exactly that source
 * ran. Per browser and best effort — storage can be missing or full, and then nothing counts.
 */
import { scriptSourceHash } from '../shared/sha256';

export const PREVIEWED_KEY = 'lascodia.pine.previewed.v1';
/** The newest hashes kept. */
const MAX_KEPT = 300;

function read(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(PREVIEWED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markPreviewed(source: string | null | undefined): void {
  if (!source?.trim()) return;
  const hash = scriptSourceHash(source);
  const kept = read().filter((h) => h !== hash);
  kept.push(hash);
  try {
    globalThis.localStorage?.setItem(PREVIEWED_KEY, JSON.stringify(kept.slice(-MAX_KEPT)));
  } catch {
    /* storage unavailable or full: the checklist just will not tick this step */
  }
}

export function wasPreviewed(source: string | null | undefined): boolean {
  if (!source?.trim()) return false;
  return read().includes(scriptSourceHash(source));
}
