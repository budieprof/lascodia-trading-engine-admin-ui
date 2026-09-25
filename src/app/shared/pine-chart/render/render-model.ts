import type { ColorTrack } from '../core/color';
import type { DisplayFlags } from '../core/display';
import type { ValueFormat } from '../core/format';
import type { BlockMinMax } from '../core/range-minmax';
import type { BarTimeline } from '../core/timeline';
import type {
  PineDeclaration,
  PineDrawingLineStyle,
  PineExtend,
  PineHAlign,
  PineLabelStyle,
  PineLineStyle,
  PineLocation,
  PinePlotStyle,
  PineShape,
  PineSize,
  PineTablePosition,
  PineVAlign,
} from '../model/pine-outputs.types';

/**
 * The render model: what `buildRenderModel()` makes of a run result, and all the canvas layer draws.
 *
 * Everything is positioned by LOGICAL index (0 = the chart's first bar) and price, with offsets,
 * `show_last`, display flags, pane assignment and color parsing already applied — so the canvas code
 * only projects and paints, and every rule about what Pine shows where is testable without a canvas.
 * Per-bar data lives in typed arrays addressed by slot (`logical - start`).
 */

/** The main (price) pane, or the script's own pane for a non-overlay script. */
export type PaneKey = 'main' | 'script';

export interface PriceBars {
  /** Open times, Unix ms. */
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  /** barcolor() per bar as CSS (null = default up/down coloring), or null when no barcolor output. */
  colors: (string | null)[] | null;
}

interface LayerBase {
  /** Output id (plot-type outputs share one id space, which is their declaration order). */
  id: number;
  /** Stable key for legends and data windows, e.g. `plot:3`. */
  key: string;
  title: string;
  pane: PaneKey;
  display: DisplayFlags;
}

/** A plot(). */
export interface PlotLayer extends LayerBase {
  type: 'plot';
  style: PinePlotStyle;
  lineStyle: PineLineStyle;
  lineWidth: number;
  trackPrice: boolean;
  histBase: number;
  join: boolean;
  /** Logical index of slot 0. */
  start: number;
  /** NaN = na (or hidden by show_last). */
  values: Float64Array;
  colors: ColorTrack;
  /** Slots holding a value, ascending — lines bridge between them, bars iterate them. */
  valid: Int32Array;
  format: ValueFormat;
  /** Autoscale range source over `values`. */
  scale: BlockMinMax;
  /** histbase counts toward the pane's scale (area, columns, histogram). */
  includeBaseInScale: boolean;
  /** Last plotted value (trackprice, price-scale label). */
  last: { slot: number; value: number; color: string | null } | null;
}

/** A plotshape / plotchar / plotarrow. Points are sorted by logical index. */
export interface MarkerLayer extends LayerBase {
  type: 'marker';
  kind: 'shape' | 'char' | 'arrow';
  shape: PineShape;
  char: string;
  location: PineLocation;
  size: PineSize;
  text: string;
  minHeight: number;
  maxHeight: number;
  format: ValueFormat;
  logicals: Float64Array;
  values: Float64Array;
  colors: (string | null)[];
  textColors: (string | null)[];
  /** Arrows: 1 = up. */
  up: Uint8Array;
}

/** A plotcandle / plotbar. */
export interface CandleLayer extends LayerBase {
  type: 'candle';
  style: 'candle' | 'bar';
  start: number;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  colors: ColorTrack;
  /** null = same as the body color. */
  wickColors: ColorTrack | null;
  borderColors: ColorTrack | null;
  format: ValueFormat;
  scale: BlockMinMax;
}

/** bgcolor(). */
export interface BackgroundLayer extends LayerBase {
  type: 'background';
  start: number;
  colors: ColorTrack;
}

/** hline(). */
export interface HlineLayer extends LayerBase {
  type: 'hline';
  price: number;
  color: string | null;
  lineStyle: PineLineStyle;
  lineWidth: number;
}

export type FillEdge = { kind: 'plot'; layer: PlotLayer } | { kind: 'price'; price: number };

/** fill() between plots, hlines, or a gradient between plots. */
export interface FillLayer extends LayerBase {
  type: 'fill';
  kind: 'plots' | 'hlines' | 'gradient';
  fillGaps: boolean;
  upper: FillEdge;
  lower: FillEdge;
  /** Logical index of `colors` slot 0 (no offset: fills color by bar). */
  colorStart: number;
  colors: ColorTrack;
  gradient: {
    start: number;
    topValues: Float64Array;
    bottomValues: Float64Array;
    topColors: ColorTrack;
    bottomColors: ColorTrack;
  } | null;
  /** First logical index the fill shows at (show_last), -Infinity when unrestricted. */
  visibleFrom: number;
}

export type SeriesLayer = PlotLayer | CandleLayer;

export interface LabelDrawing {
  id: number;
  /** Logical index (fractional for xloc.bar_time between bars). */
  x: number;
  /** Price for yloc.price; ignored for abovebar/belowbar. */
  y: number | null;
  yloc: 'price' | 'abovebar' | 'belowbar';
  text: string;
  color: string | null;
  style: PineLabelStyle;
  textColor: string | null;
  fontSize: number;
  textAlign: PineHAlign;
  tooltip: string | null;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
}

export interface LineDrawing {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  extend: PineExtend;
  color: string | null;
  style: PineDrawingLineStyle;
  width: number;
}

export interface BoxDrawing {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  borderColor: string | null;
  borderWidth: number;
  borderStyle: PineDrawingLineStyle;
  extend: PineExtend;
  bgColor: string | null;
  text: string;
  /** px; 0 = auto (fit the box). */
  fontSize: number;
  textColor: string | null;
  hAlign: PineHAlign;
  vAlign: PineVAlign;
  wrap: boolean;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
}

export interface PolylineDrawing {
  id: number;
  xs: Float64Array;
  ys: Float64Array;
  curved: boolean;
  closed: boolean;
  lineColor: string | null;
  fillColor: string | null;
  lineStyle: PineDrawingLineStyle;
  lineWidth: number;
}

export interface LinefillDrawing {
  id: number;
  line1: LineDrawing;
  line2: LineDrawing;
  color: string | null;
}

export interface DrawingSet {
  labels: LabelDrawing[];
  lines: LineDrawing[];
  boxes: BoxDrawing[];
  polylines: PolylineDrawing[];
  linefills: LinefillDrawing[];
}

export interface TableCellLayout {
  key: string;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
  bgColor: string | null;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  hAlign: PineHAlign;
  vAlign: PineVAlign;
  /** % of the pane width/height; 0 = automatic. */
  widthPct: number;
  heightPct: number;
  tooltip: string | null;
}

export interface TableLayout {
  id: number;
  pane: PaneKey;
  position: PineTablePosition;
  columns: number;
  rows: number;
  bgColor: string | null;
  frameColor: string | null;
  frameWidth: number;
  borderColor: string | null;
  borderWidth: number;
  cells: TableCellLayout[];
}

/** A strategy trade as drawn on the chart. */
export interface TradeDrawing {
  number: number;
  direction: 'long' | 'short';
  isOpen: boolean;
  entryX: number;
  entryPrice: number;
  entrySignal: string;
  exitX: number | null;
  exitPrice: number | null;
  exitSignal: string | null;
  qty: number;
  profit: number;
  profitPercent: number | null;
  /** Connecting line color: green profit, red loss, gray even. */
  lineColor: string;
}

export interface PaneModel {
  key: PaneKey;
  backgrounds: BackgroundLayer[];
  fills: FillLayer[];
  /** Plots and plotcandle/plotbar in declaration order. */
  series: SeriesLayer[];
  hlines: HlineLayer[];
  markers: MarkerLayer[];
  drawings: DrawingSet;
  tables: TableLayout[];
  /** Strategy trades (main pane only). */
  trades: TradeDrawing[];
}

export interface PineRenderModel {
  timeline: BarTimeline;
  bars: PriceBars;
  /** Slots past the last bar that outputs reach (positive offsets, future drawings), capped. */
  futureSlots: number;
  pricePrecision: number;
  declaration: PineDeclaration | null;
  /** Script title for status lines (short title when given). */
  title: string;
  overlay: boolean;
  /** The declaration's own format (price-scale formatting of the script pane). */
  format: ValueFormat;
  panes: { main: PaneModel; script: PaneModel | null };
}
