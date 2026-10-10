import { afterEach, describe, expect, it } from 'vitest';
import {
  readDeviceSizes,
  rememberDeviceSizes,
  withDeviceSizes,
  withoutDeviceSizes,
} from './device-sizes';
import type { ChartWorkspaceState } from './workspace-state';

const STATE: ChartWorkspaceState = {
  v: 2,
  symbol: 'EURUSD',
  view: { barSpacing: 8, rightOffset: 5, paneHeights: [520, 140] },
  panel: { watchlistOpen: true, width: 360, sidePane: 'details' },
  symbolMemory: {
    on: true,
    symbols: { GBPUSD: { resolution: '60', view: { barSpacing: 6, rightOffset: 3, paneHeights: [600] } } },
  },
};

describe('device sizes (pane heights and panel width stay on this device)', () => {
  afterEach(() => localStorage.clear());

  it('leaves the sizes out of what goes to the engine — everything else stays', () => {
    const shared = withoutDeviceSizes(STATE);
    expect(shared.view).toEqual({ barSpacing: 8, rightOffset: 5 });
    expect(shared.panel).toEqual({ watchlistOpen: true, sidePane: 'details' });
    expect(shared.symbolMemory?.symbols?.['GBPUSD'].view).toEqual({ barSpacing: 6, rightOffset: 3 });
    expect(shared.symbol).toBe('EURUSD');
    // The page's state is untouched.
    expect(STATE.view?.paneHeights).toEqual([520, 140]);
    expect(STATE.panel?.width).toBe(360);
  });

  it("puts this device's sizes back into a layout from the engine", () => {
    rememberDeviceSizes(7, STATE);
    const back = withDeviceSizes(withoutDeviceSizes(STATE), readDeviceSizes(7));
    expect(back).toEqual(STATE);
  });

  it('keeps what an older layout carries when this device has nothing remembered', () => {
    expect(withDeviceSizes(STATE, readDeviceSizes(99))).toBe(STATE);
  });

  it("remembers per layout, and moves an unsaved layout's sizes to its id once it has one", () => {
    rememberDeviceSizes(null, STATE);
    expect(readDeviceSizes(null)?.paneHeights).toEqual([520, 140]);
    rememberDeviceSizes(12, STATE);
    expect(readDeviceSizes(12)?.watchlistWidth).toBe(360);
    expect(readDeviceSizes(null)).toBeNull();
    expect(readDeviceSizes(13)).toBeNull();
  });
});
