/**
 * Order-flow layers on the chart (Bookmap / DeepCharts-style): the wire contracts of the engine's `chart-flow/*`
 * reads (C1, C2), the toggles a layout saves, and the models the chart host draws.
 *
 * Data honesty: spot FX has no consolidated tape. "Delta" here is the TICK RULE over one broker's quote stream (a mid
 * up-tick counts +1, a down-tick −1), "volume" is a tick count, and depth is ONE broker's MT5 DOM as its EA reports it.
 * Every layer says so where it is drawn.
 */

// ── C1: GET chart-flow/order-book-heatmap ─────────────────────────────────────

/** One price level of a snapshot: `[price, volume]` (volume in units, as the broker reports it). */
export type HeatmapLevel = [number, number];

/** The last broker DOM snapshot captured inside one time bucket. Buckets without a snapshot are omitted. */
export interface HeatmapColumnDto {
  /** Bucket start (UTC ISO). */
  t: string;
  /** When the snapshot was captured (UTC ISO). */
  capturedAtUtc: string;
  bid: number;
  ask: number;
  bids: HeatmapLevel[];
  asks: HeatmapLevel[];
}

export interface OrderBookHeatmapDto {
  symbol: string;
  fromUtc: string;
  toUtc: string;
  bucketSeconds: number;
  /** Earliest non-deleted snapshot for the symbol (retention is ~7 days); null when there is none at all. */
  oldestAvailableUtc: string | null;
  /** The EA instances whose books the columns came from. */
  sourceInstanceIds: string[];
  columns: HeatmapColumnDto[];
  maxLevelVolume: number;
}

// ── C2: POST chart-flow/tick-bars ─────────────────────────────────────────────

export interface TickBarsRequest {
  symbol: string;
  /** Ascending bar OPEN times (UTC ISO), exactly as the chart has them; 1..2000. */
  barTimes: string[];
  /** Exclusive end of the last bar (UTC ISO). */
  endUtc: string;
  footprint: boolean;
  /** Footprint row height in MT5 points (10^-digits); absent: one pip. */
  footprintRowPoints?: number;
}

/** One footprint row of a bar: up- and down-ticks whose mid fell in `[price, price + row)`. */
export interface FootprintRowDto {
  price: number;
  up: number;
  down: number;
}

export type TickBarSource = 'ticks' | 'candle' | 'none';

export interface TickBarDto {
  /** The bar's open (UTC ISO), one per requested bar time. */
  t: string;
  /** `ticks`: built from retained ticks; `candle`: no ticks retained, filled from the stored candle; `none`: neither. */
  source: TickBarSource;
  ticks: number | null;
  upTicks: number | null;
  downTicks: number | null;
  delta: number | null;
  /** Runs from the first bar of the response; null on bars without ticks (the line breaks there). */
  cumDelta: number | null;
  spreadMinPoints: number | null;
  spreadAvgPoints: number | null;
  spreadMaxPoints: number | null;
  ticksPerMinute: number | null;
  footprint?: FootprintRowDto[] | null;
}

export interface TickBarsDto {
  symbol: string;
  /** Oldest retained tick for the symbol (retention is ~14 days); null when none. */
  tickCoverageFromUtc: string | null;
  bars: TickBarDto[];
}

// ── Settings (saved with the layout) ──────────────────────────────────────────

export interface OrderFlowSettings {
  /** OF-1: broker DOM liquidity heatmap behind the candles. */
  heatmap: boolean;
  /** 0..1, the heatmap's opacity. */
  heatmapOpacity: number;
  /** OF-2: cumulative tick delta + per-bar delta pane. */
  cvd: boolean;
  /** OF-3: per-bar tick-count footprint on the price pane. */
  footprint: boolean;
  /** OF-4: spread and tick-rate ribbon pane. */
  ribbon: boolean;
  /** OF-6: fill markers with requested vs filled price. */
  fills: boolean;
}

/** Every layer off by default. */
export const DEFAULT_ORDER_FLOW: OrderFlowSettings = {
  heatmap: false,
  heatmapOpacity: 0.6,
  cvd: false,
  footprint: false,
  ribbon: false,
  fills: false,
};

/** A saved layout's order-flow toggles, defaulted and clamped (layouts saved before this feature carry none). */
export function restoredOrderFlow(saved: Partial<OrderFlowSettings> | null | undefined): OrderFlowSettings {
  const s = saved ?? {};
  const opacity = Number(s.heatmapOpacity);
  return {
    heatmap: s.heatmap === true,
    heatmapOpacity: Number.isFinite(opacity)
      ? Math.min(1, Math.max(0, opacity))
      : DEFAULT_ORDER_FLOW.heatmapOpacity,
    cvd: s.cvd === true,
    footprint: s.footprint === true,
    ribbon: s.ribbon === true,
    fills: s.fills === true,
  };
}

/** How many order-flow layers are on (the toolbar's overlay count). */
export function orderFlowCount(s: OrderFlowSettings): number {
  return [s.heatmap, s.cvd, s.footprint, s.ribbon, s.fills].filter(Boolean).length;
}

// ── What the chart is showing (reported by the host's layers) ──────────────────

export interface OrderFlowView {
  /** UTC ms of the first and last plotted bar on screen (clamped to the bars held). */
  fromUtc: number;
  toUtc: number;
  /** Plotted bar indexes on screen (clamped). */
  fromIndex: number;
  toIndex: number;
  /** The price pane's width in px. */
  widthPx: number;
  barSpacing: number;
  /** The newest bar is on screen (live updates are only worth drawing then). */
  rightEdgeInView: boolean;
  /** Price per pixel on the price pane right now (for the footprint's row height); null before the first paint. */
  pricePerPx: number | null;
}
