import { Injectable, inject, signal } from '@angular/core';
import { ChartPrefsService } from '../workspace/chart-prefs.service';
import { TOOLS, type DrawingKind } from './model';

/** The favourite drawing tools — a synced chart preference (DR-I12). */
export const FAVORITE_TOOLS_KEY = 'lascodia.chart.favoriteDrawingTools.v1';

const KNOWN = new Set<string>(TOOLS.map((t) => t.kind));

/** A stored list as the tools it names, in order, once each; anything else read as none. */
export function parseFavorites(raw: string | null): DrawingKind[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    const out: DrawingKind[] = [];
    for (const k of v)
      if (typeof k === 'string' && KNOWN.has(k) && !out.includes(k as DrawingKind))
        out.push(k as DrawingKind);
    return out;
  } catch {
    return [];
  }
}

/**
 * TradingView's favourite drawing tools: starred in the rail's flyouts, shown on the floating Favourites bar, in the
 * order they were starred. Kept with the chart preferences the engine syncs, so they follow the operator.
 */
@Injectable({ providedIn: 'root' })
export class DrawingFavorites {
  private readonly prefs = inject(ChartPrefsService);
  readonly list = signal<DrawingKind[]>(parseFavorites(this.prefs.getItem(FAVORITE_TOOLS_KEY)));

  /** Re-read after the engine's preferences landed in the cache. */
  reload(): void {
    this.list.set(parseFavorites(this.prefs.getItem(FAVORITE_TOOLS_KEY)));
  }

  has(kind: DrawingKind): boolean {
    return this.list().includes(kind);
  }

  toggle(kind: DrawingKind): void {
    const next = this.has(kind) ? this.list().filter((k) => k !== kind) : [...this.list(), kind];
    this.list.set(next);
    this.prefs.setItem(FAVORITE_TOOLS_KEY, JSON.stringify(next));
  }
}
