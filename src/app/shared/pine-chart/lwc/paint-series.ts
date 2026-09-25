import { trackColor } from '../core/color';
import type {
  BackgroundLayer,
  CandleLayer,
  FillEdge,
  FillLayer,
  HlineLayer,
  PlotLayer,
} from '../render/render-model';
import { applyStroke, type Ctx } from './canvas-kit';
import type { Projection } from './projection';

/**
 * Painters for per-bar outputs. Each draws only the visible slot window, batches consecutive runs
 * of one color into a single path, and allocates nothing per point — they run every frame of a pan.
 *
 * Pine rules implemented here (see the Plots page of the manual):
 * - a line segment into bar i takes bar i's color, so `color = na` on a bar hides the jump into it;
 * - `line` / `stepline` / `area` bridge na values, the `*br` styles break at them;
 * - an isolated `linebr` point draws as a short dash centred on its bar;
 * - step lines change level halfway between bars and the last bar plots only halfway;
 * - `histogram` bars are `linewidth` px wide, `columns` fill the bar spacing;
 * - circles and crosses size by `linewidth` and are joined by a 1px line when `join = true`;
 * - `trackprice` draws a dotted line at the last value across the whole pane.
 */

/** First index in the ascending array with value >= v. */
export function lowerBound(a: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index range of `valid` covering slots [s0, s1] plus one neighbour each side (for edge segments). */
function validWindow(valid: Int32Array, s0: number, s1: number): [number, number] {
  const n = valid.length;
  const k0 = Math.max(0, lowerBound(valid, s0) - 1);
  const k1 = Math.min(n - 1, lowerBound(valid, s1 + 1));
  return [k0, k1];
}

export function paintPlot(ctx: Ctx, p: Projection, layer: PlotLayer): void {
  if (!layer.display.pane || layer.valid.length === 0) return;
  ctx.save();
  switch (layer.style) {
    case 'line':
      strokePlotLine(ctx, p, layer, true, layer.lineWidth, layer.lineStyle);
      break;
    case 'linebr':
      strokePlotLine(ctx, p, layer, false, layer.lineWidth, layer.lineStyle);
      break;
    case 'stepline':
      strokeStepLine(ctx, p, layer, true);
      break;
    case 'steplinebr':
      strokeStepLine(ctx, p, layer, false);
      break;
    case 'stepline_diamond':
      strokeStepLine(ctx, p, layer, true);
      paintDiamonds(ctx, p, layer);
      break;
    case 'area':
      paintArea(ctx, p, layer, true);
      break;
    case 'areabr':
      paintArea(ctx, p, layer, false);
      break;
    case 'histogram':
      paintBars(ctx, p, layer, Math.max(1, layer.lineWidth));
      break;
    case 'columns':
      paintBars(ctx, p, layer, columnWidth(p.barSpacing));
      break;
    case 'circles':
    case 'cross':
      if (layer.join) strokePlotLine(ctx, p, layer, true, 1, 'solid');
      paintPoints(ctx, p, layer, layer.style === 'circles' ? 'circle' : 'cross');
      break;
  }
  if (layer.trackPrice) paintTrackPrice(ctx, p, layer);
  ctx.restore();
}

export function columnWidth(barSpacing: number): number {
  if (barSpacing <= 2) return Math.max(1, Math.round(barSpacing));
  return Math.max(1, Math.round(barSpacing * 0.8));
}

/**
 * Line through the plot's values. With `bridge`, consecutive values connect across na gaps; without,
 * only values on adjacent bars connect and isolated values become short dashes.
 */
export function strokePlotLine(
  ctx: Ctx,
  p: Projection,
  layer: PlotLayer,
  bridge: boolean,
  width: number,
  style: string,
): void {
  const { valid, values, start, colors } = layer;
  const s0 = p.from - start;
  const s1 = p.to - start;
  if (s1 < valid[0] - 1 || s0 > valid[valid.length - 1] + 1) return;
  const [k0, k1] = validWindow(valid, s0, s1);
  applyStroke(ctx, 'transparent', width, style);
  let current: string | null = null;
  let open = false;
  let px = 0;
  let py = 0;
  const flush = () => {
    if (open && current) {
      ctx.strokeStyle = current;
      ctx.stroke();
    }
    open = false;
  };
  for (let k = k0; k <= k1; k++) {
    const s = valid[k];
    const x = p.x(start + s);
    const y = p.y(values[s]);
    const connected = k > k0 && (bridge || s - valid[k - 1] === 1);
    if (connected) {
      const color = trackColor(colors, s);
      if (color !== current) {
        flush();
        current = color;
      }
      if (current) {
        if (!open) {
          ctx.beginPath();
          ctx.moveTo(px, py);
          open = true;
        }
        ctx.lineTo(x, y);
      }
    } else if (k > k0) {
      flush();
    }
    px = x;
    py = y;
  }
  flush();

  // Isolated points: a single value with no neighbour draws a dash centred on its bar.
  const n = valid.length;
  const half = Math.max(width / 2, p.barSpacing / 4, 1);
  for (let k = k0; k <= k1; k++) {
    const s = valid[k];
    const leftNeighbour = k > 0 && (bridge || valid[k - 1] === s - 1);
    const rightNeighbour = k < n - 1 && (bridge || valid[k + 1] === s + 1);
    if (leftNeighbour || rightNeighbour) continue;
    const color = trackColor(colors, s);
    if (!color) continue;
    const x = p.x(start + s);
    const y = p.y(values[s]);
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x - half, y);
    ctx.lineTo(x + half, y);
    ctx.stroke();
  }
}

/**
 * Step line: each bar is a horizontal segment spanning its bar width at its value (held across na
 * values when bridging), with vertical transitions on bar boundaries in the new bar's color.
 */
export function strokeStepLine(ctx: Ctx, p: Projection, layer: PlotLayer, bridge: boolean): void {
  const { valid, values, start, colors } = layer;
  const n = values.length;
  const firstValid = valid[0];
  const lastValid = valid[valid.length - 1];
  const sFrom = Math.max(bridge ? firstValid : 0, p.from - start);
  const sTo = Math.min(bridge ? lastValid : n - 1, p.to - start);
  if (sFrom > sTo) return;
  const half = p.barSpacing / 2;
  applyStroke(ctx, 'transparent', layer.lineWidth, layer.lineStyle);
  ctx.lineJoin = 'miter';

  // Value held into the first drawn slot, and whether the slot before it showed a color.
  let prev = NaN;
  let prevVisible = false;
  if (sFrom > 0) {
    const k = lowerBound(valid, sFrom) - 1;
    if (k >= 0 && (bridge || valid[k] === sFrom - 1)) {
      prev = values[valid[k]];
      prevVisible = trackColor(colors, sFrom - 1) !== null;
    }
  }
  let held = prev;
  let current: string | null = null;
  let open = false;
  const flush = () => {
    if (open && current) {
      ctx.strokeStyle = current;
      ctx.stroke();
    }
    open = false;
  };

  for (let s = sFrom; s <= sTo; s++) {
    const v = values[s];
    const hasValue = v === v;
    if (!hasValue && !bridge) {
      flush();
      prev = NaN;
      prevVisible = false;
      continue;
    }
    const cur = hasValue ? v : held;
    if (!(cur === cur)) continue;
    held = cur;
    const color = trackColor(colors, s);
    if (!color) {
      flush();
      prev = cur;
      prevVisible = false;
      continue;
    }
    const logical = start + s;
    const x = p.x(logical);
    const xL = x - half;
    const xR = logical >= p.lastLogical ? x : x + half;
    const y = p.y(cur);
    const vertical = prevVisible && prev === prev && prev !== cur;
    if (color !== current) {
      flush();
      current = color;
    }
    if (!open) {
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(xL, p.y(prev));
        ctx.lineTo(xL, y);
      } else {
        ctx.moveTo(xL, y);
      }
      open = true;
    } else if (vertical) {
      ctx.lineTo(xL, y);
    } else if (prev !== cur) {
      ctx.moveTo(xL, y);
    }
    ctx.lineTo(xR, y);
    prev = cur;
    prevVisible = true;
  }
  flush();
}

/** stepline_diamond: a diamond wherever the value changes. */
function paintDiamonds(ctx: Ctx, p: Projection, layer: PlotLayer): void {
  const { valid, values, start, colors } = layer;
  const [k0, k1] = validWindow(valid, p.from - start, p.to - start);
  const r = 2 + layer.lineWidth;
  ctx.setLineDash([]);
  for (let k = k0; k <= k1; k++) {
    const s = valid[k];
    if (k > 0 && values[valid[k - 1]] === values[s]) continue;
    const color = trackColor(colors, s);
    if (!color) continue;
    const x = p.x(start + s);
    const y = p.y(values[s]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
  }
}

/** Area between the values and histbase, filled and outlined in the plot color. */
export function paintArea(ctx: Ctx, p: Projection, layer: PlotLayer, bridge: boolean): void {
  const { valid, values, start, colors } = layer;
  const s0 = p.from - start;
  const s1 = p.to - start;
  if (s1 < valid[0] - 1 || s0 > valid[valid.length - 1] + 1) return;
  const [k0, k1] = validWindow(valid, s0, s1);
  const yBase = p.y(layer.histBase);
  const xs: number[] = [];
  const ys: number[] = [];
  let color: string | null = null;
  const flush = () => {
    if (color && xs.length >= 2) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(xs[0], yBase);
      for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.lineTo(xs[xs.length - 1], yBase);
      ctx.closePath();
      ctx.fill();
      applyStroke(ctx, color, layer.lineWidth, layer.lineStyle);
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.stroke();
    }
    xs.length = 0;
    ys.length = 0;
  };
  let px = 0;
  let py = 0;
  for (let k = k0; k <= k1; k++) {
    const s = valid[k];
    const x = p.x(start + s);
    const y = p.y(values[s]);
    const connected = k > k0 && (bridge || s - valid[k - 1] === 1);
    if (connected) {
      const c = trackColor(colors, s);
      if (c !== color || xs.length === 0) {
        flush();
        color = c;
        xs.push(px);
        ys.push(py);
      }
      xs.push(x);
      ys.push(y);
    } else {
      flush();
    }
    px = x;
    py = y;
  }
  flush();
}

/** Histogram (fixed px width) and columns (bar-spacing width), from histbase to the value. */
export function paintBars(ctx: Ctx, p: Projection, layer: PlotLayer, width: number): void {
  const { valid, values, start, colors } = layer;
  const k0 = lowerBound(valid, p.from - start);
  const k1 = lowerBound(valid, p.to - start + 1) - 1;
  const yBase = p.y(layer.histBase);
  let fill: string | null = null;
  for (let k = k0; k <= k1; k++) {
    const s = valid[k];
    const c = trackColor(colors, s);
    if (!c) continue;
    if (c !== fill) {
      ctx.fillStyle = c;
      fill = c;
    }
    const x = Math.round(p.x(start + s));
    const y = p.y(values[s]);
    const top = Math.min(y, yBase);
    const h = Math.max(1, Math.abs(y - yBase));
    ctx.fillRect(x - Math.floor(width / 2), top, width, h);
  }
}

/** circles / cross styles. */
function paintPoints(ctx: Ctx, p: Projection, layer: PlotLayer, kind: 'circle' | 'cross'): void {
  const { valid, values, start, colors } = layer;
  const k0 = lowerBound(valid, p.from - start);
  const k1 = lowerBound(valid, p.to - start + 1) - 1;
  const lw = layer.lineWidth;
  const r = 1 + lw * 0.9;
  const arm = 2 + lw;
  ctx.setLineDash([]);
  ctx.lineWidth = Math.max(1, lw / 3);
  let color: string | null = null;
  let open = false;
  const flush = () => {
    if (open && color) {
      if (kind === 'circle') {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }
    open = false;
  };
  for (let k = k0; k <= k1; k++) {
    const s = valid[k];
    const c = trackColor(colors, s);
    if (c !== color) {
      flush();
      color = c;
    }
    if (!c) continue;
    if (!open) {
      ctx.beginPath();
      open = true;
    }
    const x = p.x(start + s);
    const y = p.y(values[s]);
    if (kind === 'circle') {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
    }
  }
  flush();
}

function paintTrackPrice(ctx: Ctx, p: Projection, layer: PlotLayer): void {
  const last = layer.last;
  if (!last || !last.color) return;
  const y = Math.round(p.y(last.value)) + 0.5;
  if (!Number.isFinite(y)) return;
  ctx.strokeStyle = last.color;
  ctx.lineWidth = Math.min(2, layer.lineWidth);
  ctx.setLineDash([2, 2]);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(p.width, y);
  ctx.stroke();
}

// ── plotcandle / plotbar ─────────────────────────────────────────────────────────────────────────

export function paintCandles(ctx: Ctx, p: Projection, layer: CandleLayer): void {
  if (!layer.display.pane) return;
  const n = layer.close.length;
  const s0 = Math.max(0, p.from - layer.start);
  const s1 = Math.min(n - 1, p.to - layer.start);
  if (s0 > s1) return;
  let bodyW = Math.max(1, Math.floor(p.barSpacing * 0.8));
  if (bodyW > 2 && bodyW % 2 === 0) bodyW -= 1;
  const wickW = Math.max(1, Math.min(3, Math.floor(p.barSpacing / 10)));
  ctx.save();
  ctx.setLineDash([]);
  for (let s = s0; s <= s1; s++) {
    const c = layer.close[s];
    if (!(c === c)) continue;
    const body = trackColor(layer.colors, s);
    if (!body) continue;
    const wick = (layer.wickColors ? trackColor(layer.wickColors, s) : null) ?? body;
    const border = (layer.borderColors ? trackColor(layer.borderColors, s) : null) ?? body;
    const x = Math.round(p.x(layer.start + s));
    const yO = p.y(layer.open[s]);
    const yH = p.y(layer.high[s]);
    const yL = p.y(layer.low[s]);
    const yC = p.y(c);
    if (layer.style === 'candle') {
      ctx.fillStyle = wick;
      ctx.fillRect(x - Math.floor(wickW / 2), yH, wickW, Math.max(1, yL - yH));
      const top = Math.min(yO, yC);
      const h = Math.max(1, Math.abs(yC - yO));
      const left = x - Math.floor(bodyW / 2);
      ctx.fillStyle = body;
      ctx.fillRect(left, top, bodyW, h);
      if (border !== body && bodyW > 2) {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, top + 0.5, bodyW - 1, Math.max(0, h - 1));
      }
    } else {
      const lw = Math.max(1, Math.min(2, Math.floor(p.barSpacing / 6)));
      const tick = Math.max(1, Math.floor(bodyW / 2));
      ctx.fillStyle = body;
      ctx.fillRect(x - Math.floor(lw / 2), yH, lw, Math.max(1, yL - yH));
      ctx.fillRect(x - tick, yO - lw / 2, tick, lw);
      ctx.fillRect(x, yC - lw / 2, tick, lw);
    }
  }
  ctx.restore();
}

// ── bgcolor, hline ───────────────────────────────────────────────────────────────────────────────

/** Per-bar vertical bands; consecutive bars of one color merge into one rectangle (no seams). */
export function paintBackground(ctx: Ctx, p: Projection, layer: BackgroundLayer): void {
  const len = layer.colors.indexes ? layer.colors.indexes.length : 0;
  const s0 = Math.max(0, p.from - layer.start);
  const s1 = Math.min(len - 1, p.to - layer.start);
  if (s0 > s1) return;
  const half = p.barSpacing / 2;
  let runColor: string | null = null;
  let runStart = 0;
  const flush = (endX: number) => {
    if (runColor) {
      ctx.fillStyle = runColor;
      const x0 = Math.floor(runStart);
      ctx.fillRect(x0, 0, Math.ceil(endX) - x0, p.height);
    }
  };
  for (let s = s0; s <= s1; s++) {
    const c = trackColor(layer.colors, s);
    const x = p.x(layer.start + s);
    if (c !== runColor) {
      flush(x - half);
      runColor = c;
      runStart = x - half;
    }
  }
  flush(p.x(layer.start + s1) + half);
}

export function paintHline(ctx: Ctx, p: Projection, layer: HlineLayer): void {
  if (!layer.display.pane || !layer.color) return;
  const y = p.y(layer.price);
  if (!Number.isFinite(y)) return;
  const yy = layer.lineWidth % 2 === 1 ? Math.round(y) + 0.5 : Math.round(y);
  ctx.save();
  applyStroke(ctx, layer.color, layer.lineWidth, layer.lineStyle);
  ctx.beginPath();
  ctx.moveTo(0, yy);
  ctx.lineTo(p.width, yy);
  ctx.stroke();
  ctx.restore();
}

/** Highlight band behind one bar (the bar a log line, trace step or replay start points at). */
export function paintHighlight(ctx: Ctx, p: Projection, logical: number, color: string): void {
  const x = p.x(logical);
  const w = Math.max(2, p.barSpacing);
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, 0, w, p.height);
  ctx.restore();
}

// ── fill() ───────────────────────────────────────────────────────────────────────────────────────

function edgeValue(edge: FillEdge, logical: number): number {
  if (edge.kind === 'price') return edge.price;
  const l = edge.layer;
  const s = logical - l.start;
  return s >= 0 && s < l.values.length ? l.values[s] : NaN;
}

/** Plot value at a bar, bridging na gaps linearly between the surrounding values (fillgaps). */
function bridgedValue(edge: FillEdge, logical: number): number {
  if (edge.kind === 'price') return edge.price;
  const l = edge.layer;
  const s = logical - l.start;
  if (s >= 0 && s < l.values.length) {
    const v = l.values[s];
    if (v === v) return v;
  }
  const k = lowerBound(l.valid, s);
  if (k === 0 || k >= l.valid.length) return NaN;
  const a = l.valid[k - 1];
  const b = l.valid[k];
  const va = l.values[a];
  const vb = l.values[b];
  return va + ((vb - va) * (s - a)) / (b - a);
}

export function paintFill(ctx: Ctx, p: Projection, layer: FillLayer): void {
  if (!layer.display.pane) return;
  ctx.save();
  ctx.setLineDash([]);
  if (layer.kind === 'hlines') paintHlineFill(ctx, p, layer);
  else if (layer.kind === 'gradient') paintGradientFill(ctx, p, layer);
  else paintPlotFill(ctx, p, layer);
  ctx.restore();
}

function fillColorAt(layer: FillLayer, logical: number): string | null {
  if (logical < layer.visibleFrom) return null;
  return trackColor(layer.colors, logical - layer.colorStart);
}

function paintHlineFill(ctx: Ctx, p: Projection, layer: FillLayer): void {
  const y1 = p.y(edgeValue(layer.upper, 0));
  const y2 = p.y(edgeValue(layer.lower, 0));
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return;
  const top = Math.min(y1, y2);
  const h = Math.abs(y2 - y1);
  if (!layer.colors.indexes) {
    if (!layer.colors.uniform) return;
    ctx.fillStyle = layer.colors.uniform;
    ctx.fillRect(0, top, p.width, h);
    return;
  }
  // Per-bar colors: bands, merged into runs like bgcolor.
  const half = p.barSpacing / 2;
  let run: string | null = null;
  let runX = 0;
  const flush = (endX: number) => {
    if (run) {
      ctx.fillStyle = run;
      ctx.fillRect(Math.floor(runX), top, Math.ceil(endX) - Math.floor(runX), h);
    }
  };
  for (let l = p.from; l <= p.to; l++) {
    const c = fillColorAt(layer, l);
    const x = p.x(l);
    if (c !== run) {
      flush(x - half);
      run = c;
      runX = x - half;
    }
  }
  flush(p.x(p.to) + half);
}

/**
 * Fill between two plots: polygons over runs of bars where both plots have values (or across gaps
 * with fillgaps) and the fill color stays the same; a segment into bar i takes bar i's color.
 */
function paintPlotFill(ctx: Ctx, p: Projection, layer: FillLayer): void {
  const value = layer.fillGaps ? bridgedValue : edgeValue;
  const top: number[] = [];
  const bottom: number[] = [];
  const xs: number[] = [];
  let run: string | null = null;
  const flush = () => {
    if (run && xs.length >= 2) {
      ctx.fillStyle = run;
      ctx.beginPath();
      ctx.moveTo(xs[0], top[0]);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], top[i]);
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], bottom[i]);
      ctx.closePath();
      ctx.fill();
    }
    xs.length = 0;
    top.length = 0;
    bottom.length = 0;
  };
  let prevOk = false;
  let px = 0;
  let pa = 0;
  let pb = 0;
  for (let l = p.from; l <= p.to; l++) {
    const a = value(layer.upper, l);
    const b = value(layer.lower, l);
    const ok = a === a && b === b;
    const x = p.x(l);
    const ya = ok ? p.y(a) : 0;
    const yb = ok ? p.y(b) : 0;
    if (ok && prevOk) {
      const c = fillColorAt(layer, l);
      if (c !== run || xs.length === 0) {
        flush();
        run = c;
        xs.push(px);
        top.push(pa);
        bottom.push(pb);
      }
      xs.push(x);
      top.push(ya);
      bottom.push(yb);
    } else {
      flush();
    }
    prevOk = ok;
    px = x;
    pa = ya;
    pb = yb;
  }
  flush();
}

/** Gradient fill: each bar segment gets a vertical gradient from top_value/top_color to bottom_value/bottom_color. */
function paintGradientFill(ctx: Ctx, p: Projection, layer: FillLayer): void {
  const g = layer.gradient;
  if (!g) return;
  const value = layer.fillGaps ? bridgedValue : edgeValue;
  let prevOk = false;
  let px = 0;
  let pa = 0;
  let pb = 0;
  for (let l = p.from; l <= p.to; l++) {
    const a = value(layer.upper, l);
    const b = value(layer.lower, l);
    const ok = a === a && b === b;
    const x = p.x(l);
    const ya = ok ? p.y(a) : 0;
    const yb = ok ? p.y(b) : 0;
    const s = l - g.start;
    if (ok && prevOk && l >= layer.visibleFrom && s >= 0 && s < g.topValues.length) {
      const tv = g.topValues[s];
      const bv = g.bottomValues[s];
      const tc = trackColor(g.topColors, s);
      const bc = trackColor(g.bottomColors, s);
      if (tv === tv && bv === bv && (tc || bc)) {
        const ty = p.y(tv);
        const by = p.y(bv);
        let fill: string | CanvasGradient = tc ?? bc!;
        if (Math.abs(by - ty) >= 0.5) {
          const grad = ctx.createLinearGradient(0, ty, 0, by);
          grad.addColorStop(0, tc ?? 'rgba(0,0,0,0)');
          grad.addColorStop(1, bc ?? 'rgba(0,0,0,0)');
          fill = grad;
        }
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(px, pa);
        ctx.lineTo(x, ya);
        ctx.lineTo(x, yb);
        ctx.lineTo(px, pb);
        ctx.closePath();
        ctx.fill();
      }
    }
    prevOk = ok;
    px = x;
    pa = ya;
    pb = yb;
  }
}
