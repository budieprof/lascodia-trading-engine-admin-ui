import type { PaintCtx } from '../advanced-painters';
import { distanceToSegment, pointInPolygon, type Pt } from '../geometry';
import type { DrawingKind } from '../model';
import type { ToolBehavior, ToolBehaviorMap, ToolOption } from './types';

/**
 * TradingView rail family "Patterns": harmonic patterns, chart patterns,
 * Elliott waves and cycles. See RAIL_LAYOUT 'patterns' in ../model.ts.
 *
 * Every painter runs both for finished drawings and for the creation preview,
 * so each one copes with fewer anchors than the tool's total.
 */

type Ctx = PaintCtx & { selected?: boolean; options: Record<string, unknown> };

// ── Shared helpers ──────────────────────────────────────────────────────────

/** `#RRGGBB` (or `rgb(...)`) → `rgba(..., alpha)`. Anything else is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(color);
  if (rgb) return `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${alpha})`;
  return color;
}

/**
 * The Fibonacci ratio TradingView prints on a harmonic leg: the size of the
 * move b→c relative to the move a→b, in price. 0 when a→b is flat.
 */
export function legRatio(a: number, b: number, c: number): number {
  const base = Math.abs(b - a);
  return base === 0 ? 0 : Math.abs(c - b) / base;
}

/** TradingView prints ratios with three decimals. */
export const fmtRatio = (r: number | undefined): string => (r ?? 0).toFixed(3);

/**
 * Whether vertex `i` of a zig-zag is a swing high on screen (smaller y than
 * its neighbours' mean). TradingView puts the label above highs, below lows.
 */
export function isSwingHigh(pts: readonly Pt[], i: number): boolean {
  const prev = pts[i - 1];
  const next = pts[i + 1];
  const ref = prev && next ? (prev.y + next.y) / 2 : (prev ?? next)?.y;
  if (ref === undefined) return true;
  return pts[i].y <= ref;
}

const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function seg(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function polyline(ctx: CanvasRenderingContext2D, pts: readonly Pt[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: readonly Pt[], fill: string): void {
  if (pts.length < 3) return;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

/** A filled rounded box with white text — TV's point / ratio label. */
function box(ctx: CanvasRenderingContext2D, text: string, at: Pt, color: string, size = 12): void {
  if (!text) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `${size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const w = ctx.measureText(text).width + 10;
  const h = size + 8;
  const x = at.x - w / 2;
  const y = at.y - h / 2;
  const r = 3;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(text, at.x, at.y + 0.5);
  ctx.restore();
}

/** Dotted connector with TradingView's ratio box at its midpoint. */
function ratioLine(p: Ctx, a: Pt, b: Pt, text: string | null): void {
  const { ctx, drawing } = p;
  ctx.save();
  ctx.setLineDash([2, 3]);
  seg(ctx, a, b);
  ctx.restore();
  if (text && drawing.style.showLabels) box(ctx, text, midpoint(a, b), drawing.style.color, 11);
}

/** Point labels: above a swing high, below a swing low. */
function pointLabels(p: Ctx, labels: readonly string[]): void {
  if (!p.drawing.style.showLabels) return;
  const { ctx, pts, drawing } = p;
  for (let i = 0; i < pts.length; i++) {
    const text = labels[i];
    if (!text) continue;
    const up = isSwingHigh(pts, i);
    box(ctx, text, { x: pts[i].x, y: pts[i].y + (up ? -16 : 16) }, drawing.style.color);
  }
}

function fillColor(p: Ctx): string | null {
  if (p.options['fillBackground'] === false) return null;
  return p.drawing.style.fill ?? withAlpha(p.drawing.style.color, 0.2);
}

export function hitSegments(pts: readonly Pt[], at: Pt, tol: number): boolean {
  for (let i = 1; i < pts.length; i++) if (distanceToSegment(at, pts[i - 1], pts[i]) <= tol) return true;
  return false;
}

function prices(p: Ctx): number[] {
  return p.drawing.points.slice(0, p.pts.length).map((pt) => pt.price);
}

const FILL_OPTION: ToolOption = { key: 'fillBackground', label: 'Background', type: 'bool', default: true };

// ── Harmonic patterns ───────────────────────────────────────────────────────

/** XABCD ratios in TV's placement: XB = AB/XA, AC = BC/AB, BD = CD/BC, XD = AD/XA. */
export function xabcdRatios(pr: readonly number[]): { xb?: number; ac?: number; bd?: number; xd?: number } {
  const [x, a, b, c, d] = pr;
  return {
    xb: b !== undefined ? legRatio(x, a, b) : undefined,
    ac: c !== undefined ? legRatio(a, b, c) : undefined,
    bd: d !== undefined ? legRatio(b, c, d) : undefined,
    xd: d !== undefined ? legRatio(x, a, d) : undefined,
  };
}

/**
 * Cypher ratios: B as a retracement of XA (on XB), C as an extension of XA
 * measured from X (on XC = XC/XA), D as a retracement of XC (on XD = CD/XC).
 */
export function cypherRatios(pr: readonly number[]): { xb?: number; xc?: number; xd?: number } {
  const [x, a, b, c, d] = pr;
  const xa = Math.abs(a - x);
  const xc = c !== undefined ? Math.abs(c - x) : 0;
  return {
    xb: b !== undefined ? legRatio(x, a, b) : undefined,
    xc: c !== undefined ? (xa === 0 ? 0 : xc / xa) : undefined,
    xd: d !== undefined ? (xc === 0 ? 0 : Math.abs(c - d) / xc) : undefined,
  };
}

function paintXabcd(p: Ctx, cypher: boolean): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const [x, a, b, c, d] = pts;
  const fill = fillColor(p);
  if (fill) {
    if (b) fillPoly(ctx, [x, a, b], fill);
    if (d) fillPoly(ctx, [b, c, d], fill);
  }
  polyline(ctx, pts);
  if (cypher) {
    const r = cypherRatios(prices(p));
    if (b) ratioLine(p, x, b, fmtRatio(r.xb));
    if (c) ratioLine(p, x, c, fmtRatio(r.xc));
    if (d) ratioLine(p, b, d, null);
    if (d) ratioLine(p, x, d, fmtRatio(r.xd));
  } else {
    const r = xabcdRatios(prices(p));
    if (b) ratioLine(p, x, b, fmtRatio(r.xb));
    if (c) ratioLine(p, a, c, fmtRatio(r.ac));
    if (d) ratioLine(p, b, d, fmtRatio(r.bd));
    if (d) ratioLine(p, x, d, fmtRatio(r.xd));
  }
  pointLabels(p, ['X', 'A', 'B', 'C', 'D']);
}

/** ABCD: AC = BC/AB, BD = CD/BC. */
export function abcdRatios(pr: readonly number[]): { ac?: number; bd?: number } {
  const [a, b, c, d] = pr;
  return {
    ac: c !== undefined ? legRatio(a, b, c) : undefined,
    bd: d !== undefined ? legRatio(b, c, d) : undefined,
  };
}

function paintAbcd(p: Ctx): void {
  const { pts } = p;
  if (pts.length < 2) return;
  polyline(p.ctx, pts);
  const r = abcdRatios(prices(p));
  if (pts[2]) ratioLine(p, pts[0], pts[2], fmtRatio(r.ac));
  if (pts[3]) ratioLine(p, pts[1], pts[3], fmtRatio(r.bd));
  pointLabels(p, ['A', 'B', 'C', 'D']);
}

/** Intersection of line a1→a2 with line b1→b2, or null if parallel. */
export function intersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  return { x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) };
}

/**
 * Triangle pattern area: the A–C and B–D sides run on to their apex when it
 * lies ahead of the last anchor (a converging triangle); otherwise (expanding
 * or parallel) the quad A-B-D-C.
 */
export function trianglePolygon(pts: readonly Pt[]): Pt[] {
  const [a, b, c, d] = pts;
  if (!d) return pts.slice();
  const apex = intersect(a, c, b, d);
  if (!apex || apex.x <= Math.max(c.x, d.x)) return [a, b, d, c];
  return [a, b, apex];
}

function paintTrianglePattern(p: Ctx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const fill = fillColor(p);
  if (pts.length >= 4) {
    const poly = trianglePolygon(pts);
    if (fill) fillPoly(ctx, poly, fill);
    seg(ctx, pts[0], pts[2]);
    seg(ctx, pts[1], pts[3]);
    if (poly.length === 3) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      seg(ctx, pts[2], poly[2]);
      seg(ctx, pts[3], poly[2]);
      ctx.restore();
    }
  } else if (pts.length === 3 && fill) {
    fillPoly(ctx, pts, fill);
  }
  polyline(ctx, pts);
  pointLabels(p, ['A', 'B', 'C', 'D']);
}

/**
 * Three drives (7 anchors 0,1,A,2,B,3,C): element j is the ratio of leg
 * (j+1→j+2) to leg (j→j+1) — corrections as retracements of the drive before,
 * drives as extensions of the correction before.
 */
export function threeDrivesRatios(pr: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < pr.length; i++) out.push(legRatio(pr[i - 2], pr[i - 1], pr[i]));
  return out;
}

function paintThreeDrives(p: Ctx): void {
  const { pts } = p;
  if (pts.length < 2) return;
  polyline(p.ctx, pts);
  const r = threeDrivesRatios(prices(p));
  // Dotted connectors drive-top to drive-top and correction to correction,
  // each carrying the ratio of the leg ending at its far end.
  for (const [i, j] of [
    [1, 3],
    [2, 4],
    [3, 5],
    [4, 6],
  ] as const) {
    if (pts[j]) ratioLine(p, pts[i], pts[j], fmtRatio(r[j - 2]));
  }
}

// ── Head and shoulders ──────────────────────────────────────────────────────

const HS_LABELS = ['', 'Left Shoulder', '', 'Head', '', 'Right Shoulder', ''];

/** The three filled humps of a head-and-shoulders: shoulder, head, shoulder. */
export function hsHumps(pts: readonly Pt[]): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 0; i + 2 < pts.length; i += 2) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

/** Neckline through the troughs (anchors 2 and 4), spanning anchor 0 to anchor 6. */
export function neckline(pts: readonly Pt[]): [Pt, Pt] | null {
  const n1 = pts[2];
  const n2 = pts[4];
  if (!n1 || !n2) return null;
  const at = (x: number): Pt => {
    const dx = n2.x - n1.x;
    return { x, y: dx === 0 ? n1.y : n1.y + ((x - n1.x) * (n2.y - n1.y)) / dx };
  };
  const right = (pts[6] ?? n2).x;
  return [at(Math.min(pts[0].x, n1.x)), at(Math.max(right, n2.x))];
}

function paintHeadAndShoulders(p: Ctx): void {
  const { ctx, pts } = p;
  if (pts.length < 2) return;
  const fill = fillColor(p);
  if (fill) for (const hump of hsHumps(pts)) fillPoly(ctx, hump, fill);
  polyline(ctx, pts);
  const neck = neckline(pts);
  if (neck) seg(ctx, neck[0], neck[1]);
  pointLabels(p, HS_LABELS);
}

// ── Elliott waves ───────────────────────────────────────────────────────────

/** TradingView's Elliott degrees, largest first. */
export const ELLIOTT_DEGREES = [
  'Supermillennium',
  'Millennium',
  'Submillennium',
  'Grand Supercycle',
  'Supercycle',
  'Cycle',
  'Primary',
  'Intermediate',
  'Minor',
  'Minute',
  'Minuette',
  'Subminuette',
  'Micro',
  'Submicro',
  'Miniscule',
] as const;
export type ElliottDegree = (typeof ELLIOTT_DEGREES)[number];

/**
 * Label notation per degree, the standard Frost & Prechter scheme TV follows:
 * Grand Supercycle ((I)), Supercycle (I), Cycle I, Primary ①, Intermediate (1),
 * Minor 1, Minute ⓘ, Minuette (i), Subminuette i — and the same three-step
 * cycle (circle / parens / plain) repeated above and below.
 */
type Decor = 'plain' | 'paren' | 'dparen' | 'circle';
interface DegreeStyle {
  decor: Decor;
  numerals: 'arabic' | 'roman' | 'roman-lower';
  letters: 'upper' | 'lower';
  color: string;
}
const DEGREE_STYLE: Record<ElliottDegree, DegreeStyle> = {
  Supermillennium: { decor: 'circle', numerals: 'roman', letters: 'upper', color: '#D50000' },
  Millennium: { decor: 'dparen', numerals: 'roman', letters: 'upper', color: '#FF6D00' },
  Submillennium: { decor: 'paren', numerals: 'roman', letters: 'upper', color: '#FFD600' },
  'Grand Supercycle': { decor: 'dparen', numerals: 'roman', letters: 'upper', color: '#00C853' },
  Supercycle: { decor: 'paren', numerals: 'roman', letters: 'upper', color: '#2962FF' },
  Cycle: { decor: 'plain', numerals: 'roman', letters: 'upper', color: '#AA00FF' },
  Primary: { decor: 'circle', numerals: 'arabic', letters: 'upper', color: '#4CAF50' },
  Intermediate: { decor: 'paren', numerals: 'arabic', letters: 'upper', color: '#2196F3' },
  Minor: { decor: 'plain', numerals: 'arabic', letters: 'upper', color: '#FF9800' },
  Minute: { decor: 'circle', numerals: 'roman-lower', letters: 'lower', color: '#9C27B0' },
  Minuette: { decor: 'paren', numerals: 'roman-lower', letters: 'lower', color: '#F44336' },
  Subminuette: { decor: 'plain', numerals: 'roman-lower', letters: 'lower', color: '#00BCD4' },
  Micro: { decor: 'circle', numerals: 'arabic', letters: 'upper', color: '#795548' },
  Submicro: { decor: 'paren', numerals: 'arabic', letters: 'upper', color: '#607D8B' },
  Miniscule: { decor: 'plain', numerals: 'arabic', letters: 'upper', color: '#E91E63' },
};

const asDegree = (v: unknown, fallback: ElliottDegree): ElliottDegree =>
  typeof v === 'string' && v in DEGREE_STYLE ? (v as ElliottDegree) : fallback;

export function degreeColor(degree: ElliottDegree): string {
  return DEGREE_STYLE[degree].color;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

/** Raw wave symbols per tool (index 0 is the origin and is unlabelled). */
export const WAVE_SYMBOLS: Partial<Record<DrawingKind, readonly string[]>> = {
  'elliott-impulse': ['', '1', '2', '3', '4', '5'],
  'elliott-minor': ['', '1', '2', '3', '4', '5'],
  'elliott-intermediate': ['', '1', '2', '3', '4', '5'],
  'elliott-correction': ['', 'A', 'B', 'C'],
  'elliott-triangle': ['', 'A', 'B', 'C', 'D', 'E'],
  'elliott-double-combo': ['', 'W', 'X', 'Y'],
  'elliott-triple-combo': ['', 'W', 'X', 'Y', 'X', 'Z'],
};

/** A wave symbol as written at a degree, e.g. '1' at Intermediate → '(1)'. */
export function elliottLabel(symbol: string, degree: ElliottDegree): { text: string; circled: boolean } {
  if (!symbol) return { text: '', circled: false };
  const s = DEGREE_STYLE[degree];
  let core: string;
  if (/^\d$/.test(symbol)) {
    core = s.numerals === 'arabic' ? symbol : ROMAN[+symbol];
    if (s.numerals === 'roman-lower') core = core.toLowerCase();
  } else {
    // W/X/Y/Z combo letters follow the same case rule as A-E.
    core = s.letters === 'lower' ? symbol.toLowerCase() : symbol.toUpperCase();
  }
  if (s.decor === 'paren') return { text: `(${core})`, circled: false };
  if (s.decor === 'dparen') return { text: `((${core}))`, circled: false };
  return { text: core, circled: s.decor === 'circle' };
}

/** The label sequence a tool shows at a degree (circled labels marked "◯x"). */
export function elliottLabels(kind: DrawingKind, degree: ElliottDegree): string[] {
  return (WAVE_SYMBOLS[kind] ?? []).map((sym) => {
    const l = elliottLabel(sym, degree);
    return l.circled ? `◯${l.text}` : l.text;
  });
}

const ELLIOTT_DEFAULT_DEGREE: Partial<Record<DrawingKind, ElliottDegree>> = {
  'elliott-minor': 'Minor',
  'elliott-intermediate': 'Intermediate',
};

function paintElliott(p: Ctx): void {
  const { ctx, pts, drawing, options } = p;
  if (pts.length < 2) return;
  const degree = asDegree(options['degree'], ELLIOTT_DEFAULT_DEGREE[drawing.kind] ?? 'Intermediate');
  if (options['showWave'] !== false) polyline(ctx, pts);
  if (!drawing.style.showLabels) return;
  const symbols = WAVE_SYMBOLS[drawing.kind] ?? [];
  const color = (options['labelColor'] as string) || DEGREE_STYLE[degree].color;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < pts.length; i++) {
    const { text, circled } = elliottLabel(symbols[i] ?? '', degree);
    if (!text) continue;
    const up = isSwingHigh(pts, i);
    const at = { x: pts[i].x, y: pts[i].y + (up ? -15 : 15) };
    ctx.fillStyle = color;
    ctx.fillText(text, at.x, at.y + 0.5);
    if (circled) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(9, ctx.measureText(text).width / 2 + 5), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Cycles ──────────────────────────────────────────────────────────────────

/** x of every cyclic line: from the earlier anchor, stepping |P2−P1| until past the right edge. */
export function cycleXs(x1: number, x2: number, width: number, max = 500): number[] {
  const step = Math.abs(x2 - x1);
  const start = Math.min(x1, x2);
  if (step < 1) return [start];
  const out: number[] = [];
  for (let x = start; x <= width + step && out.length < max; x += step) out.push(x);
  return out;
}

function paintCyclicLines(p: Ctx): void {
  const { ctx, pts, width, height } = p;
  if (pts.length < 2) return;
  for (const x of cycleXs(pts[0].x, pts[1].x, width)) seg(ctx, { x, y: 0 }, { x, y: height });
  // TV shows the defining span as a dashed horizontal between the anchors.
  ctx.save();
  ctx.setLineDash([4, 4]);
  seg(ctx, pts[0], { x: pts[1].x, y: pts[0].y });
  ctx.restore();
}

/** Time cycles: semicircles of diameter |P2−P1| standing on P1's price, repeating right. */
export function timeCycleArcs(a: Pt, b: Pt, width: number): { cx: number; r: number }[] {
  const d = Math.abs(b.x - a.x);
  if (d < 1) return [];
  const r = d / 2;
  return cycleXs(a.x, b.x, width).map((x) => ({ cx: x + r, r }));
}

function paintTimeCycles(p: Ctx): void {
  const { ctx, pts, width } = p;
  if (pts.length < 2) return;
  const y = pts[0].y;
  const fill = fillColor(p);
  for (const { cx, r } of timeCycleArcs(pts[0], pts[1], width)) {
    ctx.beginPath();
    ctx.arc(cx, y, r, Math.PI, 0);
    if (fill) {
      ctx.save();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();
  }
}

/**
 * Sine line: P1 is a crest (or trough), P2 the next trough (crest) — half a
 * period apart, amplitude half their vertical distance. The wave runs across
 * the whole visible width.
 */
export function sineY(a: Pt, b: Pt, x: number): number {
  const half = b.x - a.x;
  const amp = (a.y - b.y) / 2;
  const mid = (a.y + b.y) / 2;
  if (Math.abs(half) < 1e-9) return a.y;
  return mid + amp * Math.cos((Math.PI * (x - a.x)) / half);
}

export function sinePoints(a: Pt, b: Pt, width: number, stepPx = 2): Pt[] {
  if (Math.abs(b.x - a.x) < 1) return [a, b];
  const out: Pt[] = [];
  for (let x = 0; x <= width; x += stepPx) out.push({ x, y: sineY(a, b, x) });
  return out;
}

function paintSine(p: Ctx): void {
  if (p.pts.length < 2) return;
  polyline(p.ctx, sinePoints(p.pts[0], p.pts[1], p.width));
}

// ── Behaviours ──────────────────────────────────────────────────────────────

function harmonic(
  points: number,
  color: string,
  painter: (p: Ctx) => void,
  fill: boolean,
  filledAreas: (pts: readonly Pt[]) => Pt[][] = (pts) => {
    const [x, a, b, c, d] = pts;
    return [b ? [x, a, b] : [], d ? [b, c, d] : []].filter((t) => t.length === 3);
  },
): ToolBehavior {
  return {
    points,
    defaultStyle: { color, width: 2, dash: 'solid', fill: fill ? withAlpha(color, 0.2) : null, showLabels: true },
    options: fill ? [FILL_OPTION] : [],
    paint: painter,
    hitTest: (p, at, tol) => {
      if (hitSegments(p.pts, at, tol)) return true;
      if (!fill || p.options['fillBackground'] === false) return false;
      return filledAreas(p.pts).some((poly) => pointInPolygon(at, poly));
    },
  };
}

function elliott(kind: DrawingKind, points: number): ToolBehavior {
  const degree = ELLIOTT_DEFAULT_DEGREE[kind] ?? 'Intermediate';
  return {
    points,
    defaultStyle: { color: '#3D85C6', width: 2, dash: 'solid', fill: null, showLabels: true },
    options: [
      { key: 'degree', label: 'Degree', type: 'select', default: degree, choices: ELLIOTT_DEGREES },
      { key: 'showWave', label: 'Show wave', type: 'bool', default: true },
      { key: 'labelColor', label: 'Label colour', type: 'color', default: DEGREE_STYLE[degree].color },
    ],
    paint: paintElliott,
    hitTest: (p, at, tol) => hitSegments(p.pts, at, tol),
  };
}

const CYCLE_COLOR = '#159980';

export const BEHAVIORS: ToolBehaviorMap = {
  'xabcd-pattern': harmonic(5, '#2962FF', (p) => paintXabcd(p, false), true),
  'cypher-pattern': harmonic(5, '#2962FF', (p) => paintXabcd(p, true), true),
  'five-point-pattern': harmonic(5, '#2962FF', (p) => paintXabcd(p, false), true),
  'abcd-pattern': harmonic(4, '#089981', paintAbcd, false),
  'three-drives': harmonic(7, '#673AB7', paintThreeDrives, false),
  'triangle-pattern': harmonic(4, '#9C27B0', paintTrianglePattern, true, (pts) =>
    pts.length >= 4 ? [trianglePolygon(pts)] : pts.length === 3 ? [pts.slice()] : [],
  ),
  'head-and-shoulders': harmonic(7, '#089981', paintHeadAndShoulders, true, hsHumps),
  'head-and-shoulders-inverse': harmonic(7, '#F23645', paintHeadAndShoulders, true, hsHumps),
  'elliott-impulse': elliott('elliott-impulse', 6),
  'elliott-correction': elliott('elliott-correction', 4),
  'elliott-triangle': elliott('elliott-triangle', 6),
  'elliott-double-combo': elliott('elliott-double-combo', 4),
  'elliott-triple-combo': elliott('elliott-triple-combo', 6),
  'elliott-minor': elliott('elliott-minor', 6),
  'elliott-intermediate': elliott('elliott-intermediate', 6),
  'cyclic-lines': {
    points: 2,
    defaultStyle: { color: CYCLE_COLOR, width: 1, dash: 'solid', fill: null, showLabels: false },
    paint: paintCyclicLines,
    hitTest: (p, at, tol) =>
      p.pts.length >= 2 && cycleXs(p.pts[0].x, p.pts[1].x, p.width).some((x) => Math.abs(at.x - x) <= tol),
  },
  'time-cycles': {
    points: 2,
    defaultStyle: { color: CYCLE_COLOR, width: 1, dash: 'solid', fill: 'rgba(106, 168, 79, 0.5)', showLabels: false },
    options: [FILL_OPTION],
    paint: paintTimeCycles,
    hitTest: (p, at, tol) => {
      if (p.pts.length < 2) return false;
      const y0 = p.pts[0].y;
      if (at.y > y0 + tol) return false;
      return timeCycleArcs(p.pts[0], p.pts[1], p.width).some(({ cx, r }) => {
        const d = Math.hypot(at.x - cx, at.y - y0);
        return Math.abs(d - r) <= tol || (p.options['fillBackground'] !== false && d <= r);
      });
    },
  },
  'sine-line': {
    points: 2,
    defaultStyle: { color: CYCLE_COLOR, width: 1, dash: 'solid', fill: null, showLabels: false },
    paint: paintSine,
    hitTest: (p, at, tol) => p.pts.length >= 2 && Math.abs(sineY(p.pts[0], p.pts[1], at.x) - at.y) <= tol + 1,
  },
};
