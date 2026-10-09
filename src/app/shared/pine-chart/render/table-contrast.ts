import { luminance, parseCssRgb, parsePineColor, toCss, type Rgba } from '../core/color';
import type { TableCellLayout, TableLayout } from './render-model';

/**
 * Readable Pine tables (PC-I11, PC-02): a script's table colours are drawn verbatim, and a
 * dashboard written for one chart theme can come out as white text on a translucent grey over a
 * white chart (~1.3:1). The guard reads each cell as it really shows — its background over the
 * table's over the chart's — and turns text that reads under 3:1 there black or white, whichever
 * reads better. Text the script made fully transparent stays hidden. Pure.
 */

/** WCAG's minimum for large or bold text; below it a cell is hard to read. */
export const MIN_TABLE_CONTRAST = 3;

const BLACK = { r: 19, g: 23, b: 34, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function read(c: string | null | undefined): Rgba | null {
  if (!c || c === 'transparent') return null;
  return parsePineColor(c) ?? parseCssRgb(c);
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Rgba | null, bottom: Rgba): Rgba {
  if (!top || top.a <= 0) return bottom;
  const a = Math.min(1, top.a);
  const mix = (t: number, b: number) => t * a + b * (1 - a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** WCAG contrast ratio of two opaque colours (1 … 21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * A text colour that reads on `background` (opaque): `text` itself when it reads at 3:1 or better
 * there, else black or white — whichever reads better. Null text (transparent) stays transparent.
 */
export function readableText(text: string, background: Rgba): string {
  const t = read(text);
  if (!t || t.a <= 0) return text;
  const shown = over(t, background);
  if (contrastRatio(shown, background) >= MIN_TABLE_CONTRAST) return text;
  return toCss(contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE);
}

/** A table with every cell's text readable over the chart's `chartBackground` (a CSS colour). */
export function readableTable(t: TableLayout, chartBackground: string): TableLayout {
  const chart = read(chartBackground) ?? WHITE;
  const base = over(read(t.bgColor), { ...chart, a: 1 });
  let changed = false;
  const cells = t.cells.map((c): TableCellLayout => {
    if (!c.text) return c;
    const textColor = readableText(c.textColor, over(read(c.bgColor), base));
    if (textColor === c.textColor) return c;
    changed = true;
    return { ...c, textColor };
  });
  return changed ? { ...t, cells } : t;
}
