import { describe, expect, it } from 'vitest';

import { DEFAULT_ORDER_FLOW } from '../../orderflow/orderflow.types';
import { DEFAULT_LAYER_GROUPS } from '../../overlays/layer-groups';
import { ChartOverlaySettings } from './chart-overlay-settings';

// US02b: the overlay settings moved out of the page. Their defaults are the page's old field initialisers, and the
// multibook pick keeps its rules (save → restore is pinned in chart-analysis-page.overlays-persist.spec).

describe('ChartOverlaySettings', () => {
  it('starts at the chart’s defaults', () => {
    const o = new ChartOverlaySettings();
    expect(o.snapshot()).toEqual({
      showPositions: false,
      showOrders: false,
      showOverlays: false,
      showVolumeProfile: false,
      volumeProfileMode: 'visible',
      showSupportResistance: false,
      showStructure: false,
      showEvents: true,
      minEventImpact: 'Medium',
      showBlackout: true,
      showClosedTrades: false,
      fitTradeLines: true,
      showWatches: true,
      vpNakedPocs: false,
      vpDeveloping: false,
      orderFlow: DEFAULT_ORDER_FLOW,
    });
    expect(o.layerGroups()).toBe(DEFAULT_LAYER_GROUPS);
    expect(o.anyTradeOverlay()).toBe(false);
  });

  it('order-flow edits are clamped as before; a consolidated subset says which sources are in', () => {
    const o = new ChartOverlaySettings();
    o.setHeatmapOpacity(3);
    expect(o.orderFlow().heatmapOpacity).toBe(1);
    o.toggleOrderFlow('cvd');
    expect(o.orderFlow().cvd).toBe(true);
    o.setOrderFlowSource('');
    expect(o.orderFlow().sourceId).toBeNull();
    expect(o.consolidatedHas('any')).toBe(true);
    o.setOrderFlowSource('consolidated:a,b');
    expect(o.isConsolidatedPick()).toBe(true);
    expect(o.consolidatedHas('a')).toBe(true);
    expect(o.consolidatedHas('c')).toBe(false);
  });
});
