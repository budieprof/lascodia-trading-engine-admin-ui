import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { Bar } from '../datafeed/candle-feed.service';
import { DrawingRenderer } from './drawing-renderer';
import type { DrawingStore } from './drawing-store.service';
import { HANDLE_RADIUS, hitHandle, hitTestDrawing, magnetPrice, type Pt } from './geometry';
import { behaviorFor } from './tools/registry';
import { optionsOf, type InlineEdit, type TextRect } from './tools/types';
import { styleFor, toolFor, type Drawing, type DrawingKind, type DrawingPoint } from './model';
import {
  barStepMs,
  byZ,
  effectiveMagnet,
  isDrag,
  isVisibleOn,
  shiftPoints,
  shiftPointsByBars,
  snapAngle,
  type MagnetMode,
} from './drawing-ops';
import { drawingTemplates } from './drawing-templates';

/**
 * The panes drawings can be in besides the price pane (DR-07 / DR-I10): the chart says which built-in study a pane
 * belongs to and which series carries its scale.
 */
export interface DrawingPaneHost {
  /** The study (its uid) whose pane is at `paneIndex` (> 0); null for a pane drawings cannot go in. */
  keyAt(paneIndex: number): string | null;
  /** The series whose scale a study's pane drawings use; null while the study is not drawn. */
  seriesFor(key: string): ISeriesApi<SeriesType> | null;
}

/** A pane's renderer and the series it is bound to ('' = the price pane). */
interface PaneBinding {
  renderer: DrawingRenderer;
  series: ISeriesApi<SeriesType> | null;
}

/** A pane on screen: its plot area's top-left in container coordinates and its size. */
interface PaneBox {
  origin: Pt;
  width: number;
  height: number;
}

/** Tools that read the market's prices or bars (or trade on them): on the price pane only. */
export const PRICE_PANE_ONLY: ReadonlySet<DrawingKind> = new Set<DrawingKind>([
  'long-position',
  'short-position',
  'fixed-range-volume-profile',
  'anchored-volume-profile',
  'anchored-vwap',
  'bars-pattern',
  'ghost-feed',
  'forecast',
]);

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

  /** The pane the drawing being placed is in ('' = price). */
  private pendingPane = '';

  private dragging: {
    id: string;
    /** The pane the dragged drawing is in. */
    pane: string;
    handleIndex: number;
    start: Pt;
    originalPoints: DrawingPoint[];
    /** Ctrl/Cmd held at press on a body: the first movement clones. */
    cloneOnMove: boolean;
    moved: boolean;
    /** A press on one of a multi-selection: every unlocked selected drawing moves with it (DR-I10). */
    group: { id: string; points: DrawingPoint[] }[] | null;
    /** A drawing fixed to the pane (DR-I12): moved by its pane fractions, from these. */
    screen: { ax: number; ay: number } | null;
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
  /** The study panes (DR-07); without it drawings go on the price pane only. */
  paneHost: DrawingPaneHost | null = null;
  /**
   * The account's and the symbol's facts a new Long / Short Position is placed with (DR-I9: equity, account
   * currency, contract size, pip, quote→account rate); null when the chart knows none.
   */
  positionDefaults: (() => Record<string, unknown> | null) | null = null;
  /** Renderers of the study panes that have drawings, by study uid. */
  private readonly panes = new Map<string, PaneBinding>();

  /** Raised when a tool completes, so the toolbar can drop back to the cursor. */
  onToolComplete?: () => void;
  onSelectionChange?: (id: string | null) => void;
  /** Double-click on a drawing: open its Settings dialog. */
  onEditRequest?: (id: string) => void;
  /** Double-click on a text-bearing drawing: edit inline at `rect` (container coordinates). */
  onInlineEdit?: (e: { id: string; rect: TextRect; value: string; commit: (v: string) => Partial<Drawing> }) => void;
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

  /** The renderer of a pane ('' = price); a study pane's is made on first use. */
  private rendererFor(key: string): DrawingRenderer {
    if (!key) return this.renderer;
    return this.bindingFor(key).renderer;
  }

  /** The series whose scale a pane's drawings use. */
  private seriesFor(key: string): ISeriesApi<SeriesType> | null {
    if (!key) return this.series;
    return this.bindingFor(key).series;
  }

  private bindingFor(key: string): PaneBinding {
    let b = this.panes.get(key);
    if (!b) {
      const binding: PaneBinding = { renderer: null as unknown as DrawingRenderer, series: null };
      binding.renderer = new DrawingRenderer(
        () => this.chart,
        () => binding.series,
        () => paneSeriesPrecision(binding.series),
        (t) => this.shift(t),
        () => this.bars,
        (t) => this.unshift(t),
      );
      b = binding;
      this.panes.set(key, b);
      this.bind(key, b);
    }
    return b;
  }

  /** Bind a study pane's renderer to the series its study is drawn with now (none while it is not drawn). */
  private bind(key: string, b: PaneBinding): void {
    const next = this.paneHost?.seriesFor(key) ?? null;
    if (next === b.series) return;
    try {
      b.series?.detachPrimitive(b.renderer);
    } catch {
      // Went with its series.
    }
    b.series = next;
    next?.attachPrimitive(b.renderer);
  }

  /**
   * The studies' series were made again (inputs, style, a pane moved): bind each study pane's drawings to the
   * series drawn now. Cheap when nothing changed.
   */
  rebindPanes(): void {
    for (const [key, b] of this.panes) this.bind(key, b);
  }

  /** Every renderer, the price pane's first. */
  private renderers(): DrawingRenderer[] {
    return [this.renderer, ...[...this.panes.values()].map((b) => b.renderer)];
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
    for (const b of this.panes.values()) {
      try {
        b.series?.detachPrimitive(b.renderer);
      } catch {
        // Went with its series.
      }
      b.series = null;
    }
    this.panes.clear();
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

  /** Delete the selected drawings that are not locked (DR-06). Returns true if any went. */
  deleteSelected(): boolean {
    if (!this.store.removeSelectedUnlocked()) return false;
    this.onSelectionChange?.(null);
    return true;
  }

  /**
   * Render this panel's drawings. Hidden drawings and drawings whose
   * Visibility tab excludes the current resolution are dropped here, so they
   * are neither painted nor hit-tested; the rest paint in visual order.
   */
  sync(drawings: Drawing[], selectedId: string | null, selectedIds: ReadonlySet<string> = new Set()): void {
    const { resolution } = this.scope();
    this.shown = byZ(drawings.filter((d) => isVisibleOn(d, resolution)));
    // Each pane's renderer paints its own drawings, on its own scale (DR-07).
    const byPane = new Map<string, Drawing[]>([['', []]]);
    for (const d of this.shown) {
      const key = d.pane ?? '';
      if (key && !this.paneHost) continue;
      const list = byPane.get(key) ?? [];
      list.push(d);
      byPane.set(key, list);
    }
    for (const key of this.panes.keys()) if (!byPane.has(key)) byPane.set(key, []);
    for (const [key, list] of byPane) this.rendererFor(key).setDrawings(list, selectedId, selectedIds);
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
    for (const r of this.renderers()) r.setPreview(null);
  }

  /**
   * Arrow-key nudge of the selected drawing: sideways by whole bars, vertically
   * by screen pixels converted to price (so a nudge looks the same at any
   * zoom). Locked drawings do not move.
   */
  nudgeSelected(bars: number, pixels: number): boolean {
    const id = this.store.selectedId();
    const d = id ? this.shown.find((x) => x.id === id) : undefined;
    // In its pane's units (DR-07).
    const series = d ? this.seriesFor(d.pane ?? '') : null;
    if (!d || d.locked || !series) return false;
    const y0 = series.priceToCoordinate(d.points[0]?.price ?? 0);
    let dp = 0;
    if (pixels !== 0 && y0 !== null) {
      const p1 = series.coordinateToPrice(y0 + pixels);
      const p0 = series.coordinateToPrice(y0);
      if (p1 !== null && p0 !== null) dp = (p1 as number) - (p0 as number);
    }
    const dt = bars * barStepMs(this.bars);
    if (dt === 0 && dp === 0) return false;
    this.store.update(d.id, {
      points: shiftPointsByBars(
        d.points,
        bars,
        dp,
        (t) => this.renderer.logicalAt(t),
        (l) => this.renderer.timeAtLogical(l),
        dt,
      ),
    });
    return true;
  }

  /** Paste the clipboard drawing here, a few bars/pixels away from its source. */
  paste(): Drawing | null {
    const step = barStepMs(this.bars);
    const pasted = this.store.paste(this.scope(), {
      dt: step * 3,
      dp: this.pricePerPixels(-20, this.store.clipboardPane),
    });
    if (pasted) this.select(pasted.id);
    return pasted;
  }

  private pricePerPixels(px: number, pane = ''): number {
    const s = this.seriesFor(pane);
    if (!s) return 0;
    const a = s.coordinateToPrice(100);
    const b = s.coordinateToPrice(100 + px);
    return a !== null && b !== null ? (b as number) - (a as number) : 0;
  }

  /**
   * A pane's plot area on screen ('' = the price pane): where it starts in the container — below the panes above it,
   * right of a left price scale — and its size. Drawings project into, and pointers are read in, these coordinates.
   */
  private paneBox(key: string): PaneBox | null {
    const chart = this.chart;
    const c = this.container;
    if (!chart || !c) return null;
    let index = 0;
    if (key) {
      try {
        const s = this.seriesFor(key);
        if (!s) return null;
        index = s.getPane().paneIndex();
      } catch {
        return null;
      }
    }
    const el = chart.panes()[index]?.getHTMLElement();
    if (!el) {
      // No pane element (a chart without the panes API): the container is the price pane.
      return index === 0 ? { origin: { x: 0, y: 0 }, width: c.clientWidth, height: c.clientHeight } : null;
    }
    const cr = c.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = chart.priceScale('left').width();
    return {
      origin: { x: r.left - cr.left + left, y: r.top - cr.top },
      width: chart.timeScale().width() || r.width,
      height: r.height,
    };
  }

  /** The point of a pointer event in a pane's own coordinates. */
  private inPane(ev: MouseEvent, key: string): Pt | null {
    const box = this.paneBox(key);
    const rect = this.container?.getBoundingClientRect();
    if (!box || !rect) return null;
    return { x: ev.clientX - rect.left - box.origin.x, y: ev.clientY - rect.top - box.origin.y };
  }

  /**
   * The pane under a pointer event and the point in it (DR-07: the pointer was read through the price series
   * wherever it was, so a click on an RSI pane made a drawing at a price far off the price pane). Null over a pane
   * drawings cannot go in (a script's, a fundamentals pane) or off every pane.
   */
  private paneAt(ev: MouseEvent): { key: string; p: Pt } | null {
    const chart = this.chart;
    const c = this.container;
    if (!chart || !c) return null;
    const panes = chart.panes();
    for (let i = 0; i < panes.length; i++) {
      const el = panes[i].getHTMLElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (ev.clientY < r.top || ev.clientY >= r.bottom) continue;
      const key = i === 0 ? '' : (this.paneHost?.keyAt(i) ?? null);
      if (key === null) return null;
      const p = this.inPane(ev, key);
      return p ? { key, p } : null;
    }
    // No pane elements (a chart without the panes API): the container is the price pane.
    if (!panes.some((pane) => pane.getHTMLElement())) {
      const p = this.inPane(ev, '');
      return p ? { key: '', p } : null;
    }
    return null;
  }

  /** Screen (pane coordinates) → model, applying the magnet in force for this event — on the price pane only. */
  private toModel(p: Pt, magnet: MagnetMode = 'off', pane = ''): DrawingPoint | null {
    const chart = this.chart;
    const series = this.seriesFor(pane);
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

    // The magnet snaps to the bars' prices: meaningless on a study's scale.
    if (magnet === 'off' || pane) return { time: ms, price };

    const bar = nearestBar(this.bars, ms);
    if (magnet === 'strong') {
      // Strong: always the nearest of the bar's OHLC, however far away.
      return { time: bar ? bar.time : ms, price: magnetPrice(price, bar, Number.POSITIVE_INFINITY) };
    }
    // Weak: snap only within a tenth of the visible price range — far enough
    // to feel helpful, near enough not to yank the point somewhere the
    // operator did not click.
    const top = series.coordinateToPrice(0);
    const bottom = series.coordinateToPrice(this.paneBox('')?.height ?? this.container?.clientHeight ?? 0);
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
  private anchorFor(p: Pt, ev: MouseEvent, origin: DrawingPoint | null, pane = ''): DrawingPoint | null {
    if (ev.shiftKey && origin) {
      const o = this.rendererFor(pane).project(origin);
      if (o) return this.toModel(snapAngle(o, p), 'off', pane);
    }
    return this.toModel(p, effectiveMagnet(this.magnetMode, ev.ctrlKey || ev.metaKey), pane);
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
    // The pane under the pointer, and the point in it (DR-07). A drawing being placed stays in the pane it began in.
    const under = this.paneAt(ev);
    const pane = this.pending.length > 0 ? this.pendingPane : (under?.key ?? null);
    const p = pane === null ? null : this.pending.length > 0 ? this.inPane(ev, pane) : under!.p;
    if (this.activeTool && (pane === null || (pane && PRICE_PANE_ONLY.has(this.activeTool)))) {
      // Over a pane drawings cannot go in, or a price-only tool off the price pane: nothing is placed.
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!p || pane === null) {
      if (!this.activeTool) this.select(null);
      return;
    }
    // TV: a ruler measurement goes away on the next click on the chart.
    if (this.transientId && !this.pendingKind) this.clearTransient();

    // Every branch below preventDefaults the pointerdown (so the chart does not pan while a
    // drawing is placed or dragged), and that also stops the browser moving keyboard focus.
    // Take it explicitly, or Delete / Enter / ⌘C / arrow nudges reach nothing after a click.
    (this.container?.closest('[tabindex]') as HTMLElement | null)?.focus({ preventScroll: true });

    // Placing a new drawing.
    if (this.activeTool) {
      const kind = this.activeTool;
      const needed = this.neededPoints(kind);
      const model = this.anchorFor(p, ev, this.pending.at(-1) ?? null, pane);
      ev.preventDefault();
      ev.stopPropagation();
      if (!model) return;
      if (this.pending.length === 0) this.pendingPane = pane;

      // Unlimited-click tools: a click on the first anchor closes and finishes.
      if (needed === Number.POSITIVE_INFINITY && this.pending.length >= 2) {
        const first = this.rendererFor(pane).project(this.pending[0]);
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
      this.rendererFor(pane).setPreview({ drawing: this.previewDrawing(kind, this.pending), cursor: null });
      return;
    }

    // Selecting / starting a drag. Ctrl/Cmd or Shift adds to (or takes out of) the selection (DR-I10);
    // Ctrl/Cmd-DRAG on a body still clones, decided once the pointer moves.
    const hit = this.pick(p, pane);
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (hit && additive && this.store.selectedIds().size > 0 && !this.store.selectedIds().has(hit.id)) {
      this.store.toggleSelected(hit.id);
      this.onSelectionChange?.(this.store.selectedId());
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!hit || !this.store.selectedIds().has(hit.id) || this.store.selectedIds().size < 2) {
      this.select(hit?.id ?? null);
    } else {
      // A press on one of a multi-selection keeps the selection (a drag moves them all).
      this.store.focusInSelection(hit.id);
    }

    if (hit && !hit.drawing.locked) {
      // The undo snapshot is taken on the first MOVE, not here: a click that only selects must not
      // cost the operator their Redo (DR-04).
      const screen = screenAnchorOf(hit.drawing);
      this.dragging = {
        id: hit.id,
        pane,
        screen,
        handleIndex: screen ? -1 : hit.handleIndex,
        start: p,
        originalPoints: hit.drawing.points.map((pt) => ({ ...pt })),
        cloneOnMove: hit.handleIndex < 0 && (ev.ctrlKey || ev.metaKey) && this.store.selectedIds().size < 2,
        moved: false,
        group:
          hit.handleIndex < 0 && this.store.selectedIds().size > 1
            ? this.shown
                .filter((d) => this.store.selectedIds().has(d.id) && !d.locked)
                .map((d) => ({ id: d.id, points: d.points.map((pt) => ({ ...pt })) }))
            : null,
      };
      this.setChartInteractive(false);
      this.setCursor(hit.handleIndex >= 0 ? 'crosshair' : 'grabbing');
      this.container?.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    // Preview the in-progress drawing following the cursor, in the pane it began in.
    if (this.activeTool) {
      this.setCursor('crosshair');
      if (!this.pendingKind || this.pending.length === 0) return;
      const pane = this.pendingPane;
      const p = this.inPane(ev, pane);
      if (!p) return;
      const renderer = this.rendererFor(pane);
      const needed = this.neededPoints(this.pendingKind);
      if (needed === 'freehand') {
        if ((ev.buttons & 1) === 1) {
          const model = this.toModel(p, 'off', pane);
          if (model) this.pending.push(model);
        }
        renderer.setPreview({ drawing: this.previewDrawing(this.pendingKind, this.pending), cursor: null });
        return;
      }
      if (this.press && (ev.buttons & 1) === 1 && isDrag(this.press.at, p)) this.press.dragged = true;
      // Preview through the same snapping the next click will apply, so what
      // is shown is exactly what will be placed.
      const next = this.anchorFor(p, ev, this.pending.at(-1) ?? null, pane);
      const cursor = next ? renderer.project(next) : p;
      renderer.setPreview({
        drawing: this.previewDrawing(this.pendingKind, this.pending),
        cursor: cursor ?? p,
      });
      return;
    }

    if (!this.dragging) {
      // Hover: handles fade in and the cursor says what a press would do.
      if ((ev.buttons & 1) === 1) return;
      const under = this.paneAt(ev);
      const hit = under ? this.pick(under.p, under.key) : null;
      for (const r of this.renderers()) r.setHover(hit?.id ?? null);
      this.setCursor(hit ? (hit.handleIndex >= 0 && !hit.drawing.locked ? 'crosshair' : 'pointer') : null);
      return;
    }

    const drag = this.dragging;
    const p = this.inPane(ev, drag.pane);
    if (!p) return;
    if (!drag.moved && !isDrag(drag.start, p, 2)) return;
    if (!drag.moved) {
      drag.moved = true;
      this.store.beginGesture(drag.id);
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

    const drawing = this.store.forSymbol(this.scope().symbol).find((d) => d.id === drag.id);
    if (!drawing) return;

    if (drag.handleIndex >= 0) {
      // Resize: Shift constrains against the drawing's other anchor (2-point
      // tools); Ctrl/Cmd inverts the magnet, as on TradingView.
      const other =
        drag.originalPoints.length === 2 && drag.handleIndex < 2
          ? drag.originalPoints[1 - drag.handleIndex]
          : null;
      const model = this.anchorFor(p, ev, other, drag.pane);
      if (!model) return;
      // The tool decides what a handle drag means (perimeter handles on an
      // ellipse, edge handles on a rectangle…); by default it moves the
      // grabbed anchor only.
      const behavior = behaviorFor(drawing.kind);
      const handleIndex = drag.handleIndex;
      const renderer = this.rendererFor(drag.pane);
      const points = behavior?.moveHandle
        ? behavior.moveHandle({ ...drawing, points: drag.originalPoints }, handleIndex, model, {
            project: (pt) => renderer.project(pt),
            unproject: (pt) => this.toModel(pt, 'off', drag.pane),
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
      // Fixed to the pane: it moves by the pointer's share of the pane, not by bars and prices (DR-I12).
      if (drag.screen && !drag.group) {
        const box = this.paneBox(drag.pane);
        if (!box || box.width <= 0 || box.height <= 0) return;
        const clamp = (v: number) => Math.min(1, Math.max(0, v));
        this.store.update(
          drawing.id,
          {
            options: {
              ...(drawing.options ?? {}),
              ax: clamp(drag.screen.ax + (to.x - drag.start.x) / box.width),
              ay: clamp(drag.screen.ay + (to.y - drag.start.y) / box.height),
            },
          },
          false,
        );
        return;
      }
      const model = this.toModel(to, 'off', drag.pane);
      const startModel = this.toModel(drag.start, 'off', drag.pane);
      if (!model || !startModel) return;
      const l0 = this.renderer.logicalAt(startModel.time);
      const l1 = this.renderer.logicalAt(model.time);
      const shift = (original: DrawingPoint[]): DrawingPoint[] =>
        l0 !== null && l1 !== null
          ? shiftPointsByBars(
              original,
              l1 - l0,
              model.price - startModel.price,
              (t) => this.renderer.logicalAt(t),
              (l) => this.renderer.timeAtLogical(l),
              model.time - startModel.time,
            )
          : shiftPoints(original, model.time - startModel.time, model.price - startModel.price);
      if (drag.group) {
        const originals = new Map(drag.group.map((g) => [g.id, g.points]));
        this.store.moveMany([...originals.keys()], (d) => shift(originals.get(d.id) ?? d.points));
        return;
      }
      this.store.update(drawing.id, { points: shift(drag.originalPoints) }, false);
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.dragging) {
      // A drag that ended where it started leaves no undo step; a plain click on one of a
      // multi-selection narrows the selection to it, as on TradingView.
      if (this.dragging.moved) this.store.endGesture();
      else if (this.dragging.group) this.select(this.dragging.id);
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
      const p = this.inPane(ev, this.pendingPane);
      const model = p ? this.anchorFor(p, ev, this.pending[0], this.pendingPane) : null;
      if (model) {
        this.pending.push(model);
        if (this.pending.length >= needed) this.commitPending();
      }
    }
  };

  private onPointerLeave = (): void => {
    if (!this.dragging) for (const r of this.renderers()) r.setHover(null);
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
    const under = this.paneAt(ev);
    const hit = under ? this.pick(under.p, under.key) : null;
    if (!hit || !under) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.select(hit.id);
    const edit = hit.drawing.locked ? null : this.inlineEditAt(hit.drawing, under.p, under.key);
    if (edit && this.onInlineEdit) this.onInlineEdit({ id: hit.id, ...edit });
    else this.onEditRequest?.(hit.id);
  };

  /**
   * Inline edit offered by the tool at `p` (pane coordinates): a cell (`editAt`) or its text box (`textRect`), the
   * box in container coordinates — where the editor is laid over the chart.
   */
  private inlineEditAt(d: Drawing, p: Pt, pane = ''): InlineEdit | null {
    const behavior = behaviorFor(d.kind);
    if (!behavior?.editAt && !behavior?.textRect) return null;
    const renderer = this.rendererFor(pane);
    const pts = renderer.projectAll(d);
    if (pts.length === 0) return null;
    const box = this.paneBox(pane);
    const ctx = {
      ...renderer.paintCtx(
        null as unknown as CanvasRenderingContext2D,
        d,
        pts,
        box?.width ?? this.container?.clientWidth ?? 0,
        box?.height ?? this.container?.clientHeight ?? 0,
      ),
      options: optionsOf(behavior, d),
    };
    const toContainer = <T extends { rect: TextRect }>(e: T): T =>
      box ? { ...e, rect: { ...e.rect, x: e.rect.x + box.origin.x, y: e.rect.y + box.origin.y } } : e;
    const cell = behavior.editAt?.(ctx, p);
    if (cell) return toContainer(cell);
    const rect = behavior.textRect?.(ctx);
    if (!rect) return null;
    return toContainer({ rect, value: d.style.text ?? '', commit: (text) => ({ style: { ...d.style, text } }) });
  }

  /** Apply an inline edit's result as one undo step. */
  applyInlineEdit(id: string, patch: Partial<Drawing>): void {
    this.store.update(id, patch);
  }

  /** Right-click: cancels a drawing in progress, else opens the drawing menu. */
  private onContextMenu = (ev: MouseEvent): void => {
    if (this.pending.length > 0 || this.activeTool) {
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelPending();
      return;
    }
    const under = this.paneAt(ev);
    const hit = under ? this.pick(under.p, under.key) : null;
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
    // Fixed to the pane (Anchored Text / Note, DR-I12): where it was placed, as fractions of the pane.
    if (behavior?.screenAnchored && points.length) {
      const px = this.rendererFor(this.pendingPane).project(points[0]);
      const box = this.paneBox(this.pendingPane);
      if (px && box && box.width > 0 && box.height > 0) {
        options = { ...(options ?? {}), ax: px.x / box.width, ay: px.y / box.height };
      }
    }
    // A position is sized from the account it would trade on, not a typed account size (DR-I9).
    if (kind === 'long-position' || kind === 'short-position') {
      const facts = this.positionDefaults?.();
      if (facts) options = { ...(options ?? {}), ...facts };
    }
    const created = this.store.add(kind, points, styleFor(kind, template?.style), this.scope(), {
      options,
      ...(this.pendingPane ? { pane: this.pendingPane } : {}),
    });
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
      ...(this.pendingPane ? { pane: this.pendingPane } : {}),
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
  private pick(p: Pt, pane = ''): { id: string; drawing: Drawing; handleIndex: number } | null {
    // Only the drawings of the pane under the pointer, projected on its scale (DR-07).
    const list = this.shown.filter((d) => (d.pane ?? '') === pane);
    if (!list.length) return null;
    const renderer = this.rendererFor(pane);
    const box = this.paneBox(pane);
    const bounds = {
      width: box?.width ?? this.container?.clientWidth ?? 0,
      height: box?.height ?? this.container?.clientHeight ?? 0,
    };
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      const pts = renderer.projectAll(d);
      if (pts.length === 0) continue;
      const behavior = behaviorFor(d.kind);
      const ctxBase = behavior
        ? {
            ...renderer.paintCtx(null as unknown as CanvasRenderingContext2D, d, pts, bounds.width, bounds.height),
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
      for (const r of this.renderers()) r.setHover(null);
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

/** The price precision a study pane's drawings label their prices with: its series' (2 when it sets none). */
function paneSeriesPrecision(series: ISeriesApi<SeriesType> | null): number {
  try {
    const f = series?.options().priceFormat as { precision?: number } | undefined;
    return typeof f?.precision === 'number' ? f.precision : 2;
  } catch {
    return 2;
  }
}

/** A pane-anchored drawing's fractions (DR-I12); null for one on a bar and a price. */
function screenAnchorOf(d: Drawing): { ax: number; ay: number } | null {
  if (!behaviorFor(d.kind)?.screenAnchored) return null;
  const ax = d.options?.['ax'];
  const ay = d.options?.['ay'];
  return typeof ax === 'number' && typeof ay === 'number' && Number.isFinite(ax) && Number.isFinite(ay)
    ? { ax, ay }
    : null;
}
