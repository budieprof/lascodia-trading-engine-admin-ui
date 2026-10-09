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

import { grabbedTradeLine, tradeDragPrice, type TradeLine } from './trade-lines';

/** A finished drag: the line, and the price it was dropped at (rounded to the symbol's digits). */
export interface TradeLineMove {
  line: TradeLine;
  price: number;
}

/** Pixels a press may move and still count as a click on a clickable line. */
const CLICK_SLOP_PX = 3;

/**
 * Trading lines on the price pane (SP-I3 / SP-I4), on the alerts' draggable-line pattern: the press is taken in the
 * capture phase so the chart does not pan, scrolling and scaling are off for the drag, Escape cancels, and the drop is
 * handed to {@link onMove} — the page confirms a position or order change before anything is sent; a ticket bracket
 * just moves the ticket (the ticket's Submit is its confirmation).
 *
 * Lines with `drawn: false` (a position's stop, an order's price — the trade layer's overlay draws them) are only made
 * grabbable here, and drawn while they move.
 */
export class TradeLinesPrimitive implements ISeriesPrimitive<Time> {
  private lines: TradeLine[] = [];
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate?: () => void;
  private element: HTMLElement | null = null;
  private hovering = false;
  private drag: {
    line: TradeLine;
    pointerId: number;
    price: number;
    restore: { handleScroll: unknown; handleScale: unknown };
  } | null = null;

  private press: { line: TradeLine; pointerId: number; y: number } | null = null;

  constructor(
    private readonly precision: () => number,
    private readonly onMove: (move: TradeLineMove) => void,
    private readonly onClick: (line: TradeLine) => void = () => undefined,
  ) {}

  setLines(lines: TradeLine[]): void {
    this.lines = lines;
    // A line that disappears mid-drag (its position closed) ends the drag.
    if (this.drag && !lines.some((l) => l.key === this.drag!.line.key)) this.cancelDrag();
    this.requestUpdate?.();
  }

  /** True while the operator is dragging a line (the page holds back redraws that would yank it). */
  isDragging(): boolean {
    return this.drag !== null;
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

  /** The lines drawn this frame: this layer's own, and the dragged one at its preview price. */
  private drawnLines(): { line: TradeLine; price: number }[] {
    const drag = this.drag;
    const out: { line: TradeLine; price: number }[] = [];
    for (const line of this.lines) {
      const dragging = drag?.line.key === line.key;
      if (!line.drawn && !dragging) continue;
      out.push({ line, price: dragging ? drag!.price : line.price });
    }
    return out;
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
        const dragging = this.drag?.line.key === line.key;
        ctx.globalAlpha = line.faded ? 0.6 : 1;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = dragging ? 2 : 1;
        ctx.setLineDash(line.faded ? [2, 3] : dragging ? [8, 4] : [6, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        // A chip a little left of the trade layer's own labels, so a dragged stop never hides its old label.
        const text = dragging
          ? `${line.label} → ${price.toFixed(Math.max(0, this.precision()))}`
          : line.label;
        const tw = ctx.measureText(text).width + 10;
        const x = Math.max(0, w - tw - 140);
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
    const line = grabbedTradeLine(this.lines, y, toY);
    if (!line) return;
    // Ours: the chart must not start a pan or a drawing from this press.
    ev.preventDefault();
    ev.stopPropagation();
    if (!line.draggable) {
      // A clickable line (a position's entry, an order's price): a click, if the pointer does not travel.
      this.press = { line, pointerId: ev.pointerId, y };
      return;
    }
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
    if (this.press && ev.pointerId === this.press.pointerId) {
      if (Math.abs(y - this.press.y) > CLICK_SLOP_PX) this.press = null;
      return;
    }
    if (!this.drag) {
      const over = grabbedTradeLine(this.lines, y, toY);
      const hovering = !!over;
      if (this.element && (hovering !== this.hovering || hovering)) {
        this.element.style.cursor = !over ? '' : over.draggable ? 'ns-resize' : 'pointer';
        this.hovering = hovering;
      }
      return;
    }
    if (ev.pointerId !== this.drag.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();
    const price = tradeDragPrice(y, (py) => series.coordinateToPrice(py), this.precision());
    if (price !== null) {
      this.drag.price = price;
      this.requestUpdate?.();
    }
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    const press = this.press;
    if (press && ev.pointerId === press.pointerId) {
      this.press = null;
      ev.preventDefault();
      ev.stopPropagation();
      this.onClick(press.line);
      return;
    }
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
    this.press = null;
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
