/**
 * Pure maths for the "Forecasting and measurement tools" family.
 *
 * Everything here is canvas-free so the numbers TradingView prints (R:R, P&L,
 * tick counts, bar counts, VWAP, profile rows) can be pinned by unit tests.
 */

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Formatting ────────────────────────────────────────────────────────────

/** Minimum tick for a price shown with `precision` decimals. */
export function tickSize(precision: number): number {
  return Math.pow(10, -precision);
}

/**
 * Distance in ticks, as TradingView prints it after the percentage.
 *
 * Forex symbols quoted with a fractional pip (5 or 3 decimals) are shown in
 * pips with one decimal — "0.00500 … 50.0" — everything else in whole ticks.
 */
export function formatTicks(delta: number, precision: number): string {
  const ticks = delta / tickSize(precision);
  if (precision === 5 || precision === 3) return (ticks / 10).toFixed(1);
  return String(Math.round(ticks));
}

/** Plain number with thousands kept compact: 2 decimals, trailing zeros dropped. */
export function formatAmount(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** "1.23M" / "45.6K" / "789" — TradingView's volume abbreviation. */
export function formatVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${formatAmount(v / 1e9)}B`;
  if (a >= 1e6) return `${formatAmount(v / 1e6)}M`;
  if (a >= 1e3) return `${formatAmount(v / 1e3)}K`;
  return formatAmount(v);
}

/** "2d 3h", "3h 20m", "45m", "0m" — the two largest non-zero units, TradingView style. */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  let m = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return sign + (parts.slice(0, 2).join(' ') || '0m');
}

/** "Δprice (Δ%) Δticks" — the Price Range label. */
export function priceRangeText(from: number, to: number, precision: number): string {
  const delta = to - from;
  const pct = from !== 0 ? (delta / Math.abs(from)) * 100 : 0;
  return `${delta.toFixed(precision)} (${pct.toFixed(2)}%) ${formatTicks(delta, precision)}`;
}

/** "N bars, Xd Yh" — the Date Range label's first line. */
export function dateRangeText(bars: number, ms: number): string {
  return `${bars} bar${Math.abs(bars) === 1 ? '' : 's'}, ${formatDuration(ms)}`;
}

// ── Time axis ─────────────────────────────────────────────────────────────

/** Bar interval in ms from a chart resolution string ("60", "240", "D", "1W"…). */
export function resolutionMs(resolution: string | undefined): number | null {
  if (!resolution) return null;
  const m = /^(\d*)([SDWM]?)$/i.exec(resolution.trim());
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const unit = m[2].toUpperCase();
  const minute = 60_000;
  if (unit === 'S') return n * 1000;
  if (unit === 'D') return n * 1440 * minute;
  if (unit === 'W') return n * 7 * 1440 * minute;
  if (unit === 'M') return n * 30 * 1440 * minute;
  return n * minute;
}

/** Median spacing of the bars, the fallback interval when the resolution is unknown. */
export function medianInterval(bars: readonly { time: number }[]): number | null {
  if (bars.length < 2) return null;
  const diffs: number[] = [];
  for (let i = Math.max(1, bars.length - 200); i < bars.length; i++) diffs.push(bars[i].time - bars[i - 1].time);
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1] || null;
}

/**
 * Fractional bar index of `time`. Inside the series it is the index of the bar
 * at or before `time`; past either end it extrapolates at `interval`, which is
 * how a range reaching into the future still counts bars.
 */
export function barIndexAt(bars: readonly { time: number }[], time: number, interval: number): number {
  if (bars.length === 0) return time / interval;
  const first = bars[0].time;
  const last = bars[bars.length - 1].time;
  if (time >= last) return bars.length - 1 + (time - last) / interval;
  if (time <= first) return (time - first) / interval;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Signed bar count from t0 to t1 — what "N bars" means on every TV measurer. */
export function barsBetween(bars: readonly { time: number }[], t0: number, t1: number, interval: number): number {
  return Math.round(barIndexAt(bars, t1, interval) - barIndexAt(bars, t0, interval));
}

/** Total volume of the bars whose time falls within [t0, t1] (either order). */
export function volumeBetween(bars: readonly OhlcvBar[], t0: number, t1: number): number {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  let v = 0;
  for (const b of bars) if (b.time >= lo && b.time <= hi) v += b.volume;
  return v;
}

// ── Long / short position ─────────────────────────────────────────────────

export interface PositionInputs {
  side: 'long' | 'short';
  entry: number;
  target: number;
  stop: number;
  accountSize: number;
  lotSize: number;
  risk: number;
  riskUnit: '%' | 'money';
  leverage: number;
  qtyPrecision: number;
}

export interface PositionStats {
  qty: number;
  riskAmount: number;
  rr: number;
  targetDelta: number;
  stopDelta: number;
  targetPct: number;
  stopPct: number;
  targetAmount: number;
  stopAmount: number;
}

function floorTo(v: number, decimals: number): number {
  const f = Math.pow(10, Math.max(0, decimals));
  return Math.floor(v * f + 1e-9) / f;
}

/**
 * TradingView's position maths: risk sets the size, leverage caps it
 * (`Qty = min(QtyRisk, QtyLvg)`), and the amounts are qty × lot × distance.
 */
export function positionStats(i: PositionInputs): PositionStats {
  const targetDelta = Math.abs(i.target - i.entry);
  const stopDelta = Math.abs(i.entry - i.stop);
  const riskAmount = i.riskUnit === '%' ? (i.accountSize * i.risk) / 100 : i.risk;
  const lot = i.lotSize > 0 ? i.lotSize : 1;
  const qtyRisk = stopDelta > 0 ? riskAmount / (stopDelta * lot) : 0;
  const qtyLvg = i.entry > 0 && i.leverage > 0 ? (i.accountSize * i.leverage) / (i.entry * lot) : Infinity;
  const qty = floorTo(Math.min(qtyRisk, qtyLvg), i.qtyPrecision);
  const base = i.entry !== 0 ? Math.abs(i.entry) : 1;
  return {
    qty,
    riskAmount,
    rr: stopDelta > 0 ? targetDelta / stopDelta : 0,
    targetDelta,
    stopDelta,
    targetPct: (targetDelta / base) * 100,
    stopPct: (stopDelta / base) * 100,
    targetAmount: qty * lot * targetDelta,
    stopAmount: qty * lot * stopDelta,
  };
}

/** P&L of the position if closed at `price`. */
export function positionPnl(side: 'long' | 'short', entry: number, price: number, qty: number, lotSize: number): number {
  return (side === 'long' ? price - entry : entry - price) * qty * (lotSize > 0 ? lotSize : 1);
}

export type PositionOutcome =
  | { state: 'pending' }
  | { state: 'open'; time: number; price: number }
  | { state: 'target' | 'stop' | 'expired'; time: number; price: number };

/**
 * Walk the bars from the entry to the box's right edge, as TradingView does:
 * the first bar to trade the entry opens the trade, then the first bar to touch
 * the target or stop closes it. A bar touching both is scored as the stop —
 * without intrabar data the pessimistic read is the honest one.
 */
export function positionOutcome(
  bars: readonly OhlcvBar[],
  side: 'long' | 'short',
  entry: number,
  target: number,
  stop: number,
  t0: number,
  t1: number,
): PositionOutcome {
  let opened = false;
  let last: OhlcvBar | null = null;
  for (const b of bars) {
    if (b.time < t0) continue;
    if (b.time > t1) break;
    last = b;
    if (!opened) {
      if (b.low <= entry && b.high >= entry) opened = true;
      else continue;
    }
    const hitStop = side === 'long' ? b.low <= stop : b.high >= stop;
    const hitTarget = side === 'long' ? b.high >= target : b.low <= target;
    if (hitStop) return { state: 'stop', time: b.time, price: stop };
    if (hitTarget) return { state: 'target', time: b.time, price: target };
  }
  if (!opened || !last) return { state: 'pending' };
  const lastBar = bars[bars.length - 1];
  if (lastBar && lastBar.time > t1) return { state: 'expired', time: last.time, price: last.close };
  return { state: 'open', time: last.time, price: last.close };
}

/**
 * Default target/stop for a freshly placed position: a stop sized to the
 * timeframe (0.15% of price on H1, scaled by √time) and a 1.5R target, 20 bars
 * wide. Deterministic, so a one-click position looks the same on every repaint.
 */
export function defaultPositionLevels(
  side: 'long' | 'short',
  entry: number,
  entryTime: number,
  interval: number,
): { target: number; stop: number; end: number } {
  const stopDist = entry * 0.0015 * Math.sqrt(interval / 3_600_000);
  const dir = side === 'long' ? 1 : -1;
  return { target: entry + dir * stopDist * 1.5, stop: entry - dir * stopDist, end: entryTime + 20 * interval };
}

// ── Anchored VWAP ─────────────────────────────────────────────────────────

export interface VwapPoint {
  time: number;
  vwap: number;
  stdev: number;
}

export type VwapSource = 'hlc3' | 'hl2' | 'ohlc4' | 'close' | 'open' | 'high' | 'low';

export function sourceOf(b: OhlcvBar, src: VwapSource): number {
  switch (src) {
    case 'hl2':
      return (b.high + b.low) / 2;
    case 'ohlc4':
      return (b.open + b.high + b.low + b.close) / 4;
    case 'close':
    case 'open':
    case 'high':
    case 'low':
      return b[src];
    default:
      return (b.high + b.low + b.close) / 3;
  }
}

/** Cumulative VWAP from the anchor, with the volume-weighted standard deviation for the bands. */
export function anchoredVwap(bars: readonly OhlcvBar[], anchor: number, src: VwapSource = 'hlc3'): VwapPoint[] {
  const out: VwapPoint[] = [];
  let pv = 0;
  let v = 0;
  let pv2 = 0;
  for (const b of bars) {
    if (b.time < anchor) continue;
    const s = sourceOf(b, src);
    const vol = b.volume > 0 ? b.volume : 0;
    pv += s * vol;
    pv2 += s * s * vol;
    v += vol;
    if (v <= 0) {
      out.push({ time: b.time, vwap: s, stdev: 0 });
      continue;
    }
    const vwap = pv / v;
    out.push({ time: b.time, vwap, stdev: Math.sqrt(Math.max(0, pv2 / v - vwap * vwap)) });
  }
  return out;
}

// ── Volume profile ────────────────────────────────────────────────────────

export interface ProfileRow {
  low: number;
  high: number;
  up: number;
  down: number;
  total: number;
}

export interface Profile {
  rows: ProfileRow[];
  poc: number;
  vaLow: number;
  vaHigh: number;
  peak: number;
}

/**
 * TradingView's fixed-range / anchored profile: `rows` equal price rows
 * spanning the window's high-low, each bar's volume spread over the rows its
 * range covers in proportion to overlap, split up/down by close vs open, and a
 * value area grown from the POC towards the fuller neighbour.
 */
export function volumeProfileRows(bars: readonly OhlcvBar[], rows = 24, valueAreaPct = 70): Profile | null {
  const used = bars.filter((b) => b.volume > 0);
  if (used.length === 0 || rows < 1) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of used) {
    lo = Math.min(lo, b.low);
    hi = Math.max(hi, b.high);
  }
  if (hi <= lo) hi = lo + Math.abs(lo) * 1e-6 + 1e-9;
  const step = (hi - lo) / rows;
  const out: ProfileRow[] = Array.from({ length: rows }, (_, i) => ({
    low: lo + i * step,
    high: lo + (i + 1) * step,
    up: 0,
    down: 0,
    total: 0,
  }));
  for (const b of used) {
    const up = b.close >= b.open;
    const span = b.high - b.low;
    const first = Math.min(rows - 1, Math.max(0, Math.floor((b.low - lo) / step)));
    const last = Math.min(rows - 1, Math.max(0, Math.floor((b.high - lo) / step)));
    for (let r = first; r <= last; r++) {
      const share =
        span > 0 ? (Math.min(b.high, out[r].high) - Math.max(b.low, out[r].low)) / span : 1 / (last - first + 1);
      if (share <= 0) continue;
      const vol = b.volume * share;
      if (up) out[r].up += vol;
      else out[r].down += vol;
      out[r].total += vol;
    }
  }
  let poc = 0;
  for (let i = 1; i < rows; i++) if (out[i].total > out[poc].total) poc = i;
  const total = out.reduce((s, r) => s + r.total, 0);
  let a = poc;
  let z = poc;
  let inside = out[poc].total;
  const target = (total * valueAreaPct) / 100;
  while (inside < target - 1e-9 && (a > 0 || z < rows - 1)) {
    const below = a > 0 ? out[a - 1].total : -1;
    const above = z < rows - 1 ? out[z + 1].total : -1;
    if (above >= below) inside += out[++z].total;
    else inside += out[--a].total;
  }
  return { rows: out, poc, vaLow: a, vaHigh: z, peak: out[poc].total };
}

// ── Forecast ──────────────────────────────────────────────────────────────

/**
 * Forecast outcome: success once any bar between source and target time
 * trades through the target price; failure once the target time has passed
 * without it; pending while the window is still open.
 */
export function forecastOutcome(
  bars: readonly OhlcvBar[],
  source: { time: number; price: number },
  target: { time: number; price: number },
): 'success' | 'failure' | 'pending' {
  const up = target.price >= source.price;
  const t0 = Math.min(source.time, target.time);
  const t1 = Math.max(source.time, target.time);
  for (const b of bars) {
    if (b.time <= t0 || b.time > t1) continue;
    if (up ? b.high >= target.price : b.low <= target.price) return 'success';
  }
  const last = bars[bars.length - 1];
  return last && last.time >= t1 ? 'failure' : 'pending';
}

// ── Ghost feed ────────────────────────────────────────────────────────────

/** Small deterministic PRNG so a ghost feed repaints identically. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic candles along a path of {index, price} anchors (index = bar
 * offset). Opens chain from the previous close; closes follow the path with
 * `variance` ticks of noise; each candle's high-low is about `avgHL` ticks.
 */
export function ghostCandles(
  path: readonly { index: number; price: number }[],
  avgHL: number,
  variance: number,
  tick: number,
  seed: string,
): { index: number; open: number; high: number; low: number; close: number }[] {
  const rnd = seededRandom(seed);
  const out: { index: number; open: number; high: number; low: number; close: number }[] = [];
  if (path.length < 2) return out;
  let prevClose = path[0].price;
  for (let s = 1; s < path.length; s++) {
    const a = path[s - 1];
    const b = path[s];
    const n = Math.max(1, Math.round(Math.abs(b.index - a.index)));
    const dir = b.index >= a.index ? 1 : -1;
    for (let k = 1; k <= n; k++) {
      const onPath = a.price + ((b.price - a.price) * k) / n;
      const noise = k === n ? 0 : (rnd() * 2 - 1) * variance * tick;
      const open = prevClose;
      const close = onPath + noise;
      const hl = Math.max(Math.abs(close - open), avgHL * tick * (0.5 + rnd()));
      const extra = Math.max(0, hl - Math.abs(close - open));
      const upShare = rnd();
      out.push({
        index: a.index + dir * k,
        open,
        close,
        high: Math.max(open, close) + extra * upShare,
        low: Math.min(open, close) - extra * (1 - upShare),
      });
      prevClose = close;
    }
  }
  return out;
}
