import { InjectionToken, isSignal } from '@angular/core';
import type { ChartAnalysisPageComponent } from './chart-analysis-page.component';

/**
 * US02: what each section of the chart page's template (side pane, overlays menu) may read of the page — a SLICE, not the page. Each child injects its own token, typed
 * as exactly the members it uses ({@link pageSlice}: getters for those members and nothing else at run time), so a
 * section's dependencies are listed here, checked by the compiler against the page, and a spec provides a small fake.
 * (They used to inject the whole page through one `CHART_PAGE` token.)
 *
 * US02b: the main series (symbol, timeframe, bars) is in no slice — a section reads it from the page's
 * ChartSessionStore (chart-session-store.ts), which the page provides; the legend, the panel strip, the studies strip and the context menus
 * take inputs;
 * the drawing rail reads the page's ChartDrawingTools.
 */
type Page = ChartAnalysisPageComponent;

/** An object exposing only `keys` of `page`: signals as they are (two-way bindings keep working), methods bound. */
export function pageSlice<K extends keyof Page>(page: Page, keys: readonly K[]): Pick<Page, K> {
  const out = {} as Pick<Page, K>;
  for (const key of keys) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => {
        const value = page[key] as unknown;
        return typeof value === 'function' && !isSignal(value)
          ? (value as (...a: unknown[]) => unknown).bind(page)
          : value;
      },
    });
  }
  return out;
}

/** The overlays menu's slice of the page. */
export const OVERLAYS_MENU_KEYS = [
  'autoAnalysis',
  'autoAnalysisLayers',
  'autoAnalysisOn',
  'blackoutTitle',
  'consolidatableSources',
  'consolidatedHas',
  'cycleEventImpact',
  'deltaOn',
  'fitTradeLines',
  'footprintRowChoices',
  'footprintRowUnit',
  'isConsolidatedPick',
  'layerGroups',
  'minEventImpact',
  'openMenu',
  'openScorecard',
  'orderFlow',
  'orderFlowFeed',
  'overlayCount',
  'profileExtras',
  'sessionBreaks',
  'setFootprintRows',
  'setHeatmapOpacity',
  'setOrderFlowSource',
  'setTradeMinSize',
  'setVolumeProfileMode',
  'showBlackout',
  'showClosedTrades',
  'showEvents',
  'showOrders',
  'showOverlays',
  'showPositions',
  'showStructure',
  'showSupportResistance',
  'showTradeTimeline',
  'showVolume',
  'showVolumeProfile',
  'showWatchMarks',
  'toggleAutoAnalysis',
  'toggleAutoLayer',
  'toggleConsolidatedSource',
  'toggleDelta',
  'toggleEvents',
  'toggleMenu',
  'toggleOrderFlow',
  'toggleOrders',
  'toggleOverlays',
  'togglePositions',
  'toggleProfileExtra',
  'tradeTimelineInfo',
  'volumeProfileMode',
  'volumeProfileModes',
] as const;
export type ChartOverlaysMenuSlice = Pick<Page, (typeof OVERLAYS_MENU_KEYS)[number]>;
export const CHART_OVERLAYS_MENU = new InjectionToken<ChartOverlaysMenuSlice>(
  'CHART_OVERLAYS_MENU',
);

/** The side pane's slice of the page. */
export const SIDE_PANE_KEYS = [
  'articles',
  'calendarAll',
  'calendarCurrencies',
  'calendarEvent',
  'calendarMinImpact',
  'chartPanels',
  'dataWindowSections',
  'details',
  'eventRelevance',
  'facts',
  'legSummary',
  'marketView',
  'newsAnalysis',
  'newsFocus',
  'newsLoading',
  'openArticle',
  'orderFlow',
  'orderFlowReplayClip',
  'precision',
  'resolutionLabel',
  'selectSymbol',
  'sidePane',
  'tickReplayBook',
  'timezone',
] as const;
export type ChartSidePaneSlice = Pick<Page, (typeof SIDE_PANE_KEYS)[number]>;
export const CHART_SIDE_PANE = new InjectionToken<ChartSidePaneSlice>('CHART_SIDE_PANE');
