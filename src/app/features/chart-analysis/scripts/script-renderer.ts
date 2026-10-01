import {
  LineSeries,
  type AutoscaleInfo,
  type IChartApi,
  type IChartApiBase,
  type ISeriesApi,
  type ITimeScaleApi,
  type LineData,
  type Logical,
  type LogicalRange,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

import { PineLayersPrimitive } from '@shared/pine-chart/lwc/pine-layers-primitive';
import { buildRenderModel } from '@shared/pine-chart/render/build-render-model';
import type { PineRenderModel } from '@shared/pine-chart/render/render-model';
import type { ChartScriptResult } from './chart-script.model';

export interface ScriptRenderOptions {
  /**
   * The chart's display-timezone shift for a UTC instant (ms → ms) — chart-host's
   * `timezoneShiftMs`. Used only to find the run's bars on the host's (shifted) time axis.
   * Default: none (UTC).
   */
  shiftMs?: (utcMs: number) => number;
  /** Draw strategy fills (entry/exit arrows with signal, qty and P&L, entry→exit line). Default true. */
  showTrades?: boolean;
  /** Symbol price decimals; inferred from the run's bars when omitted. */
  pricePrecision?: number | null;
}

export interface ScriptRenderHandle {
  /** Removes the primitives, the script pane's anchor series and the pane. Idempotent. */
  dispose(): void;
  /** Toggle the strategy's trade drawings without re-rendering. */
  setShowTrades(show: boolean): void;
  /**
   * False when the run's last bar is not on the host chart's time axis (the host has not loaded
   * that bar, or the two bar sequences differ) — the drawings would be misplaced, so they are hidden.
   */
  aligned(): boolean;
}

/**
 * Draws a run on the chart-analysis chart with the SHARED Pine renderer (`@shared/pine-chart`,
 * the one the strategy-edit preview uses): `buildRenderModel` + one `PineLayersPrimitive` per pane
 * paint plots, fills, hlines, bgcolor, plotshape/plotchar/arrows, labels/lines/boxes/polylines and
 * strategy trades exactly as the Pine chart does.
 *
 * <p>The shared primitive projects by LOGICAL index, assuming bar 0 of the run is logical 0 of the
 * chart (true on its own chart). Here the host chart has its own bar window, so each primitive sees
 * the chart through a view whose logical axis is shifted by the run's offset on the host — found
 * each frame from the run's last bar time (`timeToIndex`), so it survives the host prepending
 * history. This assumes the run's bars and the host's are the same contiguous sequence (both come
 * from the engine's candles at the same resolution).</p>
 *
 * <p>`declaration.overlay` is respected: an overlay script paints on the price pane (attached to
 * `mainSeries`, sharing its scale, extending its autoscale); a non-overlay script gets its own pane
 * below, anchored by an invisible line series whose autoscale is the script's value range.</p>
 */
export function renderScriptResult(
  chart: IChartApi,
  mainSeries: ISeriesApi<SeriesType, Time>,
  result: ChartScriptResult,
  options: ScriptRenderOptions = {},
): ScriptRenderHandle {
  let showTrades = options.showTrades !== false;
  const noop: ScriptRenderHandle = { dispose: () => undefined, setShowTrades: () => undefined, aligned: () => false };
  const run = result.run;
  if (!run || !run.bars.length) return noop;

  const model: PineRenderModel = buildRenderModel(
    { bars: run.bars, outputs: run.outputs, report: run.report, declaration: run.compile?.declaration ?? null },
    { pricePrecision: options.pricePrecision ?? null, trades: true },
  );

  const shift = options.shiftMs ?? (() => 0);
  const hostTime = (ms: number) => Math.floor((ms + shift(ms)) / 1000) as UTCTimestamp;
  const lastBar = run.bars.length - 1;
  const lastTime = hostTime(run.bars[lastBar].t);

  /** Host logical index of run bar 0, or null when the run is not on the host axis. */
  const offset = (): number | null => {
    const idx = chart.timeScale().timeToIndex(lastTime as Time, false);
    return idx === null ? null : (idx as number) - lastBar;
  };

  const hooks = {
    highlight: () => null,
    highlightColor: () => 'rgba(41, 98, 255, 0.14)',
    showTrades: () => showTrades,
  };

  const cleanups: (() => void)[] = [];

  // ── main (price) pane ──
  const mainLayers = new OffsetLayersPrimitive(hooks, offset);
  mainSeries.attachPrimitive(mainLayers);
  mainLayers.setData(model.panes.main, model);
  cleanups.push(() => safe(() => mainSeries.detachPrimitive(mainLayers)));

  // ── script pane (non-overlay) ──
  let anchor: ISeriesApi<'Line', Time> | null = null;
  let paneIndex = -1;
  if (model.panes.script) {
    paneIndex = chart.panes().length;
    const scriptLayers = new OffsetLayersPrimitive(hooks, offset);
    anchor = chart.addSeries(
      LineSeries,
      {
        color: 'rgba(0,0,0,0)',
        lineVisible: false,
        pointMarkersVisible: false,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        title: model.title,
        autoscaleInfoProvider: (): AutoscaleInfo | null => {
          const r = chart.timeScale().getVisibleLogicalRange();
          const o = offset();
          if (!r || o === null) return null;
          const range = scriptLayers.valueRange(Math.floor(r.from) - o, Math.ceil(r.to) - o);
          if (!range) return null;
          const pad = range.min === range.max ? Math.abs(range.min) * 0.01 || 1 : 0;
          return { priceRange: { minValue: range.min - pad, maxValue: range.max + pad } };
        },
      },
      paneIndex,
    );
    anchor.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    const fmt = model.format;
    const minMove = Math.pow(10, -fmt.precision);
    anchor.applyOptions({
      priceFormat:
        fmt.format === 'percent' || fmt.format === 'volume'
          ? { type: fmt.format, precision: fmt.precision, minMove }
          : { type: 'price', precision: fmt.precision, minMove },
    });
    // The anchor spans the host's own bar times so the pane shares the time axis.
    const base = 0;
    anchor.setData(
      mainSeries.data().map((d) => ({ time: d.time, value: base }) as LineData<Time>),
    );
    anchor.attachPrimitive(scriptLayers);
    scriptLayers.setData(model.panes.script, model);
    const a = anchor;
    cleanups.push(() => safe(() => a.detachPrimitive(scriptLayers)));
    cleanups.push(() => safe(() => chart.removeSeries(a)));
  }

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const c of cleanups.reverse()) c();
      if (paneIndex > 0 && paneIndex < chart.panes().length) {
        const pane = chart.panes()[paneIndex];
        if (pane && pane.getSeries().length === 0) safe(() => chart.removePane(paneIndex));
      }
    },
    setShowTrades: (show: boolean) => {
      showTrades = show;
      mainLayers.redraw();
    },
    aligned: () => offset() !== null,
  };
}

/**
 * The shared primitive, seeing the chart through a logical axis shifted by `offset()` (run bar 0 =
 * logical 0). Paints nothing while the run is not on the host axis.
 */
class OffsetLayersPrimitive extends PineLayersPrimitive {
  constructor(
    hooks: ConstructorParameters<typeof PineLayersPrimitive>[0],
    private readonly offset: () => number | null,
  ) {
    super(hooks);
  }

  override attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    super.attached({ ...param, chart: shiftedChart(param.chart, this.offset) });
  }

  override autoscaleInfo(start: number, end: number): AutoscaleInfo | null {
    const o = this.offset();
    return o === null ? null : super.autoscaleInfo(start - o, end - o);
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
