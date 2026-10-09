/**
 * Trading sessions on their own clocks (DR-18): Tokyo, London and New York open at a local time in their own time
 * zone, so their UTC hours move twice a year with daylight saving — the Sessions indicator kept fixed UTC hours, and
 * read them off bars already shifted into the chart's display zone (changing the axis zone moved the sessions).
 * Here a session is a local window in a named zone, tested on a bar's REAL (UTC) instant.
 *
 * The windows are the conventional FX sessions, 08:00–17:00 local (Tokyo 09:00–18:00), Monday to Friday — the same
 * definition as the watchlist's session column (`watchlist-columns.ts` FX_SESSIONS) and the session profiles.
 *
 * Pure apart from the time-zone offsets (`Intl`, cached per hour); unit-tested directly.
 */
import { timezoneOffsetMinutes } from '../workspace/layout-store.service';
import type { Maybe, Ohlc } from './math';

export interface SessionWindow {
  /** Local open, `HHMM`. */
  start: string;
  /** Local close, `HHMM` (exclusive). Before `start`: an overnight session. */
  end: string;
  /** IANA time zone of the local clock. */
  zone: string;
  /** Trading days on the local calendar, Pine digits (1 = Sunday … 7 = Saturday). Default Monday–Friday. */
  days?: string;
}

export const SESSION_WINDOWS: Readonly<Record<'asia' | 'london' | 'newyork', SessionWindow>> = {
  asia: { start: '0900', end: '1800', zone: 'Asia/Tokyo' },
  london: { start: '0800', end: '1700', zone: 'Europe/London' },
  newyork: { start: '0800', end: '1700', zone: 'America/New_York' },
};

/** Zones a session can be set in (the settings' choices). */
export const SESSION_ZONES: readonly string[] = [
  'Asia/Tokyo',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Zurich',
  'America/New_York',
  'America/Chicago',
  'Etc/UTC',
];

const MIN = 60_000;
const DAY = 86_400_000;

/** `HHMM` → minutes after midnight; NaN when it is not a time. */
export function minutesOfDay(hhmm: string): number {
  const m = /^(\d{2}):?(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 24 && mm < 60 ? h * 60 + mm : Number.NaN;
}

/** A `HHMM-HHMM` session string → its window in `zone`; null when malformed. */
export function parseSessionWindow(text: string, zone: string): SessionWindow | null {
  const m = /^\s*(\d{2}:?\d{2})\s*-\s*(\d{2}:?\d{2})\s*$/.exec(String(text));
  if (!m) return null;
  if (Number.isNaN(minutesOfDay(m[1])) || Number.isNaN(minutesOfDay(m[2]))) return null;
  return { start: m[1].replace(':', ''), end: m[2].replace(':', ''), zone };
}

/**
 * The session (by its local opening day, UTC ms of that local date) that `utcMs` falls in, or null outside it. An
 * overnight session belongs to the day it opened.
 */
export function sessionDayOf(utcMs: number, w: SessionWindow): number | null {
  const start = minutesOfDay(w.start);
  const end = minutesOfDay(w.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const local = utcMs + timezoneOffsetMinutes(w.zone, utcMs) * MIN;
  const day = Math.floor(local / DAY) * DAY;
  const m = (local - day) / MIN;
  const days = w.days ?? '23456';
  const trades = (d: number) => days.includes(String(new Date(d).getUTCDay() + 1));
  if (start < end) return m >= start && m < end && trades(day) ? day : null;
  if (m >= start) return trades(day) ? day : null;
  if (m < end) return trades(day - DAY) ? day - DAY : null;
  return null;
}

/**
 * The running high and low of each occurrence of a session, null outside it (so separate sessions are not joined).
 * `utcTimes[i]` is bar i's real instant — the chart passes its bars shifted into the display zone.
 */
export function sessionHighLow(
  bars: readonly Ohlc[],
  w: SessionWindow,
  utcTimes?: readonly number[],
): { high: Maybe[]; low: Maybe[] } {
  const n = bars.length;
  const high: Maybe[] = new Array<Maybe>(n).fill(null);
  const low: Maybe[] = new Array<Maybe>(n).fill(null);
  let hh = -Infinity;
  let ll = Infinity;
  let current: number | null = null;
  for (let i = 0; i < n; i++) {
    const day = sessionDayOf(utcTimes?.[i] ?? bars[i].time, w);
    if (day === null) {
      current = null;
      continue;
    }
    if (day !== current) {
      current = day;
      hh = -Infinity;
      ll = Infinity;
    }
    hh = Math.max(hh, bars[i].high);
    ll = Math.min(ll, bars[i].low);
    high[i] = hh;
    low[i] = ll;
  }
  return { high, low };
}
