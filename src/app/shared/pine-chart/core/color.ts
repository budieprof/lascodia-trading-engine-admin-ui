/**
 * Pine colors on the wire are `"#RRGGBBAA"` (null = na). Canvas wants CSS colors, and a chart with
 * 20,000 bars and dozens of per-bar colored plots converts the same handful of strings over and over,
 * so conversions are memoised.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const parsed = new Map<string, Rgba | null>();
const css = new Map<string, string | null>();

/** Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`. Null for na, empty or malformed input. */
export function parsePineColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const hit = parsed.get(value);
  if (hit !== undefined) return hit;
  const result = parseUncached(value.trim());
  if (parsed.size > 20_000) parsed.clear();
  parsed.set(value, result);
  return result;
}

function parseUncached(value: string): Rgba | null {
  const m = HEX.exec(value);
  if (!m) return null;
  let hex = m[1];
  if (hex.length <= 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a: Math.round(a * 1000) / 1000 };
}

/**
 * CSS `rgba()` for a Pine color, or null when the color is na or fully transparent — a transparent
 * color draws nothing, so callers skip the draw call altogether.
 */
export function cssColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const hit = css.get(value);
  if (hit !== undefined) return hit;
  const rgba = parsePineColor(value);
  const result = rgba && rgba.a > 0 ? toCss(rgba) : null;
  if (css.size > 20_000) css.clear();
  css.set(value, result);
  return result;
}

export function toCss(c: Rgba): string {
  return c.a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

/** The same color with its alpha multiplied by `factor` (0..1). Accepts Pine hex or CSS rgb()/rgba(). */
export function withAlpha(color: string, factor: number): string {
  const rgba = parsePineColor(color) ?? parseCssRgb(color);
  if (!rgba) return color;
  return toCss({ ...rgba, a: Math.max(0, Math.min(1, rgba.a * factor)) });
}

const RGB = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

export function parseCssRgb(value: string): Rgba | null {
  const m = RGB.exec(value.trim());
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

/** Relative luminance (WCAG) of a color, 0 (black) … 1 (white). */
export function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** Black or white — whichever reads better on `background`. */
export function contrastText(background: string | null | undefined, dark = false): string {
  const rgba = background ? (parsePineColor(background) ?? parseCssRgb(background)) : null;
  if (!rgba || rgba.a < 0.35) return dark ? '#D1D4DC' : '#131722';
  return luminance(rgba) > 0.45 ? '#131722' : '#FFFFFF';
}

/**
 * A palette-indexed color track: per-slot colors are stored as small integers into a palette of
 * CSS strings, so 20,000 bars of a two-color plot cost one Uint32Array and two strings.
 */
export interface ColorTrack {
  /** The CSS color of every slot when colors never change (null = invisible), used when `indexes` is null. */
  uniform: string | null;
  /** Per-slot palette index (0 = invisible) when colors vary. */
  indexes: Uint32Array | null;
  /** `palette[0]` is the invisible entry. */
  palette: string[];
}

export const EMPTY_TRACK: ColorTrack = { uniform: null, indexes: null, palette: [''] };

/** CSS color of a slot, or null when invisible / outside the track. */
export function trackColor(track: ColorTrack, slot: number): string | null {
  if (track.indexes === null) return track.uniform;
  if (slot < 0 || slot >= track.indexes.length) return null;
  const i = track.indexes[slot];
  return i === 0 ? null : track.palette[i];
}

/** Builds a track from wire colors, placing wire index `i` at slot `i + shift` of a track of `length` slots. */
export function buildColorTrack(
  uniform: string | null | undefined,
  perBar: readonly (string | null)[] | null | undefined,
  length: number,
  shift = 0,
  keep: (sourceIndex: number) => boolean = () => true,
): ColorTrack {
  if (!perBar) {
    return { uniform: cssColor(uniform ?? null), indexes: null, palette: [''] };
  }
  const palette: string[] = [''];
  const lookup = new Map<string, number>();
  const indexes = new Uint32Array(Math.max(0, length));
  for (let i = 0; i < perBar.length; i++) {
    const slot = i + shift;
    if (slot < 0 || slot >= length || !keep(i)) continue;
    const c = cssColor(perBar[i]);
    if (c === null) continue;
    let idx = lookup.get(c);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(c);
      lookup.set(c, idx);
    }
    indexes[slot] = idx;
  }
  return { uniform: null, indexes, palette };
}
