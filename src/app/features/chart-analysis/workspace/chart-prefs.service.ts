import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { ChartLayoutsService } from '@core/services/chart-layouts.service';

/**
 * The chart's per-viewer preferences that follow the operator across browsers and machines.
 * Each is the localStorage key the feature always used; the engine (`chart/preferences`) holds
 * the same string under the same key.
 */
export const SYNCED_PREF_KEYS = [
  'lascodia.chart.favouriteStudies',
  'lascodia.chart.studyTemplates.v1',
  'lascodia.chart.drawing-templates.v1',
  'lascodia.chart.drawing-toolbar.pos.v1',
  'lascodia.chart.watchlist.split',
  'lascodia.chart.pref.magnetStrength',
  'lascodia.chart.pref.stayInDrawing',
  'lascodia.chart.pref.favouriteIntervals',
  // Pine scripts' named input templates (PC-I12, `scripts/script-input-templates.ts`).
  'lascodia.chart.scriptInputTemplates.v1',
  // Favourite drawing tools and their toolbar's place (DR-I12, `drawings/drawing-favorites.service.ts`).
  'lascodia.chart.favoriteDrawingTools.v1',
  'lascodia.chart.favoritesBar.pos.v1',
  // Auto analysis layers (DR-I11).
  'lascodia.chart.pref.autoAnalysis',
] as const;
export type SyncedPrefKey = (typeof SYNCED_PREF_KEYS)[number];

const PUSH_DEBOUNCE_MS = 800;
const HYDRATE_TIMEOUT_MS = 4_000;

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Two tiers, like drawings: localStorage is the synchronous cache every component reads, the
 * engine is the source of truth.
 *
 * - {@link hydrate} runs before the chart page renders: engine values are written into the cache
 *   (the engine wins), and keys only this browser has are uploaded once — so nothing set before
 *   preferences were server-side is lost.
 * - {@link setItem} writes the cache at once and pushes to the engine on a short debounce;
 *   `pagehide` flushes what is still pending with a keepalive request.
 */
@Injectable({ providedIn: 'root' })
export class ChartPrefsService {
  private readonly remote = inject(ChartLayoutsService);
  private readonly pending = new Map<string, string | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hydration: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flushOnUnload());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushOnUnload();
      });
    }
  }

  /** Storage-shaped view for code that takes a `Storage` (drawing templates). */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (key) => this.getItem(key),
    setItem: (key, value) => this.setItem(key, value),
  };

  getItem(key: string): string | null {
    try {
      return local()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    try {
      local()?.setItem(key, value);
    } catch {
      /* cache unavailable — the engine still gets it */
    }
    if ((SYNCED_PREF_KEYS as readonly string[]).includes(key)) this.queue(key, value);
  }

  removeItem(key: string): void {
    try {
      local()?.removeItem(key);
    } catch {
      /* ignore */
    }
    if ((SYNCED_PREF_KEYS as readonly string[]).includes(key)) this.queue(key, null);
  }

  /** Engine → cache once per session (shared promise); never rejects. */
  hydrate(): Promise<void> {
    this.hydration ??= this.doHydrate();
    return this.hydration;
  }

  private async doHydrate(): Promise<void> {
    let res;
    try {
      res = await firstValueFrom(this.remote.preferences().pipe(timeout(HYDRATE_TIMEOUT_MS)));
    } catch {
      this.hydration = null; // offline: the cache serves; try again next time
      return;
    }
    if (!res?.status) {
      this.hydration = null;
      return;
    }
    const server = new Map((res.data ?? []).map((p) => [p.key, p.value]));
    for (const key of SYNCED_PREF_KEYS) {
      if (server.has(key)) {
        const v = server.get(key);
        try {
          if (typeof v === 'string') local()?.setItem(key, v);
          else if (v === null) local()?.removeItem(key);
        } catch {
          /* ignore */
        }
      } else {
        // Set in this browser before preferences were server-side: upload it once.
        const mine = this.getItem(key);
        if (mine !== null) this.queue(key, mine);
      }
    }
  }

  private queue(key: string, value: string | null): void {
    this.pending.set(key, value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), PUSH_DEBOUNCE_MS);
  }

  private push(): void {
    this.timer = null;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [key, value] of batch) {
      this.remote.setPreference(key, value).subscribe({
        next: (r) => {
          if (!r?.status && !this.pending.has(key)) this.queueLater(key, value);
        },
        error: () => {
          if (!this.pending.has(key)) this.queueLater(key, value);
        },
      });
    }
  }

  /** Retry a failed push after a pause (offline); a newer value queued meanwhile wins. */
  private queueLater(key: string, value: string | null): void {
    setTimeout(() => {
      if (!this.pending.has(key)) this.queue(key, value);
    }, 15_000);
  }

  private flushOnUnload(): void {
    if (!this.pending.size) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [key, value] of this.pending)
      this.remote.sendOnUnload(`/chart/preferences/${encodeURIComponent(key)}`, 'PUT', { value });
    this.pending.clear();
  }
}
