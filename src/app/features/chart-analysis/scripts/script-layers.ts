import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';

import type { PineRenderModel } from '@shared/pine-chart/render/render-model';
import type { ChartScriptResult, ScriptBasis } from './chart-script.model';
import { runMatchesChart, type SeriesId } from './live-bar';
import {
  DEFAULT_DISPLAY,
  resolveDisplay,
  visibleOnTimeframe,
  type ScriptDisplaySettings,
} from './script-display';
import { ScriptRenderer, type ScriptHost } from './script-renderer';
import type { ScriptLabel } from './script-status';

/** One Pine script on the chart, as chart-host draws it (its `scriptResults` input). */
export interface ChartScriptLayer {
  /** The run's key on the page (`mine:7`, `strategy:12`, `editor:…`): layers are diffed by it. */
  key: string;
  result: ChartScriptResult;
  /** Its eye and Style/Visibility settings, resolved; the defaults when absent. */
  display?: ScriptDisplaySettings;
  /**
   * Why it is not drawn on the chart as it is now — another chart type, its re-run for this one
   * still on the way, a run past Bar Replay's head; null or absent: drawn. Its pane stays meanwhile.
   */
  suspended?: string | null;
  /** What its status line says of a run that is drawn but not current: catching up in replay. */
  note?: string | null;
  /** What its status line prints besides its values: title, inputs, failure (PC-I2). */
  label?: ScriptLabel;
}

/** A run on the page, as far as the chart's layers read it. */
export interface LayerRun extends SeriesId {
  item: { key: string };
  result: ChartScriptResult;
  display?: Partial<ScriptDisplaySettings>;
  /** The bars it was computed on; absent = standard. */
  chartType?: ScriptBasis;
  /** The Bar Replay head it was run to (that bar's open, Unix ms); absent: run to now. */
  until?: number;
}

/** The chart the layers are for, as far as they read it. */
export interface LayerChart {
  /** Its symbol and resolution. */
  chart: SeriesId;
  /** The series its bars on screen are; null while none are loaded. */
  bars: SeriesId | null;
  /** The bars runs are computed on for its style; null on a price-based style. */
  basis: ScriptBasis | null;
  /** Why no script is drawn on its chart type ("Not available on Renko charts"); null when they are. */
  unavailable: string | null;
  /** Bar Replay's head: the open (Unix ms) of the last bar it shows; null or absent outside replay. */
  replayHead?: number | null;
}

/** A run reaches past Bar Replay's head: nothing of it shows until its run to the head lands. */
export const REPLAY_AHEAD = 'Running to the replay head…';
/** A run ends before Bar Replay's head: it shows as far as it goes while its run to the head comes. */
export const REPLAY_BEHIND = 'Catching up with the replay head…';

/** Open time (Unix ms) of a run's last bar; null when it has none. */
export function runLastBarMs(result: ChartScriptResult): number | null {
  const bars = result.run?.bars;
  return bars?.length ? bars[bars.length - 1].t : null;
}

/**
 * Where a run stands against Bar Replay's head (PC-08, PC-I8); null outside replay, and once its run
 * to the head has landed.
 *
 * - `ahead`: it was computed past the head — a run to now, or to a later head before the operator
 *   stepped back. Its plots, drawings, tables and trades would show bars the chart has not reached,
 *   so none of it is shown until its run to the head lands. Judged by its bars, never by what it was
 *   asked for: that is what keeps the future off the chart.
 * - `behind`: it was run to another head (or to now, on bars that end before the head): it shows as
 *   far as it goes — every bar of it is at or before the head — while its run to the head comes.
 */
export function replayLag(
  run: Pick<LayerRun, 'result' | 'until'>,
  head: number | null | undefined,
): 'ahead' | 'behind' | null {
  if (head === null || head === undefined) return null;
  const last = runLastBarMs(run.result);
  if (last !== null && last > head) return 'ahead';
  return run.until === head ? null : 'behind';
}

/**
 * The layers the chart draws for the page's runs: those computed for its symbol and resolution,
 * once its bars are that series (through a switch the previous runs' outputs go at once and the new
 * runs wait for the new bars), each with its display settings. A run is suspended — its pane stays,
 * nothing drawn — on a chart type runs cannot sit on (`unavailable`), while its run for the chart's
 * bars is on its way (Heikin-Ashi ↔ standard, PC-09), and in Bar Replay while it reaches past the
 * head (PC-08); one that ends before the head is drawn, its status line saying it is catching up.
 */
export function chartScriptLayers<R extends LayerRun>(
  runs: readonly R[],
  on: LayerChart,
  labelOf?: (run: R) => ScriptLabel,
): ChartScriptLayer[] {
  const { chart, bars, basis, unavailable } = on;
  return runs
    .filter((r) => runMatchesChart(r, chart, bars))
    .map((r) => {
      const display = resolveDisplay(r.display);
      const lag = replayLag(r, on.replayHead);
      const suspended =
        unavailable ??
        hiddenOnTimeframe(display, chart.resolution) ??
        ((r.chartType ?? 'standard') !== basis ? 'Running on the new chart type…' : null) ??
        (lag === 'ahead' ? REPLAY_AHEAD : null);
      // A hidden indicator is not run to the head (nothing of it shows), so it is not catching up.
      const catchingUp =
        lag === 'behind' && !suspended && (display.visible || r.result.kind === 'strategy');
      return {
        key: r.item.key,
        result: r.result,
        display,
        suspended,
        note: catchingUp ? REPLAY_BEHIND : null,
        ...(labelOf ? { label: labelOf(r) } : {}),
      };
    });
}

/** Two lists of layers draw and label the same: what the page's computed compares by. */
export function sameLayers(a: readonly ChartScriptLayer[], b: readonly ChartScriptLayer[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (l, i) =>
        l.key === b[i].key &&
        l.result === b[i].result &&
        l.suspended === b[i].suspended &&
        (l.note ?? null) === (b[i].note ?? null) &&
        JSON.stringify(l.display) === JSON.stringify(b[i].display) &&
        JSON.stringify(l.label) === JSON.stringify(b[i].label),
    )
  );
}

/** Why a script is not shown on this timeframe (its Visibility tab), or null. */
export function hiddenOnTimeframe(
  display: Pick<ScriptDisplaySettings, 'timeframes'>,
  resolution: string,
): string | null {
  return visibleOnTimeframe(display.timeframes, resolution)
    ? null
    : 'Hidden on this timeframe (its Visibility settings)';
}

/** The render model a layer draws: its run's, with its display settings applied. */
export type LayerModel = (result: ChartScriptResult, display: ScriptDisplaySettings) =>
  PineRenderModel | null;

/**
 * The scripts on the chart, by key (PC-04, PC-I3). `sync` diffs the page's layers against what is
 * drawn: a script that left is disposed (its pane goes), a new one gets a renderer, and one whose
 * result or settings changed gets them — its panes, scales and anchors stay as they are, so a pane
 * the operator resized keeps its height and its place among the study panes. Every sync also
 * re-attaches to a replaced price series and lines the anchors up with the host's bars; between
 * syncs, a tick reaches the anchors as one `update()` of a new bar, through the price series'
 * data-changed event — never a re-render.
 */
export class ScriptLayers {
  private readonly renderers = new Map<string, ScriptRenderer>();
  /** Keys in the page's order: a later script's `barcolor()` wins. */
  private order: string[] = [];
  /** What each renderer was last given, to skip a sync that changes nothing for it. */
  private readonly given = new Map<string, { display: string; suspended: boolean }>();
  private chart: IChartApi | null = null;
  private price: ISeriesApi<SeriesType, Time> | null = null;
  private modelKey = '';
  private readonly onPriceData = () => {
    for (const r of this.renderers.values()) r.syncAnchors();
  };

  constructor(
    private readonly host: ScriptHost,
    private readonly modelOf: LayerModel,
  ) {}

  /** The renderers in the page's order. */
  list(): ScriptRenderer[] {
    const out: ScriptRenderer[] = [];
    for (const key of this.order) {
      const r = this.renderers.get(key);
      if (r) out.push(r);
    }
    return out;
  }

  get(key: string): ScriptRenderer | null {
    return this.renderers.get(key) ?? null;
  }

  get size(): number {
    return this.renderers.size;
  }

  /**
   * Draw exactly `layers`, by the least change (see the class comment). `modelKey` names what the
   * render models are built with besides each layer's own (the symbol's precision, the theme): a
   * change restyles every layer.
   */
  sync(layers: readonly ChartScriptLayer[], modelKey = ''): void {
    const chart = this.host.chart();
    if (chart !== this.chart) {
      // A new chart: everything drawn went with the old one.
      for (const r of this.renderers.values()) r.dispose();
      this.renderers.clear();
      this.given.clear();
      this.watch(null);
      this.chart = chart;
    }
    if (!chart) return;
    if (modelKey !== this.modelKey) {
      this.modelKey = modelKey;
      this.given.clear();
    }

    const wanted = new Set(layers.map((l) => l.key));
    for (const [key, r] of [...this.renderers]) {
      if (wanted.has(key)) continue;
      r.dispose();
      this.renderers.delete(key);
      this.given.delete(key);
    }
    this.order = layers.map((l) => l.key);

    for (const l of layers) {
      const display = l.display ?? DEFAULT_DISPLAY;
      const suspended = !!l.suspended;
      const displayKey = JSON.stringify(display);
      let r = this.renderers.get(l.key);
      const before = this.given.get(l.key);
      if (
        r &&
        r.current === l.result &&
        before?.display === displayKey &&
        before.suspended === suspended
      )
        continue;
      if (!r) {
        r = new ScriptRenderer(this.host, l.key);
        this.renderers.set(l.key, r);
      }
      r.update(l.result, this.modelOf(l.result, display), display, suspended);
      this.given.set(l.key, { display: displayKey, suspended });
    }

    this.watch(this.host.price());
    for (const r of this.renderers.values()) r.syncHost();
  }

  /** Every renderer re-placed on the scales as the chart has them now (the price moved sides). */
  syncScales(): void {
    for (const r of this.renderers.values()) r.syncHost();
  }

  /** The chart sides whose price axis the scripts need shown. */
  axisSides(): Set<'left' | 'right'> {
    const out = new Set<'left' | 'right'>();
    for (const r of this.renderers.values()) for (const s of r.axisSides()) out.add(s);
    return out;
  }

  dispose(): void {
    for (const r of this.renderers.values()) r.dispose();
    this.renderers.clear();
    this.given.clear();
    this.order = [];
    this.watch(null);
    this.chart = null;
  }

  /** Follow the price series' data (ticks): the anchors take its new bars. */
  private watch(price: ISeriesApi<SeriesType, Time> | null): void {
    if (price === this.price) return;
    const old = this.price;
    if (old) {
      try {
        old.unsubscribeDataChanged(this.onPriceData);
      } catch {
        // Removed with a style change.
      }
    }
    this.price = price;
    price?.subscribeDataChanged(this.onPriceData);
  }
}
