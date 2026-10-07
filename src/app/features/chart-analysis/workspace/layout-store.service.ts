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
 * Time zones offered for the time axis.
 *
 * Deliberately short and trading-relevant rather than the full IANA list: the
 * question an operator actually asks is "what time was this in London / New
 * York / at the broker", not "what is this in Kiritimati".
 */
export const CHART_TIMEZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'UTC', label: 'UTC' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Berlin', label: 'Frankfurt' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'America/Chicago', label: 'Chicago' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

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

/**
 * Offset in minutes between UTC and `timezone` at `atMs`.
 *
 * Computed from `Intl` at the given instant rather than from a fixed table,
 * because the offset changes with DST — a chart that hardcodes London at UTC+0
 * is an hour wrong for seven months of the year.
 */
export function timezoneOffsetMinutes(timezone: string, atMs: number): number {
  if (timezone === 'UTC') return 0;
  try {
    const parts = zoneFormatter(timezone).formatToParts(new Date(atMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - atMs) / 60000);
  } catch {
    return 0;
  }
}
