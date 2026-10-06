import { describe, expect, it } from 'vitest';
import type { IChartApi, IChartApiBase, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
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
