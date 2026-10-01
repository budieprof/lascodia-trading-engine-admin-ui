import type { PaintCtx } from '../advanced-painters';
import type { Pt } from '../geometry';
import type { Drawing } from '../model';
import type { ToolBehavior, ToolBehaviorMap, ToolOption } from './types';
import {
  DEFAULT_TEXT,
  TV_BLUE,
  alignOf,
  bool,
  bubblePath,
  distToSegment,
  fillLines,
  fontOf,
  inRect,
  layoutText,
  measurerFor,
  num,
  opt,
  roundRectPath,
  str,
  wrapWidthOf,
  type Rect,
  type TextLayout,
} from './text-layout';
import { TABLE_BEHAVIOR } from './text-table';

/**
 * TradingView rail family "Text and annotation tools".
 *
 * Every tool is laid out by one shape function that both `paint` and `hitTest`
 * call, so the clickable area is always exactly the painted box. Anchors stay in
 * chart space; boxes are sized in pixels relative to the projected anchors, as
 * on TradingView (text does not scale with zoom).
 */

export type TextPaintCtx = PaintCtx & { options: Record<string, unknown> };
type P = TextPaintCtx;

const WHITE = '#FFFFFF';
const DARK = '#131722';
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** Text with TV's placeholder when empty. */
export function textOf(d: Drawing, fallback = DEFAULT_TEXT): string {
  return d.style.text && d.style.text.length > 0 ? d.style.text : fallback;
}

/** Price as TradingView prints it on a Price Label: fixed to the symbol's precision. */
export function formatPrice(price: number, precision: number): string {
  const p = Math.max(0, Math.min(10, Math.round(precision)));
  return price.toFixed(p);
}

function measureLayout(p: P, text: string, pad: { x: number; y: number }, wrap: number | null, minWidth = 0): TextLayout {
  const s = p.drawing.style;
  const font = fontOf(s);
  const m = measurerFor(p.ctx, font, s.fontSize);
  return layoutText(m, text, s.fontSize, font, { padX: pad.x, padY: pad.y, wrapWidth: wrap, minWidth });
}

export interface Shape {
  layout: TextLayout;
  box: Rect;
  /** Speech-bubble tail tip, if the box has one. */
  tip?: Pt;
  /** Extra segments that count as part of the drawing (poles). */
  segments?: [Pt, Pt][];
  /** Extra circles (pins, emoji heads). */
  circles?: { c: Pt; r: number }[];
}

/** Text: box top-left at the anchor; padded only when it has a background/border. */
function plainBox(p: P, at: Pt): Shape {
  const o = p.options;
  const boxed = bool(o['background'], false) || bool(o['border'], false);
  const layout = measureLayout(p, textOf(p.drawing), boxed ? { x: 8, y: 6 } : { x: 0, y: 0 }, wrapWidthOf(o));
  return { layout, box: { x: at.x, y: at.y, w: layout.width, h: layout.height } };
}

/** Bubble above-right of `tip`, tail from its bottom-left (comment / balloon / price label). */
function bubbleAbove(p: P, text: string, tip: Pt, pad: { x: number; y: number }, gap: number): Shape {
  const layout = measureLayout(p, text, pad, wrapWidthOf(p.options), 24);
  return { layout, box: { x: tip.x - 6, y: tip.y - gap - layout.height, w: layout.width, h: layout.height }, tip };
}

function drawBox(p: P, s: Shape, bg: string | null, border: string | null, radius: number, textColor: string): void {
  const { ctx } = p;
  ctx.save();
  ctx.setLineDash([]);
  if (bg || border) {
    if (s.tip) bubblePath(ctx, s.box, radius, s.tip);
    else roundRectPath(ctx, s.box, radius);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fill();
    }
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  fillLines(ctx, s.layout, s.box, textColor, alignOf(p.options['align']));
  ctx.restore();
}

export function hitShape(s: Shape | null, at: Pt, tol: number): boolean {
  if (!s) return false;
  if (inRect(at, s.box, tol)) return true;
  if (s.tip) {
    const c = { x: s.box.x + s.box.w / 2, y: s.box.y + s.box.h / 2 };
    if (distToSegment(at, c, s.tip) <= tol + 4) return true;
  }
  for (const [a, b] of s.segments ?? []) if (distToSegment(at, a, b) <= tol) return true;
  for (const c of s.circles ?? []) if (Math.hypot(at.x - c.c.x, at.y - c.c.y) <= c.r + tol) return true;
  return false;
}

function boxTool(
  def: Omit<ToolBehavior, 'paint' | 'hitTest'>,
  shape: (p: P) => Shape | null,
  draw: (p: P, s: Shape) => void,
): ToolBehavior {
  return {
    ...def,
    paint: (p) => {
      const s = p.pts.length ? shape(p) : null;
      if (s) draw(p, s);
    },
    hitTest: (p, at, tol) => (p.pts.length ? hitShape(shape(p), at, tol) : false),
  };
}

const textColorOf = (p: P, d: string): string => p.drawing.style.textColor ?? d;
/** Colour option, or null when its on/off toggle is off. */
const colorOpt = (p: P, key: string, onKey: string, d: string, dOn: boolean): string | null =>
  bool(p.options[onKey], dOn) ? str(p.options[key], d) : null;

const bubbleOptions = (bg: string, border: string): readonly ToolOption[] => [
  opt.align('left'),
  opt.background(true),
  opt.backgroundColor(bg),
  opt.border(true),
  opt.borderColor(border),
  opt.wordWrap(false),
  opt.wordWrapWidth(200),
];

// ── Text ──────────────────────────────────────────────────────────────────
const TEXT = boxTool(
  {
    points: 1,
    defaultStyle: { text: DEFAULT_TEXT, fontSize: 14, color: TV_BLUE, textColor: TV_BLUE, bold: false, italic: false },
    options: [
      opt.align('left'),
      opt.background(false),
      opt.backgroundColor('rgba(41,98,255,0.25)'),
      opt.border(false),
      opt.borderColor('#707070'),
      opt.wordWrap(false),
      opt.wordWrapWidth(200),
    ],
  },
  (p) => plainBox(p, p.pts[0]),
  (p, s) =>
    drawBox(
      p,
      s,
      colorOpt(p, 'backgroundColor', 'background', 'rgba(41,98,255,0.25)', false),
      colorOpt(p, 'borderColor', 'border', '#707070', false),
      4,
      textColorOf(p, TV_BLUE),
    ),
);

// ── Note (TV "Note": a pin whose text shows on hover; here when selected) ──
const PIN_R = 9;
function notePin(p: P): Shape {
  const a = p.pts[0];
  const head = { x: a.x, y: a.y - 22 };
  const s = bubbleAbove(p, textOf(p.drawing), { x: head.x, y: head.y - PIN_R }, { x: 10, y: 8 }, 10);
  s.box.x = head.x - s.box.w / 2;
  s.circles = [{ c: head, r: PIN_R }];
  s.segments = [[a, head]];
  return s;
}
const NOTE: ToolBehavior = {
  points: 1,
  defaultStyle: { text: DEFAULT_TEXT, fontSize: 14, color: TV_BLUE, textColor: WHITE },
  options: [
    opt.align('left'),
    opt.backgroundColor('rgba(41,98,255,0.7)'),
    opt.borderColor(TV_BLUE),
    opt.wordWrap(true),
    opt.wordWrapWidth(240),
  ],
  paint: (p) => {
    if (!p.pts.length) return;
    const s = notePin(p);
    const { ctx } = p;
    const a = p.pts[0];
    const head = s.circles![0].c;
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = p.drawing.style.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(head.x, head.y, PIN_R, 0, Math.PI * 2);
    ctx.fillStyle = p.drawing.style.color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = WHITE;
    ctx.fill();
    ctx.restore();
    if (p.selected) {
      drawBox(p, s, str(p.options['backgroundColor'], 'rgba(41,98,255,0.7)'), str(p.options['borderColor'], TV_BLUE), 6, textColorOf(p, WHITE));
    }
  },
  // Only the pin is clickable; the text box is a hover/selection affordance.
  hitTest: (p, at, tol) => {
    if (!p.pts.length) return false;
    const s = notePin(p);
    return hitShape({ ...s, box: { x: -1e9, y: -1e9, w: 0, h: 0 }, tip: undefined }, at, tol);
  },
};

// ── Comment (blue rounded bubble, white text, tail to the anchor) ──────────
const commentShape = (p: P): Shape => bubbleAbove(p, textOf(p.drawing), p.pts[0], { x: 12, y: 8 }, 14);
const COMMENT = boxTool(
  { points: 1, defaultStyle: { text: DEFAULT_TEXT, fontSize: 16, color: TV_BLUE, textColor: WHITE }, options: bubbleOptions(TV_BLUE, TV_BLUE) },
  commentShape,
  (p, s) =>
    drawBox(p, s, colorOpt(p, 'backgroundColor', 'background', TV_BLUE, true), colorOpt(p, 'borderColor', 'border', TV_BLUE, true), 16, textColorOf(p, WHITE)),
);

// ── Balloon (legacy yellow speech balloon) ─────────────────────────────────
const BALLOON_BG = 'rgba(156,39,176,0.7)';
const BALLOON_BORDER = 'rgba(156,39,176,0)';
const balloonShape = (p: P): Shape => bubbleAbove(p, textOf(p.drawing), p.pts[0], { x: 10, y: 6 }, 16);
const BALLOON = boxTool(
  { points: 1, defaultStyle: { text: DEFAULT_TEXT, fontSize: 14, color: '#9C27B0', textColor: WHITE }, options: bubbleOptions(BALLOON_BG, BALLOON_BORDER) },
  balloonShape,
  (p, s) =>
    drawBox(
      p,
      s,
      colorOpt(p, 'backgroundColor', 'background', BALLOON_BG, true),
      colorOpt(p, 'borderColor', 'border', BALLOON_BORDER, true),
      10,
      textColorOf(p, WHITE),
    ),
);

const CALLOUT_BG = 'rgba(0,151,167,0.7)';
const CALLOUT_BORDER = '#0097A7';
// ── Callout (anchor tip + draggable box; handles: tip and box) ─────────────
function calloutShape(p: P): Shape {
  const tip = p.pts[0];
  const at = p.pts[1] ?? { x: tip.x + 30, y: tip.y - 60 };
  const layout = measureLayout(p, textOf(p.drawing), { x: 10, y: 6 }, wrapWidthOf(p.options), 24);
  return { layout, box: { x: at.x, y: at.y, w: layout.width, h: layout.height }, tip };
}
const CALLOUT = boxTool(
  {
    points: 2,
    defaultStyle: { text: DEFAULT_TEXT, fontSize: 14, color: CALLOUT_BORDER, textColor: WHITE, width: 2 },
    options: bubbleOptions(CALLOUT_BG, CALLOUT_BORDER),
  },
  calloutShape,
  (p, s) =>
    drawBox(
      p,
      s,
      colorOpt(p, 'backgroundColor', 'background', CALLOUT_BG, true),
      colorOpt(p, 'borderColor', 'border', CALLOUT_BORDER, true),
      6,
      textColorOf(p, WHITE),
    ),
);

// ── Price Label (tag with the anchor's price inside, tail to the price) ────
function priceLabelShape(p: P): Shape {
  const a = p.pts[0];
  const price = p.drawing.points[0]?.price ?? p.priceAt(a.y);
  const text = p.drawing.style.text || (price === null || price === undefined ? '' : formatPrice(price, p.precision));
  return bubbleAbove(p, text, a, { x: 8, y: 4 }, 12);
}
const PRICE_LABEL = boxTool(
  {
    points: 1,
    defaultStyle: { text: '', fontSize: 14, bold: true, color: TV_BLUE, textColor: WHITE },
    options: [opt.backgroundColor(TV_BLUE), opt.border(true), opt.borderColor(TV_BLUE)],
  },
  priceLabelShape,
  (p, s) => drawBox(p, s, str(p.options['backgroundColor'], TV_BLUE), colorOpt(p, 'borderColor', 'border', TV_BLUE, true), 4, textColorOf(p, WHITE)),
);

// ── Signpost (vertical pole from the bar's high/low to an emoji head + label) ─
/** Price the pole reaches down/up to: the nearest bar's high (label above) or low (below). */
export function signpostBase(bars: P['bars'], time: number, labelPrice: number): number | null {
  if (!bars || !bars.length) return null;
  let best = bars[0];
  for (const b of bars) if (Math.abs(b.time - time) < Math.abs(best.time - time)) best = b;
  return labelPrice >= best.high ? best.high : labelPrice <= best.low ? best.low : labelPrice;
}
/** Pixels per unit price around y (price up ⇒ y down, so negative). */
function pxPerPrice(p: P, y: number): number {
  const p0 = p.priceAt(y);
  const p1 = p.priceAt(y + 100);
  if (p0 === null || p1 === null || p0 === p1) return 0;
  return 100 / (p1 - p0);
}
const SIGN_HEAD_R = 12;
function signpostShape(p: P): Shape {
  const head = p.pts[0];
  const d = p.drawing.points[0];
  const basePrice = d ? signpostBase(p.bars, d.time, d.price) : null;
  let baseY = head.y + 40;
  if (basePrice !== null && d) {
    const k = pxPerPrice(p, head.y);
    if (k !== 0) baseY = head.y + (basePrice - d.price) * k;
  }
  const above = baseY >= head.y;
  const r = bool(p.options['emoji'], false) ? SIGN_HEAD_R : 0;
  const layout = measureLayout(p, textOf(p.drawing), { x: 8, y: 4 }, wrapWidthOf(p.options));
  const boxY = above ? head.y - r - (r ? 4 : 0) - layout.height : head.y + r + (r ? 4 : 0);
  return {
    layout,
    box: { x: head.x - layout.width / 2, y: boxY, w: layout.width, h: layout.height },
    segments: [[{ x: head.x, y: baseY }, head]],
    circles: r ? [{ c: head, r }] : [],
  };
}
const SIGNPOST = boxTool(
  {
    points: 1,
    defaultStyle: { text: DEFAULT_TEXT, fontSize: 12, color: TV_BLUE, textColor: WHITE },
    options: [
      { key: 'emoji', label: 'Emoji pin', type: 'bool', default: false, tab: 'text' },
      { key: 'emojiChar', label: 'Emoji', type: 'text', default: '🙂', tab: 'text' },
      opt.wordWrap(false),
      opt.wordWrapWidth(200),
    ],
  },
  signpostShape,
  (p, s) => {
    const { ctx } = p;
    const [base, head] = s.segments![0];
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = p.drawing.style.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    if (s.circles?.length) {
      ctx.beginPath();
      ctx.arc(head.x, head.y, SIGN_HEAD_R, 0, Math.PI * 2);
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.strokeStyle = p.drawing.style.color;
      ctx.stroke();
      ctx.font = `${Math.round(SIGN_HEAD_R * 1.3)}px ${EMOJI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(str(p.options['emojiChar'], '🙂'), head.x, head.y + 1);
    }
    ctx.restore();
    // TV's "plate": the label box takes the signpost colour, text on it.
    drawBox(p, s, p.drawing.style.color, p.drawing.style.color, 4, textColorOf(p, WHITE));
  },
);

// ── Flag Mark (small coloured flag, pole foot on the anchor) ───────────────
const FLAG_W = 16;
const FLAG_H = 22;
const FLAG: ToolBehavior = {
  points: 1,
  defaultStyle: { color: TV_BLUE, text: '' },
  paint: (p) => {
    if (!p.pts.length) return;
    const { ctx } = p;
    const a = p.pts[0];
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = p.drawing.style.color;
    ctx.fillRect(a.x - 1, a.y - FLAG_H, 2, FLAG_H);
    ctx.beginPath();
    ctx.moveTo(a.x + 1, a.y - FLAG_H);
    ctx.lineTo(a.x + FLAG_W, a.y - FLAG_H);
    ctx.lineTo(a.x + FLAG_W - 4, a.y - FLAG_H + 5);
    ctx.lineTo(a.x + FLAG_W, a.y - FLAG_H + 10);
    ctx.lineTo(a.x + 1, a.y - FLAG_H + 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
  hitTest: (p, at, tol) =>
    !!p.pts.length && inRect(at, { x: p.pts[0].x - 2, y: p.pts[0].y - FLAG_H, w: FLAG_W + 2, h: FLAG_H }, tol),
};

// ── Sticker (emoji, centred on the anchor) ─────────────────────────────────
const STICKERS = ['⭐', '🚀', '💰', '🔥', '🎯', '⚠️', '👍', '👎', '🐂', '🐻', '💎', '📈', '📉'] as const;
const stickerSize = (p: P): number => num(p.options['size'], 48);
const STICKER: ToolBehavior = {
  points: 1,
  defaultStyle: { text: '' },
  options: [
    { key: 'sticker', label: 'Sticker', type: 'select', default: '⭐', choices: STICKERS, tab: 'style' },
    { key: 'size', label: 'Size', type: 'number', default: 48, min: 16, max: 160, step: 4, tab: 'style' },
  ],
  paint: (p) => {
    if (!p.pts.length) return;
    const { ctx } = p;
    const a = p.pts[0];
    const s = stickerSize(p);
    ctx.save();
    ctx.font = `${s}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = DARK;
    ctx.fillText(str(p.options['sticker'], '⭐'), a.x, a.y);
    if (p.selected) {
      ctx.strokeStyle = TV_BLUE;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x - s / 2 - 4, a.y - s / 2 - 4, s + 8, s + 8);
    }
    ctx.restore();
  },
  hitTest: (p, at, tol) => {
    if (!p.pts.length) return false;
    const h = stickerSize(p) / 2 + 4;
    return inRect(at, { x: p.pts[0].x - h, y: p.pts[0].y - h, w: h * 2, h: h * 2 }, tol);
  },
};

// ── Idea (lightbulb badge + title) ────────────────────────────────────────
function ideaShape(p: P): Shape {
  const a = p.pts[0];
  const layout = measureLayout(p, textOf(p.drawing, 'Idea'), { x: 8, y: 4 }, wrapWidthOf(p.options));
  return { layout, box: { x: a.x + 16, y: a.y - layout.height / 2, w: layout.width, h: layout.height }, circles: [{ c: a, r: 12 }] };
}
const IDEA = boxTool(
  {
    points: 1,
    defaultStyle: { text: 'Idea', fontSize: 12, color: '#FF9800', textColor: DARK },
    options: [opt.backgroundColor(WHITE), opt.borderColor('#FF9800')],
  },
  ideaShape,
  (p, s) => {
    const { ctx } = p;
    const c = s.circles![0];
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c.c.x, c.c.y, c.r, 0, Math.PI * 2);
    ctx.fillStyle = p.drawing.style.color;
    ctx.fill();
    ctx.font = `14px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💡', c.c.x, c.c.y + 1);
    ctx.restore();
    drawBox(p, s, str(p.options['backgroundColor'], WHITE), str(p.options['borderColor'], '#FF9800'), 4, textColorOf(p, DARK));
  },
);

export const BEHAVIORS: ToolBehaviorMap = {
  text: TEXT,
  'anchored-note': NOTE,
  comment: COMMENT,
  table: TABLE_BEHAVIOR,
  callout: CALLOUT,
  'price-label': PRICE_LABEL,
  signpost: SIGNPOST,
  flag: FLAG,
  balloon: BALLOON,
  sticker: STICKER,
  idea: IDEA,
};

/**
 * Screen rect of a drawing's editable text — for the inline editor (position a
 * textarea over it on double-click). Null for tools without free text
 * (flag, sticker; table uses `tableCellAt` from text-table.ts).
 */
export function textBoxRect(p: TextPaintCtx): Rect | null {
  if (!p.pts.length) return null;
  switch (p.drawing.kind) {
    case 'text':
      return plainBox(p, p.pts[0]).box;
    case 'anchored-note':
      return notePin(p).box;
    case 'comment':
      return commentShape(p).box;
    case 'balloon':
      return balloonShape(p).box;
    case 'callout':
      return calloutShape(p).box;
    case 'price-label':
      return priceLabelShape(p).box;
    case 'signpost':
      return signpostShape(p).box;
    case 'idea':
      return ideaShape(p).box;
    default:
      return null;
  }
}
