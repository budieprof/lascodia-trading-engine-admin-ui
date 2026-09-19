import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { Bar } from '../datafeed/candle-feed.service';
import { DrawingRenderer } from './drawing-renderer';
import type { DrawingStore } from './drawing-store.service';
import { hitHandle, hitTestDrawing, magnetPrice, type Pt } from './geometry';
import { styleFor, toolFor, type Drawing, type DrawingKind, type DrawingPoint } from './model';

/**
 * Pointer interaction for drawings: placing, selecting, moving and resizing.
 *
 * Deliberately NOT inside the Angular component. This is a state machine over
 * raw mouse events with a lot of edge cases, and keeping it out of the
 * component means it can be reasoned about (and later tested) without a chart
 * or a DOM fixture.
 *
 * It owns one rule that matters more than the rest: **while a tool is active or
 * a drag is in progress, the chart's own scroll/scale handlers are turned off.**
 * Without that, dragging a trendline pans the chart underneath it and the line
 * appears to fly away.
 */
export class DrawingController {
  private readonly renderer: DrawingRenderer;

  /** Points already committed for the drawing being placed. */
  private pending: DrawingPoint[] = [];
  private pendingKind: DrawingKind | null = null;

  private dragging: {
    id: string;
    handleIndex: number;
    start: Pt;
    originalPoints: DrawingPoint[];
  } | null = null;

  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private container: HTMLElement | null = null;

  activeTool: DrawingKind | null = null;
  magnet = false;
  bars: Bar[] = [];

  /** Raised when a tool completes, so the toolbar can drop back to the cursor. */
  onToolComplete?: () => void;
  onSelectionChange?: (id: string | null) => void;

  constructor(
    private readonly store: DrawingStore,
    precision: () => number,
  ) {
    this.renderer = new DrawingRenderer(
      () => this.chart,
      () => this.series,
      precision,
    );
  }

  get primitive(): DrawingRenderer {
    return this.renderer;
  }

  attach(chart: IChartApi, container: HTMLElement): void {
    this.detach();
    this.chart = chart;
    this.container = container;
    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('dblclick', this.onDoubleClick);
  }

  /**
   * Bind to the price series, re-binding when it is replaced.
   *
   * Changing chart style REPLACES the series (series type is structural in
   * Lightweight Charts, not an option), and a primitive is attached to a
   * series rather than to the chart — so without re-binding here, switching
   * from candles to line silently drops every drawing off the canvas.
   */
  bindSeries(series: ISeriesApi<SeriesType>): void {
    this.series = series;
    series.attachPrimitive(this.renderer);
  }

  detach(): void {
    const c = this.container;
    if (c) {
      c.removeEventListener('pointerdown', this.onPointerDown);
      c.removeEventListener('pointermove', this.onPointerMove);
      c.removeEventListener('pointerup', this.onPointerUp);
      c.removeEventListener('dblclick', this.onDoubleClick);
    }
    this.chart = null;
    this.series = null;
    this.container = null;
    this.dragging = null;
    this.cancelPending();
  }

  /** Delete the selected drawing, if any and unlocked. Returns true if it went. */
  deleteSelected(): boolean {
    const id = this.store.selectedId();
    if (!id) return false;
    const drawing = this.store.visible().find((d) => d.id === id);
    if (!drawing || drawing.locked) return false;
    this.store.remove(id);
    this.onSelectionChange?.(null);
    return true;
  }

  sync(drawings: Drawing[], selectedId: string | null): void {
    this.renderer.setDrawings(drawings, selectedId);
  }

  /** Cancel a half-placed drawing (Escape, or switching tools). */
  cancelPending(): void {
    this.pending = [];
    this.pendingKind = null;
    this.renderer.setPreview(null);
  }

  private localPoint(ev: PointerEvent | MouseEvent): Pt | null {
    const rect = this.container?.getBoundingClientRect();
    if (!rect) return null;
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /** Screen → model, applying magnet snapping when enabled. */
  private toModel(p: Pt): DrawingPoint | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return null;
    const time = chart.timeScale().coordinateToTime(p.x);
    const price = series.coordinateToPrice(p.y);
    if (time === null || price === null) return null;
    const ms = (time as number) * 1000;

    if (!this.magnet) return { time: ms, price };

    // Snap to the nearest bar's OHLC, within a tenth of the visible price
    // range — far enough to feel helpful, near enough not to yank the point
    // somewhere the operator did not click.
    const bar = nearestBar(this.bars, ms);
    const top = series.coordinateToPrice(0);
    const bottom = series.coordinateToPrice(this.container?.clientHeight ?? 0);
    const span = top !== null && bottom !== null ? Math.abs(top - bottom) : 0;
    const snapped = magnetPrice(price, bar, span * 0.1);
    return { time: bar ? bar.time : ms, price: snapped };
  }

  private setChartInteractive(enabled: boolean): void {
    this.chart?.applyOptions({ handleScroll: enabled, handleScale: enabled });
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const p = this.localPoint(ev);
    if (!p) return;

    // Placing a new drawing.
    if (this.activeTool) {
      const model = this.toModel(p);
      if (!model) return;
      const spec = toolFor(this.activeTool);
      if (!spec) return;

      this.pendingKind = this.activeTool;
      this.pending.push(model);

      if (spec.points !== 'freehand' && this.pending.length >= spec.points) {
        this.commitPending();
      }
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    // Selecting / starting a drag.
    const hit = this.pick(p);
    this.store.selectedId.set(hit?.id ?? null);
    this.onSelectionChange?.(hit?.id ?? null);

    if (hit && !hit.drawing.locked) {
      this.store.beginGesture();
      this.dragging = {
        id: hit.id,
        handleIndex: hit.handleIndex,
        start: p,
        originalPoints: hit.drawing.points.map((pt) => ({ ...pt })),
      };
      this.setChartInteractive(false);
      this.container?.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const p = this.localPoint(ev);
    if (!p) return;

    // Preview the in-progress drawing following the cursor.
    if (this.activeTool && this.pendingKind && this.pending.length > 0) {
      const spec = toolFor(this.pendingKind);
      if (spec?.points === 'freehand' && (ev.buttons & 1) === 1) {
        const model = this.toModel(p);
        if (model) this.pending.push(model);
      }
      this.renderer.setPreview({
        drawing: this.previewDrawing(this.pendingKind, this.pending),
        cursor: p,
      });
      return;
    }

    if (!this.dragging) return;

    const model = this.toModel(p);
    if (!model) return;
    const drawing = this.store.visible().find((d) => d.id === this.dragging?.id);
    if (!drawing) return;

    if (this.dragging.handleIndex >= 0) {
      // Resize: move the grabbed anchor only.
      const points = this.dragging.originalPoints.map((pt, i) =>
        i === this.dragging?.handleIndex ? model : pt,
      );
      this.store.update(drawing.id, { points }, false);
    } else {
      // Move: shift every anchor by the pointer delta, converted in model
      // space so the shape keeps its size under a non-linear price scale.
      const startModel = this.toModel(this.dragging.start);
      if (!startModel) return;
      const dt = model.time - startModel.time;
      const dp = model.price - startModel.price;
      const points = this.dragging.originalPoints.map((pt) => ({
        time: pt.time + dt,
        price: pt.price + dp,
      }));
      this.store.update(drawing.id, { points }, false);
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.dragging) {
      this.dragging = null;
      this.setChartInteractive(true);
      try {
        this.container?.releasePointerCapture(ev.pointerId);
      } catch {
        /* capture may already be gone */
      }
    }

    // Freehand tools finish on release rather than on a click count.
    if (this.activeTool && this.pendingKind) {
      const spec = toolFor(this.pendingKind);
      if (spec?.points === 'freehand' && this.pending.length > 1) this.commitPending();
    }
  };

  /** Double-click completes a freehand path early. */
  private onDoubleClick = (): void => {
    if (this.pendingKind && this.pending.length >= 2) this.commitPending();
  };

  private commitPending(): void {
    if (!this.pendingKind || this.pending.length === 0) return;
    const style = styleFor(this.pendingKind);
    this.store.add(this.pendingKind, this.pending, style);
    this.cancelPending();
    this.activeTool = null;
    this.setChartInteractive(true);
    this.onToolComplete?.();
  }

  private previewDrawing(kind: DrawingKind, points: DrawingPoint[]): Drawing {
    return {
      id: 'preview',
      kind,
      symbol: '',
      resolution: '',
      points,
      style: styleFor(kind),
      locked: false,
      createdAt: 0,
    };
  }

  /**
   * Topmost drawing under the pointer.
   *
   * Iterated newest-first so the most recently drawn object wins an overlap,
   * which is what the operator expects after stacking two shapes. Handles are
   * checked before bodies so a resize always beats a move.
   */
  private pick(p: Pt): { id: string; drawing: Drawing; handleIndex: number } | null {
    const list = this.store.visible();
    const bounds = {
      width: this.container?.clientWidth ?? 0,
      height: this.container?.clientHeight ?? 0,
    };
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      const pts = this.renderer.projectAll(d);
      if (pts.length === 0) continue;
      const handle = hitHandle(p, pts);
      if (handle >= 0) return { id: d.id, drawing: d, handleIndex: handle };
      if (hitTestDrawing(p, d.kind, pts, d.style.fill !== null, bounds)) {
        return { id: d.id, drawing: d, handleIndex: -1 };
      }
    }
    return null;
  }

  setTool(kind: DrawingKind | null): void {
    this.cancelPending();
    this.activeTool = kind;
    // A tool being armed must not also pan the chart on the first click.
    this.setChartInteractive(kind === null);
    if (kind) {
      this.store.selectedId.set(null);
      this.onSelectionChange?.(null);
    }
  }
}

function nearestBar(bars: Bar[], timeMs: number): Bar | null {
  if (bars.length === 0) return null;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < timeMs) lo = mid + 1;
    else hi = mid;
  }
  const candidate = bars[lo];
  const previous = bars[Math.max(0, lo - 1)];
  return Math.abs(candidate.time - timeMs) <= Math.abs(previous.time - timeMs)
    ? candidate
    : previous;
}
