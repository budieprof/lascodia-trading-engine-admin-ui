import { Injectable, computed, signal } from '@angular/core';

/**
 * Per-route saved-view store. A "view" snapshots whatever filter / sort /
 * pager / tab state the page wants to persist — the format is opaque from
 * the service's perspective; callers serialise their own DTO into the
 * `state` field and deserialise on restore.
 *
 * Persisted to `localStorage` (NOT sessionStorage) so views survive across
 * sessions — an operator expects their pinned filters to still exist
 * tomorrow morning. Keys are namespaced by route.
 *
 * Future upgrade path: migrate to a backend `/user-views` endpoint once
 * there's cross-device demand. The public API stays the same.
 */
export interface SavedView<T = unknown> {
  /** Stable id — used for delete + update. */
  id: string;
  /** Human-readable label shown in the view picker. */
  label: string;
  /** Whether this view shows up in the quick-switcher without opening the menu. */
  pinned: boolean;
  /** Route path this view belongs to (e.g. `/orders`). */
  route: string;
  /** Opaque snapshot — the feature page decides the shape. */
  state: T;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'lascodia.saved-views';

@Injectable({ providedIn: 'root' })
export class SavedViewsService {
  private readonly _views = signal<SavedView[]>(this.readAll());

  /** All views across all routes. Usually you want `forRoute(path)` instead. */
  readonly all = this._views.asReadonly();

  forRoute<T>(route: string) {
    return computed<SavedView<T>[]>(
      () => this._views().filter((v) => v.route === route) as SavedView<T>[],
    );
  }

  /**
   * Upsert a view. New views get a fresh id; existing ones (matched by id)
   * update their `state` + `updatedAt`. Label changes require an explicit id.
   */
  save<T>(view: Omit<SavedView<T>, 'createdAt' | 'updatedAt'> & { id?: string }): SavedView<T> {
    const now = new Date().toISOString();
    const id = view.id ?? crypto.randomUUID();
    const existing = this._views().find((v) => v.id === id);
    const stored: SavedView<T> = {
      id,
      label: view.label,
      pinned: view.pinned,
      route: view.route,
      state: view.state,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? this._views().map((v) => (v.id === id ? (stored as SavedView) : v))
      : [...this._views(), stored as SavedView];
    this._views.set(next);
    this.persist(next);
    return stored;
  }

  rename(id: string, label: string): void {
    const next = this._views().map((v) =>
      v.id === id ? { ...v, label, updatedAt: new Date().toISOString() } : v,
    );
    this._views.set(next);
    this.persist(next);
  }

  togglePin(id: string): void {
    const next = this._views().map((v) =>
      v.id === id ? { ...v, pinned: !v.pinned, updatedAt: new Date().toISOString() } : v,
    );
    this._views.set(next);
    this.persist(next);
  }

  remove(id: string): void {
    const next = this._views().filter((v) => v.id !== id);
    this._views.set(next);
    this.persist(next);
  }

  // ── storage ────────────────────────────────────────────────────────

  private readAll(): SavedView[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedView[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persist(views: SavedView[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
    } catch {
      /* quota exceeded / storage unavailable — silent */
    }
  }
}
