import type { MarkerLayer } from '../render/render-model';
import { FONT_DEFAULT } from '../render/build-render-model';
import {
  cssFont,
  drawArrow,
  drawShape,
  drawTextBlock,
  measureBlock,
  roundRectPath,
  splitLines,
  type Ctx,
} from './canvas-kit';
import type { Projection } from './projection';
import { lowerBound } from './paint-series';

/**
 * plotshape / plotchar / plotarrow.
 *
 * Markers sit relative to their bar (`abovebar` / `belowbar`), the pane edges (`top` / `bottom`)
 * or a price (`absolute`). Several markers on one bar and location stack outward instead of
 * overlapping, which is what Pine does when two plotshape() calls fire on the same bar. In a
 * separate pane there are no price bars, so above/below-bar placement falls back to the pane edges.
 */

/** High/low of the main-series bar at a logical index (NaN outside the data). */
export interface BarLookup {
  high(logical: number): number;
  low(logical: number): number;
}

/** Pixels already used per bar, per side, this frame — shared by every marker and trade layer. */
export class MarkerStacks {
  private readonly above = new Map<number, number>();
  private readonly below = new Map<number, number>();
  private readonly top = new Map<number, number>();
  private readonly bottom = new Map<number, number>();

  take(side: 'above' | 'below' | 'top' | 'bottom', logical: number, px: number): number {
    const m = this.map(side);
    const used = m.get(logical) ?? 0;
    m.set(logical, used + px);
    return used;
  }

  private map(side: 'above' | 'below' | 'top' | 'bottom'): Map<number, number> {
    switch (side) {
      case 'above':
        return this.above;
      case 'below':
        return this.below;
      case 'top':
        return this.top;
      default:
        return this.bottom;
    }
  }
}

/** Shape box in px for a size.* (auto follows the zoom level). */
export function shapeSizePx(size: string, barSpacing: number): number {
  switch (size) {
    case 'tiny':
      return 8;
    case 'small':
      return 12;
    case 'normal':
      return 18;
    case 'large':
      return 26;
    case 'huge':
      return 38;
    default:
      return Math.max(6, Math.min(14, Math.round(barSpacing * 0.8)));
  }
}

/** plotchar glyph px for a size.*. */
export function charSizePx(size: string, barSpacing: number): number {
  switch (size) {
    case 'tiny':
      return 10;
    case 'small':
      return 14;
    case 'normal':
      return 20;
    case 'large':
      return 28;
    case 'huge':
      return 40;
    default:
      return Math.max(8, Math.min(16, Math.round(barSpacing * 1.1)));
  }
}

const GAP = 4;
const TEXT_PX = 12;

export function paintMarkers(
  ctx: Ctx,
  p: Projection,
  layer: MarkerLayer,
  bars: BarLookup | null,
  stacks: MarkerStacks,
): void {
  if (!layer.display.pane || layer.logicals.length === 0) return;
  const i0 = lowerBound(layer.logicals, p.from);
  const i1 = lowerBound(layer.logicals, p.to + 1) - 1;
  if (i0 > i1) return;
  ctx.save();
  ctx.setLineDash([]);
  if (layer.kind === 'arrow') paintArrows(ctx, p, layer, bars, stacks, i0, i1);
  else paintShapes(ctx, p, layer, bars, stacks, i0, i1);
  ctx.restore();
}

type Side = 'above' | 'below' | 'top' | 'bottom' | 'absolute';

function sideOf(location: string, bars: BarLookup | null): Side {
  switch (location) {
    case 'abovebar':
      return bars ? 'above' : 'top';
    case 'belowbar':
      return bars ? 'below' : 'bottom';
    case 'top':
      return 'top';
    case 'bottom':
      return 'bottom';
    default:
      return 'absolute';
  }
}

function paintShapes(
  ctx: Ctx,
  p: Projection,
  layer: MarkerLayer,
  bars: BarLookup | null,
  stacks: MarkerStacks,
  i0: number,
  i1: number,
): void {
  const side = sideOf(layer.location, bars);
  const isChar = layer.kind === 'char';
  const size = isChar ? charSizePx(layer.size, p.barSpacing) : shapeSizePx(layer.size, p.barSpacing);
  const bubble = !isChar && (layer.shape === 'labelup' || layer.shape === 'labeldown');
  ctx.font = cssFont(TEXT_PX, FONT_DEFAULT);
  const textLines = splitLines(layer.text);
  const textBlock = textLines.length ? measureBlock(ctx, textLines, TEXT_PX) : null;

  for (let i = i0; i <= i1; i++) {
    const color = layer.colors[i];
    const textColor = layer.textColors[i] ?? color;
    if (!color && !(textBlock && textColor)) continue;
    const logical = layer.logicals[i];
    const x = p.x(logical);

    // The marker's footprint along the stacking direction.
    let boxW = size;
    let boxH = size;
    if (bubble) {
      const inner = textBlock ?? { width: 0, height: TEXT_PX, lines: [], lineHeight: TEXT_PX };
      boxW = Math.max(size, inner.width + 12);
      boxH = Math.max(size * 0.8, inner.height + 6) + 6; // + pointer
    }
    const textH = !bubble && textBlock ? textBlock.height + 2 : 0;
    const footprint = boxH + textH + 2;

    let shapeTop: number;
    let textTop: number | null = null;
    if (side === 'absolute') {
      const cy = p.y(layer.values[i]);
      if (!Number.isFinite(cy)) continue;
      shapeTop = cy - boxH / 2;
      if (textH) textTop = shapeTop - textH;
    } else if (side === 'above') {
      const hi = bars!.high(logical);
      if (!(hi === hi)) continue;
      const used = stacks.take('above', logical, footprint);
      const bottom = p.y(hi) - GAP - used;
      shapeTop = bottom - boxH;
      if (textH) textTop = shapeTop - textH;
    } else if (side === 'below') {
      const lo = bars!.low(logical);
      if (!(lo === lo)) continue;
      const used = stacks.take('below', logical, footprint);
      shapeTop = p.y(lo) + GAP + used;
      if (textH) textTop = shapeTop + boxH + 2;
    } else if (side === 'top') {
      const used = stacks.take('top', logical, footprint);
      shapeTop = GAP + used;
      if (textH) textTop = shapeTop + boxH + 2;
    } else {
      const used = stacks.take('bottom', logical, footprint);
      shapeTop = p.height - GAP - used - boxH;
      if (textH) textTop = shapeTop - textH;
    }

    if (bubble) {
      drawBubble(ctx, layer.shape === 'labelup', x, shapeTop, boxW, boxH, color, textBlock, textColor);
    } else if (isChar) {
      if (color) {
        ctx.save();
        ctx.font = cssFont(size, FONT_DEFAULT);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(layer.char, x, shapeTop + size / 2);
        ctx.restore();
      }
    } else if (color) {
      drawShape(ctx, layer.shape, x, shapeTop + size / 2, size, color);
    }

    if (textBlock && textTop !== null && textColor) {
      ctx.font = cssFont(TEXT_PX, FONT_DEFAULT);
      drawTextBlock(ctx, textBlock, x - textBlock.width / 2, textTop, textBlock.width, textBlock.height, 'center', 'top', textColor);
    }
  }
}

/** shape.labelup / shape.labeldown: a bubble with its pointer toward the bar, text inside. */
function drawBubble(
  ctx: Ctx,
  up: boolean,
  x: number,
  top: number,
  w: number,
  h: number,
  color: string | null,
  text: ReturnType<typeof measureBlock> | null,
  textColor: string | null,
): void {
  const ptr = 6;
  const boxTop = up ? top + ptr : top;
  const boxH = h - ptr;
  const left = x - w / 2;
  if (color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    roundRectPath(ctx, left, boxTop, w, boxH, 3);
    ctx.fill();
    ctx.beginPath();
    if (up) {
      ctx.moveTo(x - ptr, boxTop + 0.5);
      ctx.lineTo(x, top);
      ctx.lineTo(x + ptr, boxTop + 0.5);
    } else {
      ctx.moveTo(x - ptr, boxTop + boxH - 0.5);
      ctx.lineTo(x, top + h);
      ctx.lineTo(x + ptr, boxTop + boxH - 0.5);
    }
    ctx.closePath();
    ctx.fill();
  }
  if (text && textColor) {
    ctx.font = cssFont(TEXT_PX, FONT_DEFAULT);
    drawTextBlock(ctx, text, left, boxTop, w, boxH, 'center', 'center', textColor);
  }
}

/**
 * plotarrow: up arrows under the bar for positive values, down arrows over it for negative ones,
 * with a length between minheight and maxheight proportional to |value| relative to the largest
 * |value| in view.
 */
function paintArrows(
  ctx: Ctx,
  p: Projection,
  layer: MarkerLayer,
  bars: BarLookup | null,
  stacks: MarkerStacks,
  i0: number,
  i1: number,
): void {
  let maxAbs = 0;
  for (let i = i0; i <= i1; i++) {
    const v = Math.abs(layer.values[i]);
    if (v > maxAbs) maxAbs = v;
  }
  if (!(maxAbs > 0)) return;
  const minH = Math.min(layer.minHeight, layer.maxHeight);
  const maxH = Math.max(layer.minHeight, layer.maxHeight);
  const headW = Math.max(5, Math.min(14, p.barSpacing * 0.8));
  for (let i = i0; i <= i1; i++) {
    const v = layer.values[i];
    const color = layer.colors[i];
    if (!(v === v) || v === 0 || !color) continue;
    const logical = layer.logicals[i];
    const x = p.x(logical);
    const len = minH + ((maxH - minH) * Math.abs(v)) / maxAbs;
    const up = layer.up[i] === 1;
    if (up) {
      let tip: number;
      if (bars) {
        const lo = bars.low(logical);
        if (!(lo === lo)) continue;
        tip = p.y(lo) + GAP + stacks.take('below', logical, len + 2);
      } else {
        tip = p.height - GAP - len - stacks.take('bottom', logical, len + 2);
      }
      drawArrow(ctx, x, tip, tip + len, headW, color);
    } else {
      let tip: number;
      if (bars) {
        const hi = bars.high(logical);
        if (!(hi === hi)) continue;
        tip = p.y(hi) - GAP - stacks.take('above', logical, len + 2);
      } else {
        tip = GAP + len + stacks.take('top', logical, len + 2);
      }
      drawArrow(ctx, x, tip, tip - len, headW, color);
    }
  }
}
