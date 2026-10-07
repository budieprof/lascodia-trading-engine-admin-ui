/**
 * How a Pine run lands on the chart-analysis chart beyond what its primitives paint: the bars its
 * `barcolor()` recolours and the room its future drawings need right of the last bar. Pure, so the
 * host can ask while it rebuilds its series, and every rule is testable without a chart.
 *
 * <p>Alignment is `script-renderer`'s: the run's last bar is found on the host axis by time and
 * every other run bar sits at the same distance from it (run index + offset = host index), which
 * holds because both are the engine's candles at the same resolution. Host times are the plotted
 * ones — zone-shifted, Lightweight Charts seconds.</p>
 */

/** TradingView's default space right of the last bar, in bars (the time scale's `rightOffset`). */
export const DEFAULT_RIGHT_OFFSET = 5;
/** The most bars of empty space drawings in the future may claim. */
export const MAX_SCRIPT_RIGHT_OFFSET = 40;
/** Bars of air kept beyond the furthest drawing. */
const MARGIN_PAD_BARS = 2;
/**
 * A margin this many bars wider than needed is kept rather than shrunk. A bar that opens before a
 * script's live re-run brings its drawings one bar closer for a moment; without slack the view would
 * step back and forth each time.
 */
const MARGIN_SHRINK_SLACK = 2;

/**
 * Host index of the run's bar 0: where the run's last bar sits on the host axis, minus its own
 * index. Null when the host has no bar at `lastTime` (its window ends earlier, or a different
 * sequence): nothing of the run can be placed then, as `script-renderer` hides its drawings.
 */
export function runOffsetOnHost(
  hostTimes: ArrayLike<number>,
  lastTime: number,
  lastIndex: number,
): number | null {
  // Lower bound, as the library's timeToIndex: the first of equal times.
  let lo = 0;
  let hi = hostTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (hostTimes[mid] < lastTime) lo = mid + 1;
    else hi = mid;
  }
  return lo < hostTimes.length && hostTimes[lo] === lastTime ? lo - lastIndex : null;
}

/**
 * A run's `barcolor()` (one entry per run bar, null = not coloured) on the host's bars: one entry
 * per host bar. Run bars that fall off the host's window are dropped. Null when no host bar ends up
 * coloured.
 */
export function barColorsOnHost(
  colors: readonly (string | null)[],
  offset: number | null,
  hostLength: number,
): (string | null)[] | null {
  if (offset === null) return null;
  let out: (string | null)[] | null = null;
  const end = Math.min(hostLength, offset + colors.length);
  for (let h = Math.max(0, offset); h < end; h++) {
    const c = colors[h - offset];
    if (!c) continue;
    out ??= new Array<string | null>(hostLength).fill(null);
    out[h] = c;
  }
  return out;
}

/**
 * Several runs' colours over the same host bars, in the order the scripts were added: a later one
 * wins on every bar it colours and leaves the others alone — TradingView's rule for stacked
 * `barcolor()` scripts.
 */
export function mergeBarColors(
  layers: readonly ((string | null)[] | null)[],
): (string | null)[] | null {
  let out: (string | null)[] | null = null;
  for (const layer of layers) {
    if (!layer) continue;
    if (!out) {
      out = [...layer];
      continue;
    }
    for (let i = 0; i < layer.length; i++) if (layer[i]) out[i] = layer[i];
  }
  return out;
}

export function sameBarColors(
  a: readonly (string | null)[] | null,
  b: readonly (string | null)[] | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Which parts of a bar a colour paints: a candle's body, border and wick; a hollow candle's border
 * and wick (its body stays hollow — the style's whole point); a bar's single colour (OHLC and HLC
 * bars, and the HiLo / volume-candle custom series).
 */
export type BarPaint = 'candle' | 'hollow' | 'bar';

/** The per-bar colour fields of Lightweight Charts' candle and bar data. */
export interface BarColorFields {
  color?: string;
  borderColor?: string;
  wickColor?: string;
}

export function withBarColor<T extends object>(
  row: T,
  color: string | null | undefined,
  paint: BarPaint,
): T & BarColorFields {
  if (!color) return row as T & BarColorFields;
  if (paint === 'bar') return { ...row, color };
  if (paint === 'hollow') return { ...row, borderColor: color, wickColor: color };
  return { ...row, color, borderColor: color, wickColor: color };
}

/**
 * Bars past the host's last bar that a run's outputs reach (future labels, lines and boxes,
 * positive plot offsets): its own future slots, less the bars the host has opened since the run.
 */
export function futureBarsOnHost(
  offset: number | null,
  lastIndex: number,
  futureSlots: number,
  hostLength: number,
): number {
  if (offset === null || !(futureSlots > 0) || hostLength === 0) return 0;
  return Math.max(0, offset + lastIndex + futureSlots - (hostLength - 1));
}

/**
 * The largest margin a chart `widthPx` wide at `barSpacing` px per bar gives drawings: the cap, or
 * half the bars on screen when that is less — a narrow chart keeps most of its width for price.
 */
export function marginCap(widthPx: number, barSpacing: number): number {
  if (!(widthPx > 0) || !(barSpacing > 0)) return MAX_SCRIPT_RIGHT_OFFSET;
  return Math.max(
    DEFAULT_RIGHT_OFFSET,
    Math.min(MAX_SCRIPT_RIGHT_OFFSET, Math.floor(widthPx / barSpacing / 2)),
  );
}

/**
 * The time scale's right offset for drawings reaching `reach` bars past the last bar, given the
 * `current` one: the furthest drawing plus two bars, between the default and `cap`; the default
 * once nothing reaches the future. Grows at once; shrinks only past a little slack.
 */
export function scriptRightOffset(
  current: number,
  reach: number,
  cap = MAX_SCRIPT_RIGHT_OFFSET,
): number {
  if (!(reach > 0)) return DEFAULT_RIGHT_OFFSET;
  const want = Math.max(DEFAULT_RIGHT_OFFSET, Math.min(cap, Math.ceil(reach) + MARGIN_PAD_BARS));
  if (want > current) return want;
  return current - want > MARGIN_SHRINK_SLACK ? want : current;
}

/**
 * Whether changing the right offset `from` → `to` may move the view, which is at `scrollPos` (bars
 * from the last bar to the right edge; negative = scrolled into history). Growing moves it only at
 * the live edge — the newest bar on screen — and only when less than `to` is showing. Shrinking
 * moves it only while it still sits where the margin put it. Any other view is the operator's.
 */
export function marginMovesView(from: number, to: number, scrollPos: number): boolean {
  if (to > from) return scrollPos > -0.5 && scrollPos < to;
  return Math.abs(scrollPos - from) < 0.5;
}

/**
 * The scroll position a layout saves. At the live edge of a margin the scripts opened, it is the
 * default's: the margin belongs to the drawings, and saving it would reopen the chart with empty
 * space the operator never chose. Anywhere else the position is the operator's own.
 */
export function savedRightOffset(scrollPos: number, rightOffset: number): number {
  return rightOffset !== DEFAULT_RIGHT_OFFSET && Math.abs(scrollPos - rightOffset) < 0.5
    ? DEFAULT_RIGHT_OFFSET
    : scrollPos;
}

/** The inverse on restore: a saved live edge reopens at the chart's current one. */
export function restoredRightOffset(saved: number, rightOffset: number): number {
  return Math.abs(saved - DEFAULT_RIGHT_OFFSET) < 0.5 ? rightOffset : saved;
}
