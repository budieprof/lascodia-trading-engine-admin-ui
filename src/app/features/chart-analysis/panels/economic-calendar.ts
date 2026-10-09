import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';
import { zonedDayKey } from './zoned-time';

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
  /** Calendar day in the display zone, `yyyy-mm-dd`. */
  key: string;
  /** First event's time, for the day heading. */
  dayMs: number;
  events: UpcomingEconomicEvent[];
}

/**
 * Events grouped by day in `zone` — the chart's time zone (SP-09) — in time order; the viewer's own zone when no
 * zone is given. Pure.
 */
export function groupByDay(
  events: readonly UpcomingEconomicEvent[],
  zone?: string | null,
): CalendarDay[] {
  const days: CalendarDay[] = [];
  const sorted = [...events].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  for (const e of sorted) {
    const ms = Date.parse(e.scheduledAt);
    const key = zonedDayKey(ms, zone);
    const last = days[days.length - 1];
    if (last?.key === key) last.events.push(e);
    else days.push({ key, dayMs: ms, events: [e] });
  }
  return days;
}

/** A calendar figure as a number with its unit: `0.3%` → 0.3 `%`, `215K` → 215 `K`, `-1.2B` → −1.2 `B`. */
export function parseEventNumber(s: string | null | undefined): { value: number; unit: string } | null {
  // A comma is refused rather than guessed: "1,234" may be a thousands separator or a decimal one.
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*([%KMBT]?)\s*$/i.exec(s ?? '');
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? { value, unit: m[2].toUpperCase() } : null;
}

/**
 * Actual − forecast in the release's own unit (`+0.2%`, `−35K`), or null when either is missing or they are not the
 * same kind of number. Whether that is good for the currency is the engine's `result` (Beat / Miss), which knows the
 * figure's polarity — a higher unemployment rate is a miss.
 */
export function eventSurprise(
  e: Pick<UpcomingEconomicEvent, 'actual' | 'forecast'>,
): { value: number; text: string } | null {
  const a = parseEventNumber(e.actual);
  const f = parseEventNumber(e.forecast);
  if (!a || !f || a.unit !== f.unit) return null;
  const diff = Math.round((a.value - f.value) * 10_000) / 10_000;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
  return { value: diff, text: `${sign}${Math.abs(diff)}${a.unit}` };
}

/** "released 12 min ago" / "in 2h 05m" / "due now" / "in 3 days" — the card's status line. Pure. */
export function releaseStatus(
  e: Pick<UpcomingEconomicEvent, 'scheduledAt' | 'actual'>,
  nowMs: number,
): string {
  const at = Date.parse(e.scheduledAt);
  const left = at - nowMs;
  if (left > 0) {
    const mins = Math.ceil(left / 60_000);
    if (mins < 60) return `in ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `in ${hours}h ${String(mins % 60).padStart(2, '0')}m`;
    return `in ${Math.round(hours / 24)} days`;
  }
  const ago = Math.round(-left / 60_000);
  const agoText = ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`;
  return e.actual ? `released ${agoText}` : ago < 60 ? 'due now — no actual yet' : `no actual recorded (${agoText})`;
}

/**
 * Refresh every 30 s instead of 5 min while a release is imminent or just due without its actual — only while the
 * `economicEventActualRecorded` push is not reaching the pane (EV-1: it brings the actual the moment it is stored).
 */
export const FAST_REFRESH_MS = 30_000;
export const SLOW_REFRESH_MS = 300_000;

export function refreshInterval(
  events: readonly Pick<UpcomingEconomicEvent, 'scheduledAt' | 'actual'>[],
  nowMs: number,
  /** The push is connected: it delivers the actuals, the slow re-read is only the backstop. */
  pushLive = false,
): number {
  if (pushLive) return SLOW_REFRESH_MS;
  const hot = events.some((e) => {
    if (e.actual) return false;
    const at = Date.parse(e.scheduledAt);
    return at - nowMs <= 2 * 60_000 && nowMs - at <= 30 * 60_000;
  });
  return hot ? FAST_REFRESH_MS : SLOW_REFRESH_MS;
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

/** The engine's post-event grace: an event counts as having happened 2 minutes after its time. */
export const POST_EVENT_GRACE_MS = 2 * 60_000;

/** Whether the event has happened (by the clock, as the engine decides it). Pure. */
export function isEventPast(e: Pick<UpcomingEconomicEvent, 'scheduledAt'>, nowMs: number): boolean {
  return nowMs >= Date.parse(e.scheduledAt) + POST_EVENT_GRACE_MS;
}

/**
 * The pane's list with a pushed release (EV-1 `economicEventActualRecorded`) folded in: the row of the same id is
 * replaced; an event the pane does not list yet is added when it passes the pane's filter (its currencies — empty =
 * all — and its minimum importance); anything else leaves the list as it is (same array). Pure.
 */
export function upsertEvent(
  events: readonly UpcomingEconomicEvent[],
  pushed: UpcomingEconomicEvent,
  filter: { currencies: readonly string[]; minImpact: string },
): readonly UpcomingEconomicEvent[] {
  if (!pushed || typeof pushed.id !== 'number') return events;
  const i = events.findIndex((e) => e.id === pushed.id);
  if (i >= 0) {
    const next = [...events];
    next[i] = { ...events[i], ...pushed };
    return next;
  }
  const ccyOk = !filter.currencies.length || filter.currencies.some((c) => c.toUpperCase() === pushed.currency?.toUpperCase());
  const impactOk = impactDots(pushed.impact) >= impactDots(filter.minImpact);
  return ccyOk && impactOk ? [...events, pushed] : events;
}
