/**
 * How one Pine script on the chart is shown — everything its chip's eye and its Settings dialog's
 * Style and Visibility tabs set. Applied on the client to the run's render model: changing any of it
 * never re-runs the script. Saved with the layout as the fields that differ from the defaults.
 */
export interface ScriptDisplaySettings {
  /** The eye: a hidden script draws nothing; its status line stays, to show it again. */
  visible: boolean;
  /** Strategy fills on the chart (TradingView's "Trades on chart"). */
  showTrades: boolean;
  /**
   * Paint the script's main-pane visuals behind the bars (`behind_chart`); null: as the script
   * declares (Pine's default is behind).
   */
  behindChart: boolean | null;
}

export const DEFAULT_DISPLAY: Readonly<ScriptDisplaySettings> = Object.freeze({
  visible: true,
  showTrades: true,
  behindChart: null,
});

/** A layout's (or a chip's) partial settings with the defaults for everything it leaves out. */
export function resolveDisplay(
  d: Partial<ScriptDisplaySettings> | null | undefined,
): ScriptDisplaySettings {
  return { ...DEFAULT_DISPLAY, ...(d ?? {}) };
}

/** Only the fields that differ from the defaults: what a layout saves. */
export function displayOverrides(d: ScriptDisplaySettings): Partial<ScriptDisplaySettings> {
  const out: Partial<ScriptDisplaySettings> = {};
  for (const k of Object.keys(DEFAULT_DISPLAY) as (keyof ScriptDisplaySettings)[]) {
    if (JSON.stringify(d[k]) !== JSON.stringify(DEFAULT_DISPLAY[k]))
      (out as Record<string, unknown>)[k] = d[k];
  }
  return out;
}
