import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { Bar } from '../datafeed/candle-feed.service';
import { DrawingRenderer } from './drawing-renderer';
import type { DrawingStore } from './drawing-store.service';
import { HANDLE_RADIUS, hitHandle, hitTestDrawing, magnetPrice, type Pt } from './geometry';
import { behaviorFor } from './tools/registry';
import { optionsOf } from './tools/types';
import { styleFor, toolFor, type Drawing, type DrawingKind, type DrawingPoint } from './model';
import {
  barStepMs,
  byZ,
  effectiveMagnet,
  isDrag,
  isVisibleOn,
  shiftPoints,
  snapAngle,
  type MagnetMode,
} from './drawing-ops';
import { drawingTemplates } from './drawing-templates';

/**
 * Pointer interaction for drawings: placing, selecting, moving and resizing —
 * TradingView's rules throughout.
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
 *
 * TradingView behaviours implemented here:
 *  - click each anchor with a live preview, or press-drag-release for the
 *    first two anchors in one gesture;
 *  - Shift constrains the segment being placed/dragged to 0/45/90°;
 *  - right-click cancels a drawing in progress; Esc (page) does too;
 *  - the new drawing is selected and the tool drops back to the cursor unless
 *    "Stay in drawing mode" is on;
 *  - magnet weak/strong, Ctrl/Cmd temporarily inverting it;
 *  - hover shows the drawing's handles and a pointer cursor;
 *  - Ctrl/Cmd-drag on a body clones it and moves the clone;
 *  - locked drawings select but never move;
 *  - double-click opens settings, right-click opens the drawing menu.
 */
export class DrawingController {
  private readonly renderer: DrawingRenderer;

  /** Points already committed for the drawing being placed. */
  private pending: DrawingPoint[] = [];
  private pendingKind: DrawingKind | null = null;
  /** The press that may turn into a press-drag-release creation. */
  private press: { at: Pt; dragged: boolean } | null = null;

  private dragging: {
    id: string;
    handleIndex: number;
    start: Pt;
    originalPoints: DrawingPoint[];
    /** Ctrl/Cmd held at press on a body: the first movement clones. */
    cloneOnMove: boolean;
    moved: boolean;
  } | null = null;

  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private container: HTMLElement | null = null;
  /** A transient drawing (ruler) that disappears on the next click or tool change. */
  private transientId: string | null = null;
  /** What the renderer is showing: visible on this resolution, in z order. */
  private shown: Drawing[] = [];

  activeTool: DrawingKind | null = null;
  magnetMode: MagnetMode = 'off';
  /** TV "Stay in drawing mode": the tool stays armed after a drawing completes. */
  stayInDrawingMode = false;
  bars: Bar[] = [];

  /** Raised when a tool completes, so the toolbar can drop back to the cursor. */
  onToolComplete?: () => void;
  onSelectionChange?: (id: string | null) => void;
  /** Double-click on a drawing: open its Settings dialog. */
  onEditRequest?: (id: string) => void;
  /** Right-click on a drawing: open the drawing menu at these client coordinates. */
  onDrawingContextMenu?: (e: { id: string; clientX: number; clientY: number }) => void;

  /** Back-compat boolean for callers that only know on/off. */
  get magnet(): boolean {
    return this.magnetMode !== 'off';
  }
  set magnet(on: boolean) {
    this.magnetMode = on ? (this.magnetMode === 'off' ? 'weak' : this.magnetMode) : 'off';
  }

  constructor(
    private readonly store: DrawingStore,
    precision: () => number,
    /** This panel's symbol + timeframe, so drawings land on the right chart. */
    private readonly scope: () => { symbol: string; resolution: string },
    /** Stored UTC instant → displayed instant (timezone offset). */
    private readonly shift: (timeMs: number) => number = (t) => t,
    /** Displayed instant → stored UTC instant. The inverse of `shift`. */
    private readonly unshift: (timeMs: number) => number = (t) => t,
  ) {
    this.renderer = new DrawingRenderer(
      () => this.chart,
      () => this.series,
      precision,
      (t) => this.shift(t),
      // The same bars the magnet snaps to, so a volume profile and a magnet
      // snap can never disagree about what was traded.
      () => this.bars,
      (t) => this.unshift(t),
    );
  }

  get primitive(): DrawingRenderer {
    return this.renderer;
  }

  attach(chart: IChartApi, container: HTMLElement): void {
    this.detach();
    this.chart = chart;
    this.container = container;
    ensureCursorStyles();
    // CAPTURE phase, deliberately. Lightweight Charts attaches its own pointer
    // handlers to the canvas inside this container and stops the event there,
    // so a bubble-phase listener never sees a click that lands on the chart —
    // which is every click that matters. Capturing also makes an armed tool
    // authoritative over the chart's pan/zoom, which is the behaviour we want:
    // the first click of a trendline must place a point, not start a drag.
    container.addEventListener('pointerdown', this.onPointerDown, true);
    container.addEventListener('pointermove', this.onPointerMove, true);
    container.addEventListener('pointerup', this.onPointerUp, true);
    container.addEventListener('pointerleave', this.onPointerLeave, true);
    container.addEventListener('dblclick', this.onDoubleClick, true);
    container.addEventListener('contextmenu', this.onContextMenu, true);
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
      c.removeEventListener('pointerdown', this.onPointerDown, true);
      c.removeEventListener('pointermove', this.onPointerMove, true);
      c.removeEventListener('pointerup', this.onPointerUp, true);
      c.removeEventListener('pointerleave', this.onPointerLeave, true);
      c.removeEventListener('dblclick', this.onDoubleClick, true);
      c.removeEventListener('contextmenu', this.onContextMenu, true);
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
    const { symbol, resolution } = this.scope();
    const drawing = this.store.forScope(symbol, resolution).find((d) => d.id === id);
    if (!drawing || drawing.locked) return false;
    this.store.remove(id);
    this.onSelectionChange?.(null);
    return true;
  }

  /**
   * Render this panel's drawings. Hidden drawings and drawings whose
   * Visibility tab excludes the current resolution are dropped here, so they
   * are neither painted nor hit-tested; the rest paint in visual order.
   */
  sync(drawings: Drawing[], selectedId: string | null): void {
    const { resolution } = this.scope();
    this.shown = byZ(drawings.filter((d) => isVisibleOn(d, resolution)));
    this.renderer.setDrawings(this.shown, selectedId);
  }

  /** Whether a drawing is being placed right now. */
  get isPlacing(): boolean {
    return this.pending.length > 0;
  }

  /** Cancel a half-placed drawing (Escape, right-click, or switching tools). */
  cancelPending(): void {
    this.pending = [];
    this.pendingKind = null;
    this.press = null;
    this.renderer.setPreview(null);
  }

  /**
   * Arrow-key nudge of the selected drawing: sideways by whole bars, vertically
   * by screen pixels converted to price (so a nudge looks the same at any
   * zoom). Locked drawings do not move.
   */
  nudgeSelected(bars: number, pixels: number): boolean {
    const id = this.store.selectedId();
    const d = id ? this.shown.find((x) => x.id === id) : undefined;
    if (!d || d.locked || !this.series) return false;
    const y0 = this.series.priceToCoordinate(d.points[0]?.price ?? 0);
    let dp = 0;
    if (pixels !== 0 && y0 !== null) {
      const p1 = this.series.coordinateToPrice(y0 + pixels);
      const p0 = this.series.coordinateToPrice(y0);
      if (p1 !== null && p0 !== null) dp = (p1 as number) - (p0 as number);
    }
    const dt = bars * barStepMs(this.bars);
    if (dt === 0 && dp === 0) return false;
    this.store.update(d.id, { points: shiftPoints(d.points, dt, dp) });
    return true;
  }

  /** Paste the clipboard drawing here, a few bars/pixels away from its source. */
  paste(): Drawing | null {
    const step = barStepMs(this.bars);
    const pasted = this.store.paste(this.scope(), { dt: step * 3, dp: this.pricePerPixels(-20) });
    if (pasted) this.select(pasted.id);
    return pasted;
  }

  private pricePerPixels(px: number): number {
    const s = this.series;
    if (!s) return 0;
    const a = s.coordinateToPrice(100);
    const b = s.coordinateToPrice(100 + px);
    return a !== null && b !== null ? (b as number) - (a as number) : 0;
  }

  private localPoint(ev: PointerEvent | MouseEvent): Pt | null {
    const rect = this.container?.getBoundingClientRect();
    if (!rect) return null;
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /** Screen → model, applying the magnet in force for this event. */
  private toModel(p: Pt, magnet: MagnetMode = 'off'): DrawingPoint | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return null;
    const time = chart.timeScale().coordinateToTime(p.x);
    const price = series.coordinateToPrice(p.y);
    if (price === null) return null;
    // Back to UTC before it is stored: the click lands on the DISPLAYED axis,
    // and storing that instant would bake the current timezone into the
    // drawing. Past either end of the loaded bars there is no time under the
    // pointer, so it is extrapolated by whole bars (future anchors for
    // positions and forecasts).
    const ms = time !== null ? this.unshift((time as number) * 1000) : this.renderer.timeAtX(p.x);
    if (ms === null) return null;

    if (magnet === 'off') return { time: ms, price };

    const bar = nearestBar(this.bars, ms);
    if (magnet === 'strong') {
      // Strong: always the nearest of the bar's OHLC, however far away.
      return { time: bar ? bar.time : ms, price: magnetPrice(price, bar, Number.POSITIVE_INFINITY) };
    }
    // Weak: snap only within a tenth of the visible price range — far enough
    // to feel helpful, near enough not to yank the point somewhere the
    // operator did not click.
    const top = series.coordinateToPrice(0);
    const bottom = series.coordinateToPrice(this.container?.clientHeight ?? 0);
    const span = top !== null && bottom !== null ? Math.abs(top - bottom) : 0;
    const snapped = magnetPrice(price, bar, span * 0.1);
    return { time: bar ? bar.time : ms, price: snapped };
  }

  /**
   * The model point for a pointer event while placing or dragging: Shift
   * snaps the segment from `origin` to 45° steps (and bypasses the magnet,
   * which would otherwise pull it off the constrained line); otherwise the
   * magnet in force applies, Ctrl/Cmd inverting it.
   */
  private anchorFor(p: Pt, ev: MouseEvent, origin: DrawingPoint | null): DrawingPoint | null {
    if (ev.shiftKey && origin) {
      const o = this.renderer.project(origin);
      if (o) return this.toModel(snapAngle(o, p));
    }
    return this.toModel(p, effectiveMagnet(this.magnetMode, ev.ctrlKey || ev.metaKey));
  }

  private setChartInteractive(enabled: boolean): void {
    this.chart?.applyOptions({ handleScroll: enabled, handleScale: enabled });
  }

  private setCursor(cursor: 'default' | 'pointer' | 'grabbing' | 'crosshair' | 'move' | null): void {
    const c = this.container;
    if (!c) return;
    if (cursor) c.setAttribute('data-draw-cursor', cursor);
    else c.removeAttribute('data-draw-cursor');
  }

  private select(id: string | null): void {
    this.store.selectedId.set(id);
    this.onSelectionChange?.(id);
  }

  /**
   * Anchors a tool needs: a count, 'freehand' (drag-collect, finish on
   * release) or Infinity (a point per click until double-click / Enter / a
   * click on the first point). The behaviour wins over the ToolSpec.
   */
  private neededPoints(kind: DrawingKind): number | 'freehand' {
    const spec = toolFor(kind);
    const behavior = behaviorFor(kind);
    if (behavior?.creation === 'freehand') return 'freehand';
    if (behavior?.points !== undefined) return behavior.points;
    if (behavior?.creation === 'click' && (spec?.points === 'multi' || spec?.points === 'freehand')) {
      return Number.POSITIVE_INFINITY;
    }
    if (spec?.points === 'multi') return Number.POSITIVE_INFINITY;
    return spec?.points ?? 2;
  }

  /** Finish an unlimited-click drawing (double-click, Enter). Returns whether one was. */
  finishPending(): boolean {
    if (!this.pendingKind || this.pending.length < 2) return false;
    this.commitPending();
    return true;
  }

  /** Drop the live transient drawing (ruler), if any. Not an undoable edit. */
  private clearTransient(): void {
    const id = this.transientId;
    if (!id) return;
    this.transientId = null;
    if (this.store.selectedId() === id) this.select(null);
    this.store.remove(id, false);
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const p = this.localPoint(ev);
    if (!p) return;
    // TV: a ruler measurement goes away on the next click on the chart.
    if (this.transientId && !this.pendingKind) this.clearTransient();

    // Placing a new drawing.
    if (this.activeTool) {
      const kind = this.activeTool;
      const needed = this.neededPoints(kind);
      const model = this.anchorFor(p, ev, this.pending.at(-1) ?? null);
      ev.preventDefault();
      ev.stopPropagation();
      if (!model) return;

      // Unlimited-click tools: a click on the first anchor closes and finishes.
      if (needed === Number.POSITIVE_INFINITY && this.pending.length >= 2) {
        const first = this.renderer.project(this.pending[0]);
        if (first && Math.hypot(first.x - p.x, first.y - p.y) <= HANDLE_RADIUS + 2) {
          this.commitPending({ closed: true });
          return;
        }
      }
      this.pendingKind = kind;
      this.pending.push(model);
      if (needed === 'freehand') {
        this.container?.setPointerCapture(ev.pointerId);
        return;
      }
      if (this.pending.length >= needed) {
        this.commitPending();
        return;
      }
      // The first anchor of a multi-point tool may become a press-drag-release.
      if (this.pending.length === 1) {
        this.press = { at: p, dragged: false };
        this.container?.setPointerCapture(ev.pointerId);
      }
      this.renderer.setPreview({ drawing: this.previewDrawing(kind, this.pending), cursor: null });
      return;
    }

    // Selecting / starting a drag.
    const hit = this.pick(p);
    this.select(hit?.id ?? null);

    if (hit && !hit.drawing.locked) {
      this.store.beginGesture();
      this.dragging = {
        id: hit.id,
        handleIndex: hit.handleIndex,
        start: p,
        originalPoints: hit.drawing.points.map((pt) => ({ ...pt })),
        cloneOnMove: hit.handleIndex < 0 && (ev.ctrlKey || ev.metaKey),
        moved: false,
      };
      this.setChartInteractive(false);
      this.setCursor(hit.handleIndex >= 0 ? 'crosshair' : 'grabbing');
      this.container?.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const p = this.localPoint(ev);
    if (!p) return;

    // Preview the in-progress drawing following the cursor.
    if (this.activeTool) {
      this.setCursor('crosshair');
      if (!this.pendingKind || this.pending.length === 0) return;
      const needed = this.neededPoints(this.pendingKind);
      if (needed === 'freehand') {
        if ((ev.buttons & 1) === 1) {
          const model = this.toModel(p);
          if (model) this.pending.push(model);
        }
        this.renderer.setPreview({ drawing: this.previewDrawing(this.pendingKind, this.pending), cursor: null });
        return;
      }
      if (this.press && (ev.buttons & 1) === 1 && isDrag(this.press.at, p)) this.press.dragged = true;
      // Preview through the same snapping the next click will apply, so what
      // is shown is exactly what will be placed.
      const next = this.anchorFor(p, ev, this.pending.at(-1) ?? null);
      const cursor = next ? this.renderer.project(next) : p;
      this.renderer.setPreview({
        drawing: this.previewDrawing(this.pendingKind, this.pending),
        cursor: cursor ?? p,
      });
      return;
    }

    if (!this.dragging) {
      // Hover: handles fade in and the cursor says what a press would do.
      if ((ev.buttons & 1) === 1) return;
      const hit = this.pick(p);
      this.renderer.setHover(hit?.id ?? null);
      this.setCursor(hit ? (hit.handleIndex >= 0 && !hit.drawing.locked ? 'crosshair' : 'pointer') : null);
      return;
    }

    const drag = this.dragging;
    if (!drag.moved && !isDrag(drag.start, p, 2)) return;
    if (!drag.moved) {
      drag.moved = true;
      if (drag.cloneOnMove) {
        // Ctrl/Cmd-drag: the ORIGINAL stays put and a clone follows the
        // pointer. The clone joins the gesture snapshot taken at press, so one
        // undo removes it.
        const copy = this.store.clone(drag.id, drag.originalPoints, false);
        if (copy) {
          drag.id = copy.id;
          this.select(copy.id);
        }
      }
    }

    const { symbol, resolution } = this.scope();
    const drawing = this.store.forScope(symbol, resolution).find((d) => d.id === drag.id);
    if (!drawing) return;

    if (drag.handleIndex >= 0) {
      // Resize: Shift constrains against the drawing's other anchor (2-point
      // tools); Ctrl/Cmd inverts the magnet, as on TradingView.
      const other =
        drag.originalPoints.length === 2 && drag.handleIndex < 2
          ? drag.originalPoints[1 - drag.handleIndex]
          : null;
      const model = this.anchorFor(p, ev, other);
      if (!model) return;
      // The tool decides what a handle drag means (perimeter handles on an
      // ellipse, edge handles on a rectangle…); by default it moves the
      // grabbed anchor only.
      const behavior = behaviorFor(drawing.kind);
      const handleIndex = drag.handleIndex;
      const points = behavior?.moveHandle
        ? behavior.moveHandle({ ...drawing, points: drag.originalPoints }, handleIndex, model, {
            project: (pt) => this.renderer.project(pt),
            unproject: (pt) => this.toModel(pt),
          })
        : drag.originalPoints.map((pt, i) => (i === handleIndex ? model : pt));
      this.store.update(drawing.id, { points }, false);
    } else {
      // Move: shift every anchor by the pointer delta, converted in model
      // space so the shape keeps its size under a non-linear price scale.
      // Shift locks the move to the dominant axis.
      let to = p;
      if (ev.shiftKey) {
        const dx = Math.abs(p.x - drag.start.x);
        const dy = Math.abs(p.y - drag.start.y);
        to = dx >= dy ? { x: p.x, y: drag.start.y } : { x: drag.start.x, y: p.y };
      }
      const model = this.toModel(to);
      const startModel = this.toModel(drag.start);
      if (!model || !startModel) return;
      const points = shiftPoints(drag.originalPoints, model.time - startModel.time, model.price - startModel.price);
      this.store.update(drawing.id, { points }, false);
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.dragging) {
      this.dragging = null;
      this.setChartInteractive(true);
      this.setCursor('pointer');
      try {
        this.container?.releasePointerCapture(ev.pointerId);
      } catch {
        /* capture may already be gone */
      }
      return;
    }

    try {
      this.container?.releasePointerCapture(ev.pointerId);
    } catch {
      /* not captured */
    }
    if (!this.activeTool || !this.pendingKind) return;
    const needed = this.neededPoints(this.pendingKind);

    // Freehand tools finish on release rather than on a click count.
    if (needed === 'freehand') {
      if (this.pending.length > 1) this.commitPending();
      return;
    }

    // Press-drag-release: the release places the second anchor.
    const press = this.press;
    this.press = null;
    if (press?.dragged && this.pending.length === 1) {
      const p = this.localPoint(ev);
      const model = p ? this.anchorFor(p, ev, this.pending[0]) : null;
      if (model) {
        this.pending.push(model);
        if (this.pending.length >= needed) this.commitPending();
      }
    }
  };

  private onPointerLeave = (): void => {
    if (!this.dragging) this.renderer.setHover(null);
  };

  /** Double-click finishes a multi-point drawing, or opens a drawing's settings. */
  private onDoubleClick = (ev: MouseEvent): void => {
    if (this.pendingKind) {
      // The dblclick's two clicks each added the same point; drop the duplicate.
      const [a, b] = this.pending.slice(-2);
      if (a && b && a.time === b.time && Math.abs(a.price - b.price) < 1e-12) this.pending.pop();
      if (this.pending.length >= 2) this.commitPending();
      return;
    }
    if (this.activeTool) return;
    const p = this.localPoint(ev);
    const hit = p ? this.pick(p) : null;
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.select(hit.id);
    this.onEditRequest?.(hit.id);
  };

  /** Right-click: cancels a drawing in progress, else opens the drawing menu. */
  private onContextMenu = (ev: MouseEvent): void => {
    if (this.pending.length > 0 || this.activeTool) {
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelPending();
      return;
    }
    const p = this.localPoint(ev);
    const hit = p ? this.pick(p) : null;
    if (!hit) return; // empty chart: the page's chart menu handles it
    ev.preventDefault();
    ev.stopPropagation();
    this.select(hit.id);
    this.onDrawingContextMenu?.({ id: hit.id, clientX: ev.clientX, clientY: ev.clientY });
  };

  private commitPending(flags?: { closed?: boolean }): void {
    if (!this.pendingKind || this.pending.length === 0) return;
    const kind = this.pendingKind;
    const template = drawingTemplates.getDefault(kind);
    const behavior = behaviorFor(kind);
    let points = this.pending;
    let options = template?.options;
    if (flags?.closed) options = { ...(options ?? {}), closed: true };
    // Creation hook: a tool may derive anchors (position target/stop) or
    // snapshot data (bars pattern) at the moment it is completed.
    const hook = behavior?.onCreate?.(this.previewDrawing(kind, points), this.bars);
    if (hook) {
      if (hook.points) points = hook.points;
      if (hook.options) options = { ...(options ?? {}), ...hook.options };
    }
    const created = this.store.add(kind, points, styleFor(kind, template?.style), this.scope(), { options });
    if (behavior?.transient) {
      this.clearTransient();
      this.transientId = created.id;
    }
    this.cancelPending();
    if (this.stayInDrawingMode) return;
    this.activeTool = null;
    this.setChartInteractive(true);
    this.setCursor(null);
    this.select(created.id);
    this.onToolComplete?.();
  }

  private previewDrawing(kind: DrawingKind, points: DrawingPoint[]): Drawing {
    const template = drawingTemplates.getDefault(kind);
    return {
      id: 'preview',
      kind,
      symbol: '',
      resolution: '',
      points,
      style: styleFor(kind, template?.style),
      options: template?.options,
      locked: false,
      createdAt: 0,
    };
  }

  /**
   * Topmost drawing under the pointer.
   *
   * Iterated top of the visual order first, so whatever paints on top wins an
   * overlap. Handles are checked before bodies so a resize always beats a
   * move. Hidden / interval-excluded drawings are not in `shown` and so can
   * never be grabbed.
   */
  private pick(p: Pt): { id: string; drawing: Drawing; handleIndex: number } | null {
    const list = this.shown;
    const bounds = {
      width: this.container?.clientWidth ?? 0,
      height: this.container?.clientHeight ?? 0,
    };
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      const pts = this.renderer.projectAll(d);
      if (pts.length === 0) continue;
      const behavior = behaviorFor(d.kind);
      const ctxBase = behavior
        ? {
            ...this.renderer.paintCtx(null as unknown as CanvasRenderingContext2D, d, pts, bounds.width, bounds.height),
            options: optionsOf(behavior, d),
          }
        : null;
      const handlePts = behavior?.handles && ctxBase ? behavior.handles(ctxBase) : pts;
      const handle = hitHandle(p, handlePts);
      if (handle >= 0) return { id: d.id, drawing: d, handleIndex: handle };
      const hit =
        behavior?.hitTest && ctxBase
          ? behavior.hitTest(ctxBase, p, 6)
          : hitTestDrawing(p, d.kind, pts, d.style.fill !== null, bounds);
      if (hit) {
        return { id: d.id, drawing: d, handleIndex: -1 };
      }
    }
    return null;
  }

  setTool(kind: DrawingKind | null): void {
    this.cancelPending();
    this.clearTransient();
    this.activeTool = kind;
    // A tool being armed must not also pan the chart on the first click.
    this.setChartInteractive(kind === null);
    this.setCursor(kind ? 'crosshair' : null);
    if (kind) {
      this.renderer.setHover(null);
      this.select(null);
    }
  }
}

/**
 * Lightweight Charts sets its own cursor on the canvases it owns, so a cursor
 * on the container alone is overridden. One global rule keyed on a data
 * attribute wins over it for the container and everything inside.
 */
function ensureCursorStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('draw-cursor-styles')) return;
  const style = document.createElement('style');
  style.id = 'draw-cursor-styles';
  style.textContent = ['pointer', 'grabbing', 'crosshair', 'move', 'default']
    .map((c) => `[data-draw-cursor="${c}"], [data-draw-cursor="${c}"] * { cursor: ${c} !important; }`)
    .join('\n');
  document.head.appendChild(style);
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
