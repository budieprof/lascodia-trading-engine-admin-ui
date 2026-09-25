/**
 * Wire types of the scripting API that the Pine chart renders (ADR-0027, `docs/api/scripting-api.md`).
 *
 * `PineScriptOutputs` is the camelCase JSON of the engine's `LascodiaTradingEngine.Scripting.Output.ScriptOutputs`
 * (schema version 1). Facts the renderer relies on:
 *
 * - every per-bar array is aligned to `bars.times` — index `i` is `bar_index = bars.firstIndex + i`;
 * - `na` is `null`, colors are `"#RRGGBBAA"` strings;
 * - styles, positions and sizes are the Pine constant names without their namespace (`label_down`,
 *   `top_right`, `dashed`, `stepline`, …);
 * - `offset` and `showLast` are REPORTED, not applied — the renderer applies them;
 * - drawing x coordinates come resolved to both a bar index and a time (extrapolated beyond the data);
 * - only displayed tables are exported (the newest per position); merged cells carry their spans.
 *
 * Everything here is data from the engine: the renderer never trusts a field to be present, see `normalize.ts`.
 */

// ── §3 run: bars, outputs ────────────────────────────────────────────────────────────────────────

/** One chart bar of a run (`bars[]` of the §3 response). Times are Unix ms UTC. */
export interface PineBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** The bar window of an output export. */
export interface PineOutputBars {
  /** bar_index of `times[0]`. */
  firstIndex: number;
  /** Bar open times, Unix ms UTC. */
  times: number[];
  /** Chart timeframe in Pine spelling (`"60"`, `"1D"`, `"15S"`). */
  timeframe: string;
}

/** `display.*` locations: `["all"]`, `["none"]` or a list such as `["pane", "data_window"]`. */
export type PineDisplayName =
  | 'all'
  | 'none'
  | 'pane'
  | 'data_window'
  | 'price_scale'
  | 'status_line'
  | 'pine_screener';

export type PinePlotStyle =
  | 'line'
  | 'linebr'
  | 'stepline'
  | 'stepline_diamond'
  | 'steplinebr'
  | 'histogram'
  | 'cross'
  | 'area'
  | 'areabr'
  | 'columns'
  | 'circles';

export type PineLineStyle = 'solid' | 'dashed' | 'dotted';

/** line.style_* (lines, boxes, polylines). */
export type PineDrawingLineStyle =
  | 'solid'
  | 'dotted'
  | 'dashed'
  | 'arrow_left'
  | 'arrow_right'
  | 'arrow_both';

export type PineShape =
  | 'xcross'
  | 'cross'
  | 'circle'
  | 'triangleup'
  | 'triangledown'
  | 'flag'
  | 'arrowup'
  | 'arrowdown'
  | 'labelup'
  | 'labeldown'
  | 'square'
  | 'diamond';

export type PineLocation = 'abovebar' | 'belowbar' | 'top' | 'bottom' | 'absolute';

export type PineSize = 'auto' | 'tiny' | 'small' | 'normal' | 'large' | 'huge';

export type PineLabelStyle =
  | 'none'
  | 'xcross'
  | 'cross'
  | 'triangleup'
  | 'triangledown'
  | 'flag'
  | 'circle'
  | 'arrowup'
  | 'arrowdown'
  | 'label_up'
  | 'label_down'
  | 'label_left'
  | 'label_right'
  | 'label_lower_left'
  | 'label_lower_right'
  | 'label_upper_left'
  | 'label_upper_right'
  | 'label_center'
  | 'square'
  | 'diamond'
  | 'text_outline';

export type PineTablePosition =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'middle_left'
  | 'middle_center'
  | 'middle_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

export type PineExtend = 'none' | 'left' | 'right' | 'both';
export type PineXloc = 'bar_index' | 'bar_time';
export type PineYloc = 'price' | 'abovebar' | 'belowbar';
export type PineHAlign = 'left' | 'center' | 'right';
export type PineVAlign = 'top' | 'center' | 'bottom';

/** Presentation properties every plot-type output carries. */
export interface PineSeriesOutputBase {
  id: number;
  title?: string | null;
  offset: number;
  editable?: boolean;
  showLast?: number | null;
  display: string[];
  forceOverlay: boolean;
}

/** A plot(). */
export interface PinePlotOutput extends PineSeriesOutputBase {
  /** `{{plot_N}}` number. */
  plotNumber: number;
  style: PinePlotStyle | string;
  lineStyle: PineLineStyle | string;
  lineWidth: number;
  trackPrice: boolean;
  histBase: number;
  join: boolean;
  /** format.* name (inherit, price, volume, percent, mintick) or null = the declaration's format. */
  format?: string | null;
  precision?: number | null;
  /** The color of every bar when it never changes (then `colors` is null). */
  color?: string | null;
  colors?: (string | null)[] | null;
  values: (number | null)[];
}

/** One drawn marker of a plotshape/plotchar/plotarrow. */
export interface PineMarkerPoint {
  barIndex: number;
  time: number;
  /** The series value (price for location "absolute"; signed height for arrows). */
  value?: number | null;
  color?: string | null;
  textColor?: string | null;
  /** "up"/"down" for arrows. */
  direction?: 'up' | 'down' | string | null;
}

/** A plotshape ("shape"), plotchar ("char") or plotarrow ("arrow"). */
export interface PineMarkerOutput extends PineSeriesOutputBase {
  plotNumber: number;
  kind: 'shape' | 'char' | 'arrow' | string;
  shape?: PineShape | string | null;
  char?: string | null;
  location?: PineLocation | string | null;
  size?: PineSize | string | null;
  text?: string | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  format?: string | null;
  precision?: number | null;
  /** Only the bars where a marker is drawn. */
  points: PineMarkerPoint[];
}

/** A plotbar ("bar") or plotcandle ("candle"). A bar with any na OHLC value is null in all four arrays. */
export interface PineCandleOutput extends PineSeriesOutputBase {
  plotNumber: number;
  kind: 'bar' | 'candle' | string;
  format?: string | null;
  precision?: number | null;
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  color?: string | null;
  colors?: (string | null)[] | null;
  /** Candles only (null = same as the body color). */
  wickColors?: (string | null)[] | null;
  borderColors?: (string | null)[] | null;
}

/** bgcolor()/barcolor(): a color per bar (null = none). */
export interface PineColorSeriesOutput extends PineSeriesOutputBase {
  colors: (string | null)[];
}

export interface PineHlineOutput {
  id: number;
  title?: string | null;
  price?: number | null;
  color?: string | null;
  /** solid, dotted, dashed. */
  lineStyle: PineLineStyle | string;
  lineWidth: number;
  editable?: boolean;
  display: string[];
}

/** fill() between two plots ("plots"), two hlines ("hlines") or a gradient between two plots ("gradient"). */
export interface PineFillOutput {
  id: number;
  kind: 'plots' | 'hlines' | 'gradient' | string;
  /** Plot ids (plots/gradient) or hline ids (hlines). */
  from: number;
  to: number;
  title?: string | null;
  editable?: boolean;
  showLast?: number | null;
  fillGaps: boolean;
  display: string[];
  color?: string | null;
  colors?: (string | null)[] | null;
  topValues?: (number | null)[] | null;
  bottomValues?: (number | null)[] | null;
  topColors?: (string | null)[] | null;
  bottomColors?: (string | null)[] | null;
}

/** A drawing x coordinate as written by the script and resolved to both axes. */
export interface PineOutputX {
  /** As written (bar index or Unix ms per the drawing's xloc). */
  value?: number | null;
  barIndex?: number | null;
  time?: number | null;
}

export interface PineLabelOutput {
  id: number;
  x: PineOutputX;
  y?: number | null;
  xloc: PineXloc | string;
  yloc: PineYloc | string;
  text: string;
  color?: string | null;
  style: PineLabelStyle | string;
  textColor?: string | null;
  size?: PineSize | string | null;
  /** Typographic size (labels 0/7/10/12/18/24; 0 = auto). */
  sizePoints: number;
  textAlign: PineHAlign | string;
  tooltip?: string | null;
  fontFamily: 'default' | 'monospace' | string;
  bold: boolean;
  italic: boolean;
  forceOverlay: boolean;
  createdBar: number;
}

export interface PineLineOutput {
  id: number;
  x1: PineOutputX;
  y1?: number | null;
  x2: PineOutputX;
  y2?: number | null;
  xloc: PineXloc | string;
  extend: PineExtend | string;
  color?: string | null;
  style: PineDrawingLineStyle | string;
  width: number;
  forceOverlay: boolean;
  createdBar: number;
}

export interface PineBoxOutput {
  id: number;
  left: PineOutputX;
  top?: number | null;
  right: PineOutputX;
  bottom?: number | null;
  xloc: PineXloc | string;
  borderColor?: string | null;
  borderWidth: number;
  borderStyle: PineDrawingLineStyle | string;
  extend: PineExtend | string;
  bgColor?: string | null;
  text: string;
  textSize?: PineSize | string | null;
  /** Typographic size (boxes/tables 0/8/10/14/20/36; 0 = auto). */
  textSizePoints: number;
  textColor?: string | null;
  textHAlign: PineHAlign | string;
  textVAlign: PineVAlign | string;
  /** none or auto. */
  textWrap: 'none' | 'auto' | string;
  fontFamily: 'default' | 'monospace' | string;
  bold: boolean;
  italic: boolean;
  forceOverlay: boolean;
  createdBar: number;
}

export interface PinePolylinePoint {
  time?: number | null;
  barIndex?: number | null;
  price?: number | null;
}

export interface PinePolylineOutput {
  id: number;
  points: PinePolylinePoint[];
  curved: boolean;
  closed: boolean;
  /** Which field of the points the polyline uses for x: bar_index or bar_time. */
  xloc: PineXloc | string;
  lineColor?: string | null;
  fillColor?: string | null;
  lineStyle: PineDrawingLineStyle | string;
  lineWidth: number;
  forceOverlay: boolean;
  createdBar: number;
}

export interface PineLinefillOutput {
  id: number;
  line1: number;
  line2: number;
  color?: string | null;
}

export interface PineTableCellOutput {
  column: number;
  row: number;
  /** 1 unless the cell is the top-left of a merged range. */
  columnSpan: number;
  rowSpan: number;
  text: string;
  /** Width/height in % of the pane; 0 = automatic. */
  width: number;
  height: number;
  textColor?: string | null;
  textHAlign: PineHAlign | string;
  textVAlign: PineVAlign | string;
  textSize?: PineSize | string | null;
  textSizePoints: number;
  bgColor?: string | null;
  tooltip?: string | null;
  fontFamily: 'default' | 'monospace' | string;
  bold: boolean;
  italic: boolean;
}

export interface PineTableOutput {
  id: number;
  position: PineTablePosition | string;
  columns: number;
  rows: number;
  bgColor?: string | null;
  frameColor?: string | null;
  frameWidth: number;
  borderColor?: string | null;
  borderWidth: number;
  forceOverlay: boolean;
  /** Defined cells only (cells covered by a merge are omitted; the merge's top-left cell carries spans). */
  cells: PineTableCellOutput[];
}

export interface PineAlertConditionOutput {
  id: number;
  title: string;
  /** The message template (placeholders unexpanded). */
  message: string;
}

export interface PineAlertEventOutput {
  /** alertcondition, alert or order_fill. */
  source: string;
  conditionId?: number | null;
  title?: string | null;
  message: string;
  frequency?: string | null;
  barIndex: number;
  barTime: number;
  time: number;
  isRealtime: boolean;
  isConfirmed: boolean;
}

export type PineLogLevel = 'info' | 'warning' | 'error';

export interface PineLogOutput {
  level: PineLogLevel | string;
  message: string;
  barIndex: number;
  /** Bar open time on historical bars; the wall clock on realtime bars (ms UTC). */
  time: number;
  isRealtime: boolean;
  /** Source line of the log.*() call — not in schema 1; shown ("Source code") when the engine adds it. */
  line?: number | null;
}

/** All outputs of a run (or of a bar window of it). */
export interface PineScriptOutputs {
  schemaVersion: number;
  bars: PineOutputBars;
  plots: PinePlotOutput[];
  markers: PineMarkerOutput[];
  candles: PineCandleOutput[];
  backgrounds: PineColorSeriesOutput[];
  barColors: PineColorSeriesOutput[];
  hlines: PineHlineOutput[];
  fills: PineFillOutput[];
  labels: PineLabelOutput[];
  lines: PineLineOutput[];
  boxes: PineBoxOutput[];
  polylines: PinePolylineOutput[];
  linefills: PineLinefillOutput[];
  tables: PineTableOutput[];
  alertConditions: PineAlertConditionOutput[];
  alerts: PineAlertEventOutput[];
  droppedAlerts: number;
  logs: PineLogOutput[];
  droppedLogs: number;
}

// ── §3 run: strategy report (only what the chart draws; `app-strategy-report` reads the rest) ─────

/** One row of the Strategy Tester's "List of trades" (`StrategyReport.trades`). */
export interface PineReportTrade {
  /** 1-based trade number. */
  number: number;
  isOpen: boolean;
  /** "long" / "short". */
  direction: 'long' | 'short' | string;
  entryId: string;
  entrySignal: string;
  entryTime: number;
  entryBarIndex: number;
  entryPrice: number;
  exitId?: string | null;
  exitSignal?: string | null;
  exitTime?: number | null;
  exitBarIndex?: number | null;
  exitPrice?: number | null;
  exitLeg?: string | null;
  qty: number;
  positionValue?: number | null;
  profit: number;
  profitPercent?: number | null;
  cumulativeProfit?: number | null;
  runUp?: number | null;
  drawdown?: number | null;
  barsHeld?: number | null;
  commission?: number | null;
}

/** The strategy report as far as the chart reads it; every other member passes through untouched. */
export interface PineStrategyReport {
  meta?: {
    symbol?: string;
    timeframe?: string;
    accountCurrency?: string;
    initialCapital?: number;
    [key: string]: unknown;
  } | null;
  trades: PineReportTrade[];
  [key: string]: unknown;
}

// ── §2/§3 compile, trace, profile, runtime error ─────────────────────────────────────────────────

export interface PineDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info' | string;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface PineDeclaration {
  kind: 'indicator' | 'strategy' | 'library' | string;
  title: string;
  shortTitle?: string | null;
  overlay: boolean;
  format?: string | null;
  precision?: number | null;
  [key: string]: unknown;
}

export interface PineCompileResult {
  success: boolean;
  diagnostics: PineDiagnostic[];
  declaration: PineDeclaration | null;
  [key: string]: unknown;
}

/** One traced expression at one bar ("why didn't it fire"). Lines and columns are 1-based. */
export interface PineTraceItem {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Source text of the expression. */
  text: string;
  /** The value, formatted by the engine ("true", "false", "1.08523", "na"). */
  value: string;
}

export interface PineTraceBar {
  bar: number;
  timeMs: number;
  items: PineTraceItem[];
}

export interface PineProfileLine {
  line: number;
  executions: number;
  totalMicros: number;
}

export interface PineRuntimeError {
  code: string;
  message: string;
  line?: number | null;
  column?: number | null;
  barIndex?: number | null;
}

/** The §3 response `data`. */
export interface PineRunResult {
  compile: PineCompileResult | null;
  bars: PineBar[];
  outputs: PineScriptOutputs | null;
  report: PineStrategyReport | null;
  trace: PineTraceBar[];
  profile: PineProfileLine[];
  runtimeError: PineRuntimeError | null;
  elapsedMs: number | null;
}

// ── §3 request ───────────────────────────────────────────────────────────────────────────────────

export type PineChartType =
  | 'standard'
  | 'heikinashi'
  | 'renko'
  | 'linebreak'
  | 'kagi'
  | 'pointfigure';

export type PineInputValue = number | boolean | string;

/** `POST scripting/run`. Either `source` or `strategyId`. */
export interface PineRunRequest {
  source?: string;
  strategyId?: number;
  symbol: string;
  /** Pine timeframe or engine M1..D1. */
  timeframe: string;
  fromUtc?: string;
  toUtc?: string;
  /** Default 2000, max 20000 for a preview. */
  lastBars?: number;
  inputs?: Record<string, PineInputValue>;
  mode?: 'preview' | 'backtest';
  trace?: { fromBar: number; toBar: number };
  profile?: boolean;
  chartType?: PineChartType;
}

// ── §5 replay ────────────────────────────────────────────────────────────────────────────────────

/** `POST scripting/replay` — the §3 request plus the bar to start at. */
export interface PineReplayStartRequest extends PineRunRequest {
  startBar: number;
}

/** `POST scripting/replay/{sessionId}/step`. */
export interface PineReplayStepRequest {
  /** 1..500. */
  bars: number;
  ticks?: boolean;
}

/** The strategy position after a replay frame (schema owned by the engine; rendered as key/values). */
export interface PineReplayPosition {
  size?: number | null;
  avgPrice?: number | null;
  openProfit?: number | null;
  [key: string]: unknown;
}

export interface PineReplayFrame {
  /** bar_index of the last bar the frame covers. */
  barIndex: number;
  /** Bars new in this frame (the first frame carries every bar up to the start bar). */
  bars: PineBar[];
  /** Outputs for the new bar window (drawings, tables, alerts and logs are whole). */
  outputsDelta: PineScriptOutputs | null;
  report?: PineStrategyReport | null;
  position?: PineReplayPosition | null;
}

export interface PineReplayStartResponse {
  sessionId: string;
  frame: PineReplayFrame;
}
