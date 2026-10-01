import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import type { TpoProfile, VolumeProfile } from './profile-math';
import type { ProfileBlock, ProfileRenderModel } from './profile-studies';

export interface ProfileColors {
  up: string;
  down: string;
  valueArea: string;
  poc: string;
  vaLine: string;
  tpoText: string;
  ib: string;
}

export const DEFAULT_PROFILE_COLORS: ProfileColors = {
  up: '#26A69A',
  down: '#EF5350',
  valueArea: '#2962FF',
  poc: '#FFB300',
  vaLine: '#2962FF',
  tpoText: '#B2B5BE',
  ib: '#AB47BC',
};

/**
 * Series primitive for profile studies. Follows the AnalysisOverlayRenderer conventions:
 * zOrder 'normal', price → y projected per frame via the series, time → x via an injected
 * `timeToX` (UTC ms → x or null).
 *
 * Attach: `series.attachPrimitive(renderer)`; feed `renderer.setModel(computeProfileStudy(...))`.
 */
export class ProfileRenderer implements ISeriesPrimitive<Time> {
  private model: ProfileRenderModel | null = null;
  private requestUpdate?: () => void;

  constructor(
    private readonly series: () => ISeriesApi<SeriesType> | null,
    private readonly timeToX: (ms: number) => number | null = () => null,
    private readonly colors: ProfileColors = DEFAULT_PROFILE_COLORS,
    /** Max width (px) of a right-anchored histogram; also capped at 25% of pane width. */
    private readonly rightMaxWidth = 200,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  setModel(model: ProfileRenderModel | null): void {
    this.model = model;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projection happens in draw() */
  }

  paneViews() {
    return [
      {
        zOrder: () => 'normal' as const,
        renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.draw(target) }),
      },
    ];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      const series = this.series();
      const model = this.model;
      if (!series || !model) return;
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const width = scope.mediaSize.width;
      if (model.kind === 'volume') {
        for (const block of model.blocks) this.drawVolume(ctx, series, width, block, model.anchor);
      } else {
        for (const s of model.sessions) this.drawTpo(ctx, series, width, s);
      }
      ctx.restore();
    });
  }

  private span(t0: number, t1: number, width: number): [number, number] | null {
    const x0 = this.timeToX(t0);
    const x1 = this.timeToX(t1);
    if (x0 === null || x1 === null) return null;
    if (x1 < 0 || x0 > width) return null;
    return [x0, Math.max(x0 + 4, x1)];
  }

  private drawVolume(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
    block: ProfileBlock,
    anchor: 'right' | 'span',
  ): void {
    const vp: VolumeProfile = block.profile;
    if (vp.maxRowVolume <= 0) return;
    let left: number;
    let right: number;
    let maxW: number;
    if (anchor === 'right') {
      maxW = Math.min(this.rightMaxWidth, width * 0.25);
      right = width;
      left = width - maxW;
    } else {
      const s = this.span(block.t0, block.t1, width);
      if (!s) return;
      [left, right] = s;
      maxW = (right - left) * 0.7;
    }
    const c = this.colors;
    const yHigh = series.priceToCoordinate(vp.vah);
    const yLow = series.priceToCoordinate(vp.val);
    if (anchor === 'span' && yHigh !== null && yLow !== null) {
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = c.valueArea;
      ctx.fillRect(left, Math.min(yHigh, yLow), right - left, Math.abs(yLow - yHigh));
    }
    vp.rows.forEach((row) => {
      const vol = row.upVol + row.downVol;
      if (vol <= 0) return;
      const yTop = series.priceToCoordinate(row.priceHigh);
      const yBot = series.priceToCoordinate(row.priceLow);
      if (yTop === null || yBot === null) return;
      const y = Math.min(yTop, yBot);
      const h = Math.max(1, Math.abs(yBot - yTop) - 1);
      const inVa = row.priceLow >= vp.val - 1e-12 && row.priceHigh <= vp.vah + 1e-12;
      const w = (vol / vp.maxRowVolume) * maxW;
      const upW = (row.upVol / vol) * w;
      ctx.globalAlpha = inVa ? 0.55 : 0.25;
      // Right-anchored grows leftwards from the edge; span-anchored grows rightwards from t0.
      const x = anchor === 'right' ? right - w : left;
      ctx.fillStyle = c.up;
      ctx.fillRect(x, y, upW, h);
      ctx.fillStyle = c.down;
      ctx.fillRect(x + upW, y, w - upW, h);
    });
    ctx.globalAlpha = 1;
    this.hLine(ctx, series, vp.poc, left, right, c.poc, 2, []);
    this.hLine(ctx, series, vp.vah, left, right, c.vaLine, 1, [4, 3]);
    this.hLine(ctx, series, vp.val, left, right, c.vaLine, 1, [4, 3]);
  }

  private drawTpo(ctx: CanvasRenderingContext2D, series: ISeriesApi<SeriesType>, width: number, tpo: TpoProfile): void {
    const s = this.span(tpo.t0, tpo.t1, width);
    if (!s) return;
    const [left, right] = s;
    const c = this.colors;
    const rowPx =
      tpo.rows.length > 0
        ? Math.abs(
            (series.priceToCoordinate(tpo.rows[0].priceLow) ?? 0) - (series.priceToCoordinate(tpo.rows[0].priceHigh) ?? 0),
          )
        : 0;
    const maxLetters = Math.max(1, ...tpo.rows.map((r) => r.letters.length));
    const cell = Math.min(9, (right - left) / maxLetters);
    // Letters need ~8px of row height and ~6px of width; otherwise fall back to blocks.
    const useLetters = rowPx >= 8 && cell >= 6;
    const fontPx = Math.min(11, Math.floor(rowPx));
    if (useLetters) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textBaseline = 'middle';
    }
    tpo.rows.forEach((row, i) => {
      if (row.letters.length === 0) return;
      const yTop = series.priceToCoordinate(row.priceHigh);
      const yBot = series.priceToCoordinate(row.priceLow);
      if (yTop === null || yBot === null) return;
      const y = Math.min(yTop, yBot);
      const h = Math.max(1, Math.abs(yBot - yTop) - (useLetters ? 0 : 1));
      const inVa = row.priceLow >= tpo.val - 1e-12 && row.priceHigh <= tpo.vah + 1e-12;
      const single = tpo.singlePrints.includes(i);
      if (useLetters) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = i === tpo.pocIndex ? c.poc : single ? c.down : inVa ? c.valueArea : c.tpoText;
        row.letters.forEach((l, k) => ctx.fillText(l, left + k * cell, y + h / 2));
      } else {
        ctx.globalAlpha = inVa ? 0.55 : 0.25;
        ctx.fillStyle = i === tpo.pocIndex ? c.poc : c.valueArea;
        ctx.fillRect(left, y, row.letters.length * cell, h);
      }
    });
    ctx.globalAlpha = 1;
    this.hLine(ctx, series, tpo.poc, left, right, c.poc, 1.5, []);
    this.hLine(ctx, series, tpo.vah, left, right, c.vaLine, 1, [4, 3]);
    this.hLine(ctx, series, tpo.val, left, right, c.vaLine, 1, [4, 3]);
    // Initial balance as a vertical bar on the session's left edge.
    const ibTop = series.priceToCoordinate(tpo.ibHigh);
    const ibBot = series.priceToCoordinate(tpo.ibLow);
    if (ibTop !== null && ibBot !== null) {
      ctx.fillStyle = c.ib;
      ctx.fillRect(left - 3, Math.min(ibTop, ibBot), 2, Math.abs(ibBot - ibTop));
    }
  }

  private hLine(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    price: number,
    x0: number,
    x1: number,
    color: string,
    lw: number,
    dash: number[],
  ): void {
    const y = series.priceToCoordinate(price);
    if (y === null) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x1, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }
}
