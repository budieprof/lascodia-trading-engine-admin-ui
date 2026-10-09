import type { Ohlc } from '../indicators/math';
import { periodKey } from '../indicators/periods';
import type { TradingDays } from '../datafeed/session-calendar';
import {
  SESSION_WINDOWS as NAMED_SESSIONS,
  minutesOfDay,
  sessionDayOf,
} from '../indicators/sessions';
import { timezoneOffsetMinutes } from '../workspace/layout-store.service';

/**
 * Profile studies — pure math, and THE one volume profile and VWAP of the chart (DR-19): the profile
 * studies, the chart-level volume profile overlay, the market-structure read, the volume-profile and
 * anchored-VWAP drawing tools and the VWAP indicators all compute here. (There were three profiles
 * that split a bar's volume differently and three VWAPs that treated a bar without volume three ways.)
 * Bar `time` is UTC epoch milliseconds (the chart's `Ohlc` convention). FX `volume` is TICK volume:
 * every profile here is a tick-volume profile.
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
export function valueAreaIndices(
  weights: readonly number[],
  pocIndex: number,
  pct: number,
): [number, number] {
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
    if (
      weights[i] > weights[best] ||
      (weights[i] === weights[best] && Math.abs(i - mid) < Math.abs(best - mid))
    )
      best = i;
  }
  return best;
}

/** Volume profile over all `bars`. Null when there are no bars or no volume. */
export function volumeProfile(
  bars: readonly Ohlc[],
  opts: ProfileOptions = {},
): VolumeProfile | null {
  return profileRange(bars, 0, bars.length - 1, opts);
}

function profileRange(
  bars: readonly Ohlc[],
  fromIdx: number,
  toIdx: number,
  opts: ProfileOptions,
): VolumeProfile | null {
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
      const w = Math.max(
        0,
        Math.min(b.high, rows[r].priceHigh) - Math.max(b.low, rows[r].priceLow),
      );
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

// ── VWAP ────────────────────────────────────────────────────────────────────

export type VwapSource = 'hlc3' | 'hl2' | 'ohlc4' | 'close' | 'open' | 'high' | 'low';

export function priceOf(b: Ohlc, src: VwapSource): number {
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

export interface VwapRun {
  /** The VWAP per bar; null before the start, and while no volume has traded since the last reset. */
  vwap: (number | null)[];
  /** The volume-weighted standard deviation of the price about it (the bands' unit); null with `vwap`. */
  dev: (number | null)[];
}

/**
 * Volume-weighted average price — the chart's one VWAP (`ta.vwap`, DR-19): Σ price·volume / Σ volume from
 * `startIndex` (an anchor), starting again whenever `periodOf` changes (a session, week or month). A bar without
 * volume adds nothing, and while a period has had no volume the VWAP is na — as TradingView's: an average weighted
 * by volume is undefined without any. The deviation is √(Σ v·p² / Σ v − vwap²), clamped at 0, summed in the
 * engine runtime's order so a single bar's deviation is exactly 0 in both.
 */
export function vwapRun(
  bars: readonly Ohlc[],
  opts: { source?: VwapSource; startIndex?: number; periodOf?: (time: number) => number } = {},
): VwapRun {
  const n = bars.length;
  const vwap: (number | null)[] = new Array(n).fill(null);
  const dev: (number | null)[] = new Array(n).fill(null);
  const src = opts.source ?? 'hlc3';
  let key = NaN;
  let sv = 0;
  let spv = 0;
  let sp2v = 0;
  for (let i = Math.max(0, opts.startIndex ?? 0); i < n; i++) {
    const b = bars[i];
    const k = opts.periodOf ? opts.periodOf(b.time) : 0;
    if (k !== key) {
      key = k;
      sv = 0;
      spv = 0;
      sp2v = 0;
    }
    const p = priceOf(b, src);
    const v = b.volume;
    if (Number.isFinite(p) && Number.isFinite(v) && v > 0) {
      spv += p * v;
      sv += v;
      sp2v += v * p * p;
    }
    if (sv <= 0) continue;
    const vw = spv / sv;
    vwap[i] = vw;
    dev[i] = Math.sqrt(Math.max(0, sp2v / sv - vw * vw));
  }
  return { vwap, dev };
}

// ── Sessions ────────────────────────────────────────────────────────────────

export type SessionName = 'daily' | 'asia' | 'london' | 'newyork';

/**
 * The named sessions are the Sessions indicator's (`indicators/sessions.ts`, DR-18): Tokyo 09:00–18:00, London and
 * New York 08:00–17:00, each on its own clock with its daylight saving, Monday to Friday. (They were fixed UTC hours —
 * London 07:00–16:00 UTC all year, an hour early in winter — and Asia a different window from the indicator's.)
 */
export const SESSION_WINDOWS = NAMED_SESSIONS;

export interface SessionProfile {
  /** Session start (UTC ms, on the true clock). */
  sessionStart: number;
  startIdx: number;
  endIdx: number;
  profile: VolumeProfile;
}

export interface SessionOptions extends ProfileOptions {
  session: SessionName;
  /** For the `daily` session only: a midnight-to-midnight day on this clock (minutes from UTC). */
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
  if (session === 'daily') {
    const off = tzOffsetMinutes * MIN;
    return Math.floor((t + off) / DAY) * DAY - off;
  }
  const w = SESSION_WINDOWS[session];
  const localDay = sessionDayOf(t, w);
  if (localDay === null) return null;
  // The open's instant: its local time on that date, less the zone's offset there.
  const openLocal = localDay + minutesOfDay(w.start) * MIN;
  const guess = openLocal - timezoneOffsetMinutes(w.zone, openLocal) * MIN;
  return openLocal - timezoneOffsetMinutes(w.zone, guess) * MIN;
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
    return periodKey(
      t,
      period === 'day' ? 'Day' : period === 'week' ? 'Week' : 'Month',
      days.dayOf,
    );
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
      if (
        opts.anchor === 'highestHigh'
          ? bars[i].high > bars[anchor].high
          : bars[i].low < bars[anchor].low
      )
        anchor = i;
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

// ── Developing POC / value area, naked POCs, composite (DR-I7) ────────────────

export interface DevelopingProfile {
  /** One point per checkpoint: the time (UTC ms) it holds from, and the profile of the period so far. */
  t: number[];
  poc: number[];
  vah: number[];
  val: number[];
}

/**
 * How a period's POC and value area developed, as TradingView's "Developing POC / VA" draw them: at each checkpoint
 * (the chart's bar opens inside the period) the profile of the period's bars SO FAR — its own grid over its own
 * range, so a point never knows a later bar's price. `bars[from..to]` is the period (lower-timeframe bars when the
 * chart has them); `checkpoints` ascending UTC ms.
 */
export function developingProfile(
  bars: readonly Ohlc[],
  from: number,
  to: number,
  checkpoints: readonly number[],
  opts: ProfileOptions = {},
): DevelopingProfile {
  const out: DevelopingProfile = { t: [], poc: [], vah: [], val: [] };
  if (to < from) return out;
  const t0 = bars[from].time;
  const t1 = bars[to].time;
  let k = from;
  // Each checkpoint takes the bars that OPENED before it (the period up to that bar), plus the last one at the end.
  const points = checkpoints.filter((c) => c > t0 && c <= t1);
  points.push(Number.POSITIVE_INFINITY);
  for (const c of points) {
    while (k + 1 <= to && bars[k + 1].time < c) k++;
    const p = profileRange(bars, from, k, opts);
    if (!p) continue;
    out.t.push(c === Number.POSITIVE_INFINITY ? bars[k].time : c);
    out.poc.push(p.poc);
    out.vah.push(p.vah);
    out.val.push(p.val);
  }
  return out;
}

export interface NakedPoc {
  price: number;
  /** When the period whose POC it is ended (its last bar's open, UTC ms). */
  from: number;
  /** The first later bar that traded through it (UTC ms), or null: still naked. */
  until: number | null;
}

/**
 * The POCs of `periods` that price has not revisited — "naked" (virgin) POCs: each one from its period's end until
 * the first LATER bar whose range holds it, or still open. Only the latest `limit` stay (a long scroll-back
 * otherwise draws hundreds).
 */
export function nakedPocs(
  bars: readonly Ohlc[],
  periods: readonly SessionProfile[],
  limit = 20,
): NakedPoc[] {
  const out: NakedPoc[] = [];
  for (const s of periods) {
    const price = s.profile.poc;
    let until: number | null = null;
    for (let i = s.endIdx + 1; i < bars.length; i++) {
      if (bars[i].low <= price && bars[i].high >= price) {
        until = bars[i].time;
        break;
      }
    }
    out.push({ price, from: s.profile.t1, until });
  }
  return out.slice(Math.max(0, out.length - limit));
}

/**
 * One profile of the last `periods` trading days (a composite): their bars together, as TradingView's composite /
 * multi-session profile — the levels a market has built over a week rather than within a day.
 */
export function compositeProfile(
  bars: readonly Ohlc[],
  opts: ProfileOptions & { periods: number; days?: TradingDays },
): VolumeProfile | null {
  if (bars.length === 0) return null;
  const want = Math.max(1, Math.round(opts.periods));
  let seen = 1;
  let start = bars.length - 1;
  let key = periodStartOf(bars[start].time, 'day', opts.days);
  for (let i = bars.length - 2; i >= 0; i--) {
    const k = periodStartOf(bars[i].time, 'day', opts.days);
    if (k !== key) {
      if (seen === want) break;
      seen++;
      key = k;
    }
    start = i;
  }
  return profileRange(bars, start, bars.length - 1, opts);
}

/** The interval of `bars` (the median gap, so weekends do not count), ms; 0 for fewer than two bars. */
export function barIntervalOf(bars: readonly { time: number }[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < bars.length && gaps.length < 400; i++) {
    const g = bars[i].time - bars[i - 1].time;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
