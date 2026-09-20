import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import type { SrLevel, VolumeProfileResult } from './analysis-overlays';

/**
 * Draws the analytical overlays on the price pane: the volume profile and the
 * auto-detected support/resistance levels.
 *
 * <p>One primitive for both, for the same reason the drawing renderer is one primitive for
 * every drawing: the library re-runs `paneViews()` on every frame of a pan, so each extra
 * primitive is another round trip per frame.</p>
 *
 * <p>Price → y comes from the series on every frame. Nothing is projected at compute time:
 * those coordinates are only valid for the viewport that produced them.</p>
 */
export class AnalysisOverlayRenderer implements ISeriesPrimitive<Time> {
  private profile: VolumeProfileResult | null = null;
  private levels: readonly SrLevel[] = [];
  private requestUpdate?: () => void;

  constructor(
    private readonly series: () => ISeriesApi<SeriesType> | null,
    private readonly precision: () => number,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setProfile(profile: VolumeProfileResult | null): void {
    this.profile = profile;
    this.requestUpdate?.();
  }

  setLevels(levels: readonly SrLevel[]): void {
    this.levels = levels;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projection is recomputed inside draw() */
  }

  paneViews() {
    return [
      {
        // 'normal' — NOT 'bottom'. Bottom renders beneath the pane background, which makes
        // the overlay invisible; that cost an afternoon on the economic-event marks.
        zOrder: () => 'normal' as const,
        renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.draw(target) }),
      },
    ];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      const series = this.series();
      if (!series) return;
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;
      this.drawProfile(ctx, series, width, height);
      this.drawLevels(ctx, series, width);
      ctx.restore();
    });
  }

  private drawProfile(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
    height: number,
  ): void {
    const profile = this.profile;
    if (!profile || profile.peak <= 0) return;

    // Anchored to the RIGHT edge and drawn leftwards: that is where a profile belongs, and
    // it keeps the newest candles readable instead of burying them.
    const maxWidth = Math.min(200, width * 0.22);
    const binHeight = this.binHeight(series, profile, height);

    ctx.save();
    for (const bin of profile.bins) {
      if (bin.volume <= 0) continue;
      const y = series.priceToCoordinate(bin.price);
      if (y === null) continue;
      const inValue = bin.price >= profile.valueAreaLow && bin.price <= profile.valueAreaHigh;
      ctx.globalAlpha = inValue ? 0.3 : 0.14;
      ctx.fillStyle = '#2962FF';
      const w = (bin.volume / profile.peak) * maxWidth;
      ctx.fillRect(width - w, y - binHeight / 2, w, Math.max(1, binHeight - 1));
    }

    const pocY = series.priceToCoordinate(profile.poc);
    if (pocY !== null) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#FF6D00';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(width - maxWidth, pocY);
      ctx.lineTo(width, pocY);
      ctx.stroke();
      this.tag(
        ctx,
        `POC ${profile.poc.toFixed(this.precision())}`,
        width - maxWidth - 4,
        pocY,
        '#FF6D00',
        'right',
      );
    }
    ctx.restore();
  }

  /**
   * Bin thickness in pixels, measured from two adjacent bin prices.
   *
   * <p>Not `height / bins`: on a log scale the bins are not evenly spaced, and a fixed
   * thickness would leave gaps at one end and overlap at the other.</p>
   */
  private binHeight(
    series: ISeriesApi<SeriesType>,
    profile: VolumeProfileResult,
    height: number,
  ): number {
    if (profile.bins.length < 2) return 4;
    const a = series.priceToCoordinate(profile.bins[0].price);
    const b = series.priceToCoordinate(profile.bins[1].price);
    if (a === null || b === null) return Math.max(2, height / profile.bins.length);
    return Math.max(2, Math.abs(b - a));
  }

  private drawLevels(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
  ): void {
    if (this.levels.length === 0) return;
    ctx.save();
    for (const level of this.levels) {
      const y = series.priceToCoordinate(level.price);
      if (y === null) continue;
      const colour = level.kind === 'resistance' ? '#EF5350' : '#26A69A';
      // Weight carries the strength, so a five-touch level reads as more than a two-touch
      // one without the operator having to read the label.
      ctx.lineWidth = 1 + level.strength * 2;
      ctx.globalAlpha = 0.35 + level.strength * 0.45;
      ctx.strokeStyle = colour;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      this.tag(
        ctx,
        `${level.price.toFixed(this.precision())} · ${level.touches}×`,
        4,
        y,
        colour,
        'left',
      );
    }
    ctx.restore();
  }

  private tag(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    colour: string,
    align: 'left' | 'right',
  ): void {
    ctx.save();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 8;
    const left = align === 'left' ? x : x - w;
    ctx.fillStyle = colour;
    ctx.fillRect(left, y - 8, w, 16);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 4, y);
    ctx.restore();
  }
}
