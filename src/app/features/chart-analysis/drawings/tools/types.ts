import type { PaintCtx } from '../paint-ctx';
import type { Pt } from '../geometry';
import type { Drawing, DrawingKind, DrawingPoint, DrawingStyle } from '../model';
import type { Bar } from '../../datafeed/candle-feed.service';

/**
 * Per-tool behaviour — the seam that lets each tool match TradingView exactly.
 *
 * A tool with a behaviour here owns its painting, its handles, its hit-test,
 * its defaults and its settings; the renderer and controller only do canvas
 * plumbing, selection and drag mechanics. Tools without one still use the
 * legacy switch in `drawing-renderer.ts`, so families migrate independently.
 *
 * One file per TradingView rail family lives next to this one
 * (`trend.ts`, `fib-gann.ts`, `patterns.ts`, `forecast.ts`, `shapes.ts`,
 * `text.ts`), each exporting a `Partial<Record<DrawingKind, ToolBehavior>>`.
 */

/** Screen ↔ data conversions available to handle logic. */
export interface ToolGeometry {
  project: (p: DrawingPoint) => Pt | null;
  unproject: (p: Pt) => DrawingPoint | null;
}

/** A setting on the tool's Style/Text tab, rendered generically by the settings dialog. */
export type ToolOption =
  | { key: string; label: string; type: 'bool'; default: boolean; tab?: 'style' | 'text' }
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number; tab?: 'style' | 'text' }
  | { key: string; label: string; type: 'color'; default: string; tab?: 'style' | 'text' }
  | { key: string; label: string; type: 'select'; default: string; choices: readonly string[]; tab?: 'style' | 'text' }
  | { key: string; label: string; type: 'text'; default: string; tab?: 'style' | 'text' }
  /** Fib-style level table: value, colour, visible. */
  | {
      key: string;
      label: string;
      type: 'levels';
      default: readonly { value: number; color: string; visible: boolean }[];
      tab?: 'style';
    };

export type CreationMode =
  /** Click each anchor in turn (also accepts press-drag-release for the first two). */
  | 'click'
  /** Press, drag, release — one gesture (brush, highlighter). */
  | 'freehand';

export interface ToolBehavior {
  /** Anchors the user places. Overrides ToolSpec.points when present. */
  points?: number;
  creation?: CreationMode;
  /** TradingView's default look for this tool. Wins over ToolSpec.defaultStyle. */
  defaultStyle?: Partial<DrawingStyle>;
  /** Extra settings beyond colour/width/dash/fill/text, with their defaults. */
  options?: readonly ToolOption[];

  /** `hovered` is true while the pointer is over the drawing (and it is not selected). */
  paint(p: PaintCtx & { selected: boolean; hovered?: boolean; options: Record<string, unknown> }): void;

  /** Screen positions of the grab handles. Defaults to the projected anchors. */
  handles?(p: PaintCtx & { options: Record<string, unknown> }): Pt[];
  /**
   * New anchors after dragging handle `index` to `to`. Defaults to replacing
   * anchor `index`. Needed whenever handles are not the anchors (ellipse
   * perimeter, rectangle corners/edges, fib extension end, position target/stop…).
   */
  moveHandle?(drawing: Drawing, index: number, to: DrawingPoint, geo: ToolGeometry): DrawingPoint[];
  /** Whether screen point `at` touches the drawing. Defaults to geometry.hitTestDrawing. */
  hitTest?(p: PaintCtx & { options: Record<string, unknown> }, at: Pt, tol: number): boolean;
  /**
   * Screen rect of the drawing's text box. When present, double-clicking the
   * drawing edits `style.text` inline in a textarea at this rect instead of
   * opening the Settings dialog.
   */
  textRect?(p: PaintCtx & { options: Record<string, unknown> }): TextRect | null;
  /**
   * Generic inline edit at a point (e.g. a table cell). Takes precedence over
   * `textRect` when it returns an edit for the double-clicked point.
   */
  editAt?(p: PaintCtx & { options: Record<string, unknown> }, at: Pt): InlineEdit | null;
  /**
   * Transient tools (the ruler) vanish on the next chart click or tool change
   * and are never synced to the engine.
   */
  transient?: boolean;
  /**
   * Called once when the drawing is completed, before it is stored. May
   * replace the anchors (e.g. derive a position's target/stop) or seed
   * options (e.g. snapshot source bars).
   */
  onCreate?(
    drawing: Drawing,
    bars: readonly Bar[],
  ): { points?: DrawingPoint[]; options?: Record<string, unknown> } | void;
}

export interface TextRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An inline text edit: where the editor sits, its initial value, and how to apply it. */
export interface InlineEdit {
  rect: TextRect;
  value: string;
  commit(value: string): Partial<Drawing>;
}

export type ToolBehaviorMap = Partial<Record<DrawingKind, ToolBehavior>>;

/** Resolved options: tool defaults overlaid with what the drawing stores. */
export function optionsOf(behavior: ToolBehavior | undefined, drawing: Drawing): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of behavior?.options ?? []) out[o.key] = o.default;
  return { ...out, ...(drawing.options ?? {}) };
}
