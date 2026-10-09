import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';
import type { EconomicEventDto } from '@core/api/api.types';

/**
 * Economic events on the chart's time axis (CC-07, CC-I2, SP-08) — the pure half: what to fetch,
 * how scroll-back extends it, the Tier-1 blackout bands, the hover card's words. The renderer draws
 * them; the page fetches them (`chart-events.service.ts`).
 */

export type EventImpact = 'High' | 'Medium' | 'Low';

/** An event on the chart. `time` is its UTC instant; the chart places it on the display clock. */
export interface EventMark {
  id: number;
  time: number;
  title: string;
  currency: string;
  impact: EventImpact;
  /** The row as the calendar modal shows it (click → `EconomicEventModal`). */
  event: UpcomingEconomicEvent;
}

/** An events-list row as the engine sends it since C3 (the reading fields are new). */
export type EconomicEventRow = EconomicEventDto & {
  forecastProvenance?: string | null;
  polarity?: string | null;
  result?: 'Beat' | 'Miss' | 'Inline' | null;
};

const DAY = 86_400_000;
/** How far ahead the chart asks for upcoming events. */
export const EVENTS_AHEAD_MS = 14 * DAY;

/** The window the chart's events cover: the oldest bar on screen to two weeks ahead. */
export function eventsWindow(
  oldestBarMs: number | null,
  nowMs: number,
): { from: number; to: number } {
  return { from: oldestBarMs ?? nowMs - 45 * DAY, to: nowMs + EVENTS_AHEAD_MS };
}

/**
 * What scroll-back still needs: the span of `wanted` that `held` (the window already fetched) does
 * not cover on the left, or null when it is covered. Events only ever extend backwards — the right
 * end is "two weeks from now" and is refreshed with a full reload.
 */
export function missingOnTheLeft(
  held: { from: number; to: number } | null,
  wanted: { from: number; to: number },
): { from: number; to: number } | null {
  if (!held) return wanted;
  return wanted.from < held.from ? { from: wanted.from, to: held.from - 1 } : null;
}

/** A list row as a chart mark; null when it cannot be placed (no readable time). */
export function markOf(row: EconomicEventRow): EventMark | null {
  const time = Date.parse(row.scheduledAt ?? '');
  if (!Number.isFinite(time)) return null;
  const impact = String(row.impact);
  const level: EventImpact = impact === 'High' ? 'High' : impact === 'Medium' ? 'Medium' : 'Low';
  const currency = (row.currency ?? '').toUpperCase();
  return {
    id: row.id,
    time,
    title: row.title ?? '',
    currency,
    impact: level,
    event: {
      id: row.id,
      title: row.title ?? '',
      currency,
      impact: impact as UpcomingEconomicEvent['impact'],
      scheduledAt: row.scheduledAt,
      forecast: row.forecast ?? null,
      previous: row.previous ?? null,
      actual: row.actual ?? null,
      forecastProvenance: row.forecastProvenance ?? 'Unknown',
      polarity: row.polarity ?? undefined,
      result: row.result ?? null,
    },
  };
}

/** Marks merged by id (the newer copy wins: an actual may have landed), in time order. */
export function mergeMarks(
  held: readonly EventMark[],
  incoming: readonly EventMark[],
): EventMark[] {
  const byId = new Map<number, EventMark>();
  for (const m of held) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.time - b.time || a.id - b.id);
}

/** The high-impact news blackout as live applies it (`GET economic-event/news-blackout`). */
export interface BlackoutWindow {
  active: boolean;
  minutesBefore: number;
  minutesAfter: number;
  explanation?: string;
}

/**
 * The spans live refuses new entries in around Tier-1 events — `[event − before, event + after]`
 * for every High event of the pair's currencies (`NewsBlackoutRules`: the symbol's base and quote)
 * — merged where they overlap. UTC ms. Empty when the blackout is off.
 */
export function blackoutBands(
  marks: readonly EventMark[],
  window: BlackoutWindow | null,
  currencies: readonly string[],
): { from: number; to: number }[] {
  if (!window?.active || (window.minutesBefore <= 0 && window.minutesAfter <= 0)) return [];
  const wanted = new Set(currencies.map((c) => c.toUpperCase()));
  const spans = marks
    .filter((m) => m.impact === 'High' && (wanted.size === 0 || wanted.has(m.currency)))
    .map((m) => ({
      from: m.time - Math.max(0, window.minutesBefore) * 60_000,
      to: m.time + Math.max(0, window.minutesAfter) * 60_000,
    }))
    .sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** "in 3h 05m", "in 2d 4h", "in 12m"; "now" within the minute; null once it is past. */
export function eventCountdown(nowMs: number, eventMs: number): string | null {
  const ms = eventMs - nowMs;
  if (ms < -60_000) return null;
  if (ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${String(mins).padStart(2, '0')}m`;
  return `in ${mins}m`;
}

/** The hover card's lines for an event (CC-I2): what, when, and the numbers. */
export interface EventCard {
  title: string;
  currency: string;
  impact: EventImpact;
  when: string;
  rows: { label: string; value: string }[];
  /** How the actual compared, for the currency (engine-read), or null. */
  surprise: string | null;
}

/**
 * The card's content. `when` is the event's time on the chart's clock (formatted by the caller).
 * "Surprise" is the engine's reading: whether the actual beat or missed the forecast FOR THE
 * CURRENCY (a lower unemployment rate is a beat) — never a guess from the numbers here.
 */
export function eventCard(mark: EventMark, when: string, nowMs: number): EventCard {
  const e = mark.event;
  const rows: { label: string; value: string }[] = [];
  const countdown = eventCountdown(nowMs, mark.time);
  if (countdown && countdown !== 'now' && mark.time > nowMs)
    rows.push({ label: 'Due', value: countdown });
  rows.push({ label: 'Actual', value: e.actual ?? '—' });
  rows.push({ label: 'Forecast', value: e.forecast ?? '—' });
  rows.push({ label: 'Previous', value: e.previous ?? '—' });
  const surprise =
    e.result === 'Beat'
      ? `Beat — better than forecast for ${mark.currency}`
      : e.result === 'Miss'
        ? `Miss — worse than forecast for ${mark.currency}`
        : e.result === 'Inline'
          ? 'In line with the forecast'
          : null;
  return { title: mark.title, currency: mark.currency, impact: mark.impact, when, rows, surprise };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An event's time on the chart's clock: "Fri 9 Oct 12:30 UTC−4" — the zone's offset at that instant
 * (`offsetMinutes`), so the card says which clock it is on.
 */
export function formatEventTime(utcMs: number, offsetMinutes: number): string {
  const d = new Date(utcMs + offsetMinutes * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const abs = Math.abs(offsetMinutes);
  const zone =
    offsetMinutes === 0
      ? 'UTC'
      : `UTC${offsetMinutes > 0 ? '+' : '−'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} ${zone}`;
}

/** The mark whose flag is under `x` (within `tolerance` px), nearest first; null when none. */
export function markNear<T extends { x: number }>(
  placed: readonly T[],
  x: number,
  tolerance = 6,
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const p of placed) {
    const d = Math.abs(p.x - x);
    if (d <= tolerance && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Whether an event passes the chart's minimum importance. */
export function passesImpact(impact: EventImpact, min: EventImpact): boolean {
  const rank: Record<EventImpact, number> = { Low: 0, Medium: 1, High: 2 };
  return rank[impact] >= rank[min];
}
