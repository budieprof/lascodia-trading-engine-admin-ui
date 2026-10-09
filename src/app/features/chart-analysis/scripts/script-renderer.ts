import {
  LineSeries,
  type AutoscaleInfo,
  type DeepPartial,
  type IChartApi,
  type IChartApiBase,
  type ISeriesApi,
  type ITimeScaleApi,
  type LineSeriesOptions,
  type Logical,
  type LogicalRange,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

import { PineLayersPrimitive } from '@shared/pine-chart/lwc/pine-layers-primitive';
import type { HitRegion } from '@shared/pine-chart/lwc/paint-drawings';
import { statusLineValues, type LegendValue } from '@shared/pine-chart/render/legend';
import type { PineRenderModel, TableLayout } from '@shared/pine-chart/render/render-model';
import type { ChartScriptResult } from './chart-script.model';
import {
  barColorsOnHost,
  futureBarsOnHost,
  labelRightPx,
  runOffsetOnHost,
  type LabelReach,
} from './run-on-host';
import { DEFAULT_DISPLAY, type ScriptDisplaySettings } from './script-display';

/** The host's bar times (plotted seconds), read by index: a tick must not copy every bar. */
export interface HostTimes {
  readonly length: number;
  at(index: number): number;
}

/** What a script's drawing needs of the chart it is on (chart-host). */
export interface ScriptHost {
  chart(): IChartApi | null;
  /** The price series (the candles). A style change replaces it. */
  price(): ISeriesApi<SeriesType, Time> | null;
  /** The display zone's shift for a UTC instant (ms → ms); 0 on a UTC axis. */
  shiftMs(utcMs: number): number;
  /** The host's bars as plotted: zone-shifted Lightweight Charts seconds, ascending. */
  hostTimes(): HostTimes;
  /** The side the price scale is on (TradingView's "Scale position"). */
  priceSide(): 'left' | 'right';
  /**
   * Px a pane's price scale keeps clear at its top for the tables anchored there (PC-I11): the
   * scripts' autoscale asks for it. Optional: none.
   */
  tableMarginPx?(paneIndex: number): number;
}

/** A script's values at one bar, per pane (PC-I2 status lines). */
export interface ScriptStatus {
  /** Values on the price pane (an overlay script's, or a pane script's `force_overlay` outputs). */
  main: LegendValue[];
  /** Values in the script's own pane; null when it has none. */
  script: LegendValue[] | null;
}

/** The price scale a script's main-pane outputs are measured on. */
export type MainScale = 'price' | 'left' | 'right' | 'none';

/** An invisible line series a pane or an own scale is anchored by, and the times written to it. */
interface Anchor {
  series: ISeriesApi<'Line', Time>;
  scaleId: string;
  written: number[];
}

/**
 * The anchors' options: never drawn, never labelled. No `title` (PC-03): the library printed it on
 * the price axis at the anchor's constant value — a black "MSqueeze" tag on the zero line, the
 * colour's alpha dropped.
 */
export const ANCHOR_OPTIONS: DeepPartial<LineSeriesOptions> = Object.freeze({
  color: 'rgba(0,0,0,0)',
  lineVisible: false,
  pointMarkersVisible: false,
  crosshairMarkerVisible: false,
  lastValueVisible: false,
  priceLineVisible: false,
});

/** The price scale's margins, as chart-host gives its own (`scaleMargins`). */
const SCALE_MARGINS = { top: 0.1, bottom: 0.08 };

/**
 * One Pine script drawn on the chart-analysis chart with the SHARED Pine renderer
 * (`@shared/pine-chart`: one `PineLayersPrimitive` per pane paints plots, fills, hlines, bgcolor,
 * shapes, drawings and strategy trades exactly as the Pine chart does) — kept alive across runs
 * (PC-04, PC-I3): a new result, new display settings or a rebuilt price series change what is on
 * it, never the panes. A script pane is made once and keeps its height and place while the script
 * is on the chart; ticks reach it only as an `update()` of its anchor's newest bar.
 *
 * <p>The shared primitive projects by LOGICAL index, run bar 0 = logical 0. Here the host chart has
 * its own bar window, so each primitive sees the chart through a view whose logical axis is shifted
 * by the run's offset on the host — found each frame from the run's last bar time (`timeToIndex`),
 * so it survives the host prepending history. The run's bars and the host's are the same contiguous
 * sequence (both are the engine's candles at the same resolution and price basis).</p>
 *
 * <p>The declaration decides where it draws (PC-I10): an overlay script paints on the price pane, on
 * the price scale — or on its own invisible scale with `scale = scale.none` (it no longer squashes
 * the candles), or on the other side's scale with `scale.left` / `scale.right`; a non-overlay script
 * gets its own pane, anchored by an invisible line series whose autoscale is the script's value
 * range, on the chart's scale side, the declared side, or no axis at all (`scale.none`).
 * `behind_chart` (default true) paints the main-pane outputs under the candles, and
 * `explicit_plot_zorder` orders them as the code does (the render model's `drawOrder`).</p>
 *
 * <p>Two things belong to the host's own series rather than to a primitive, so the renderer only
 * reports them: `barcolor()` (the host draws its candles in those colours) and how far drawings
 * reach past the last bar (the host widens its right margin).</p>
 */
export class ScriptRenderer {
  private result: ChartScriptResult | null = null;
  private model: PineRenderModel | null = null;
  private display: ScriptDisplaySettings = DEFAULT_DISPLAY;
  private suspended = false;
  /** Index of the model's last bar (its time on the host axis: {@link lastTime}). */
  private lastBar = -1;
  /** Labels whose text runs right of their anchors: px, turned into bars at the host's zoom. */
  private labelReach: LabelReach[] = [];
  private readonly mainLayers: OffsetLayersPrimitive;
  /** The series the main-pane primitive is attached to (the price series, or `overlayAnchor`). */
  private mainSeries: ISeriesApi<SeriesType, Time> | null = null;
  private mainScale: MainScale = 'price';
  /** The own scale of an overlay script that does not share the price scale. */
  private overlayAnchor: Anchor | null = null;
  /** The script's own pane (non-overlay scripts). */
  private pane: { anchor: Anchor; layers: OffsetLayersPrimitive } | null = null;
  private disposed = false;

  constructor(
    private readonly host: ScriptHost,
    readonly key: string,
  ) {
    const offset = () => this.offset();
    this.mainLayers = new OffsetLayersPrimitive(this.hooks(true), offset, () =>
      this.drawn() ? (this.host.tableMarginPx?.(0) ?? 0) : 0,
    );
  }

  /** The run it shows. */
  get current(): ChartScriptResult | null {
    return this.result;
  }

  /** The render model it draws (display settings applied); null when there is none. */
  get renderModel(): PineRenderModel | null {
    return this.model;
  }

  get settings(): ScriptDisplaySettings {
    return this.display;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Show `model` (the run's render model with the display settings applied; null: nothing to
   * draw). `suspended`: the run does not fit the chart as it is now (another chart type, a basis
   * re-run on its way) — the panes stay, nothing is drawn.
   */
  update(
    result: ChartScriptResult,
    model: PineRenderModel | null,
    display: ScriptDisplaySettings,
    suspended = false,
  ): void {
    if (this.disposed) return;
    this.result = result;
    this.model = model && model.bars.time.length ? model : null;
    this.display = display;
    this.suspended = suspended;
    this.measure();
    this.place();
    this.paint();
  }

  /**
   * The host rebuilt (a new series, zone, style or history) or a frame needs the newest state:
   * re-find the run's last bar on the axis, re-attach to a replaced price series, and bring the
   * anchors' times in line with the host's bars.
   */
  syncHost(): void {
    if (this.disposed) return;
    this.measure();
    this.place();
    this.syncAnchors();
    this.mainLayers.redraw();
    this.pane?.layers.redraw();
  }

  /** The host's bars changed in place (a tick, a new bar, replay stepping back): the anchors follow. */
  syncAnchors(): void {
    const times = this.host.hostTimes();
    if (this.overlayAnchor) syncAnchorData(this.overlayAnchor, times);
    if (this.pane) syncAnchorData(this.pane.anchor, times);
  }

  /** What it draws is on the chart now: shown, not suspended, and with bars. */
  drawn(): boolean {
    return !this.disposed && !this.suspended && this.display.visible && this.model !== null;
  }

  /**
   * False when the run's last bar is not on the host chart's time axis (the host has not loaded
   * that bar, or the two bar sequences differ) — the drawings would be misplaced, so they are hidden.
   */
  aligned(): boolean {
    return this.offset() !== null;
  }

  /** Index of the script's own pane on the chart now; -1 when it has none. */
  scriptPaneIndex(): number {
    if (!this.pane) return -1;
    try {
      return this.pane.anchor.series.getPane().paneIndex();
    } catch {
      return -1;
    }
  }

  /** The chart sides whose price axis it needs shown (an own scale on the side the price is not on). */
  axisSides(): ('left' | 'right')[] {
    const out: ('left' | 'right')[] = [];
    const side = this.host.priceSide();
    if ((this.mainScale === 'left' || this.mainScale === 'right') && this.mainScale !== side)
      out.push(this.mainScale);
    const paneId = this.pane?.anchor.scaleId;
    if ((paneId === 'left' || paneId === 'right') && paneId !== side) out.push(paneId);
    return out;
  }

  /**
   * The run's Pine tables by host pane index. Tables are anchored to the pane, not to bars, so
   * they are HTML over the chart (the host mounts the shared table overlay), not canvas.
   */
  tables(): { paneIndex: number; tables: readonly TableLayout[] }[] {
    const m = this.model;
    // Not on the host axis (replay before its last bar, another window): its tables would show
    // values of bars the chart does not show — in replay, the future (PC-08).
    if (!m || !this.drawn() || !this.aligned()) return [];
    const out: { paneIndex: number; tables: readonly TableLayout[] }[] = [];
    if (m.panes.main.tables.length) out.push({ paneIndex: 0, tables: m.panes.main.tables });
    const paneIndex = this.scriptPaneIndex();
    if (m.panes.script?.tables.length && paneIndex > 0)
      out.push({ paneIndex, tables: m.panes.script.tables });
    return out;
  }

  /**
   * The run's `barcolor()` on the host's bars: given the host's bar times as plotted (zone-shifted
   * seconds, ascending), one CSS colour per host bar, null where the run leaves a bar alone. Null
   * when the run colours nothing on the host axis. Reads no chart state, so the host can ask while
   * it rebuilds its price series — the price series is drawn with these colours, not painted over.
   */
  barColors(hostTimes: ArrayLike<number>): (string | null)[] | null {
    const m = this.model;
    const last = this.lastTime;
    if (!m?.bars.colors || !this.drawn() || last === null) return null;
    return barColorsOnHost(
      m.bars.colors,
      runOffsetOnHost(hostTimes, last, this.lastBar),
      hostTimes.length,
    );
  }

  /**
   * How many bars past the host's last bar the run's outputs reach (future labels, lines and
   * boxes, positive plot offsets, and — at `barSpacing` px per bar — the text of labels running
   * right of their anchors); 0 when none do or the run is not on the host axis. Fractional.
   */
  futureBars(hostTimes: ArrayLike<number>, barSpacing?: number): number {
    const m = this.model;
    const last = this.lastTime;
    if (!m || !this.drawn() || last === null) return 0;
    return futureBarsOnHost(
      runOffsetOnHost(hostTimes, last, this.lastBar),
      this.lastBar,
      m.futureSlots,
      hostTimes.length,
      this.labelReach,
      barSpacing,
    );
  }

  /**
   * The run's logical index for a host logical index (the bar under the crosshair); its last bar
   * when there is none — TradingView's resting legend. Null when the run is not on the axis.
   */
  runLogical(hostLogical: number | null): number | null {
    const m = this.model;
    if (!m) return null;
    if (hostLogical === null || !Number.isFinite(hostLogical)) return m.timeline.length - 1;
    const o = this.offset();
    return o === null ? null : Math.round(hostLogical) - o;
  }

  /** Its status-line values at a host bar (null: at rest — its last bar). */
  statusAt(hostLogical: number | null): ScriptStatus | null {
    const m = this.model;
    const logical = this.runLogical(hostLogical);
    if (!m || logical === null) return null;
    return {
      main: statusLineValues(m.panes.main, logical),
      script: m.panes.script ? statusLineValues(m.panes.script, logical) : null,
    };
  }

  /** The tooltip region under a pane-relative point in the last frame, topmost first. */
  hitAt(paneIndex: number, x: number, y: number): HitRegion | null {
    if (!this.drawn()) return null;
    const hits =
      paneIndex === 0
        ? this.mainLayers.hits
        : paneIndex === this.scriptPaneIndex()
          ? (this.pane?.layers.hits ?? [])
          : [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    }
    return null;
  }

  /** Repaint without new data (trades shown or hidden, a frame after a hover). */
  redraw(): void {
    this.mainLayers.redraw();
    this.pane?.layers.redraw();
  }

  /** Removes the primitives, its scales' anchor series and its pane. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attachMain(null);
    this.removeOverlayAnchor();
    this.removePane();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private hooks(main: boolean) {
    return {
      highlight: () => null,
      highlightColor: () => 'rgba(41, 98, 255, 0.14)',
      showTrades: () => this.display.showTrades,
      // Behind the candles: only where there are candles, the price pane.
      behindChart: () =>
        main && (this.display.behindChart ?? this.model?.declaration?.behindChart !== false),
    };
  }

  /** Host logical index of run bar 0, or null when the run is not on the host axis. */
  private offset(): number | null {
    const chart = this.host.chart();
    const last = this.lastTime;
    if (!chart || last === null) return null;
    const idx = chart.timeScale().timeToIndex(last as Time, false);
    return idx === null ? null : (idx as number) - this.lastBar;
  }

  /**
   * The run's last bar on the host axis (plotted seconds) — on the display clock as it is NOW, so a
   * zone switch never leaves the run looking for its bar at the old clock's time.
   */
  private get lastTime(): number | null {
    const m = this.model;
    if (!m || this.lastBar < 0) return null;
    const ms = m.bars.time[this.lastBar];
    return Math.floor((ms + this.host.shiftMs(ms)) / 1000);
  }

  private measure(): void {
    const m = this.model;
    if (!m) {
      this.lastBar = -1;
      this.labelReach = [];
      return;
    }
    // The model's bars, which every logical index (drawings, bar colours) counts.
    this.lastBar = m.bars.time.length - 1;
    const reach: LabelReach[] = [];
    for (const pane of [m.panes.main, m.panes.script]) {
      for (const l of pane?.drawings.labels ?? []) {
        const px = labelRightPx(l);
        if (px > 0) reach.push({ x: l.x, px });
      }
    }
    this.labelReach = reach;
  }

  /** Where the main-pane outputs are measured (PC-I10). */
  private mainScaleFor(m: PineRenderModel | null): MainScale {
    const scale = m?.declaration?.scale ?? null;
    // A pane script's own pane takes its declared scale; its force_overlay outputs stay on the price's.
    if (!m || !m.overlay || scale === null) return 'price';
    if (scale === 'none') return 'none';
    return scale === this.host.priceSide() ? 'price' : scale;
  }

  /** The price scale id of the script's own pane: the declared side, none (no axis), or the chart's. */
  private paneScaleIdFor(m: PineRenderModel): string {
    const scale = m.declaration?.scale ?? null;
    if (scale === 'none') return `pine:${this.key}`;
    return scale ?? this.host.priceSide();
  }

  /** Attach the primitives where the declaration and the chart put them now. */
  private place(): void {
    const chart = this.host.chart();
    if (!chart || this.disposed) return;
    const m = this.model;

    const scale = this.mainScaleFor(m);
    this.mainScale = scale;
    if (scale === 'price') {
      this.removeOverlayAnchor();
      this.attachMain(this.host.price());
    } else {
      const scaleId = scale === 'none' ? `pine:${this.key}` : scale;
      if (this.overlayAnchor && this.overlayAnchor.scaleId !== scaleId) this.removeOverlayAnchor();
      this.overlayAnchor ??= this.makeAnchor(chart, scaleId, 0, this.mainLayers);
      this.attachMain(this.overlayAnchor.series);
    }

    if (m?.panes.script) {
      const scaleId = this.paneScaleIdFor(m);
      if (!this.pane) {
        const layers = new OffsetLayersPrimitive(this.hooks(false), () => this.offset());
        layers.marginAbove = () =>
          this.drawn() ? (this.host.tableMarginPx?.(this.scriptPaneIndex()) ?? 0) : 0;
        const anchor = this.makeAnchor(chart, scaleId, chart.panes().length, layers);
        anchor.series.attachPrimitive(layers);
        this.pane = { anchor, layers };
      } else if (this.pane.anchor.scaleId !== scaleId) {
        this.pane.anchor.series.applyOptions({ priceScaleId: scaleId });
        this.pane.anchor.series.priceScale().applyOptions({ scaleMargins: SCALE_MARGINS });
        this.pane.anchor.scaleId = scaleId;
      }
    } else if (m) {
      // The script no longer has a pane of its own (an edit made it an overlay).
      this.removePane();
    }
  }

  private paint(): void {
    const show = this.drawn();
    const m = show ? this.model : null;
    this.mainLayers.setData(m ? m.panes.main : null, m);
    if (this.pane) {
      this.pane.layers.setData(m ? m.panes.script : null, m);
      if (m) {
        const fmt = m.format;
        const minMove = Math.pow(10, -fmt.precision);
        this.pane.anchor.series.applyOptions({
          priceFormat:
            fmt.format === 'percent' || fmt.format === 'volume'
              ? { type: fmt.format, precision: fmt.precision, minMove }
              : { type: 'price', precision: fmt.precision, minMove },
        });
      }
    }
  }

  private attachMain(series: ISeriesApi<SeriesType, Time> | null): void {
    if (this.mainSeries === series) return;
    const old = this.mainSeries;
    if (old) safe(() => old.detachPrimitive(this.mainLayers));
    this.mainSeries = series;
    series?.attachPrimitive(this.mainLayers);
  }

  /**
   * An invisible line series on `scaleId` in pane `paneIndex`, spanning the host's bars so the pane
   * shares the time axis; its autoscale is `layers`' value range over the visible bars.
   */
  private makeAnchor(
    chart: IChartApi,
    scaleId: string,
    paneIndex: number,
    layers: OffsetLayersPrimitive,
  ): Anchor {
    const series = chart.addSeries(
      LineSeries,
      {
        ...ANCHOR_OPTIONS,
        priceScaleId: scaleId,
        autoscaleInfoProvider: (): AutoscaleInfo | null => this.rangeOf(layers),
      },
      paneIndex,
    );
    series.priceScale().applyOptions({ scaleMargins: SCALE_MARGINS });
    const anchor: Anchor = { series, scaleId, written: [] };
    syncAnchorData(anchor, this.host.hostTimes());
    return anchor;
  }

  /**
   * `layers`' value range over the visible bars (padded when flat), for an anchor's autoscale —
   * with the room its pane's top tables need (PC-I11).
   */
  private rangeOf(layers: OffsetLayersPrimitive): AutoscaleInfo | null {
    const r = this.host.chart()?.timeScale().getVisibleLogicalRange();
    const o = this.offset();
    if (!r || o === null) return null;
    const range = layers.valueRange(Math.floor(r.from) - o, Math.ceil(r.to) - o);
    if (!range) return null;
    const pad = range.min === range.max ? Math.abs(range.min) * 0.01 || 1 : 0;
    const above = layers.marginAbove();
    return {
      priceRange: { minValue: range.min - pad, maxValue: range.max + pad },
      ...(above > 0 ? { margins: { above, below: 0 } } : {}),
    };
  }

  private removeOverlayAnchor(): void {
    const a = this.overlayAnchor;
    if (!a) return;
    this.overlayAnchor = null;
    if (this.mainSeries === a.series) this.attachMain(null);
    const chart = this.host.chart();
    safe(() => chart?.removeSeries(a.series));
  }

  private removePane(): void {
    const p = this.pane;
    if (!p) return;
    this.pane = null;
    const chart = this.host.chart();
    if (!chart) return;
    const index = (() => {
      try {
        return p.anchor.series.getPane().paneIndex();
      } catch {
        return -1;
      }
    })();
    safe(() => p.anchor.series.detachPrimitive(p.layers));
    safe(() => chart.removeSeries(p.anchor.series));
    // The library keeps an emptied pane only when asked to; remove it when it is still there.
    if (index > 0 && index < chart.panes().length) {
      const pane = chart.panes()[index];
      if (pane && pane.getSeries().length === 0) safe(() => chart.removePane(index));
    }
  }
}

/**
 * Bring an anchor's times in line with the host's bars by the least work: nothing when they are
 * the same bars (a tick moved the forming one), one `update()` for a bar opened on the end, one
 * `pop()` for bars taken off it (replay stepping back), else every time again (a rebuild).
 */
export function syncAnchorData(
  anchor: Pick<Anchor, 'series' | 'written'>,
  times: HostTimes,
): void {
  const w = anchor.written;
  const n = times.length;
  const m = w.length;
  const sameStart = n > 0 && m > 0 && times.at(0) === w[0];
  if (n === m && (n === 0 || (sameStart && times.at(n - 1) === w[m - 1]))) return;
  if (n === m + 1 && m > 0 && sameStart && times.at(m - 1) === w[m - 1]) {
    const t = times.at(n - 1);
    anchor.series.update({ time: t as UTCTimestamp, value: 0 });
    w.push(t);
    return;
  }
  if (n > 0 && n < m && sameStart && times.at(n - 1) === w[n - 1]) {
    anchor.series.pop(m - n);
    w.length = n;
    return;
  }
  const all = new Array<number>(n);
  for (let i = 0; i < n; i++) all[i] = times.at(i);
  anchor.series.setData(all.map((t) => ({ time: t as UTCTimestamp, value: 0 })));
  anchor.written = all;
}

/** Plain bar times as {@link HostTimes}. */
export function hostTimesOf(times: ArrayLike<number>): HostTimes {
  return { length: times.length, at: (i) => times[i] };
}

/**
 * The shared primitive, seeing the chart through a logical axis shifted by `offset()` (run bar 0 =
 * logical 0). Paints nothing while the run is not on the host axis.
 */
export class OffsetLayersPrimitive extends PineLayersPrimitive {
  constructor(
    hooks: ConstructorParameters<typeof PineLayersPrimitive>[0],
    private readonly offset: () => number | null,
    /** Px of top margin to ask of the scale (tables anchored at the pane's top, PC-I11). */
    public marginAbove: () => number = () => 0,
  ) {
    super(hooks);
  }

  override attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    super.attached({ ...param, chart: shiftedChart(param.chart, this.offset) });
  }

  override autoscaleInfo(start: number, end: number): AutoscaleInfo | null {
    const o = this.offset();
    const base = o === null ? null : super.autoscaleInfo(start - o, end - o);
    const above = this.marginAbove();
    if (!(above > 0)) return base;
    return { priceRange: base?.priceRange ?? null, margins: { above, below: 0 } };
  }
}

/** `chart` whose time scale reads logical `l` as the real chart's `l + offset()`. */
export function shiftedChart(
  chart: IChartApiBase<Time>,
  offset: () => number | null,
): IChartApiBase<Time> {
  const shiftedTs = (ts: ITimeScaleApi<Time>): ITimeScaleApi<Time> =>
    new Proxy(ts, {
      get(target, prop, receiver) {
        if (prop === 'getVisibleLogicalRange') {
          return (): LogicalRange | null => {
            const o = offset();
            const r = target.getVisibleLogicalRange();
            if (!r || o === null) return null;
            return { from: (r.from - o) as Logical, to: (r.to - o) as Logical };
          };
        }
        if (prop === 'logicalToCoordinate') {
          return (l: Logical) => {
            const o = offset();
            return o === null ? null : target.logicalToCoordinate((l + o) as Logical);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  return new Proxy(chart, {
    get(target, prop, receiver) {
      if (prop === 'timeScale') return () => shiftedTs(target.timeScale());
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* chart torn down first */
  }
}
