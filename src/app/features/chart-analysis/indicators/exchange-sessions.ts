import type { TradingCalendarDto } from '@core/instruments/instrument.types';
import type { Maybe, Ohlc } from './math';
import { sessionDayOf, type SessionWindow } from './sessions';

/**
 * An instrument's own sessions, from the engine's trading calendar (UA02): NYSE pre-market 04:00–09:30, regular
 * 09:30–16:00, post-market 16:00–20:00 New York; Eurex extended 01:10–08:00 and regular 08:00–22:00 Berlin; CME Globex
 * 17:00–16:00 Chicago (its one Regular session — the engine's calendar has no separate pit hours); crypto 24/7 (no
 * sessions to split). The FX Tokyo / London / New York windows stay in the Sessions study; these are the exchange's.
 *
 * Each calendar row is a session that OPENS on its weekday; rows with the same kind and hours merge into one window with
 * those weekdays (Pine day digits, 1 = Sunday). Holidays and early closes are the engine's C1 closures and are not
 * re-derived here. Pure.
 */

export type ExchangeSessionKind = 'Pre' | 'Regular' | 'Post';

export interface ExchangeSessions {
  code: string;
  zone: string;
  is24x7: boolean;
  windows: Record<ExchangeSessionKind, SessionWindow[]>;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function dayDigit(day: string | number): string | null {
  const n = typeof day === 'number' ? day : DAY_NAMES.indexOf(String(day).trim().toLowerCase());
  return n >= 0 && n <= 6 ? String(n + 1) : null;
}

const hhmm = (t: string): string => String(t).replace(':', '').padStart(4, '0').slice(0, 4);

/** The calendar's Pre / Regular / Post windows (maintenance breaks are not sessions). */
export function exchangeSessionsOf(cal: TradingCalendarDto): ExchangeSessions {
  const windows: Record<ExchangeSessionKind, SessionWindow[]> = { Pre: [], Regular: [], Post: [] };
  const byKey = new Map<string, SessionWindow>();
  for (const s of cal.sessions ?? []) {
    if (s.kind !== 'Pre' && s.kind !== 'Regular' && s.kind !== 'Post') continue;
    const digit = dayDigit(s.day);
    if (!digit) continue;
    const start = hhmm(s.open);
    const end = hhmm(s.close);
    const key = `${s.kind}|${start}|${end}`;
    let w = byKey.get(key);
    if (!w) {
      w = { start, end, zone: cal.timeZone, days: '' };
      byKey.set(key, w);
      windows[s.kind].push(w);
    }
    if (!w.days!.includes(digit)) w.days = [...w.days!, digit].sort().join('');
  }
  return { code: cal.code, zone: cal.timeZone, is24x7: !!cal.is24x7, windows };
}

/** The `Days` input's choices; `Auto` = the calendar's own trading days. */
export const SESSION_DAY_CHOICES = ['Auto', 'Mon–Fri', 'Every day', 'Sun–Thu', 'Mon–Sat'] as const;

/** A `Days` choice → Pine day digits; null = keep each window's own (Auto / unknown). */
export function dayDigitsOf(choice: string | number | undefined): string | null {
  switch (choice) {
    case 'Mon–Fri':
      return '23456';
    case 'Every day':
      return '1234567';
    case 'Sun–Thu':
      return '12345';
    case 'Mon–Sat':
      return '234567';
    default:
      return null;
  }
}

/**
 * The running high and low of each occurrence of a session KIND (one per local opening day), null outside it — the
 * same rule as the FX Sessions study (`sessionHighLow`), over every window of that kind, restricted to `days` when set.
 */
export function kindHighLow(
  bars: readonly Ohlc[],
  windows: readonly SessionWindow[],
  utcTimes?: readonly number[],
  days?: string | null,
): { high: Maybe[]; low: Maybe[] } {
  const n = bars.length;
  const high: Maybe[] = new Array<Maybe>(n).fill(null);
  const low: Maybe[] = new Array<Maybe>(n).fill(null);
  if (!windows.length) return { high, low };
  const ws = windows.map((w) =>
    days ? { ...w, days: [...(w.days ?? '23456')].filter((d) => days.includes(d)).join('') } : w,
  );
  let hh = -Infinity;
  let ll = Infinity;
  let current: number | null = null;
  for (let i = 0; i < n; i++) {
    const t = utcTimes?.[i] ?? bars[i].time;
    let day: number | null = null;
    for (const w of ws) {
      if (!w.days) continue;
      day = sessionDayOf(t, w);
      if (day !== null) break;
    }
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

/** Why the Exchange-sessions study draws nothing for a symbol, or null when it can draw. */
export function exchangeSessionsNote(
  s: ExchangeSessions | null | undefined,
  symbol: string,
): string | null {
  const sym = symbol.toUpperCase();
  if (!s) return `No exchange calendar reported for ${sym} yet.`;
  if (s.is24x7)
    return `${sym} trades 24/7 (${s.code}): no exchange sessions. Use Sessions with Days "Every day".`;
  if (!s.windows.Regular.length && !s.windows.Pre.length && !s.windows.Post.length)
    return `The ${s.code} calendar has no sessions.`;
  return null;
}
