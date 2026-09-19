import { Injectable, computed, signal } from '@angular/core';
import type { ActiveIndicator, ChartStyle } from '../chart/chart-host.component';
import type { TvResolution } from '../datafeed/resolution';

const STORAGE_KEY = 'lascodia.chart.layouts.v1';
const LAST_KEY = 'lascodia.chart.lastLayout.v1';

/** Everything that defines how a chart is set up, minus the drawings. */
export interface ChartLayout {
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

interface Stored {
  layouts: ChartLayout[];
  templates: StudyTemplate[];
}

/**
 * Saved chart layouts and study templates.
 *
 * A layout captures the whole chart setup — symbol, timeframe, style, studies,
 * scale mode, timezone — so an operator can flip between "EURUSD scalping" and
 * "daily review" without rebuilding either.
 *
 * Templates deliberately DROP the symbol and timeframe: they are a set of
 * studies to apply to whatever is on screen. Conflating the two is the usual
 * mistake here, and it makes "apply my template" quietly move the chart to
 * another instrument.
 *
 * Storage is `localStorage` for now, per-browser. Swapping in an engine-backed
 * store changes `read`/`write` only — see plan §8.
 */
@Injectable({ providedIn: 'root' })
export class ChartLayoutStore {
  private readonly state = signal<Stored>(this.read());

  readonly layouts = computed(() =>
    [...this.state().layouts].sort((a, b) => b.savedAt - a.savedAt),
  );
  readonly templates = computed(() =>
    [...this.state().templates].sort((a, b) => b.savedAt - a.savedAt),
  );

  saveLayout(name: string, snapshot: Omit<ChartLayout, 'id' | 'name' | 'savedAt'>): ChartLayout {
    const trimmed = name.trim() || 'Untitled layout';
    const existing = this.state().layouts.find((l) => l.name === trimmed);
    const layout: ChartLayout = {
      ...snapshot,
      id: existing?.id ?? `l_${Date.now().toString(36)}`,
      name: trimmed,
      savedAt: Date.now(),
    };
    // Saving under an existing name REPLACES it rather than making a second
    // entry with the same label, which is what "save" means to an operator.
    this.state.update((s) => ({
      ...s,
      layouts: [...s.layouts.filter((l) => l.id !== layout.id), layout],
    }));
    this.write();
    return layout;
  }

  removeLayout(id: string): void {
    this.state.update((s) => ({ ...s, layouts: s.layouts.filter((l) => l.id !== id) }));
    this.write();
  }

  saveTemplate(name: string, indicators: ActiveIndicator[]): StudyTemplate {
    const trimmed = name.trim() || 'Untitled template';
    const existing = this.state().templates.find((t) => t.name === trimmed);
    const template: StudyTemplate = {
      id: existing?.id ?? `t_${Date.now().toString(36)}`,
      name: trimmed,
      // Cloned so later edits to the live studies do not mutate the template.
      indicators: indicators.map((i) => ({ ...i, params: { ...i.params } })),
      savedAt: Date.now(),
    };
    this.state.update((s) => ({
      ...s,
      templates: [...s.templates.filter((t) => t.id !== template.id), template],
    }));
    this.write();
    return template;
  }

  removeTemplate(id: string): void {
    this.state.update((s) => ({ ...s, templates: s.templates.filter((t) => t.id !== id) }));
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

  /** Remember the last layout so the page reopens where it was left. */
  rememberLast(layoutId: string | null): void {
    try {
      if (layoutId) localStorage.setItem(LAST_KEY, layoutId);
      else localStorage.removeItem(LAST_KEY);
    } catch {
      /* storage unavailable; the chart still works */
    }
  }

  lastLayout(): ChartLayout | null {
    try {
      const id = localStorage.getItem(LAST_KEY);
      return id ? (this.state().layouts.find((l) => l.id === id) ?? null) : null;
    } catch {
      return null;
    }
  }

  private write(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state()));
    } catch {
      /* keep the in-memory state; nothing else to do */
    }
  }

  private read(): Stored {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { layouts: [], templates: [] };
      const parsed = JSON.parse(raw) as Partial<Stored>;
      return {
        layouts: Array.isArray(parsed.layouts) ? parsed.layouts : [],
        templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      };
    } catch {
      return { layouts: [], templates: [] };
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
 * Offset in minutes between UTC and `timezone` at `atMs`.
 *
 * Computed from `Intl` at the given instant rather than from a fixed table,
 * because the offset changes with DST — a chart that hardcodes London at UTC+0
 * is an hour wrong for seven months of the year.
 */
export function timezoneOffsetMinutes(timezone: string, atMs: number): number {
  if (timezone === 'UTC') return 0;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(atMs));
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
