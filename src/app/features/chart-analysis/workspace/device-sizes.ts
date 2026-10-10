import type { ChartWorkspaceState } from './workspace-state';

/**
 * Sizes that belong to the SCREEN, not to the layout: a laptop and a large monitor must not overwrite each other's
 * pane heights or panel width. They stay in this browser (per layout) and never go to the engine; everything else in
 * a layout still follows the operator across devices.
 *
 * - `view.paneHeights` — each chart pane's height in px (main pane first);
 * - `panel.width` — the watchlist panel's width in px;
 * - `symbolMemory.symbols[*].view.paneHeights` — the same, remembered per symbol (CC-I11 layout memory).
 *
 * The Pine Editor dock's layout and sizes (`pages/chart-analysis-page/dock-layout.ts`) are browser-only already.
 */
export interface DeviceSizes {
  paneHeights?: number[];
  watchlistWidth?: number;
  symbolPaneHeights?: Record<string, number[]>;
}

const DEVICE_SIZES_KEY = 'lascodia.chart.deviceSizes.v1';
/** The layout not saved yet (no id): its sizes move to its id once the engine gives it one. */
const UNSAVED = 'unsaved';

/** The layout without its device sizes — what is sent to the engine. Never mutates `state`. */
export function withoutDeviceSizes(state: ChartWorkspaceState): ChartWorkspaceState {
  const out: ChartWorkspaceState = { ...state };
  if (out.view) {
    const { paneHeights: _, ...view } = out.view;
    out.view = view as typeof out.view;
  }
  if (out.panel && 'width' in out.panel) {
    const { width: _, ...panel } = out.panel;
    out.panel = panel;
  }
  if (out.symbolMemory?.symbols) {
    const symbols: NonNullable<NonNullable<ChartWorkspaceState['symbolMemory']>['symbols']> = {};
    for (const [sym, entry] of Object.entries(out.symbolMemory.symbols)) {
      if (entry.view) {
        const { paneHeights: _, ...view } = entry.view;
        symbols[sym] = { ...entry, view: view as typeof entry.view };
      } else symbols[sym] = entry;
    }
    out.symbolMemory = { ...out.symbolMemory, symbols };
  }
  return out;
}

/** The device sizes a layout holds (to remember in this browser). */
export function deviceSizesOf(state: ChartWorkspaceState): DeviceSizes {
  const sizes: DeviceSizes = {};
  if (state.view?.paneHeights?.length) sizes.paneHeights = [...state.view.paneHeights];
  if (typeof state.panel?.width === 'number') sizes.watchlistWidth = state.panel.width;
  for (const [sym, entry] of Object.entries(state.symbolMemory?.symbols ?? {})) {
    if (entry.view?.paneHeights?.length) (sizes.symbolPaneHeights ??= {})[sym] = [...entry.view.paneHeights];
  }
  return sizes;
}

/**
 * A layout from the engine with THIS device's sizes put back. Where the device has none, what the layout carries is
 * kept (layouts saved before sizes went device-local still open as they were) — otherwise the defaults apply.
 */
export function withDeviceSizes(state: ChartWorkspaceState, sizes: DeviceSizes | null): ChartWorkspaceState {
  if (!sizes) return state;
  const out: ChartWorkspaceState = { ...state };
  if (sizes.paneHeights && out.view) out.view = { ...out.view, paneHeights: [...sizes.paneHeights] };
  if (sizes.watchlistWidth !== undefined) out.panel = { ...(out.panel ?? {}), width: sizes.watchlistWidth };
  if (sizes.symbolPaneHeights && out.symbolMemory?.symbols) {
    const symbols = { ...out.symbolMemory.symbols };
    for (const [sym, heights] of Object.entries(sizes.symbolPaneHeights)) {
      const entry = symbols[sym];
      if (entry?.view) symbols[sym] = { ...entry, view: { ...entry.view, paneHeights: [...heights] } };
    }
    out.symbolMemory = { ...out.symbolMemory, symbols };
  }
  return out;
}

function readAll(): Record<string, DeviceSizes> {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_SIZES_KEY) ?? 'null') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, DeviceSizes>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, DeviceSizes>): void {
  try {
    localStorage.setItem(DEVICE_SIZES_KEY, JSON.stringify(all));
  } catch {
    // Storage refused: sizes just aren't remembered on this device.
  }
}

/** This device's sizes for a layout (null: none remembered). */
export function readDeviceSizes(layoutId: number | null): DeviceSizes | null {
  return readAll()[layoutId === null ? UNSAVED : String(layoutId)] ?? null;
}

/** Remember a layout's sizes on this device; an unsaved layout's move to its id once it has one. */
export function rememberDeviceSizes(layoutId: number | null, state: ChartWorkspaceState | null): void {
  if (!state) return;
  const all = readAll();
  const key = layoutId === null ? UNSAVED : String(layoutId);
  all[key] = deviceSizesOf(state);
  if (layoutId !== null) delete all[UNSAVED];
  writeAll(all);
}
