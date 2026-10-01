import type { Pt } from '../geometry';
import type { Drawing, DrawingPoint, DrawingStyle } from '../model';
import type { ToolBehavior, ToolBehaviorMap, ToolOption } from './types';
import {
  FIB_LEVELS_TV,
  GANN_BOX_LEVELS_TV,
  GANN_FAN_LEVELS_TV,
  GRAY,
  PITCHFAN_LEVELS_TV,
  RADIAL_LEVELS_TV,
  SPEED_LEVELS_TV,
  TIMEZONE_LEVELS_TV,
  TREND_TIME_LEVELS_TV,
  bool,
  commonBackground,
  emptyScene,
  extensionPrice,
  farPoint,
  fibLevelOptions,
  fmtLevel,
  gannAngleLabel,
  hitScene,
  lerp,
  levelText,
  levelsOf,
  levelsOption,
  num,
  paintScene,
  retracementPrice,
  str,
  withAlpha,
  type Ctx,
  type Level,
  type Opts,
  type Scene,
} from './fib-gann-core';

/**
 * TradingView "Gann and Fibonacci tools" rail family.
 *
 * Each tool is a scene builder (see fib-gann-core.ts); paint and hitTest share
 * it, so what is grabbable is exactly what is drawn. Level sets, colours and
 * option names follow TradingView's defaults.
 */

const FIB_STYLE: Partial<DrawingStyle> = { color: GRAY, width: 1, dash: 'dashed', fill: null, showLabels: true };

const TREND_DASH = [6, 4];
const lw = (o: Opts): number => num(o, 'levelWidth', 1);
const bgAlpha = (o: Opts): number => num(o, 'bgOpacity', 80);
const bg = (o: Opts): boolean => bool(o, 'background', true);

function trendPolyline(s: Scene, c: Ctx, pts: Pt[]): void {
  if (!bool(c.options, 'trendLine', true)) return;
  for (let i = 1; i < pts.length; i++) {
    s.lines.push({ a: pts[i - 1], b: pts[i], color: c.drawing.style.color, width: c.drawing.style.width, dash: TREND_DASH });
  }
}

/** Horizontal level lines between xl..xr with TV bands + labels. */
function horizontalLevels(
  s: Scene,
  c: Ctx,
  levels: Level[],
  yOf: (l: number) => number,
  priceOf: (l: number) => number | null,
  xa: number,
  xb: number,
): void {
  const o = c.options;
  const extL = bool(o, 'extendLeft');
  const extR = bool(o, 'extendRight');
  const xl = extL ? 0 : Math.min(xa, xb);
  const xr = extR ? c.width : Math.max(xa, xb);
  const h = str(o, 'labelsH', 'left');
  const v = str(o, 'labelsV', 'bottom');
  levels.forEach((l, i) => {
    const y = yOf(l.value);
    if (bg(o) && i > 0) {
      const py = yOf(levels[i - 1].value);
      s.fills.push({
        poly: [{ x: xl, y: py }, { x: xr, y: py }, { x: xr, y }, { x: xl, y }],
        color: withAlpha(l.color, bgAlpha(o)),
      });
    }
    s.lines.push({ a: { x: xl, y }, b: { x: xr, y }, color: l.color, width: lw(o) });
    if (!c.drawing.style.showLabels) return;
    let x: number;
    let align: CanvasTextAlign;
    if (h === 'left') [x, align] = extL ? [xl + 4, 'left'] : [xl - 4, 'right'];
    else if (h === 'right') [x, align] = extR ? [xr - 4, 'right'] : [xr + 4, 'left'];
    else [x, align] = [(xl + xr) / 2, 'center'];
    s.labels.push({
      text: levelText(l.value, priceOf(l.value), o, c.precision),
      at: { x, y: y + (v === 'top' ? -2 : v === 'bottom' ? 2 : 0) },
      color: l.color,
      align,
      baseline: v === 'top' ? 'bottom' : v === 'bottom' ? 'top' : 'middle',
    });
  });
}

const modelPrice = (d: Drawing, i: number, c: Ctx): number | null =>
  d.points[i]?.price ?? (c.pts[i] ? c.priceAt(c.pts[i].y) : null);

// ── Fib retracement ────────────────────────────────────────────────────────
function retracementScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const rev = bool(c.options, 'reverse');
  const p1 = modelPrice(c.drawing, 0, c);
  const p2 = modelPrice(c.drawing, 1, c);
  horizontalLevels(
    s,
    c,
    levelsOf(c.options, FIB_LEVELS_TV),
    (l) => retracementPrice(a.y, b.y, l, rev),
    (l) => (p1 === null || p2 === null ? null : retracementPrice(p1, p2, l, rev)),
    a.x,
    b.x,
  );
  trendPolyline(s, c, [a, b]);
  return s;
}

// ── Trend-based Fib extension ──────────────────────────────────────────────
function extensionScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b, d] = c.pts;
  if (!a || !b) return s;
  if (!d) {
    trendPolyline(s, c, [a, b]);
    return s;
  }
  const rev = bool(c.options, 'reverse');
  const [p1, p2, p3] = [0, 1, 2].map((i) => modelPrice(c.drawing, i, c));
  horizontalLevels(
    s,
    c,
    levelsOf(c.options, FIB_LEVELS_TV),
    (l) => extensionPrice(a.y, b.y, d.y, l, rev),
    (l) => (p1 === null || p2 === null || p3 === null ? null : extensionPrice(p1, p2, p3, l, rev)),
    d.x,
    d.x + Math.max(Math.abs(b.x - a.x), Math.abs(d.x - b.x), 40),
  );
  trendPolyline(s, c, [a, b, d]);
  return s;
}

// ── Fib channel ────────────────────────────────────────────────────────────
function channelScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b, d] = c.pts;
  if (!a || !b) return s;
  if (!d) {
    s.lines.push({ a, b, color: GRAY, width: lw(c.options) });
    return s;
  }
  const o = c.options;
  const slope = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x);
  const off = d.y - (a.y + slope * (d.x - a.x));
  const levels = levelsOf(o, FIB_LEVELS_TV);
  const seg = (l: number): [Pt, Pt] => {
    let p = { x: a.x, y: a.y + off * l };
    let q = { x: b.x, y: b.y + off * l };
    if (bool(o, 'extendLeft')) p = farPoint(q, p, c.width, c.height);
    if (bool(o, 'extendRight')) q = farPoint(p, q, c.width, c.height);
    return [p, q];
  };
  levels.forEach((l, i) => {
    const [p, q] = seg(l.value);
    if (bg(o) && i > 0) {
      const [pp, pq] = seg(levels[i - 1].value);
      s.fills.push({ poly: [pp, pq, q, p], color: withAlpha(l.color, bgAlpha(o)) });
    }
    s.lines.push({ a: p, b: q, color: l.color, width: lw(o) });
    if (c.drawing.style.showLabels) {
      const left = a.x <= b.x ? { x: a.x, y: a.y + off * l.value } : { x: b.x, y: b.y + off * l.value };
      s.labels.push({
        text: levelText(l.value, c.priceAt(left.y), o, c.precision),
        at: { x: left.x - 4, y: left.y },
        color: l.color,
        align: 'right',
        baseline: 'middle',
      });
    }
  });
  return s;
}

// ── Vertical-line families: time zone + trend-based fib time ───────────────
function verticals(s: Scene, c: Ctx, levels: Level[], xOf: (l: number) => number): void {
  const o = c.options;
  levels.forEach((l, i) => {
    const x = xOf(l.value);
    if (bg(o) && i > 0) {
      const px = xOf(levels[i - 1].value);
      s.fills.push({
        poly: [{ x: px, y: 0 }, { x, y: 0 }, { x, y: c.height }, { x: px, y: c.height }],
        color: withAlpha(l.color, bgAlpha(o)),
      });
    }
    s.lines.push({ a: { x, y: 0 }, b: { x, y: c.height }, color: l.color, width: lw(o) });
    if (c.drawing.style.showLabels) {
      s.labels.push({ text: fmtLevel(l.value), at: { x: x + 4, y: c.height - 6 }, color: l.color, align: 'left', baseline: 'bottom' });
    }
  });
}

function timezoneScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const unit = b.x - a.x;
  verticals(s, c, levelsOf(c.options, TIMEZONE_LEVELS_TV), (n) => a.x + unit * n);
  trendPolyline(s, c, [a, b]);
  return s;
}

function trendFibTimeScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b, d] = c.pts;
  if (!a || !b) return s;
  if (d) verticals(s, c, levelsOf(c.options, TREND_TIME_LEVELS_TV), (l) => d.x + (b.x - a.x) * l);
  trendPolyline(s, c, d ? [a, b, d] : [a, b]);
  return s;
}

// ── Speed resistance fan ───────────────────────────────────────────────────
function speedFanScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const o = c.options;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const price = levelsOf({ ...o, levels: o['priceLevels'] }, SPEED_LEVELS_TV);
  const time = levelsOf({ ...o, levels: o['timeLevels'] }, SPEED_LEVELS_TV);
  // TV grid: level 0 at the END of the move, 1 at the start (retracement sense).
  const yAt = (l: number) => a.y + dy * (1 - l);
  const xAt = (l: number) => a.x + dx * (1 - l);
  if (bool(o, 'grid', true)) {
    for (const l of price) s.lines.push({ a: { x: a.x, y: yAt(l.value) }, b: { x: b.x, y: yAt(l.value) }, color: GRAY, width: 1, dash: [1, 2] });
    for (const l of time) s.lines.push({ a: { x: xAt(l.value), y: a.y }, b: { x: xAt(l.value), y: b.y }, color: GRAY, width: 1, dash: [1, 2] });
  }
  const ray = (t: Pt): Pt => farPoint(a, t, c.width, c.height);
  // Price rays pass through (b.x, level price); time rays through (level time, b.price).
  const priceRays = price.filter((l) => l.value < 1).map((l) => ({ l, far: ray({ x: b.x, y: yAt(l.value) }) }));
  const timeRays = time.filter((l) => l.value > 0 && l.value < 1).map((l) => ({ l, far: ray({ x: xAt(l.value), y: b.y }) }));
  priceRays.forEach(({ l, far }, i) => {
    if (bg(o) && i > 0) s.fills.push({ poly: [a, priceRays[i - 1].far, far], color: withAlpha(l.color, bgAlpha(o)) });
    s.lines.push({ a, b: far, color: l.color, width: lw(o) });
  });
  timeRays.forEach(({ l, far }, i) => {
    if (bg(o) && i > 0) s.fills.push({ poly: [a, timeRays[i - 1].far, far], color: withAlpha(l.color, bgAlpha(o)) });
    s.lines.push({ a, b: far, color: l.color, width: lw(o) });
  });
  if (c.drawing.style.showLabels) {
    for (const l of price) s.labels.push({ text: fmtLevel(l.value), at: { x: a.x - 4, y: yAt(l.value) }, color: l.color, align: 'right', baseline: 'middle' });
    for (const l of time) s.labels.push({ text: fmtLevel(l.value), at: { x: xAt(l.value), y: b.y + (dy < 0 ? -4 : 4) }, color: l.color, align: 'center', baseline: dy < 0 ? 'bottom' : 'top' });
  }
  return s;
}

// ── Circles / arcs / wedge / spiral ────────────────────────────────────────
function radialRings(s: Scene, c: Ctx, levels: Level[], center: Pt, base: number, start: number, end: number): void {
  const o = c.options;
  levels.forEach((l, i) => {
    const r = base * l.value;
    if (bg(o)) {
      const r0 = i > 0 ? base * levels[i - 1].value : 0;
      s.rings.push({ c: center, r0: [r0, r0], r1: [r, r], start, end, color: withAlpha(l.color, bgAlpha(o)) });
    }
    s.arcs.push({ c: center, rx: r, ry: r, start, end, color: l.color, width: lw(o) });
  });
}

function circlesScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  // TV: the trend line is the DIAMETER of the 1-circle; centre at its midpoint.
  const center = lerp(a, b, 0.5);
  const base = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  const levels = levelsOf(c.options, RADIAL_LEVELS_TV);
  radialRings(s, c, levels, center, base, 0, Math.PI * 2);
  if (c.drawing.style.showLabels) {
    for (const l of levels) s.labels.push({ text: fmtLevel(l.value), at: { x: center.x, y: center.y - base * l.value - 2 }, color: l.color, align: 'center', baseline: 'bottom' });
  }
  trendPolyline(s, c, [a, b]);
  return s;
}

/** Half-circle arcs about `center`, radius |a→b|·level, on the upper or lower side. */
function halfArcsScene(c: Ctx, center: Pt, other: Pt, upward: boolean): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  const base = Math.hypot(b.x - a.x, b.y - a.y);
  const full = bool(c.options, 'fullCircles');
  const [start, end] = full ? [0, Math.PI * 2] : upward ? [Math.PI, Math.PI * 2] : [0, Math.PI];
  const levels = levelsOf(c.options, RADIAL_LEVELS_TV);
  radialRings(s, c, levels, center, base, start, end);
  if (c.drawing.style.showLabels && base > 0) {
    const ux = (other.x - center.x) / base;
    const uy = (other.y - center.y) / base;
    for (const l of levels) {
      s.labels.push({ text: fmtLevel(l.value), at: { x: center.x + ux * base * l.value + 3, y: center.y + uy * base * l.value }, color: l.color, align: 'left', baseline: 'middle' });
    }
  }
  trendPolyline(s, c, [a, b]);
  return s;
}

function resistanceArcsScene(c: Ctx): Scene {
  const [a, b] = c.pts;
  if (!a || !b) return emptyScene();
  // TV speed resistance arcs: centred on the first point, on the second point's side.
  return halfArcsScene(c, a, b, b.y < a.y);
}

function fibArcsScene(c: Ctx): Scene {
  const [a, b] = c.pts;
  if (!a || !b) return emptyScene();
  // Classic Fib arcs: centred on the second point, opening back toward the first.
  return halfArcsScene(c, b, a, a.y < b.y);
}

function wedgeScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b, d] = c.pts;
  if (!a || !b) return s;
  if (!d) {
    trendPolyline(s, c, [a, b]);
    return s;
  }
  const base = Math.hypot(b.x - a.x, b.y - a.y);
  let a1 = Math.atan2(b.y - a.y, b.x - a.x);
  let sweep = Math.atan2(d.y - a.y, d.x - a.x) - a1;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  let a2 = a1 + sweep;
  if (sweep < 0) [a1, a2] = [a2, a1];
  const levels = levelsOf(c.options, RADIAL_LEVELS_TV);
  radialRings(s, c, levels, a, base, a1, a2);
  const maxR = base * (levels.at(-1)?.value ?? 1);
  for (const ang of [a1, a2]) s.lines.push({ a, b: { x: a.x + Math.cos(ang) * maxR, y: a.y + Math.sin(ang) * maxR }, color: GRAY, width: lw(c.options) });
  if (c.drawing.style.showLabels) {
    for (const l of levels) s.labels.push({ text: fmtLevel(l.value), at: { x: a.x + Math.cos(a1) * base * l.value, y: a.y + Math.sin(a1) * base * l.value }, color: l.color, align: 'left', baseline: 'bottom' });
  }
  return s;
}

const PHI = (1 + Math.sqrt(5)) / 2;

function spiralScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const R = Math.hypot(b.x - a.x, b.y - a.y);
  if (R === 0) return s;
  const t0 = Math.atan2(b.y - a.y, b.x - a.x);
  const dir = bool(c.options, 'counterclockwise') ? -1 : 1;
  // Golden spiral: radius grows by φ every quarter turn and passes through b.
  const k = Math.log(PHI) / (Math.PI / 2);
  const limit = Math.hypot(c.width, c.height) * 2;
  const color = str(c.options, 'spiralColor', '#F23645');
  let prev: Pt | null = null;
  for (let th = -6 * Math.PI; th <= 8 * Math.PI; th += Math.PI / 48) {
    const r = R * Math.exp(k * th);
    if (r > limit) break;
    const ang = t0 + dir * th;
    const p = { x: a.x + Math.cos(ang) * r, y: a.y + Math.sin(ang) * r };
    if (prev && r > 0.5) s.lines.push({ a: prev, b: p, color, width: lw(c.options) });
    prev = p;
  }
  trendPolyline(s, c, [a, farPoint(a, b, c.width, c.height)]);
  return s;
}

// ── Pitchfan ───────────────────────────────────────────────────────────────
function pitchfanScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b, d] = c.pts;
  if (!a || !b) return s;
  if (!d) {
    trendPolyline(s, c, [a, b]);
    return s;
  }
  const o = c.options;
  const median = str(o, 'medianColor', '#F23645');
  const mid = lerp(b, d, 0.5);
  const half = { x: d.x - mid.x, y: d.y - mid.y };
  const rays: { v: number; color: string; far: Pt }[] = [{ v: 0, color: median, far: farPoint(a, mid, c.width, c.height) }];
  for (const l of levelsOf(o, PITCHFAN_LEVELS_TV)) {
    for (const sign of [-1, 1]) {
      const t = { x: mid.x + half.x * l.value * sign, y: mid.y + half.y * l.value * sign };
      rays.push({ v: l.value * sign, color: l.color, far: farPoint(a, t, c.width, c.height) });
    }
  }
  rays.sort((p, q) => p.v - q.v);
  rays.forEach((r, i) => {
    if (bg(o) && i > 0) {
      const outer = Math.abs(r.v) >= Math.abs(rays[i - 1].v) ? r : rays[i - 1];
      s.fills.push({ poly: [a, rays[i - 1].far, r.far], color: withAlpha(outer.color, bgAlpha(o)) });
    }
    s.lines.push({ a, b: r.far, color: r.color, width: lw(o) });
  });
  s.lines.push({ a: b, b: d, color: median, width: lw(o) });
  return s;
}

// ── Gann family ────────────────────────────────────────────────────────────
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function gannBoxGrid(s: Scene, c: Ctx, box: Box): void {
  const o = c.options;
  const price = levelsOf({ ...o, levels: o['priceLevels'] }, GANN_BOX_LEVELS_TV);
  const time = levelsOf({ ...o, levels: o['timeLevels'] }, GANN_BOX_LEVELS_TV);
  const { x0, y0, x1, y1 } = box;
  const yAt = (l: number) => y0 + (y1 - y0) * l;
  const xAt = (l: number) => x0 + (x1 - x0) * l;
  if (bg(o)) {
    price.forEach((l, i) => {
      if (i === 0) return;
      const py = yAt(price[i - 1].value);
      const y = yAt(l.value);
      s.fills.push({ poly: [{ x: x0, y: py }, { x: x1, y: py }, { x: x1, y }, { x: x0, y }], color: withAlpha(l.color, bgAlpha(o)) });
    });
    time.forEach((l, i) => {
      if (i === 0) return;
      const px = xAt(time[i - 1].value);
      const x = xAt(l.value);
      s.fills.push({ poly: [{ x: px, y: y0 }, { x, y: y0 }, { x, y: y1 }, { x: px, y: y1 }], color: withAlpha(l.color, bgAlpha(o) + (100 - bgAlpha(o)) / 2) });
    });
  }
  for (const l of price) s.lines.push({ a: { x: x0, y: yAt(l.value) }, b: { x: x1, y: yAt(l.value) }, color: l.color, width: lw(o) });
  for (const l of time) s.lines.push({ a: { x: xAt(l.value), y: y0 }, b: { x: xAt(l.value), y: y1 }, color: l.color, width: lw(o) });
  if (c.drawing.style.showLabels) {
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    for (const l of price) {
      if (bool(o, 'labelsLeft', true)) s.labels.push({ text: fmtLevel(l.value), at: { x: left - 4, y: yAt(l.value) }, color: l.color, align: 'right', baseline: 'middle' });
      if (bool(o, 'labelsRight', true)) s.labels.push({ text: fmtLevel(l.value), at: { x: right + 4, y: yAt(l.value) }, color: l.color, align: 'left', baseline: 'middle' });
    }
    for (const l of time) {
      if (bool(o, 'labelsTop', true)) s.labels.push({ text: fmtLevel(l.value), at: { x: xAt(l.value), y: top - 4 }, color: l.color, align: 'center', baseline: 'bottom' });
      if (bool(o, 'labelsBottom', true)) s.labels.push({ text: fmtLevel(l.value), at: { x: xAt(l.value), y: bottom + 4 }, color: l.color, align: 'center', baseline: 'top' });
    }
  }
  if (bool(o, 'angles', false)) {
    const p0 = { x: x0, y: y0 };
    for (const l of price) s.lines.push({ a: p0, b: { x: x1, y: yAt(l.value) }, color: l.color, width: 1, dash: [3, 3] });
    for (const l of time) s.lines.push({ a: p0, b: { x: xAt(l.value), y: y1 }, color: l.color, width: 1, dash: [3, 3] });
  }
}

const boxOf = (a: Pt, b: Pt): Box => ({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });

function gannBoxScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  gannBoxGrid(s, c, boxOf(a, b));
  return s;
}

/** Gann square fan + arcs, out of the box's first corner. */
function gannSquareExtras(s: Scene, c: Ctx, box: Box): void {
  const o = c.options;
  const origin = { x: box.x0, y: box.y0 };
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (bool(o, 'fans', true)) {
    for (const l of levelsOf({ ...o, levels: o['fanLevels'] }, GANN_FAN_LEVELS_TV)) {
      const end = l.value <= 1 ? { x: box.x1, y: box.y0 + h * l.value } : { x: box.x0 + w / l.value, y: box.y1 };
      s.lines.push({ a: origin, b: end, color: l.color, width: lw(o) });
    }
  }
  if (bool(o, 'arcs', true)) {
    // Quarter ellipse spanning the box quadrant opposite the origin corner.
    const sx = Math.sign(w) || 1;
    const sy = Math.sign(h) || 1;
    const angX = sx > 0 ? 0 : Math.PI;
    const angY = sy > 0 ? Math.PI / 2 : (3 * Math.PI) / 2;
    let [st, en] = sx * sy > 0 ? [angX, angY] : [angY, angX];
    if (en < st) en += Math.PI * 2;
    const arcLv = levelsOf({ ...o, levels: o['arcLevels'] }, SPEED_LEVELS_TV.filter((l) => l.value > 0));
    for (const l of arcLv) s.arcs.push({ c: origin, rx: Math.abs(w) * l.value, ry: Math.abs(h) * l.value, start: st, end: en, color: l.color, width: lw(o) });
  }
}

function gannSquareScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const box = boxOf(a, b);
  gannBoxGrid(s, c, box);
  gannSquareExtras(s, c, box);
  return s;
}

/** Fixed square: side follows the larger drag extent so the 1×1 is a true 45°. */
export function fixedSquareCorner(a: Pt, b: Pt): Pt {
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + (b.x >= a.x ? side : -side), y: a.y + (b.y >= a.y ? side : -side) };
}

function gannSquareFixedScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const box = boxOf(a, fixedSquareCorner(a, b));
  gannBoxGrid(s, c, box);
  gannSquareExtras(s, c, box);
  return s;
}

function fanFrom(s: Scene, c: Ctx, a: Pt, dx: number, dy: number): void {
  const o = c.options;
  const rays = levelsOf(o, GANN_FAN_LEVELS_TV).map((l) => ({
    l,
    far: farPoint(a, { x: a.x + dx, y: a.y + dy * l.value }, c.width, c.height),
  }));
  rays.forEach(({ l, far }, i) => {
    if (bg(o) && i > 0) s.fills.push({ poly: [a, rays[i - 1].far, far], color: withAlpha(l.color, bgAlpha(o)) });
    s.lines.push({ a, b: far, color: l.color, width: lw(o) });
    if (c.drawing.style.showLabels) {
      // On the box edge the ray leaves through (TV labels at the unit box).
      const at = { x: a.x + dx * Math.min(1, 1 / l.value), y: a.y + dy * Math.min(l.value, 1) };
      s.labels.push({ text: gannAngleLabel(l.value), at, color: l.color, align: 'left', baseline: 'bottom' });
    }
  });
}

function gannFanScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b || b.x === a.x) return s;
  fanFrom(s, c, a, b.x - a.x, b.y - a.y);
  return s;
}

function gannFanFixedScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b || b.x === a.x) return s;
  const corner = fixedSquareCorner(a, b);
  fanFrom(s, c, a, corner.x - a.x, corner.y - a.y);
  return s;
}

function gannGridScene(c: Ctx): Scene {
  const s = emptyScene();
  const [a, b] = c.pts;
  if (!a || !b) return s;
  const aw = Math.abs(b.x - a.x);
  const ah = Math.abs(b.y - a.y);
  if (aw < 2 || ah < 2) return s;
  const color = c.drawing.style.color;
  // ±1×1 diagonals through every cell node on p1's row, covering the viewport.
  const reach = c.height * 2;
  const run = reach * (aw / ah);
  const k0 = Math.floor((-run - a.x) / aw) - 1;
  const k1 = Math.ceil((c.width + run - a.x) / aw) + 1;
  for (let k = k0, n = 0; k <= k1 && n < 600; k++, n++) {
    const x = a.x + k * aw;
    for (const sgn of [-1, 1]) {
      s.lines.push({ a: { x: x - run, y: a.y - reach * sgn }, b: { x: x + run, y: a.y + reach * sgn }, color, width: lw(c.options) });
    }
  }
  s.lines.push({ a, b, color, width: c.drawing.style.width, dash: TREND_DASH });
  return s;
}

// ── Behavior factory ───────────────────────────────────────────────────────
type SceneFn = (c: Ctx) => Scene;

function make(points: number, build: SceneFn, options: readonly ToolOption[], extra: Partial<ToolBehavior> = {}): ToolBehavior {
  return {
    points,
    creation: 'click',
    defaultStyle: FIB_STYLE,
    options,
    paint(p) {
      paintScene(p.ctx, build(p), p.drawing.style.fontSize);
    },
    hitTest(p, at, tol) {
      return hitScene(build(p), at, tol);
    },
    ...extra,
  };
}

// Box handles: 0 = p1, 1 = p2, 2 = (p1.time, p2.price), 3 = (p2.time, p1.price).
export const boxHandles: Pick<ToolBehavior, 'handles' | 'moveHandle'> = {
  handles(p) {
    const [a, b] = p.pts;
    if (!a || !b) return p.pts;
    return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }];
  },
  moveHandle(d: Drawing, i: number, to: DrawingPoint): DrawingPoint[] {
    const [p1, p2] = d.points;
    if (i === 0) return [to, p2];
    if (i === 1) return [p1, to];
    if (i === 2) return [{ time: to.time, price: p1.price }, { time: p2.time, price: to.price }];
    return [{ time: p1.time, price: to.price }, { time: to.time, price: p2.price }];
  },
};

const withTrend = (def: readonly Level[], extra: ToolOption[] = []): ToolOption[] => [
  levelsOption(def),
  { key: 'trendLine', label: 'Trend line', type: 'bool', default: true },
  ...commonBackground(),
  ...extra,
];

const fullCircles: ToolOption = { key: 'fullCircles', label: 'Full circles', type: 'bool', default: false };

const gannBoxOptions = (extra: ToolOption[] = []): ToolOption[] => [
  { key: 'priceLevels', label: 'Price levels', type: 'levels', default: GANN_BOX_LEVELS_TV, tab: 'style' },
  { key: 'timeLevels', label: 'Time levels', type: 'levels', default: GANN_BOX_LEVELS_TV, tab: 'style' },
  { key: 'labelsLeft', label: 'Left labels', type: 'bool', default: true },
  { key: 'labelsRight', label: 'Right labels', type: 'bool', default: true },
  { key: 'labelsTop', label: 'Top labels', type: 'bool', default: true },
  { key: 'labelsBottom', label: 'Bottom labels', type: 'bool', default: true },
  { key: 'angles', label: 'Angles', type: 'bool', default: false },
  ...commonBackground(),
  ...extra,
];

const gannSquareOptions = (): ToolOption[] =>
  gannBoxOptions([
    { key: 'fans', label: 'Fans', type: 'bool', default: true },
    { key: 'fanLevels', label: 'Fan levels', type: 'levels', default: GANN_FAN_LEVELS_TV, tab: 'style' },
    { key: 'arcs', label: 'Arcs', type: 'bool', default: true },
    { key: 'arcLevels', label: 'Arc levels', type: 'levels', default: SPEED_LEVELS_TV.filter((l) => l.value > 0), tab: 'style' },
  ]);

export const BEHAVIORS: ToolBehaviorMap = {
  'fib-retracement': make(2, retracementScene, fibLevelOptions(FIB_LEVELS_TV)),
  'fib-extension': make(3, extensionScene, fibLevelOptions(FIB_LEVELS_TV)),
  'fib-channel': make(3, channelScene, fibLevelOptions(FIB_LEVELS_TV)),
  'fib-timezone': make(2, timezoneScene, withTrend(TIMEZONE_LEVELS_TV)),
  'trend-fib-time': make(3, trendFibTimeScene, withTrend(TREND_TIME_LEVELS_TV)),
  'fib-speed-fan': make(2, speedFanScene, [
    { key: 'priceLevels', label: 'Price levels', type: 'levels', default: SPEED_LEVELS_TV, tab: 'style' },
    { key: 'timeLevels', label: 'Time levels', type: 'levels', default: SPEED_LEVELS_TV, tab: 'style' },
    { key: 'grid', label: 'Grid', type: 'bool', default: true },
    ...commonBackground(),
  ]),
  'fib-circles': make(2, circlesScene, withTrend(RADIAL_LEVELS_TV)),
  'fib-spiral': make(2, spiralScene, [
    { key: 'spiralColor', label: 'Spiral colour', type: 'color', default: '#F23645' },
    { key: 'counterclockwise', label: 'Counterclockwise', type: 'bool', default: false },
    { key: 'trendLine', label: 'Ray', type: 'bool', default: true },
    { key: 'levelWidth', label: 'Line width', type: 'number', default: 1, min: 1, max: 4, step: 1 },
  ]),
  'fib-resistance-arcs': make(2, resistanceArcsScene, withTrend(RADIAL_LEVELS_TV, [fullCircles])),
  'fib-arcs': make(2, fibArcsScene, withTrend(RADIAL_LEVELS_TV, [fullCircles])),
  'fib-wedge': make(3, wedgeScene, withTrend(RADIAL_LEVELS_TV)),
  pitchfan: make(3, pitchfanScene, withTrend(PITCHFAN_LEVELS_TV, [{ key: 'medianColor', label: 'Median colour', type: 'color', default: '#F23645' }])),
  'gann-box': make(2, gannBoxScene, gannBoxOptions(), boxHandles),
  'gann-square': make(2, gannSquareScene, gannSquareOptions(), boxHandles),
  'gann-square-fixed': make(2, gannSquareFixedScene, gannSquareOptions(), {
    handles(p) {
      const [a, b] = p.pts;
      return a && b ? [a, fixedSquareCorner(a, b)] : p.pts;
    },
  }),
  'gann-fan': make(2, gannFanScene, withTrend(GANN_FAN_LEVELS_TV)),
  'gann-fan-fixed': make(2, gannFanFixedScene, withTrend(GANN_FAN_LEVELS_TV)),
  'gann-grid': make(2, gannGridScene, [{ key: 'levelWidth', label: 'Line width', type: 'number', default: 1, min: 1, max: 4, step: 1 }], {
    defaultStyle: { ...FIB_STYLE, color: '#2962FF' },
  }),
};
