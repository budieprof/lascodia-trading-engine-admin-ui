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
  /**
   * C5 (additive): whose book the columns are — `{id:"mt5",kind:"mt5",label:"broker DOM, <instance>"}` or the venue
   * (`{id:"crypto-okx",kind:"venue",label:"OKX"}`, sizes in the venue's own unit).
   */
  source?: ChartFlowSourceDto | null;
  /**
   * C5 (additive), venue books only: the span actually read from the store (≤ 2 h, ending at the window's end). Buckets
   * outside it were NOT READ — not "no book". Null / absent for MT5 (every bucket is read).
   */
  readFromUtc?: string | null;
  readToUtc?: string | null;
}

// ── C2: POST chart-flow/tick-bars ─────────────────────────────────────────────

export interface TickBarsRequest {
  symbol: string;
  /** Ascending bar OPEN times (UTC ISO), exactly as the chart has them; 1..2000. */
  barTimes: string[];
  /** Exclusive end of the last bar (UTC ISO). */
  endUtc: string;
  footprint: boolean;
  /** Footprint row height in MT5 points (10^-digits); absent: one pip. MT5 symbols. */
  footprintRowPoints?: number;
  /**
   * C4 (multi-asset): footprint row height as N × the instrument's tick size; wins over `footprintRowPoints`. Sent for
   * every symbol that is not an MT5 pair; absent: the engine's default (≈ 1 bp of price in 1/2/5 × 10^k ticks).
   */
  footprintRowTicks?: number;
}

/** C4: what a tick-flow answer's up / down / delta / footprint are built from. */
export type DeltaSource = 'trades' | 'tickRule';

/**
 * C4: the unit of `upTicks` / `downTicks` / `delta` / `cumDelta` and the footprint's `up` / `down`: quote counts
 * (`ticks`) or traded volume in the instrument's own unit (`base` coins / base units, `contracts`, `shares`).
 */
export type FlowVolumeUnit = 'ticks' | 'base' | 'contracts' | 'shares';

/** C1/C4/C5 `source`: whose data a chart-flow answer was read from. */
export interface ChartFlowSourceDto {
  id: string;
  /** `mt5` | `venue`. */
  kind: string;
  /** "MT5 broker ticks", "broker DOM, <instance>", "Coinbase". */
  label: string;
}

/**
 * One footprint row of a bar: up- and down-ticks whose mid fell in `[price, price + row)` — or, with
 * `deltaSource: "trades"`, the aggressor buy (`up`) and sell (`down`) volume traded there.
 */
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
  /** C4 (additive; absent from older engines = the tick rule): real aggressor trades or the estimated tick rule. */
  deltaSource?: DeltaSource;
  /** C4 (additive; absent = `ticks`). With trades, `ticks` on a bar is the number of prints. */
  volumeUnit?: FlowVolumeUnit;
  /** C4 (additive): `{id:"mt5",kind:"mt5",label:"MT5 broker ticks"}` or the venue. */
  source?: ChartFlowSourceDto | null;
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
  /**
   * The footprint's row height in MT5 points (an MT5 symbol) or in the instrument's ticks (every other symbol, C4
   * `footprintRowTicks`); null: adaptive (about ten rows per typical visible bar).
   */
  footprintRowPoints: number | null;
  /** OF-4: spread and tick-rate ribbon pane. */
  ribbon: boolean;
  /** OF-6: fill markers with requested vs filled price. */
  fills: boolean;
  /**
   * Market-data source (C7 `md/sources` id) feeding the heatmap, the depth panel and the trade layer; null = automatic
   * (the source holding the most book for the window). Multibook: `consolidated` / `consolidated:a,b` = the consolidated
   * book of the entitled sources (spot prices, base-currency units).
   */
  sourceId: string | null;
  /** Trade bubbles from a source that publishes real trades (CME / venues). */
  trades: boolean;
  /** Trades smaller than this (in the source's own size unit) are not drawn. */
  tradeMinSize: number;
  /**
   * cme-tier2: CME order-flow markers (large lots, sweeps / stop runs, iceberg-like levels, absorption) from the
   * engine's analysis of the real CME tape + book; with a CME source picked, the CVD pane and the footprint show the
   * REAL aggressor delta instead of the tick rule.
   */
  cmeFlow: boolean;
}

/** Every layer off by default. */
export const DEFAULT_ORDER_FLOW: OrderFlowSettings = {
  heatmap: false,
  heatmapOpacity: 0.6,
  cvd: false,
  footprint: false,
  footprintRowPoints: null,
  ribbon: false,
  fills: false,
  sourceId: null,
  trades: false,
  tradeMinSize: 0,
  cmeFlow: false,
};

/** A saved layout's order-flow toggles, defaulted and clamped (layouts saved before this feature carry none). */
export function restoredOrderFlow(
  saved: Partial<OrderFlowSettings> | null | undefined,
): OrderFlowSettings {
  const s = saved ?? {};
  const opacity = Number(s.heatmapOpacity);
  return {
    heatmap: s.heatmap === true,
    heatmapOpacity: Number.isFinite(opacity)
      ? Math.min(1, Math.max(0, opacity))
      : DEFAULT_ORDER_FLOW.heatmapOpacity,
    cvd: s.cvd === true,
    footprint: s.footprint === true,
    footprintRowPoints:
      typeof s.footprintRowPoints === 'number' &&
      Number.isInteger(s.footprintRowPoints) &&
      s.footprintRowPoints >= 1
        ? s.footprintRowPoints
        : null,
    ribbon: s.ribbon === true,
    fills: s.fills === true,
    sourceId:
      typeof s.sourceId === 'string' &&
      (/^[A-Za-z0-9._:-]{1,64}$/.test(s.sourceId) ||
        // Multibook: "consolidated:a,b" — a subset of registry sources.
        /^consolidated:[A-Za-z0-9._-]{1,64}(,[A-Za-z0-9._-]{1,64}){0,31}$/.test(s.sourceId))
        ? s.sourceId
        : null,
    trades: s.trades === true,
    tradeMinSize:
      typeof s.tradeMinSize === 'number' && Number.isFinite(s.tradeMinSize) && s.tradeMinSize > 0
        ? s.tradeMinSize
        : 0,
    cmeFlow: s.cmeFlow === true,
  };
}

/** How many order-flow layers are on (the toolbar's overlay count). */
export function orderFlowCount(s: OrderFlowSettings): number {
  return [s.heatmap, s.cvd, s.footprint, s.ribbon, s.fills, s.trades, s.cmeFlow].filter(Boolean).length;
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
