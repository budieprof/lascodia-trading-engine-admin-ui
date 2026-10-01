import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import type { Ohlc } from '../indicators/math';
import type { CandlestickHit } from './candlestick-patterns';
import type { ChartPatternHit, PatternDirection, PatternPoint } from './chart-patterns';

/**
 * Draws detected patterns on the price pane: candlestick hits as small labelled markers
 * (bullish below the bar, bearish/neutral above), chart patterns as an outline plus dashed
 * breakout / target lines and a name label.
 *
 * <p>One primitive for both, like {@link AnalysisOverlayRenderer}: the library re-runs
 * `paneViews()` on every frame of a pan. Price → y and time → x are resolved per frame, never
 * cached, since projected coordinates only hold for the viewport that produced them.</p>
 */
export interface PatternPalette {
  bullish: string;
  bearish: string;
  neutral: string;
  text: string;
  labelBg: string;
}

const LIGHT: PatternPalette = { bullish: '#089981', bearish: '#F23645', neutral: '#2962FF', text: '#FFFFFF', labelBg: 'rgba(255,255,255,0.85)' };
const DARK: PatternPalette = { bullish: '#22AB94', bearish: '#F7525F', neutral: '#5B8DEF', text: '#FFFFFF', labelBg: 'rgba(19,23,34,0.85)' };

const FONT = '10px -apple-system, system-ui, sans-serif';

export class PatternRenderer implements ISeriesPrimitive<Time> {
  private bars: readonly Ohlc[] = [];
  private candles: readonly CandlestickHit[] = [];
  private patterns: readonly ChartPatternHit[] = [];
  private requestUpdate?: () => void;

  constructor(
    private readonly series: () => ISeriesApi<SeriesType> | null,
    /** Bar time (same unit as `Ohlc.time`) → x, or null when the time scale cannot place it. */
    private readonly timeToX: (time: number) => number | null,
    /** True when the chart is in dark theme; read every frame so a theme flip repaints right. */
    private readonly isDark: () => boolean = () => false,
  ) {}

  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = undefined;
  }

  /** Bars the hit indices refer to — must be the same array the detectors ran on. */
  setBars(bars: readonly Ohlc[]): void {
    this.bars = bars;
    this.requestUpdate?.();
  }

  setCandlestickHits(hits: readonly CandlestickHit[]): void {
    this.candles = hits;
    this.requestUpdate?.();
  }

  setChartPatterns(hits: readonly ChartPatternHit[]): void {
    this.patterns = hits;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    /* projection is recomputed inside draw() */
  }

  paneViews() {
    return [
      {
        // 'normal', not 'bottom' — bottom paints beneath the pane background.
        zOrder: () => 'normal' as const,
        renderer: () => ({ draw: (target: CanvasRenderingTarget2D) => this.draw(target) }),
      },
    ];
  }

  private draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      const series = this.series();
      if (!series || this.bars.length === 0) return;
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const pal = this.isDark() ? DARK : LIGHT;
      const width = scope.mediaSize.width;
      this.drawPatterns(ctx, series, pal, width);
      this.drawCandles(ctx, series, pal, width);
      ctx.restore();
    });
  }

  private x(index: number): number | null {
    const bar = this.bars[index];
    if (bar) return this.timeToX(bar.time);
    // Projected past the last bar (breakout lines): extrapolate from the bar spacing.
    const n = this.bars.length;
    if (n < 2 || index < n) return null;
    const a = this.timeToX(this.bars[n - 2].time);
    const b = this.timeToX(this.bars[n - 1].time);
    return a === null || b === null ? null : b + (b - a) * (index - (n - 1));
  }

  private color(dir: PatternDirection, pal: PatternPalette): string {
    return dir === 'bullish' ? pal.bullish : dir === 'bearish' ? pal.bearish : pal.neutral;
  }

  private drawCandles(ctx: CanvasRenderingContext2D, series: ISeriesApi<SeriesType>, pal: PatternPalette, width: number): void {
    if (this.candles.length === 0) return;
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // Several hits on one bar stack outward instead of overprinting.
    const stackAbove = new Map<number, number>();
    const stackBelow = new Map<number, number>();
    for (const hit of this.candles) {
      const bar = this.bars[hit.index];
      if (!bar) continue;
      const x = this.x(hit.index);
      if (x === null || x < -20 || x > width + 20) continue;
      const below = hit.direction === 'bullish';
      const yBar = series.priceToCoordinate(below ? bar.low : bar.high);
      if (yBar === null) continue;
      const stack = below ? stackBelow : stackAbove;
      const slot = stack.get(hit.index) ?? 0;
      stack.set(hit.index, slot + 1);
      const y = below ? yBar + 12 + slot * 15 : yBar - 12 - slot * 15;
      const w = Math.max(16, ctx.measureText(hit.abbr).width + 8);
      ctx.fillStyle = this.color(hit.direction, pal);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x - w / 2, y - 6.5, w, 13, 3);
      else ctx.rect(x - w / 2, y - 6.5, w, 13);
      ctx.fill();
      ctx.fillStyle = pal.text;
      ctx.fillText(hit.abbr, x, y + 0.5);
    }
  }

  private drawPatterns(ctx: CanvasRenderingContext2D, series: ISeriesApi<SeriesType>, pal: PatternPalette, width: number): void {
    for (const pat of this.patterns) {
      const col = this.color(pat.direction, pal);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.globalAlpha = pat.status === 'confirmed' ? 1 : 0.7;
      for (const line of pat.lines) {
        ctx.beginPath();
        let started = false;
        for (const p of line) {
          const x = this.x(p.index);
          const y = series.priceToCoordinate(p.price);
          if (x === null || y === null) continue;
          if (!started) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          started = true;
        }
        if (started) ctx.stroke();
      }

      // Point labels (wave numbers, XABCD).
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = col;
      for (const p of pat.points) {
        if (!p.label) continue;
        const x = this.x(p.index);
        const y = series.priceToCoordinate(p.price);
        if (x === null || y === null) continue;
        const isHigh = this.isLocalHigh(pat, p);
        ctx.textBaseline = isHigh ? 'bottom' : 'top';
        ctx.fillText(p.label, x, isHigh ? y - 3 : y + 3);
      }

      const lastIdx = pat.endIndex;
      const xFrom = this.x(lastIdx);
      const xConf = pat.confirmedIndex !== undefined ? this.x(pat.confirmedIndex) : null;
      if (xFrom !== null) {
        const xTo = Math.min(width, Math.max(xConf ?? xFrom, xFrom) + 60);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        if (pat.breakout !== undefined) this.hline(ctx, series, pat.breakout, xFrom, xTo);
        if (pat.target !== undefined) {
          ctx.globalAlpha = 0.6;
          this.hline(ctx, series, pat.target, (xConf ?? xFrom), xTo);
          const yT = series.priceToCoordinate(pat.target);
          if (yT !== null) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('target', xTo + 3, yT);
          }
        }
        ctx.setLineDash([]);
      }

      // Name label above the pattern's highest point.
      ctx.globalAlpha = 1;
      const top = pat.points.reduce((a, b) => (b.price > a.price ? b : a), pat.points[0]);
      const xl = this.x(Math.round((pat.startIndex + pat.endIndex) / 2));
      const yl = series.priceToCoordinate(top.price);
      if (xl !== null && yl !== null && xl > -100 && xl < width + 100) {
        const label = pat.status === 'forming' ? `${pat.name} (forming)` : pat.name;
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = pal.labelBg;
        ctx.fillRect(xl - w / 2, yl - 30, w, 14);
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, xl, yl - 23);
      }
    }
    ctx.globalAlpha = 1;
  }

  private isLocalHigh(pat: ChartPatternHit, p: PatternPoint): boolean {
    const i = pat.points.indexOf(p);
    const nb = [pat.points[i - 1], pat.points[i + 1]].filter(Boolean);
    return nb.every((q) => q.price <= p.price);
  }

  private hline(ctx: CanvasRenderingContext2D, series: ISeriesApi<SeriesType>, price: number, x0: number, x1: number): void {
    const y = series.priceToCoordinate(price);
    if (y === null) return;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
}
