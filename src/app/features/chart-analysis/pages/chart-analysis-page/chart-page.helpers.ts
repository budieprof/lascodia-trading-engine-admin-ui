import type { ChartViewState } from '../../chart/chart-host.component';
import type { PanelScript } from '../../workspace/chart-panels';
import type { CompareSeriesSpec } from '../../compare/compare-series';

// Pure helpers of the chart page (U13: moved out of chart-analysis-page.component.ts, unchanged).

/** Translate a hex colour into an rgba fill at the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(41,98,255,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/**
 * A view state as layouts save it: whole bars of scroll and whole pixels, so sub-pixel jitter and
 * fractional scroll positions never register as a change.
 */
export function normaliseView(v: ChartViewState): ChartViewState {
  return {
    barSpacing: Math.round(v.barSpacing * 100) / 100,
    rightOffset: Math.round(v.rightOffset),
    // Pane heights are device-local (`withoutDeviceSizes`): a layout read from the engine on a
    // browser that has none remembered — a new device, cleared storage — has a view WITHOUT
    // them. `.map` on that threw inside applyState, after the symbol and studies were applied
    // but before the split charts, Pine scripts and dock — and the half-applied layout became
    // the baseline the next autosave wrote back.
    paneHeights: (v.paneHeights ?? []).map((h) => Math.round(h)),
  };
}

/** A chart's scripts on a new series: their runs were the old series'. */
export function freshRuns(scripts: readonly PanelScript[]): PanelScript[] {
  return scripts.map((s) => ({ ...s, result: null, error: null, ranTo: null }));
}

/** What the price scale becomes when a compare series is added (CC-I12): a compare symbol shares the price's scale,
 * so the scale turns to Percent unless it already compares (percent or indexed to 100); a ratio in its own pane
 * leaves it alone. `switched` = the operator must be told. */
export function scaleAfterCompare<M extends string>(
  spec: Pick<CompareSeriesSpec, 'kind'>,
  mode: M,
): { mode: M | 'percent'; switched: boolean } {
  if (spec.kind === 'compare' && mode !== 'percent' && mode !== 'indexed')
    return { mode: 'percent', switched: true };
  return { mode, switched: false };
}
