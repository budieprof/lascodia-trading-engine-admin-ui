import { describe, expect, it } from 'vitest';
import type { IChartApi, IChartApiBase, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import { cssColor } from '@shared/pine-chart/core/color';
import { FONT_DEFAULT } from '@shared/pine-chart/render/build-render-model';
import { labelRightPx } from './run-on-host';
import { renderScriptResult, shiftedChart } from './script-renderer';
import { toChartScriptResult } from './chart-script.model';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';

/** A fake chart whose bar `l` sits at x = 100 + 10·l and whose view spans logical 50..80. */
function fakeChart(): IChartApiBase<Time> {
  const ts = {
    getVisibleLogicalRange: () => ({ from: 50, to: 80 }),
    logicalToCoordinate: (l: number) => 100 + 10 * l,
    width: () => 500,
  };
  return { timeScale: () => ts, panes: () => [] } as unknown as IChartApiBase<Time>;
}

describe('shiftedChart', () => {
  it('reads run logical l as host logical l + offset', () => {
    const c = shiftedChart(fakeChart(), () => 40);
    const ts = c.timeScale();
    expect(ts.getVisibleLogicalRange()).toEqual({ from: 10, to: 40 });
    expect(ts.logicalToCoordinate(0 as never)).toBe(100 + 10 * 40);
    // Everything else passes through.
    expect(ts.width()).toBe(500);
    expect(c.panes()).toEqual([]);
  });

  it('hides everything while the run is not on the host axis', () => {
    const ts = shiftedChart(fakeChart(), () => null).timeScale();
    expect(ts.getVisibleLogicalRange()).toBeNull();
    expect(ts.logicalToCoordinate(0 as never)).toBeNull();
  });
});

describe('renderScriptResult tables', () => {
  /** The engine's export of one overlay `table.new(position.top_right, 2, 1)` with two cells. */
  function runWithTable(): ReturnType<typeof toChartScriptResult> {
    const raw = structuredClone(BOLLINGER_RUN) as { outputs: { tables: unknown[] } };
    const cell = (column: number, text: string) => ({
      column,
      row: 0,
      columnSpan: 1,
      rowSpan: 1,
      text,
      width: 0,
      height: 0,
      textColor: '#38BDF8FF',
      textHAlign: 'center',
      textVAlign: 'center',
      textSize: 'small',
      textSizePoints: 10,
      bgColor: '#070A10FF',
      tooltip: null,
      fontFamily: 'default',
      bold: false,
      italic: false,
    });
    raw.outputs.tables = [
      {
        id: 1,
        position: 'top_right',
        columns: 2,
        rows: 1,
        bgColor: '#090D16FF',
        frameColor: null,
        frameWidth: 0,
        borderColor: '#1E293BFF',
        borderWidth: 1,
        forceOverlay: false,
        cells: [cell(0, 'TACTICAL ENGINE'), cell(1, 'SHORT')],
      },
    ];
    return toChartScriptResult(raw);
  }

  function fakeHost() {
    const ts = {
      timeToIndex: () => 10,
      getVisibleLogicalRange: () => null,
      logicalToCoordinate: () => null,
    };
    const chart = { timeScale: () => ts, panes: () => [] } as unknown as IChartApi;
    const series = {
      attachPrimitive: () => undefined,
      detachPrimitive: () => undefined,
    } as unknown as ISeriesApi<SeriesType, Time>;
    return { chart, series };
  }

  it("exposes an overlay script's tables on the price pane", () => {
    const { chart, series } = fakeHost();
    const h = renderScriptResult(chart, series, runWithTable());
    const panes = h.tables();
    expect(panes).toHaveLength(1);
    expect(panes[0].paneIndex).toBe(0);
    expect(panes[0].tables).toHaveLength(1);
    h.dispose();
    expect(h.tables()).toEqual([]);
  });
});

describe('renderScriptResult barcolor() and future drawings', () => {
  const H = 3_600;
  const RED = cssColor('#FF0000FF');

  /** The Bollinger run (60 H1 bars) with barcolor() on odd bars and a label 16 bars ahead. */
  function run() {
    const raw = structuredClone(BOLLINGER_RUN) as {
      bars: { t: number }[];
      outputs: { barColors: unknown[]; labels: unknown[] };
    };
    const n = raw.bars.length;
    raw.outputs.barColors = [
      {
        id: 9,
        offset: 0,
        display: ['all'],
        forceOverlay: false,
        colors: raw.bars.map((_, i) => (i % 2 ? '#FF0000FF' : null)),
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
    return { result: toChartScriptResult(raw), times: raw.bars.map((b) => b.t) };
  }

  function fakeHost() {
    const chart = {
      timeScale: () => ({ timeToIndex: () => null, getVisibleLogicalRange: () => null }),
      panes: () => [],
    } as unknown as IChartApi;
    const series = {
      attachPrimitive: () => undefined,
      detachPrimitive: () => undefined,
    } as unknown as ISeriesApi<SeriesType, Time>;
    return { chart, series };
  }

  it("maps the run's bar colours onto the host's bars by time", () => {
    const { result, times } = run();
    const { chart, series } = fakeHost();
    const h = renderScriptResult(chart, series, result);
    const host = times.map((t) => t / 1000);
    const colors = h.barColors(host)!;
    expect(colors).toHaveLength(60);
    expect(colors[0]).toBeNull();
    expect(colors[1]).toBe(RED);
    expect(colors[59]).toBe(RED);

    // The host holds 10 older bars before the run's: the same colours, 10 bars on.
    const older = Array.from({ length: 10 }, (_, i) => host[0] - (10 - i) * H);
    const longer = h.barColors([...older, ...host])!;
    expect(longer).toHaveLength(70);
    expect(longer.slice(0, 11)).toEqual(Array(11).fill(null));
    expect(longer[11]).toBe(RED);

    // The run's last bar is not on the host axis: nothing is placed.
    expect(h.barColors(host.slice(0, -1))).toBeNull();
    h.dispose();
    expect(h.barColors(host)).toBeNull();
  });

  it('finds the bars on a zone-shifted axis', () => {
    const { result, times } = run();
    const { chart, series } = fakeHost();
    const shift = 3 * 3_600_000;
    const h = renderScriptResult(chart, series, result, { shiftMs: () => shift });
    expect(h.barColors(times.map((t) => (t + shift) / 1000))![1]).toBe(RED);
    expect(h.barColors(times.map((t) => t / 1000))).toBeNull();
  });

  it("reports how far its drawings reach past the host's last bar", () => {
    const { result, times } = run();
    const { chart, series } = fakeHost();
    const h = renderScriptResult(chart, series, result);
    const host = times.map((t) => t / 1000);
    expect(h.futureBars(host)).toBe(16);
    // A bar opened on the host since the run: the label is a bar closer.
    expect(h.futureBars([...host, host[host.length - 1] + H])).toBe(15);
    expect(h.futureBars(host.slice(0, -1))).toBe(0);
    h.dispose();
    expect(h.futureBars(host)).toBe(0);
  });

  it("counts the label's text right of its anchor, in bars at the zoom it is asked at", () => {
    const { result, times } = run();
    const { chart, series } = fakeHost();
    const h = renderScriptResult(chart, series, result);
    const host = times.map((t) => t / 1000);
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
    expect(h.futureBars(host, 6)).toBeCloseTo(16 + px / 6);
    expect(h.futureBars(host, 12)).toBeCloseTo(16 + px / 12);
  });
});
