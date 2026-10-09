import type { DrawingKind } from '../drawings/model';

/*
 * Drawing-tool icon set: original line art on the 28×28 grid rendered by
 * `ChartIconComponent` (stroke = currentColor, 1px, round caps, no fill).
 * Axis-aligned strokes sit on .5 coordinates so they stay crisp; anchor points
 * are hollow r=1.5 circles, and lines joining anchors stop at the circle edge.
 */

const R = 1.5;
const n = (v: number): string => String(Math.round(v * 100) / 100);

/** Hollow anchor point. */
const pt = (x: number, y: number): string => `<circle cx="${n(x)}" cy="${n(y)}" r="${R}"/>`;

/** Plain line. */
const ln = (x1: number, y1: number, x2: number, y2: number, extra = ''): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"${extra}/>`;

/** Line trimmed by the anchor radius at the flagged ends (so it meets the circle edge). */
const seg = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  a = true,
  b = true,
  extra = '',
): string => {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = ((x2 - x1) / len) * R;
  const uy = ((y2 - y1) / len) * R;
  return ln(a ? x1 + ux : x1, a ? y1 + uy : y1, b ? x2 - ux : x2, b ? y2 - uy : y2, extra);
};

/** Anchored polyline: segments between consecutive anchors plus every anchor. */
const chain = (...p: number[]): string => {
  let s = '';
  for (let i = 0; i + 3 < p.length; i += 2) s += seg(p[i], p[i + 1], p[i + 2], p[i + 3]);
  for (let i = 0; i + 1 < p.length; i += 2) s += pt(p[i], p[i + 1]);
  return s;
};

/** Plain zig-zag (no anchors). */
const poly = (...p: number[]): string => `<polyline points="${p.map(n).join(' ')}"/>`;

/** Tiny label glyph. */
const tx = (x: number, y: number, t: string, size = 5): string =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${size}" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">${t}</text>`;

/** Solid accent path. */
const solid = (d: string, extra = ''): string =>
  `<path d="${d}" fill="currentColor" stroke="none"${extra}/>`;

const FAINT = ' opacity=".4"';
const TINT = ' opacity=".25"';
const DASH = ' stroke-dasharray="2 2"';

/** Horizontal line (crisp when y is on .5). */
const hl = (y: number, x1 = 4, x2 = 24, extra = ''): string => ln(x1, y, x2, y, extra);
/** Vertical line (crisp when x is on .5). */
const vl = (x: number, y1 = 4, y2 = 24, extra = ''): string => ln(x, y1, x, y2, extra);

/** Open arrow head with its tip at (x,y), pointing along (dx,dy). */
const head = (x: number, y: number, dx: number, dy: number, s = 3): string => {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = x - ux * s;
  const by = y - uy * s;
  return poly(bx - uy * s * 0.7, by + ux * s * 0.7, x, y, bx + uy * s * 0.7, by - ux * s * 0.7);
};

/** Small solid "fixed" badge in the top-right corner. */
const LOCK = `<rect x="20.5" y="3.5" width="4" height="4" fill="currentColor" stroke="none"/>`;

/** Pitchfork: median from p0 through the p1/p2 midpoint, parallel tines from p1 and p2. */
const fork = (
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  to = 24,
): string => {
  const mx = (p1[0] + p2[0]) / 2;
  const my = (p1[1] + p2[1]) / 2;
  const dx = mx - p0[0];
  const dy = my - p0[1];
  const tine = (x: number, y: number): string => {
    const k = (to - x) / dx;
    return seg(x, y, x + dx * k, y + dy * k, true, false);
  };
  return (
    tine(p0[0], p0[1]) +
    seg(p1[0], p1[1], p2[0], p2[1], true, true, FAINT) +
    tine(p1[0], p1[1]) +
    tine(p2[0], p2[1]) +
    pt(p0[0], p0[1]) +
    pt(p1[0], p1[1]) +
    pt(p2[0], p2[1])
  );
};

/** Volume-profile bars growing right from the axis x=6.5. */
const profile = (widths: number[]): string =>
  widths.map((w, i) => hl(7.5 + i * 2.5, 6.5, 6.5 + w)).join('');

const GANN_SQUARE =
  `<rect x="5.5" y="5.5" width="17" height="17"/>` +
  ln(5.5, 22.5, 22.5, 5.5) +
  `<g${FAINT}>` +
  ln(5.5, 5.5, 22.5, 22.5) +
  ln(5.5, 22.5, 22.5, 14) +
  ln(5.5, 22.5, 14, 5.5) +
  '</g>';

const GANN_FAN =
  seg(5, 23, 23, 5) +
  `<g${FAINT}>` +
  ln(6.4, 22.4, 24, 14) +
  ln(6.5, 22.7, 24, 19) +
  ln(5.6, 21.6, 14, 4) +
  ln(5.4, 21.5, 9, 4) +
  '</g>' +
  pt(5, 23);

const ELLIOTT_5 = poly(4, 22, 8, 15, 11, 18, 16, 8, 19, 12, 23, 5);

export const TOOL_ICONS: Record<DrawingKind, string> = {
  // ── Lines ────────────────────────────────────────────────────────────
  'trend-line': chain(6, 22, 22, 6),
  ray: seg(6, 22, 24, 4, true, false) + pt(6, 22) + pt(14, 14),
  'extended-line': ln(4, 24, 24, 4) + pt(11, 17) + pt(17, 11),
  'horizontal-line': hl(14.5, 4, 12.5) + hl(14.5, 15.5, 24) + pt(14, 14.5),
  'horizontal-ray': hl(14.5, 9.5, 24) + pt(8, 14.5) + head(24, 14.5, 1, 0, 2.5),
  'vertical-line': vl(14.5, 4, 12.5) + vl(14.5, 15.5, 24) + pt(14.5, 14),
  'cross-line':
    hl(14.5, 4, 13) + hl(14.5, 16, 24) + vl(14.5, 4, 13) + vl(14.5, 16, 24) + pt(14.5, 14.5),
  'parallel-channel':
    seg(5, 16, 19, 6) +
    seg(9, 22, 23, 12) +
    pt(5, 16) +
    pt(19, 6) +
    pt(23, 12) +
    ln(7, 19, 21, 9, FAINT + DASH),
  'flat-channel': hl(7.5, 4, 24) + seg(5, 21, 23, 14) + pt(5, 21) + pt(23, 14) + pt(14, 7.5),
  'regression-channel':
    ln(4, 15, 24, 7, FAINT + DASH) +
    ln(4, 11, 24, 3) +
    ln(4, 19, 24, 11) +
    solid('M7 13h1.5v1.5H7zM11 15.5h1.5V17H11zM15 10h1.5v1.5H15zM19 11h1.5v1.5H19z'),
  'disjoint-angle':
    seg(5, 9, 22, 5) +
    seg(5, 23, 22, 15) +
    pt(5, 9) +
    pt(22, 5) +
    pt(5, 23) +
    ln(5, 11, 5, 21, FAINT + DASH),
  'info-line':
    chain(5, 21, 19, 9) +
    `<rect x="13.5" y="16.5" width="10" height="7" rx="1"/>` +
    hl(18.5, 15.5, 21.5, FAINT) +
    hl(21.5, 15.5, 19.5, FAINT),
  'trend-angle':
    chain(5, 21, 21, 8) + hl(21.5, 6.5, 24, DASH) + `<path d="M13 21.5a8 8 0 0 0-1.8-5"/>`,

  // ── Shapes ───────────────────────────────────────────────────────────
  rectangle: `<rect x="6.5" y="8.5" width="15" height="11"/>` + pt(6.5, 8.5) + pt(21.5, 19.5),
  'rotated-rectangle': `<path d="M5 15 13 6l10 7-8 9z"/>` + pt(5, 15) + pt(13, 6) + pt(23, 13),
  ellipse: `<ellipse cx="14" cy="14" rx="9.5" ry="6.5"/>` + pt(4.5, 14) + pt(23.5, 14),
  circle: `<circle cx="14" cy="14" r="9"/>` + pt(14, 14) + pt(23, 14),
  triangle: chain(5, 22, 14, 6, 23, 19, 5, 22),
  path: chain(5, 21, 12, 13, 17, 17) + seg(17, 17, 22.5, 7, true, false) + head(23, 6, 0.5, -1, 3),
  polyline: chain(5, 18, 10, 8, 16, 20, 22, 9),
  brush:
    `<path d="M5 20c3-6 5-10 8-9s0 7 3 8 4-6 7-11"/>` +
    solid('M4 21.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z'),
  highlighter:
    `<path d="M5 20c4-3 9-5 15-6" stroke-width="4"${TINT}/>` +
    `<path d="m16 5 6 6-5.5 5.5-6-6z"/>` +
    `<path d="M10.5 10.5 8 16l4 4 4.5-3.5"/>`,
  arc: `<path d="M6.5 21a7.5 7.5 0 0 1 15 0"/>` + pt(5, 21) + pt(23, 21),
  'arc-curve': `<path d="M6.3 20.5Q14 4 21.7 20.5"/>` + pt(5.5, 22) + pt(22.5, 22) + pt(14, 12.3),
  curve:
    `<path d="M6.4 19.2C9 12 16 9 21.5 9"/>` +
    pt(5.5, 20.5) +
    pt(23, 9) +
    pt(11, 6) +
    seg(5.5, 20.5, 11, 6, true, true, FAINT + DASH),
  'double-curve':
    `<path d="M5.6 18.2C8 6 13 6 14 13s6 9 8.4-3"/>` + pt(5, 19.7) + pt(23, 8.5) + pt(14, 14.5),

  // ── Fibonacci ────────────────────────────────────────────────────────
  'fib-retracement':
    hl(6.5) +
    `<g${FAINT}>` +
    hl(10.5) +
    hl(14.5) +
    hl(18.5) +
    '</g>' +
    hl(22.5) +
    seg(6, 22.5, 22, 6.5, true, true, DASH) +
    pt(6, 22.5) +
    pt(22, 6.5),
  'fib-extension':
    chain(5, 21, 10, 11, 15, 17) +
    hl(5.5, 13, 24) +
    `<g${FAINT}>` +
    hl(9.5, 13, 24) +
    hl(13.5, 17, 24) +
    hl(17.5, 17, 24) +
    '</g>',
  'fib-channel':
    seg(5, 19, 17, 7) +
    ln(8, 22, 22, 8) +
    `<g${FAINT}>` +
    ln(11, 23, 24, 10) +
    ln(15, 24, 24, 15) +
    '</g>' +
    pt(5, 19) +
    pt(17, 7) +
    pt(9.5, 20.5),
  'fib-timezone':
    vl(5.5, 7, 24) +
    `<g${FAINT}>` +
    vl(8.5, 7, 24) +
    vl(11.5, 7, 24) +
    vl(15.5, 7, 24) +
    '</g>' +
    vl(22.5, 4, 24) +
    pt(5.5, 5) +
    pt(8.5, 5) +
    seg(5.5, 5, 8.5, 5, true, true),
  'trend-fib-time':
    chain(5, 20, 10, 9, 14, 15) +
    `<g${FAINT}>` +
    vl(17.5, 4, 24) +
    vl(20.5, 4, 24) +
    '</g>' +
    vl(23.5, 4, 24),
  'fib-circles':
    `<circle cx="14" cy="14" r="4"/><circle cx="14" cy="14" r="7"${FAINT}/><circle cx="14" cy="14" r="10"${FAINT}/>` +
    pt(14, 14) +
    pt(18, 14),
  'fib-arcs':
    `<path d="M8 21a6 6 0 0 1 12 0M5 21a9 9 0 0 1 18 0"${FAINT}/><path d="M11 21a3 3 0 0 1 6 0"/>` +
    chain(14, 21, 22, 7),
  'fib-resistance-arcs':
    `<path d="M5 22a17 17 0 0 1 17-17M5 22a13 13 0 0 1 13-13"${FAINT}/><path d="M5 22a9 9 0 0 1 9-9"/>` +
    pt(5, 22) +
    pt(23, 5),
  'fib-wedge':
    seg(6, 21, 22, 6) +
    seg(6, 21, 23, 19) +
    `<path d="M17.5 10.4a13 13 0 0 1 2 8.1M13 14.4a9 9 0 0 1 1.4 5.4"${FAINT}/>` +
    pt(6, 21) +
    pt(22, 6) +
    pt(23, 19),
  'fib-speed-fan':
    seg(5, 23, 23, 5, true, true) +
    `<g${FAINT}>` +
    ln(6.4, 22.4, 24, 11) +
    ln(6.4, 22.6, 24, 17) +
    ln(5.6, 21.6, 17, 4) +
    ln(5.4, 21.5, 11, 4) +
    '</g>' +
    hl(5.5, 4, 21.5, DASH + FAINT) +
    vl(23.5, 6.5, 24, DASH + FAINT) +
    pt(5, 23) +
    pt(23, 5),
  'fib-spiral':
    `<path d="M14 14a2 2 0 0 1 2 2 3.5 3.5 0 0 1-5 2 5.5 5.5 0 0 1 1-9 8 8 0 0 1 9 8 10 10 0 0 1-6 6.5"/>` +
    pt(14, 14),

  // ── Text & annotation ───────────────────────────────────────────────
  text:
    hl(7.5, 8, 20) +
    vl(14, 7.5, 21.5) +
    ln(8, 7.5, 8, 9.5) +
    ln(20, 7.5, 20, 9.5) +
    hl(21.5, 11.5, 16.5),
  callout:
    `<rect x="11.5" y="5.5" width="12" height="8" rx="1.5"/>` +
    `<g${FAINT}>` +
    hl(8.5, 14, 21) +
    hl(10.5, 14, 19) +
    '</g>' +
    seg(5.5, 22.5, 13, 13.5, true, false) +
    pt(5.5, 22.5),
  arrow:
    seg(5.5, 22.5, 19, 9, true, false) +
    `<path d="m23 5-7.5 2.5 5 5z" fill="currentColor"/>` +
    pt(5.5, 22.5),
  flag: vl(8.5, 5, 24) + `<path d="M8.5 6.5c3-2 6 2 9 0s4 0 5 0v8c-1 0-2-2-5 0s-6-2-9 0"/>`,
  'price-label': `<path d="M5.5 10.5h12l5 4-5 4h-12z"/>` + hl(14.5, 8, 15, FAINT),
  signpost:
    vl(14.5, 4, 24) +
    `<path d="M6.5 6.5h13l3 3-3 3h-13z"/>` +
    `<path d="M21.5 14.5h-13l-3 3 3 3h13z"${FAINT}/>`,
  comment:
    `<path d="M7 5.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-4.5 4v-4H7a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/>` +
    hl(10.5, 9, 19) +
    hl(13.5, 9, 16),
  balloon:
    `<ellipse cx="14" cy="11" rx="7" ry="7.5"/>` +
    solid('M14 18.5l-1.5 1.5h3z') +
    `<path d="M14 20c-1 1.5 1 2.5 0 4"/>`,
  sticker: `<path d="M14 4.5l2.9 5.8 6.4.9-4.6 4.5 1.1 6.4-5.8-3-5.8 3 1.1-6.4-4.6-4.5 6.4-.9z"/>`,
  idea:
    `<path d="M11 18.5c0-3-3.5-4-3.5-8a6.5 6.5 0 0 1 13 0c0 4-3.5 5-3.5 8z"/>` +
    hl(20.5, 11, 17) +
    hl(22.5, 12, 16) +
    `<path d="M12.5 13l1.5 2 1.5-2"${FAINT}/>`,
  table:
    solid('M6 7h16v4.5H6z', TINT) +
    `<rect x="5.5" y="6.5" width="17" height="15" rx="1"/>` +
    hl(11.5, 5.5, 22.5) +
    hl(16.5, 5.5, 22.5) +
    vl(11.5, 6.5, 21.5) +
    vl(16.5, 6.5, 21.5),
  'anchored-note':
    `<rect x="9.5" y="4.5" width="14" height="11" rx="1"/>` +
    `<g${FAINT}>` +
    hl(8.5, 12, 21) +
    hl(11.5, 12, 18) +
    '</g>' +
    seg(5.5, 22.5, 12, 15.5, true, false) +
    pt(5.5, 22.5),
  'arrow-mark-up': solid('M14 5l7 8h-4v9h-6v-9H7z'),
  'arrow-mark-down': solid('M14 23l7-8h-4V6h-6v9H7z'),
  'arrow-mark-left': solid('M5 14l8-7v4h9v6h-9v4z'),
  'arrow-mark-right': solid('M23 14l-8-7v4H6v6h9v4z'),
  // ── DR-I12 ──────────────────────────────────────────────────────────────
  'anchored-text':
    `<rect x="4.5" y="4.5" width="19" height="19" rx="1"${DASH}${FAINT}/>` +
    hl(8.5, 9, 19) +
    vl(14, 8.5, 19.5) +
    pt(4.5, 4.5),
  note:
    `<circle cx="14" cy="9" r="4.5"/>` +
    vl(14, 13.5, 23.5) +
    `<circle cx="14" cy="9" r="1" fill="currentColor"/>`,
  'price-note':
    `<rect x="11.5" y="4.5" width="12" height="8" rx="1"/>` +
    seg(6.5, 18.5, 14, 12.5, true, false) +
    hl(18.5, 6.5, 24, DASH) +
    pt(6.5, 18.5),
  image:
    `<rect x="4.5" y="6.5" width="19" height="15" rx="1"/>` +
    `<path d="M6 20l5.5-6 4 4 2.5-2.5 4 4.5"/>` +
    `<circle cx="18" cy="10.5" r="1.5"/>`,
  'arrow-marker': solid('M4 16.5v-5h12V7l8 7-8 7v-4.5z'),
  icon: solid('M14 4.5l2.6 6.2 6.7.5-5.1 4.4 1.6 6.5L14 18.6l-5.8 3.5 1.6-6.5-5.1-4.4 6.7-.5z'),

  // ── Measure / projection ────────────────────────────────────────────
  measure:
    `<rect x="5.5" y="7.5" width="17" height="13"${DASH}${FAINT}/>` +
    vl(14, 8.5, 19.5) +
    head(14, 8.5, 0, -1, 2.5) +
    hl(14, 6.5, 21.5) +
    head(21.5, 14, 1, 0, 2.5),
  'price-range':
    hl(5.5, 6, 22) +
    hl(22.5, 6, 22) +
    vl(14, 7, 21) +
    head(14, 7, 0, -1, 2.5) +
    head(14, 21, 0, 1, 2.5),
  'date-range':
    vl(5.5, 6, 22) +
    vl(22.5, 6, 22) +
    hl(14, 7, 21) +
    head(7, 14, -1, 0, 2.5) +
    head(21, 14, 1, 0, 2.5),
  ruler:
    `<path d="M4.5 18.5l14-14 5 5-14 14z"/>` +
    ln(8, 15, 10, 17) +
    ln(10.5, 12.5, 11.8, 13.8) +
    ln(13, 10, 15, 12) +
    ln(15.5, 7.5, 16.8, 8.8),
  'long-position':
    solid('M6 6h16v8.5H6z', TINT) +
    `<rect x="5.5" y="5.5" width="17" height="17"/>` +
    hl(14.5, 5.5, 22.5) +
    vl(11.5, 9, 19) +
    head(11.5, 9, 0, -1, 2.5),
  'short-position':
    solid('M6 14.5h16V22H6z', TINT) +
    `<rect x="5.5" y="5.5" width="17" height="17"/>` +
    hl(14.5, 5.5, 22.5) +
    vl(11.5, 9, 19) +
    head(11.5, 19, 0, 1, 2.5),
  forecast:
    chain(5, 18, 13, 12) +
    seg(13, 12, 23, 6, true, false, DASH) +
    seg(13, 12, 23, 19, true, false, DASH + FAINT) +
    `<circle cx="23" cy="6" r="1" fill="currentColor"/>`,
  projection:
    chain(5, 21, 12, 9, 17, 15) +
    `<path d="M12 10.5a8 8 0 0 1 5 3"${FAINT}/>` +
    seg(17, 15, 24, 4, true, false, DASH),
  'bars-pattern':
    vl(5.5, 14, 22) +
    vl(8.5, 11, 18) +
    vl(11.5, 8, 15) +
    hl(16.5, 4.5, 5.5) +
    hl(13.5, 7.5, 8.5) +
    hl(10.5, 10.5, 11.5) +
    `<g${FAINT}>` +
    vl(16.5, 13, 21) +
    vl(19.5, 10, 17) +
    vl(22.5, 7, 14) +
    '</g>',
  'ghost-feed':
    `<path d="M8.5 23.5V11a5.5 5.5 0 0 1 11 0v12.5l-2-1.5-2 1.5-1.5-1.5-1.5 1.5-2-1.5z"/>` +
    solid('M11.5 12h1.5v2h-1.5zM15 12h1.5v2H15z'),
  'cyclic-lines':
    vl(5.5, 7, 24) +
    vl(11.5, 7, 24) +
    vl(17.5, 7, 24, FAINT) +
    vl(23.5, 7, 24, FAINT) +
    pt(5.5, 5) +
    pt(11.5, 5) +
    seg(5.5, 5, 11.5, 5),
  'sine-line': `<path d="M4 14.5c2.5-8 5.5-8 8 0s5.5 8 8 0 3-4 4-4"/>` + pt(8, 8.6) + pt(16, 20.4),
  'time-cycles':
    `<path d="M5 21.5a4.5 4.5 0 0 1 9 0 4.5 4.5 0 0 1 9 0"/>` +
    hl(21.5, 4, 24, FAINT) +
    pt(5, 21.5) +
    pt(14, 21.5),
  'anchored-vwap':
    `<path d="M6.3 19.3c3-1 4-6 7-6s4 3 6-1 2-6 3.5-6"/>` +
    `<path d="M6 21.5c3-.5 5-3 8-3s4 1 8.5-3"${FAINT}${DASH}/>` +
    pt(5, 20.5) +
    vl(5, 22, 24),
  'anchored-volume-profile': vl(6.5, 4, 22) + profile([5, 9, 14, 17, 11, 7]) + pt(6.5, 23.5),
  'fixed-range-volume-profile':
    vl(4.5, 4, 24, DASH + FAINT) +
    vl(23.5, 4, 24, DASH + FAINT) +
    vl(6.5, 6, 22) +
    profile([4, 8, 14, 16, 10, 6]),

  // ── Pitchforks ──────────────────────────────────────────────────────
  pitchfork: fork([5, 20], [12, 8], [14, 22]),
  'schiff-pitchfork':
    fork([5, 14], [12, 8], [14, 22]) +
    `<circle cx="5" cy="21" r="1" fill="currentColor" stroke="none"${FAINT}/>` +
    ln(5, 20, 5, 16, FAINT + DASH),
  'modified-schiff-pitchfork':
    fork([8.5, 14.5], [12, 8], [14, 22]) +
    `<circle cx="5" cy="21" r="1" fill="currentColor" stroke="none"${FAINT}/>` +
    ln(5.5, 20, 7.6, 16, FAINT + DASH),
  'inside-pitchfork':
    seg(5, 21, 12, 8) +
    seg(5, 21, 19, 17) +
    seg(12, 8, 19, 17, true, true, FAINT) +
    seg(5, 21, 24, 12.5, true, false) +
    `<g${FAINT}>` +
    ln(13.4, 8.6, 24, 3.8) +
    ln(20.4, 16.4, 24, 14.8) +
    '</g>' +
    pt(5, 21) +
    pt(12, 8) +
    pt(19, 17),
  pitchfan:
    seg(5, 21, 13, 7) +
    seg(5, 21, 17, 20) +
    seg(13, 7, 17, 20, true, true, FAINT) +
    seg(5, 21, 24, 9, true, false) +
    `<g${FAINT}>` +
    ln(6.3, 20.3, 24, 4) +
    ln(6.5, 20.8, 24, 17) +
    '</g>' +
    pt(5, 21) +
    pt(13, 7) +
    pt(17, 20),

  // ── Gann ────────────────────────────────────────────────────────────
  'gann-box':
    `<rect x="5.5" y="5.5" width="17" height="17"/>` +
    `<g${FAINT}>` +
    vl(9.5, 5.5, 22.5) +
    vl(14, 5.5, 22.5) +
    vl(18.5, 5.5, 22.5) +
    hl(9.5, 5.5, 22.5) +
    hl(14, 5.5, 22.5) +
    hl(18.5, 5.5, 22.5) +
    '</g>' +
    pt(5.5, 22.5) +
    pt(22.5, 5.5),
  'gann-square': GANN_SQUARE + pt(5.5, 22.5) + pt(22.5, 5.5),
  'gann-square-fixed': GANN_SQUARE + pt(5.5, 22.5) + LOCK,
  'gann-grid':
    `<g${FAINT}>` +
    ln(4, 14, 14, 4) +
    ln(14, 24, 24, 14) +
    ln(4, 14, 14, 24) +
    ln(14, 4, 24, 14) +
    '</g>' +
    seg(5, 23, 23, 5) +
    pt(5, 23) +
    pt(23, 5),
  'gann-fan': GANN_FAN + pt(23, 5),
  'gann-fan-fixed': GANN_FAN + LOCK,

  // ── Elliott ─────────────────────────────────────────────────────────
  'elliott-impulse':
    ELLIOTT_5 +
    tx(8, 12.5, '1') +
    tx(11, 23.5, '2') +
    tx(15, 6.5, '3') +
    tx(20, 17, '4') +
    tx(21, 6, '5'),
  'elliott-correction':
    poly(5, 7, 11, 18, 16, 11, 23, 22) +
    tx(11, 23.5, 'A') +
    tx(16, 9.3, 'B') +
    tx(20, 24.5, 'C') +
    pt(5, 7),
  'elliott-triangle':
    poly(4, 6, 8, 20, 12, 9, 16, 18, 19, 11, 23, 16) +
    ln(4, 6, 23, 13, FAINT + DASH) +
    ln(8, 20, 23, 15, FAINT + DASH) +
    tx(8, 24.5, 'a', 4) +
    tx(12, 7, 'b', 4) +
    tx(16, 22.5, 'c', 4) +
    tx(19, 9, 'd', 4) +
    tx(24.5, 19.5, 'e', 4),
  'elliott-double-combo':
    poly(4, 7, 9, 18, 14, 11, 19, 21, 24, 14) + tx(9, 23, 'W') + tx(14, 9, 'X') + tx(19, 26, 'Y'),
  'elliott-triple-combo':
    poly(4, 6, 7, 15, 10, 10, 14, 19, 17, 14, 20, 23, 24, 18) +
    tx(7, 19.5, 'W', 4) +
    tx(10, 8.5, 'X', 4) +
    tx(13, 23.5, 'Y', 4) +
    tx(17, 12.5, 'X', 4) +
    tx(22, 26.5, 'Z', 4),
  'elliott-minor': chain(4, 23, 8, 15, 11, 18, 16, 8, 19, 12, 23, 5),
  'elliott-intermediate':
    ELLIOTT_5 +
    tx(7.5, 12.5, '(1)', 3.5) +
    tx(11, 22.5, '(2)', 3.5) +
    tx(15.5, 6, '(3)', 3.5) +
    tx(20, 16, '(4)', 3.5) +
    tx(23, 3, '(5)', 3.5),

  // ── Harmonic / chart patterns ───────────────────────────────────────
  'abcd-pattern':
    poly(5, 20, 10, 8, 16, 15, 22, 5) +
    ln(5, 20, 16, 15, FAINT + DASH) +
    tx(5, 25, 'A') +
    tx(10, 6.5, 'B') +
    tx(16, 20, 'C') +
    tx(23, 10, 'D'),
  'xabcd-pattern':
    poly(4, 20, 8, 7, 13, 16, 18, 10, 23, 22) +
    `<path d="M4 20 13 16 23 22M8 7 18 10"${FAINT}/>` +
    tx(4, 25, 'X', 4) +
    tx(8, 5.5, 'A', 4) +
    tx(13, 20.5, 'B', 4) +
    tx(18, 8.5, 'C', 4) +
    tx(24, 26, 'D', 4),
  'cypher-pattern':
    poly(4, 21, 9, 9, 13, 15, 19, 5, 23, 18) +
    `<path d="M4 21 13 15 23 18M9 9 19 5"${FAINT}/>` +
    `<circle cx="14" cy="22" r="3"/>` +
    tx(14, 23.8, 'C', 4.5),
  'five-point-pattern': chain(4, 20, 8.5, 8, 13, 16, 18, 9, 23.5, 21),
  'three-drives':
    poly(4, 22, 7, 16, 9, 19, 13, 11, 15, 14, 20, 5, 23, 9) +
    ln(7, 16, 20, 5, FAINT + DASH) +
    tx(7, 12.5, '1', 4) +
    tx(13, 8, '2', 4) +
    tx(21, 3.5, '3', 4),
  'head-and-shoulders':
    poly(4, 20, 8, 12, 11, 18, 14.5, 5, 18, 18, 21, 12, 24, 20) + hl(18.5, 4, 24, FAINT + DASH),
  'head-and-shoulders-inverse':
    poly(4, 8, 8, 16, 11, 10, 14.5, 23, 18, 10, 21, 16, 24, 8) + hl(9.5, 4, 24, FAINT + DASH),
  'triangle-pattern':
    poly(4, 7, 8, 21, 12, 10, 16, 18, 20, 12, 23, 15) +
    ln(4, 7, 24, 13.5, FAINT) +
    ln(8, 21, 24, 15, FAINT),
};
