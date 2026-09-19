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
  | 'short-position'
  // Channels and regression
  | 'flat-channel'
  | 'regression-channel'
  | 'disjoint-angle'
  // Pitchforks
  | 'pitchfork'
  | 'schiff-pitchfork'
  | 'modified-schiff-pitchfork'
  | 'inside-pitchfork'
  // Gann
  | 'gann-box'
  | 'gann-fan'
  | 'gann-square'
  // Fibonacci (extended set)
  | 'fib-channel'
  | 'fib-timezone'
  | 'fib-circles'
  | 'fib-arcs'
  | 'fib-wedge'
  | 'fib-speed-fan'
  // Elliott
  | 'elliott-impulse'
  | 'elliott-correction'
  | 'elliott-triangle'
  // Harmonic patterns
  | 'abcd-pattern'
  | 'xabcd-pattern'
  | 'three-drives'
  | 'head-and-shoulders'
  | 'triangle-pattern'
  // More annotations
  | 'arc'
  | 'curve'
  | 'polyline'
  | 'flag'
  | 'price-label'
  | 'signpost'
  | 'anchored-vwap'
  // Remaining Fibonacci
  | 'fib-spiral'
  | 'fib-resistance-arcs'
  // Cycles and projection
  | 'cyclic-lines'
  | 'sine-line'
  | 'time-cycles'
  | 'bars-pattern'
  | 'ghost-feed'
  | 'projection'
  // Remaining Elliott
  | 'elliott-double-combo'
  | 'elliott-triple-combo'
  | 'elliott-minor'
  | 'elliott-intermediate'
  // Remaining harmonics
  | 'cypher-pattern'
  | 'five-point-pattern'
  | 'head-and-shoulders-inverse'
  // Gann extras
  | 'gann-fan-fixed'
  | 'gann-grid'
  // Shapes and annotations
  | 'rotated-rectangle'
  | 'arc-curve'
  | 'double-curve'
  | 'highlighter'
  | 'comment'
  | 'balloon'
  | 'sticker'
  | 'table'
  | 'anchored-note'
  | 'idea'
  | 'pitchfan';

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
  group:
    | 'lines'
    | 'channels'
    | 'pitchfork'
    | 'gann'
    | 'shapes'
    | 'fib'
    | 'elliott'
    | 'patterns'
    | 'annotation'
    | 'measure';
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

  // ── Channels ─────────────────────────────────────────────────────────────
  {
    kind: 'flat-channel',
    label: 'Flat Channel',
    group: 'channels',
    points: 2,
    icon: '⊟',
    defaultStyle: { fill: 'rgba(41,98,255,0.10)' },
  },
  {
    kind: 'regression-channel',
    label: 'Regression Channel',
    group: 'channels',
    points: 2,
    icon: '⋰',
    defaultStyle: { fill: 'rgba(41,98,255,0.10)' },
  },
  { kind: 'disjoint-angle', label: 'Disjoint Angle', group: 'channels', points: 3, icon: '∠' },

  // ── Pitchforks ───────────────────────────────────────────────────────────
  { kind: 'pitchfork', label: "Andrews' Pitchfork", group: 'pitchfork', points: 3, icon: 'Ψ' },
  { kind: 'schiff-pitchfork', label: 'Schiff Pitchfork', group: 'pitchfork', points: 3, icon: 'ψ' },
  {
    kind: 'modified-schiff-pitchfork',
    label: 'Modified Schiff',
    group: 'pitchfork',
    points: 3,
    icon: 'Ϣ',
  },
  { kind: 'inside-pitchfork', label: 'Inside Pitchfork', group: 'pitchfork', points: 3, icon: 'ϟ' },

  // ── Gann ─────────────────────────────────────────────────────────────────
  {
    kind: 'gann-box',
    label: 'Gann Box',
    group: 'gann',
    points: 2,
    icon: '▦',
    defaultStyle: { fill: 'rgba(41,98,255,0.06)' },
  },
  { kind: 'gann-fan', label: 'Gann Fan', group: 'gann', points: 2, icon: '✳' },
  { kind: 'gann-square', label: 'Gann Square', group: 'gann', points: 2, icon: '⊞' },

  // ── Fibonacci (extended) ─────────────────────────────────────────────────
  { kind: 'fib-channel', label: 'Fib Channel', group: 'fib', points: 3, icon: '⊿' },
  { kind: 'fib-timezone', label: 'Fib Time Zone', group: 'fib', points: 2, icon: '⏲' },
  { kind: 'fib-circles', label: 'Fib Circles', group: 'fib', points: 2, icon: '◎' },
  { kind: 'fib-arcs', label: 'Fib Arcs', group: 'fib', points: 2, icon: '◠' },
  { kind: 'fib-wedge', label: 'Fib Wedge', group: 'fib', points: 3, icon: '◣' },
  { kind: 'fib-speed-fan', label: 'Fib Speed Fan', group: 'fib', points: 2, icon: '⋀' },

  // ── Elliott ──────────────────────────────────────────────────────────────
  {
    kind: 'elliott-impulse',
    label: 'Elliott Impulse (12345)',
    group: 'elliott',
    points: 6,
    icon: '⑤',
  },
  {
    kind: 'elliott-correction',
    label: 'Elliott Correction (ABC)',
    group: 'elliott',
    points: 4,
    icon: 'Ⓒ',
  },
  {
    kind: 'elliott-triangle',
    label: 'Elliott Triangle (ABCDE)',
    group: 'elliott',
    points: 6,
    icon: 'Ⓔ',
  },

  // ── Harmonic patterns ────────────────────────────────────────────────────
  { kind: 'abcd-pattern', label: 'ABCD Pattern', group: 'patterns', points: 4, icon: 'Ⓐ' },
  { kind: 'xabcd-pattern', label: 'XABCD Pattern', group: 'patterns', points: 5, icon: 'Ⓧ' },
  { kind: 'three-drives', label: 'Three Drives', group: 'patterns', points: 7, icon: '3' },
  {
    kind: 'head-and-shoulders',
    label: 'Head and Shoulders',
    group: 'patterns',
    points: 7,
    icon: 'Ⓗ',
  },
  {
    kind: 'triangle-pattern',
    label: 'Triangle Pattern',
    group: 'patterns',
    points: 4,
    icon: '◺',
  },

  // ── More annotations ─────────────────────────────────────────────────────
  { kind: 'arc', label: 'Arc', group: 'shapes', points: 2, icon: '◡' },
  { kind: 'curve', label: 'Curve', group: 'shapes', points: 3, icon: '∿' },
  { kind: 'polyline', label: 'Polyline', group: 'shapes', points: 'freehand', icon: '⏢' },
  { kind: 'flag', label: 'Flag Mark', group: 'annotation', points: 1, icon: '⚑' },
  { kind: 'price-label', label: 'Price Label', group: 'annotation', points: 1, icon: '🏷' },
  { kind: 'signpost', label: 'Signpost', group: 'annotation', points: 1, icon: '📍' },
  {
    kind: 'anchored-vwap',
    label: 'Anchored VWAP',
    group: 'measure',
    points: 1,
    icon: '⚓',
    defaultStyle: { color: '#00BCD4' },
  },

  // ── Remaining Fibonacci ──────────────────────────────────────────────────
  { kind: 'fib-spiral', label: 'Fib Spiral', group: 'fib', points: 2, icon: '🌀' },
  { kind: 'fib-resistance-arcs', label: 'Fib Resistance Arcs', group: 'fib', points: 2, icon: '◟' },

  // ── Cycles and projection ────────────────────────────────────────────────
  { kind: 'cyclic-lines', label: 'Cyclic Lines', group: 'measure', points: 2, icon: '┆' },
  { kind: 'sine-line', label: 'Sine Line', group: 'measure', points: 2, icon: '∿' },
  { kind: 'time-cycles', label: 'Time Cycles', group: 'measure', points: 2, icon: '◍' },
  { kind: 'bars-pattern', label: 'Bars Pattern', group: 'measure', points: 2, icon: '▥' },
  { kind: 'ghost-feed', label: 'Ghost Feed', group: 'measure', points: 2, icon: '👻' },
  { kind: 'projection', label: 'Projection', group: 'measure', points: 3, icon: '⤳' },

  // ── Remaining Elliott ────────────────────────────────────────────────────
  {
    kind: 'elliott-double-combo',
    label: 'Elliott Double Combo (WXY)',
    group: 'elliott',
    points: 4,
    icon: 'Ⓨ',
  },
  {
    kind: 'elliott-triple-combo',
    label: 'Elliott Triple Combo (WXYXZ)',
    group: 'elliott',
    points: 6,
    icon: 'Ⓩ',
  },
  { kind: 'elliott-minor', label: 'Elliott Minor Wave', group: 'elliott', points: 6, icon: 'ⓜ' },
  {
    kind: 'elliott-intermediate',
    label: 'Elliott Intermediate Wave',
    group: 'elliott',
    points: 6,
    icon: 'ⓘ',
  },

  // ── Remaining harmonics ──────────────────────────────────────────────────
  { kind: 'cypher-pattern', label: 'Cypher Pattern', group: 'patterns', points: 5, icon: 'Ⓒ' },
  {
    kind: 'five-point-pattern',
    label: '5-Point Pattern',
    group: 'patterns',
    points: 5,
    icon: '⑤',
  },
  {
    kind: 'head-and-shoulders-inverse',
    label: 'Inverse Head and Shoulders',
    group: 'patterns',
    points: 7,
    icon: 'Ⓥ',
  },

  // ── Gann extras ──────────────────────────────────────────────────────────
  { kind: 'gann-fan-fixed', label: 'Gann Fan (fixed)', group: 'gann', points: 1, icon: '✲' },
  { kind: 'gann-grid', label: 'Gann Grid', group: 'gann', points: 2, icon: '▩' },
  { kind: 'pitchfan', label: 'Pitchfan', group: 'pitchfork', points: 3, icon: 'ϡ' },

  // ── Shapes and annotations ───────────────────────────────────────────────
  {
    kind: 'rotated-rectangle',
    label: 'Rotated Rectangle',
    group: 'shapes',
    points: 3,
    icon: '▱',
    defaultStyle: { fill: 'rgba(41,98,255,0.12)' },
  },
  { kind: 'arc-curve', label: 'Arc Curve', group: 'shapes', points: 3, icon: '⌒' },
  { kind: 'double-curve', label: 'Double Curve', group: 'shapes', points: 4, icon: '∽' },
  {
    kind: 'highlighter',
    label: 'Highlighter',
    group: 'shapes',
    points: 'freehand',
    icon: '🖍',
    defaultStyle: { color: 'rgba(255,214,0,0.55)', width: 12 },
  },
  { kind: 'comment', label: 'Comment', group: 'annotation', points: 1, icon: '🗨' },
  { kind: 'balloon', label: 'Balloon', group: 'annotation', points: 1, icon: '🎈' },
  { kind: 'sticker', label: 'Sticker', group: 'annotation', points: 1, icon: '⭐' },
  { kind: 'table', label: 'Table', group: 'annotation', points: 1, icon: '▦' },
  { kind: 'anchored-note', label: 'Anchored Note', group: 'annotation', points: 2, icon: '📌' },
  { kind: 'idea', label: 'Idea', group: 'annotation', points: 1, icon: '💡' },
];

export function toolFor(kind: DrawingKind): ToolSpec | undefined {
  return TOOLS.find((t) => t.kind === kind);
}

/** Gann fan angles as rise:run ratios, 1×1 being the 45° line. */
export const GANN_RATIOS = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8] as const;

/** Fibonacci ratios used by circles, arcs and speed fans. */
export const FIB_RADII = [0.236, 0.382, 0.5, 0.618, 1] as const;

/** Wave labels per Elliott tool, in click order. */
export const ELLIOTT_LABELS: Record<string, readonly string[]> = {
  'elliott-double-combo': ['0', 'W', 'X', 'Y'],
  'elliott-triple-combo': ['0', 'W', 'X', 'Y', 'X', 'Z'],
  'elliott-minor': ['0', '1', '2', '3', '4', '5'],
  'elliott-intermediate': ['0', '1', '2', '3', '4', '5'],
  'cypher-pattern': ['X', 'A', 'B', 'C', 'D'],
  'five-point-pattern': ['X', 'A', 'B', 'C', 'D'],
  'head-and-shoulders-inverse': ['', 'LS', '', 'H', '', 'RS', ''],
  projection: ['A', 'B', 'C'],
  'elliott-impulse': ['0', '1', '2', '3', '4', '5'],
  'elliott-correction': ['0', 'A', 'B', 'C'],
  'elliott-triangle': ['0', 'A', 'B', 'C', 'D', 'E'],
  'abcd-pattern': ['A', 'B', 'C', 'D'],
  'xabcd-pattern': ['X', 'A', 'B', 'C', 'D'],
  'three-drives': ['0', '1', 'A', '2', 'B', '3', 'C'],
  'head-and-shoulders': ['', 'LS', '', 'H', '', 'RS', ''],
  'triangle-pattern': ['A', 'B', 'C', 'D'],
};

/** Fibonacci levels, shared by retracement and extension. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618] as const;

export function newDrawingId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function styleFor(kind: DrawingKind, base?: Partial<DrawingStyle>): DrawingStyle {
  return { ...DEFAULT_STYLE, ...(toolFor(kind)?.defaultStyle ?? {}), ...(base ?? {}) };
}
