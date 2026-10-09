import { distanceToSegment, pointInPolygon, type Pt } from '../geometry';
import type { ToolBehavior, ToolBehaviorMap } from './types';
import { fontOf } from './shapes-paint';

/**
 * TradingView tools the rail was missing (DR-I12): the Arrow Marker (a block arrow from one point to another, its
 * label at the tail), Icons (a glyph in the drawing's colour) and Image (a picture spanning two corners).
 */

const TV_BLUE = '#2962FF';

// ── Arrow Marker ───────────────────────────────────────────────────────────

/** The block arrow from `tail` to `tip`: shaft and head widths grow with the line width, as TradingView's do. */
export function arrowMarkerPolygon(tail: Pt, tip: Pt, width: number): Pt[] {
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const shaft = 3 + width * 1.5;
  const head = shaft * 2.6;
  const headLen = Math.min(len * 0.45, head * 1.6);
  const neck = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
  const at = (p: Pt, k: number) => ({ x: p.x + nx * k, y: p.y + ny * k });
  return [
    at(tail, shaft),
    at(neck, shaft),
    at(neck, head),
    tip,
    at(neck, -head),
    at(neck, -shaft),
    at(tail, -shaft),
  ];
}

const ARROW_MARKER: ToolBehavior = {
  points: 2,
  defaultStyle: { color: TV_BLUE, textColor: TV_BLUE, fill: null, width: 2, fontSize: 14 },
  options: [{ key: 'showLabel', label: 'Show label', type: 'bool', default: true, tab: 'text' }],
  paint({ ctx, pts, drawing, options }) {
    if (pts.length < 2) return;
    const poly = arrowMarkerPolygon(pts[0], pts[1], drawing.style.width);
    if (!poly.length) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = drawing.style.color;
    ctx.fill();
    if (options['showLabel'] !== false && drawing.style.text) {
      // The label sits beyond the tail, away from the head.
      const [tail, tip] = pts;
      const len = Math.hypot(tip.x - tail.x, tip.y - tail.y) || 1;
      const ux = (tip.x - tail.x) / len;
      const uy = (tip.y - tail.y) / len;
      ctx.font = fontOf(drawing);
      ctx.fillStyle = drawing.style.textColor ?? drawing.style.color;
      ctx.textAlign = ux > 0.3 ? 'right' : ux < -0.3 ? 'left' : 'center';
      ctx.textBaseline = uy > 0.3 ? 'bottom' : uy < -0.3 ? 'top' : 'middle';
      ctx.fillText(drawing.style.text, tail.x - ux * 6, tail.y - uy * 6);
    }
    ctx.restore();
  },
  hitTest({ pts, drawing }, at, tol) {
    if (pts.length < 2) return false;
    const poly = arrowMarkerPolygon(pts[0], pts[1], drawing.style.width);
    return (
      (poly.length > 0 && pointInPolygon(at, poly)) ||
      distanceToSegment(at, pts[0], pts[1]) <= tol + 3
    );
  },
};

// ── Icons ───────────────────────────────────────────────────────────────────

/** TradingView's icon set, as glyphs drawn in the drawing's colour (the Sticker tool keeps the colour emoji). */
export const ICONS = [
  '★',
  '♥',
  '✓',
  '✗',
  '⚑',
  '⚠',
  '●',
  '■',
  '▲',
  '▼',
  '◆',
  '✚',
  '☀',
  '⚡',
  '♣',
  '♠',
  '♦',
  '☺',
] as const;

const iconSize = (o: Record<string, unknown>): number => {
  const v = o['size'];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 32;
};

const ICON: ToolBehavior = {
  points: 1,
  defaultStyle: { color: TV_BLUE, text: '' },
  options: [
    { key: 'icon', label: 'Icon', type: 'select', default: '★', choices: ICONS, tab: 'style' },
    {
      key: 'size',
      label: 'Size',
      type: 'number',
      default: 32,
      min: 10,
      max: 160,
      step: 2,
      tab: 'style',
    },
  ],
  paint({ ctx, pts, drawing, options, selected }) {
    if (!pts.length) return;
    const a = pts[0];
    const s = iconSize(options);
    ctx.save();
    ctx.font = `${s}px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols 2",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = drawing.style.color;
    ctx.fillText(typeof options['icon'] === 'string' ? (options['icon'] as string) : '★', a.x, a.y);
    if (selected) {
      ctx.strokeStyle = TV_BLUE;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x - s / 2 - 4, a.y - s / 2 - 4, s + 8, s + 8);
    }
    ctx.restore();
  },
  hitTest({ pts, options }, at, tol) {
    if (!pts.length) return false;
    const h = iconSize(options) / 2 + 4;
    return Math.abs(at.x - pts[0].x) <= h + tol && Math.abs(at.y - pts[0].y) <= h + tol;
  },
};

// ── Image ───────────────────────────────────────────────────────────────────

/** Event the image cache raises when a picture has loaded, so every drawing renderer paints again. */
export const IMAGE_LOADED_EVENT = 'lascodia:drawing-image-loaded';

const images = new Map<string, HTMLImageElement>();

/** The decoded picture for a data URL; null until it has loaded (the renderers repaint then). */
export function imageFor(src: string): HTMLImageElement | null {
  if (!src || typeof Image === 'undefined') return null;
  let img = images.get(src);
  if (!img) {
    if (images.size > 64) images.clear();
    img = new Image();
    img.onload = () => {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(IMAGE_LOADED_EVENT));
    };
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** The rectangle two corners span (any order). */
export function cornerRect(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

const IMAGE: ToolBehavior = {
  points: 2,
  defaultStyle: { color: TV_BLUE, width: 1, fill: null },
  options: [
    { key: 'src', label: 'Picture', type: 'image', default: '', tab: 'style' },
    {
      key: 'opacity',
      label: 'Opacity %',
      type: 'number',
      default: 100,
      min: 5,
      max: 100,
      step: 5,
      tab: 'style',
    },
    { key: 'border', label: 'Border', type: 'bool', default: false, tab: 'style' },
  ],
  paint({ ctx, pts, drawing, options, selected }) {
    if (pts.length < 2) return;
    const r = cornerRect(pts[0], pts[1]);
    if (r.w < 1 || r.h < 1) return;
    const src = typeof options['src'] === 'string' ? (options['src'] as string) : '';
    const img = imageFor(src);
    ctx.save();
    ctx.setLineDash([]);
    if (img) {
      const opacity = typeof options['opacity'] === 'number' ? (options['opacity'] as number) : 100;
      ctx.globalAlpha = Math.max(0.05, Math.min(1, opacity / 100));
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
    } else {
      // No picture yet (or still loading): a frame that says what to do.
      ctx.fillStyle = 'rgba(41,98,255,0.08)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = drawing.style.color;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        src ? 'Loading…' : 'Double-click to choose a picture',
        r.x + r.w / 2,
        r.y + r.h / 2,
      );
    }
    if (selected || options['border'] === true || !img) {
      ctx.strokeStyle = drawing.style.color;
      ctx.lineWidth = 1;
      if (!img) ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  },
  hitTest({ pts }, at, tol) {
    if (pts.length < 2) return false;
    const r = cornerRect(pts[0], pts[1]);
    return (
      at.x >= r.x - tol && at.x <= r.x + r.w + tol && at.y >= r.y - tol && at.y <= r.y + r.h + tol
    );
  },
};

export const MEDIA_BEHAVIORS: ToolBehaviorMap = {
  'arrow-marker': ARROW_MARKER,
  icon: ICON,
  image: IMAGE,
};
