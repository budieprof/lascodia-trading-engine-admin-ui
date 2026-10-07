import { parseCssRgb, parsePineColor, type Rgba } from '@shared/pine-chart/core/color';

/**
 * Colours for the price axis's labels in a bar's colour: the series' own last-value label and the
 * countdown drawn under it (BarCountdownPrimitive), which read as one two-line box.
 *
 * A script's `barcolor()` can be translucent — Smart Algo v2 fades a down-close to 45% — and the
 * library treats the two labels differently: it draws its own label with the alpha dropped, so the
 * faded bar's label came out at full strength, and a primitive's label exactly as given, so the
 * countdown let the axis prices show through it ("05:10:30" over "1.11500"). Both now take the
 * colour as the bar shows it — laid over the chart's background, opaque — and text that reads on it.
 * An opaque colour is passed through untouched.
 */

/** `color` as it shows over `background`, made opaque; an opaque or unreadable colour as given. */
export function opaqueOver(color: string, background: string): string {
  const c = parse(color);
  if (!c || c.a >= 1) return color;
  const bg = parse(background);
  if (!bg) return color;
  const mix = (front: number, back: number) => Math.round(front * c.a + back * (1 - c.a));
  return `rgb(${mix(c.r, bg.r)}, ${mix(c.g, bg.g)}, ${mix(c.b, bg.b)})`;
}

/**
 * Text for a label on `background`, by Lightweight Charts' own rule for its labels (grey level over
 * 160 takes black, else white — `generateContrastColors`). The series' label beside the countdown
 * gets its text from the library, so the countdown follows the same rule: on a light bar colour
 * the countdown's white text used to sit under the price label's black.
 */
export function labelTextColor(background: string): string {
  const c = parse(background);
  if (!c) return '#ffffff';
  return 0.199 * c.r + 0.687 * c.g + 0.114 * c.b > 160 ? '#000000' : '#ffffff';
}

/**
 * The series' `priceLineColor` for the bar its last-value label shows: the bar's colour laid over
 * the background when that colour is translucent; '' otherwise, which leaves the library's own
 * colouring (the bar's colour, or the style's up/down colour) exactly as it was.
 */
export function lastValueLabelColor(
  barColor: string | null | undefined,
  background: string,
): string {
  if (!barColor) return '';
  const c = parse(barColor);
  return c && c.a < 1 ? opaqueOver(barColor, background) : '';
}

/** Pine's `#RRGGBBAA` (and shorter hex) or CSS `rgb()` / `rgba()`, as bar colours reach the chart. */
function parse(color: string): Rgba | null {
  return parsePineColor(color) ?? parseCssRgb(color);
}
