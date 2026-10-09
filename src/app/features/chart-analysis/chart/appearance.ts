/**
 * The chart's own appearance settings (CC-I11 chart settings dialog): the candle colours, the grid lines and the
 * background, over the theme's palette. Absent fields keep the theme's (TradingView's 2026 palette, chart-host).
 */
export interface ChartAppearance {
  /** Rising bars (body, border, wick; volume at half strength). */
  up?: string;
  /** Falling bars. */
  down?: string;
  /** Which grid lines show (default both). */
  grid?: 'both' | 'vertical' | 'horizontal' | 'none';
  /** The canvas colour; absent: the theme's. */
  background?: string;
}

/** The palette fields the appearance overrides. */
export interface AppearancePalette {
  background: string;
  up: string;
  down: string;
  volumeUp: string;
  volumeDown: string;
}

const HEX = /^#([0-9a-f]{6})$/i;

/** Whether `c` is a colour the dialog writes (#RRGGBB). */
export function isHexColour(c: unknown): c is string {
  return typeof c === 'string' && HEX.test(c);
}

/** `#RRGGBB` at `alpha` as rgba(); other colours unchanged. */
export function withAlpha(c: string, alpha: number): string {
  const m = HEX.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** The palette with the appearance applied: colours the dialog cannot have written are ignored. */
export function applyAppearance<P extends AppearancePalette>(p: P, a: ChartAppearance | null | undefined): P {
  if (!a) return p;
  const out = { ...p };
  if (isHexColour(a.up)) {
    out.up = a.up;
    out.volumeUp = withAlpha(a.up, 0.5);
  }
  if (isHexColour(a.down)) {
    out.down = a.down;
    out.volumeDown = withAlpha(a.down, 0.5);
  }
  if (isHexColour(a.background)) out.background = a.background;
  return out;
}

/** The grid lines' visibility. */
export function gridVisibility(a: ChartAppearance | null | undefined): { vert: boolean; horz: boolean } {
  const g = a?.grid ?? 'both';
  return { vert: g === 'both' || g === 'vertical', horz: g === 'both' || g === 'horizontal' };
}

/** What changes the price series' colours (a new value rebuilds it). */
export function appearanceKey(a: ChartAppearance | null | undefined): string {
  return `${isHexColour(a?.up) ? a!.up : ''}|${isHexColour(a?.down) ? a!.down : ''}|${isHexColour(a?.background) ? a!.background : ''}`;
}

/** A layout's appearance with anything malformed dropped; null when nothing is left (the theme's look). */
export function restoredAppearance(a: unknown): ChartAppearance | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const out: ChartAppearance = {};
  if (isHexColour(o['up'])) out.up = o['up'];
  if (isHexColour(o['down'])) out.down = o['down'];
  if (isHexColour(o['background'])) out.background = o['background'];
  if (o['grid'] === 'vertical' || o['grid'] === 'horizontal' || o['grid'] === 'none') out.grid = o['grid'];
  return Object.keys(out).length ? out : null;
}
