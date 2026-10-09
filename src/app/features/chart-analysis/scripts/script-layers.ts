import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';

import type { PineRenderModel } from '@shared/pine-chart/render/render-model';
import type { ChartScriptResult } from './chart-script.model';
import { DEFAULT_DISPLAY, type ScriptDisplaySettings } from './script-display';
import { ScriptRenderer, type ScriptHost } from './script-renderer';

/** One Pine script on the chart, as chart-host draws it (its `scriptResults` input). */
export interface ChartScriptLayer {
  /** The run's key on the page (`mine:7`, `strategy:12`, `editor:…`): layers are diffed by it. */
  key: string;
  result: ChartScriptResult;
  /** Its eye and Style/Visibility settings, resolved; the defaults when absent. */
  display?: ScriptDisplaySettings;
  /**
   * Why it is not drawn on the chart as it is now — another chart type, its re-run for this one
   * still on the way; null or absent: drawn. Its pane stays meanwhile.
   */
  suspended?: string | null;
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

  /** Draw exactly `layers`, by the least change (see the class comment). */
  sync(layers: readonly ChartScriptLayer[]): void {
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
