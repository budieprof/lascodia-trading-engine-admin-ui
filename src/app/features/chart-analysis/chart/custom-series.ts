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
  /** A script's `barcolor()` for this bar, over the up/down colour (the library's price line too). */
  color?: string;
  /** Point & Figure: the box size and whether the column is X (rising) or O (falling). */
  box?: number;
  up?: boolean;
  /** Kagi: thick (yang) where the segment starts, and the price it changes thickness at (null: none). */
  thickStart?: boolean;
  switchAt?: number | null;
}

export interface CustomSeriesStyle extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  /** Minimum drawn width in px, so a zero-volume bar is still visible. */
  minBarWidth: number;
}

const DEFAULT_STYLE: CustomSeriesStyle = {
  ...customSeriesDefaultOptions,
  upColor: '#089981',
  downColor: '#F23645',
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
      ctx.fillStyle =
        item.color ?? (item.close >= item.open ? this.style.upColor : this.style.downColor);
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
      ctx.fillStyle = item.color ?? (up ? this.style.upColor : this.style.downColor);

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

/** The HLC area's own colours, on top of the base style. */
export interface HlcAreaStyle extends CustomSeriesStyle {
  /** The close line, drawn over both fills. */
  closeColor: string;
  /** Fill between the high and the close. */
  upFill: string;
  /** Fill between the close and the low. */
  downFill: string;
}

/**
 * TradingView's HLC area: a high line, a low line and a close line, the band between high and close
 * filled in the up colour and the band between close and low in the down colour — how far each bar
 * closed from either end of its range, at a glance. Until 2026-10 the style was the Area series
 * under another name, byte for byte (CC-23).
 */
class HlcAreaRenderer extends BaseRenderer {
  protected paint(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, OhlcvData>,
    toY: PriceToCoordinateConverter,
  ): void {
    const range = data.visibleRange!;
    const style = this.style as HlcAreaStyle;
    const pts: { x: number; h: number; l: number; c: number }[] = [];
    // One bar past each edge, so the bands run off the pane rather than stopping short of it.
    const from = Math.max(0, range.from - 1);
    const to = Math.min(data.bars.length, range.to + 1);
    for (let i = from; i < to; i++) {
      const bar = data.bars[i];
      const item = bar.originalData;
      if (!item || item.close === undefined) continue;
      const h = toY(item.high);
      const l = toY(item.low);
      const c = toY(item.close);
      if (h === null || l === null || c === null) continue;
      pts.push({ x: bar.x, h, l, c });
    }
    if (pts.length === 0) return;
    const band = (top: (p: (typeof pts)[number]) => number, bottom: typeof top, fill: string) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, top(pts[0]));
      for (const p of pts) ctx.lineTo(p.x, top(p));
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, bottom(pts[i]));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    band((p) => p.h, (p) => p.c, style.upFill ?? 'rgba(8,153,129,0.2)');
    band((p) => p.c, (p) => p.l, style.downFill ?? 'rgba(242,54,69,0.2)');
    const line = (y: (p: (typeof pts)[number]) => number, color: string, width: number) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, y(pts[0]));
      for (const p of pts) ctx.lineTo(p.x, y(p));
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    line((p) => p.h, style.upColor, 1);
    line((p) => p.l, style.downColor, 1);
    line((p) => p.c, style.closeColor ?? '#2962FF', 2);
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

export class HlcAreaSeries extends BaseSeriesView {
  protected createRenderer(): BaseRenderer {
    return new HlcAreaRenderer();
  }

  override defaultOptions(): HlcAreaStyle {
    return {
      ...DEFAULT_STYLE,
      closeColor: '#2962FF',
      upFill: 'rgba(8,153,129,0.2)',
      downFill: 'rgba(242,54,69,0.2)',
    };
  }
}

/**
 * Point & Figure (CC-I10): each bar is a column of boxes on the box grid — X's in the up colour for a rising column,
 * O's in the down colour for a falling one — one box per level from `low` to `high`. Boxes too small to draw a mark in
 * are filled as one block.
 */
class PnfRenderer extends BaseRenderer {
  protected paint(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, OhlcvData>,
    toY: PriceToCoordinateConverter,
  ): void {
    const range = data.visibleRange!;
    const width = Math.max(3, data.barSpacing * 0.8);
    for (let i = range.from; i < range.to; i++) {
      const bar = data.bars[i];
      const item = bar.originalData;
      const box = item?.box;
      if (!item || item.high === undefined || !box) continue;
      const up = item.up ?? item.close >= item.open;
      const color = up ? this.style.upColor : this.style.downColor;
      const left = bar.x - width / 2;
      const first = Math.round(item.low / box);
      const last = Math.round(item.high / box);
      const top0 = toY((last + 0.5) * box);
      const bottom0 = toY((first - 0.5) * box);
      if (top0 === null || bottom0 === null) continue;
      const cell = Math.abs(bottom0 - top0) / Math.max(1, last - first + 1);
      if (cell < 4 || width < 4) {
        ctx.fillStyle = color;
        ctx.fillRect(left, Math.min(top0, bottom0), width, Math.abs(bottom0 - top0) || 1);
        continue;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.min(2, cell / 8));
      const inset = Math.min(width, cell) * 0.15;
      for (let level = first; level <= last; level++) {
        const yTop = toY((level + 0.5) * box);
        const yBottom = toY((level - 0.5) * box);
        if (yTop === null || yBottom === null) continue;
        const t = Math.min(yTop, yBottom) + inset;
        const b = Math.max(yTop, yBottom) - inset;
        const l = left + inset;
        const r = left + width - inset;
        ctx.beginPath();
        if (up) {
          ctx.moveTo(l, t);
          ctx.lineTo(r, b);
          ctx.moveTo(r, t);
          ctx.lineTo(l, b);
        } else {
          ctx.ellipse((l + r) / 2, (t + b) / 2, Math.max(1, (r - l) / 2), Math.max(1, (b - t) / 2), 0, 0, 2 * Math.PI);
        }
        ctx.stroke();
      }
    }
  }
}

export class PnfSeries extends BaseSeriesView {
  protected createRenderer(): BaseRenderer {
    return new PnfRenderer();
  }

  /** The boxes reach half a box past the top and bottom levels: the price scale keeps them whole. */
  override priceValueBuilder(plotRow: OhlcvData): number[] {
    const half = (plotRow.box ?? 0) / 2;
    return [plotRow.high + half, plotRow.low - half, plotRow.close];
  }
}

/** Line widths of Kagi's thick (yang) and thin (yin) lines, px. */
const KAGI_THICK = 3;
const KAGI_THIN = 1;

/**
 * Kagi (CC-I10): a vertical line per segment from where it turned to its extreme, joined to the previous one by a
 * horizontal at the turning price; thick (yang, up colour) above the last shoulder, thin (yin, down colour) below the
 * last waist, changing mid-segment where it crosses one.
 */
class KagiRenderer extends BaseRenderer {
  protected paint(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, OhlcvData>,
    toY: PriceToCoordinateConverter,
  ): void {
    const range = data.visibleRange!;
    const stroke = (x1: number, y1: number, x2: number, y2: number, thick: boolean) => {
      ctx.beginPath();
      ctx.strokeStyle = thick ? this.style.upColor : this.style.downColor;
      ctx.lineWidth = thick ? KAGI_THICK : KAGI_THIN;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    ctx.lineCap = 'square';
    let prev: { x: number; thick: boolean } | null = null;
    const from = Math.max(0, range.from - 1);
    for (let i = from; i < Math.min(data.bars.length, range.to + 1); i++) {
      const bar = data.bars[i];
      const item = bar.originalData;
      if (!item || item.close === undefined) {
        prev = null;
        continue;
      }
      const open = toY(item.open);
      const close = toY(item.close);
      if (open === null || close === null) {
        prev = null;
        continue;
      }
      const thickStart = item.thickStart ?? item.close >= item.open;
      // The shoulder / waist joining the previous segment, in the thickness that one ended in.
      if (prev) stroke(prev.x, open, bar.x, open, prev.thick);
      const at = item.switchAt === null || item.switchAt === undefined ? null : toY(item.switchAt);
      if (at === null) stroke(bar.x, open, bar.x, close, thickStart);
      else {
        stroke(bar.x, open, bar.x, at, thickStart);
        stroke(bar.x, at, bar.x, close, !thickStart);
      }
      prev = { x: bar.x, thick: at === null ? thickStart : !thickStart };
    }
  }
}

export class KagiSeries extends BaseSeriesView {
  protected createRenderer(): BaseRenderer {
    return new KagiRenderer();
  }
}
