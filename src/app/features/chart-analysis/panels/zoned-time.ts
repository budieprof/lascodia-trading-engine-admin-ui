import { Pipe, type PipeTransform } from '@angular/core';

import { timezoneOffsetMinutes } from '../workspace/layout-store.service';

/**
 * Times in the CHART's time zone (SP-09). The calendar and news panes formatted every time in the browser's own
 * zone while the chart's axis used the chart zone, so a 12:30 New York release read 17:30 beside an axis that put it
 * at 12:30. Angular's DatePipe takes a UTC offset, not an IANA zone (and one offset is wrong across a DST change), so
 * the offset is resolved per instant with the same `timezoneOffsetMinutes` the chart uses. A null / empty zone means
 * the browser's own zone (the old behaviour).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface ZonedParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

export function zonedParts(ms: number, zone: string | null | undefined): ZonedParts {
  if (!zone) {
    const d = new Date(ms);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      weekday: d.getDay(),
    };
  }
  const shifted = new Date(ms + timezoneOffsetMinutes(zone, ms) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `yyyy-mm-dd` of the instant's day in the zone (for grouping by day). */
export function zonedDayKey(ms: number, zone: string | null | undefined): string {
  const p = zonedParts(ms, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export type ZonedFormat = 'time' | 'day' | 'dateTime';

/** `HH:mm`, `Fri 9 Oct` or `Oct 9 HH:mm` in the zone; '' for an unparseable input. */
export function formatZoned(
  value: string | number | null | undefined,
  zone: string | null | undefined,
  format: ZonedFormat,
): string {
  const ms = typeof value === 'number' ? value : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  const p = zonedParts(ms, zone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  switch (format) {
    case 'time':
      return time;
    case 'day':
      return `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
    case 'dateTime':
      return `${MONTHS[p.month - 1]} ${p.day} ${time}`;
  }
}

/** A short name for the zone, for headings: "New York", "UTC", or "your time" for the browser's own. */
export function zoneLabel(zone: string | null | undefined): string {
  if (!zone) return 'your time';
  if (zone === 'UTC') return 'UTC';
  const city = zone.split('/').pop() ?? zone;
  return city.replace(/_/g, ' ');
}

/** `{{ iso | zonedDate: timezone() : 'time' }}` — see {@link formatZoned}. Pure: the zone is an argument. */
@Pipe({ name: 'zonedDate', standalone: true })
export class ZonedDatePipe implements PipeTransform {
  transform(
    value: string | number | null | undefined,
    zone: string | null | undefined,
    format: ZonedFormat = 'dateTime',
  ): string {
    return formatZoned(value, zone, format);
  }
}
