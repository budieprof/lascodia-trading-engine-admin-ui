import { describe, expect, it } from 'vitest';

import { normaliseView } from './chart-analysis-page.component';
import { withDeviceSizes, withoutDeviceSizes } from '../../workspace/device-sizes';
import type { ChartWorkspaceState } from '../../workspace/workspace-state';

// Pane heights never leave the device (`withoutDeviceSizes`), so a layout read on a browser with
// none remembered carries a view without them. normaliseView used to `.map` them and threw out of
// applyState on that first open — "Cannot read properties of undefined (reading 'map')".

describe('normaliseView', () => {
  it('rounds a full view state', () => {
    expect(
      normaliseView({ barSpacing: 6.123, rightOffset: -3.6, paneHeights: [410.4, 120.6] }),
    ).toEqual({
      barSpacing: 6.12,
      rightOffset: -4,
      paneHeights: [410, 121],
    });
  });

  it('takes a layout from the engine on a device that remembers no pane heights', () => {
    const saved: ChartWorkspaceState = {
      v: 2,
      symbol: 'EURUSD',
      view: { barSpacing: 8, rightOffset: 5, paneHeights: [400, 150] },
    } as ChartWorkspaceState;
    const fromEngine = withDeviceSizes(withoutDeviceSizes(saved), null);
    expect(fromEngine.view).toBeDefined();
    expect(() => normaliseView(fromEngine.view!)).not.toThrow();
    expect(normaliseView(fromEngine.view!)).toEqual({
      barSpacing: 8,
      rightOffset: 5,
      paneHeights: [],
    });
  });
});
