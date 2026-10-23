import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import {
  NAMED_SESSION_LABEL,
  type NamedSession,
  type PeriodProfile,
  type SrLevel,
  type VolumeProfileResult,
} from './analysis-overlays';
import type { MarketStructure } from './market-structure';
import type { AutoAnalysis } from './auto-analysis';
import type { ProfileExtras } from './profile-levels';
import { HitRegistry, type AlertableLevel, type HitResult } from './overlay-hits';
import {
  structureLevelKey,
  structureMarkerKey,
  structureZoneKey,
  type ProvenanceFacts,
  type ProvenanceKey,
} from './provenance';

/** Each named session's colour on its compact profile (PR-1). */
const SESSION_TINT: Readonly<Record<NamedSession, string>> = {
  asia: '#AB47BC',
  london: '#2962FF',
  newyork: '#FF9800',
};

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
/**
 * Move a label clear of ones already placed, and record where it landed.
 *
 * <p>Labels only — the line itself stays at the true price. A nudged LINE would put a level
 * somewhere price never was, which is a far worse fault than a label a few pixels off.</p>
 */
function nudge(y: number, placed: number[], gap = 15): number {
  let out = y;
  let guard = 0;
  while (placed.some((p) => Math.abs(p - out) < gap) && guard++ < 12) out += gap;
  placed.push(out);
  return out;
}

/**
 * One profile row, split into up (teal) and down (pink) volume the way TradingView paints its
 * profiles. Rows inside the value area are drawn stronger than the tails. `opacity` scales both (the
 * layer group's slider, PR-5).
 */
export function paintBin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  bin: { volume: number; up?: number; down?: number },
  inValue: boolean,
  opacity = 1,
): void {
  ctx.globalAlpha = (inValue ? 0.55 : 0.25) * opacity;
  const up = bin.up ?? bin.volume;
  const upW = bin.volume > 0 ? (up / bin.volume) * w : w;
  ctx.fillStyle = '#26A69A';
  ctx.fillRect(x, y, upW, h);
  ctx.fillStyle = '#EF5350';
  ctx.fillRect(x + upW, y, w - upW, h);
}

/** The two layer groups this renderer draws (PR-5), each with its opacity 0..1 (0 = hidden). */
export interface AnalysisOpacity {
  /** Market structure, support & resistance, auto analysis. */
  structure: number;
  /** The volume profile, period / session profiles, naked POCs, developing lines. */
  profiles: number;
}

export class AnalysisOverlayRenderer implements ISeriesPrimitive<Time> {
  private profile: VolumeProfileResult | null = null;
  private periods: readonly PeriodProfile[] = [];
  private levels: readonly SrLevel[] = [];
  private structure: MarketStructure | null = null;
  /** Auto analysis (DR-I11): scored trendlines, higher-timeframe levels, the zig-zag Fib. */
  private auto: AutoAnalysis | null = null;
  private extras: ProfileExtras | null = null;
  private opacity: AnalysisOpacity = { structure: 1, profiles: 1 };
  /** The group being drawn's opacity: every alpha below is multiplied by it. */
  private alpha = 1;
  /** Where each derived element landed on the last frame (PR-4 hover, PR-7 right-click). */
  private readonly hits = new HitRegistry();
  private requestUpdate?: () => void;

  constructor(
    private readonly series: () => ISeriesApi<SeriesType> | null,
    private readonly precision: () => number,
    /** Bar time (UTC ms) → x, or null when the time scale cannot place it. */
    private readonly timeToX: (ms: number) => number | null = () => null,
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

  /** Session / periodic profiles — each drawn inside its own time span. */
  setPeriodProfiles(periods: readonly PeriodProfile[]): void {
    this.periods = periods;
    this.requestUpdate?.();
  }

  /** Naked POCs, developing POC / VA lines and the mode's notice (PR-2, PR-3); null: none. */
  setProfileExtras(extras: ProfileExtras | null): void {
    this.extras = extras;
    this.requestUpdate?.();
  }

  setLevels(levels: readonly SrLevel[]): void {
    this.levels = levels;
    this.requestUpdate?.();
  }

  setStructure(structure: MarketStructure | null): void {
    this.structure = structure;
    this.requestUpdate?.();
  }

  setAuto(auto: AutoAnalysis | null): void {
    this.auto = auto;
    this.requestUpdate?.();
  }

  /** The layer groups' opacity (PR-5); a group at 0 is not drawn and not hoverable. */
  setOpacity(opacity: AnalysisOpacity): void {
    if (opacity.structure === this.opacity.structure && opacity.profiles === this.opacity.profiles)
      return;
    this.opacity = { ...opacity };
    this.requestUpdate?.();
  }

  /** What derived layer is under (x, y) on the last frame — pane media px — or null (PR-4). */
  hit(x: number, y: number): HitResult | null {
    return this.hits.hit(x, y);
  }

  /** The POC / VAH / VAL, nPOC or range edge under (x, y), for "Add alert at …" (PR-7). */
  levelAt(x: number, y: number): AlertableLevel | null {
    return this.hits.levelAt(x, y);
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
    this.hits.clear();
    target.useBitmapCoordinateSpace((scope) => {
      const series = this.series();
      if (!series) return;
      const ctx = scope.context;
      ctx.save();
      ctx.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;
      // Zones first: they are filled bands, and drawing them after the lines would bury
      // every level inside them.
      if (this.opacity.structure > 0) {
        this.alpha = this.opacity.structure;
        this.drawStructure(ctx, series, width);
      }
      if (this.opacity.profiles > 0) {
        this.alpha = this.opacity.profiles;
        this.drawProfile(ctx, series, width, height);
        this.drawPeriodProfiles(ctx, series, width, height);
        this.drawProfileExtras(ctx, series, width);
      }
      if (this.opacity.structure > 0) {
        this.alpha = this.opacity.structure;
        this.drawLevels(ctx, series, width);
        this.drawAuto(ctx, series, width);
      }
      this.alpha = 1;
      ctx.restore();
    });
  }

  /** A horizontal level line's hit region, optionally alertable. */
  private lineHit(
    key: ProvenanceKey,
    facts: ProvenanceFacts,
    x0: number,
    x1: number,
    y: number,
    level?: AlertableLevel,
  ): void {
    this.hits.add({ type: 'line', key, facts, x0, y0: y, x1, y1: y, level });
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
    const facts: ProvenanceFacts = { bars: profile.bars, rows: profile.bins.length };

    ctx.save();
    let top = Infinity;
    let bottom = -Infinity;
    for (const bin of profile.bins) {
      if (bin.volume <= 0) continue;
      const y = series.priceToCoordinate(bin.price);
      if (y === null) continue;
      const inValue = bin.price >= profile.valueAreaLow && bin.price <= profile.valueAreaHigh;
      const w = (bin.volume / profile.peak) * maxWidth;
      // A 1px gap between rows: without it adjacent buckets fuse into one slab and the
      // profile stops reading as a distribution.
      paintBin(ctx, width - w, y - binHeight / 2, w, Math.max(1, binHeight - 1), bin, inValue, this.alpha);
      top = Math.min(top, y - binHeight / 2);
      bottom = Math.max(bottom, y + binHeight / 2);
    }
    this.hits.add({ type: 'area', key: 'profile.visible', facts, x0: width - maxWidth, y0: top, x1: width, y1: bottom });
    ctx.globalAlpha = this.alpha;
    this.valueAreaLines(ctx, series, profile, width - maxWidth, width, 'right', facts);
    ctx.restore();
  }

  private drawPeriodProfiles(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
    height: number,
  ): void {
    if (this.periods.length === 0) return;
    ctx.save();
    for (const period of this.periods) {
      const x0 = this.timeToX(period.t0);
      const x1 = this.timeToX(period.t1);
      if (x0 === null || x1 === null) continue;
      if (x1 < 0 || x0 > width) continue;
      const span = Math.max(4, x1 - x0);
      const profile = period.profile;
      if (profile.peak <= 0) continue;
      // Asia / London / New York overlap: their compact profiles stay narrower so neighbours stay readable.
      const maxWidth = span * (period.session ? 0.55 : 0.7);
      const binHeight = this.binHeight(series, profile, height);
      const tint = period.session ? SESSION_TINT[period.session] : '#2962FF';
      const facts: ProvenanceFacts = {
        bars: profile.bars,
        rows: profile.bins.length,
        label: period.label,
        session: period.session,
      };

      // Faint frame over the value area, so each period's accepted range reads at a glance.
      const vaTop = series.priceToCoordinate(profile.valueAreaHigh);
      const vaBottom = series.priceToCoordinate(profile.valueAreaLow);
      if (period.session) {
        // The session's name over its profile, in its tint: three overlapping sessions need telling apart.
        const top = series.priceToCoordinate(profile.bins[profile.bins.length - 1]?.price ?? profile.poc);
        if (top !== null && span >= 28) {
          ctx.globalAlpha = 0.9 * this.alpha;
          ctx.fillStyle = tint;
          ctx.font = '9px -apple-system, system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(NAMED_SESSION_LABEL[period.session], x0 + 2, top - binHeight / 2 - 2);
        }
      }
      if (vaTop !== null && vaBottom !== null) {
        ctx.globalAlpha = (period.session ? 0.08 : 0.06) * this.alpha;
        ctx.fillStyle = tint;
        ctx.fillRect(
          x0,
          Math.min(vaTop, vaBottom) - binHeight / 2,
          span,
          Math.abs(vaBottom - vaTop) + binHeight,
        );
      }
      let top = Infinity;
      let bottom = -Infinity;
      for (const bin of profile.bins) {
        if (bin.volume <= 0) continue;
        const y = series.priceToCoordinate(bin.price);
        if (y === null) continue;
        const inValue = bin.price >= profile.valueAreaLow && bin.price <= profile.valueAreaHigh;
        const w = (bin.volume / profile.peak) * maxWidth;
        paintBin(ctx, x0, y - binHeight / 2, w, Math.max(1, binHeight - 1), bin, inValue, this.alpha);
        top = Math.min(top, y - binHeight / 2);
        bottom = Math.max(bottom, y + binHeight / 2);
      }
      this.hits.add({
        type: 'area',
        key: period.session ? 'profile.session' : 'profile.period',
        facts,
        x0,
        y0: top,
        x1: x0 + maxWidth,
        y1: bottom,
      });
      ctx.globalAlpha = this.alpha;
      const pocY = series.priceToCoordinate(profile.poc);
      if (pocY !== null) {
        ctx.strokeStyle = '#FF6D00';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x0, pocY);
        ctx.lineTo(x0 + span, pocY);
        ctx.stroke();
        this.lineHit('profile.poc', facts, x0, x0 + span, pocY, {
          label: `POC ${period.label}`,
          price: profile.poc,
        });
      }
      for (const [key, price, name] of [
        ['profile.vah', profile.valueAreaHigh, 'VAH'],
        ['profile.val', profile.valueAreaLow, 'VAL'],
      ] as const) {
        const y = series.priceToCoordinate(price);
        if (y !== null)
          this.lineHit(key, facts, x0, x0 + span, y, { label: `${name} ${period.label}`, price });
      }
    }
    ctx.restore();
  }

  /**
   * Developing POC / VAH / VAL as step lines (PR-3) — each level held from its bar's open to the next
   * bar's — then the naked POCs (PR-2): dashed on to the right edge while naked, dotted and fainter up
   * to the bar that traded through them once touched. Then the mode's notice, if it draws nothing.
   */
  private drawProfileExtras(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
  ): void {
    const extras = this.extras;
    if (!extras) return;
    ctx.save();
    for (const d of extras.developing) {
      const facts: ProvenanceFacts = { label: d.period };
      this.stepLine(ctx, series, d.t, d.poc, '#FF6D00', 1.25, [], facts);
      this.stepLine(ctx, series, d.t, d.vah, '#2962FF', 1, [2, 2], facts);
      this.stepLine(ctx, series, d.t, d.val, '#2962FF', 1, [2, 2], facts);
    }
    const placed: number[] = [];
    for (const n of extras.naked) {
      const x0 = this.timeToX(n.from);
      const y = series.priceToCoordinate(n.price);
      if (x0 === null || y === null || x0 > width) continue;
      const x1 = n.until === null ? width : this.timeToX(n.until);
      if (x1 === null || x1 < 0) continue;
      ctx.globalAlpha = (n.until === null ? 0.9 : 0.45) * this.alpha;
      ctx.strokeStyle = '#FF6D00';
      ctx.lineWidth = 1;
      ctx.setLineDash(n.until === null ? [6, 3] : [1, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const facts: ProvenanceFacts = { label: n.period, bars: n.bars, touched: n.until !== null };
      const level = { label: n.until === null ? n.label : `POC ${n.period}`, price: n.price };
      this.lineHit('profile.npoc', facts, Math.max(0, x0), x1, y, level);
      // Only the naked ones are labelled: a touched POC is history, its line says where it ended.
      if (n.until === null) {
        ctx.globalAlpha = this.alpha;
        this.tag(
          ctx,
          `${n.label} ${n.price.toFixed(this.precision())}`,
          Math.max(4, x0 + 4),
          nudge(y, placed),
          '#FF6D00',
          'left',
          { key: 'profile.npoc', facts, level },
        );
      }
    }
    ctx.globalAlpha = this.alpha;
    if (extras.notice) this.notice(ctx, extras.notice);
    ctx.restore();
  }

  /** A step line through (t[i], v[i]): flat from each point to the next one's time, then a step. */
  private stepLine(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    t: readonly number[],
    v: readonly number[],
    colour: string,
    lineWidth: number,
    dash: number[],
    facts: ProvenanceFacts,
  ): void {
    ctx.save();
    ctx.globalAlpha = 0.85 * this.alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let prev: { x: number; y: number } | null = null;
    for (let i = 0; i < t.length; i++) {
      const x = this.timeToX(t[i]);
      const y = series.priceToCoordinate(v[i]);
      if (x === null || y === null) {
        prev = null;
        continue;
      }
      if (prev === null) ctx.moveTo(x, y);
      else {
        ctx.lineTo(x, prev.y);
        ctx.lineTo(x, y);
        this.lineHit('profile.developing', facts, prev.x, x, prev.y);
      }
      prev = { x, y };
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Why the chosen profile mode draws nothing, in the pane's top-left corner. */
  private notice(ctx: CanvasRenderingContext2D, text: string): void {
    ctx.save();
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 12;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(19, 23, 34, 0.75)';
    ctx.fillRect(8, 30, w, 20);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.fillText(text, 14, 40);
    ctx.restore();
  }

  /** POC (solid) and VAH/VAL (dashed) across [x0, x1], with tags on `side`. */
  private valueAreaLines(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    profile: VolumeProfileResult,
    x0: number,
    x1: number,
    side: 'left' | 'right',
    facts: ProvenanceFacts,
  ): void {
    const placed: number[] = [];
    const lines: Array<[string, number, string, number[], ProvenanceKey]> = [
      ['POC', profile.poc, '#FF6D00', [], 'profile.poc'],
      ['VAH', profile.valueAreaHigh, '#2962FF', [4, 3], 'profile.vah'],
      ['VAL', profile.valueAreaLow, '#2962FF', [4, 3], 'profile.val'],
    ];
    for (const [name, price, colour, dash, key] of lines) {
      const y = series.priceToCoordinate(price);
      if (y === null) continue;
      ctx.strokeStyle = colour;
      ctx.lineWidth = name === 'POC' ? 1.5 : 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const level = { label: name, price };
      this.lineHit(key, facts, x0, x1, y, level);
      this.tag(
        ctx,
        `${name} ${price.toFixed(this.precision())}`,
        side === 'right' ? x0 - 4 : x1 + 4,
        nudge(y, placed),
        colour,
        side,
        { key, facts, level },
      );
    }
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
    // Floor of 1, not 2: at a wide zoom a 2px floor makes neighbouring rows overlap, which
    // is what turned the profile into a solid block.
    if (a === null || b === null) return Math.max(1, height / profile.bins.length);
    return Math.max(1, Math.abs(b - a));
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
      ctx.globalAlpha = (0.35 + level.strength * 0.45) * this.alpha;
      ctx.strokeStyle = colour;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      ctx.globalAlpha = this.alpha;
      ctx.setLineDash([]);
      const facts: ProvenanceFacts = { touches: level.touches };
      this.lineHit('sr.level', facts, 0, width, y);
      this.tag(
        ctx,
        `${level.price.toFixed(this.precision())} · ${level.touches}×`,
        4,
        y,
        colour,
        'left',
        { key: 'sr.level', facts },
      );
    }
    ctx.restore();
  }

  /**
   * Auto analysis (DR-I11): each trendline from its first anchor out to the right edge, labelled with its touches and
   * score; the higher timeframe's levels as dotted lines labelled with it; the zig-zag Fib from the leg's end.
   */
  private drawAuto(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
  ): void {
    const auto = this.auto;
    if (!auto) return;
    const placed: number[] = [];
    ctx.save();
    for (const line of auto.trendlines) {
      const xa = this.timeToX(line.a.time);
      const xb = this.timeToX(line.b.time);
      const ya = series.priceToCoordinate(line.a.price);
      const yb = series.priceToCoordinate(line.b.price);
      if (xa === null || xb === null || ya === null || yb === null || xb === xa) continue;
      const k = (yb - ya) / (xb - xa);
      const yEnd = ya + k * (width - xa);
      const colour = line.kind === 'resistance' ? '#EF5350' : '#26A69A';
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.min(3, 1 + (line.touches - 2) * 0.5);
      ctx.globalAlpha = 0.85 * this.alpha;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xa, ya);
      ctx.lineTo(width, yEnd);
      ctx.stroke();
      ctx.globalAlpha = this.alpha;
      const facts: ProvenanceFacts = { touches: line.touches, score: line.score };
      this.hits.add({ type: 'line', key: 'auto.trendline', facts, x0: xa, y0: ya, x1: width, y1: yEnd });
      const yLabel = nudge(ya + k * (width - 70 - xa), placed);
      this.tag(
        ctx,
        `${line.touches} touches · ${line.score.toFixed(1)}`,
        width - 70,
        yLabel,
        colour,
        'right',
        { key: 'auto.trendline', facts },
      );
    }
    for (const level of auto.htf) {
      const y = series.priceToCoordinate(level.price);
      if (y === null) continue;
      const colour = level.kind === 'resistance' ? '#AB47BC' : '#5C6BC0';
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1 + level.strength;
      ctx.globalAlpha = 0.7 * this.alpha;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.globalAlpha = this.alpha;
      ctx.setLineDash([]);
      const facts: ProvenanceFacts = { timeframe: level.timeframe, touches: level.touches };
      this.lineHit('auto.htf', facts, 0, width, y);
      this.tag(
        ctx,
        `${level.timeframe} ${level.kind === 'resistance' ? 'R' : 'S'} ${level.touches}×`,
        width - 4,
        nudge(y, placed),
        colour,
        'right',
        { key: 'auto.htf', facts },
      );
    }
    const fib = auto.fib;
    if (fib) {
      const x0 = this.timeToX(fib.to.time) ?? 0;
      for (const l of fib.levels) {
        const y = series.priceToCoordinate(l.price);
        if (y === null) continue;
        ctx.strokeStyle = '#FF9800';
        ctx.lineWidth = l.ratio === 0.618 || l.ratio === 0.5 ? 1.5 : 1;
        ctx.globalAlpha = 0.8 * this.alpha;
        ctx.setLineDash(l.ratio === 0 || l.ratio === 1 ? [] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, x0), y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.globalAlpha = this.alpha;
        ctx.setLineDash([]);
        const facts: ProvenanceFacts = { ratio: l.ratio, deviation: fib.deviation };
        this.lineHit('auto.fib', facts, Math.max(0, x0), width, y);
        this.tag(
          ctx,
          `${l.ratio} (${l.price.toFixed(this.precision())})`,
          Math.max(4, x0 + 4),
          nudge(y, placed),
          '#FF9800',
          'left',
          { key: 'auto.fib', facts },
        );
      }
    }
    ctx.restore();
  }

  /** Zone fills, their edge levels, and the structural event markers. */
  private drawStructure(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    width: number,
  ): void {
    const structure = this.structure;
    if (!structure) return;
    const facts: ProvenanceFacts = { structure: structure.basis };

    const ZONE: Record<string, string> = {
      balance: '#5C6BC0',
      value: '#7E57C2',
      pool: '#FF7043',
    };
    const LEVEL: Record<string, string> = {
      structure: '#5C6BC0',
      value: '#7E57C2',
      pool: '#FF7043',
      live: '#2962FF',
    };

    ctx.save();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    for (const zone of structure.zones) {
      const top = series.priceToCoordinate(Math.max(zone.from, zone.to));
      const bottom = series.priceToCoordinate(Math.min(zone.from, zone.to));
      if (top === null || bottom === null) continue;
      const colour = ZONE[zone.kind] ?? '#787B86';
      const key = structureZoneKey(zone);
      // A stop pool can be under a pixel tall at a wide zoom; floor it so it stays visible.
      const h = Math.max(2, bottom - top);
      if (zone.kind === 'pool') {
        // An ESTIMATE, drawn softer than the measured zones: a light fill and a dashed edge, so it never
        // reads as stops someone saw (PR-4).
        ctx.globalAlpha = 0.1 * this.alpha;
        ctx.fillStyle = colour;
        ctx.fillRect(0, top, width, h);
        ctx.globalAlpha = 0.55 * this.alpha;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(0.5, Math.round(top) + 0.5, width - 1, Math.max(1, Math.round(h) - 1));
        ctx.setLineDash([]);
        this.hits.add({ type: 'area', key, facts, x0: 0, y0: top, x1: width, y1: top + h });
      } else {
        ctx.globalAlpha = 0.12 * this.alpha;
        ctx.fillStyle = colour;
        ctx.fillRect(0, top, width, h);
      }
      ctx.globalAlpha = (zone.kind === 'pool' ? 0.75 : 0.9) * this.alpha;
      ctx.fillStyle = colour;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(zone.label, 8, top + 2);
      const textW = ctx.measureText(zone.label).width;
      this.hits.add({ type: 'tag', key, facts, x0: 8, y0: top + 2, x1: 8 + textW, y1: top + 14 });
    }

    ctx.globalAlpha = this.alpha;
    // Tags are placed against the ones already drawn: VAH, POC, Range high and Last are
    // often within a few pips, and stacked at their exact prices they overwrite each other
    // — the first render had POC unreadable under Last.
    const placed: number[] = [];
    for (const level of structure.levels) {
      const y = series.priceToCoordinate(level.price);
      if (y === null) continue;
      const colour = LEVEL[level.kind] ?? '#787B86';
      ctx.strokeStyle = colour;
      ctx.lineWidth = level.kind === 'live' ? 1 : 1.2;
      ctx.setLineDash(level.kind === 'value' ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      const key = structureLevelKey(level);
      // Range edges and the value levels can carry an alert; "Last" moves with every tick, so not it.
      const alertable = level.kind === 'structure' || level.kind === 'value';
      const lvl = alertable ? { label: level.label, price: level.price } : undefined;
      this.lineHit(key, facts, 0, width, y, lvl);
      // The LINE stays at the true price; only the label moves, so nothing is misread as
      // sitting at a level it is not.
      this.tag(
        ctx,
        `${level.label} ${level.price.toFixed(this.precision())}`,
        width - 4,
        nudge(y, placed),
        colour,
        'right',
        { key, facts, level: lvl },
      );
    }
    ctx.setLineDash([]);

    const placedMarkers: number[] = [];
    for (const marker of structure.markers) {
      const y = series.priceToCoordinate(marker.price);
      if (y === null) continue;
      // No x projection here: the renderer has no time scale, so an event is drawn as a
      // labelled tick at its PRICE. The label carries what and when.
      const colour = marker.kind === 'climax' ? '#EF5350' : '#26A69A';
      this.tag(ctx, marker.label, 8, nudge(y, placedMarkers), colour, 'left', {
        key: structureMarkerKey(marker),
        facts,
      });
    }
    ctx.restore();
  }

  /** A filled label; with `hit`, its box is registered for the hover and the right-click. */
  private tag(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    colour: string,
    align: 'left' | 'right',
    hit?: { key: ProvenanceKey; facts: ProvenanceFacts; level?: AlertableLevel },
  ): void {
    ctx.save();
    ctx.globalAlpha = this.alpha;
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
    if (hit) this.hits.add({ type: 'tag', ...hit, x0: left, y0: y - 8, x1: left + w, y1: y + 8 });
  }
}
