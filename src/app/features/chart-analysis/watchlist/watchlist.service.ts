import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { ChartWatchlist, WatchQuote } from './watchlist.model';

const SILENT = { silent: true };
const SAVE_DEBOUNCE_MS = 600;

/**
 * Engine-backed chart watchlists (`/chart-watchlist`) plus the daily-change
 * quote snapshot (`/market-data/watchlist-quotes`).
 *
 * Lists live in the engine, not the browser, so a watchlist built on one
 * machine is there on the next — the same contract as chart drawings. Edits
 * are applied locally at once and written back debounced, so dragging a row
 * or cycling a flag never waits on the network.
 */
@Injectable({ providedIn: 'root' })
export class WatchlistService {
  private readonly api = inject(ApiService);

  readonly lists = signal<ChartWatchlist[]>([]);
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = computed(() => {
    const all = this.lists();
    return all.find((l) => l.isActive) ?? all[0] ?? null;
  });

  private saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** A seeded list (id 0) being created; later edits wait for its real id. */
  private creating: Promise<ChartWatchlist> | null = null;

  async load(): Promise<void> {
    try {
      const lists = await firstValueFrom(
        this.api.getEnvelope<ChartWatchlist[]>('/chart-watchlist', SILENT),
      );
      this.lists.set(lists ?? []);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Watchlists are unavailable.');
    } finally {
      this.loaded.set(true);
    }
  }

  quotes(symbols: string[]): Promise<WatchQuote[]> {
    if (!symbols.length) return Promise.resolve([]);
    return firstValueFrom(
      this.api.getEnvelope<WatchQuote[]>(
        `/market-data/watchlist-quotes?symbols=${encodeURIComponent(symbols.join(','))}`,
        SILENT,
      ),
    ).then((q) => q ?? []);
  }

  /** Replace a list locally and schedule its write. */
  update(next: ChartWatchlist): void {
    this.lists.update((all) => all.map((l) => (l.id === next.id ? next : l)));
    const prev = this.saveTimers.get(next.id);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(
      next.id,
      setTimeout(() => {
        this.saveTimers.delete(next.id);
        void this.persist(next.id);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  async create(name: string, from?: ChartWatchlist): Promise<void> {
    const body = { name, sections: from?.sections ?? [] };
    const created = await this.write(() =>
      this.api.postEnvelope<ChartWatchlist>('/chart-watchlist', body, SILENT),
    );
    if (!created) return;
    this.lists.update((all) => [...all, created]);
    await this.activate(created.id);
  }

  async rename(id: number, name: string): Promise<void> {
    const list = this.lists().find((l) => l.id === id);
    if (list && name.trim()) this.update({ ...list, name: name.trim() });
  }

  async activate(id: number): Promise<void> {
    this.lists.update((all) => all.map((l) => ({ ...l, isActive: l.id === id })));
    if (id !== 0) this.update(this.lists().find((l) => l.id === id)!);
  }

  async remove(id: number): Promise<void> {
    if (id !== 0)
      await this.write(() => this.api.deleteEnvelope<unknown>(`/chart-watchlist/${id}`, SILENT));
    // The engine reseeds a default when the last list goes, so re-read rather than guess.
    await this.load();
  }

  /** Flush pending writes now (page leaving). */
  flush(): void {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      void this.persist(id);
    }
    this.saveTimers.clear();
  }

  private async persist(id: number): Promise<void> {
    if (id === 0) {
      // The seeded default is not stored yet: the first edit creates it.
      if (!this.creating) {
        const draft = this.lists().find((l) => l.id === 0);
        if (!draft) return;
        this.creating = firstValueFrom(
          this.api.postEnvelope<ChartWatchlist>(
            '/chart-watchlist',
            { name: draft.name, sections: draft.sections },
            SILENT,
          ),
        );
        try {
          const created = await this.creating;
          // Keep whatever the operator did meanwhile; only adopt the id.
          const latest = this.lists().find((l) => l.id === 0) ?? draft;
          this.lists.update((all) =>
            all.map((l) => (l.id === 0 ? { ...latest, id: created.id, isActive: true } : l)),
          );
          if (latest !== draft) this.update({ ...latest, id: created.id, isActive: true });
          this.error.set(null);
        } catch (err) {
          this.error.set(err instanceof Error ? err.message : 'The watchlist could not be saved.');
        } finally {
          this.creating = null;
        }
      }
      return;
    }
    const list = this.lists().find((l) => l.id === id);
    if (!list) return;
    await this.write(() =>
      this.api.putEnvelope<ChartWatchlist>(
        `/chart-watchlist/${id}`,
        {
          name: list.name,
          sections: list.sections,
          isActive: list.isActive,
          sortOrder: list.sortOrder,
        },
        SILENT,
      ),
    );
  }

  private async write<T>(call: () => import('rxjs').Observable<T>): Promise<T | null> {
    this.saving.set(true);
    try {
      const r = await firstValueFrom(call());
      this.error.set(null);
      return r;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'The watchlist could not be saved.');
      return null;
    } finally {
      this.saving.set(false);
    }
  }
}

/** Ties a flush to a component's lifetime. */
export function flushOnDestroy(service: WatchlistService): void {
  inject(DestroyRef).onDestroy(() => service.flush());
}
