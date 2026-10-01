import { describe, expect, it } from 'vitest';
import type { IChartApiBase, Time } from 'lightweight-charts';
import { shiftedChart } from './script-renderer';

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
