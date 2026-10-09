import type { Pt } from './geometry';
import type { Drawing, DrawingPoint } from './model';

/**
 * Pure drawing operations shared by the controller, the store and the
 * settings dialog. Kept free of Angular and the canvas so every TradingView
 * rule here is unit-testable.
 */

/** TradingView's magnet: off, weak (snaps when near a bar value) or strong (always snaps). */
export type MagnetMode = 'off' | 'weak' | 'strong';

/**
 * Magnet in force for one pointer event. Holding Ctrl/Cmd temporarily inverts
 * it, as on TradingView: off becomes strong, weak/strong become off.
 */
export function effectiveMagnet(mode: MagnetMode, modifier: boolean): MagnetMode {
  if (!modifier) return mode;
  return mode === 'off' ? 'strong' : 'off';
}

/**
 * Shift-constrain the segment `from → to` to the nearest multiple of 45°
 * (horizontal, vertical or diagonal), keeping its length — TradingView's Shift
 * behaviour while placing or dragging a line point.
 */
export function snapAngle(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...to };
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  // Horizontal/vertical keep the pointer's own coordinate on the free axis, so
  // the point lands exactly where the cursor is along the constrained line.
  const r = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  const cos = r(Math.cos(angle));
  const sin = r(Math.sin(angle));
  if (sin === 0) return { x: to.x, y: from.y };
  if (cos === 0) return { x: from.x, y: to.y };
  const proj = dx * cos + dy * sin;
  return { x: from.x + proj * cos, y: from.y + proj * sin };
}

/** Shift every anchor by a time and price delta. */
export function shiftPoints(points: readonly DrawingPoint[], dt: number, dp: number): DrawingPoint[] {
  return points.map((p) => ({ time: p.time + dt, price: p.price + dp }));
}

/**
 * Move every anchor by `dBars` bars (fractional allowed) and `dp` in price — TradingView's
 * move semantics. Shifting by milliseconds instead lands anchors inside weekends and session
 * gaps, which squashes or tears multi-point shapes; counting bars keeps the shape intact.
 * Falls back to a time shift when the bar mapping is unavailable.
 */
export function shiftPointsByBars(
  points: readonly DrawingPoint[],
  dBars: number,
  dp: number,
  logicalAt: (t: number) => number | null,
  timeAtLogical: (l: number) => number | null,
  fallbackDt: number,
): DrawingPoint[] {
  return points.map((p) => {
    const l = logicalAt(p.time);
    const t = l === null ? null : timeAtLogical(l + dBars);
    return { time: t ?? p.time + fallbackDt, price: p.price + dp };
  });
}

// ── Visibility on intervals (TV "Visibility" tab) ──────────────────────────

export type IntervalUnit = 'ticks' | 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export interface IntervalGroup {
  unit: IntervalUnit;
  label: string;
  /** TradingView's range bounds for this unit. */
  min: number;
  max: number;
  /** False where this chart has no such resolutions (ticks, seconds). */
  available: boolean;
}

export const INTERVAL_GROUPS: readonly IntervalGroup[] = [
  { unit: 'ticks', label: 'Ticks', min: 1, max: 1000, available: false },
  { unit: 'seconds', label: 'Seconds', min: 1, max: 59, available: false },
  { unit: 'minutes', label: 'Minutes', min: 1, max: 59, available: true },
  { unit: 'hours', label: 'Hours', min: 1, max: 24, available: true },
  { unit: 'days', label: 'Days', min: 1, max: 366, available: true },
  { unit: 'weeks', label: 'Weeks', min: 1, max: 52, available: true },
  { unit: 'months', label: 'Months', min: 1, max: 12, available: true },
];

/** A chart resolution (`1`, `60`, `1D`, `1W`, `1M`…) as TradingView's unit + count. */
export function intervalOf(resolution: string): { unit: IntervalUnit; value: number } | null {
  const m = /^(\d*)([SDWM]?)$/.exec(resolution);
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  switch (m[2]) {
    case 'S':
      return { unit: 'seconds', value: n };
    case 'D':
      return { unit: 'days', value: n };
    case 'W':
      return { unit: 'weeks', value: n };
    case 'M':
      return { unit: 'months', value: n };
    default:
      return n % 60 === 0 ? { unit: 'hours', value: n / 60 } : { unit: 'minutes', value: n };
  }
}

export type IntervalVisibility = Record<IntervalUnit, { on: boolean; from: number; to: number }>;

/**
 * A drawing's `visibleOn` is a list of tokens (DR-I2): a UNIT RANGE as the Visibility tab sets it —
 * `hours:1-4` = every timeframe from 1 to 4 hours, so a typed 3h shows it too — or a single resolution (`240`),
 * which is how drawings from before kept per symbol read (their own timeframe). `none` = no timeframe at all.
 * Absent or empty = every timeframe.
 */
const NONE = 'none';

function rangeToken(token: string): { unit: IntervalUnit; from: number; to: number } | null {
  const m = /^([a-z]+):(\d+)-(\d+)$/.exec(token);
  if (!m || !INTERVAL_GROUPS.some((g) => g.unit === m[1])) return null;
  return { unit: m[1] as IntervalUnit, from: Number(m[2]), to: Number(m[3]) };
}

/** Dialog state for a drawing's `visibleOn` (absent/empty = visible everywhere). */
export function visibilityFromList(visibleOn: readonly string[] | undefined, resolutions: readonly string[]): IntervalVisibility {
  const all = !visibleOn || visibleOn.length === 0;
  const out = {} as IntervalVisibility;
  for (const g of INTERVAL_GROUPS) {
    const range = all ? null : visibleOn!.map(rangeToken).find((r) => r?.unit === g.unit);
    if (range) {
      out[g.unit] = { on: true, from: range.from, to: range.to };
      continue;
    }
    // Single resolutions (drawings saved before the ranges): the unit's span over the listed ones.
    const values = (all ? resolutions : visibleOn!)
      .map(intervalOf)
      .filter((i): i is { unit: IntervalUnit; value: number } => !!i && i.unit === g.unit)
      .map((i) => i.value);
    const on = all ? true : values.length > 0;
    out[g.unit] =
      all || values.length === 0
        ? { on, from: g.min, to: g.max }
        : { on, from: Math.min(...values), to: Math.max(...values) };
  }
  return out;
}

/**
 * Dialog state → `visibleOn`: a range per unit that is on, `undefined` when every unit is on over its whole range
 * (every timeframe), `['none']` when every unit is off. `resolutions` is kept for the call sites' symmetry.
 */
export function visibilityToList(v: IntervalVisibility, resolutions: readonly string[]): string[] | undefined {
  void resolutions;
  const groups = INTERVAL_GROUPS.filter((g) => g.available);
  const everything = groups.every((g) => v[g.unit]?.on && v[g.unit].from <= g.min && v[g.unit].to >= g.max);
  if (everything) return undefined;
  const list = groups.filter((g) => v[g.unit]?.on).map((g) => `${g.unit}:${v[g.unit].from}-${v[g.unit].to}`);
  return list.length ? list : [NONE];
}

/**
 * Whether a drawing is ON the chart at `resolution` by its Visibility list (DR-I2: a drawing belongs to its symbol
 * and shows on every timeframe its list allows; empty = all) — whether or not its eye hides it.
 */
export function isShownOn(d: Pick<Drawing, 'visibleOn'>, resolution: string): boolean {
  const list = d.visibleOn;
  if (!list || list.length === 0) return true;
  const iv = intervalOf(resolution);
  for (const token of list) {
    if (token === resolution) return true;
    const r = rangeToken(token);
    if (r && iv && r.unit === iv.unit && iv.value >= r.from && iv.value <= r.to) return true;
  }
  // A timeframe the units cannot place (none today) is not hidden by a range it cannot be measured against.
  return !iv && list.some((t) => rangeToken(t) !== null);
}

/** Whether a drawing is painted on `resolution` — hidden drawings and excluded intervals are not. */
export function isVisibleOn(d: Pick<Drawing, 'hidden' | 'visibleOn'>, resolution: string): boolean {
  if (d.hidden) return false;
  return isShownOn(d, resolution);
}

// ── Visual order ───────────────────────────────────────────────────────────

export type ZOrderOp = 'front' | 'back' | 'forward' | 'backward';

/** Paint order: ascending `z`, ties broken by list order (creation). */
export function byZ<T extends Pick<Drawing, 'z'>>(list: readonly T[]): T[] {
  return list
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (a.d.z ?? 0) - (b.d.z ?? 0) || a.i - b.i)
    .map((x) => x.d);
}

/** New `z` for every drawing in `scope` after moving `id`. Returns id → z. */
export function reorder(scope: readonly Drawing[], id: string, op: ZOrderOp): Map<string, number> {
  const ordered = byZ(scope);
  const from = ordered.findIndex((d) => d.id === id);
  const out = new Map<string, number>();
  if (from < 0) return out;
  const [item] = ordered.splice(from, 1);
  const to =
    op === 'front'
      ? ordered.length
      : op === 'back'
        ? 0
        : op === 'forward'
          ? Math.min(ordered.length, from + 1)
          : Math.max(0, from - 1);
  ordered.splice(to, 0, item);
  ordered.forEach((d, i) => out.set(d.id, i));
  return out;
}

/** The z one above everything in `scope` — where a new drawing lands. */
export function topZ(scope: readonly Pick<Drawing, 'z'>[]): number {
  return scope.reduce((m, d) => Math.max(m, d.z ?? 0), -1) + 1;
}

/** Typical bar spacing in ms (median of the last gaps) — one arrow-key nudge sideways. */
export function barStepMs(bars: readonly { time: number }[]): number {
  const gaps: number[] = [];
  for (let i = Math.max(1, bars.length - 50); i < bars.length; i++) gaps.push(bars[i].time - bars[i - 1].time);
  if (gaps.length === 0) return 60_000;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] || 60_000;
}

/** Whether a press moved far enough to be a drag rather than a click (TV ~3px). */
export function isDrag(a: Pt, b: Pt, threshold = 4): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) > threshold;
}
