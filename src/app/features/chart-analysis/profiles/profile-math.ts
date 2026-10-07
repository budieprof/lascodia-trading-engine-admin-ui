import { periodKey, type Ohlc } from '../indicators/math';
import type { TradingDays } from '../datafeed/session-calendar';

/**
 * Profile studies — pure math. Bar `time` is UTC epoch milliseconds (the chart's `Ohlc`
 * convention). FX `volume` is TICK volume: every profile here is a tick-volume profile.
 *
 * Each bar's volume is spread uniformly across its high–low range (overlap-weighted per row),
 * not dumped on the close, so total row volume always equals total bar volume.
 *
 * Days, weeks and months are the symbol's TRADING days when the chart knows its session (`days`,
 * a `TradingCalendar` — for FX, days from 17:00 to 17:00 New York), as TradingView's session and
 * periodic profiles and TPO count them; without one, UTC days.
 */

export interface ProfileRow {
  priceLow: number;
  priceHigh: number;
  upVol: number;
  downVol: number;
}

export interface VolumeProfile {
  rows: ProfileRow[];
  /** Row index of the point of control. */
  pocIndex: number;
  /** Mid price of the POC row. */
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
  maxRowVolume: number;
  /** Bar index range [fromIdx, toIdx] (inclusive) and its time span (ms). */
  fromIdx: number;
  toIdx: number;
  t0: number;
  t1: number;
}

export interface ProfileOptions {
  /** Row count (default 24). Ignored when tickSize is given. */
  rows?: number;
  /** Fixed row height in price units. */
  tickSize?: number;
  /** Value-area percentage 0..100 (default 70). */
  valueAreaPct?: number;
  /** Split volume into up (close >= open) / down. Default true; false puts all in upVol. */
  upDown?: boolean;
}

const DAY = 86_400_000;
const MIN = 60_000;
const MAX_ROWS = 2000;

interface Grid {
  lo: number;
  step: number;
  n: number;
}

function makeGrid(lo: number, hi: number, opts: { rows?: number; tickSize?: number }): Grid {
  if (opts.tickSize && opts.tickSize > 0) {
    const step = opts.tickSize;
    const gLo = Math.floor(lo / step + 1e-9) * step;
    // Rows are [low, low+step); the high must land inside the last row, hence +1.
    const n = Math.floor((hi - gLo) / step + 1e-9) + 1;
    if (n > MAX_ROWS) return { lo, step: (hi - lo) / MAX_ROWS || 1, n: MAX_ROWS };
    return { lo: gLo, step, n };
  }
  const n = Math.max(1, Math.min(MAX_ROWS, Math.round(opts.rows ?? 24)));
  const range = hi - lo;
  return { lo, step: range > 0 ? range / n : Math.max(Math.abs(lo) * 1e-6, 1e-9), n };
}

function rowOf(g: Grid, price: number): number {
  return Math.min(g.n - 1, Math.max(0, Math.floor((price - g.lo) / g.step + 1e-9)));
}

/**
 * Standard value-area expansion: start at POC, repeatedly add the larger of the next row
 * above / below until `pct` of total is enclosed. Returns [lowIdx, highIdx].
 */
export function valueAreaIndices(weights: readonly number[], pocIndex: number, pct: number): [number, number] {
  const total = weights.reduce((a, b) => a + b, 0);
  let lo = pocIndex;
  let hi = pocIndex;
  if (total <= 0) return [lo, hi];
  const target = (total * Math.min(100, Math.max(0, pct))) / 100;
  let acc = weights[pocIndex];
  while (acc < target - 1e-12 && (lo > 0 || hi < weights.length - 1)) {
    const up = hi < weights.length - 1 ? weights[hi + 1] : -1;
    const dn = lo > 0 ? weights[lo - 1] : -1;
    if (up >= dn) acc += weights[++hi];
    else acc += weights[--lo];
  }
  return [lo, hi];
}

/** Highest-weight index; ties go to the row nearest the middle of the range. */
export function pocIndexOf(weights: readonly number[]): number {
  let best = 0;
  const mid = (weights.length - 1) / 2;
  for (let i = 1; i < weights.length; i++) {
    if (weights[i] > weights[best] || (weights[i] === weights[best] && Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best;
}

/** Volume profile over all `bars`. Null when there are no bars or no volume. */
export function volumeProfile(bars: readonly Ohlc[], opts: ProfileOptions = {}): VolumeProfile | null {
  return profileRange(bars, 0, bars.length - 1, opts);
}

function profileRange(bars: readonly Ohlc[], fromIdx: number, toIdx: number, opts: ProfileOptions): VolumeProfile | null {
  const from = Math.max(0, fromIdx);
  const to = Math.min(bars.length - 1, toIdx);
  if (to < from) return null;
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    lo = Math.min(lo, b.low);
    hi = Math.max(hi, b.high);
    total += Math.max(0, b.volume || 0);
  }
  if (!isFinite(lo) || total <= 0) return null;
  const g = makeGrid(lo, hi, opts);
  const upDown = opts.upDown ?? true;
  const rows: ProfileRow[] = Array.from({ length: g.n }, (_, i) => ({
    priceLow: g.lo + i * g.step,
    priceHigh: g.lo + (i + 1) * g.step,
    upVol: 0,
    downVol: 0,
  }));
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const v = Math.max(0, b.volume || 0);
    if (v === 0) continue;
    const up = !upDown || b.close >= b.open;
    const r0 = rowOf(g, b.low);
    const r1 = rowOf(g, b.high);
    const range = b.high - b.low;
    if (range <= 0 || r0 === r1) {
      if (up) rows[r0].upVol += v;
      else rows[r0].downVol += v;
      continue;
    }
    // Overlap-weighted; renormalise so clamping at the grid edges never loses volume.
    let sumW = 0;
    const ws: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const w = Math.max(0, Math.min(b.high, rows[r].priceHigh) - Math.max(b.low, rows[r].priceLow));
      ws.push(w);
      sumW += w;
    }
    for (let r = r0; r <= r1; r++) {
      const share = sumW > 0 ? (v * ws[r - r0]) / sumW : v / (r1 - r0 + 1);
      if (up) rows[r].upVol += share;
      else rows[r].downVol += share;
    }
  }
  const weights = rows.map((r) => r.upVol + r.downVol);
  const pocIndex = pocIndexOf(weights);
  const [vaLo, vaHi] = valueAreaIndices(weights, pocIndex, opts.valueAreaPct ?? 70);
  return {
    rows,
    pocIndex,
    poc: (rows[pocIndex].priceLow + rows[pocIndex].priceHigh) / 2,
    vah: rows[vaHi].priceHigh,
    val: rows[vaLo].priceLow,
    totalVolume: total,
    maxRowVolume: Math.max(...weights),
    fromIdx: from,
    toIdx: to,
    t0: bars[from].time,
    t1: bars[to].time,
  };
}

/** Profile of bars[fromIdx..toIdx] inclusive (indices clamped). */
export function visibleRangeProfile(
  bars: readonly Ohlc[],
  fromIdx: number,
  toIdx: number,
  opts: ProfileOptions = {},
): VolumeProfile | null {
  return profileRange(bars, Math.floor(fromIdx), Math.ceil(toIdx), opts);
}

// ── Sessions ────────────────────────────────────────────────────────────────

export type SessionName = 'daily' | 'asia' | 'london' | 'newyork';

/**
 * Session windows in minutes-of-day on the clock shifted by `tzOffsetMinutes` (0 = UTC).
 * Asia wraps midnight (23:00–08:00 UTC, Tokyo open through London pre-open).
 */
export const SESSION_WINDOWS: Record<Exclude<SessionName, 'daily'>, { start: number; end: number }> = {
  asia: { start: 23 * 60, end: 8 * 60 },
  london: { start: 7 * 60, end: 16 * 60 },
  newyork: { start: 12 * 60, end: 21 * 60 },
};

export interface SessionProfile {
  /** Session start (UTC ms, on the true clock). */
  sessionStart: number;
  startIdx: number;
  endIdx: number;
  profile: VolumeProfile;
}

export interface SessionOptions extends ProfileOptions {
  session: SessionName;
  /** Offset of the session clock from UTC in minutes (e.g. -300 for New York EST). */
  tzOffsetMinutes?: number;
  /** The symbol's trading days: what a `daily` session is when no clock offset is set. */
  days?: TradingDays;
}

/**
 * Start (UTC ms) of the session containing t, or null when t is outside the window.
 *
 * <p>`daily` with no clock offset is the symbol's trading session when `days` is given — for FX
 * from 17:00 New York (21:00 or 22:00 UTC) — as TradingView's session profile and TPO count
 * sessions. An explicit offset keeps a midnight-to-midnight day on that clock.</p>
 */
export function sessionStartOf(
  t: number,
  session: SessionName,
  tzOffsetMinutes = 0,
  days?: TradingDays,
): number | null {
  if (session === 'daily' && days && tzOffsetMinutes === 0) return days.sessionAt(t).start;
  const off = tzOffsetMinutes * MIN;
  const local = t + off;
  const dayStart = Math.floor(local / DAY) * DAY;
  if (session === 'daily') return dayStart - off;
  const { start, end } = SESSION_WINDOWS[session];
  const m = (local - dayStart) / MIN;
  if (start < end) return m >= start && m < end ? dayStart + start * MIN - off : null;
  if (m >= start) return dayStart + start * MIN - off;
  if (m < end) return dayStart - DAY + start * MIN - off;
  return null;
}

function groupProfiles(
  bars: readonly Ohlc[],
  keyOf: (t: number) => number | null,
  opts: ProfileOptions,
): SessionProfile[] {
  const out: SessionProfile[] = [];
  let i = 0;
  while (i < bars.length) {
    const k = keyOf(bars[i].time);
    if (k === null) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < bars.length && keyOf(bars[j + 1].time) === k) j++;
    const profile = profileRange(bars, i, j, opts);
    if (profile) out.push({ sessionStart: k, startIdx: i, endIdx: j, profile });
    i = j + 1;
  }
  return out;
}

/** One profile per session occurrence (contiguous bars sharing a session start). */
export function sessionProfiles(bars: readonly Ohlc[], opts: SessionOptions): SessionProfile[] {
  return groupProfiles(
    bars,
    (t) => sessionStartOf(t, opts.session, opts.tzOffsetMinutes ?? 0, opts.days),
    opts,
  );
}

export type ProfilePeriod = 'day' | 'week' | 'month';

/**
 * The day / ISO week (Monday) / month containing t. With the symbol's trading days (`days`), the
 * period of its trading DATE — a key ({@link periodKey}), not an instant: an FX session's evening
 * bars belong to the next day. Without them, the start (UTC ms) of the UTC one.
 */
export function periodStartOf(t: number, period: ProfilePeriod, days?: TradingDays): number {
  if (days) {
    return periodKey(t, period === 'day' ? 'Day' : period === 'week' ? 'Week' : 'Month', days.dayOf);
  }
  const day = Math.floor(t / DAY) * DAY;
  if (period === 'day') return day;
  if (period === 'week') {
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    return day - dow * DAY;
  }
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function periodicProfiles(
  bars: readonly Ohlc[],
  opts: ProfileOptions & { period: ProfilePeriod; days?: TradingDays },
): SessionProfile[] {
  return groupProfiles(bars, (t) => periodStartOf(t, opts.period, opts.days), opts);
}

export type AutoAnchor = 'highestHigh' | 'lowestLow' | 'session' | 'week';

/**
 * Profile from an automatically chosen anchor bar to the last bar. highestHigh/lowestLow
 * search the last `lookback` bars (default 100); session = the current trading day (the UTC day
 * without `days`), week = the current week.
 */
export function autoAnchoredProfile(
  bars: readonly Ohlc[],
  opts: ProfileOptions & { anchor: AutoAnchor; lookback?: number; days?: TradingDays },
): VolumeProfile | null {
  if (bars.length === 0) return null;
  const last = bars.length - 1;
  let anchor = last;
  if (opts.anchor === 'highestHigh' || opts.anchor === 'lowestLow') {
    const start = Math.max(0, bars.length - Math.max(1, opts.lookback ?? 100));
    anchor = start;
    for (let i = start; i <= last; i++) {
      if (opts.anchor === 'highestHigh' ? bars[i].high > bars[anchor].high : bars[i].low < bars[anchor].low) anchor = i;
    }
  } else {
    // Back over the bars of the newest bar's period. Compared by period, not by time: a trading
    // day's key is its date, and its session opened the evening before.
    const period = opts.anchor === 'session' ? 'day' : 'week';
    const key = periodStartOf(bars[last].time, period, opts.days);
    while (anchor > 0 && periodStartOf(bars[anchor - 1].time, period, opts.days) === key) anchor--;
  }
  return profileRange(bars, anchor, last, opts);
}

/** Fixed-range profile between two times (ms, inclusive). */
export function fixedRangeProfile(
  bars: readonly Ohlc[],
  fromTime: number,
  toTime: number,
  opts: ProfileOptions = {},
): VolumeProfile | null {
  const a = Math.min(fromTime, toTime);
  const b = Math.max(fromTime, toTime);
  let i = 0;
  while (i < bars.length && bars[i].time < a) i++;
  let j = bars.length - 1;
  while (j >= 0 && bars[j].time > b) j--;
  return profileRange(bars, i, j, opts);
}

// ── TPO (market profile) ────────────────────────────────────────────────────

export interface TpoRow {
  priceLow: number;
  priceHigh: number;
  /** One letter per bracket that traded through this row, in bracket order. */
  letters: string[];
}

export interface TpoProfile {
  sessionStart: number;
  startIdx: number;
  endIdx: number;
  t0: number;
  t1: number;
  rows: TpoRow[];
  pocIndex: number;
  poc: number;
  vah: number;
  val: number;
  /** Initial balance = range of the first two brackets. */
  ibHigh: number;
  ibLow: number;
  /** Row indices with exactly one TPO. */
  singlePrints: number[];
  bracketCount: number;
}

export interface TpoOptions {
  period?: 'day';
  bracketMinutes?: number;
  tickSize?: number;
  rows?: number;
  valueAreaPct?: number;
  tzOffsetMinutes?: number;
  /** The symbol's trading days: with no clock offset, each profile is one trading session. */
  days?: TradingDays;
}

/** A..Z then a..z, then wraps. */
export function tpoLetter(bracket: number): string {
  const k = bracket % 52;
  return k < 26 ? String.fromCharCode(65 + k) : String.fromCharCode(97 + k - 26);
}

export function tpoProfile(bars: readonly Ohlc[], opts: TpoOptions = {}): TpoProfile[] {
  const bracketMs = Math.max(1, opts.bracketMinutes ?? 30) * MIN;
  const tz = opts.tzOffsetMinutes ?? 0;
  const out: TpoProfile[] = [];
  let i = 0;
  while (i < bars.length) {
    // The session's open is also where its brackets count from: A is its first half hour.
    const key = sessionStartOf(bars[i].time, 'daily', tz, opts.days) as number;
    let j = i;
    while (j + 1 < bars.length && sessionStartOf(bars[j + 1].time, 'daily', tz, opts.days) === key)
      j++;
    const tpo = buildTpo(bars, i, j, key, bracketMs, opts);
    if (tpo) out.push(tpo);
    i = j + 1;
  }
  return out;
}

function buildTpo(
  bars: readonly Ohlc[],
  from: number,
  to: number,
  sessionStart: number,
  bracketMs: number,
  opts: TpoOptions,
): TpoProfile | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = from; k <= to; k++) {
    lo = Math.min(lo, bars[k].low);
    hi = Math.max(hi, bars[k].high);
  }
  if (!isFinite(lo)) return null;
  const g = makeGrid(lo, hi, { tickSize: opts.tickSize, rows: opts.rows });
  const rows: TpoRow[] = Array.from({ length: g.n }, (_, r) => ({
    priceLow: g.lo + r * g.step,
    priceHigh: g.lo + (r + 1) * g.step,
    letters: [],
  }));
  const touched: Set<number>[] = rows.map(() => new Set<number>());
  let ibHigh = -Infinity;
  let ibLow = Infinity;
  let maxBracket = 0;
  for (let k = from; k <= to; k++) {
    const b = bars[k];
    const br = Math.max(0, Math.floor((b.time - sessionStart) / bracketMs));
    maxBracket = Math.max(maxBracket, br);
    if (br < 2) {
      ibHigh = Math.max(ibHigh, b.high);
      ibLow = Math.min(ibLow, b.low);
    }
    // A high sitting exactly on a row's lower edge did not trade INTO that row.
    const rLo = rowOf(g, b.low);
    let rHi = rowOf(g, b.high);
    if (rHi > rLo && b.high <= rows[rHi].priceLow + g.step * 1e-6) rHi--;
    for (let r = rLo; r <= rHi; r++) touched[r].add(br);
  }
  touched.forEach((set, r) => {
    rows[r].letters = [...set].sort((a, b) => a - b).map(tpoLetter);
  });
  const counts = rows.map((r) => r.letters.length);
  const pocIndex = pocIndexOf(counts);
  const [vaLo, vaHi] = valueAreaIndices(counts, pocIndex, opts.valueAreaPct ?? 70);
  if (!isFinite(ibHigh)) {
    ibHigh = hi;
    ibLow = lo;
  }
  return {
    sessionStart,
    startIdx: from,
    endIdx: to,
    t0: bars[from].time,
    t1: bars[to].time,
    rows,
    pocIndex,
    poc: (rows[pocIndex].priceLow + rows[pocIndex].priceHigh) / 2,
    vah: rows[vaHi].priceHigh,
    val: rows[vaLo].priceLow,
    ibHigh,
    ibLow,
    singlePrints: counts.flatMap((c, r) => (c === 1 ? [r] : [])),
    bracketCount: maxBracket + 1,
  };
}
