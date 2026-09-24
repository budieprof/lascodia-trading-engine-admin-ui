/**
 * `display.*` locations of a plot-type output. The wire sends `["all"]`, `["none"]` or the list of
 * locations (`["pane", "data_window"]`); anything unknown or missing means "all", which is Pine's
 * default.
 */
export interface DisplayFlags {
  /** Drawn in the chart pane (and allowed to affect its scale). */
  pane: boolean;
  dataWindow: boolean;
  /** Last-value label on the price scale. */
  priceScale: boolean;
  /** Value in the pane's status line (legend). */
  statusLine: boolean;
}

export const DISPLAY_ALL: DisplayFlags = Object.freeze({
  pane: true,
  dataWindow: true,
  priceScale: true,
  statusLine: true,
});

export const DISPLAY_NONE: DisplayFlags = Object.freeze({
  pane: false,
  dataWindow: false,
  priceScale: false,
  statusLine: false,
});

export function parseDisplay(names: readonly string[] | null | undefined): DisplayFlags {
  if (!names || names.length === 0) return DISPLAY_ALL;
  const set = new Set(names.map((n) => String(n).toLowerCase()));
  if (set.has('all')) return DISPLAY_ALL;
  if (set.has('none')) return DISPLAY_NONE;
  const flags: DisplayFlags = {
    pane: set.has('pane'),
    dataWindow: set.has('data_window'),
    priceScale: set.has('price_scale'),
    statusLine: set.has('status_line'),
  };
  // A list holding only locations this renderer does not show (e.g. ["pine_screener"]) hides the
  // output here, exactly like Pine: the screener is not a chart location.
  return flags;
}

/** True when the output is visible anywhere this chart renders. */
export function isDisplayedAnywhere(d: DisplayFlags): boolean {
  return d.pane || d.dataWindow || d.priceScale || d.statusLine;
}
