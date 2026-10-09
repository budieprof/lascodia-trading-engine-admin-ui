import type { ActiveIndicator, ChartStyle, ChartViewState } from '../chart/chart-host.component';
import type { TvResolution } from '../datafeed/resolution';
import type {
  ChartScriptItem,
  ChartScriptSource,
  SavedChartScript,
} from '../scripts/chart-script.service';
import type { ScriptInputValues } from '@core/api/scripting.types';
import type { ScriptDisplaySettings } from '../scripts/script-display';
import type { LegacyChartLayout } from './layout-store.service';
import type { ChartAppearance } from '../chart/appearance';
import type { CompareSeriesSpec } from '../compare/compare-series';

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
  /** How it is shown (eye, Style, Visibility): only what differs from the defaults (PC-01/PC-13). */
  display?: Partial<ScriptDisplaySettings>;
}

/** A script on the chart as its layout saves it: how to find it again, and its input overrides. */
export function workspaceScriptOf(run: {
  item: ChartScriptItem;
  values: ScriptInputValues;
  display?: Partial<ScriptDisplaySettings>;
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
    ...(run.display && Object.keys(run.display).length ? { display: run.display } : {}),
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

/** The other charts of a multi-chart layout (CC-I5): each its own series, studies and scripts. */
export interface ChartPanelState {
  symbol: string;
  resolution: string;
  /** Its own built-in studies. */
  indicators?: ActiveIndicator[];
  /** Its own Pine scripts (indicators). */
  scripts?: WorkspaceScript[];
  /** Its link group, 1 … 3 (absent or 0: not linked): charts in one group follow each other (`sync`). */
  link?: number;
}

/** What linked charts follow of each other (CC-I5); absent: symbol and interval no, crosshair and time yes. */
export interface ChartSync {
  symbol?: boolean;
  interval?: boolean;
  crosshair?: boolean;
  time?: boolean;
}

/** The layout state version this console writes. */
export const WORKSPACE_VERSION = 2;

/**
 * Everything a chart-analysis workspace restores (engine `ChartLayout.state`). Versioned with
 * `v`; every field but `v` is optional so an older or partial state still applies.
 *
 * v2 (CC-I5, multi-chart): the main chart keeps every v1 field at the top level; the layout's other charts are
 * `charts` (each with its own studies, scripts and link group), with `link` / `sync` for the main chart's group and
 * what linked charts follow. v1's `split.panels` (symbol and timeframe only) become `charts` ({@link migrateWorkspaceState}).
 */
export interface ChartWorkspaceState {
  v: 1 | 2;
  symbol?: string;
  resolution?: TvResolution;
  style?: ChartStyle;
  showVolume?: boolean;
  scaleMode?: 'normal' | 'log' | 'percent' | 'indexed';
  /** The price scale upside down (default off). */
  invertScale?: boolean;
  /** The side the price scale sits on (default right). */
  scaleSide?: 'right' | 'left';
  /** Session-break lines on intraday charts (default off). */
  sessionBreaks?: boolean;
  /** Countdown to bar close on the price scale (default on). */
  countdown?: boolean;
  /** Candle colours, grid lines, background over the theme's (CC-I11 chart settings); absent: the theme's. */
  appearance?: ChartAppearance;
  /** Compare overlays and synthetic series (CC-I12); absent: none. */
  compare?: CompareSeriesSpec[];
  /**
   * Layout memory per symbol (CC-I11): `on` — a symbol switched to opens on the timeframe and zoom it was left on;
   * `symbols` — what each was left on (`workspace/symbol-memory.ts`). Absent: off.
   */
  symbolMemory?: { on?: boolean; symbols?: Record<string, { resolution: string; view?: ChartViewState }> };
  timezone?: string;
  /** How the price-based styles are built (CC-I10); absent: ATR × 1, no wicks, 3 lines. */
  priceBased?: {
    boxMethod?: 'atr' | 'pips';
    boxSizeAtr?: number;
    boxPips?: number;
    renkoWicks?: boolean;
    lineBreakLines?: number;
    /** Point & Figure's reversal in boxes (CC-I10); absent: 3. */
    pnfReversal?: number;
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
    /** Shade the news blackout around Tier-1 events (default on). */
    showBlackout?: boolean;
    /** Fill markers of closed trades (default off). */
    showClosedTrades?: boolean;
    /** Whether the trade lines widen the price scale's fit (default on). */
    fitTradeLines?: boolean;
    /** Watch / monitor marks and lines (default on). */
    showWatches?: boolean;
  };
  /** The split view: its arrangement — and, in v1, each comparison panel's series (CC-12; v2: `charts`). */
  split?: {
    layout?: string;
    panels?: { symbol: string; resolution: string }[];
  };
  /** v2: the layout's other charts, in order (CC-I5). */
  charts?: ChartPanelState[];
  /** v2: the main chart's link group (1 … 3; absent or 0: not linked). */
  link?: number;
  /** v2: what linked charts follow of each other. */
  sync?: ChartSync;
  panel?: {
    watchlistOpen?: boolean;
    width?: number;
    sidePane?: 'none' | 'details' | 'news' | 'calendar' | 'datawindow';
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
  pnfReversal: number;
}

/**
 * A layout's price-based settings with the chart's defaults for anything missing or out of range: a
 * layout saved before they existed opens Renko as it always did (1 × ATR, no wicks, 3 lines).
 */
export function restoredPriceBased(pb: ChartWorkspaceState['priceBased']): PriceBasedSettings {
  const positive = (v: number | undefined, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  const lines = pb?.lineBreakLines;
  const rev = pb?.pnfReversal;
  return {
    boxMethod: pb?.boxMethod === 'pips' ? 'pips' : 'atr',
    boxSizeAtr: positive(pb?.boxSizeAtr, 1),
    boxPips: positive(pb?.boxPips, 10),
    renkoWicks: pb?.renkoWicks === true,
    lineBreakLines: typeof lines === 'number' && lines >= 1 && lines <= 10 ? Math.round(lines) : 3,
    pnfReversal: typeof rev === 'number' && rev >= 1 && rev <= 10 ? Math.round(rev) : 3,
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
  const v = !!x && typeof x === 'object' ? (x as { v?: unknown }).v : undefined;
  return v === 1 || v === 2;
}

/**
 * A layout state as v2 (CC-I5). A v1 state loses nothing: every field stays where it was and its split panels'
 * series become `charts` (the arrangement stays in `split.layout`). A v2 state comes back as it is.
 */
export function migrateWorkspaceState(s: ChartWorkspaceState): ChartWorkspaceState {
  if (s.v === 2) return s;
  const { split, ...rest } = s;
  const charts: ChartPanelState[] = (split?.panels ?? [])
    .filter((p) => p && typeof p.symbol === 'string' && typeof p.resolution === 'string')
    .map((p) => ({ symbol: p.symbol, resolution: p.resolution }));
  return {
    ...rest,
    v: 2,
    ...(split ? { split: { ...(split.layout !== undefined ? { layout: split.layout } : {}) } } : {}),
    ...(charts.length ? { charts } : {}),
  };
}

/** A link group as a layout may hold it: 1 … 3, else 0 (not linked). */
export function linkGroupOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 3 ? raw : 0;
}

/** What linked charts follow, with the defaults for what a layout leaves out. */
export function restoredSync(raw: ChartSync | undefined): Required<ChartSync> {
  return {
    symbol: raw?.symbol === true,
    interval: raw?.interval === true,
    crosshair: raw?.crosshair !== false,
    time: raw?.time !== false,
  };
}
