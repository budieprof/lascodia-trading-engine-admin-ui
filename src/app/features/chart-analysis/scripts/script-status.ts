import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import type { LegendValue } from '@shared/pine-chart/render/legend';
import type { ScriptFailure } from './script-run-state';

/**
 * A Pine script's status line (PC-I2): what TradingView prints at the top of the pane a study
 * draws in — its title, its inputs, its values at the bar under the crosshair (its last bar at
 * rest) — with the eye, Settings, source and remove buttons and its error badge. Overlay scripts'
 * rows join the price pane's legend; a pane script's row sits over its own pane. Pure.
 */

/** What the page knows of a script that its status line shows (on its chart layer). */
export interface ScriptLabel {
  title: string;
  /** Its inputs, as the status line prints them ("20 2 close"). */
  inputs: string;
  failure: ScriptFailure | null;
}

/** One script's status line. */
export interface ScriptStatusRow {
  key: string;
  title: string;
  inputs: string;
  values: LegendValue[];
  /** The eye: a hidden script's row stays, dimmed, to show it again. */
  visible: boolean;
  failure: ScriptFailure | null;
  /** Why it draws nothing now (another chart type, hidden on this timeframe), or null. */
  note: string | null;
  /** The price pane (its row goes in the page's legend) or its own pane. */
  pane: 'main' | 'script';
  paneIndex: number;
  /** Its pane's top in the chart's px (script panes; null until laid out). */
  top: number | null;
}

/** The actions a status line (or a chip) asks of the page. */
export type ScriptAction =
  | { key: string; kind: 'visibility' | 'settings' | 'source' | 'logs' | 'remove' }
  | { key: string; kind: 'openAt'; where: { line: number; column: number } };

/** Kinds whose values a status line prints: what an operator reads a study's set-up by. */
const SHOWN = new Set(['int', 'float', 'string', 'source', 'symbol', 'timeframe', 'enum', 'price']);
const MAX_SUMMARY = 60;

/**
 * A script's inputs as its status line prints them, TradingView-style: the value of each input it
 * shows (numbers, strings, sources, symbols, timeframes, enums — colours, booleans, sessions and
 * times are left to Settings), the chart's override else the default, space-separated, cut short.
 */
export function inputsSummary(
  inputs: readonly ScriptInputDto[],
  values: ScriptInputValues,
): string {
  const parts: string[] = [];
  for (const i of inputs) {
    if (!SHOWN.has(i.kind) || i.display === 'none') continue;
    const v = i.id in values ? values[i.id] : i.defaultValue;
    if (v === null || v === undefined || v === '') continue;
    // An enum or an option shows its text, as its dropdown does.
    const at = i.options?.findIndex((o) => o === v) ?? -1;
    parts.push(String(at >= 0 && i.optionTexts?.[at] ? i.optionTexts[at] : v));
  }
  const text = parts.join(' ');
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}
