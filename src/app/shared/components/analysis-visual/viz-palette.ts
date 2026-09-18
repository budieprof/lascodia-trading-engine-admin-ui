/**
 * Colour parameters for analyst-authored charts.
 *
 * Two distinct jobs, and conflating them is the usual way a trading chart goes wrong:
 *
 *  - IDENTITY (categorical). A chart with several named series that mean nothing in particular —
 *    "Muted / Confirmed / Contradicted", "USD / EUR". Hues are assigned in FIXED ORDER by series
 *    index, never cycled and never re-assigned when a filter changes the series count. The order
 *    below is validated: every adjacent pair clears the colour-vision-deficiency separation floor
 *    in both light and dark.
 *
 *  - POLARITY / STATUS (semantic). Up and down, win and loss. Here the desk's own green/red is
 *    non-negotiable — the candlesticks elsewhere in this app are already that pair and a chart of
 *    delta that inverted it would be read backwards. Colour is never the ONLY carrier of sign: a
 *    diverging bar also sits on the far side of the zero baseline, and a segment also carries its
 *    outcome in its label.
 */

export type VizMode = 'light' | 'dark';

/** Role names the analyst can address a series or annotation by. */
export type VizColorRole = 'up' | 'down' | 'neutral' | 'accent' | 'warn' | 'muted';

interface VizPalette {
  /** Fixed-order categorical hues. A 9th series folds into the 8th rather than generating a hue. */
  readonly categorical: readonly string[];
  readonly semantic: Readonly<Record<VizColorRole, string>>;
  /** Diverging poles + neutral midpoint, for a heatmap read against a threshold. */
  readonly diverging: { readonly low: string; readonly mid: string; readonly high: string };
  /** Single-hue ramp ends, for magnitude with no meaningful midpoint. */
  readonly sequential: { readonly from: string; readonly to: string };
  readonly axis: string;
  readonly grid: string;
  readonly text: string;
  readonly textMuted: string;
  readonly surface: string;
}

const LIGHT: VizPalette = {
  categorical: [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
  ],
  semantic: {
    // The desk's own pair, shared with the candlesticks and the Entry/SL/TP overlays.
    up: '#1f8a3d',
    down: '#c4290a',
    neutral: '#6e6e73',
    accent: '#0071e3',
    warn: '#b45309',
    muted: '#9a9a9f',
  },
  diverging: { low: '#c4290a', mid: '#f0efec', high: '#2a78d6' },
  sequential: { from: '#cde2fb', to: '#184f95' },
  axis: '#8e8e93',
  grid: 'rgba(0,0,0,0.07)',
  text: '#1d1d1f',
  textMuted: '#6e6e73',
  surface: '#ffffff',
};

const DARK: VizPalette = {
  categorical: [
    '#3987e5',
    '#d95926',
    '#199e70',
    '#c98500',
    '#d55181',
    '#008300',
    '#9085e9',
    '#e66767',
  ],
  semantic: {
    up: '#3fb562',
    down: '#e35a3c',
    neutral: '#9a9a9f',
    accent: '#3d9bff',
    warn: '#d98a2b',
    muted: '#6e6e73',
  },
  diverging: { low: '#e35a3c', mid: '#383835', high: '#3987e5' },
  sequential: { from: '#0d366b', to: '#86b6ef' },
  axis: '#8e8e93',
  grid: 'rgba(255,255,255,0.09)',
  text: '#f5f5f7',
  textMuted: '#a1a1a6',
  surface: '#1c1c1e',
};

export const vizPalette = (mode: VizMode): VizPalette => (mode === 'dark' ? DARK : LIGHT);

/**
 * Colour for series index `i`. Past the last slot the palette repeats its final hue rather than
 * inventing one — a ninth distinguishable series does not exist, and pretending otherwise produces
 * two colours nobody can tell apart while implying they are different things.
 */
export const categoricalAt = (mode: VizMode, i: number): string => {
  const p = vizPalette(mode).categorical;
  return p[Math.min(i, p.length - 1)];
};

export const roleColor = (
  mode: VizMode,
  role: VizColorRole | undefined,
  fallback: string,
): string => (role ? vizPalette(mode).semantic[role] : fallback);

/** Sign-coded colour for a diverging bar / waterfall step. */
export const signColor = (mode: VizMode, value: number): string => {
  const s = vizPalette(mode).semantic;
  return value > 0 ? s.up : value < 0 ? s.down : s.neutral;
};

/** Hex → rgba, for the shaded bands behind a chart. */
export const alpha = (hex: string, a: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
