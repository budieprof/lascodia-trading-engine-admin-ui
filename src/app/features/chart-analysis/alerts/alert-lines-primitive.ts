import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  IChartApiBase,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

import { dragPrice, grabbedLine, type AlertLine } from './alert-lines-geometry';

/** A finished drag: the line, and the price it was dropped at (rounded to the symbol's digits). */
export interface AlertLineMove {
  line: AlertLine;
  price: number;
}

/**
 * The chart's price alerts as dashed lines with an axis chip each (alerts v2, SP-I2). An active line can be dragged to a
 * new level: the press is taken in the capture phase so the chart does not pan, scrolling and scaling are switched off
 * for the drag, and the drop is handed to {@link onMove} — the page confirms it before anything is saved, so a slip of
 * the mouse never moves a live alert.
 */
export class AlertLinesPrimitive implements ISeriesPrimitive<Time> {
  private lines: AlertLine[] = [];
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate?: () => void;
  private element: HTMLElement | null = null;
  private hovering = false;
  private drag: {
    line: AlertLine;
    pointerId: number;
    price: number;
    restore: { handleScroll: unknown; handleScale: unknown };
  } | null = null;

  constructor(
    private readonly precision: () => number,
    private readonly onMove: (move: AlertLineMove) => void,
  ) {}

  setLines(lines: AlertLine[]): void {
    this.lines = lines;
    this.requestUpdate?.();
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<SeriesType, Time>;
    this.requestUpdate = param.requestUpdate;
    this.element = param.chart.chartElement();
    this.element.addEventListener('pointerdown', this.onPointerDown, true);
    this.element.addEventListener('pointermove', this.onPointerMove, true);
    this.element.addEventListener('pointerup', this.onPointerUp, true);
    this.element.addEventListener('pointercancel', this.onPointerCancel, true);
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  detached(): void {
    this.cancelDrag();
    this.element?.removeEventListener('pointerdown', this.onPointerDown, true);
    this.element?.removeEventListener('pointermove', this.onPointerMove, true);
    this.element?.removeEventListener('pointerup', this.onPointerUp, true);
    this.element?.removeEventListener('pointercancel', this.onPointerCancel, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    if (this.element && this.hovering) this.element.style.cursor = '';
    this.hovering = false;
    this.element = null;
    this.chart = null;
    this.series = null;
    this.requestUpdate = undefined;
  }

  updateAllViews(): void {
    /* projected per frame in draw() */
  }

  paneViews() {
    return [
      {
        zOrder: () => 'top' as const,
        renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.draw(target) }),
      },
    ];
  }

  priceAxisViews(): ISeriesPrimitiveAxisView[] {
    const series = this.series;
    if (!series) return [];
    return this.drawnLines().map(({ line, price }) => ({
      coordinate: () => series.priceToCoordinate(price) ?? -100,
      text: () => price.toFixed(Math.max(0, this.precision())),
      textColor: () => '#FFFFFF',
      backColor: () => line.color,
      visible: () => series.priceToCoordinate(price) !== null,
      tickVisible: () => true,
    }));
  }

  /** The lines as drawn this frame: the dragged one at its preview price. */
  private drawnLines(): { line: AlertLine; price: number }[] {
    const drag = this.drag;
    return this.lines.map((line) => ({
      line,
      price:
        drag && drag.line.alertId === line.alertId && drag.line.bound === line.bound
          ? drag.price
          : line.price,
    }));
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const series = this.series;
    if (!series || this.lines.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const w = scope.bitmapSize.width / scope.horizontalPixelRatio;
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const { line, price } of this.drawnLines()) {
        const y = series.priceToCoordinate(price);
        if (y === null) continue;
        const dragging =
          this.drag?.line.alertId === line.alertId && this.drag?.line.bound === line.bound;
        ctx.globalAlpha = line.active ? 1 : 0.55;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = dragging ? 2 : 1;
        ctx.setLineDash(dragging ? [8, 4] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        // A label at the right end, left of the price scale — the axis chip carries the price.
        const text = line.label;
        const tw = ctx.measureText(text).width + 10;
        const x = Math.max(0, w - tw - 4);
        ctx.setLineDash([]);
        ctx.fillStyle = line.color;
        ctx.fillRect(x, y - 8, tw, 16);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, x + 5, y);
      }
      ctx.restore();
    });
  }

  // ── Dragging ──────────────────────────────────────────────────────────────

  private paneY(ev: PointerEvent): number | null {
    if (!this.element) return null;
    return ev.clientY - this.element.getBoundingClientRect().top;
  }

  /** The series' price → pixel projection, limited to the price pane (the top one) so a lower pane never grabs. */
  private projection(): ((price: number) => number | null) | null {
    const series = this.series;
    const chart = this.chart;
    if (!series || !chart) return null;
    const height = chart.paneSize(0).height;
    return (price) => {
      const y = series.priceToCoordinate(price);
      return y === null || y < 0 || y > height ? null : y;
    };
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || !this.series || !this.chart) return;
    const y = this.paneY(ev);
    const toY = this.projection();
    if (y === null || !toY) return;
    const line = grabbedLine(this.lines, y, toY);
    if (!line) return;
    // Ours: the chart must not start a pan or a drawing from this press.
    ev.preventDefault();
    ev.stopPropagation();
    const options = this.chart.options() as unknown as {
      handleScroll: unknown;
      handleScale: unknown;
    };
    this.drag = {
      line,
      pointerId: ev.pointerId,
      price: line.price,
      restore: { handleScroll: options.handleScroll, handleScale: options.handleScale },
    };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    try {
      this.element?.setPointerCapture(ev.pointerId);
    } catch {
      /* the pointer is gone already */
    }
    this.requestUpdate?.();
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const series = this.series;
    const y = this.paneY(ev);
    const toY = this.projection();
    if (!series || y === null || !toY) return;
    if (!this.drag) {
      // Hover: show the line can be moved (and give the cursor back only if it was ours).
      const over = !!grabbedLine(this.lines, y, toY);
      if (this.element && over !== this.hovering) {
        this.element.style.cursor = over ? 'ns-resize' : '';
        this.hovering = over;
      }
      return;
    }
    if (ev.pointerId !== this.drag.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();
    const price = dragPrice(y, (py) => series.coordinateToPrice(py), this.precision());
    if (price !== null) {
      this.drag.price = price;
      this.requestUpdate?.();
    }
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.endDrag();
    if (drag.price !== drag.line.price) this.onMove({ line: drag.line, price: drag.price });
  };

  private readonly onPointerCancel = (ev: PointerEvent): void => {
    if (this.drag && ev.pointerId === this.drag.pointerId) this.cancelDrag();
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.drag) {
      ev.stopPropagation();
      this.cancelDrag();
    }
  };

  private cancelDrag(): void {
    if (this.drag) this.endDrag();
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.chart) {
      this.chart.applyOptions({
        handleScroll: drag.restore.handleScroll,
        handleScale: drag.restore.handleScale,
      } as Parameters<IChartApiBase<Time>['applyOptions']>[0]);
    }
    try {
      if (drag) this.element?.releasePointerCapture(drag.pointerId);
    } catch {
      /* not captured */
    }
    this.requestUpdate?.();
  }
}
