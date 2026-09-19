import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import { FIB_LEVELS, type DashStyle, type Drawing } from './model';
import { HANDLE_RADIUS, rectOf, type Pt } from './geometry';

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
export class DrawingRenderer implements ISeriesPrimitive<Time> {
  private drawings: Drawing[] = [];
  private selectedId: string | null = null;
  /** In-progress drawing, rendered as a preview while being placed. */
  private preview: { drawing: Drawing; cursor: Pt | null } | null = null;
  private requestUpdate?: () => void;

  constructor(
    private readonly chart: () => IChartApi | null,
    private readonly series: () => ISeriesApi<SeriesType> | null,
    private readonly precision: () => number,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setDrawings(drawings: Drawing[], selectedId: string | null): void {
    this.drawings = drawings;
    this.selectedId = selectedId;
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

  /** Project a model point to screen space, or null if off the current scale. */
  project(point: { time: number; price: number }): Pt | null {
    const chart = this.chart();
    const series = this.series();
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate((point.time / 1000) as Time);
    const y = series.priceToCoordinate(point.price);
    if (x === null || y === null) return null;
    return { x, y };
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
        this.paint(ctx, drawing, pts, w, h, drawing.id === this.selectedId);
      }

      if (this.preview) {
        const pts = this.projectAll(this.preview.drawing);
        const withCursor = this.preview.cursor ? [...pts, this.preview.cursor] : pts;
        if (withCursor.length > 0) {
          ctx.globalAlpha = 0.75;
          this.paint(ctx, this.preview.drawing, withCursor, w, h, false);
          ctx.globalAlpha = 1;
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
  ): void {
    this.applyStroke(ctx, drawing);
    const [a, b, c] = pts;
    const fill = drawing.style.fill;

    switch (drawing.kind) {
      case 'trend-line':
      case 'measure':
        if (pts.length >= 2) this.line(ctx, a, b);
        if (drawing.kind === 'measure' && pts.length >= 2) this.measureLabel(ctx, drawing, a, b);
        break;

      case 'arrow':
        if (pts.length >= 2) {
          this.line(ctx, a, b);
          this.arrowHead(ctx, a, b, drawing.style.color);
        }
        break;

      case 'ray':
        if (pts.length >= 2) this.line(ctx, a, extend(a, b, w, h));
        break;

      case 'extended-line':
        if (pts.length >= 2) this.line(ctx, extend(b, a, w, h), extend(a, b, w, h));
        break;

      case 'horizontal-line':
        this.line(ctx, { x: 0, y: a.y }, { x: w, y: a.y });
        this.priceTag(ctx, drawing, a.y, w);
        break;

      case 'horizontal-ray':
        if (pts.length >= 2) {
          this.line(ctx, { x: Math.min(a.x, b.x), y: a.y }, { x: w, y: a.y });
          this.priceTag(ctx, drawing, a.y, w);
        } else {
          this.line(ctx, a, { x: w, y: a.y });
        }
        break;

      case 'vertical-line':
        this.line(ctx, { x: a.x, y: 0 }, { x: a.x, y: h });
        break;

      case 'cross-line':
        this.line(ctx, { x: 0, y: a.y }, { x: w, y: a.y });
        this.line(ctx, { x: a.x, y: 0 }, { x: a.x, y: h });
        break;

      case 'parallel-channel':
        if (pts.length >= 2) {
          this.line(ctx, a, b);
          if (pts.length >= 3) {
            const dy = c.y - a.y;
            const a2 = { x: a.x, y: a.y + dy };
            const b2 = { x: b.x, y: b.y + dy };
            this.line(ctx, a2, b2);
            if (fill) {
              ctx.fillStyle = fill;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.lineTo(b2.x, b2.y);
              ctx.lineTo(a2.x, a2.y);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
        break;

      case 'rectangle':
        if (pts.length >= 2) {
          const r = rectOf(a, b);
          if (fill) {
            ctx.fillStyle = fill;
            ctx.fillRect(r.x, r.y, r.w, r.h);
          }
          ctx.strokeRect(r.x, r.y, r.w, r.h);
        }
        break;

      case 'ellipse':
        if (pts.length >= 2) {
          const r = rectOf(a, b);
          ctx.beginPath();
          ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          if (fill) {
            ctx.fillStyle = fill;
            ctx.fill();
          }
          ctx.stroke();
        }
        break;

      case 'triangle':
        if (pts.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(c.x, c.y);
          ctx.closePath();
          if (fill) {
            ctx.fillStyle = fill;
            ctx.fill();
          }
          ctx.stroke();
        } else if (pts.length >= 2) {
          this.line(ctx, a, b);
        }
        break;

      case 'path':
      case 'brush':
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        break;

      case 'fib-retracement':
        if (pts.length >= 2) this.fib(ctx, drawing, a, b, w, false);
        break;

      case 'fib-extension':
        if (pts.length >= 3) this.fib(ctx, drawing, b, c, w, true, a);
        else if (pts.length >= 2) this.line(ctx, a, b);
        break;

      case 'text':
        this.text(ctx, drawing, a);
        break;

      case 'callout':
        if (pts.length >= 2) {
          this.line(ctx, a, b);
          this.text(ctx, drawing, b, true);
        } else {
          this.text(ctx, drawing, a, true);
        }
        break;

      case 'price-range':
        if (pts.length >= 2) this.priceRange(ctx, drawing, a, b);
        break;

      case 'date-range':
        if (pts.length >= 2) this.dateRange(ctx, drawing, a, b, h);
        break;

      case 'long-position':
      case 'short-position':
        if (pts.length >= 2) this.position(ctx, drawing, pts, w);
        break;

      default:
        if (pts.length >= 2) this.line(ctx, a, b);
    }

    ctx.setLineDash([]);
    if (selected) this.handles(ctx, pts, drawing.locked);
  }

  private line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  private arrowHead(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string): void {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const size = 10;
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(
      b.x - size * Math.cos(angle - Math.PI / 7),
      b.y - size * Math.sin(angle - Math.PI / 7),
    );
    ctx.lineTo(
      b.x - size * Math.cos(angle + Math.PI / 7),
      b.y - size * Math.sin(angle + Math.PI / 7),
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Fibonacci levels between two anchors.
   *
   * Retracement measures 0→1 across the anchors; extension projects the same
   * ratios beyond the second leg, which is why it takes a third point.
   */
  private fib(
    ctx: CanvasRenderingContext2D,
    drawing: Drawing,
    a: Pt,
    b: Pt,
    w: number,
    extension: boolean,
    origin?: Pt,
  ): void {
    const left = Math.min(a.x, b.x, origin?.x ?? a.x);
    const span = b.y - a.y;
    ctx.save();
    ctx.font = `${drawing.style.fontSize}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';

    let previousY: number | null = null;
    for (const level of FIB_LEVELS) {
      const y = extension ? b.y + span * level : a.y + span * level;
      if (drawing.style.fill && previousY !== null) {
        ctx.fillStyle = drawing.style.fill;
        ctx.fillRect(left, Math.min(previousY, y), w - left, Math.abs(y - previousY));
      }
      previousY = y;
      ctx.beginPath();
      ctx.strokeStyle = drawing.style.color;
      ctx.lineWidth = level === 0 || level === 1 ? drawing.style.width : 1;
      ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
      ctx.moveTo(left, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (drawing.style.showLabels) {
        ctx.fillStyle = drawing.style.color;
        ctx.fillText(level.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''), left + 4, y - 2);
      }
    }
    ctx.restore();
  }

  private priceTag(ctx: CanvasRenderingContext2D, drawing: Drawing, y: number, w: number): void {
    if (!drawing.style.showLabels) return;
    const price = this.series()?.coordinateToPrice(y);
    if (price === null || price === undefined) return;
    const label = price.toFixed(this.precision());
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = drawing.style.color;
    ctx.fillRect(w - tw - 2, y - 8, tw, 16);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w - tw + 2, y);
    ctx.restore();
  }

  private text(ctx: CanvasRenderingContext2D, drawing: Drawing, at: Pt, boxed = false): void {
    const label = drawing.style.text || 'Text';
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = `${drawing.style.fontSize}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    if (boxed) {
      ctx.fillStyle = drawing.style.fill ?? 'rgba(41,98,255,0.12)';
      ctx.fillRect(at.x - 4, at.y - 11, tw + 8, 22);
      ctx.strokeStyle = drawing.style.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(at.x - 4, at.y - 11, tw + 8, 22);
    }
    ctx.fillStyle = drawing.style.color;
    ctx.fillText(label, at.x, at.y);
    ctx.restore();
  }

  private measureLabel(ctx: CanvasRenderingContext2D, drawing: Drawing, a: Pt, b: Pt): void {
    const series = this.series();
    if (!series || !drawing.style.showLabels) return;
    const p1 = series.coordinateToPrice(a.y);
    const p2 = series.coordinateToPrice(b.y);
    if (p1 === null || p2 === null) return;
    const delta = p2 - p1;
    const pct = p1 !== 0 ? (delta / p1) * 100 : 0;
    this.badge(
      ctx,
      `${delta >= 0 ? '+' : ''}${delta.toFixed(this.precision())}  (${pct.toFixed(2)}%)`,
      { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 14 },
      drawing.style.color,
    );
  }

  private priceRange(ctx: CanvasRenderingContext2D, drawing: Drawing, a: Pt, b: Pt): void {
    const r = rectOf(a, b);
    if (drawing.style.fill) {
      ctx.fillStyle = drawing.style.fill;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    this.measureLabel(ctx, drawing, a, b);
  }

  private dateRange(
    ctx: CanvasRenderingContext2D,
    drawing: Drawing,
    a: Pt,
    b: Pt,
    h: number,
  ): void {
    ctx.save();
    ctx.setLineDash([4, 3]);
    this.line(ctx, { x: a.x, y: 0 }, { x: a.x, y: h });
    this.line(ctx, { x: b.x, y: 0 }, { x: b.x, y: h });
    ctx.restore();
    if (!drawing.style.showLabels) return;
    const chart = this.chart();
    const t1 = chart?.timeScale().coordinateToTime(a.x);
    const t2 = chart?.timeScale().coordinateToTime(b.x);
    if (typeof t1 === 'number' && typeof t2 === 'number') {
      const hours = Math.abs(t2 - t1) / 3600;
      const label = hours >= 48 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
      this.badge(ctx, label, { x: (a.x + b.x) / 2, y: 16 }, drawing.style.color);
    }
  }

  /**
   * Long/short position tool: entry → target → stop, with the R:R that falls
   * out of them. This is the one drawing that states a trade rather than
   * describing the chart, so the ratio is the point of it.
   */
  private position(ctx: CanvasRenderingContext2D, drawing: Drawing, pts: Pt[], w: number): void {
    const [entry, target, stop] = pts;
    const right = Math.max(entry.x, target?.x ?? entry.x, stop?.x ?? entry.x);
    const left = Math.min(entry.x, target?.x ?? entry.x, stop?.x ?? entry.x);
    const boxWidth = Math.max(right - left, 40);

    ctx.save();
    ctx.setLineDash([]);
    if (target) {
      ctx.fillStyle = 'rgba(38,166,154,0.18)';
      ctx.fillRect(left, Math.min(entry.y, target.y), boxWidth, Math.abs(target.y - entry.y));
    }
    if (stop) {
      ctx.fillStyle = 'rgba(239,83,80,0.18)';
      ctx.fillRect(left, Math.min(entry.y, stop.y), boxWidth, Math.abs(stop.y - entry.y));
    }
    ctx.strokeStyle = drawing.style.color;
    ctx.lineWidth = 1;
    this.line(ctx, { x: left, y: entry.y }, { x: left + boxWidth, y: entry.y });
    ctx.restore();

    if (!drawing.style.showLabels || !target || !stop) return;
    const series = this.series();
    if (!series) return;
    const pe = series.coordinateToPrice(entry.y);
    const pt = series.coordinateToPrice(target.y);
    const ps = series.coordinateToPrice(stop.y);
    if (pe === null || pt === null || ps === null) return;
    const reward = Math.abs(pt - pe);
    const risk = Math.abs(pe - ps);
    const rr = risk > 0 ? reward / risk : 0;
    this.badge(
      ctx,
      `R:R ${rr.toFixed(2)}  ·  +${reward.toFixed(this.precision())} / −${risk.toFixed(this.precision())}`,
      { x: left + boxWidth / 2, y: entry.y - 14 },
      drawing.style.color,
    );
  }

  private badge(ctx: CanvasRenderingContext2D, label: string, at: Pt, color: string): void {
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(at.x - tw / 2, at.y - 9, tw, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, at.x, at.y);
    ctx.restore();
  }

  private handles(ctx: CanvasRenderingContext2D, pts: Pt[], locked: boolean): void {
    ctx.save();
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
      // A locked drawing shows its anchors but greys them, so it is obvious
      // why dragging does nothing.
      ctx.fillStyle = locked ? '#787B86' : '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = locked ? '#787B86' : '#2962FF';
      ctx.lineWidth = 2;
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

/** Extend a→b to the edge of the canvas, for rays and extended lines. */
export function extend(a: Pt, b: Pt, w: number, h: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return b;
  // Scale far enough to leave the viewport in any direction; the canvas clips.
  const scale = (Math.abs(w) + Math.abs(h)) * 2;
  const len = Math.hypot(dx, dy);
  return { x: a.x + (dx / len) * scale, y: a.y + (dy / len) * scale };
}
