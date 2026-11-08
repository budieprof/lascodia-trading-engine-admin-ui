import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';

import { ChartAnalysisPageComponent } from './chart-analysis-page.component';
import { ChartOverlaySettings } from './chart-overlay-settings';
import { DEFAULT_ORDER_FLOW, restoredOrderFlow } from '../../orderflow/orderflow.types';
import { restoreLayerGroups } from '../../overlays/layer-groups';
import { migrateWorkspaceState, type ChartWorkspaceState } from '../../workspace/workspace-state';

// US02b pin: every overlay setting the overlays menu edits survives a layout save → restore unchanged, and an older
// layout without the newer keys restores to the defaults (trade lines following the old single switch). Written
// before the overlay settings moved out of the page; the cases must stay as they are through that move.

type Page = ChartAnalysisPageComponent & Record<string, any>;

/** A page with the members `captureState` reads and `applyChartSettings` writes, at the chart's defaults. */
function setup(): Page {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  Object.assign(p, {
    // Not overlay settings: present so the layout can be captured and applied.
    symbol: signal('EURUSD'),
    resolution: signal('60'),
    style: signal('candles'),
    scaleMode: signal('normal'),
    invertScale: signal(false),
    scaleSide: signal('right'),
    showCountdown: signal(true),
    appearance: signal(null),
    compareSeries: signal([]),
    rememberPerSymbol: signal(false),
    symbolMemory: signal({}),
    timezone: signal('UTC'),
    boxMethod: signal('atr'),
    boxSizeAtr: signal(1),
    boxPips: signal(10),
    renkoWicks: signal(false),
    lineBreakLines: signal(3),
    pnfReversal: signal(3),
    active: signal([]),
    savedScriptsState: signal([]),
    viewSnapshot: signal(null),
    pendingView: null,
    splitState: signal({ layout: '1' }),
    panelStates: signal([]),
    mainLink: signal(0),
    chartSync: signal({ symbol: false, interval: false, crosshair: true, time: true }),
    watchlistOpen: signal(false),
    dockWidth: signal(300),
    sidePane: signal('none'),
    calendarAll: signal(false),
    calendarMinImpact: signal('Low'),
    dockView: () => ({ mode: 'bottom' }),
  });
  overlayState(p);
  return p;
}

/**
 * The overlay settings, at the page's defaults. After the move this is the one place that says where they live:
 * volume and session breaks on the page, the rest in its ChartOverlaySettings (aliased on the page as it does).
 */
function overlayState(p: Page): void {
  const overlaySettings = new ChartOverlaySettings();
  Object.assign(p, {
    showVolume: signal(true),
    sessionBreaks: signal(false),
    overlaySettings,
    showPositions: overlaySettings.showPositions,
    showOrders: overlaySettings.showOrders,
    showOverlays: overlaySettings.showOverlays,
    showVolumeProfile: overlaySettings.showVolumeProfile,
    volumeProfileMode: overlaySettings.volumeProfileMode,
    showSupportResistance: overlaySettings.showSupportResistance,
    showStructure: overlaySettings.showStructure,
    showEvents: overlaySettings.showEvents,
    minEventImpact: overlaySettings.minEventImpact,
    showBlackout: overlaySettings.showBlackout,
    showClosedTrades: overlaySettings.showClosedTrades,
    fitTradeLines: overlaySettings.fitTradeLines,
    showWatchMarks: overlaySettings.showWatchMarks,
    profileExtras: overlaySettings.profileExtras,
    layerGroups: overlaySettings.layerGroups,
    orderFlow: overlaySettings.orderFlow,
  });
}

/** Every overlay setting, read through the page. */
function overlays(p: Page) {
  return {
    showVolume: p.showVolume(),
    sessionBreaks: p.sessionBreaks(),
    showPositions: p.showPositions(),
    showOrders: p.showOrders(),
    showOverlays: p.showOverlays(),
    showVolumeProfile: p.showVolumeProfile(),
    volumeProfileMode: p.volumeProfileMode(),
    showSupportResistance: p.showSupportResistance(),
    showStructure: p.showStructure(),
    showEvents: p.showEvents(),
    minEventImpact: p.minEventImpact(),
    showBlackout: p.showBlackout(),
    showClosedTrades: p.showClosedTrades(),
    fitTradeLines: p.fitTradeLines(),
    showWatchMarks: p.showWatchMarks(),
    profileExtras: { ...p.profileExtras() },
    layerGroups: JSON.parse(JSON.stringify(p.layerGroups())),
    orderFlow: { ...p.orderFlow() },
  };
}

/** Every setting away from its default. */
function changeAll(p: Page): void {
  p.showVolume.set(false);
  p.sessionBreaks.set(true);
  p.showPositions.set(true);
  p.showOrders.set(true);
  p.showOverlays.set(true);
  p.showVolumeProfile.set(true);
  p.volumeProfileMode.set('week');
  p.showSupportResistance.set(true);
  p.showStructure.set(true);
  p.showEvents.set(false);
  p.minEventImpact.set('High');
  p.showBlackout.set(false);
  p.showClosedTrades.set(true);
  p.fitTradeLines.set(false);
  p.showWatchMarks.set(false);
  p.profileExtras.set({ nakedPocs: true, developing: true });
  p.layerGroups.set({
    structure: { visible: false, opacity: 0.5 },
    profiles: { visible: true, opacity: 0.3 },
    flow: { visible: false, opacity: 0.8 },
    events: { visible: true, opacity: 0.2 },
    trades: { visible: false, opacity: 0.9 },
  });
  p.orderFlow.set({
    heatmap: true,
    heatmapOpacity: 0.35,
    cvd: true,
    footprint: true,
    footprintRowPoints: 5,
    ribbon: true,
    fills: true,
    sourceId: 'crypto-coinbase',
    trades: true,
    tradeMinSize: 2,
    cmeFlow: true,
  });
}

/** Saved as the engine stores it (JSON), then restored the way a layout is. */
function saveAndRestore(from: Page, to: Page): void {
  const saved = JSON.parse(JSON.stringify(from.captureState())) as ChartWorkspaceState;
  to['applyChartSettings'](migrateWorkspaceState(saved));
}

describe('chart page — overlay settings survive a layout save → restore (US02b pin)', () => {
  it('every overlay setting away from its default comes back as it was', () => {
    const a = setup();
    changeAll(a);
    const before = overlays(a);
    expect(before.orderFlow).not.toEqual(DEFAULT_ORDER_FLOW); // the case covers every key
    expect(Object.keys(before.orderFlow).sort()).toEqual(Object.keys(DEFAULT_ORDER_FLOW).sort());
    const b = setup();
    saveAndRestore(a, b);
    expect(overlays(b)).toEqual(before);
  });

  it('the defaults round-trip as defaults', () => {
    const a = setup();
    const before = overlays(a);
    const b = setup();
    changeAll(b); // a chart with everything changed takes the saved defaults back
    saveAndRestore(a, b);
    expect(overlays(b)).toEqual(before);
  });

  it('an older layout without the newer keys restores to the defaults', () => {
    const b = setup();
    changeAll(b);
    // Before the trade-lines split, the PR-2/3/5 profile + layer-group keys and order flow.
    const old: ChartWorkspaceState = {
      v: 1,
      symbol: 'EURUSD',
      overlays: { showOverlays: true, showVolumeProfile: true, showEvents: false },
    };
    b['applyChartSettings'](migrateWorkspaceState(old));
    expect(overlays(b)).toEqual({
      ...overlays(setup()),
      showPositions: true, // the old single switch drove all three
      showOrders: true,
      showOverlays: true,
      showVolumeProfile: true,
      showEvents: false,
      volumeProfileMode: 'week', // absent: the mode is left as it was (not reset)
      orderFlow: restoredOrderFlow(undefined),
      layerGroups: JSON.parse(JSON.stringify(restoreLayerGroups(undefined))),
    });
  });
});
