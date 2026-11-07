/**
 * `?tab=` ↔ the strategy detail page's tab (U06, 2026-11-07). The page read `?tab=` on open but never
 * wrote it, so a reload, a shared link or the back button always landed on Config.
 */

/** The query value for a tab: the default tab is the bare URL (null removes the parameter). */
export function tabQueryParam(tab: string, defaultTab = 'config'): string | null {
  return !tab || tab === defaultTab ? null : tab;
}

/** A `?tab=` value the page knows, else null (an unknown value never blanks the page). */
export function readTabParam(
  raw: string | null | undefined,
  known: readonly string[],
): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v && known.includes(v) ? v : null;
}
