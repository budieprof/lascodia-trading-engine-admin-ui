import type { PaintCtx } from '../paint-ctx';
import { distanceToSegment, type Pt } from '../geometry';
import type { ToolOption } from './types';

/**
 * Shared machinery for the Gann & Fibonacci family.
 *
 * Every tool in the family builds a SCENE — line segments, arcs, filled
 * polygons and labels — from its anchors and options. Painting and hit-testing
 * both consume the same scene, so what you can grab is exactly what is drawn.
 */

export interface Level {
  value: number;
  color: string;
  visible: boolean;
}

export interface SceneLine {
  a: Pt;
  b: Pt;
  color: string;
  width: number;
  dash?: number[];
}
export interface SceneArc {
  c: Pt;
  rx: number;
  ry: number;
  start: number;
  end: number;
  color: string;
  width: number;
}
export interface SceneFill {
  poly: Pt[];
  color: string;
}
/** Filled ring segment between two concentric (elliptic) arcs. */
export interface SceneRing {
  c: Pt;
  r0: [number, number];
  r1: [number, number];
  start: number;
  end: number;
  color: string;
}
export interface SceneLabel {
  text: string;
  at: Pt;
  color: string;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
}
export interface Scene {
  lines: SceneLine[];
  arcs: SceneArc[];
  fills: SceneFill[];
  rings: SceneRing[];
  labels: SceneLabel[];
}

export const emptyScene = (): Scene => ({ lines: [], arcs: [], fills: [], rings: [], labels: [] });

export type Opts = Record<string, unknown>;
export type Ctx = PaintCtx & { options: Opts };

// ── TradingView palette ────────────────────────────────────────────────────
export const GRAY = '#787B86';
export const RED = '#F23645';
export const ORANGE = '#FF9800';
export const GREEN = '#4CAF50';
export const TEAL = '#089981';
export const CYAN = '#00BCD4';
export const BLUE = '#2962FF';
export const PURPLE = '#9C27B0';
export const PINK = '#E91E63';
export const AMBER = '#FFB74D'; // unused slot colour TV gives hidden extras

export const lv = (value: number, color: string, visible = true): Level => ({ value, color, visible });

/** TV "Fib Retracement" / "Trend-Based Fib Extension" / "Fib Channel" default set (24 slots). */
export const FIB_LEVELS_TV: readonly Level[] = [
  lv(0, GRAY),
  lv(0.236, RED),
  lv(0.382, ORANGE),
  lv(0.5, GREEN),
  lv(0.618, TEAL),
  lv(0.786, CYAN),
  lv(1, GRAY),
  lv(1.618, BLUE),
  lv(2.618, RED),
  lv(3.618, PURPLE),
  lv(4.236, PINK),
  lv(1.272, ORANGE, false),
  lv(1.414, RED, false),
  lv(2, TEAL, false),
  lv(2.272, ORANGE, false),
  lv(2.414, GREEN, false),
  lv(3, CYAN, false),
  lv(3.272, GRAY, false),
  lv(3.414, BLUE, false),
  lv(4, RED, false),
  lv(4.272, PURPLE, false),
  lv(4.414, PINK, false),
  lv(4.618, ORANGE, false),
  lv(4.764, CYAN, false),
];

/** TV "Fib Time Zone" — Fibonacci counts. */
export const TIMEZONE_LEVELS_TV: readonly Level[] = [
  lv(0, GRAY),
  lv(1, BLUE),
  lv(2, BLUE),
  lv(3, BLUE),
  lv(5, BLUE),
  lv(8, BLUE),
  lv(13, BLUE),
  lv(21, BLUE),
  lv(34, BLUE),
  lv(55, BLUE),
  lv(89, BLUE),
];

/** TV "Trend-Based Fib Time". */
export const TREND_TIME_LEVELS_TV: readonly Level[] = [
  lv(0, GRAY),
  lv(0.382, RED),
  lv(0.5, GREEN),
  lv(0.618, TEAL),
  lv(1, GRAY),
  lv(1.382, CYAN),
  lv(1.618, BLUE),
  lv(2, GRAY),
  lv(2.382, PINK),
  lv(2.618, PURPLE),
  lv(3, ORANGE),
];

/** TV circles / arcs / wedge / spiral radii. */
export const RADIAL_LEVELS_TV: readonly Level[] = [
  lv(0.236, RED),
  lv(0.382, ORANGE),
  lv(0.5, GREEN),
  lv(0.618, TEAL),
  lv(0.786, CYAN),
  lv(1, GRAY),
  lv(1.618, BLUE),
  lv(2.618, RED),
  lv(3.618, PURPLE),
  lv(4.236, PINK),
];

/** TV speed-resistance fan/arc grid fractions and Gann box levels. */
export const SPEED_LEVELS_TV: readonly Level[] = [
  lv(0, GRAY),
  lv(0.25, ORANGE),
  lv(0.382, RED),
  lv(0.5, GREEN),
  lv(0.618, TEAL),
  lv(0.75, CYAN),
  lv(1, GRAY),
];

export const GANN_BOX_LEVELS_TV: readonly Level[] = SPEED_LEVELS_TV;

/** TV "Pitchfan" — offsets from the median, as a fraction of the half-width. */
export const PITCHFAN_LEVELS_TV: readonly Level[] = [
  lv(0.25, ORANGE, false),
  lv(0.382, RED, false),
  lv(0.5, GREEN),
  lv(0.618, TEAL, false),
  lv(0.75, CYAN, false),
  lv(1, BLUE),
  lv(1.5, PURPLE, false),
  lv(1.75, PINK, false),
  lv(2, ORANGE, false),
];

/**
 * Gann fan angles: `value` is price-units per time-unit relative to the 1×1
 * (1×8 = 1 price per 8 time → 0.125; 8×1 → 8). TV's default per-angle colours.
 */
export const GANN_FAN_LEVELS_TV: readonly Level[] = [
  lv(8, ORANGE),
  lv(4, GREEN),
  lv(3, TEAL),
  lv(2, CYAN),
  lv(1, GRAY),
  lv(1 / 2, RED),
  lv(1 / 3, BLUE),
  lv(1 / 4, PURPLE),
  lv(1 / 8, PINK),
];

export function gannAngleLabel(ratio: number): string {
  if (Math.abs(ratio - 1) < 1e-9) return '1/1';
  return ratio > 1 ? `${Math.round(ratio)}/1` : `1/${Math.round(1 / ratio)}`;
}

// ── Option builders ────────────────────────────────────────────────────────
export const levelsOption = (def: readonly Level[], label = 'Levels'): ToolOption => ({
  key: 'levels',
  label,
  type: 'levels',
  default: def,
  tab: 'style',
});

/** The settings TV shows on every horizontal-level Fib tool. */
export function fibLevelOptions(def: readonly Level[], extra: readonly ToolOption[] = []): ToolOption[] {
  return [
    levelsOption(def),
    { key: 'trendLine', label: 'Trend line', type: 'bool', default: true },
    { key: 'extendLeft', label: 'Extend lines left', type: 'bool', default: false },
    { key: 'extendRight', label: 'Extend lines right', type: 'bool', default: false },
    { key: 'reverse', label: 'Reverse', type: 'bool', default: false },
    { key: 'showPrices', label: 'Prices', type: 'bool', default: true },
    { key: 'showLevels', label: 'Levels', type: 'select', default: 'values', choices: ['values', 'percent', 'none'] },
    { key: 'labelsH', label: 'Labels', type: 'select', default: 'left', choices: ['left', 'center', 'right'] },
    { key: 'labelsV', label: 'Labels vertical', type: 'select', default: 'bottom', choices: ['top', 'middle', 'bottom'] },
    ...commonBackground(),
    ...extra,
  ];
}

export function commonBackground(): ToolOption[] {
  return [
    { key: 'background', label: 'Background', type: 'bool', default: true },
    { key: 'bgOpacity', label: 'Background transparency', type: 'number', default: 80, min: 0, max: 100, step: 5 },
    { key: 'useOneColor', label: 'Use one colour', type: 'bool', default: false },
    { key: 'oneColor', label: 'One colour', type: 'color', default: BLUE },
    { key: 'levelWidth', label: 'Levels line width', type: 'number', default: 1, min: 1, max: 4, step: 1 },
  ];
}

// ── Option readers ─────────────────────────────────────────────────────────
export function levelsOf(o: Opts, fallback: readonly Level[]): Level[] {
  const raw = o['levels'];
  const list = Array.isArray(raw) ? (raw as Level[]) : (fallback as Level[]);
  const color = o['useOneColor'] ? String(o['oneColor'] ?? BLUE) : null;
  return list
    .filter((l) => l && l.visible !== false && Number.isFinite(Number(l.value)))
    .map((l) => ({ value: Number(l.value), color: color ?? l.color, visible: true }))
    .sort((a, b) => a.value - b.value);
}

export const bool = (o: Opts, k: string, d = false): boolean => (o[k] === undefined ? d : Boolean(o[k]));
export const num = (o: Opts, k: string, d: number): number => {
  const v = Number(o[k]);
  return Number.isFinite(v) ? v : d;
};
export const str = (o: Opts, k: string, d: string): string => (typeof o[k] === 'string' ? (o[k] as string) : d);

/** `#RRGGBB` + TV transparency (0 = opaque, 100 = invisible) → rgba(). */
export function withAlpha(color: string, transparency: number): string {
  const a = Math.max(0, Math.min(1, 1 - transparency / 100));
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function fmtLevel(v: number): string {
  return String(+v.toFixed(3));
}

/** TV level text: "0.618 (1.12345)", "61.8% (1.12345)", or just the price. */
export function levelText(value: number, price: number | null, o: Opts, precision: number): string {
  const mode = str(o, 'showLevels', 'values');
  const lvl = mode === 'percent' ? `${+(value * 100).toFixed(1)}%` : mode === 'values' ? fmtLevel(value) : '';
  const pr = bool(o, 'showPrices', true) && price !== null ? price.toFixed(precision) : '';
  if (lvl && pr) return `${lvl} (${pr})`;
  return lvl || pr;
}

// ── Pure math (exported for specs) ─────────────────────────────────────────
/**
 * Fib retracement level price. TV places level 0 at the SECOND anchor and
 * level 1 at the first; "Reverse" swaps them.
 */
export function retracementPrice(p1: number, p2: number, level: number, reverse = false): number {
  const [zero, one] = reverse ? [p1, p2] : [p2, p1];
  return zero + (one - zero) * level;
}

/**
 * Trend-based Fib extension: the p1→p2 move projected from p3. Level 0 sits
 * on p3, level 1 at p3 + (p2 − p1). Reverse projects the move the other way.
 */
export function extensionPrice(p1: number, p2: number, p3: number, level: number, reverse = false): number {
  const move = (p2 - p1) * (reverse ? -1 : 1);
  return p3 + move * level;
}

/** Fib time zone: bar offsets from the first anchor given the 0→1 unit in bars. */
export function timezoneBars(unitBars: number, levels: readonly number[]): number[] {
  return levels.map((n) => n * unitBars);
}

/** Gann angle slope in price per bar given the 1×1 price-per-bar scale. */
export function gannSlope(ratio: number, pricePerBar: number): number {
  return ratio * pricePerBar;
}

// ── Geometry helpers ───────────────────────────────────────────────────────
export function farPoint(a: Pt, b: Pt, w: number, h: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return b;
  const s = (Math.abs(w) + Math.abs(h) + Math.abs(a.x) + Math.abs(a.y)) * 2;
  return { x: a.x + (dx / len) * s, y: a.y + (dy / len) * s };
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function angleIn(a: number, start: number, end: number): boolean {
  const tau = Math.PI * 2;
  const span = (((end - start) % tau) + tau) % tau || tau;
  const d = (((a - start) % tau) + tau) % tau;
  return d <= span + 1e-9;
}

export function hitScene(s: Scene, at: Pt, tol: number): boolean {
  for (const l of s.lines) if (distanceToSegment(at, l.a, l.b) <= tol) return true;
  for (const a of s.arcs) {
    if (a.rx <= 0 || a.ry <= 0) continue;
    const dx = (at.x - a.c.x) / a.rx;
    const dy = (at.y - a.c.y) / a.ry;
    const r = Math.hypot(dx, dy);
    const scale = Math.min(a.rx, a.ry);
    if (Math.abs(r - 1) * scale <= tol && angleIn(Math.atan2(dy, dx), a.start, a.end)) return true;
  }
  return false;
}

// ── Painting ───────────────────────────────────────────────────────────────
export function paintScene(ctx: CanvasRenderingContext2D, s: Scene, fontSize = 12): void {
  ctx.save();
  for (const f of s.fills) {
    if (f.poly.length < 3) continue;
    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.moveTo(f.poly[0].x, f.poly[0].y);
    for (const p of f.poly.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();
  }
  for (const r of s.rings) {
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.ellipse(r.c.x, r.c.y, r.r1[0], r.r1[1], 0, r.start, r.end, false);
    ctx.ellipse(r.c.x, r.c.y, Math.max(0, r.r0[0]), Math.max(0, r.r0[1]), 0, r.end, r.start, true);
    ctx.closePath();
    ctx.fill();
  }
  for (const l of s.lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.setLineDash(l.dash ?? []);
    ctx.beginPath();
    ctx.moveTo(l.a.x, l.a.y);
    ctx.lineTo(l.b.x, l.b.y);
    ctx.stroke();
  }
  for (const a of s.arcs) {
    if (a.rx <= 0 || a.ry <= 0) continue;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.width;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.ellipse(a.c.x, a.c.y, a.rx, a.ry, 0, a.start, a.end, false);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
  for (const t of s.labels) {
    if (!t.text) continue;
    ctx.fillStyle = t.color;
    ctx.textAlign = t.align;
    ctx.textBaseline = t.baseline;
    ctx.fillText(t.text, t.at.x, t.at.y);
  }
  ctx.restore();
}
