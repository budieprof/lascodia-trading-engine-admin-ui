import { utcMs } from '../panels/fx-fundamentals';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import type { HeatmapColumnDto, HeatmapLevel, OrderBookHeatmapDto } from './orderflow.types';

/**
 * OF-1 — the liquidity heatmap's maths, kept free of the chart so it can be tested: the engine's per-bucket broker DOM
 * snapshots (C1) binned onto one price-row grid, a robust colour scale, the live column folded in, and when a new
 * window is worth fetching. The renderer only projects what this builds; nothing here runs per frame or per crosshair
 * move.
 */

/** One bucket's book, binned: rows ascending by price. */
export interface HeatColumn {
  /** Bucket start and exclusive end (UTC ms) — a column is drawn over its own bucket only, never carried forward. */
  t: number;
  end: number;
  capturedAt: number;
  bid: number;
  ask: number;
  /** Row keys (price / rowStep, rounded), ascending. */
  rows: Int32Array;
  /** Units resting in each row (bids and asks that fall in it, summed). */
  volumes: Float64Array;
}

export interface HeatGrid {
  symbol: string;
  fromUtc: number;
  toUtc: number;
  bucketMs: number;
  /** Earliest snapshot the engine still holds for the symbol; null: none at all. */
  oldestAvailableUtc: number | null;
  sources: string[];
  columns: HeatColumn[];
  /** Price height of one row. */
  rowStep: number;
  /** The volume the colour scale tops out at: the 98th percentile of the binned cells, not the single largest. */
  robustMax: number;
}

/** The percentile the colour scale saturates at: a single outsized wall does not wash every other level out. */
export const ROBUST_PERCENTILE = 0.98;

/** The `p` quantile (0..1) of `values` (nearest rank on a sorted copy); 0 for none. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

/** The median positive gap between distinct prices — the broker's level spacing; `floor` when there are no gaps. */
export function levelStep(prices: Iterable<number>, floor: number): number {
  const distinct = [...new Set(prices)].filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < distinct.length; i++) {
    const g = distinct[i] - distinct[i - 1];
    // Below half a point the gap is floating-point noise between two spellings of one price.
    if (g > floor / 2) gaps.push(g);
  }
  if (gaps.length === 0) return floor;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  // Snap to whole points: 0.000009999 is a 1-point ladder.
  return Math.max(floor, Math.round(median / floor) * floor);
}

function validLevels(raw: readonly HeatmapLevel[] | null | undefined): HeatmapLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l) =>
      Array.isArray(l) &&
      Number.isFinite(l[0]) &&
      l[0] > 0 &&
      Number.isFinite(l[1]) &&
      l[1] >= 0,
  );
}

/** One column's levels onto the row grid: levels sharing a row are summed. */
function binColumn(
  t: number,
  end: number,
  capturedAt: number,
  bid: number,
  ask: number,
  levels: readonly HeatmapLevel[],
  rowStep: number,
): HeatColumn {
  const byRow = new Map<number, number>();
  for (const [price, volume] of levels) {
    const row = Math.round(price / rowStep);
    byRow.set(row, (byRow.get(row) ?? 0) + volume);
  }
  const keys = [...byRow.keys()].sort((a, b) => a - b);
  return {
    t,
    end,
    capturedAt,
    bid,
    ask,
    rows: Int32Array.from(keys),
    volumes: Float64Array.from(keys.map((k) => byRow.get(k) ?? 0)),
  };
}

/**
 * The response as a grid. `pointSize` is the symbol's MT5 point (10^-digits), the finest row allowed. Columns keep
 * the engine's bucket starts; one whose bucket is not in the window is dropped.
 */
export function buildHeatGrid(dto: OrderBookHeatmapDto, pointSize: number): HeatGrid {
  const fromUtc = utcMs(dto.fromUtc);
  const toUtc = utcMs(dto.toUtc);
  const bucketMs = Math.max(1, Math.round(dto.bucketSeconds * 1000));
  const parsed = (dto.columns ?? [])
    .map((c: HeatmapColumnDto) => ({
      t: utcMs(c.t),
      capturedAt: utcMs(c.capturedAtUtc),
      bid: Number(c.bid),
      ask: Number(c.ask),
      levels: [...validLevels(c.bids), ...validLevels(c.asks)],
    }))
    .filter((c) => Number.isFinite(c.t) && c.t >= fromUtc - bucketMs && c.t < toUtc)
    .sort((a, b) => a.t - b.t);
  const rowStep = levelStep(
    parsed.flatMap((c) => c.levels.map((l) => l[0])),
    pointSize > 0 ? pointSize : 0.00001,
  );
  const columns = parsed.map((c) =>
    binColumn(c.t, c.t + bucketMs, c.capturedAt, c.bid, c.ask, c.levels, rowStep),
  );
  const oldest = dto.oldestAvailableUtc ? utcMs(dto.oldestAvailableUtc) : NaN;
  return {
    symbol: dto.symbol,
    fromUtc,
    toUtc,
    bucketMs,
    oldestAvailableUtc: Number.isFinite(oldest) ? oldest : null,
    sources: [...(dto.sourceInstanceIds ?? [])],
    columns,
    rowStep,
    robustMax: robustMaxOf(columns),
  };
}

/** The colour scale's top: the 98th percentile of every non-empty cell. */
export function robustMaxOf(columns: readonly HeatColumn[]): number {
  const all: number[] = [];
  for (const c of columns) for (const v of c.volumes) if (v > 0) all.push(v);
  return percentile(all, ROBUST_PERCENTILE);
}

/** A cell's place on the colour scale (0..1): logarithmic, so a 10× wall reads brighter without hiding thin levels. */
export function heatIntensity(volume: number, robustMax: number): number {
  if (!(volume > 0) || !(robustMax > 0)) return 0;
  return Math.min(1, Math.log1p(volume) / Math.log1p(robustMax));
}

/** Colour stops (intensity → rgb): deep blue for thin liquidity, through cyan and yellow, to orange-red at the walls. */
const RAMP: readonly [number, [number, number, number]][] = [
  [0, [20, 40, 110]],
  [0.3, [30, 110, 210]],
  [0.55, [0, 200, 220]],
  [0.8, [250, 220, 60]],
  [1, [255, 90, 40]],
];

/** The rgba of an intensity: the ramp's colour, more opaque as it gets brighter (a thin level stays faint). */
export function heatColor(intensity: number): string {
  const x = Math.min(1, Math.max(0, intensity));
  let i = 1;
  while (i < RAMP.length - 1 && RAMP[i][0] < x) i++;
  const [x0, c0] = RAMP[i - 1];
  const [x1, c1] = RAMP[i];
  const f = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
  const ch = (k: number) => Math.round(c0[k] + (c1[k] - c0[k]) * f);
  const alpha = 0.12 + 0.83 * x;
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${alpha.toFixed(3)})`;
}

/** 256 precomputed colours, so a frame never formats a colour string per cell. */
export const HEAT_LUT: readonly string[] = Array.from({ length: 256 }, (_, i) => heatColor(i / 255));

/** The LUT colour of a volume. */
export function heatLutColor(volume: number, robustMax: number): string {
  return HEAT_LUT[Math.round(heatIntensity(volume, robustMax) * 255)];
}

/** Parse a `market-data/order-book/latest` snapshot's levels (keys `P`/`V`) as heatmap levels. */
export function snapshotLevels(snapshot: OrderBookSnapshot): HeatmapLevel[] {
  let parsed: { bids?: unknown; asks?: unknown } = {};
  try {
    parsed = snapshot.levelsJson ? (JSON.parse(snapshot.levelsJson) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  const side = (raw: unknown): HeatmapLevel[] =>
    Array.isArray(raw)
      ? validLevels(
          (raw as { P?: unknown; V?: unknown }[]).map((l) => [Number(l?.P), Number(l?.V)] as HeatmapLevel),
        )
      : [];
  return [...side(parsed.bids), ...side(parsed.asks)];
}

/**
 * The live book (the 1.5 s depth poll) folded into the grid's newest column: the snapshot replaces the column of the
 * bucket it was captured in, or opens the next bucket's column. Older snapshots than the grid's newest, other symbols
 * and books without levels change nothing. The colour scale is kept, so the map does not flicker every poll.
 */
export function foldLiveSnapshot(grid: HeatGrid, snapshot: OrderBookSnapshot): HeatGrid {
  if (snapshot.symbol?.toUpperCase() !== grid.symbol.toUpperCase()) return grid;
  const captured = utcMs(snapshot.capturedAt);
  if (!Number.isFinite(captured) || captured < grid.fromUtc) return grid;
  const last = grid.columns.at(-1);
  if (last && captured <= last.capturedAt) return grid;
  const levels = snapshotLevels(snapshot);
  if (levels.length === 0) return grid;
  const k = Math.floor((captured - grid.fromUtc) / grid.bucketMs);
  const t = grid.fromUtc + k * grid.bucketMs;
  const column = binColumn(
    t,
    t + grid.bucketMs,
    captured,
    snapshot.bidPrice,
    snapshot.askPrice,
    levels,
    grid.rowStep,
  );
  const columns = last && last.t === t ? [...grid.columns.slice(0, -1), column] : [...grid.columns, column];
  const sources = grid.sources.includes(snapshot.instanceId)
    ? grid.sources
    : [...grid.sources, snapshot.instanceId];
  return { ...grid, columns, sources, toUtc: Math.max(grid.toUtc, t + grid.bucketMs) };
}

/** The grid as of the replay head: no column at or after `clipUtc`, and the one spanning it ends there. */
export function clipHeatGrid(grid: HeatGrid, clipUtc: number | null): HeatGrid {
  if (clipUtc === null || clipUtc >= grid.toUtc) return grid;
  const columns: HeatColumn[] = [];
  for (const c of grid.columns) {
    // A snapshot captured after the head is the future, even inside the head's own bucket.
    if (c.t >= clipUtc || c.capturedAt > clipUtc) continue;
    columns.push(c.end > clipUtc ? { ...c, end: clipUtc } : c);
  }
  return { ...grid, columns, toUtc: Math.max(grid.fromUtc, clipUtc) };
}

/** What a fetched window was asked for. */
export interface HeatWindow {
  symbol: string;
  fromUtc: number;
  toUtc: number;
  buckets: number;
}

/** The engine's bucket cap (C1). */
export const MAX_BUCKETS = 800;
/** About one column per 3 px of chart. */
export const PX_PER_BUCKET = 3;
/** The window fetched reaches this share of the view past each side, so a small pan needs no new fetch. */
export const WINDOW_MARGIN = 0.25;

/**
 * The window to fetch for a view: the view widened by {@link WINDOW_MARGIN} each side, never before the oldest
 * snapshot held (when known) nor past `capUtc` (now, or the replay head); bucket count ≈ px / 3 over that window,
 * at most 800. Null when nothing of it can hold depth.
 */
export function heatWindowFor(
  symbol: string,
  view: { fromUtc: number; toUtc: number; widthPx: number },
  capUtc: number,
  oldestAvailableUtc: number | null,
): HeatWindow | null {
  const span = Math.max(60_000, view.toUtc - view.fromUtc);
  let fromUtc = view.fromUtc - span * WINDOW_MARGIN;
  let toUtc = Math.min(capUtc, view.toUtc + span * WINDOW_MARGIN);
  if (oldestAvailableUtc !== null) fromUtc = Math.max(fromUtc, oldestAvailableUtc);
  if (!(toUtc > fromUtc)) return null;
  fromUtc = Math.floor(fromUtc / 1000) * 1000;
  toUtc = Math.ceil(toUtc / 1000) * 1000;
  const px = Math.max(1, view.widthPx) * ((toUtc - fromUtc) / span);
  const buckets = Math.max(1, Math.min(MAX_BUCKETS, Math.round(px / PX_PER_BUCKET)));
  return { symbol, fromUtc, toUtc, buckets };
}

/**
 * Whether the view has moved off what was fetched: another symbol, a visible edge outside the fetched window (allowing
 * for the cap — the live edge or replay head may sit inside it), or a zoom that makes the fetched columns more than
 * 1.6× too wide or too narrow.
 */
export function heatNeedsFetch(fetched: HeatWindow | null, wanted: HeatWindow | null): boolean {
  if (!wanted) return false;
  if (!fetched || fetched.symbol !== wanted.symbol) return true;
  const fetchedBucket = (fetched.toUtc - fetched.fromUtc) / fetched.buckets;
  const wantedBucket = (wanted.toUtc - wanted.fromUtc) / wanted.buckets;
  const ratio = wantedBucket / fetchedBucket;
  if (ratio > 1.6 || ratio < 1 / 1.6) return true;
  const slack = fetchedBucket;
  return wanted.fromUtc < fetched.fromUtc - slack || wanted.toUtc > fetched.toUtc + slack;
}

/** The cell under a point: the column whose bucket holds `utcMs`, and its row nearest `price` (null: none there). */
export function heatCellAt(
  grid: HeatGrid,
  utcMs: number,
  price: number,
): { column: HeatColumn; price: number; volume: number } | null {
  const cols = grid.columns;
  let lo = 0;
  let hi = cols.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cols[mid].t <= utcMs) lo = mid + 1;
    else hi = mid;
  }
  const column = cols[lo - 1];
  if (!column || utcMs >= column.end) return null;
  const key = Math.round(price / grid.rowStep);
  const rows = column.rows;
  let a = 0;
  let b = rows.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (rows[mid] < key) a = mid + 1;
    else b = mid;
  }
  if (a >= rows.length || rows[a] !== key) return null;
  return { column, price: key * grid.rowStep, volume: column.volumes[a] };
}

/** "5 min", "30 s", "2 h" — how often the heatmap samples the book. */
export function formatBucket(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h} h`;
}
