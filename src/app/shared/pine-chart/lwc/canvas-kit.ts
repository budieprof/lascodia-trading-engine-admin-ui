import type { PineShape } from '../model/pine-outputs.types';

/**
 * Canvas primitives shared by the painters: dash patterns, fonts, text measurement and the Pine shape
 * glyphs (plotshape, label shape styles, trade arrows). All coordinates are CSS px.
 */

export type Ctx = CanvasRenderingContext2D;

/** Dash pattern for a Pine line style at a stroke width. */
export function dashFor(style: string, width: number): number[] {
  const w = Math.max(1, width);
  switch (style) {
    case 'dotted':
      return [w, Math.max(2, w * 2)];
    case 'dashed':
      return [Math.max(4, w * 4), Math.max(3, w * 2.5)];
    default:
      return [];
  }
}

export function applyStroke(ctx: Ctx, color: string, width: number, style = 'solid'): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width);
  const dash = dashFor(style, width);
  ctx.setLineDash(dash);
  ctx.lineCap = style === 'dotted' ? 'round' : 'butt';
  ctx.lineJoin = 'round';
}

export function cssFont(sizePx: number, family: string, bold = false, italic = false): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${Math.max(1, Math.round(sizePx))}px ${family}`;
}

const widthCache = new Map<string, number>();

/** measureText().width with a cache keyed by font + text (labels repaint every frame). */
export function textWidth(ctx: Ctx, text: string): number {
  const key = `${ctx.font}\u0000${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const w = ctx.measureText(text).width;
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

export function splitLines(text: string): string[] {
  return text.length ? text.split(/\r?\n/) : [];
}

/** Word-wraps `text` to `maxWidth` (explicit newlines kept; over-long words broken by character). */
export function wrapText(ctx: Ctx, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of splitLines(text)) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(ctx, candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (textWidth(ctx, word) <= maxWidth) {
        line = word;
        continue;
      }
      // A single word wider than the box: break it by character.
      let chunk = '';
      for (const ch of word) {
        if (chunk && textWidth(ctx, chunk + ch) > maxWidth) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

export interface TextBlock {
  lines: string[];
  width: number;
  lineHeight: number;
  height: number;
}

export function measureBlock(ctx: Ctx, lines: string[], fontSize: number): TextBlock {
  let width = 0;
  for (const l of lines) width = Math.max(width, textWidth(ctx, l));
  const lineHeight = Math.round(fontSize * 1.25);
  return { lines, width, lineHeight, height: lines.length * lineHeight };
}

/**
 * Draws a text block whose box is (x, y, w, h), aligned inside it. `align` is the Pine text align
 * (left/center/right), `valign` top/center/bottom.
 */
export function drawTextBlock(
  ctx: Ctx,
  block: TextBlock,
  x: number,
  y: number,
  w: number,
  h: number,
  align: 'left' | 'center' | 'right',
  valign: 'top' | 'center' | 'bottom',
  color: string,
  outline: { color: string; width: number } | null = null,
): void {
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  const tx = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;
  const top =
    valign === 'top' ? y : valign === 'bottom' ? y + h - block.height : y + (h - block.height) / 2;
  for (let i = 0; i < block.lines.length; i++) {
    const ty = top + i * block.lineHeight + block.lineHeight / 2;
    if (outline) {
      ctx.lineWidth = outline.width;
      ctx.strokeStyle = outline.color;
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.strokeText(block.lines[i], tx, ty);
    }
    ctx.fillStyle = color;
    ctx.fillText(block.lines[i], tx, ty);
  }
}

/** Rounded rectangle path (no fill/stroke). */
export function roundRectPath(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Draws a Pine shape centred on (cx, cy) with an overall size of `size` px. labelup/labeldown are
 * drawn by the label painters (they carry text), so here they fall back to their pointer triangle.
 */
export function drawShape(
  ctx: Ctx,
  shape: PineShape | string,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const s = Math.max(2, size);
  const h = s / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.setLineDash([]);
  ctx.lineJoin = 'miter';
  switch (shape) {
    case 'xcross': {
      ctx.lineWidth = Math.max(1.5, s / 7);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - h, cy - h);
      ctx.lineTo(cx + h, cy + h);
      ctx.moveTo(cx + h, cy - h);
      ctx.lineTo(cx - h, cy + h);
      ctx.stroke();
      break;
    }
    case 'cross': {
      ctx.lineWidth = Math.max(1.5, s / 7);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - h, cy);
      ctx.lineTo(cx + h, cy);
      ctx.moveTo(cx, cy - h);
      ctx.lineTo(cx, cy + h);
      ctx.stroke();
      break;
    }
    case 'circle': {
      ctx.beginPath();
      ctx.arc(cx, cy, h, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'square': {
      ctx.fillRect(cx - h, cy - h, s, s);
      break;
    }
    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(cx, cy - h);
      ctx.lineTo(cx + h, cy);
      ctx.lineTo(cx, cy + h);
      ctx.lineTo(cx - h, cy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'triangleup':
    case 'labelup': {
      ctx.beginPath();
      ctx.moveTo(cx, cy - h);
      ctx.lineTo(cx + h, cy + h);
      ctx.lineTo(cx - h, cy + h);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'triangledown':
    case 'labeldown': {
      ctx.beginPath();
      ctx.moveTo(cx - h, cy - h);
      ctx.lineTo(cx + h, cy - h);
      ctx.lineTo(cx, cy + h);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'arrowup':
      drawArrow(ctx, cx, cy - h, cy + h, s * 0.9, color);
      break;
    case 'arrowdown':
      drawArrow(ctx, cx, cy + h, cy - h, s * 0.9, color);
      break;
    case 'flag': {
      const pole = Math.max(1, s / 8);
      ctx.fillRect(cx - h, cy - h, pole, s);
      ctx.beginPath();
      ctx.moveTo(cx - h + pole, cy - h);
      ctx.lineTo(cx + h, cy - h + s * 0.28);
      ctx.lineTo(cx - h + pole, cy - h + s * 0.56);
      ctx.closePath();
      ctx.fill();
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(cx, cy, h, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * A filled arrow from `tailY` to `tipY` at x = cx (vertical). `width` is the head width; the shaft is
 * a third of it.
 */
export function drawArrow(
  ctx: Ctx,
  cx: number,
  tipY: number,
  tailY: number,
  width: number,
  color: string,
): void {
  const len = Math.abs(tailY - tipY);
  if (len < 1) return;
  const dir = tailY > tipY ? 1 : -1; // +1: arrow points up (tail below)
  const headW = Math.max(4, width);
  const headH = Math.min(len, headW * 0.85);
  const shaftW = Math.max(1, headW / 3);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx + headW / 2, tipY + dir * headH);
  ctx.lineTo(cx + shaftW / 2, tipY + dir * headH);
  ctx.lineTo(cx + shaftW / 2, tailY);
  ctx.lineTo(cx - shaftW / 2, tailY);
  ctx.lineTo(cx - shaftW / 2, tipY + dir * headH);
  ctx.lineTo(cx - headW / 2, tipY + dir * headH);
  ctx.closePath();
  ctx.fill();
}

/** Arrowhead at (x, y) pointing along the direction from (fromX, fromY). */
export function drawArrowHead(
  ctx: Ctx,
  fromX: number,
  fromY: number,
  x: number,
  y: number,
  width: number,
  color: string,
): void {
  const angle = Math.atan2(y - fromY, x - fromX);
  const len = 6 + width * 2;
  const spread = Math.PI / 7;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - len * Math.cos(angle - spread), y - len * Math.sin(angle - spread));
  ctx.lineTo(x - len * Math.cos(angle + spread), y - len * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Catmull-Rom spline through the points as cubic Bézier segments (what `polyline.new(curved = true)`
 * draws). `closed` wraps the control points around.
 */
export function curvePath(
  ctx: Ctx,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  closed: boolean,
): void {
  const n = xs.length;
  if (n < 2) return;
  const px = (i: number) => (closed ? xs[(i + n) % n] : xs[Math.max(0, Math.min(n - 1, i))]);
  const py = (i: number) => (closed ? ys[(i + n) % n] : ys[Math.max(0, Math.min(n - 1, i))]);
  ctx.moveTo(xs[0], ys[0]);
  const segments = closed ? n : n - 1;
  const t = 1 / 6;
  for (let i = 0; i < segments; i++) {
    const c1x = px(i) + (px(i + 1) - px(i - 1)) * t;
    const c1y = py(i) + (py(i + 1) - py(i - 1)) * t;
    const c2x = px(i + 1) - (px(i + 2) - px(i)) * t;
    const c2y = py(i + 1) - (py(i + 2) - py(i)) * t;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, px(i + 1), py(i + 1));
  }
}
