import type { TvResolution } from '../../datafeed/resolution';
import type { ChartStyle } from '../../chart/chart-host.component';
import type { DrawingKind } from '../../drawings/model';
import { appStorage } from '@core/storage/app-storage';
import type { BottomBarMenu } from './chart-bottom-bar.component';

/**
 * The chart page's fixed configuration (U13: moved out of chart-analysis-page.component.ts, values unchanged):
 * interval groups, range presets, chart-type menu, toolbar menus, paging limits, dock persistence and hotkeys.
 */
export const RESOLUTION_GROUPS: Array<{
  label: string;
  items: Array<{ id: TvResolution; name: string }>;
}> = [
  {
    label: 'Minutes',
    items: [
      { id: '1', name: '1 minute' },
      { id: '2', name: '2 minutes' },
      { id: '3', name: '3 minutes' },
      { id: '5', name: '5 minutes' },
      { id: '10', name: '10 minutes' },
      { id: '15', name: '15 minutes' },
      { id: '30', name: '30 minutes' },
      { id: '45', name: '45 minutes' },
    ],
  },
  {
    label: 'Hours',
    items: [
      { id: '60', name: '1 hour' },
      { id: '120', name: '2 hours' },
      { id: '180', name: '3 hours' },
      { id: '240', name: '4 hours' },
      { id: '360', name: '6 hours' },
      { id: '480', name: '8 hours' },
      { id: '720', name: '12 hours' },
    ],
  },
  {
    label: 'Days',
    items: [
      { id: '1D', name: '1 day' },
      { id: '1W', name: '1 week' },
      { id: '1M', name: '1 month' },
    ],
  },
];

export const DAY = 86_400_000;
/** Pages of history go-to-date loads at most to reach a date (1,500 bars each). */
export const GO_TO_DATE_PAGES = 12;

/** TradingView's bottom-bar presets: each picks the interval it shows the span at. */
export const RANGE_PRESETS: Array<{
  id: string;
  title: string;
  resolution: TvResolution;
  spanMs: number | 'ytd' | 'all';
}> = [
  { id: '1D', title: '1 day in 1 minute intervals', resolution: '1', spanMs: DAY },
  { id: '5D', title: '5 days in 5 minute intervals', resolution: '5', spanMs: 5 * DAY },
  { id: '1M', title: '1 month in 30 minute intervals', resolution: '30', spanMs: 30 * DAY },
  { id: '3M', title: '3 months in 1 hour intervals', resolution: '60', spanMs: 91 * DAY },
  { id: '6M', title: '6 months in 4 hour intervals', resolution: '240', spanMs: 182 * DAY },
  { id: 'YTD', title: 'Year to date in 1 day intervals', resolution: '1D', spanMs: 'ytd' },
  { id: '1Y', title: '1 year in 1 day intervals', resolution: '1D', spanMs: 365 * DAY },
  { id: '5Y', title: '5 years in 1 week intervals', resolution: '1W', spanMs: 5 * 365 * DAY },
  { id: 'All', title: 'All data in 1 month intervals', resolution: '1M', spanMs: 'all' },
];

export type ToolbarMenu =
  | 'interval'
  | 'style'
  | 'templates'
  | 'overlays'
  | 'alert'
  | 'split'
  | 'more'
  | BottomBarMenu;

/** The chart-type menu, grouped as TradingView groups it. TPO and Session volume profile toggle studies. */
export type StyleChoice = ChartStyle | 'tpo' | 'session-vp';
export const STYLE_GROUPS: Array<Array<{ id: StyleChoice; label: string }>> = [
  [
    { id: 'bars', label: 'Bars' },
    { id: 'candles', label: 'Candles' },
    { id: 'hollow', label: 'Hollow candles' },
    { id: 'vol-candle', label: 'Volume candles' },
  ],
  [
    { id: 'line', label: 'Line' },
    { id: 'line-markers', label: 'Line with markers' },
    { id: 'stepline', label: 'Step line' },
  ],
  [
    { id: 'area', label: 'Area' },
    { id: 'hlc-area', label: 'HLC area' },
    { id: 'baseline', label: 'Baseline' },
  ],
  [
    { id: 'column', label: 'Columns' },
    { id: 'hilo', label: 'High-low' },
    { id: 'hlc-bars', label: 'HLC bars' },
  ],
  [
    { id: 'tpo', label: 'Time price opportunity' },
    { id: 'session-vp', label: 'Session volume profile' },
  ],
  [
    { id: 'heikin-ashi', label: 'Heikin Ashi' },
    { id: 'renko', label: 'Renko' },
    { id: 'line-break', label: 'Line break' },
    { id: 'kagi', label: 'Kagi' },
    { id: 'pnf', label: 'Point & figure' },
    { id: 'range', label: 'Range' },
  ],
];
export const STYLE_STUDY: Partial<Record<StyleChoice, string>> = {
  tpo: 'profile:tpo',
  'session-vp': 'profile:vp-session',
};

export const CHART_STYLES: Array<{ id: ChartStyle; label: string }> = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'heikin-ashi', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'hlc-bars', label: 'HLC bars' },
  { id: 'hilo', label: 'High-Low' },
  { id: 'vol-candle', label: 'Volume candles' },
  { id: 'line', label: 'Line' },
  { id: 'line-markers', label: 'Line with markers' },
  { id: 'stepline', label: 'Step line' },
  { id: 'area', label: 'Area' },
  { id: 'hlc-area', label: 'HLC area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'column', label: 'Columns' },
  // Price-based: these rebuild the bars rather than re-skinning them.
  { id: 'renko', label: 'Renko' },
  { id: 'line-break', label: 'Line Break' },
  { id: 'kagi', label: 'Kagi' },
  { id: 'pnf', label: 'Point & Figure' },
  { id: 'range', label: 'Range' },
];

/** How many bars to pull per request / per scroll-back page. */
export const PAGE_BARS = 1500;
/** A chart script run covers the loaded history up to the engine's preview cap. */
export const MAX_SCRIPT_BARS = 20_000;

export const WATCHLIST_OPEN_KEY = 'lascodia.chart.watchlistOpen';
/** TradingView keeps the watchlist docked by default; the operator's last choice wins. */
export const DOCK_WIDTH_KEY = 'lascodia.chart.watchlistWidth';
export function loadDockWidth(): number {
  try {
    const w = Number(appStorage.getItem(DOCK_WIDTH_KEY));
    return w >= 240 && w <= 640 ? w : 380;
  } catch {
    return 380;
  }
}

export function loadWatchlistOpen(): boolean {
  try {
    return appStorage.getItem(WATCHLIST_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

/** TradingView's drawing hotkeys (Alt + key), by `KeyboardEvent.code` (DR-I12). */
export const DRAWING_HOTKEYS: Readonly<Record<string, DrawingKind>> = {
  KeyT: 'trend-line',
  KeyH: 'horizontal-line',
  KeyJ: 'horizontal-ray',
  KeyV: 'vertical-line',
  KeyC: 'cross-line',
  KeyF: 'fib-retracement',
};

/** TradingView's chart hotkeys (Alt + key), by `KeyboardEvent.code` (CC-I11). */
export const CHART_HOTKEYS: Readonly<
  Record<string, 'reset' | 'invert' | 'log' | 'percent' | 'snapshot'>
> = {
  KeyR: 'reset',
  KeyI: 'invert',
  KeyL: 'log',
  KeyP: 'percent',
  KeyS: 'snapshot',
};
