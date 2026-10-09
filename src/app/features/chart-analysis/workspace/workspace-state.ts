import type { ActiveIndicator, ChartStyle, ChartViewState } from '../chart/chart-host.component';
import type { TvResolution } from '../datafeed/resolution';
import type {
  ChartScriptItem,
  ChartScriptSource,
  SavedChartScript,
} from '../scripts/chart-script.service';
import type { ScriptInputValues } from '@core/api/scripting.types';
import type { LegacyChartLayout } from './layout-store.service';

/** A Pine script on the chart, as a layout restores it. */
export interface WorkspaceScript {
  key: string;
  source: ChartScriptSource;
  name: string;
  kind: 'indicator' | 'strategy';
  /** Inline source — the fallback when a saved script or example can no longer be found. */
  pineSource?: string;
  strategyId?: number;
  /** Its input overrides (Settings): only the inputs that differ from their defaults. */
  values: ScriptInputValues;
}

/** A script on the chart as its layout saves it: how to find it again, and its input overrides. */
export function workspaceScriptOf(run: {
  item: ChartScriptItem;
  values: ScriptInputValues;
}): WorkspaceScript {
  const { item } = run;
  return {
    key: item.key,
    source: item.source,
    name: item.name,
    kind: item.kind,
    ...(item.pineSource !== undefined ? { pineSource: item.pineSource } : {}),
    ...(item.strategyId !== undefined ? { strategyId: item.strategyId } : {}),
    values: run.values,
  };
}

/**
 * A layout's script as the chart runs it again: a "My scripts" entry as its newest saved version,
 * anything else (or a saved script since deleted) from the layout's inline copy. It runs with the
 * layout's own values — that copy's settings — not the saved script's default inputs.
 */
export function restoredScriptItem(
  w: WorkspaceScript,
  saved: readonly SavedChartScript[],
): ChartScriptItem {
  const savedId = w.source === 'mine' && w.key.startsWith('mine:') ? w.key.slice(5) : null;
  const latest = savedId ? saved.find((x) => x.id === savedId) : null;
  const pineSource = latest?.source ?? w.pineSource;
  return {
    key: w.key,
    source: w.source,
    name: latest?.name ?? w.name,
    description: '',
    kind: latest?.kind ?? w.kind,
    ...(w.strategyId !== undefined ? { strategyId: w.strategyId } : {}),
    ...(pineSource !== undefined ? { pineSource } : {}),
  };
}

/**
 * Everything a chart-analysis workspace restores (engine `ChartLayout.state`). Versioned with
 * `v`; every field but `v` is optional so an older or partial state still applies.
 */
export interface ChartWorkspaceState {
  v: 1;
  symbol?: string;
  resolution?: TvResolution;
  style?: ChartStyle;
  showVolume?: boolean;
  scaleMode?: 'normal' | 'log' | 'percent';
  /** Countdown to bar close on the price scale (default on). */
  countdown?: boolean;
  timezone?: string;
  /** How the price-based styles are built (CC-I10); absent: ATR × 1, no wicks, 3 lines. */
  priceBased?: {
    boxMethod?: 'atr' | 'pips';
    boxSizeAtr?: number;
    boxPips?: number;
    renkoWicks?: boolean;
    lineBreakLines?: number;
  };
  indicators?: ActiveIndicator[];
  scripts?: WorkspaceScript[];
  view?: ChartViewState | null;
  overlays?: {
    /** Open-position lines. Absent in layouts saved before the split: follow showOverlays. */
    showPositions?: boolean;
    /** Pending (working) order lines. Absent before the split: follow showOverlays. */
    showOrders?: boolean;
    /** Trade-signal markers + martingale rungs (before the split: all trade overlays). */
    showOverlays?: boolean;
    showVolumeProfile?: boolean;
    volumeProfileMode?: string;
    showSupportResistance?: boolean;
    showStructure?: boolean;
    showEvents?: boolean;
    minEventImpact?: 'High' | 'Medium' | 'Low';
  };
  panel?: {
    watchlistOpen?: boolean;
    width?: number;
    sidePane?: 'none' | 'details' | 'news' | 'calendar';
    calendarAll?: boolean;
    calendarMinImpact?: 'Low' | 'Medium' | 'High';
  };
  dock?: {
    editorOpen?: boolean;
    testerOpen?: boolean;
    preference?: 'editor' | 'tester';
    editorKey?: string | null;
    /** The editor's unsaved buffer. */
    editorText?: string | null;
    /**
     * The operator removed the script the editor showed: it opens on the starter template until it
     * is pointed at a script again, rather than on the chart's strategy or newest script. Written
     * only when set; a layout without it is not cleared.
     */
    editorCleared?: boolean;
  };
}

/** How the price-based styles are built, as the page holds it (CC-I10). */
export interface PriceBasedSettings {
  boxMethod: 'atr' | 'pips';
  boxSizeAtr: number;
  boxPips: number;
  renkoWicks: boolean;
  lineBreakLines: number;
}

/**
 * A layout's price-based settings with the chart's defaults for anything missing or out of range: a
 * layout saved before they existed opens Renko as it always did (1 × ATR, no wicks, 3 lines).
 */
export function restoredPriceBased(pb: ChartWorkspaceState['priceBased']): PriceBasedSettings {
  const positive = (v: number | undefined, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  const lines = pb?.lineBreakLines;
  return {
    boxMethod: pb?.boxMethod === 'pips' ? 'pips' : 'atr',
    boxSizeAtr: positive(pb?.boxSizeAtr, 1),
    boxPips: positive(pb?.boxPips, 10),
    renkoWicks: pb?.renkoWicks === true,
    lineBreakLines: typeof lines === 'number' && lines >= 1 && lines <= 10 ? Math.round(lines) : 3,
  };
}

/** The Pine Editor and Strategy Tester dock, as the page holds it. */
export interface DockView {
  editorOpen: boolean;
  testerOpen: boolean;
  preference: 'editor' | 'tester';
  /** The chart script the editor shows (its run key); null when it is unlinked. */
  editorKey: string | null;
  /** The editor's unsaved buffer. */
  editorText: string | null;
  /** Unlinked by removing its script: it opens blank (see `ChartWorkspaceState.dock`). */
  editorCleared: boolean;
}

/** The dock as a layout saves it. */
export function dockStateOf(v: DockView): NonNullable<ChartWorkspaceState['dock']> {
  return {
    editorOpen: v.editorOpen,
    testerOpen: v.testerOpen,
    preference: v.preference,
    editorKey: v.editorKey,
    editorText: v.editorText,
    ...(v.editorCleared ? { editorCleared: true } : {}),
  };
}

/**
 * A layout's dock as the page restores it, with the chart's defaults for whatever the layout leaves
 * out — a new layout, or one saved before a field existed, opens the dock as it always did.
 */
export function restoredDock(d: ChartWorkspaceState['dock']): DockView {
  return {
    editorOpen: d?.editorOpen ?? false,
    testerOpen: d?.testerOpen ?? true,
    preference: d?.preference ?? 'tester',
    editorKey: d?.editorKey ?? null,
    editorText: d?.editorText ?? null,
    editorCleared: d?.editorCleared === true,
  };
}

/** A layout an older build saved in localStorage, as a workspace state. */
export function legacyToState(l: LegacyChartLayout): ChartWorkspaceState {
  return {
    v: 1,
    symbol: l.symbol,
    resolution: l.resolution,
    style: l.style,
    showVolume: l.showVolume,
    scaleMode: l.scaleMode,
    timezone: l.timezone,
    indicators: l.indicators,
  };
}

export function isWorkspaceState(x: unknown): x is ChartWorkspaceState {
  return !!x && typeof x === 'object' && (x as { v?: unknown }).v === 1;
}
