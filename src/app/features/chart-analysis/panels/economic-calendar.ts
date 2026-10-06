import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';

/** Country flag per currency (EUR → the EU flag); the code alone when unknown. */
const FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  CHF: '🇨🇭',
  CAD: '🇨🇦',
  AUD: '🇦🇺',
  NZD: '🇳🇿',
  CNY: '🇨🇳',
  NGN: '🇳🇬',
  ZAR: '🇿🇦',
  MXN: '🇲🇽',
  SEK: '🇸🇪',
  NOK: '🇳🇴',
  XAU: '🥇',
};

export function currencyFlag(ccy: string): string {
  return FLAGS[ccy.toUpperCase()] ?? '';
}

/** Importance as filled dots out of three. */
export function impactDots(impact: string): number {
  const i = impact.toLowerCase();
  return i === 'high' ? 3 : i === 'medium' ? 2 : 1;
}

export interface CalendarDay {
  /** Local calendar day, `yyyy-mm-dd`. */
  key: string;
  /** First event's time, for the day heading. */
  dayMs: number;
  events: UpcomingEconomicEvent[];
}

/** Events grouped by the viewer's local day, in time order. Pure. */
export function groupByDay(events: readonly UpcomingEconomicEvent[]): CalendarDay[] {
  const days: CalendarDay[] = [];
  const sorted = [...events].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  for (const e of sorted) {
    const ms = Date.parse(e.scheduledAt);
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const last = days[days.length - 1];
    if (last?.key === key) last.events.push(e);
    else days.push({ key, dayMs: ms, events: [e] });
  }
  return days;
}

/** Events within this long get a live countdown. */
export const SOON_MS = 4 * 3_600_000;

/**
 * The countdown shown beside a soon event: `in 1h 05m`, `in 12:34` under an hour, `due` once its
 * time has passed without an actual, null when it is not soon or already released. Pure.
 */
export function eventCountdown(
  e: Pick<UpcomingEconomicEvent, 'scheduledAt' | 'actual'>,
  nowMs: number,
): string | null {
  if (e.actual) return null;
  const left = Date.parse(e.scheduledAt) - nowMs;
  if (left <= 0) return left > -3_600_000 ? 'due' : null;
  if (left > SOON_MS) return null;
  const s = Math.ceil(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `in ${h}h ${String(m).padStart(2, '0')}m`
    : `in ${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
