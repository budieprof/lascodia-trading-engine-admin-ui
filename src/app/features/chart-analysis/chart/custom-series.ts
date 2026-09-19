import {
  customSeriesDefaultOptions,
  type CustomSeriesOptions,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

/**
 * The two chart styles Lightweight Charts has no series for.
 *
 * Everything else in the catalogue is a built-in series with different options.
 * These two are not:
 *
 * - **HiLo** draws the bar's RANGE only — no open tick and no close tick. A bar
 *   series always draws the close, so `openVisible: false` gives HLC bars, not
 *   HiLo. Ours is a plain vertical wick per bar.
 * - **VolCandle** scales each candle's WIDTH by its volume, so a high-volume
 *   bar is visibly fatter. No built-in series varies bar width per point.
 *
 * Both are implemented as custom series, which means owning the drawing. The
 * renderer works in bitmap space and is handed a price converter per frame,
 * exactly like the library's own series.
 */

export interface OhlcvData extends WhitespaceData<Time> {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CustomSeriesStyle extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  /** Minimum drawn width in px, so a zero-volume bar is still visible. */
  minBarWidth: number;
}

const DEFAULT_STYLE: CustomSeriesStyle = {
  ...customSeriesDefaultOptions,
  upColor: '#26A69A',
  downColor: '#EF5350',
  minBarWidth: 1,
};

abstract class BaseRenderer implements ICustomSeriesPaneRenderer {
  protected data: PaneRendererCustomData<Time, OhlcvData> | null = null;
  protected style: CustomSeriesStyle = DEFAULT_STYLE;

  update(data: PaneRendererCustomData<Time, OhlcvData>, style: CustomSeriesStyle): void {
    this.data = data;
    this.style = style;
  }

  draw(target: CanvasRenderingTarget2D, priceConverter: PriceToCoordinateConverter): void {
    target.useBitmapCoordinateSpace((scope) => {
      const data = this.data;
      if (!data || data.bars.length === 0 || data.visibleRange === null) return;
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      this.paint(ctx, data, priceConverter);
      ctx.restore();
    });
  }

  protected abstract paint(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, OhlcvData>,
    toY: PriceToCoordinateConverter,
  ): void;
}

/** High-low range bars: no open tick, no close tick. */
class HiLoRenderer extends BaseRenderer {
  protected paint(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, OhlcvData>,
    toY: PriceToCoordinateConverter,
  ): void {
    const range = data.visibleRange!;
    const width = Math.max(this.style.minBarWidth, Math.floor(data.barSpacing * 0.2));
    for (let i = range.from; i < range.to; i++) {
      const bar = data.bars[i];
      const item = bar.originalData;
      if (!item || item.high === undefined) continue;
      const high = toY(item.high);
      const low = toY(item.low);
      if (high === null || low === null) continue;
      ctx.fillStyle = item.close >= item.open ? this.style.upColor : this.style.downColor;
      ctx.fillRect(bar.x - width / 2, Math.min(high, low), width, Math.abs(low - high) || 1);
    }
  }
}

/**
 * Volume candles: candle width proportional to volume.
 *
 * Width is scaled against the LARGEST volume in the visible range rather than
 * the whole series, so zooming into a quiet stretch still shows relative
 * differences instead of a row of hairlines.
 */
class VolCandleRenderer extends BaseRenderer {
  protected paint(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, OhlcvData>,
    toY: PriceToCoordinateConverter,
  ): void {
    const range = data.visibleRange!;
    let maxVolume = 0;
    for (let i = range.from; i < range.to; i++) {
      const item = data.bars[i].originalData;
      if (item?.volume) maxVolume = Math.max(maxVolume, item.volume);
    }

    const fullWidth = Math.max(this.style.minBarWidth, data.barSpacing * 0.8);
    const wickWidth = Math.max(1, Math.floor(data.barSpacing * 0.1));

    for (let i = range.from; i < range.to; i++) {
      const bar = data.bars[i];
      const item = bar.originalData;
      if (!item || item.high === undefined) continue;

      const open = toY(item.open);
      const high = toY(item.high);
      const low = toY(item.low);
      const close = toY(item.close);
      if (open === null || high === null || low === null || close === null) continue;

      const up = item.close >= item.open;
      ctx.fillStyle = up ? this.style.upColor : this.style.downColor;

      // Wick at full-bar width regardless of volume — it marks the range, and
      // a wick that thins with volume reads as a different price, not a
      // different size.
      ctx.fillRect(
        bar.x - wickWidth / 2,
        Math.min(high, low),
        wickWidth,
        Math.abs(low - high) || 1,
      );

      const share = maxVolume > 0 ? (item.volume ?? 0) / maxVolume : 1;
      const bodyWidth = Math.max(this.style.minBarWidth, fullWidth * Math.sqrt(share));
      const top = Math.min(open, close);
      const height = Math.abs(close - open) || 1;
      ctx.fillRect(bar.x - bodyWidth / 2, top, bodyWidth, height);
    }
  }
}

abstract class BaseSeriesView implements ICustomSeriesPaneView<Time, OhlcvData, CustomSeriesStyle> {
  protected abstract createRenderer(): BaseRenderer;
  private instance: BaseRenderer | null = null;

  renderer(): ICustomSeriesPaneRenderer {
    this.instance ??= this.createRenderer();
    return this.instance;
  }

  priceValueBuilder(plotRow: OhlcvData): number[] {
    // High, low, close — the library uses the last entry for the price line and
    // the first two to autoscale, so the bar's full range stays on screen.
    return [plotRow.high, plotRow.low, plotRow.close];
  }

  isWhitespace(data: OhlcvData | WhitespaceData<Time>): data is WhitespaceData<Time> {
    return (data as OhlcvData).close === undefined;
  }

  update(data: PaneRendererCustomData<Time, OhlcvData>, seriesOptions: CustomSeriesStyle): void {
    this.instance ??= this.createRenderer();
    this.instance.update(data, seriesOptions);
  }

  defaultOptions(): CustomSeriesStyle {
    return DEFAULT_STYLE;
  }
}

export class HiLoSeries extends BaseSeriesView {
  protected createRenderer(): BaseRenderer {
    return new HiLoRenderer();
  }
}

export class VolCandleSeries extends BaseSeriesView {
  protected createRenderer(): BaseRenderer {
    return new VolCandleRenderer();
  }
}
