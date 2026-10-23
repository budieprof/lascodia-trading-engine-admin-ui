import { atr, periodKey, type DayOf, type Ohlc, type VolumeProfileBin } from '../indicators/math';
import {
  SESSION_WINDOWS,
  sessionStartOf,
  volumeProfile as volumeProfileOf,
} from '../profiles/profile-math';
import { sessionDayOf } from '../indicators/sessions';

/**
 * Analytical overlays computed from the loaded bars: volume profile, auto-detected
 * support/resistance, and an ESTIMATED order-flow delta.
 *
 * <p>Pure functions, so the arithmetic that decides where a level is drawn can be tested
 * without a chart. Everything here is derived from OHLCV — nothing is fetched.</p>
 */

// ── Volume profile ───────────────────────────────────────────────────────────

export interface VolumeProfileResult {
  bins: VolumeProfileBin[];
  /** Highest-volume bin: the price this window actually transacted at. */
  poc: number;
  /** Value area — the contiguous band around the POC holding `valueAreaPct` of volume. */
  valueAreaLow: number;
  valueAreaHigh: number;
  peak: number;
}

/**
 * How many price buckets to profile a window into.
 *
 * <p>Fixed at 40 the bars came out as thick slabs — on a tall pane each one was thirty-odd
 * pixels, which reads as a bar chart of five prices rather than a distribution. A volume
 * profile is supposed to be fine enough to show WHERE inside the range the trade happened.</p>
 *
 * <p>Scaled to the window rather than fixed high, because 200 buckets over a fifty-bar
 * window is mostly empty buckets, and the POC then lands on whichever single bar happened to
 * be busiest — precision that is not in the data.</p>
 */
export function binsForWindow(barCount: number): number {
  return Math.max(48, Math.min(180, Math.round(barCount * 0.8)));
}

/**
 * Volume by price for a window of bars, with its POC and value area — the profile engine's one profile
 * (`profiles/profile-math.ts`, DR-19), in the overlay's bin shape. That matters: this app had THREE volume profiles
 * that split a bar's volume differently (an even share per bucket here, overlap-weighted in the profile studies and
 * the drawing tools), so the overlay, a profile study and a profile drawing on one chart disagreed. One
 * implementation is the point.
 */
export function profileWithValueArea(
  bars: readonly Ohlc[],
  bins = binsForWindow(bars.length),
  valueAreaPct = 0.7,
): VolumeProfileResult | null {
  const p = volumeProfileOf(bars, { rows: bins, valueAreaPct: valueAreaPct * 100 });
  if (!p || p.totalVolume <= 0) return null;
  const computed: VolumeProfileBin[] = p.rows.map((r) => ({
    price: (r.priceLow + r.priceHigh) / 2,
    volume: r.upVol + r.downVol,
    up: r.upVol,
    down: r.downVol,
  }));
  const row = (price: number, edge: 'priceLow' | 'priceHigh') =>
    computed[
      Math.max(
        0,
        p.rows.findIndex((r) => r[edge] === price),
      )
    ];
  return {
    bins: computed,
    poc: computed[p.pocIndex].price,
    valueAreaLow: row(p.val, 'priceLow').price,
    valueAreaHigh: row(p.vah, 'priceHigh').price,
    peak: computed[p.pocIndex].volume,
  };
}

/**
 * How the chart-level volume profile slices the bars, as TradingView's VP family does. `session` is
 * the symbol's trading day (17:00–17:00 New York for FX); `sessions` is one profile per Asia, London
 * and New York session (DeepCharts / Sierra "session profiles", PR-1).
 */
export type VolumeProfileMode = 'visible' | 'session' | 'sessions' | 'week' | 'month';

/** The calendar modes, which slice by a period key ({@link periodStart}). */
export type PeriodMode = Exclude<VolumeProfileMode, 'visible' | 'sessions'>;

export const VOLUME_PROFILE_MODES: ReadonlyArray<{
  id: VolumeProfileMode;
  label: string;
  hint: string;
}> = [
  {
    id: 'visible',
    label: 'Visible Range',
    hint: 'One profile of the bars on screen, re-profiled as you pan',
  },
  { id: 'session', label: 'Session', hint: 'One profile per trading session' },
  {
    id: 'sessions',
    label: 'Asia · London · NY',
    hint:
      'One compact profile per Asia (Tokyo 09:00–18:00), London (08:00–17:00) and New York ' +
      '(08:00–17:00) session, each on its own clock — the Sessions indicator’s hours. Needs 1h bars or finer.',
  },
  { id: 'week', label: 'Periodic · Week', hint: 'One profile per trading week' },
  { id: 'month', label: 'Periodic · Month', hint: 'One profile per month of trading days' },
];

/** The named intraday sessions a `sessions` profile is cut by (`indicators/sessions.ts`). */
export type NamedSession = 'asia' | 'london' | 'newyork';

export const NAMED_SESSION_LABEL: Readonly<Record<NamedSession, string>> = {
  asia: 'Asia',
  london: 'London',
  newyork: 'New York',
};

export interface PeriodProfile {
  /** First and last bar time (ms) in the period. */
  t0: number;
  t1: number;
  profile: VolumeProfileResult;
  /** Index of the period's first and last bar in the bars it was cut from. */
  startIdx: number;
  endIdx: number;
  /** "Mon 20 Oct", "London 20 Oct", "wk 19 Oct", "Oct 2026" — what the period is called on the chart. */
  label: string;
  /** Which named session it is (`sessions` mode only). */
  session?: NamedSession;
}

/**
 * Key of the period `time` falls in.
 *
 * <p>With the symbol's trading days (`dayOf`), the trading day, week or month of its trading
 * DATE ({@link periodKey}): an FX session opens at 17:00 New York the evening before its date, so
 * a session profile spans 17:00 to 17:00 New York, Sunday evening's bars open Monday's week and the
 * session opening on 30 September opens October.</p>
 *
 * <p>Without them, the UTC day / Monday week / month the instant falls in — a start in UTC ms —
 * with Sunday folded into the following week, so FX's Sunday-evening open is not left as a
 * one-candle profile of its own.</p>
 */
export function periodStart(time: number, mode: PeriodMode, dayOf?: DayOf): number {
  if (dayOf) {
    return periodKey(time, mode === 'session' ? 'Day' : mode === 'week' ? 'Week' : 'Month', dayOf);
  }
  const d = new Date(time);
  if (mode === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (mode === 'session') return day;
  // ISO weeks start Monday; getUTCDay() is 0 on Sunday. FX's Sunday-evening open is folded
  // into the week it trades into, not left as a one-candle profile of its own.
  const dow = d.getUTCDay();
  const back = dow === 0 ? -1 : dow - 1;
  return day - back * 86_400_000;
}

/**
 * One profile per session / week / month over `bars` — of the symbol's trading days when `dayOf`
 * is given ({@link periodStart}).
 *
 * <p>Bins are sized per period rather than once for the whole chart: a quiet Asian session
 * and a busy NFP day each get a distribution fine enough to show where inside ITS range the
 * trade happened. Periods with too few bars to say anything are skipped.</p>
 */
export function periodProfiles(
  bars: readonly Ohlc[],
  mode: Exclude<VolumeProfileMode, 'visible'>,
  opts: { minBars?: number; dayOf?: DayOf } = {},
): PeriodProfile[] {
  if (mode === 'sessions') return namedSessionProfiles(bars, opts.minBars ?? 3);
  const minBars = opts.minBars ?? 3;
  const keyOf = (t: number) => periodStart(t, mode, opts.dayOf);
  const out: PeriodProfile[] = [];
  let start = 0;
  for (let i = 1; i <= bars.length; i++) {
    const boundary = i === bars.length || keyOf(bars[i].time) !== keyOf(bars[start].time);
    if (!boundary) continue;
    const slice = bars.slice(start, i);
    if (slice.length >= minBars) {
      const profile = profileWithValueArea(slice, periodBins(slice.length));
      if (profile)
        out.push({
          t0: slice[0].time,
          t1: slice[slice.length - 1].time,
          profile,
          startIdx: start,
          endIdx: i - 1,
          label: periodLabel(slice[0].time, mode, opts.dayOf),
        });
    }
    start = i;
  }
  return out;
}

/** Rows for one period's profile: fine enough for a busy day, not empty buckets for a quiet one. */
export function periodBins(barCount: number): number {
  return Math.max(24, Math.min(72, barCount * 2));
}

const DAY_MS = 86_400_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20 Oct" of a date held as UTC ms of its midnight. */
function dayMonth(dateMs: number): string {
  const d = new Date(dateMs);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/**
 * What a period is called on the chart: its trading DATE for a session ("Mon 20 Oct" — an FX session
 * opening Sunday 17:00 New York is Monday's), the Monday of its week, its month.
 */
export function periodLabel(time: number, mode: PeriodMode, dayOf?: DayOf): string {
  const date = dayOf ? Math.floor(dayOf(time) / DAY_MS) * DAY_MS : Math.floor(time / DAY_MS) * DAY_MS;
  const d = new Date(date);
  if (mode === 'month') return `${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (mode === 'week') {
    const back = (d.getUTCDay() + 6) % 7; // Monday = 0
    return `wk ${dayMonth(date - back * DAY_MS)}`;
  }
  return `${WEEKDAY[d.getUTCDay()]} ${dayMonth(date)}`;
}

/**
 * One profile per Asia, London and New York session (PR-1): the bars inside each session's window
 * on its own clock (`SESSION_WINDOWS`, the Sessions indicator's and the session profile study's
 * hours — not new ones), in time order. The windows overlap (London and New York share four hours),
 * so a bar can be in two sessions' profiles: that is what the sessions are.
 */
function namedSessionProfiles(bars: readonly Ohlc[], minBars: number): PeriodProfile[] {
  const out: PeriodProfile[] = [];
  for (const session of ['asia', 'london', 'newyork'] as const) {
    const window = SESSION_WINDOWS[session];
    let i = 0;
    while (i < bars.length) {
      const key = sessionStartOf(bars[i].time, session);
      if (key === null) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < bars.length && sessionStartOf(bars[j + 1].time, session) === key) j++;
      if (j - i + 1 >= minBars) {
        const slice = bars.slice(i, j + 1);
        const profile = profileWithValueArea(slice, periodBins(slice.length));
        const localDay = sessionDayOf(bars[i].time, window);
        if (profile && localDay !== null)
          out.push({
            t0: bars[i].time,
            t1: bars[j].time,
            profile,
            startIdx: i,
            endIdx: j,
            label: `${NAMED_SESSION_LABEL[session]} ${dayMonth(localDay)}`,
            session,
          });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
}

/**
 * Why `sessions` mode draws nothing on these bars, or null when it can: a session is nine hours, so
 * bars coarser than an hour leave two or three per session — not a distribution.
 */
export function sessionProfileNotice(barIntervalMs: number): string | null {
  return barIntervalMs > 3_600_000
    ? 'Session profiles need 1h bars or finer — a 9-hour session is two or three bars here.'
    : null;
}

// ── Support and resistance ───────────────────────────────────────────────────

export interface SrLevel {
  price: number;
  /** Relative to the latest close. A level price has crossed becomes the other kind. */
  kind: 'support' | 'resistance';
  /** How many swing pivots formed this level. */
  touches: number;
  /** 0..1, combining touch count and recency. Drives line weight. */
  strength: number;
  /** Time of the most recent touch. */
  lastMs: number;
}

export interface SrOptions {
  /** Half-width of the fractal window: a pivot is the extreme of `2*lookback+1` bars. */
  lookback?: number;
  /** Cluster tolerance as a multiple of ATR. */
  toleranceAtr?: number;
  /** Most levels to return, across both sides. */
  max?: number;
  /** Ignore levels formed by fewer than this many pivots. */
  minTouches?: number;
  /**
   * Minimum gap between REPORTED levels, as a multiple of ATR.
   *
   * <p>Separate from `toleranceAtr`, which decides what counts as one cluster. Without it
   * the output was four levels inside twenty pips — 1.15457, 1.15353, 1.15311, 1.15255 on
   * live EURUSD — which is chop rendered as structure. Each is a real cluster; reporting
   * all four is still wrong.</p>
   */
  separationAtr?: number;
}

/**
 * Support and resistance from swing pivots.
 *
 * <p>Three steps, each deliberately simple enough to argue with:</p>
 * <ol>
 *   <li>Find fractal pivots — a bar whose high is the highest of the `2*lookback+1` bars
 *       centred on it, and the same for lows.</li>
 *   <li>Cluster pivots that sit within `toleranceAtr × ATR` of each other. A tolerance in
 *       ATR rather than pips is what makes the same settings work on EURUSD and on a pair
 *       that moves five times as far.</li>
 *   <li>Score by touches and recency, and keep the strongest.</li>
 * </ol>
 *
 * <p>A pivot is only knowable `lookback` bars after it forms — that is inherent, not a bug,
 * and it is why the most recent bars never produce a level.</p>
 */
export function supportResistance(bars: readonly Ohlc[], opts: SrOptions = {}): SrLevel[] {
  const lookback = opts.lookback ?? 3;
  const toleranceAtr = opts.toleranceAtr ?? 0.5;
  const max = opts.max ?? 8;
  const minTouches = opts.minTouches ?? 2;

  if (bars.length < lookback * 2 + 3) return [];

  const atrSeries = atr(bars as Ohlc[], 14);
  const lastAtr = [...atrSeries].reverse().find((v) => v !== null && v > 0) ?? null;
  // Without a usable ATR there is no scale to cluster on, and a fixed tolerance would be
  // meaningless across instruments. Say nothing rather than guess.
  if (lastAtr === null) return [];
  const tolerance = lastAtr * toleranceAtr;
  if (tolerance <= 0) return [];

  const pivots: { price: number; time: number }[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) isHigh = false;
      if (bars[k].low <= bars[i].low) isLow = false;
    }
    if (isHigh) pivots.push({ price: bars[i].high, time: bars[i].time });
    if (isLow) pivots.push({ price: bars[i].low, time: bars[i].time });
  }
  if (pivots.length === 0) return [];

  // Cluster by price. Sorting first makes this one pass instead of N².
  //
  // A pivot joins only if the cluster's TOTAL span stays within the tolerance — measured
  // against the cluster's lowest member, not against the last one added. Chaining off the
  // last member lets a dense region merge into one enormous cluster whose width is
  // unbounded: on 1500 EURUSD hourly bars that produced "levels" with 94 touches spanning
  // far more than the tolerance, which is not a level at all, it is the busiest half of the
  // range wearing a price tag.
  pivots.sort((a, b) => a.price - b.price);
  const clusters: { prices: number[]; lastMs: number }[] = [];
  for (const pivot of pivots) {
    const current = clusters[clusters.length - 1];
    if (current && pivot.price - current.prices[0] <= tolerance) {
      current.prices.push(pivot.price);
      current.lastMs = Math.max(current.lastMs, pivot.time);
    } else {
      clusters.push({ prices: [pivot.price], lastMs: pivot.time });
    }
  }

  const firstMs = bars[0].time;
  const lastMs = bars[bars.length - 1].time;
  const span = Math.max(1, lastMs - firstMs);
  const close = bars[bars.length - 1].close;
  const maxTouches = Math.max(...clusters.map((c) => c.prices.length));

  const scored: SrLevel[] = clusters
    .filter((c) => c.prices.length >= minTouches)
    .map((c) => {
      const price = c.prices.reduce((s, p) => s + p, 0) / c.prices.length;
      const recency = (c.lastMs - firstMs) / span;
      // Touches carry more weight than recency: a level tested five times last month is
      // more real than one touched twice yesterday.
      const strength = Math.min(1, (c.prices.length / maxTouches) * 0.7 + recency * 0.3);
      return {
        price,
        kind: price >= close ? ('resistance' as const) : ('support' as const),
        touches: c.prices.length,
        strength,
        lastMs: c.lastMs,
      };
    })
    .sort((a, b) => b.strength - a.strength);

  const separation = lastAtr * (opts.separationAtr ?? 1.5);

  /** Strongest first, skipping anything too close to a level already taken. */
  const pick = (from: SrLevel[], limit: number, taken: SrLevel[]): SrLevel[] => {
    const out: SrLevel[] = [];
    for (const level of from) {
      if (out.length >= limit) break;
      const clash = [...taken, ...out].some((k) => Math.abs(k.price - level.price) < separation);
      if (!clash) out.push(level);
    }
    return out;
  };

  // Balanced: an S/R overlay showing seven resistances and no support is not telling the
  // operator where price might hold. Take the best of each side, then let the stronger side
  // use whatever the weaker one could not fill.
  const half = Math.max(1, Math.floor(max / 2));
  const above = scored.filter((l) => l.kind === 'resistance');
  const below = scored.filter((l) => l.kind === 'support');
  const resistances = pick(above, half, []);
  const supports = pick(below, half, resistances);
  const chosen = [...resistances, ...supports];
  if (chosen.length < max) {
    chosen.push(...pick(scored, max - chosen.length, chosen));
  }
  return chosen.sort((a, b) => b.price - a.price);
}

// ── Estimated order-flow delta ───────────────────────────────────────────────
//
// Lives in `indicators/math.ts` with the rest of the indicator maths — it is plotted as a
// study, not drawn on the price pane — and is re-exported here so the overlay surface has
// one import.
export { estimatedDelta, type DeltaBar } from '../indicators/math';
