import { describe, expect, it } from 'vitest';
import type { IChartApi, IChartApiBase, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import { cssColor } from '@shared/pine-chart/core/color';
import { FONT_DEFAULT } from '@shared/pine-chart/render/build-render-model';
import { labelRightPx } from './run-on-host';
import {
  ANCHOR_OPTIONS,
  ScriptRenderer,
  hostTimesOf,
  shiftedChart,
  syncAnchorData,
  type ScriptHost,
} from './script-renderer';
import { ScriptLayers, chartScriptLayers, type ChartScriptLayer } from './script-layers';
import { scriptRenderModel } from './script-model-cache';
import { toChartScriptResult, type ChartScriptResult } from './chart-script.model';
import { DEFAULT_DISPLAY } from './script-display';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';

/** A fake chart whose bar `l` sits at x = 100 + 10·l and whose view spans logical 50..80. */
function viewChart(): IChartApiBase<Time> {
  const ts = {
    getVisibleLogicalRange: () => ({ from: 50, to: 80 }),
    logicalToCoordinate: (l: number) => 100 + 10 * l,
    width: () => 500,
  };
  return { timeScale: () => ts, panes: () => [] } as unknown as IChartApiBase<Time>;
}

describe('shiftedChart', () => {
  it('reads run logical l as host logical l + offset', () => {
    const c = shiftedChart(viewChart(), () => 40);
    const ts = c.timeScale();
    expect(ts.getVisibleLogicalRange()).toEqual({ from: 10, to: 40 });
    expect(ts.logicalToCoordinate(0 as never)).toBe(100 + 10 * 40);
    // Everything else passes through.
    expect(ts.width()).toBe(500);
    expect(c.panes()).toEqual([]);
  });

  it('hides everything while the run is not on the host axis', () => {
    const ts = shiftedChart(viewChart(), () => null).timeScale();
    expect(ts.getVisibleLogicalRange()).toBeNull();
    expect(ts.logicalToCoordinate(0 as never)).toBeNull();
  });
});

// ── A chart that records what is done to it ───────────────────────────────────────────────────

type Row = { time: number; value: number };

class FakeSeries {
  data: Row[] = [];
  primitives: object[] = [];
  setDatas = 0;
  updates = 0;
  pops = 0;
  private handlers: (() => void)[] = [];
  removed = false;

  constructor(
    private readonly chart: FakeChart,
    readonly options: Record<string, unknown>,
  ) {}

  attachPrimitive(p: { attached?: (x: unknown) => void }): void {
    this.primitives.push(p);
    p.attached?.({ chart: this.chart, series: this, requestUpdate: () => undefined });
  }
  detachPrimitive(p: { detached?: () => void }): void {
    this.primitives = this.primitives.filter((x) => x !== p);
    p.detached?.();
  }
  setData(rows: Row[]): void {
    this.data = [...rows];
    this.setDatas++;
  }
  update(row: Row): void {
    this.data.push(row);
    this.updates++;
  }
  pop(n: number): void {
    this.data.length -= n;
    this.pops++;
  }
  applyOptions(o: Record<string, unknown>): void {
    Object.assign(this.options, o);
  }
  priceScale() {
    return { applyOptions: () => undefined };
  }
  getPane() {
    return { paneIndex: () => this.chart.paneIndexOf(this) };
  }
  subscribeDataChanged(h: () => void): void {
    this.handlers.push(h);
  }
  unsubscribeDataChanged(h: () => void): void {
    this.handlers = this.handlers.filter((x) => x !== h);
  }
  fireDataChanged(): void {
    for (const h of this.handlers) h();
  }
  get subscribers(): number {
    return this.handlers.length;
  }
}

class FakeChart {
  /** Series by pane, pane 0 first. */
  readonly panesList: FakeSeries[][] = [[]];
  added = 0;
  removedSeries = 0;
  removedPanes = 0;
  options: Record<string, unknown> = {};
  /** The host's bars (plotted seconds): what timeToIndex looks times up in. */
  times: number[] = [];

  addSeries(_def: unknown, options: Record<string, unknown>, paneIndex = 0): FakeSeries {
    const s = new FakeSeries(this, { ...options });
    while (this.panesList.length <= paneIndex) this.panesList.push([]);
    this.panesList[paneIndex].push(s);
    this.added++;
    return s;
  }
  removeSeries(s: FakeSeries): void {
    for (const list of this.panesList) {
      const i = list.indexOf(s);
      if (i >= 0) list.splice(i, 1);
    }
    s.removed = true;
    this.removedSeries++;
  }
  removePane(index: number): void {
    this.panesList.splice(index, 1);
    this.removedPanes++;
  }
  paneIndexOf(s: FakeSeries): number {
    return this.panesList.findIndex((l) => l.includes(s));
  }
  panes() {
    return this.panesList.map((list) => ({ getSeries: () => list }));
  }
  timeScale() {
    return {
      timeToIndex: (t: number) => {
        const i = this.times.indexOf(t);
        return i < 0 ? null : i;
      },
      getVisibleLogicalRange: () => null,
      logicalToCoordinate: () => null,
    };
  }
  applyOptions(o: Record<string, unknown>): void {
    Object.assign(this.options, o);
  }
}

const H = 3_600;

/** The Bollinger run (60 H1 bars, overlay strategy), optionally edited. */
function bollinger(edit?: (raw: any) => void): ChartScriptResult {
  const raw = structuredClone(BOLLINGER_RUN) as any;
  edit?.(raw);
  return toChartScriptResult(raw);
}

/** A non-overlay indicator over the same 60 bars: one plot in its own pane. */
function paneScript(edit?: (raw: any) => void): ChartScriptResult {
  return bollinger((raw) => {
    raw.compile.declaration = {
      ...raw.compile.declaration,
      kind: 'indicator',
      title: 'Osc',
      overlay: false,
    };
    raw.report = null;
    raw.outputs.fills = [];
    raw.outputs.plots = [raw.outputs.plots[0]];
    edit?.(raw);
  });
}

function rig(times: number[] = (BOLLINGER_RUN as any).bars.map((b: any) => b.t / 1000)) {
  const chart = new FakeChart();
  chart.times = [...times];
  const price = chart.addSeries(null, { title: 'price' }, 0);
  chart.added = 0;
  let side: 'left' | 'right' = 'right';
  const state = { price, plotted: chart.times };
  const host: ScriptHost = {
    chart: () => chart as unknown as IChartApi,
    price: () => state.price as unknown as ISeriesApi<SeriesType, Time>,
    shiftMs: () => 0,
    hostTimes: () => hostTimesOf(state.plotted),
    priceSide: () => side,
  };
  const layers = new ScriptLayers(host, (r) => scriptRenderModel(r, 5));
  return {
    chart,
    host,
    layers,
    state,
    setSide: (s: 'left' | 'right') => (side = s),
    sync: (...l: ChartScriptLayer[]) => layers.sync(l),
  };
}

describe('ScriptLayers — persistent panes (PC-04, PC-I3)', () => {
  it('a pane script gets one pane, kept across new results: no series added or removed', () => {
    const { chart, sync } = rig();
    sync({ key: 'mine:1', result: paneScript() });
    expect(chart.panesList).toHaveLength(2);
    const anchor = chart.panesList[1][0];
    expect(chart.added).toBe(1);

    // A live re-run brings a new result object, twice.
    sync({ key: 'mine:1', result: paneScript() });
    sync({ key: 'mine:1', result: paneScript() });
    expect(chart.added).toBe(1);
    expect(chart.removedSeries).toBe(0);
    expect(chart.panesList[1][0]).toBe(anchor);
    // The anchor's data was written once: the bars did not change.
    expect(anchor.setDatas).toBe(1);
  });

  it('the anchor carries no title (PC-03) and is never drawn or labelled', () => {
    const { chart, sync } = rig();
    sync({ key: 'mine:1', result: paneScript() });
    const o = chart.panesList[1][0].options;
    expect(o['title']).toBeUndefined();
    expect(o).toMatchObject(ANCHOR_OPTIONS as Record<string, unknown>);
  });

  it('diffs by key: a second script adds its own pane, removing one removes only its pane', () => {
    const { chart, sync } = rig();
    sync({ key: 'a', result: paneScript() }, { key: 'b', result: paneScript() });
    expect(chart.panesList).toHaveLength(3);
    const b = chart.panesList[2][0];
    sync({ key: 'b', result: paneScript() });
    expect(chart.panesList).toHaveLength(2);
    expect(chart.panesList[1][0]).toBe(b);
    expect(chart.removedSeries).toBe(1);
  });

  it('an overlay script draws on the price series and adds no series', () => {
    const { chart, state, sync } = rig();
    sync({ key: 'mine:1', result: bollinger() });
    expect(chart.added).toBe(0);
    expect(state.price.primitives).toHaveLength(1);
  });

  it('re-attaches to a replaced price series (a style change) without touching its panes', () => {
    const { chart, state, sync } = rig();
    sync({ key: 'o', result: bollinger() }, { key: 'p', result: paneScript() });
    const old = state.price;
    const anchor = chart.panesList[1][0];
    const next = chart.addSeries(null, { title: 'price 2' }, 0);
    chart.removeSeries(old);
    state.price = next;

    sync({ key: 'o', result: bollinger() }, { key: 'p', result: paneScript() });
    expect(old.primitives).toHaveLength(0);
    // The overlay's primitive and the pane script's force_overlay layer (none here: one primitive).
    expect(next.primitives.length).toBeGreaterThanOrEqual(1);
    expect(chart.panesList[1][0]).toBe(anchor);
  });

  it('follows ticks: a new bar is one anchor update(), a bar taken off one pop() — never setData', () => {
    const { chart, state, sync } = rig();
    sync({ key: 'p', result: paneScript() });
    const anchor = chart.panesList[1][0];
    expect(anchor.setDatas).toBe(1);
    const n = state.plotted.length;

    // The forming bar ticks: same bars.
    state.price.fireDataChanged();
    expect([anchor.updates, anchor.pops, anchor.setDatas]).toEqual([0, 0, 1]);

    // A new period opens.
    state.plotted = [...state.plotted, state.plotted[n - 1] + H];
    state.price.fireDataChanged();
    expect([anchor.updates, anchor.setDatas]).toEqual([1, 1]);
    expect(anchor.data).toHaveLength(n + 1);

    // Replay steps back two bars.
    state.plotted = state.plotted.slice(0, n - 1);
    state.price.fireDataChanged();
    expect([anchor.pops, anchor.setDatas]).toEqual([1, 1]);
    expect(anchor.data).toHaveLength(n - 1);

    // History loaded on the left: every time again.
    state.plotted = [state.plotted[0] - H, ...state.plotted];
    state.price.fireDataChanged();
    expect(anchor.setDatas).toBe(2);
  });

  it('watches only the current price series', () => {
    const { chart, state, sync } = rig();
    sync({ key: 'p', result: paneScript() });
    expect(state.price.subscribers).toBe(1);
    const old = state.price;
    state.price = chart.addSeries(null, {}, 0);
    sync({ key: 'p', result: paneScript() });
    expect(old.subscribers).toBe(0);
    expect(state.price.subscribers).toBe(1);
  });

  it('a hidden script keeps its pane and draws nothing (no bar colours, no tables)', () => {
    const { chart, sync } = rig();
    const result = paneScript();
    sync({ key: 'p', result });
    sync({ key: 'p', result, display: { ...DEFAULT_DISPLAY, visible: false } });
    expect(chart.panesList).toHaveLength(2);
    expect(chart.removedSeries).toBe(0);
  });

  it('a new chart (rebuilt) starts over: nothing is removed from the old one', () => {
    const r = rig();
    r.sync({ key: 'p', result: paneScript() });
    expect(r.layers.size).toBe(1);
    const fresh = new FakeChart();
    fresh.times = r.chart.times;
    (r.host as { chart: () => unknown }).chart = () => fresh;
    r.state.price = fresh.addSeries(null, {}, 0);
    r.sync({ key: 'p', result: paneScript() });
    expect(fresh.panesList).toHaveLength(2);
  });
});

describe('ScriptRenderer — scales and layers (PC-I10, PC-14)', () => {
  it('scale.none: an overlay script gets its own invisible scale — the candles keep theirs', () => {
    const { chart, state, sync } = rig();
    sync({
      key: 'n',
      result: bollinger((raw) => (raw.compile.declaration.scale = 'none')),
    });
    expect(state.price.primitives).toHaveLength(0);
    const own = chart.panesList[0].find((s) => s !== state.price)!;
    expect(own.options['priceScaleId']).toBe('pine:n');
    expect(own.primitives).toHaveLength(1);
  });

  it('scale.left with the price on the right: its own scale on the left, which must be shown', () => {
    const { chart, layers, state, setSide, sync } = rig();
    sync({ key: 'l', result: bollinger((raw) => (raw.compile.declaration.scale = 'left')) });
    const own = chart.panesList[0].find((s) => s !== state.price)!;
    expect(own.options['priceScaleId']).toBe('left');
    expect([...layers.axisSides()]).toEqual(['left']);

    // The price moves to the left: the script shares its scale again, nothing extra to show.
    setSide('left');
    layers.syncScales();
    expect(state.price.primitives).toHaveLength(1);
    expect(own.removed).toBe(true);
    expect(layers.axisSides().size).toBe(0);
  });

  it('a pane script follows the chart’s scale side, or takes the side it declares', () => {
    const { chart, layers, setSide, sync } = rig();
    sync({ key: 'p', result: paneScript() });
    const anchor = chart.panesList[1][0];
    expect(anchor.options['priceScaleId']).toBe('right');
    setSide('left');
    layers.syncScales();
    expect(anchor.options['priceScaleId']).toBe('left');

    sync({ key: 'p', result: paneScript((raw) => (raw.compile.declaration.scale = 'none')) });
    expect(anchor.options['priceScaleId']).toBe('pine:p');
  });

  it('behind_chart (default true) paints the main pane behind the candles; false in front', () => {
    const behind = new ScriptRenderer(rig().host, 'x');
    const r = bollinger();
    behind.update(r, scriptRenderModel(r, 5), DEFAULT_DISPLAY);
    const hooks = (behind as any).mainLayers.hooks;
    expect(hooks.behindChart()).toBe(true);

    const front = bollinger((raw) => (raw.compile.declaration.behindChart = false));
    behind.update(front, scriptRenderModel(front, 5), DEFAULT_DISPLAY);
    expect(hooks.behindChart()).toBe(false);
    // The operator's choice (Style tab) wins over the declaration.
    behind.update(front, scriptRenderModel(front, 5), { ...DEFAULT_DISPLAY, behindChart: true });
    expect(hooks.behindChart()).toBe(true);
  });
});

describe('ScriptRenderer — tables, bar colours and future drawings', () => {
  /** The Bollinger run with barcolor() on odd bars, a label 16 bars ahead and one table. */
  function decorated(): { result: ChartScriptResult; times: number[] } {
    const raw = structuredClone(BOLLINGER_RUN) as any;
    const n = raw.bars.length;
    raw.outputs.barColors = [
      {
        id: 9,
        offset: 0,
        display: ['all'],
        forceOverlay: false,
        colors: raw.bars.map((_: unknown, i: number) => (i % 2 ? '#FF0000FF' : null)),
      },
    ];
    raw.outputs.labels = [
      {
        id: 1,
        x: { barIndex: n - 1 + 16 },
        y: 1.15,
        xloc: 'bar_index',
        yloc: 'price',
        text: 'target',
        style: 'label_left',
        sizePoints: 0,
        textAlign: 'center',
        fontFamily: 'default',
        bold: false,
        italic: false,
        forceOverlay: false,
        createdBar: n - 1,
      },
    ];
    raw.outputs.tables = [
      {
        id: 1,
        position: 'top_right',
        columns: 1,
        rows: 1,
        bgColor: '#090D16FF',
        frameColor: null,
        frameWidth: 0,
        borderColor: null,
        borderWidth: 0,
        forceOverlay: false,
        cells: [
          {
            column: 0,
            row: 0,
            columnSpan: 1,
            rowSpan: 1,
            text: 'SHORT',
            width: 0,
            height: 0,
            textColor: '#38BDF8FF',
            textHAlign: 'center',
            textVAlign: 'center',
            textSize: 'small',
            textSizePoints: 10,
            bgColor: null,
            tooltip: null,
            fontFamily: 'default',
            bold: false,
            italic: false,
          },
        ],
      },
    ];
    return { result: toChartScriptResult(raw), times: raw.bars.map((b: any) => b.t / 1000) };
  }

  function drawn(times: number[], shift = 0) {
    const { result } = decorated();
    const r = rig(times.map((t) => t + shift / 1000));
    (r.host as { shiftMs: () => number }).shiftMs = () => shift;
    const s = new ScriptRenderer(r.host, 'k');
    s.update(result, scriptRenderModel(result, 5), DEFAULT_DISPLAY);
    return { s, rig: r, result };
  }

  const RED = cssColor('#FF0000FF');

  it("exposes an overlay script's tables on the price pane, none once hidden or gone", () => {
    const { times } = decorated();
    const { s, result } = drawn(times);
    expect(s.tables()).toHaveLength(1);
    expect(s.tables()[0].paneIndex).toBe(0);
    s.update(result, scriptRenderModel(result, 5), { ...DEFAULT_DISPLAY, visible: false });
    expect(s.tables()).toEqual([]);
    s.dispose();
    expect(s.tables()).toEqual([]);
  });

  it("maps the run's bar colours onto the host's bars by time", () => {
    const { times } = decorated();
    const { s } = drawn(times);
    const colors = s.barColors(times)!;
    expect(colors).toHaveLength(60);
    expect(colors[0]).toBeNull();
    expect(colors[1]).toBe(RED);
    expect(colors[59]).toBe(RED);

    // The host holds 10 older bars before the run's: the same colours, 10 bars on.
    const older = Array.from({ length: 10 }, (_, i) => times[0] - (10 - i) * H);
    const longer = s.barColors([...older, ...times])!;
    expect(longer).toHaveLength(70);
    expect(longer.slice(0, 11)).toEqual(Array(11).fill(null));
    expect(longer[11]).toBe(RED);

    // The run's last bar is not on the host axis: nothing is placed.
    expect(s.barColors(times.slice(0, -1))).toBeNull();
    s.dispose();
    expect(s.barColors(times)).toBeNull();
  });

  it('finds the bars on a zone-shifted axis — on the clock as it is now', () => {
    const { times } = decorated();
    const shift = 3 * 3_600_000;
    const { s, rig: r } = drawn(times, shift);
    const shifted = times.map((t) => t + shift / 1000);
    expect(s.barColors(shifted)![1]).toBe(RED);
    expect(s.barColors(times)).toBeNull();
    // The zone switches back to UTC: the same renderer finds the run at the UTC times.
    (r.host as { shiftMs: () => number }).shiftMs = () => 0;
    expect(s.barColors(times)![1]).toBe(RED);
  });

  it("reports how far its drawings reach past the host's last bar", () => {
    const { times } = decorated();
    const { s } = drawn(times);
    expect(s.futureBars(times)).toBe(16);
    // A bar opened on the host since the run: the label is a bar closer.
    expect(s.futureBars([...times, times[times.length - 1] + H])).toBe(15);
    expect(s.futureBars(times.slice(0, -1))).toBe(0);
    s.dispose();
    expect(s.futureBars(times)).toBe(0);
  });

  it("counts the label's text right of its anchor, in bars at the zoom it is asked at", () => {
    const { times } = decorated();
    const { s } = drawn(times);
    // "target", label_left, size.normal (12 px): its bubble runs right of the anchor 16 bars out.
    const px = labelRightPx({
      style: 'label_left',
      text: 'target',
      fontSize: 12,
      fontFamily: FONT_DEFAULT,
      bold: false,
      yloc: 'price',
    });
    expect(px).toBeGreaterThan(40);
    expect(s.futureBars(times, 6)).toBeCloseTo(16 + px / 6);
    expect(s.futureBars(times, 12)).toBeCloseTo(16 + px / 12);
  });

  it('answers the tooltip regions its primitives recorded, per pane, and none while hidden (PC-10)', () => {
    const { times } = decorated();
    const { s, result } = drawn(times);
    const fill = { x: 10, y: 10, w: 20, h: 20, tooltip: 'Trade #1', trades: [1] };
    (s as any).mainLayers.hits = [fill];
    expect(s.hitAt(0, 15, 15)).toBe(fill);
    expect(s.hitAt(0, 50, 15)).toBeNull();
    expect(s.hitAt(1, 15, 15)).toBeNull();
    s.update(result, scriptRenderModel(result, 5), { ...DEFAULT_DISPLAY, visible: false });
    expect(s.hitAt(0, 15, 15)).toBeNull();
  });

  it('reads its status-line values at a host bar, and at its last bar when at rest', () => {
    const { times } = decorated();
    const { s, rig: r } = drawn(times);
    // The fake time scale finds the run's last bar at host index 59: offset 0.
    expect(r.chart.timeScale().timeToIndex(times[59])).toBe(59);
    const atRest = s.statusAt(null)!;
    const at59 = s.statusAt(59)!;
    expect(atRest.main.map((v) => v.text)).toEqual(at59.main.map((v) => v.text));
    expect(atRest.main.map((v) => v.title)).toEqual(['Basis', 'Upper', 'Lower']);
    expect(s.statusAt(5)!.main.every((v) => v.text === '∅')).toBe(true);
  });
});

describe('chartScriptLayers (PC-09)', () => {
  const EURUSD = { symbol: 'EURUSD', resolution: '60' as const };
  const run = (key: string, chartType?: 'standard' | 'heikinashi', symbol = 'EURUSD') => ({
    item: { key },
    result: bollinger(),
    symbol,
    resolution: '60' as const,
    ...(chartType ? { chartType } : {}),
  });

  it('draws the runs made for the chart’s series and bars, each with its display settings', () => {
    const layers = chartScriptLayers([run('a'), run('b', 'standard')], EURUSD, EURUSD, 'standard', null);
    expect(layers.map((l) => [l.key, l.suspended])).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(layers[0].display).toEqual(DEFAULT_DISPLAY);
  });

  it('suspends a run made on the other bars until its re-run lands (Heikin-Ashi ↔ standard)', () => {
    const layers = chartScriptLayers(
      [run('std'), run('ha', 'heikinashi')],
      EURUSD,
      EURUSD,
      'heikinashi',
      null,
    );
    expect(layers.map((l) => [l.key, l.suspended])).toEqual([
      ['std', 'Running on the new chart type…'],
      ['ha', null],
    ]);
  });

  it('suspends every run on a chart type runs cannot sit on, saying so', () => {
    const layers = chartScriptLayers([run('a')], EURUSD, EURUSD, null, 'Not available on Renko charts');
    expect(layers[0].suspended).toBe('Not available on Renko charts');
  });

  it('leaves out another series’ runs, and runs while the bars on screen are another series’', () => {
    expect(chartScriptLayers([run('a', undefined, 'GBPUSD')], EURUSD, EURUSD, 'standard', null)).toEqual([]);
    const gbp = { symbol: 'GBPUSD', resolution: '60' as const };
    expect(chartScriptLayers([run('a')], EURUSD, gbp, 'standard', null)).toEqual([]);
  });
});

describe('syncAnchorData', () => {
  function anchor() {
    const series = new FakeSeries(new FakeChart(), {});
    return { series: series as unknown as ISeriesApi<'Line', Time>, written: [] as number[], s: series };
  }

  it('writes every time once, then only what changed at the end', () => {
    const a = anchor();
    syncAnchorData(a, hostTimesOf([1, 2, 3]));
    syncAnchorData(a, hostTimesOf([1, 2, 3]));
    syncAnchorData(a, hostTimesOf([1, 2, 3, 4]));
    syncAnchorData(a, hostTimesOf([1, 2]));
    expect([a.s.setDatas, a.s.updates, a.s.pops]).toEqual([1, 1, 1]);
    expect(a.written).toEqual([1, 2]);
    // Shifted times (a zone switch): all again.
    syncAnchorData(a, hostTimesOf([11, 12]));
    expect(a.s.setDatas).toBe(2);
    expect(a.written).toEqual([11, 12]);
  });
});
