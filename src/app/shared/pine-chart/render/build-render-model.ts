import { buildColorTrack, cssColor, trackColor } from '../core/color';
import { parseDisplay } from '../core/display';
import { inferPricePrecision, resolveFormat } from '../core/format';
import { BlockMinMax } from '../core/range-minmax';
import { BarTimeline, timeframeMs, typicalStepMs } from '../core/timeline';
import type {
  PineBar,
  PineBoxOutput,
  PineCandleOutput,
  PineColorSeriesOutput,
  PineDeclaration,
  PineDrawingLineStyle,
  PineExtend,
  PineFillOutput,
  PineHAlign,
  PineHlineOutput,
  PineLabelOutput,
  PineLabelStyle,
  PineLineOutput,
  PineLineStyle,
  PineLocation,
  PineMarkerOutput,
  PineOutputX,
  PinePlotOutput,
  PinePlotStyle,
  PinePolylineOutput,
  PineScriptOutputs,
  PineShape,
  PineSize,
  PineStrategyReport,
  PineTableOutput,
  PineTablePosition,
  PineVAlign,
} from '../model/pine-outputs.types';
import type {
  BackgroundLayer,
  BoxDrawing,
  CandleLayer,
  FillEdge,
  FillLayer,
  HlineLayer,
  LabelDrawing,
  LineDrawing,
  MarkerLayer,
  PaneKey,
  PaneModel,
  PineRenderModel,
  PlotLayer,
  PolylineDrawing,
  PriceBars,
  TableCellLayout,
  TableLayout,
  TradeDrawing,
} from './render-model';

/** What the chart renders: the §3 run response, or an accumulated replay. */
export interface PineChartInput {
  bars: readonly PineBar[];
  outputs: PineScriptOutputs | null;
  report: PineStrategyReport | null;
  declaration: PineDeclaration | null;
}

export interface BuildOptions {
  /** Decimals of the symbol's price; inferred from the bars when omitted. */
  pricePrecision?: number | null;
  /** Draw strategy trades from the report (default true). */
  trades?: boolean;
}

/** Pine draws at most 500 bars into the future. */
export const MAX_FUTURE_SLOTS = 500;

export const FONT_DEFAULT =
  "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
export const FONT_MONOSPACE =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const PLOT_STYLES: readonly PinePlotStyle[] = [
  'line',
  'linebr',
  'stepline',
  'stepline_diamond',
  'steplinebr',
  'histogram',
  'cross',
  'area',
  'areabr',
  'columns',
  'circles',
];
const SHAPES: readonly PineShape[] = [
  'xcross',
  'cross',
  'circle',
  'triangleup',
  'triangledown',
  'flag',
  'arrowup',
  'arrowdown',
  'labelup',
  'labeldown',
  'square',
  'diamond',
];
const LOCATIONS: readonly PineLocation[] = ['abovebar', 'belowbar', 'top', 'bottom', 'absolute'];
const SIZES: readonly PineSize[] = ['auto', 'tiny', 'small', 'normal', 'large', 'huge'];
const LABEL_STYLES: readonly PineLabelStyle[] = [
  'none',
  'xcross',
  'cross',
  'triangleup',
  'triangledown',
  'flag',
  'circle',
  'arrowup',
  'arrowdown',
  'label_up',
  'label_down',
  'label_left',
  'label_right',
  'label_lower_left',
  'label_lower_right',
  'label_upper_left',
  'label_upper_right',
  'label_center',
  'square',
  'diamond',
  'text_outline',
];
const DRAWING_LINE_STYLES: readonly PineDrawingLineStyle[] = [
  'solid',
  'dotted',
  'dashed',
  'arrow_left',
  'arrow_right',
  'arrow_both',
];
const POSITIONS: readonly PineTablePosition[] = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
];

function oneOf<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  dflt: T,
): T {
  const v = (value ?? '').toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export interface BuildContext {
  timeline: BarTimeline;
  overlay: boolean;
  declaration: PineDeclaration | null;
  pricePrecision: number;
  /** Logical index of outputs.bars.times[0]. */
  outLogical0: number;
  /** bar_index of outputs.bars.times[0]. */
  outFirstIndex: number;
  /** bar_index of the chart's last bar (show_last counts back from it). */
  lastBarIndex: number;
  /** Largest logical index any output reaches. */
  maxLogical: number;
}

/**
 * Turns a run result into the render model. Pure and synchronous: O(bars × per-bar outputs).
 */
export function buildRenderModel(input: PineChartInput, opts: BuildOptions = {}): PineRenderModel {
  const bars = buildPriceBars(input.bars);
  const timeline = buildTimeline(bars.time, input.outputs);
  const pricePrecision =
    opts.pricePrecision !== null && opts.pricePrecision !== undefined && opts.pricePrecision >= 0
      ? Math.min(16, Math.round(opts.pricePrecision))
      : bars.close.length
        ? inferPricePrecision(bars.close)
        : 2;
  const declaration = input.declaration;
  const overlay = declaration?.overlay ?? true;
  const outputs = input.outputs;
  const outFirstIndex = outputs?.bars.firstIndex ?? timeline.firstBarIndex;

  const ctx: BuildContext = {
    timeline,
    overlay,
    declaration,
    pricePrecision,
    outLogical0: timeline.logicalOfBarIndex(outFirstIndex),
    outFirstIndex,
    lastBarIndex: timeline.lastBarIndex,
    maxLogical: timeline.length - 1,
  };

  const main = emptyPane('main');
  const script = emptyPane('script');
  const paneOf = (forceOverlay: boolean): PaneModel => (overlay || forceOverlay ? main : script);

  if (outputs) {
    const plotById = new Map<number, PlotLayer>();
    for (const p of outputs.plots) {
      const pane = paneOf(p.forceOverlay);
      const layer = buildPlot(p, pane.key, ctx);
      plotById.set(p.id, layer);
      pane.series.push(layer);
    }
    for (const c of outputs.candles) {
      const pane = paneOf(c.forceOverlay);
      pane.series.push(buildCandle(c, pane.key, ctx));
    }
    for (const m of outputs.markers) {
      const pane = paneOf(m.forceOverlay);
      pane.markers.push(buildMarker(m, pane.key, ctx));
    }
    for (const b of outputs.backgrounds) {
      const pane = paneOf(b.forceOverlay);
      const layer = buildBackground(b, pane.key, ctx);
      if (layer) pane.backgrounds.push(layer);
    }
    bars.colors = buildBarColors(outputs.barColors, bars.time.length, ctx);

    const hlineById = new Map<number, HlineLayer>();
    for (const h of outputs.hlines) {
      const pane = paneOf(false);
      const layer = buildHline(h, pane.key);
      if (!layer) continue;
      hlineById.set(h.id, layer);
      pane.hlines.push(layer);
    }
    for (const f of outputs.fills) {
      const layer = buildFill(f, plotById, hlineById, ctx);
      if (!layer) continue;
      (layer.pane === 'main' ? main : script).fills.push(layer);
    }

    const lineById = new Map<number, { line: LineDrawing; pane: PaneModel }>();
    for (const l of outputs.labels) {
      const d = buildLabel(l, ctx);
      if (d) paneOf(l.forceOverlay).drawings.labels.push(d);
    }
    for (const l of outputs.lines) {
      const d = buildLine(l, ctx);
      if (!d) continue;
      const pane = paneOf(l.forceOverlay);
      pane.drawings.lines.push(d);
      lineById.set(l.id, { line: d, pane });
    }
    for (const b of outputs.boxes) {
      const d = buildBox(b, ctx);
      if (d) paneOf(b.forceOverlay).drawings.boxes.push(d);
    }
    for (const p of outputs.polylines) {
      const d = buildPolyline(p, ctx);
      if (d) paneOf(p.forceOverlay).drawings.polylines.push(d);
    }
    for (const f of outputs.linefills) {
      const a = lineById.get(f.line1);
      const b = lineById.get(f.line2);
      if (!a || !b || a.pane !== b.pane) continue;
      a.pane.drawings.linefills.push({
        id: f.id,
        line1: a.line,
        line2: b.line,
        color: cssColor(f.color),
      });
    }
    for (const t of outputs.tables) {
      const layout = buildTableLayout(t, paneOf(t.forceOverlay).key);
      if (layout) (layout.pane === 'main' ? main : script).tables.push(layout);
    }
  }

  if (opts.trades !== false && input.report) {
    main.trades = buildTrades(input.report, timeline);
  }

  for (const pane of [main, script]) {
    pane.series.sort((a, b) => a.id - b.id);
    pane.markers.sort((a, b) => a.id - b.id);
    pane.drawings.labels.sort((a, b) => a.id - b.id);
    pane.drawings.lines.sort((a, b) => a.id - b.id);
    pane.drawings.boxes.sort((a, b) => a.id - b.id);
    pane.drawings.polylines.sort((a, b) => a.id - b.id);
    pane.drawings.linefills.sort((a, b) => a.id - b.id);
  }

  const futureSlots = Math.max(
    0,
    Math.min(MAX_FUTURE_SLOTS, Math.ceil(ctx.maxLogical - (timeline.length - 1))),
  );

  return {
    timeline,
    bars,
    futureSlots,
    pricePrecision,
    declaration,
    title: (declaration?.shortTitle || declaration?.title || '').trim() || 'Script',
    overlay,
    format: resolveFormat({}, declaration, pricePrecision),
    panes: { main, script: isPaneEmpty(script) ? null : script },
  };
}

export function emptyPane(key: PaneKey): PaneModel {
  return {
    key,
    backgrounds: [],
    fills: [],
    series: [],
    hlines: [],
    markers: [],
    drawings: { labels: [], lines: [], boxes: [], polylines: [], linefills: [] },
    tables: [],
    trades: [],
  };
}

function isPaneEmpty(p: PaneModel): boolean {
  return (
    p.backgrounds.length === 0 &&
    p.fills.length === 0 &&
    p.series.length === 0 &&
    p.hlines.length === 0 &&
    p.markers.length === 0 &&
    p.drawings.labels.length === 0 &&
    p.drawings.lines.length === 0 &&
    p.drawings.boxes.length === 0 &&
    p.drawings.polylines.length === 0 &&
    p.drawings.linefills.length === 0 &&
    p.tables.length === 0
  );
}

// ── bars and timeline ────────────────────────────────────────────────────────────────────────────

/**
 * Price bars as typed arrays. Bars that share an open time are kept — Renko, Kagi and Point & Figure
 * bricks do, and the outputs are aligned to them by position (the renderer spaces equal times apart
 * for the library). Only a payload that goes back in time is repaired: sorted, and exact duplicates
 * de-duplicated, rather than taking the chart down.
 */
export function buildPriceBars(input: readonly PineBar[]): PriceBars {
  let src = input;
  for (let i = 1; i < src.length; i++) {
    if (src[i].t < src[i - 1].t) {
      const byTime = new Map<number, PineBar>();
      for (const b of input) byTime.set(b.t, b);
      src = [...byTime.values()].sort((a, b) => a.t - b.t);
      break;
    }
  }
  const n = src.length;
  const out: PriceBars = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    colors: null,
  };
  for (let i = 0; i < n; i++) {
    const b = src[i];
    const c = b.c;
    const o = finite(b.o) ? b.o : c;
    const h = finite(b.h) ? b.h : Math.max(o, c);
    const l = finite(b.l) ? b.l : Math.min(o, c);
    out.time[i] = b.t;
    out.open[i] = o;
    out.high[i] = Math.max(h, o, c);
    out.low[i] = Math.min(l, o, c);
    out.close[i] = c;
    out.volume[i] = finite(b.v) ? b.v : 0;
  }
  return out;
}

/**
 * The chart timeline. The chart's first bar gets its bar_index by locating the outputs' first bar
 * time among the chart bars — the run's `bars` and `outputs.bars` normally cover the same window,
 * but nothing requires it.
 */
export function buildTimeline(times: Float64Array, outputs: PineScriptOutputs | null): BarTimeline {
  const outTimes = outputs?.bars.times ?? [];
  const src = times.length ? times : Float64Array.from(outTimes);
  const step = timeframeMs(outputs?.bars.timeframe) ?? typicalStepMs(src) ?? 60_000;
  let firstBarIndex = outputs?.bars.firstIndex ?? 0;
  if (outputs && outTimes.length && src.length) {
    const probe = new BarTimeline(src, 0, step);
    const k = probe.indexOfTime(outTimes[0]);
    if (k >= 0) {
      firstBarIndex = outputs.bars.firstIndex - k;
    } else {
      // No shared bar: align the two windows on their last bars.
      firstBarIndex = outputs.bars.firstIndex + outTimes.length - src.length;
    }
  }
  return new BarTimeline(src, firstBarIndex, step);
}

// ── plot-type outputs ────────────────────────────────────────────────────────────────────────────

/** Source index from which show_last keeps values (everything when not set). */
function showFromSource(showLast: number | null | undefined, ctx: BuildContext): number {
  if (!finite(showLast) || showLast < 0) return -Infinity;
  const firstShownBar = ctx.lastBarIndex - Math.floor(showLast) + 1;
  return firstShownBar - ctx.outFirstIndex;
}

/**
 * Slot window of a per-bar output after its offset: slot 0 is the first slot at logical >= 0 (points
 * shifted before the chart's first bar cannot be shown).
 */
function slotWindow(length: number, offset: number, ctx: BuildContext) {
  const rawStart = ctx.outLogical0 + Math.trunc(offset || 0);
  const skip = Math.max(0, -rawStart);
  return { start: rawStart + skip, skip, len: Math.max(0, length - skip) };
}

export function buildPlot(p: PinePlotOutput, pane: PaneKey, ctx: BuildContext): PlotLayer {
  const style = oneOf(p.style, PLOT_STYLES, 'line');
  const { start, skip, len } = slotWindow(p.values.length, p.offset, ctx);
  const showFrom = showFromSource(p.showLast, ctx);
  const values = new Float64Array(len).fill(NaN);
  let validCount = 0;
  for (let s = 0; s < len; s++) {
    const i = s + skip;
    if (i < showFrom) continue;
    const v = p.values[i];
    if (finite(v)) {
      values[s] = v;
      validCount++;
    }
  }
  const valid = new Int32Array(validCount);
  for (let s = 0, k = 0; s < len; s++) if (values[s] === values[s]) valid[k++] = s;
  const colors = buildColorTrack(p.color, p.colors, len, -skip, (i) => i >= showFrom);
  const lastSlot = validCount ? valid[validCount - 1] : -1;
  if (lastSlot >= 0) ctx.maxLogical = Math.max(ctx.maxLogical, start + lastSlot);
  return {
    type: 'plot',
    id: p.id,
    key: `plot:${p.id}`,
    title: p.title?.trim() || `Plot ${p.plotNumber}`,
    pane,
    display: parseDisplay(p.display),
    style,
    lineStyle: oneOf<PineLineStyle>(p.lineStyle, ['solid', 'dashed', 'dotted'], 'solid'),
    lineWidth: Math.max(1, Math.round(p.lineWidth || 1)),
    trackPrice: !!p.trackPrice,
    histBase: finite(p.histBase) ? p.histBase : 0,
    join: !!p.join,
    start,
    values,
    colors,
    valid,
    format: resolveFormat(p, ctx.declaration, ctx.pricePrecision),
    scale: new BlockMinMax(values),
    includeBaseInScale: style === 'area' || style === 'columns' || style === 'histogram',
    last:
      lastSlot >= 0
        ? { slot: lastSlot, value: values[lastSlot], color: trackColor(colors, lastSlot) }
        : null,
  };
}

export function buildCandle(c: PineCandleOutput, pane: PaneKey, ctx: BuildContext): CandleLayer {
  const n = Math.min(c.open.length, c.high.length, c.low.length, c.close.length);
  const { start, skip, len } = slotWindow(n, c.offset, ctx);
  const showFrom = showFromSource(c.showLast, ctx);
  const open = new Float64Array(len).fill(NaN);
  const high = new Float64Array(len).fill(NaN);
  const low = new Float64Array(len).fill(NaN);
  const close = new Float64Array(len).fill(NaN);
  let lastSlot = -1;
  for (let s = 0; s < len; s++) {
    const i = s + skip;
    if (i < showFrom) continue;
    const o = c.open[i];
    const h = c.high[i];
    const l = c.low[i];
    const cl = c.close[i];
    if (!finite(o) || !finite(h) || !finite(l) || !finite(cl)) continue;
    open[s] = o;
    high[s] = Math.max(o, h, l, cl);
    low[s] = Math.min(o, h, l, cl);
    close[s] = cl;
    lastSlot = s;
  }
  if (lastSlot >= 0) ctx.maxLogical = Math.max(ctx.maxLogical, start + lastSlot);
  const keep = (i: number) => i >= showFrom;
  return {
    type: 'candle',
    id: c.id,
    key: `candle:${c.id}`,
    title: c.title?.trim() || `Plot ${c.plotNumber}`,
    pane,
    display: parseDisplay(c.display),
    style: (c.kind ?? '').toLowerCase() === 'bar' ? 'bar' : 'candle',
    start,
    open,
    high,
    low,
    close,
    colors: buildColorTrack(c.color, c.colors, len, -skip, keep),
    wickColors: c.wickColors ? buildColorTrack(null, c.wickColors, len, -skip, keep) : null,
    borderColors: c.borderColors ? buildColorTrack(null, c.borderColors, len, -skip, keep) : null,
    format: resolveFormat(c, ctx.declaration, ctx.pricePrecision),
    scale: new BlockMinMax(low, high),
  };
}

export function buildMarker(m: PineMarkerOutput, pane: PaneKey, ctx: BuildContext): MarkerLayer {
  const kind = oneOf<'shape' | 'char' | 'arrow'>(m.kind, ['shape', 'char', 'arrow'], 'shape');
  const showFromBar =
    finite(m.showLast) && m.showLast >= 0
      ? ctx.lastBarIndex - Math.floor(m.showLast) + 1
      : -Infinity;
  const offset = Math.trunc(m.offset || 0);
  const kept = m.points
    .filter((p) => p.barIndex >= showFromBar)
    .map((p) => ({ p, logical: ctx.timeline.logicalOfBarIndex(p.barIndex) + offset }))
    .filter((x) => x.logical >= 0)
    .sort((a, b) => a.logical - b.logical);
  const n = kept.length;
  const logicals = new Float64Array(n);
  const values = new Float64Array(n);
  const colors: (string | null)[] = new Array(n);
  const textColors: (string | null)[] = new Array(n);
  const up = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const { p, logical } = kept[i];
    logicals[i] = logical;
    const v = finite(p.value) ? p.value : NaN;
    values[i] = v;
    colors[i] = cssColor(p.color);
    textColors[i] = cssColor(p.textColor);
    up[i] = p.direction === 'up' || (p.direction !== 'down' && v > 0) ? 1 : 0;
  }
  if (n) ctx.maxLogical = Math.max(ctx.maxLogical, logicals[n - 1]);
  // plotchar's default is ★; an explicit "" draws nothing (the "value in the data window only" idiom).
  const dfltChar = '★';
  return {
    type: 'marker',
    id: m.id,
    key: `marker:${m.id}`,
    title: m.title?.trim() || `Plot ${m.plotNumber}`,
    pane,
    display: parseDisplay(m.display),
    kind,
    shape: oneOf(m.shape, SHAPES, 'xcross'),
    char: m.char ?? dfltChar,
    location: oneOf(m.location, LOCATIONS, 'abovebar'),
    size: oneOf(m.size, SIZES, 'auto'),
    text: m.text ?? '',
    minHeight: finite(m.minHeight) ? Math.max(1, m.minHeight) : 5,
    maxHeight: finite(m.maxHeight) ? Math.max(1, m.maxHeight) : 100,
    format: resolveFormat(m, ctx.declaration, ctx.pricePrecision),
    logicals,
    values,
    colors,
    textColors,
    up,
  };
}

export function buildBackground(
  b: PineColorSeriesOutput,
  pane: PaneKey,
  ctx: BuildContext,
): BackgroundLayer | null {
  const display = parseDisplay(b.display);
  if (!display.pane) return null;
  const { start, skip, len } = slotWindow(b.colors.length, b.offset, ctx);
  const showFrom = showFromSource(b.showLast, ctx);
  const colors = buildColorTrack(null, b.colors, len, -skip, (i) => i >= showFrom);
  if (colors.indexes) {
    for (let s = colors.indexes.length - 1; s >= 0; s--) {
      if (colors.indexes[s] !== 0) {
        ctx.maxLogical = Math.max(ctx.maxLogical, start + s);
        break;
      }
    }
  }
  return {
    type: 'background',
    id: b.id,
    key: `bgcolor:${b.id}`,
    title: b.title?.trim() || 'Background',
    pane,
    display,
    start,
    colors,
  };
}

/** barcolor(): the last output with a color on a bar wins, as later barcolor() calls do in Pine. */
export function buildBarColors(
  outputs: readonly PineColorSeriesOutput[],
  barCount: number,
  ctx: BuildContext,
): (string | null)[] | null {
  const active = outputs.filter((o) => parseDisplay(o.display).pane);
  if (active.length === 0 || barCount === 0) return null;
  const colors: (string | null)[] = new Array(barCount).fill(null);
  let any = false;
  for (const o of [...active].sort((a, b) => a.id - b.id)) {
    const showFrom = showFromSource(o.showLast, ctx);
    const shift = ctx.outLogical0 + Math.trunc(o.offset || 0);
    for (let i = 0; i < o.colors.length; i++) {
      if (i < showFrom) continue;
      const logical = i + shift;
      if (logical < 0 || logical >= barCount) continue;
      const c = cssColor(o.colors[i]);
      if (c === null) continue;
      colors[logical] = c;
      any = true;
    }
  }
  return any ? colors : null;
}

export function buildHline(h: PineHlineOutput, pane: PaneKey): HlineLayer | null {
  if (!finite(h.price)) return null;
  return {
    type: 'hline',
    id: h.id,
    key: `hline:${h.id}`,
    title: h.title?.trim() || `Level ${h.price}`,
    pane,
    display: parseDisplay(h.display),
    price: h.price,
    color: cssColor(h.color),
    lineStyle: oneOf<PineLineStyle>(h.lineStyle, ['solid', 'dashed', 'dotted'], 'dashed'),
    lineWidth: Math.max(1, Math.round(h.lineWidth || 1)),
  };
}

export function buildFill(
  f: PineFillOutput,
  plots: ReadonlyMap<number, PlotLayer>,
  hlines: ReadonlyMap<number, HlineLayer>,
  ctx: BuildContext,
): FillLayer | null {
  const display = parseDisplay(f.display);
  const kind = oneOf<'plots' | 'hlines' | 'gradient'>(
    f.kind,
    ['plots', 'hlines', 'gradient'],
    'plots',
  );
  let upper: FillEdge;
  let lower: FillEdge;
  let pane: PaneKey;
  if (kind === 'hlines') {
    const a = hlines.get(f.from);
    const b = hlines.get(f.to);
    if (!a || !b) return null;
    upper = { kind: 'price', price: a.price };
    lower = { kind: 'price', price: b.price };
    pane = a.pane;
  } else {
    const a = plots.get(f.from);
    const b = plots.get(f.to);
    if (!a || !b) return null;
    upper = { kind: 'plot', layer: a };
    lower = { kind: 'plot', layer: b };
    pane = a.pane;
  }
  const colorLen = f.colors?.length ?? 0;
  const showFrom = showFromSource(f.showLast, ctx);
  const keep = (i: number) => i >= showFrom;
  let gradient: FillLayer['gradient'] = null;
  if (kind === 'gradient') {
    const len = Math.max(f.topValues?.length ?? 0, f.bottomValues?.length ?? 0);
    const topValues = new Float64Array(len).fill(NaN);
    const bottomValues = new Float64Array(len).fill(NaN);
    for (let i = 0; i < len; i++) {
      if (i < showFrom) continue;
      const t = f.topValues?.[i];
      const b = f.bottomValues?.[i];
      if (finite(t)) topValues[i] = t;
      if (finite(b)) bottomValues[i] = b;
    }
    gradient = {
      start: ctx.outLogical0,
      topValues,
      bottomValues,
      topColors: buildColorTrack(null, f.topColors ?? [], len, 0, keep),
      bottomColors: buildColorTrack(null, f.bottomColors ?? [], len, 0, keep),
    };
  }
  return {
    type: 'fill',
    id: f.id,
    key: `fill:${f.id}`,
    title: f.title?.trim() || 'Fill',
    pane,
    display,
    kind,
    fillGaps: !!f.fillGaps,
    upper,
    lower,
    colorStart: ctx.outLogical0,
    colors:
      kind === 'gradient'
        ? { uniform: null, indexes: null, palette: [''] }
        : buildColorTrack(f.color, f.colors, colorLen, 0, keep),
    gradient,
    visibleFrom: showFrom === -Infinity ? -Infinity : ctx.outLogical0 + showFrom,
  };
}

// ── drawings ─────────────────────────────────────────────────────────────────────────────────────

/** Logical x of a drawing coordinate per its xloc; null when na. */
export function drawingX(x: PineOutputX, xloc: string, timeline: BarTimeline): number | null {
  if (xloc === 'bar_time') {
    const t = finite(x.time) ? x.time : finite(x.value) ? x.value : null;
    if (t !== null) {
      const l = timeline.logicalOfTime(t);
      if (Number.isFinite(l)) return l;
    }
    return finite(x.barIndex) ? timeline.logicalOfBarIndex(x.barIndex) : null;
  }
  const bi = finite(x.barIndex) ? x.barIndex : finite(x.value) ? Math.trunc(x.value) : null;
  return bi === null ? null : timeline.logicalOfBarIndex(bi);
}

export function fontFamilyCss(family: string | null | undefined): string {
  return (family ?? '').toLowerCase() === 'monospace' ? FONT_MONOSPACE : FONT_DEFAULT;
}

function noteX(ctx: BuildContext, ...xs: number[]): void {
  for (const x of xs)
    if (Number.isFinite(x))
      ctx.maxLogical = Math.max(
        ctx.maxLogical,
        Math.min(x, ctx.timeline.length - 1 + MAX_FUTURE_SLOTS),
      );
}

export function buildLabel(l: PineLabelOutput, ctx: BuildContext): LabelDrawing | null {
  const x = drawingX(l.x, l.xloc, ctx.timeline);
  if (x === null) return null;
  const yloc = oneOf<'price' | 'abovebar' | 'belowbar'>(
    l.yloc,
    ['price', 'abovebar', 'belowbar'],
    'price',
  );
  if (yloc === 'price' && !finite(l.y)) return null;
  noteX(ctx, x);
  return {
    id: l.id,
    x,
    y: finite(l.y) ? l.y : null,
    yloc,
    text: l.text ?? '',
    color: cssColor(l.color),
    style: oneOf(l.style, LABEL_STYLES, 'label_down'),
    textColor: cssColor(l.textColor),
    fontSize: l.sizePoints > 0 ? l.sizePoints : labelSizePx(l.size),
    textAlign: oneOf<PineHAlign>(l.textAlign, ['left', 'center', 'right'], 'center'),
    tooltip: l.tooltip && l.tooltip.length ? l.tooltip : null,
    fontFamily: fontFamilyCss(l.fontFamily),
    bold: !!l.bold,
    italic: !!l.italic,
  };
}

/** Label text px for a size.* name (labels: tiny 7 … huge 24; auto reads as normal). */
export function labelSizePx(size: string | null | undefined): number {
  switch ((size ?? '').toLowerCase()) {
    case 'tiny':
      return 7;
    case 'small':
      return 10;
    case 'large':
      return 18;
    case 'huge':
      return 24;
    default:
      return 12;
  }
}

/** Box/table text px for a size.* name (tiny 8 … huge 36); 0 for auto. */
export function boxSizePx(size: string | null | undefined): number {
  switch ((size ?? '').toLowerCase()) {
    case 'tiny':
      return 8;
    case 'small':
      return 10;
    case 'normal':
      return 14;
    case 'large':
      return 20;
    case 'huge':
      return 36;
    default:
      return 0;
  }
}

export function buildLine(l: PineLineOutput, ctx: BuildContext): LineDrawing | null {
  const x1 = drawingX(l.x1, l.xloc, ctx.timeline);
  const x2 = drawingX(l.x2, l.xloc, ctx.timeline);
  if (x1 === null || x2 === null || !finite(l.y1) || !finite(l.y2)) return null;
  noteX(ctx, x1, x2);
  return {
    id: l.id,
    x1,
    y1: l.y1,
    x2,
    y2: l.y2,
    extend: oneOf<PineExtend>(l.extend, ['none', 'left', 'right', 'both'], 'none'),
    color: cssColor(l.color),
    style: oneOf(l.style, DRAWING_LINE_STYLES, 'solid'),
    width: Math.max(1, Math.round(l.width || 1)),
  };
}

export function buildBox(b: PineBoxOutput, ctx: BuildContext): BoxDrawing | null {
  const left = drawingX(b.left, b.xloc, ctx.timeline);
  const right = drawingX(b.right, b.xloc, ctx.timeline);
  if (left === null || right === null || !finite(b.top) || !finite(b.bottom)) return null;
  noteX(ctx, left, right);
  return {
    id: b.id,
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.max(b.top, b.bottom),
    bottom: Math.min(b.top, b.bottom),
    borderColor: cssColor(b.borderColor),
    borderWidth: Math.max(0, Math.round(b.borderWidth ?? 1)),
    borderStyle: oneOf(b.borderStyle, DRAWING_LINE_STYLES, 'solid'),
    extend: oneOf<PineExtend>(b.extend, ['none', 'left', 'right', 'both'], 'none'),
    bgColor: cssColor(b.bgColor),
    text: b.text ?? '',
    fontSize: b.textSizePoints > 0 ? b.textSizePoints : boxSizePx(b.textSize),
    textColor: cssColor(b.textColor),
    hAlign: oneOf<PineHAlign>(b.textHAlign, ['left', 'center', 'right'], 'center'),
    vAlign: oneOf<PineVAlign>(b.textVAlign, ['top', 'center', 'bottom'], 'center'),
    wrap: (b.textWrap ?? '').toLowerCase() === 'auto',
    fontFamily: fontFamilyCss(b.fontFamily),
    bold: !!b.bold,
    italic: !!b.italic,
  };
}

export function buildPolyline(p: PinePolylineOutput, ctx: BuildContext): PolylineDrawing | null {
  const byTime = p.xloc === 'bar_time';
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pt of p.points) {
    if (!finite(pt.price)) continue;
    let x: number | null = null;
    if (byTime && finite(pt.time)) x = ctx.timeline.logicalOfTime(pt.time);
    else if (finite(pt.barIndex)) x = ctx.timeline.logicalOfBarIndex(pt.barIndex);
    else if (finite(pt.time)) x = ctx.timeline.logicalOfTime(pt.time);
    if (x === null || !Number.isFinite(x)) continue;
    xs.push(x);
    ys.push(pt.price);
  }
  if (xs.length < 2) return null;
  noteX(ctx, ...xs);
  return {
    id: p.id,
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    curved: !!p.curved,
    closed: !!p.closed,
    lineColor: cssColor(p.lineColor),
    fillColor: cssColor(p.fillColor),
    lineStyle: oneOf(p.lineStyle, DRAWING_LINE_STYLES, 'solid'),
    lineWidth: Math.max(1, Math.round(p.lineWidth || 1)),
  };
}

// ── tables ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Table grid for the HTML overlay. Cells outside the declared grid are dropped, spans are clamped to
 * it, and a cell a merge covers is dropped even if the payload repeats it — the merge's top-left cell
 * owns the area, exactly as `table.merge_cells()` behaves.
 */
export function buildTableLayout(t: PineTableOutput, pane: PaneKey): TableLayout | null {
  const columns = Math.max(0, Math.floor(t.columns));
  const rows = Math.max(0, Math.floor(t.rows));
  if (columns === 0 || rows === 0) return null;
  const covered = new Uint8Array(columns * rows);
  const cells: TableCellLayout[] = [];
  const sorted = [...t.cells].sort((a, b) => a.row - b.row || a.column - b.column);
  for (const c of sorted) {
    const col = Math.floor(c.column);
    const row = Math.floor(c.row);
    if (col < 0 || row < 0 || col >= columns || row >= rows) continue;
    if (covered[row * columns + col]) continue;
    const colSpan = Math.max(1, Math.min(Math.floor(c.columnSpan || 1), columns - col));
    const rowSpan = Math.max(1, Math.min(Math.floor(c.rowSpan || 1), rows - row));
    for (let r = row; r < row + rowSpan; r++)
      for (let k = col; k < col + colSpan; k++) covered[r * columns + k] = 1;
    const size = c.textSizePoints > 0 ? c.textSizePoints : boxSizePx(c.textSize) || 12;
    cells.push({
      key: `${t.id}:${row}:${col}`,
      row,
      column: col,
      rowSpan,
      columnSpan: colSpan,
      text: c.text ?? '',
      bgColor: cssColor(c.bgColor),
      textColor: cssColor(c.textColor) ?? 'transparent',
      fontSize: size,
      fontFamily: fontFamilyCss(c.fontFamily),
      bold: !!c.bold,
      italic: !!c.italic,
      hAlign: oneOf<PineHAlign>(c.textHAlign, ['left', 'center', 'right'], 'center'),
      vAlign: oneOf<PineVAlign>(c.textVAlign, ['top', 'center', 'bottom'], 'center'),
      widthPct: Math.max(0, Math.min(100, c.width || 0)),
      heightPct: Math.max(0, Math.min(100, c.height || 0)),
      tooltip: c.tooltip && c.tooltip.length ? c.tooltip : null,
    });
  }
  return {
    id: t.id,
    pane,
    position: oneOf(t.position, POSITIONS, 'top_right'),
    columns,
    rows,
    bgColor: cssColor(t.bgColor),
    frameColor: cssColor(t.frameColor),
    frameWidth: Math.max(0, Math.round(t.frameWidth || 0)),
    borderColor: cssColor(t.borderColor),
    borderWidth: Math.max(0, Math.round(t.borderWidth || 0)),
    cells,
  };
}

// ── strategy trades ──────────────────────────────────────────────────────────────────────────────

export const TRADE_COLORS = {
  longEntry: '#2962FF',
  shortEntry: '#F23645',
  exit: '#9C27B0',
  profit: '#089981',
  loss: '#F23645',
  even: '#787B86',
} as const;

export function buildTrades(report: PineStrategyReport, timeline: BarTimeline): TradeDrawing[] {
  const at = (
    barIndex: number | null | undefined,
    time: number | null | undefined,
  ): number | null => {
    if (finite(barIndex)) return timeline.logicalOfBarIndex(barIndex);
    if (finite(time)) {
      const l = timeline.logicalOfTime(time);
      return Number.isFinite(l) ? l : null;
    }
    return null;
  };
  const out: TradeDrawing[] = [];
  for (const t of report.trades) {
    const entryX = at(t.entryBarIndex, t.entryTime);
    if (entryX === null || !finite(t.entryPrice)) continue;
    const exitX = t.isOpen ? null : at(t.exitBarIndex, t.exitTime);
    const exitPrice = !t.isOpen && finite(t.exitPrice) ? t.exitPrice : null;
    const profit = finite(t.profit) ? t.profit : 0;
    out.push({
      number: t.number,
      direction: (t.direction ?? '').toLowerCase() === 'short' ? 'short' : 'long',
      isOpen: !!t.isOpen || exitX === null || exitPrice === null,
      entryX,
      entryPrice: t.entryPrice,
      entrySignal: t.entrySignal || t.entryId || '',
      exitX: exitPrice === null ? null : exitX,
      exitPrice,
      exitSignal: t.exitSignal ?? t.exitId ?? null,
      qty: finite(t.qty) ? t.qty : 0,
      profit,
      profitPercent: finite(t.profitPercent) ? t.profitPercent : null,
      lineColor:
        profit > 0 ? TRADE_COLORS.profit : profit < 0 ? TRADE_COLORS.loss : TRADE_COLORS.even,
    });
  }
  return out.sort((a, b) => a.entryX - b.entryX || a.number - b.number);
}
