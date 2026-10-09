import { Injectable, computed, inject, signal } from '@angular/core';
import type { ActiveIndicator, ChartStyle } from '../chart/chart-host.component';
import type { TvResolution } from '../datafeed/resolution';
import { ChartPrefsService } from './chart-prefs.service';

/** Pre-engine storage: layouts + templates in one record, and the last layout's id. */
export const LEGACY_LAYOUTS_KEY = 'lascodia.chart.layouts.v1';
export const LEGACY_LAST_KEY = 'lascodia.chart.lastLayout.v1';
/** Study templates — a synced chart preference. */
export const TEMPLATES_KEY = 'lascodia.chart.studyTemplates.v1';

/** A layout as browsers stored them before layouts moved to the engine (migration input only). */
export interface LegacyChartLayout {
  id: string;
  name: string;
  symbol: string;
  resolution: TvResolution;
  style: ChartStyle;
  showVolume: boolean;
  scaleMode: 'normal' | 'log' | 'percent';
  timezone: string;
  indicators: ActiveIndicator[];
  savedAt: number;
}

/** A reusable set of studies with no symbol attached — TradingView's templates. */
export interface StudyTemplate {
  id: string;
  name: string;
  indicators: ActiveIndicator[];
  savedAt: number;
}

/**
 * Study templates (a set of studies with no symbol or timeframe — "apply my template" must never
 * move the chart to another instrument). Kept as the synced chart preference
 * {@link TEMPLATES_KEY}, so they follow the operator across machines. Named layouts live in the
 * engine (`ChartWorkspaceSync`); {@link legacyLayouts} only feeds the one-time upload.
 */
@Injectable({ providedIn: 'root' })
export class ChartLayoutStore {
  private readonly prefs = inject(ChartPrefsService);
  private readonly state = signal<StudyTemplate[]>(this.read());

  readonly templates = computed(() => [...this.state()].sort((a, b) => b.savedAt - a.savedAt));

  /** Re-read after the engine's preferences were hydrated into the cache. */
  reload(): void {
    this.state.set(this.read());
    // Templates only an older build's record holds: give them to the synced key once.
    if (this.prefs.getItem(TEMPLATES_KEY) === null && this.state().length) this.write();
  }

  saveTemplate(name: string, indicators: ActiveIndicator[]): StudyTemplate {
    const trimmed = name.trim() || 'Untitled template';
    const existing = this.state().find((t) => t.name === trimmed);
    const template: StudyTemplate = {
      id: existing?.id ?? `t_${Date.now().toString(36)}`,
      name: trimmed,
      // Cloned so later edits to the live studies do not mutate the template.
      indicators: indicators.map((i) => ({ ...i, params: { ...i.params } })),
      savedAt: Date.now(),
    };
    this.state.update((s) => [...s.filter((t) => t.id !== template.id), template]);
    this.write();
    return template;
  }

  removeTemplate(id: string): void {
    this.state.update((s) => s.filter((t) => t.id !== id));
    this.write();
  }

  /**
   * Fresh instance ids when a template is applied.
   *
   * Without this, applying the same template twice produces two studies that
   * share a uid, and the chart treats the second as the first — so the series
   * are never created and the operator sees nothing happen.
   */
  instantiate(template: StudyTemplate): ActiveIndicator[] {
    return template.indicators.map((i, index) => ({
      ...i,
      params: { ...i.params },
      uid: `${i.defId}-${Date.now().toString(36)}-${index}`,
    }));
  }

  /** Layouts this browser saved before they moved to the engine, and the one last opened. */
  legacyLayouts(): { layouts: LegacyChartLayout[]; lastId: string | null } {
    try {
      const raw = localStorage.getItem(LEGACY_LAYOUTS_KEY);
      const parsed = raw ? (JSON.parse(raw) as { layouts?: LegacyChartLayout[] }) : {};
      return {
        layouts: Array.isArray(parsed.layouts) ? parsed.layouts : [],
        lastId: localStorage.getItem(LEGACY_LAST_KEY),
      };
    } catch {
      return { layouts: [], lastId: null };
    }
  }

  /** After the upload succeeded: the engine owns them now. */
  clearLegacyLayouts(): void {
    try {
      localStorage.removeItem(LEGACY_LAYOUTS_KEY);
      localStorage.removeItem(LEGACY_LAST_KEY);
    } catch {
      /* ignore */
    }
  }

  private write(): void {
    this.prefs.setItem(TEMPLATES_KEY, JSON.stringify(this.state()));
  }

  private read(): StudyTemplate[] {
    try {
      const raw = this.prefs.getItem(TEMPLATES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as StudyTemplate[]) : [];
      }
      // Older builds kept templates beside the layouts.
      const legacy = localStorage.getItem(LEGACY_LAYOUTS_KEY);
      const old = legacy ? (JSON.parse(legacy) as { templates?: StudyTemplate[] }) : {};
      return Array.isArray(old.templates) ? old.templates : [];
    } catch {
      return [];
    }
  }
}

/**
 * The browser's own time zone, as a saved choice: resolved on each machine when the chart draws
 * ({@link resolveTimezone}), so a layout opened elsewhere shows that browser's clock rather than the
 * zone of whichever machine saved it.
 */
export const BROWSER_TIMEZONE = 'browser';

/**
 * The broker server's clock. The candle-source broker is an EU-DST EET server — UTC+2 in winter and
 * UTC+3 in summer, switching on the EU dates (engine candle repair of 2026-09-30) — which is the clock
 * MT5 prints its bars and deals in. `Europe/Athens` keeps exactly those rules.
 */
export const BROKER_SERVER_TIMEZONE = 'Europe/Athens';

/**
 * Time zones offered for the time axis.
 *
 * Deliberately short and trading-relevant rather than the full IANA list: the
 * question an operator actually asks is "what time was this in London / New
 * York / at the broker", not "what is this in Kiritimati".
 */
export const CHART_TIMEZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'UTC', label: 'UTC' },
  { id: BROWSER_TIMEZONE, label: 'Browser local' },
  { id: BROKER_SERVER_TIMEZONE, label: 'Broker server (EET)' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Berlin', label: 'Frankfurt' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'America/Chicago', label: 'Chicago' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

/**
 * The IANA zone a chart time-zone choice stands for: {@link BROWSER_TIMEZONE} is this browser's zone
 * (UTC when the browser will not say); every other id is a zone already.
 */
export function resolveTimezone(id: string): string {
  if (id !== BROWSER_TIMEZONE) return id;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * One formatter per time zone. Building an `Intl.DateTimeFormat` costs about fifteen times as much as
 * using one (~55 µs against ~3.5 µs in Node), and the chart asks for an offset per bar on every
 * repaint and per trading day when it counts sessions.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timezone, formatter);
  }
  return formatter;
}

const HOUR_MS = 3_600_000;
/** UTC hours a zone's cache remembers before it starts again (~5.7 years of hours). */
const OFFSET_CACHE_LIMIT = 50_000;
/** Each zone's offset per UTC hour; NaN marks an hour in which the zone changes its clock. */
const offsetsByHour = new Map<string, Map<number, number>>();

/**
 * Offset in minutes between UTC and `timezone` at `atMs` ({@link BROWSER_TIMEZONE} is this browser's
 * zone).
 *
 * Computed from `Intl` at the given instant rather than from a fixed table,
 * because the offset changes with DST — a chart that hardcodes London at UTC+0
 * is an hour wrong for seven months of the year.
 *
 * <p>Remembered per zone and UTC hour: the chart shifts every bar it plots by its own instant's
 * offset, and asking `Intl` for each one cost a `formatToParts` per bar on every tick. An hour is
 * remembered only when its first and last millisecond agree; an hour in which the zone changes its
 * clock (a DST switch, wherever in the hour it falls — some zones switch on the half hour) is worked
 * out per instant every time.</p>
 */
export function timezoneOffsetMinutes(timezone: string, atMs: number): number {
  const zone = resolveTimezone(timezone);
  if (zone === 'UTC') return 0;
  if (!Number.isFinite(atMs)) return exactOffsetMinutes(zone, atMs);
  const hour = Math.floor(atMs / HOUR_MS);
  let hours = offsetsByHour.get(zone);
  if (!hours) {
    hours = new Map();
    offsetsByHour.set(zone, hours);
  }
  let offset = hours.get(hour);
  if (offset === undefined) {
    const start = exactOffsetMinutes(zone, hour * HOUR_MS);
    const end = exactOffsetMinutes(zone, (hour + 1) * HOUR_MS - 1);
    offset = start === end ? start : Number.NaN;
    if (hours.size >= OFFSET_CACHE_LIMIT) hours.clear();
    hours.set(hour, offset);
  }
  return Number.isNaN(offset) ? exactOffsetMinutes(zone, atMs) : offset;
}

/**
 * Midnight of a calendar date (`month` 0-based) on a chart time zone's clock, as a UTC instant (ms):
 * what "go to 9 Oct" means on a New York axis. The offset is read at that midnight — twice, so a day
 * whose clock changes lands on its own midnight.
 */
export function midnightOnClock(year: number, month: number, day: number, zone: string): number {
  const asUtc = Date.UTC(year, month, day);
  const first = asUtc - timezoneOffsetMinutes(zone, asUtc) * 60_000;
  return asUtc - timezoneOffsetMinutes(zone, first) * 60_000;
}

/** {@link timezoneOffsetMinutes} straight from `Intl`, at exactly `atMs`. */
function exactOffsetMinutes(timezone: string, atMs: number): number {
  if (timezone === 'UTC') return 0;
  try {
    const parts = zoneFormatter(timezone).formatToParts(new Date(atMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      // Some engines print midnight as "24" under hour12: false; it is hour 0 of the same date.
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - atMs) / 60000);
  } catch {
    return 0;
  }
}
