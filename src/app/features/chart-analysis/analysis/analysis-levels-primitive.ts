import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

import type { AnalysisLine } from './analysis-overlay';

/**
 * The analysis overlay on the price pane (SP-I5): an analysis' plan and the symbol's live watches as labelled
 * horizontal lines. Display only — it takes no pointer input, so drawing tools and the trading lines keep the chart.
 * Labels sit at the LEFT edge so they never cover the trade layer's and the ticket's chips on the right.
 */
export class AnalysisLevelsPrimitive implements ISeriesPrimitive<Time> {
  private lines: AnalysisLine[] = [];
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate?: () => void;

  constructor(private readonly precision: () => number) {}

  setLines(lines: AnalysisLine[]): void {
    this.lines = lines;
    this.requestUpdate?.();
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series as ISeriesApi<SeriesType, Time>;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
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
    return this.lines.map((line) => ({
      coordinate: () => series.priceToCoordinate(line.price) ?? -100,
      text: () => line.price.toFixed(Math.max(0, this.precision())),
      textColor: () => '#FFFFFF',
      backColor: () => line.color,
      visible: () => series.priceToCoordinate(line.price) !== null,
      tickVisible: () => true,
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
      // Labels of lines a few pixels apart would overprint: each later label steps down until it is clear.
      const taken: number[] = [];
      for (const line of [...this.lines].sort((a, b) => b.price - a.price)) {
        const y = series.priceToCoordinate(line.price);
        if (y === null) continue;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(line.dashed ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        let ly: number = y;
        while (taken.some((t) => Math.abs(t - ly) < 15)) ly += 15;
        taken.push(ly);
        const tw = ctx.measureText(line.label).width + 10;
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = line.color;
        ctx.fillRect(6, ly - 8, tw, 16);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(line.label, 11, ly);
      }
      ctx.restore();
    });
  }
}
