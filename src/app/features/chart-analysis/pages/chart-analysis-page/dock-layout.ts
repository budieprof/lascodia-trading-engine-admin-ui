/**
 * How the chart page's Pine Editor / Strategy Tester / Pine Logs dock sits — below the chart, maximised over it (a
 * strip of the live chart kept in view) or beside it — and its sizes, remembered in this browser.
 */
/** How the Pine Editor / Strategy Tester dock sits: below the chart, maximised over it, or beside it. */
export type DockMode = 'docked' | 'max' | 'side';
export interface DockLayout {
  mode: DockMode;
  height: number;
  strip: number;
  side: number;
}
export const DOCK_LAYOUT_KEY = 'lascodia.chart.dockLayout.v1';
export const DEFAULT_DOCK_LAYOUT: DockLayout = { mode: 'docked', height: 340, strip: 180, side: 620 };

/** A size clamped to [min, max] (max wins when the window is too small for both). */
export function clampSize(v: number, min: number, max: number): number {
  return Math.round(Math.max(Math.min(v, max), Math.min(min, max)));
}

/** The remembered dock layout; defaults for anything missing or malformed. */
export function loadDockLayout(): DockLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY) ?? 'null') as Partial<DockLayout> | null;
    if (!raw || typeof raw !== 'object') return DEFAULT_DOCK_LAYOUT;
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      mode: raw.mode === 'max' || raw.mode === 'side' ? raw.mode : 'docked',
      height: num(raw.height, DEFAULT_DOCK_LAYOUT.height),
      strip: num(raw.strip, DEFAULT_DOCK_LAYOUT.strip),
      side: num(raw.side, DEFAULT_DOCK_LAYOUT.side),
    };
  } catch {
    return DEFAULT_DOCK_LAYOUT;
  }
}

/** Remember the layout; a storage refusal (private window) just means it isn't remembered. */
export function saveDockLayout(layout: DockLayout): void {
  try {
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Not remembered.
  }
}
