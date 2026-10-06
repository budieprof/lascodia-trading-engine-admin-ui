import type { ActiveIndicator, ChartStyle, ChartViewState } from '../chart/chart-host.component';
import type { TvResolution } from '../datafeed/resolution';
import type { ChartScriptSource } from '../scripts/chart-script.service';
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
  values: ScriptInputValues;
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
    sidePane?: 'none' | 'details' | 'news';
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
