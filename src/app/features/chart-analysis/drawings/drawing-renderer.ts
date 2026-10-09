import { behaviorFor } from './tools/registry';
import { optionsOf } from './tools/types';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import type { DashStyle, Drawing } from './model';
import { HANDLE_RADIUS, type Pt } from './geometry';
import type { PaintCtx } from './paint-ctx';
import type { Bar } from '../datafeed/candle-feed.service';
import { IMAGE_LOADED_EVENT } from './tools/media';

/**
 * Canvas renderer for every drawing on the chart, as one Lightweight Charts
 * series primitive.
 *
 * One primitive for all drawings rather than one per drawing: the library
 * redraws primitives on every frame of a pan, and attaching a hundred of them
 * means a hundred `paneViews()` round trips per frame. A single renderer walks
 * the list once.
 *
 * Projection happens at draw time, never at store time — `timeToCoordinate`
 * and `priceToCoordinate` are only valid for the current viewport, so the
 * coordinates are recomputed each frame from the `{time, price}` model.
 */
/** TradingView's selection colour on the axes. */
const AXIS_BLUE = '#2962FF';
const AXIS_BAND = 'rgba(41, 98, 255, 0.25)';

export class DrawingRenderer implements ISeriesPrimitive<Time> {
  private drawings: Drawing[] = [];
  private selectedId: string | null = null;
  /** The rest of a multi-selection (DR-I10): drawn selected too, with its handles. */
  private alsoSelected: ReadonlySet<string> = new Set();
  /** Drawing under the pointer: shows its handles faintly, as TradingView does. */
  private hoverId: string | null = null;
  /** In-progress drawing, rendered as a preview while being placed. */
  private preview: { drawing: Drawing; cursor: Pt | null } | null = null;
  private requestUpdate?: () => void;

  /**
   * `shift` converts a stored UTC instant into the instant the chart is
   * actually drawing at, which differs whenever the axis is in a non-UTC
   * timezone. Drawings are stored in UTC — they have to be, or changing the
   * display timezone would rewrite them — so the offset is applied here, at
   * projection time, exactly like the bars.
   */
  constructor(
    private readonly chart: () => IChartApi | null,
    private readonly series: () => ISeriesApi<SeriesType> | null,
    private readonly precision: () => number,
    private readonly shift: (timeMs: number) => number = (t) => t,
    /**
     * Bars for the two volume-profile tools — the only drawings that read
     * market data rather than geometry. Defaulted so every existing call site
     * keeps working: a renderer given no bars draws no profile instead of
     * throwing.
     */
    private readonly bars: () => readonly Bar[] = () => [],
    /**
     * Displayed instant → stored UTC instant. The inverse of `shift`, and the
     * same contract `DrawingController` takes under this name. Only the
     * volume profiles need it — they map a screen x back to the UTC instants
     * the bars are keyed by.
     */
    private readonly unshift: (timeMs: number) => number = (t) => t,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
    // An Image drawing's picture decodes after its first paint: paint again when it has (DR-I12).
    if (typeof window !== 'undefined')
      window.addEventListener(IMAGE_LOADED_EVENT, this.onImageLoaded);
  }

  detached(): void {
    this.requestUpdate = undefined;
    if (typeof window !== 'undefined')
      window.removeEventListener(IMAGE_LOADED_EVENT, this.onImageLoaded);
  }

  private readonly onImageLoaded = (): void => this.requestUpdate?.();

  setDrawings(
    drawings: Drawing[],
    selectedId: string | null,
    alsoSelected: ReadonlySet<string> = new Set(),
  ): void {
    this.drawings = drawings;
    this.selectedId = selectedId;
    this.alsoSelected = alsoSelected;
    this.requestUpdate?.();
  }

  setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.requestUpdate?.();
  }

  setPreview(preview: { drawing: Drawing; cursor: Pt | null } | null): void {
    this.preview = preview;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projection is recomputed inside draw() */
  }

  paneViews() {
    return [
      {
        zOrder: () => 'top' as const,
        renderer: () => ({
          draw: (target: CanvasRenderingTarget2D) => this.draw(target),
        }),
      },
    ];
  }

  // ── Axis labels for the selected drawing ─────────────────────────────────
  // TradingView marks a selected drawing on both scales: a blue label at each handle's price on
  // the price axis and at each handle's time on the time axis, plus a translucent band over the
  // drawing's whole price and time range.

  /** Handle positions of the selected drawing (or the drawing being placed), screen space. */
  private selectedHandles(): Pt[] {
    const d = this.preview?.drawing ?? this.drawings.find((x) => x.id === this.selectedId);
    if (!d) return [];
    const pts = this.projectAll(d);
    if (this.preview?.cursor) pts.push(this.preview.cursor);
    if (pts.length === 0) return [];
    const behavior = behaviorFor(d.kind);
    if (!behavior?.handles || this.preview) return pts;
    const chart = this.chart();
    const el = chart?.chartElement();
    const base = this.paintCtx(
      null as unknown as CanvasRenderingContext2D,
      d,
      pts,
      el?.clientWidth ?? 0,
      el?.clientHeight ?? 0,
    );
    try {
      return behavior.handles({ ...base, options: optionsOf(behavior, d) });
    } catch {
      return pts;
    }
  }

  private axisLabelTime(x: number): string {
    const chart = this.chart();
    let sec = chart?.timeScale().coordinateToTime(x) as number | null | undefined;
    if (sec === null || sec === undefined) {
      const utc = this.timeAtX(x);
      if (utc === null) return '';
      sec = this.shift(utc) / 1000;
    }
    const d = new Date(Number(sec) * 1000);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    const mon = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ][d.getUTCMonth()];
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${day} ${pad(d.getUTCDate())} ${mon} '${String(d.getUTCFullYear()).slice(2)}`;
    // Daily and slower charts label dates only, as TradingView does.
    return this.medianStep() >= 86_400_000
      ? date
      : `${date}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  priceAxisViews() {
    const series = this.series();
    if (!series) return [];
    const seen = new Set<number>();
    return this.selectedHandles()
      .filter((h) => {
        const k = Math.round(h.y);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((h) => {
        const price = series.coordinateToPrice(h.y);
        return {
          coordinate: () => h.y,
          text: () => (price === null ? '' : Number(price).toFixed(this.precision())),
          textColor: () => '#FFFFFF',
          backColor: () => AXIS_BLUE,
          visible: () => price !== null,
          tickVisible: () => true,
        };
      });
  }

  timeAxisViews() {
    const seen = new Set<number>();
    return this.selectedHandles()
      .filter((h) => {
        const k = Math.round(h.x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((h) => ({
        coordinate: () => h.x,
        text: () => this.axisLabelTime(h.x),
        textColor: () => '#FFFFFF',
        backColor: () => AXIS_BLUE,
        visible: () => true,
        tickVisible: () => true,
      }));
  }

  priceAxisPaneViews() {
    return [this.axisBand('y')];
  }

  timeAxisPaneViews() {
    return [this.axisBand('x')];
  }

  private axisBand(axis: 'x' | 'y') {
    return {
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: (target: CanvasRenderingTarget2D) => {
          const hs = this.selectedHandles();
          if (hs.length < 2) return;
          const vals = hs.map((h) => (axis === 'x' ? h.x : h.y));
          const lo = Math.min(...vals);
          const hi = Math.max(...vals);
          if (hi - lo < 1) return;
          target.useBitmapCoordinateSpace(
            ({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
              context.fillStyle = AXIS_BAND;
              if (axis === 'y')
                context.fillRect(
                  0,
                  lo * verticalPixelRatio,
                  bitmapSize.width,
                  (hi - lo) * verticalPixelRatio,
                );
              else
                context.fillRect(
                  lo * horizontalPixelRatio,
                  0,
                  (hi - lo) * horizontalPixelRatio,
                  bitmapSize.height,
                );
            },
          );
        },
      }),
    };
  }

  /** Project a model point to screen space, or null if off the current scale. */
  project(point: { time: number; price: number }): Pt | null {
    const chart = this.chart();
    const series = this.series();
    if (!chart || !series) return null;
    const y = series.priceToCoordinate(point.price);
    if (y === null) return null;
    const x =
      chart.timeScale().timeToCoordinate((this.shift(point.time) / 1000) as Time) ??
      this.xAtTime(point.time);
    if (x === null) return null;
    return { x, y };
  }

  /**
   * Extrapolated x for an instant outside the loaded bars — future anchors
   * (position targets, forecasts) and anchors older than the loaded history.
   * Whole-bar steps from the nearest end, at the current bar spacing.
   */
  xAtTime(timeMs: number): number | null {
    const bars = this.bars();
    const chart = this.chart();
    // Inside the loaded history but between bars (a weekend, a gap, or an anchor moved by
    // time): interpolate between the two neighbouring bars. Extrapolating from the first
    // bar here threw the point far off-screen and tore multi-point shapes apart on drag.
    if (chart && bars.length >= 2 && timeMs > bars[0].time && timeMs < bars[bars.length - 1].time) {
      const i = barIndexBefore(bars, timeMs);
      const a = bars[i];
      const b = bars[i + 1];
      const xa = chart.timeScale().timeToCoordinate((this.shift(a.time) / 1000) as Time);
      const xb = chart.timeScale().timeToCoordinate((this.shift(b.time) / 1000) as Time);
      if (xa !== null && xb !== null)
        return xa + ((timeMs - a.time) / (b.time - a.time)) * (xb - xa);
    }
    const edge = this.edge(timeMs);
    if (!edge) return null;
    return edge.x + ((timeMs - edge.time) / edge.step) * edge.spacing;
  }

  /**
   * Fractional bar index of an instant: whole numbers on bars, fractions between them, and
   * whole-bar steps past either end. Moving a drawing in this space keeps its shape across
   * weekends and session gaps, as TradingView does (it moves drawings by bars, not by time).
   */
  logicalAt(timeMs: number): number | null {
    const bars = this.bars();
    if (bars.length < 2) return null;
    const step = this.medianStep();
    const last = bars.length - 1;
    if (timeMs <= bars[0].time) return (timeMs - bars[0].time) / step;
    if (timeMs >= bars[last].time) return last + (timeMs - bars[last].time) / step;
    const i = barIndexBefore(bars, timeMs);
    return i + (timeMs - bars[i].time) / (bars[i + 1].time - bars[i].time);
  }

  /** Inverse of `logicalAt`. */
  timeAtLogical(l: number): number | null {
    const bars = this.bars();
    if (bars.length < 2) return null;
    const step = this.medianStep();
    const last = bars.length - 1;
    if (l <= 0) return bars[0].time + l * step;
    if (l >= last) return bars[last].time + (l - last) * step;
    const i = Math.floor(l);
    return bars[i].time + (l - i) * (bars[i + 1].time - bars[i].time);
  }

  private medianStep(): number {
    const bars = this.bars();
    const gaps: number[] = [];
    for (let i = Math.max(1, bars.length - 50); i < bars.length; i++)
      gaps.push(bars[i].time - bars[i - 1].time);
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1] || 60_000;
  }

  /** Inverse of `xAtTime`, snapped to whole bars (UTC ms). */
  timeAtX(x: number): number | null {
    const bars = this.bars();
    if (bars.length === 0) return null;
    const last = this.edge(bars[bars.length - 1].time + 1);
    const first = this.edge(bars[0].time - 1);
    const e = last && x >= last.x ? last : first && x <= first.x ? first : last;
    if (!e) return null;
    return e.time + Math.round((x - e.x) / e.spacing) * e.step;
  }

  private edge(timeMs: number): { time: number; x: number; step: number; spacing: number } | null {
    const chart = this.chart();
    const bars = this.bars();
    if (!chart || bars.length < 2) return null;
    const ref = timeMs >= bars[bars.length - 1].time ? bars[bars.length - 1] : bars[0];
    const x = chart.timeScale().timeToCoordinate((this.shift(ref.time) / 1000) as Time);
    if (x === null) return null;
    const spacing = chart.timeScale().options().barSpacing;
    const gaps: number[] = [];
    for (let i = Math.max(1, bars.length - 50); i < bars.length; i++)
      gaps.push(bars[i].time - bars[i - 1].time);
    gaps.sort((a, b) => a - b);
    const step = gaps[gaps.length >> 1] || 60_000;
    return { time: ref.time, x, step, spacing };
  }

  projectAll(drawing: Drawing): Pt[] {
    const out: Pt[] = [];
    for (const p of drawing.points) {
      const pt = this.project(p);
      // A drawing anchored outside the loaded range still has to render its
      // visible part, so a missing projection is skipped rather than aborting
      // the whole shape.
      if (pt) out.push(pt);
    }
    return out;
  }

  private draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const width = scope.bitmapSize.width;
      const height = scope.bitmapSize.height;

      ctx.save();
      ctx.scale(ratio, vRatio);
      const w = width / ratio;
      const h = height / vRatio;

      for (const drawing of this.drawings) {
        const pts = this.projectAll(drawing);
        if (pts.length === 0) continue;
        const selected = drawing.id === this.selectedId || this.alsoSelected.has(drawing.id);
        this.paint(ctx, drawing, pts, w, h, selected, !selected && drawing.id === this.hoverId);
      }

      if (this.preview) {
        const pts = this.projectAll(this.preview.drawing);
        const withCursor = this.preview.cursor ? [...pts, this.preview.cursor] : pts;
        if (withCursor.length > 0) {
          ctx.globalAlpha = 0.75;
          this.paint(ctx, this.preview.drawing, withCursor, w, h, false);
          ctx.globalAlpha = 1;
          // TV shows the anchors already placed while a drawing is in progress.
          this.handles(ctx, withCursor, false);
        }
      }

      ctx.restore();
    });
  }

  private applyStroke(ctx: CanvasRenderingContext2D, drawing: Drawing): void {
    ctx.strokeStyle = drawing.style.color;
    ctx.lineWidth = drawing.style.width;
    ctx.setLineDash(dashArray(drawing.style.dash, drawing.style.width));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  private paint(
    ctx: CanvasRenderingContext2D,
    drawing: Drawing,
    pts: Pt[],
    w: number,
    h: number,
    selected: boolean,
    hovered = false,
  ): void {
    // Every tool paints through its behaviour (tools/registry.ts; a spec holds every kind to one). The old
    // per-kind switch and its painters were unreachable and are gone (DR-21).
    const behavior = behaviorFor(drawing.kind);
    if (!behavior) return;
    this.applyStroke(ctx, drawing);
    const base = this.paintCtx(ctx, drawing, pts, w, h);
    const options = optionsOf(behavior, drawing);
    behavior.paint({ ...base, selected, hovered, options });
    ctx.setLineDash([]);
    if (selected || hovered) {
      this.handles(ctx, behavior.handles?.({ ...base, options }) ?? pts, drawing.locked, !selected);
    }
  }

  /** The painter context every tool receives. */
  paintCtx(
    ctx: CanvasRenderingContext2D,
    drawing: Drawing,
    pts: Pt[],
    width: number,
    height: number,
  ): PaintCtx {
    return {
      ctx,
      drawing,
      pts,
      width,
      height,
      priceAt: (y) => this.series()?.coordinateToPrice(y) ?? null,
      precision: this.precision(),
      bars: this.bars(),
      // Inverse of `project`'s x half. The library hands back seconds, and the
      // axis may be shifted for a non-UTC timezone, so undo the shift to land
      // back on the UTC instants the bars are keyed by.
      timeAt: (x) => {
        const t = this.chart()?.timeScale().coordinateToTime(x);
        if (t === null || t === undefined) return null;
        return this.unshift(Number(t) * 1000);
      },
    };
  }

  /**
   * TradingView anchor handles: white disc, 1.5px #2962FF ring. Hover draws
   * them at reduced opacity; a locked drawing greys the ring so it is obvious
   * why dragging does nothing.
   */
  private handles(ctx: CanvasRenderingContext2D, pts: Pt[], locked: boolean, faint = false): void {
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = faint ? 0.55 : 1;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = locked ? '#787B86' : '#2962FF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function dashArray(dash: DashStyle, width: number): number[] {
  if (dash === 'dashed') return [width * 3, width * 2];
  if (dash === 'dotted') return [1, width * 2];
  return [];
}

/** Index of the last bar at or before `timeMs` (bars ascending, time inside the range). */
function barIndexBefore(bars: readonly { time: number }[], timeMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= timeMs) lo = mid;
    else hi = mid;
  }
  return lo;
}
