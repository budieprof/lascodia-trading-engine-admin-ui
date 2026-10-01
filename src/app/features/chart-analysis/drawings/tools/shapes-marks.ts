import { pointInPolygon, type Pt } from '../geometry';
import type { ToolBehavior, ToolBehaviorMap } from './types';
import { fontOf } from './shapes-paint';

/**
 * TradingView "Arrow Mark Up/Down/Left/Right": a filled block arrow whose TIP sits on the
 * anchor, with an optional text label beyond its tail. Colours per TradingView:
 * up #089981, down #CC2F3C, left/right #2962FF; label 14 px in the arrow colour.
 */

export type MarkDir = 'up' | 'down' | 'left' | 'right';

/** Glyph outline pointing UP with its tip at the origin (tail extends +y). */
const GLYPH_UP: readonly Pt[] = [
  { x: 0, y: 0 },
  { x: 10, y: 11 },
  { x: 4.5, y: 11 },
  { x: 4.5, y: 26 },
  { x: -4.5, y: 26 },
  { x: -4.5, y: 11 },
  { x: -10, y: 11 },
];
const GLYPH_LEN = 26;

const ROT: Record<MarkDir, (p: Pt) => Pt> = {
  up: (p) => p,
  down: (p) => ({ x: -p.x, y: -p.y }),
  left: (p) => ({ x: -p.y, y: p.x }),
  right: (p) => ({ x: p.y, y: -p.x }),
};

export function arrowMarkPolygon(at: Pt, dir: MarkDir): Pt[] {
  return GLYPH_UP.map((g) => {
    const r = ROT[dir](g);
    return { x: at.x + r.x, y: at.y + r.y };
  });
}

/** Where the label sits: just past the tail, centred on the arrow's axis. */
function labelAnchor(at: Pt, dir: MarkDir): { p: Pt; align: CanvasTextAlign; baseline: CanvasTextBaseline } {
  const gap = GLYPH_LEN + 4;
  switch (dir) {
    case 'up':
      return { p: { x: at.x, y: at.y + gap }, align: 'center', baseline: 'top' };
    case 'down':
      return { p: { x: at.x, y: at.y - gap }, align: 'center', baseline: 'bottom' };
    case 'left':
      return { p: { x: at.x + gap, y: at.y }, align: 'left', baseline: 'middle' };
    case 'right':
      return { p: { x: at.x - gap, y: at.y }, align: 'right', baseline: 'middle' };
  }
}

function mark(dir: MarkDir, color: string): ToolBehavior {
  return {
    points: 1,
    defaultStyle: { color, textColor: color, fill: null, fontSize: 14, width: 1 },
    options: [{ key: 'showLabel', label: 'Show label', type: 'bool', default: true, tab: 'text' }],
    paint({ ctx, pts, drawing, options }) {
      if (!pts.length) return;
      const at = pts[0];
      ctx.save();
      ctx.setLineDash([]);
      ctx.beginPath();
      arrowMarkPolygon(at, dir).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = drawing.style.color;
      ctx.fill();
      if (options['showLabel'] !== false && drawing.style.text) {
        const l = labelAnchor(at, dir);
        ctx.font = fontOf(drawing);
        ctx.fillStyle = drawing.style.textColor ?? drawing.style.color;
        ctx.textAlign = l.align;
        ctx.textBaseline = l.baseline;
        drawing.style.text.split('\n').forEach((line, i, all) => {
          const lh = drawing.style.fontSize * 1.25;
          const dy = l.baseline === 'bottom' ? -(all.length - 1 - i) * lh : l.baseline === 'middle' ? (i - (all.length - 1) / 2) * lh : i * lh;
          ctx.fillText(line, l.p.x, l.p.y + dy);
        });
      }
      ctx.restore();
    },
    hitTest({ pts, drawing, options }, at, tol) {
      if (!pts.length) return false;
      const poly = arrowMarkPolygon(pts[0], dir);
      if (pointInPolygon(at, poly)) return true;
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      const inBox =
        at.x >= Math.min(...xs) - tol && at.x <= Math.max(...xs) + tol && at.y >= Math.min(...ys) - tol && at.y <= Math.max(...ys) + tol;
      if (inBox) return true;
      if (options['showLabel'] === false || !drawing.style.text) return false;
      // Approximate label box (no canvas during picking): ~0.6em per character.
      const l = labelAnchor(pts[0], dir);
      const w = drawing.style.text.length * drawing.style.fontSize * 0.6;
      const h = drawing.style.fontSize * 1.25;
      const x0 = l.align === 'center' ? l.p.x - w / 2 : l.align === 'left' ? l.p.x : l.p.x - w;
      const y0 = l.baseline === 'top' ? l.p.y : l.baseline === 'bottom' ? l.p.y - h : l.p.y - h / 2;
      return at.x >= x0 && at.x <= x0 + w && at.y >= y0 && at.y <= y0 + h;
    },
  };
}

export const MARK_BEHAVIORS: ToolBehaviorMap = {
  'arrow-mark-up': mark('up', '#089981'),
  'arrow-mark-down': mark('down', '#CC2F3C'),
  'arrow-mark-left': mark('left', '#2962FF'),
  'arrow-mark-right': mark('right', '#2962FF'),
};
