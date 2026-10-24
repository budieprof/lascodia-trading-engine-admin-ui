import type { CalendarSessionDto, TradingCalendarDto } from './instrument.types';

/**
 * A trading calendar (`GET calendars/{code}`) as the Pine session string + IANA zone the chart's day-based studies
 * already speak (`features/chart-analysis/datafeed/session-calendar.ts` `SessionSpec`; Pine day digits 1 = Sunday).
 *
 * `fx-24x5` (Sunday 17:00 → Friday 17:00 New York, sessions opening Sun…Thu at 17:00 and closing at 17:00 the next day)
 * becomes `1700-1700:23456` in `America/New_York` — exactly what `scripting/chart-bars` reports for FX today, so FX
 * charts are unchanged. A 24/7 calendar is `0000-0000:1234567`.
 *
 * Only the most common Regular hours are expressible in one Pine session string; a calendar whose regular hours differ
 * by weekday keeps the most frequent hours (all its trading days still count). Pre/Post/Maintenance sessions are not
 * trading-day boundaries and are ignored here.
 */
export interface CalendarSessionSpec {
  session: string;
  timeZone: string;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** `Sunday` / `sun` / 0 … → 0 … 6; null when unreadable. */
export function weekdayIndex(day: string | number | null | undefined): number | null {
  if (typeof day === 'number') return Number.isInteger(day) && day >= 0 && day <= 6 ? day : null;
  const d = (day ?? '').toString().trim().toLowerCase();
  if (/^\d$/.test(d)) return weekdayIndex(Number(d));
  const i = DAY_NAMES.findIndex((n) => n === d || n.slice(0, 3) === d);
  return i >= 0 ? i : null;
}

/** `HH:mm[:ss]` → minutes after midnight; null when unreadable. */
export function clockMinutes(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 24 && min >= 0 && min < 60 ? (h % 24) * 60 + min : null;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

export function pineSessionFromCalendar(
  cal: TradingCalendarDto | null | undefined,
): CalendarSessionSpec | null {
  if (!cal) return null;
  const timeZone = (cal.timeZone ?? '').trim() || 'Etc/UTC';
  if (cal.is24x7) return { session: '0000-0000:1234567', timeZone };
  const all = (cal.sessions ?? []) as CalendarSessionDto[];
  const regular = all.filter((s) => (s.kind ?? 'Regular') === 'Regular');
  const rows = (regular.length ? regular : all)
    .map((s) => ({
      day: weekdayIndex(s.day),
      open: clockMinutes(s.open),
      close: clockMinutes(s.close),
    }))
    .filter(
      (s): s is { day: number; open: number; close: number } =>
        s.day !== null && s.open !== null && s.close !== null,
    );
  if (!rows.length) return null;

  // The most frequent hours (first seen on a tie).
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(`${r.open}-${r.close}`, (counts.get(`${r.open}-${r.close}`) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  const [open, close] = best.split('-').map(Number);

  // Pine dates an overnight session by the day it CLOSES on.
  const digits = new Set<number>();
  for (const r of rows) {
    const rOvernight = r.open > r.close || (r.open === r.close && r.open !== 0);
    const closeDay = rOvernight ? (r.day + 1) % 7 : r.day;
    digits.add(closeDay + 1);
  }
  const days = [...digits].sort((a, b) => a - b).join('');
  return { session: `${hhmm(open)}-${hhmm(close)}:${days}`, timeZone };
}
