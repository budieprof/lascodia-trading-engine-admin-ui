import { distanceToSegment, type Pt } from '../geometry';
import type { PaintCtx } from '../paint-ctx';
import type { Drawing, DrawingPoint } from '../model';
import type { ToolBehavior, ToolBehaviorMap, ToolGeometry, ToolOption } from './types';
import {
  add,
  channelOffset,
  disjointSecond,
  extendSegment,
  formatSpan,
  linearRegression,
  mid,
  pitchforkGeometry,
  pitchforkLevelStarts,
  screenAngle,
  sub,
  type PitchforkVariant,
} from './trend-geometry';

/**
 * TradingView rail family "Trend line tools": lines, channels and pitchforks.
 * Geometry lives in `trend-geometry.ts`; this file paints, places handles,
 * maps handle drags back to anchors and hit-tests what is actually drawn
 * (extensions included).
 */

type P = PaintCtx & { options: Record<string, unknown> };

export const TV_BLUE = '#2962FF';
export const TV_FILL = 'rgba(41,98,255,0.2)';
const FONT = '12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

// ── painting primitives ────────────────────────────────────────────────────

function seg(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Coloured tag with white text (TV axis-style label). */
function tag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bg: string,
  align: 'left' | 'right' | 'center' = 'center',
): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = FONT;
  const w = ctx.measureText(text).width + 10;
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  ctx.fillStyle = bg;
  ctx.fillRect(left, y - 10, w, 20);
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, left + 5, y);
  ctx.restore();
}

/** Multi-line stats box, TV style: light panel, dark text, 12px. */
function statsBox(ctx: CanvasRenderingContext2D, lines: string[], at: Pt, color: string): void {
  if (!lines.length) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = FONT;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
  const h = lines.length * 18 + 8;
  const x = at.x + 10;
  const y = at.y - h / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 4);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#131722';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 13 + i * 18));
  ctx.restore();
}

/** Text tab: drawn above the line's midpoint, rotated with it (TV). */
function lineText(p: P, a: Pt, b: Pt): void {
  const { text, textColor, fontSize, color } = p.drawing.style;
  if (!text) return;
  const { ctx } = p;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `${fontSize || 12}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = textColor ?? color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const m = mid(a, b);
  ctx.translate(m.x, m.y);
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
  ctx.rotate(ang);
  ctx.fillText(text, 0, -4);
  ctx.restore();
}

function priceTags(p: P, pts: Pt[]): void {
  for (const q of pts) {
    const pr = p.priceAt(q.y);
    if (pr !== null) tag(p.ctx, pr.toFixed(p.precision), q.x, q.y - 16, p.drawing.style.color);
  }
}

// ── chart helpers ──────────────────────────────────────────────────────────

const bool = (o: Record<string, unknown>, k: string): boolean => o[k] === true;
const fillOf = (p: P): string => p.drawing.style.fill ?? TV_FILL;

/** price → y on the (linear) price scale, derived from priceAt. */
function yOfPrice(p: PaintCtx): ((price: number) => number) | null {
  const h = p.height || 1;
  const top = p.priceAt(0);
  const bot = p.priceAt(h);
  if (top === null || bot === null || top === bot) return null;
  return (price) => ((price - top) / (bot - top)) * h;
}

function timeOf(p: PaintCtx, i: number): number | null {
  const viaAxis = p.pts[i] ? p.timeAt?.(p.pts[i].x) : null;
  if (viaAxis !== null && viaAxis !== undefined) return viaAxis;
  return p.drawing.points[i]?.time ?? null;
}

type Bar = NonNullable<PaintCtx['bars']>[number];

export function nearestBar(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].time < t) lo = m + 1;
    else hi = m;
  }
  if (lo > 0 && Math.abs(bars[lo - 1].time - t) <= Math.abs(bars[lo].time - t)) return lo - 1;
  return lo;
}

function fmtSigned(v: number, precision: number): string {
  return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(precision)}`;
}

/** TV's trend-line / info-line stats: price range (%, ticks) · bars, time · distance · angle. */
export function statsLines(p: P, a: Pt, b: Pt): string[] {
  const o = p.options;
  const out: string[] = [];
  const p0 = p.priceAt(a.y);
  const p1 = p.priceAt(b.y);
  if (p0 !== null && p1 !== null) {
    const d = p1 - p0;
    const parts: string[] = [];
    if (o['showPriceRange'] === true) parts.push(fmtSigned(d, p.precision));
    if (o['showPercentChange'] === true && p0 !== 0) parts.push(`(${fmtSigned((d / Math.abs(p0)) * 100, 2)}%)`);
    if (o['showPipsChange'] === true) parts.push(fmtSigned(Math.round(d * 10 ** p.precision), 0));
    if (parts.length) out.push(parts.join(' '));
  }
  const t0 = timeOf(p, 0);
  const t1 = timeOf(p, 1);
  if (t0 !== null && t1 !== null) {
    const parts: string[] = [];
    if (o['showBarsRange'] === true && p.bars?.length) {
      parts.push(`${nearestBar(p.bars, t1) - nearestBar(p.bars, t0)} bars`);
    }
    if (o['showDateTimeRange'] === true) parts.push(formatSpan(t1 - t0));
    if (parts.length) out.push(parts.join(', '));
  }
  if (o['showDistance'] === true) out.push(`Distance: ${Math.round(Math.hypot(b.x - a.x, b.y - a.y))} px`);
  if (o['showAngle'] === true) out.push(`∠ ${screenAngle(a, b).toFixed(2)}°`);
  return out;
}

// ── options ────────────────────────────────────────────────────────────────

/** Charting Library Trendline/InfolineLineToolOverrides: all off for a trend line, all on for an info line. */
const stats = (on: boolean): ToolOption[] => [
  { key: 'showPriceRange', label: 'Price range', type: 'bool', default: on },
  { key: 'showPercentChange', label: 'Percent change', type: 'bool', default: on },
  { key: 'showPipsChange', label: 'Change in ticks', type: 'bool', default: on },
  { key: 'showBarsRange', label: 'Bars range', type: 'bool', default: on },
  { key: 'showDateTimeRange', label: 'Date/time range', type: 'bool', default: on },
  { key: 'showDistance', label: 'Distance', type: 'bool', default: on },
  { key: 'showAngle', label: 'Angle', type: 'bool', default: on },
];

function trendOptions(extendRight: boolean, extendLeft: boolean, alwaysStats: boolean): ToolOption[] {
  return [
    { key: 'extendLeft', label: 'Extend left', type: 'bool', default: extendLeft },
    { key: 'extendRight', label: 'Extend right', type: 'bool', default: extendRight },
    { key: 'showMiddlePoint', label: 'Middle point', type: 'bool', default: false },
    { key: 'showPriceLabels', label: 'Price labels', type: 'bool', default: false },
    { key: 'statsPosition', label: 'Stats position', type: 'select', default: alwaysStats ? 'center' : 'right', choices: ['left', 'center', 'right'] },
    { key: 'alwaysShowStats', label: 'Always show stats', type: 'bool', default: alwaysStats },
    ...stats(alwaysStats),
  ];
}

// ── 2-point lines: trend line / ray / info line / extended line ────────────

function extended(p: P, a: Pt, b: Pt): [Pt, Pt] {
  return extendSegment(a, b, bool(p.options, 'extendLeft'), bool(p.options, 'extendRight'), p.width, p.height);
}

function trendSegment(p: P): [Pt, Pt] | null {
  return p.pts.length < 2 ? null : extended(p, p.pts[0], p.pts[1]);
}

function paintTrend(p: P & { selected: boolean }): void {
  const { ctx, pts, drawing, options: o } = p;
  const s = trendSegment(p);
  if (!s) return;
  const [a, b] = pts;
  seg(ctx, s[0], s[1]);
  if (bool(o, 'showMiddlePoint')) {
    const m = mid(a, b);
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = drawing.style.color;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (bool(o, 'showPriceLabels')) priceTags(p, [a, b]);
  lineText(p, a, b);
  if (bool(o, 'alwaysShowStats') || p.selected) {
    const lines = statsLines(p, a, b);
    const pos = o['statsPosition'];
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    statsBox(ctx, lines, pos === 'left' ? l : pos === 'center' ? mid(a, b) : r, drawing.style.color);
  }
}

function hitTrend(p: P, at: Pt, tol: number): boolean {
  const s = trendSegment(p);
  return !!s && distanceToSegment(at, s[0], s[1]) <= tol;
}

const lineStyle = { color: TV_BLUE, width: 2, dash: 'solid' as const, fill: null, fontSize: 14 };

function trendTool(extendRight: boolean, extendLeft: boolean, alwaysStats: boolean): ToolBehavior {
  return {
    points: 2,
    defaultStyle: lineStyle,
    options: trendOptions(extendRight, extendLeft, alwaysStats),
    paint: paintTrend,
    hitTest: hitTrend,
  };
}

// ── trend angle ────────────────────────────────────────────────────────────

const trendAngle: ToolBehavior = {
  points: 2,
  defaultStyle: lineStyle,
  options: [
    { key: 'extendLeft', label: 'Extend left', type: 'bool', default: false },
    { key: 'extendRight', label: 'Extend right', type: 'bool', default: false },
    { key: 'showPriceLabels', label: 'Price labels', type: 'bool', default: false },
  ],
  paint(p) {
    const s = trendSegment(p);
    if (!s) return;
    const { ctx, pts } = p;
    const [a, b] = pts;
    seg(ctx, s[0], s[1]);
    const deg = screenAngle(a, b);
    const r = Math.min(50, Math.max(20, Math.hypot(b.x - a.x, b.y - a.y) / 2));
    const dir = b.x >= a.x ? 1 : -1;
    const e = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    seg(ctx, a, { x: a.x + dir * r * 1.6, y: a.y });
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, dir > 0 ? 0 : Math.PI, e, dir > 0 ? e < 0 : e > 0);
    ctx.stroke();
    ctx.font = FONT;
    ctx.fillStyle = p.drawing.style.color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = dir > 0 ? 'left' : 'right';
    ctx.fillText(`${deg.toFixed(2)}°`, a.x + dir * (r * 1.6 + 6), a.y + (b.y <= a.y ? -8 : 8));
    ctx.restore();
    if (bool(p.options, 'showPriceLabels')) priceTags(p, [a, b]);
    lineText(p, a, b);
  },
  hitTest: hitTrend,
};

// ── horizontal / vertical / cross ──────────────────────────────────────────

const PRICE_LABEL: ToolOption = { key: 'showPrice', label: 'Show price', type: 'bool', default: true };
const TIME_LABEL: ToolOption = { key: 'showTime', label: 'Show time', type: 'bool', default: true };

function priceAxisTag(p: P, y: number): void {
  if (p.options['showPrice'] === false || !p.drawing.style.showLabels) return;
  const pr = p.priceAt(y);
  if (pr !== null) tag(p.ctx, pr.toFixed(p.precision), p.width, y, p.drawing.style.color, 'right');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** TV time-axis label format: "Wed 01 Oct '26  14:00" (UTC). */
export function formatTvTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function timeAxisTag(p: P, x: number): void {
  if (p.options['showTime'] === false || !p.drawing.style.showLabels) return;
  const t = timeOf(p, 0);
  if (t !== null) tag(p.ctx, formatTvTime(t), x, p.height - 12, p.drawing.style.color);
}

function horizontalText(p: P, y: number, x0: number): void {
  const { text, textColor, color } = p.drawing.style;
  if (!text) return;
  const right = p.options['textAlign'] !== 'left';
  p.ctx.save();
  p.ctx.font = FONT;
  p.ctx.fillStyle = textColor ?? color;
  p.ctx.textBaseline = 'bottom';
  p.ctx.textAlign = right ? 'right' : 'left';
  p.ctx.fillText(text, right ? p.width - 80 : x0 + 4, y - 4);
  p.ctx.restore();
}

const TEXT_ALIGN: ToolOption = {
  key: 'textAlign',
  label: 'Text alignment',
  type: 'select',
  default: 'right',
  choices: ['left', 'right'],
  tab: 'text',
};

const horizontalLine: ToolBehavior = {
  points: 1,
  defaultStyle: lineStyle,
  options: [PRICE_LABEL, TEXT_ALIGN],
  paint(p) {
    const y = p.pts[0].y;
    seg(p.ctx, { x: 0, y }, { x: p.width, y });
    horizontalText(p, y, 0);
    priceAxisTag(p, y);
  },
  hitTest: (p, at, tol) => Math.abs(at.y - p.pts[0].y) <= tol,
};

const horizontalRay: ToolBehavior = {
  points: 1,
  defaultStyle: lineStyle,
  options: [PRICE_LABEL, TEXT_ALIGN],
  paint(p) {
    const a = p.pts[0];
    seg(p.ctx, a, { x: p.width, y: a.y });
    horizontalText(p, a.y, a.x);
    priceAxisTag(p, a.y);
  },
  hitTest: (p, at, tol) => Math.abs(at.y - p.pts[0].y) <= tol && at.x >= p.pts[0].x - tol,
};

const verticalLine: ToolBehavior = {
  points: 1,
  defaultStyle: lineStyle,
  options: [TIME_LABEL],
  paint(p) {
    const x = p.pts[0].x;
    seg(p.ctx, { x, y: 0 }, { x, y: p.height });
    timeAxisTag(p, x);
  },
  // TV puts the single handle mid-pane on a vertical line; dragging only changes time.
  handles: (p) => [{ x: p.pts[0].x, y: p.height / 2 }],
  moveHandle: (d, _i, to) => [{ time: to.time, price: d.points[0]?.price ?? to.price }],
  hitTest: (p, at, tol) => Math.abs(at.x - p.pts[0].x) <= tol,
};

const crossLine: ToolBehavior = {
  points: 1,
  defaultStyle: lineStyle,
  options: [PRICE_LABEL, TIME_LABEL],
  paint(p) {
    const a = p.pts[0];
    seg(p.ctx, { x: 0, y: a.y }, { x: p.width, y: a.y });
    seg(p.ctx, { x: a.x, y: 0 }, { x: a.x, y: p.height });
    priceAxisTag(p, a.y);
    timeAxisTag(p, a.x);
  },
  hitTest: (p, at, tol) => Math.abs(at.x - p.pts[0].x) <= tol || Math.abs(at.y - p.pts[0].y) <= tol,
};

// ── handle plumbing in screen space ────────────────────────────────────────

/** Project every anchor (and the drag target), run `f` in screen space, unproject the result. */
function viaScreen(d: Drawing, to: DrawingPoint, geo: ToolGeometry, f: (s: Pt[], t: Pt) => Pt[]): DrawingPoint[] {
  const s = d.points.map((pt) => geo.project(pt));
  const t = geo.project(to);
  if (!t || s.some((q) => q === null)) return d.points;
  const out = f(s as Pt[], t).map((q) => geo.unproject(q));
  return out.some((q) => q === null) ? d.points : (out as DrawingPoint[]);
}

// ── parallel channel ───────────────────────────────────────────────────────

/** Rails of the channel: [P1, P2] and the same line shifted vertically to pass through P3. */
export function parallelRails(pts: Pt[]): { a: Pt; b: Pt; c: Pt; d: Pt } | null {
  if (pts.length < 2) return null;
  const [a, b] = pts;
  const dy = pts.length >= 3 ? channelOffset(a, b, pts[2]) : 0;
  return { a, b, c: { x: a.x, y: a.y + dy }, d: { x: b.x, y: b.y + dy } };
}

/**
 * Handles (TV): 0 P1, 1 P2, 2/3 the second rail's ends, 4 mid of the base
 * rail, 5 mid of the second rail. Corner handles move that end of BOTH rails
 * (width kept); mid handles move one rail vertically (width changes).
 * Output P3 is normalised to sit at P1's x.
 */
export function moveParallelHandle(s: Pt[], i: number, to: Pt): Pt[] {
  const r = parallelRails(s);
  if (!r) return s;
  const dy = r.c.y - r.a.y;
  let { a, b } = r;
  let off = dy;
  switch (i) {
    case 0: a = to; break;
    case 1: b = to; break;
    case 2: a = { x: to.x, y: to.y - dy }; break;
    case 3: b = { x: to.x, y: to.y - dy }; break;
    case 4: {
      const shift = to.y - mid(a, b).y;
      a = { x: a.x, y: a.y + shift };
      b = { x: b.x, y: b.y + shift };
      off = dy - shift;
      break;
    }
    case 5: off = to.y - mid(a, b).y; break;
  }
  return [a, b, { x: a.x, y: a.y + off }];
}

const channelOptions: ToolOption[] = [
  { key: 'extendLeft', label: 'Extend left', type: 'bool', default: false },
  { key: 'extendRight', label: 'Extend right', type: 'bool', default: false },
  { key: 'showMiddleLine', label: 'Middle line', type: 'bool', default: true },
  { key: 'showBackground', label: 'Background', type: 'bool', default: true },
  { key: 'showPriceLabels', label: 'Price labels', type: 'bool', default: false },
];
const noMiddle = channelOptions.filter((o) => o.key !== 'showMiddleLine');

const parallelChannel: ToolBehavior = {
  points: 3,
  defaultStyle: { ...lineStyle, fill: TV_FILL },
  options: channelOptions,
  paint(p) {
    const r = parallelRails(p.pts);
    if (!r) return;
    const { ctx } = p;
    const [a1, b1] = extended(p, r.a, r.b);
    if (p.pts.length < 3) return seg(ctx, a1, b1);
    const [c1, d1] = extended(p, r.c, r.d);
    if (p.options['showBackground'] !== false) poly(ctx, [a1, b1, d1, c1], fillOf(p));
    seg(ctx, a1, b1);
    seg(ctx, c1, d1);
    if (p.options['showMiddleLine'] !== false) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      seg(ctx, mid(a1, c1), mid(b1, d1));
      ctx.restore();
    }
    if (bool(p.options, 'showPriceLabels')) priceTags(p, [r.a, r.b, r.c, r.d]);
  },
  handles(p) {
    const r = parallelRails(p.pts);
    if (!r) return p.pts;
    if (p.pts.length < 3) return [r.a, r.b];
    return [r.a, r.b, r.c, r.d, mid(r.a, r.b), mid(r.c, r.d)];
  },
  moveHandle: (d, i, to, geo) => viaScreen(d, to, geo, (s, t) => (s.length < 3 ? s.map((q, k) => (k === i ? t : q)) : moveParallelHandle(s, i, t))),
  hitTest(p, at, tol) {
    const r = parallelRails(p.pts);
    if (!r) return false;
    const [a1, b1] = extended(p, r.a, r.b);
    if (distanceToSegment(at, a1, b1) <= tol) return true;
    if (p.pts.length < 3) return false;
    const [c1, d1] = extended(p, r.c, r.d);
    if (distanceToSegment(at, c1, d1) <= tol) return true;
    return p.options['showMiddleLine'] !== false && distanceToSegment(at, mid(a1, c1), mid(b1, d1)) <= tol;
  },
};

// ── flat top/bottom ────────────────────────────────────────────────────────

/** Flat Top/Bottom: P1→P2 trend line; P3 sets the horizontal side over the same span. */
export function flatRails(pts: Pt[]): { a: Pt; b: Pt; c: Pt; d: Pt } | null {
  if (pts.length < 2) return null;
  const [a, b] = pts;
  const y = pts.length >= 3 ? pts[2].y : a.y;
  return { a, b, c: { x: a.x, y }, d: { x: b.x, y } };
}

/** Handles 0/1 move the trend ends; 2/3 move the flat side's level AND that end's time. */
export function moveFlatHandle(pts: DrawingPoint[], i: number, to: DrawingPoint): DrawingPoint[] {
  const [a, b, c] = pts;
  if (!c) return pts.map((q, k) => (k === i ? to : q));
  switch (i) {
    case 0: return [to, b, c];
    case 1: return [a, to, c];
    case 2: return [{ time: to.time, price: a.price }, b, { time: to.time, price: to.price }];
    default: return [a, { time: to.time, price: b.price }, { time: c.time, price: to.price }];
  }
}

const flatChannel: ToolBehavior = {
  points: 3,
  defaultStyle: { ...lineStyle, fill: TV_FILL },
  options: noMiddle,
  paint(p) {
    const r = flatRails(p.pts);
    if (!r) return;
    const [a1, b1] = extended(p, r.a, r.b);
    if (p.pts.length < 3) return seg(p.ctx, a1, b1);
    const [c1, d1] = extended(p, r.c, r.d);
    if (p.options['showBackground'] !== false) poly(p.ctx, [a1, b1, d1, c1], fillOf(p));
    seg(p.ctx, a1, b1);
    seg(p.ctx, c1, d1);
    if (bool(p.options, 'showPriceLabels')) priceTags(p, [r.a, r.b, r.c, r.d]);
  },
  handles(p) {
    const r = flatRails(p.pts);
    if (!r) return p.pts;
    return p.pts.length < 3 ? [r.a, r.b] : [r.a, r.b, r.c, r.d];
  },
  moveHandle: (d, i, to) => moveFlatHandle(d.points, i, to),
  hitTest(p, at, tol) {
    const r = flatRails(p.pts);
    if (!r) return false;
    const [a1, b1] = extended(p, r.a, r.b);
    if (distanceToSegment(at, a1, b1) <= tol) return true;
    const [c1, d1] = extended(p, r.c, r.d);
    return p.pts.length >= 3 && distanceToSegment(at, c1, d1) <= tol;
  },
};

// ── disjoint channel ───────────────────────────────────────────────────────

const disjointChannel: ToolBehavior = {
  points: 3,
  defaultStyle: { ...lineStyle, fill: TV_FILL },
  options: noMiddle,
  paint(p) {
    if (p.pts.length < 2) return;
    const [a, b] = p.pts;
    const [a1, b1] = extended(p, a, b);
    if (p.pts.length < 3) return seg(p.ctx, a1, b1);
    const [q1, q2] = disjointSecond(a, b, p.pts[2]);
    const [c1, d1] = extended(p, q1, q2);
    if (p.options['showBackground'] !== false) poly(p.ctx, [a, b, q2, q1], fillOf(p));
    seg(p.ctx, a1, b1);
    seg(p.ctx, c1, d1);
    if (bool(p.options, 'showPriceLabels')) priceTags(p, [a, b, q1, q2]);
  },
  handles(p) {
    if (p.pts.length < 3) return p.pts;
    const [q1, q2] = disjointSecond(p.pts[0], p.pts[1], p.pts[2]);
    return [p.pts[0], p.pts[1], q1, q2];
  },
  moveHandle: (d, i, to, geo) =>
    viaScreen(d, to, geo, (s, t) => {
      if (s.length < 3) return s.map((q, k) => (k === i ? t : q));
      const [a, b] = s;
      const [q1, q2] = disjointSecond(a, b, s[2]);
      switch (i) {
        case 0: return [t, b, { x: t.x, y: q1.y }];
        case 1: return [a, t, q1];
        case 2: return [a, b, { x: a.x, y: t.y }];
        default: return [a, b, { x: a.x, y: q1.y + (t.y - q2.y) }];
      }
    }),
  hitTest(p, at, tol) {
    if (p.pts.length < 2) return false;
    const [a1, b1] = extended(p, p.pts[0], p.pts[1]);
    if (distanceToSegment(at, a1, b1) <= tol) return true;
    if (p.pts.length < 3) return false;
    const [q1, q2] = disjointSecond(p.pts[0], p.pts[1], p.pts[2]);
    const [c1, d1] = extended(p, q1, q2);
    return distanceToSegment(at, c1, d1) <= tol;
  },
};

// ── regression trend ───────────────────────────────────────────────────────

export interface RegressionLines {
  base: [Pt, Pt];
  upper: [Pt, Pt];
  lower: [Pt, Pt];
  pearson: number;
}

const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] as const;

function sourceOf(bar: Bar, src: unknown): number {
  switch (src) {
    case 'open': return bar.open;
    case 'high': return bar.high;
    case 'low': return bar.low;
    case 'hl2': return (bar.high + bar.low) / 2;
    case 'hlc3': return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4': return (bar.open + bar.high + bar.low + bar.close) / 4;
    default: return bar.close;
  }
}

/**
 * Regression of the source over the bars between the two anchors, projected
 * to screen. x is linear in bar index (lightweight-charts spaces bars evenly),
 * pinned to the anchors' x. Deviation lines sit ±k standard deviations off.
 */
export function regressionLines(p: P): RegressionLines | null {
  if (p.pts.length < 2 || !p.bars?.length) return null;
  const y = yOfPrice(p);
  const t0 = timeOf(p, 0);
  const t1 = timeOf(p, 1);
  if (!y || t0 === null || t1 === null) return null;
  const [a, b] = p.pts;
  const i0 = nearestBar(p.bars, Math.min(t0, t1));
  const i1 = nearestBar(p.bars, Math.max(t0, t1));
  if (i1 - i0 < 1) return null;
  const vals = p.bars.slice(i0, i1 + 1).map((bar) => sourceOf(bar, p.options['source']));
  const fit = linearRegression(vals);
  if (!fit) return null;
  const [xl, xr] = t0 <= t1 ? [a.x, b.x] : [b.x, a.x];
  const n = vals.length - 1;
  const up = Number(p.options['upperDeviation'] ?? 2);
  const dn = Number(p.options['lowerDeviation'] ?? -2);
  const at = (k: number): [Pt, Pt] => [
    { x: xl, y: y(fit.intercept + k * fit.stdev) },
    { x: xr, y: y(fit.intercept + fit.slope * n + k * fit.stdev) },
  ];
  return { base: at(0), upper: at(up), lower: at(dn), pearson: fit.pearson };
}

const regressionTrend: ToolBehavior = {
  points: 2,
  // RegressiontrendLineToolOverrides: up/down rgba(41,98,255,0.3) 2px, base rgba(242,54,69,0.3) dashed 1px, transparency 70.
  defaultStyle: { color: 'rgba(41,98,255,0.3)', width: 2, dash: 'solid', fill: 'rgba(41,98,255,0.09)' },
  options: [
    { key: 'upperDeviation', label: 'Upper deviation', type: 'number', default: 2, step: 0.1 },
    { key: 'lowerDeviation', label: 'Lower deviation', type: 'number', default: -2, step: 0.1 },
    { key: 'useUpperDeviation', label: 'Use upper deviation', type: 'bool', default: true },
    { key: 'useLowerDeviation', label: 'Use lower deviation', type: 'bool', default: true },
    { key: 'source', label: 'Source', type: 'select', default: 'close', choices: SOURCES },
    { key: 'baseColor', label: 'Base line', type: 'color', default: 'rgba(242,54,69,0.3)' },
    { key: 'extendLines', label: 'Extend lines', type: 'bool', default: false },
    { key: 'showPearsons', label: "Pearson's R", type: 'bool', default: true },
    { key: 'showBackground', label: 'Background', type: 'bool', default: true },
  ],
  paint(p) {
    const { ctx } = p;
    const r = regressionLines(p);
    if (!r) {
      if (p.pts.length >= 2) seg(ctx, p.pts[0], p.pts[1]);
      return;
    }
    const ext = bool(p.options, 'extendLines');
    const E = (l: [Pt, Pt]) => extendSegment(l[0], l[1], false, ext, p.width, p.height);
    const useUp = p.options['useUpperDeviation'] !== false;
    const useDn = p.options['useLowerDeviation'] !== false;
    const up = E(r.upper);
    const dn = E(r.lower);
    const base = E(r.base);
    if (p.options['showBackground'] !== false) {
      if (useUp) poly(ctx, [base[0], base[1], up[1], up[0]], fillOf(p));
      if (useDn) poly(ctx, [base[0], base[1], dn[1], dn[0]], fillOf(p));
    }
    if (useUp) seg(ctx, up[0], up[1]);
    if (useDn) seg(ctx, dn[0], dn[1]);
    ctx.save();
    ctx.strokeStyle = String(p.options['baseColor'] ?? 'rgba(242,54,69,0.3)');
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    seg(ctx, base[0], base[1]);
    ctx.restore();
    if (bool(p.options, 'showPearsons')) {
      const low = r.lower[0].y > r.upper[0].y ? r.lower[0] : r.upper[0];
      ctx.save();
      ctx.font = FONT;
      ctx.fillStyle = p.drawing.style.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(r.pearson.toFixed(4), low.x, low.y + 4);
      ctx.restore();
    }
  },
  // TV: two handles, on the base (regression) line at each anchor's bar.
  handles(p) {
    const r = regressionLines(p);
    if (!r) return p.pts;
    return (timeOf(p, 0) ?? 0) <= (timeOf(p, 1) ?? 0) ? [r.base[0], r.base[1]] : [r.base[1], r.base[0]];
  },
  hitTest(p, at, tol) {
    const r = regressionLines(p);
    if (!r) return p.pts.length >= 2 && distanceToSegment(at, p.pts[0], p.pts[1]) <= tol;
    const ext = bool(p.options, 'extendLines');
    return [r.base, r.upper, r.lower].some((l) => {
      const [s, e] = extendSegment(l[0], l[1], false, ext, p.width, p.height);
      return distanceToSegment(at, s, e) <= tol;
    });
  },
};

// ── pitchforks ─────────────────────────────────────────────────────────────

/** TV's default level set; only 0.5 and 1 are on by default. */
export const PITCHFORK_LEVELS: readonly { value: number; color: string; visible: boolean }[] = [
  { value: 0.25, color: '#FFB74D', visible: false },
  { value: 0.382, color: '#81C784', visible: false },
  { value: 0.5, color: '#089981', visible: true },
  { value: 0.618, color: '#089981', visible: false },
  { value: 0.75, color: '#00BCD4', visible: false },
  { value: 1, color: '#2962FF', visible: true },
  { value: 1.5, color: '#9C27B0', visible: false },
  { value: 1.75, color: '#E91E63', visible: false },
  { value: 2, color: '#F77C80', visible: false },
];

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface ForkLine {
  from: Pt;
  to: Pt;
  color: string;
  value: number;
}

/**
 * All lines of a pitchfork in screen space. Level lines start on the P2–P3
 * tine and run parallel to the median; unextended, every line runs one
 * origin→centre length past the tine (TV), extended it runs off-canvas.
 * Levels alternate [P2 side, P3 side] in ascending value order.
 */
export function pitchforkLines(
  variant: PitchforkVariant,
  pts: Pt[],
  o: Record<string, unknown>,
  w: number,
  h: number,
): { median: [Pt, Pt]; levels: ForkLine[] } | null {
  if (pts.length < 3) return null;
  const [p1, p2, p3] = pts;
  const g = pitchforkGeometry(variant, p1, p2, p3);
  const len = Math.hypot(g.dir.x, g.dir.y);
  if (len === 0) return null;
  const reach = bool(o, 'extendLines') ? ((Math.abs(w) + Math.abs(h)) * 4) / len : 1;
  const fwd = { x: g.dir.x * reach, y: g.dir.y * reach };
  const levels: ForkLine[] = [];
  const table = (o['levels'] as typeof PITCHFORK_LEVELS | undefined) ?? PITCHFORK_LEVELS;
  for (const lv of [...table].sort((x, y) => x.value - y.value)) {
    if (!lv.visible) continue;
    for (const s of pitchforkLevelStarts(g, p2, p3, lv.value)) {
      // Inside pitchfork: rails run back to the origin's time so the fork sits inside the anchors.
      const from = variant === 'inside-pitchfork' ? sub(s, g.dir) : s;
      levels.push({ from, to: add(s, fwd), color: lv.color, value: lv.value });
    }
  }
  return { median: [g.origin, add(g.center, fwd)], levels };
}

function pitchfork(variant: PitchforkVariant): ToolBehavior {
  return {
    points: 3,
    defaultStyle: { color: '#F23645', width: 2, dash: 'solid', fill: null },
    options: [
      { key: 'extendLines', label: 'Extend lines', type: 'bool', default: false },
      { key: 'showBackground', label: 'Background', type: 'bool', default: true },
      { key: 'backgroundOpacity', label: 'Background opacity', type: 'number', default: 0.2, min: 0, max: 1, step: 0.05 },
      { key: 'levels', label: 'Levels', type: 'levels', default: PITCHFORK_LEVELS },
    ],
    paint(p) {
      const { ctx, pts } = p;
      if (pts.length < 3) {
        if (pts.length === 2) seg(ctx, pts[0], pts[1]);
        return;
      }
      const L = pitchforkLines(variant, pts, p.options, p.width, p.height);
      if (!L) return;
      // Fill each band between consecutive visible levels (from the median outward) in the outer level's colour.
      if (p.options['showBackground'] !== false) {
        const alpha = Number(p.options['backgroundOpacity'] ?? 0.2);
        const g = pitchforkGeometry(variant, pts[0], pts[1], pts[2]);
        const medFrom = variant === 'inside-pitchfork' ? g.origin : g.center;
        for (const side of [0, 1]) {
          let prev: [Pt, Pt] = [medFrom, L.median[1]];
          for (let k = side; k < L.levels.length; k += 2) {
            const lv = L.levels[k];
            poly(ctx, [prev[0], prev[1], lv.to, lv.from], withAlpha(lv.color, alpha));
            prev = [lv.from, lv.to];
          }
        }
      }
      ctx.save();
      ctx.lineWidth = 2;
      for (const lv of L.levels) {
        ctx.strokeStyle = lv.color;
        seg(ctx, lv.from, lv.to);
      }
      ctx.restore();
      seg(ctx, L.median[0], L.median[1]);
      ctx.save();
      ctx.lineWidth = 1;
      seg(ctx, pts[1], pts[2]);
      if (variant !== 'pitchfork') {
        // The shifted handle: show the P1–P2 leg it was derived from.
        ctx.setLineDash([4, 4]);
        seg(ctx, pts[0], pts[1]);
      }
      ctx.restore();
    },
    hitTest(p, at, tol) {
      const L = pitchforkLines(variant, p.pts, p.options, p.width, p.height);
      if (!L) return p.pts.length >= 2 && distanceToSegment(at, p.pts[0], p.pts[1]) <= tol;
      return (
        distanceToSegment(at, L.median[0], L.median[1]) <= tol ||
        distanceToSegment(at, p.pts[1], p.pts[2]) <= tol ||
        L.levels.some((l) => distanceToSegment(at, l.from, l.to) <= tol)
      );
    },
  };
}

export const BEHAVIORS: ToolBehaviorMap = {
  'trend-line': trendTool(false, false, false),
  ray: trendTool(true, false, false),
  'info-line': trendTool(false, false, true),
  'extended-line': trendTool(true, true, false),
  'trend-angle': trendAngle,
  'horizontal-line': horizontalLine,
  'horizontal-ray': horizontalRay,
  'vertical-line': verticalLine,
  'cross-line': crossLine,
  'parallel-channel': parallelChannel,
  'regression-channel': regressionTrend,
  'flat-channel': flatChannel,
  'disjoint-angle': disjointChannel,
  pitchfork: pitchfork('pitchfork'),
  'schiff-pitchfork': pitchfork('schiff-pitchfork'),
  'modified-schiff-pitchfork': pitchfork('modified-schiff-pitchfork'),
  'inside-pitchfork': pitchfork('inside-pitchfork'),
};
