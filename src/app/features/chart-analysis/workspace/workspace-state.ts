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
  indicators?: ActiveIndicator[];
  scripts?: WorkspaceScript[];
  view?: ChartViewState | null;
  overlays?: {
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
