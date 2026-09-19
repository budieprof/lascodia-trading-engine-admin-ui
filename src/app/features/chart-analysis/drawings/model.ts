/**
 * The drawing model.
 *
 * Drawings are stored in CHART space — `{ time, price }` — never in pixels.
 * That is the whole reason a trendline drawn on H1 still sits on the same
 * swing highs after zooming, panning, switching to candles, or reloading a
 * week later. Anything stored in screen coordinates silently detaches from
 * the price the first time the viewport changes.
 */

export type DrawingKind =
  // Lines
  | 'trend-line'
  | 'ray'
  | 'extended-line'
  | 'horizontal-line'
  | 'horizontal-ray'
  | 'vertical-line'
  | 'cross-line'
  | 'parallel-channel'
  // Shapes
  | 'rectangle'
  | 'ellipse'
  | 'triangle'
  | 'path'
  | 'brush'
  // Fibonacci
  | 'fib-retracement'
  | 'fib-extension'
  // Annotations
  | 'text'
  | 'callout'
  | 'arrow'
  // Measurement / projection
  | 'measure'
  | 'price-range'
  | 'date-range'
  | 'long-position'
  | 'short-position';

export interface DrawingPoint {
  /** Bar time in ms. */
  time: number;
  price: number;
}

export type DashStyle = 'solid' | 'dashed' | 'dotted';

export interface DrawingStyle {
  color: string;
  width: number;
  dash: DashStyle;
  /** Fill for shapes and Fib bands; `null` renders unfilled. */
  fill: string | null;
  fontSize: number;
  text: string;
  /** Show the price/level labels a tool defines (Fib levels, position R:R). */
  showLabels: boolean;
}

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /** Drawings belong to a symbol AND a timeframe, exactly as on TradingView. */
  symbol: string;
  resolution: string;
  points: DrawingPoint[];
  style: DrawingStyle;
  locked: boolean;
  createdAt: number;
}

export interface ToolSpec {
  kind: DrawingKind;
  label: string;
  group: 'lines' | 'shapes' | 'fib' | 'annotation' | 'measure';
  /** Clicks needed to complete the drawing. `'freehand'` collects on drag. */
  points: number | 'freehand';
  icon: string;
  /** Tools that snap to a single axis ignore the other coordinate. */
  axis?: 'price' | 'time';
  defaultStyle?: Partial<DrawingStyle>;
}

export const DEFAULT_STYLE: DrawingStyle = {
  color: '#2962FF',
  width: 2,
  dash: 'solid',
  fill: null,
  fontSize: 12,
  text: '',
  showLabels: true,
};

/**
 * The tool palette.
 *
 * Ordered as TradingView orders its left rail: cursor-adjacent line tools
 * first, then shapes, Fibonacci, annotations and measurement. Adding a tool is
 * an entry here plus a case in the renderer — the toolbar, hit-testing,
 * persistence and the object tree are all driven from this list.
 */
export const TOOLS: readonly ToolSpec[] = [
  { kind: 'trend-line', label: 'Trend Line', group: 'lines', points: 2, icon: '╱' },
  { kind: 'ray', label: 'Ray', group: 'lines', points: 2, icon: '↗' },
  { kind: 'extended-line', label: 'Extended Line', group: 'lines', points: 2, icon: '↔' },
  {
    kind: 'horizontal-line',
    label: 'Horizontal Line',
    group: 'lines',
    points: 1,
    icon: '—',
    axis: 'price',
  },
  { kind: 'horizontal-ray', label: 'Horizontal Ray', group: 'lines', points: 2, icon: '→' },
  {
    kind: 'vertical-line',
    label: 'Vertical Line',
    group: 'lines',
    points: 1,
    icon: '│',
    axis: 'time',
  },
  { kind: 'cross-line', label: 'Cross Line', group: 'lines', points: 1, icon: '✛' },
  { kind: 'parallel-channel', label: 'Parallel Channel', group: 'lines', points: 3, icon: '⫽' },

  {
    kind: 'rectangle',
    label: 'Rectangle',
    group: 'shapes',
    points: 2,
    icon: '▭',
    defaultStyle: { fill: 'rgba(41,98,255,0.12)' },
  },
  {
    kind: 'ellipse',
    label: 'Ellipse',
    group: 'shapes',
    points: 2,
    icon: '◯',
    defaultStyle: { fill: 'rgba(41,98,255,0.12)' },
  },
  {
    kind: 'triangle',
    label: 'Triangle',
    group: 'shapes',
    points: 3,
    icon: '△',
    defaultStyle: { fill: 'rgba(41,98,255,0.12)' },
  },
  { kind: 'path', label: 'Path', group: 'shapes', points: 'freehand', icon: '⋰' },
  { kind: 'brush', label: 'Brush', group: 'shapes', points: 'freehand', icon: '✎' },

  { kind: 'fib-retracement', label: 'Fib Retracement', group: 'fib', points: 2, icon: '⁞' },
  { kind: 'fib-extension', label: 'Fib Extension', group: 'fib', points: 3, icon: '⁝' },

  { kind: 'text', label: 'Text', group: 'annotation', points: 1, icon: 'T' },
  { kind: 'callout', label: 'Callout', group: 'annotation', points: 2, icon: '💬' },
  { kind: 'arrow', label: 'Arrow', group: 'annotation', points: 2, icon: '➤' },

  { kind: 'measure', label: 'Measure', group: 'measure', points: 2, icon: '📐' },
  { kind: 'price-range', label: 'Price Range', group: 'measure', points: 2, icon: '↕' },
  { kind: 'date-range', label: 'Date Range', group: 'measure', points: 2, icon: '↔' },
  {
    kind: 'long-position',
    label: 'Long Position',
    group: 'measure',
    points: 3,
    icon: '🡅',
    defaultStyle: { color: '#26A69A' },
  },
  {
    kind: 'short-position',
    label: 'Short Position',
    group: 'measure',
    points: 3,
    icon: '🡇',
    defaultStyle: { color: '#EF5350' },
  },
];

export function toolFor(kind: DrawingKind): ToolSpec | undefined {
  return TOOLS.find((t) => t.kind === kind);
}

/** Fibonacci levels, shared by retracement and extension. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618] as const;

export function newDrawingId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function styleFor(kind: DrawingKind, base?: Partial<DrawingStyle>): DrawingStyle {
  return { ...DEFAULT_STYLE, ...(toolFor(kind)?.defaultStyle ?? {}), ...(base ?? {}) };
}
